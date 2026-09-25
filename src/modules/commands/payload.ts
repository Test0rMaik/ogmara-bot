/**
 * Decoding a chat envelope's payload.
 *
 * The WebSocket delivers an `Envelope` whose `payload` is **msgpack bytes** —
 * the node enriches the frame with `msg_id`, `author` and `channel_id` and
 * nothing else, so the message text and its mention list stay inside those
 * bytes. A bot must decode them itself; the SDK's `CommandMessage` type exists
 * precisely because `parseCommand` takes a decoded object, never a raw envelope.
 *
 * This is a trust boundary. The bytes arrive from any wallet on the network via
 * a node this process does not control, so nothing here may throw and nothing
 * may allocate on the sender's say-so: `@msgpack/msgpack` defaults every `max*`
 * option to UINT32_MAX, and decoding without caps would let one hostile payload
 * force gigabytes of allocation before any check of ours runs. Same defensive
 * shape as `src/panel/posts.ts`, which crossed the same boundary first.
 */

import { decode } from '@msgpack/msgpack';

/** Decoder caps, matching `src/panel/posts.ts` and the web client's own. */
const SAFE_DECODE_OPTIONS = {
  maxStrLength: 1 << 20,
  maxBinLength: 1 << 16,
  maxArrayLength: 256,
  maxMapLength: 64,
  maxExtLength: 1 << 16,
};

/** Longest raw payload byte array this will even attempt to decode. */
const MAX_PAYLOAD_BYTES = SAFE_DECODE_OPTIONS.maxStrLength;

/**
 * Longest `content` this will hand on.
 *
 * The node's own chat cap is 4096 BYTES (`MAX_CHAT_CONTENT`), so anything longer
 * cannot be a message the node accepted. Capping here matters because the next
 * thing to touch this string is `parseCommand`, which splits it on whitespace —
 * and that runs BEFORE the rate limiter, so an uncapped 1 MB content would buy
 * an attacker a ~500,000-element array per message for free.
 */
const MAX_CONTENT_BYTES = 4096;

/**
 * Longest mention string kept.
 *
 * A bech32 address is ~62 characters; this bounds what one message can make us
 * retain without having to trust the sender's idea of an address.
 */
const MAX_MENTION_CHARS = 128;

/**
 * Longest ciphertext this will hand on.
 *
 * NOT derived from `MAX_CONTENT_BYTES` — `enc_content` is a separate,
 * larger, independently-capped field (l2-node `MAX_CHAT_CIPHERTEXT`,
 * `messages/validation.rs`): it is a MessagePack-framed, AEAD-sealed blob
 * (`{text, reply_preview?}` plus the 16-byte Poly1305 tag), not a byte-for-
 * byte ciphertext of the plaintext cap. An earlier version of this constant
 * used `MAX_CONTENT_BYTES + 256`, which silently rejected legitimate,
 * node-accepted encrypted messages between roughly 4.3KB and this real cap.
 */
const MAX_ENC_CONTENT_BYTES = 8192;

/** XChaCha20-Poly1305 nonce length (bytes) — fixed by the AEAD primitive. */
const ENC_NONCE_BYTES = 24;

/** What a command invocation needs out of a chat payload. */
export interface ChatPayload {
  readonly content: string | null;
  readonly mentions: string[];
  /**
   * True when the decoded payload carries `enc_content` — a genuinely v2
   * encrypted message. A real encrypted message decodes successfully as
   * msgpack (it is a normal envelope shape) with `content` as an empty
   * STRING, not absent — so this can NOT be inferred from `content ===
   * null`; it needs its own signal.
   */
  readonly encrypted: boolean;
  /** Ciphertext, present only when `encrypted` and well-formed. */
  readonly encContent: Uint8Array | null;
  /** 24-byte AEAD nonce, present only when `encrypted` and well-formed. */
  readonly encNonce: Uint8Array | null;
  /** The epoch the channel key must be at, present only when `encrypted` and well-formed. */
  readonly keyEpoch: number | null;
  /**
   * True when the sender's client set `via_button` — the button lifecycle
   * mechanism's press signal (protocol §3.7). NOT a security boundary: any
   * wallet can set this on an ordinary typed message too, so it is a
   * rendering/UX hint only, never trusted for authorization.
   */
  readonly viaButton: boolean;
  /**
   * Hex-encoded `reply_to`, present only when well-formed (exactly 32
   * bytes). For a button press this is the msg_id of the message the
   * button row was displayed on — a bot combines it with `viaButton` to
   * decide whether to EDIT that message in place rather than post a new
   * one. Not proof of anything by itself: the node's own authorship check
   * on the resulting edit is what actually gates whether this wallet may
   * touch that message (see `channelKeys.ts`'s `encryptedEditEnvelope`).
   */
  readonly replyTo: string | null;
}

const EMPTY: ChatPayload = {
  content: null,
  mentions: [],
  encrypted: false,
  encContent: null,
  encNonce: null,
  keyEpoch: null,
  viaButton: false,
  replyTo: null,
};

/**
 * Decode a chat envelope payload, defensively.
 *
 * Anything oversized, malformed, or not shaped like a chat message yields empty
 * fields rather than throwing — an undecodable message is simply not a command.
 */
export function decodeChatPayload(payload: unknown): ChatPayload {
  let bytes: Uint8Array;
  if (payload instanceof Uint8Array) {
    if (payload.length > MAX_PAYLOAD_BYTES) return EMPTY;
    bytes = payload;
  } else if (Array.isArray(payload)) {
    // Length-capped BEFORE the scan and the copy below. Otherwise an oversized
    // array pays for a full `.every()` pass and a full-size `Uint8Array` copy
    // before the decoder's own caps ever get a chance to reject it.
    if (payload.length > MAX_PAYLOAD_BYTES) return EMPTY;
    if (!payload.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)) {
      return EMPTY;
    }
    bytes = new Uint8Array(payload);
  } else {
    return EMPTY;
  }

  try {
    const decoded = decode(bytes, SAFE_DECODE_OPTIONS);
    if (typeof decoded !== 'object' || decoded === null) return EMPTY;
    const obj = decoded as Record<string, unknown>;

    const raw = obj['content'];
    const content =
      typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') <= MAX_CONTENT_BYTES ? raw : null;

    // NOT truncated to a fixed count. An earlier version kept the first 64,
    // which silently broke a legitimate invocation: a message that @-mentions 64
    // people before the bot would have the bot's own address dropped, leaving a
    // non-empty mention list that does not name it — which `parseCommand` reads
    // as "addressed to someone else". The decoder's own `maxArrayLength` (256)
    // is the bound; each entry is length-capped instead.
    const mentions = Array.isArray(obj['mentions'])
      ? obj['mentions'].filter(
          (m): m is string => typeof m === 'string' && m.length > 0 && m.length <= MAX_MENTION_CHARS,
        )
      : [];

    const encrypted = obj['enc_content'] !== undefined && obj['enc_content'] !== null;

    // Only extracted when well-formed. A present-but-malformed `enc_content`/
    // `enc_nonce` (wrong type, oversized, wrong nonce length) still counts as
    // `encrypted` — it IS an encrypted message — but yields no usable bytes;
    // `handleMessage` (index.ts) treats a null here as undecryptable rather
    // than ever handing raw, unvalidated bytes on to the decrypt call.
    const rawEncContent = obj['enc_content'];
    const encContent =
      encrypted && rawEncContent instanceof Uint8Array && rawEncContent.length <= MAX_ENC_CONTENT_BYTES
        ? rawEncContent
        : null;

    const rawEncNonce = obj['enc_nonce'];
    const encNonce =
      encrypted && rawEncNonce instanceof Uint8Array && rawEncNonce.length === ENC_NONCE_BYTES
        ? rawEncNonce
        : null;

    const rawKeyEpoch = obj['key_epoch'];
    const keyEpoch =
      encrypted && typeof rawKeyEpoch === 'number' && Number.isInteger(rawKeyEpoch) && rawKeyEpoch > 0
        ? rawKeyEpoch
        : null;

    const viaButton = obj['via_button'] === true;

    const rawReplyTo = obj['reply_to'];
    const replyTo =
      rawReplyTo instanceof Uint8Array && rawReplyTo.length === 32
        ? Buffer.from(rawReplyTo).toString('hex')
        : null;

    return { content, mentions, encrypted, encContent, encNonce, keyEpoch, viaButton, replyTo };
  } catch {
    return EMPTY;
  }
}
