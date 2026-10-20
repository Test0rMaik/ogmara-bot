/**
 * Auto-join: this wallet joins a channel on its own, in two situations —
 * a channel the operator configured in `bot.channels`, and a channel whose
 * owner invited this wallet directly (protocol §3.9's `ChannelInvite`,
 * surfaced as a `channel_invite` notification — l2-node 0.128.0+).
 *
 * Joining only makes this wallet a MEMBER, which is what makes it show up
 * in a channel's member list and clients' "/" picker (`get_channel_bots`
 * filters by membership). Whether an invited channel ALSO gets answered —
 * `bot.autoJoin.answerInvitedChannels` — is a separate decision, because
 * answering spends the wallet's rate-limited posting quota: an unbounded
 * number of channel owners could otherwise each grant themselves a slice of
 * one wallet's budget just by inviting it, competing with (and potentially
 * starving) whatever else that wallet posts, news included. Bounded by
 * `bot.autoJoin.maxAutoAnsweredChannels` — past the cap, further invited
 * channels still get MEMBERSHIP, just not a share of the answer budget,
 * until the operator raises the cap or manages `bot.channels` by hand.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  INVITE_EXPIRY_MARGIN_MS,
  MAX_INVITE_ENVELOPE_BYTES,
  base64ToBytes,
  decodeChannelInvite,
} from '@ogmara/sdk';
import { httpStatusFromError } from '../../ogmara.js';

/** One channel-invite notification, narrowed to what this module needs. */
export interface ChannelInviteNotice {
  readonly channelId: number;
  readonly channelName: string | undefined;
  readonly invitedBy: string;
  readonly timestamp: number;
  /**
   * Host node API endpoint for the invited channel (l2-node 0.130.0+,
   * cross-node invite delivery) — a private channel is host-node-scoped, so
   * this is what lets a channel this bot's own node has never heard of be
   * federated before joining. `undefined` when the inviter's client didn't
   * set it (older node, or the inviter's own node URL wasn't public https).
   */
  readonly anchorNode: string | undefined;
  /**
   * Raw signed `ChannelInvite` envelope bytes (l2-node 0.140.0+ private
   * join gate, spec 05 §8.4) — what a Private channel join must carry, sent
   * unchanged to both `federateChannel` and `joinChannel`. `undefined` when
   * the node attached none (older node, or a `null` on the wire), or when the
   * attached one is malformed, oversized, or does not decode as an invite for
   * THIS channel. Opaque to this module: never logged, never verified here
   * (the node is the verifier; the SDK pre-checks the target wallet).
   */
  readonly invite: Uint8Array | undefined;
  /**
   * Effective expiry of {@link invite} in unix ms — the signed envelope's own
   * value (authoritative), tightened to the node's `invite_expires_at` hint
   * when that is earlier. `undefined` exactly when `invite` is.
   */
  readonly inviteExpiresAt: number | undefined;
  /**
   * The invite envelope's own signed timestamp (unix ms, decoded, unverified)
   * — used only to pick the NEWEST of several invites to one channel.
   * `undefined` exactly when `invite` is.
   */
  readonly inviteSignedAt: number | undefined;
}

/**
 * The shape `getNotifications` returns one entry as, narrowed to what this
 * module reads.
 *
 * `channel_name`/`anchor_node` are typed `| null` alongside the usual `?:`
 * (optional) because they genuinely can BE `null`, not just absent:
 * l2-node's notification JSON splices an `Option<String>` straight into
 * `serde_json::json!`, which serializes `None` as JSON `null`, not an
 * omitted key. Code reading these MUST check for both — `!== undefined`
 * alone lets a real wire `null` straight through.
 */
export interface RawNotification {
  readonly type: string;
  readonly channel_id?: string;
  readonly channel_name?: string | null;
  readonly anchor_node?: string | null;
  /** Standard base64 of the raw signed invite envelope (l2-node 0.140.0+); `null`/absent when none. */
  readonly invite_envelope?: string | null;
  /** Node-computed effective expiry (unix ms) — a hint; the signed envelope is authoritative. */
  readonly invite_expires_at?: number | null;
  readonly from: string;
  readonly timestamp: number;
}

/** Longest `anchor_node` string this module will act on — a sanity bound, not a URL validator (the node re-validates for real before ever fetching it). */
const MAX_ANCHOR_NODE_CHARS = 2048;

/**
 * Longest `invite_envelope` string decoded at all: the base64 length of a
 * {@link MAX_INVITE_ENVELOPE_BYTES} envelope. A cap on the untrusted INPUT,
 * checked before any decode work, so an oversized field costs nothing.
 */
const MAX_INVITE_B64_CHARS = Math.ceil(MAX_INVITE_ENVELOPE_BYTES / 3) * 4;

/**
 * Private channel ids live above this floor (l2-node `PRIVATE_CHANNEL_ID_FLOOR`,
 * 2^32). Used ONLY when the channel's own record is not known locally yet —
 * the node applies the same rule to an unknown id.
 */
const PRIVATE_CHANNEL_ID_FLOOR = 2 ** 32;

/**
 * Whether a channel must be joined with an invite: its record says Private,
 * or — while this wallet's node has no record of it yet — its id is in the
 * private namespace. A known record always wins over the id heuristic.
 */
export function isPrivateChannel(channelId: number, knownPrivate: boolean | undefined): boolean {
  return knownPrivate ?? channelId > PRIVATE_CHANNEL_ID_FLOOR;
}

/**
 * Pull the invite envelope out of one `channel_invite` notification.
 *
 * `null` and absent are the same thing here (normalized to `undefined`, never
 * passed on as `null`). Decoding is strict standard base64 via the SDK; any
 * failure — bad base64, empty, oversized, not a `ChannelInvite`, or an invite
 * for a different channel than the notification names — yields no invite,
 * which for a Private channel means the invite is skipped rather than sent to
 * be rejected.
 */
function parseInviteEnvelope(
  b64: unknown,
  expiresHint: unknown,
  channelId: number,
): { invite: Uint8Array; inviteExpiresAt: number; inviteSignedAt: number } | undefined {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length > MAX_INVITE_B64_CHARS) return undefined;
  const bytes = base64ToBytes(b64);
  if (bytes === null || bytes.length === 0 || bytes.length > MAX_INVITE_ENVELOPE_BYTES) return undefined;
  const decoded = decodeChannelInvite(bytes);
  if (decoded === null || decoded.channelId !== channelId) return undefined;
  const hint =
    typeof expiresHint === 'number' && Number.isSafeInteger(expiresHint) ? expiresHint : undefined;
  return {
    invite: bytes,
    inviteSignedAt: decoded.timestamp,
    inviteExpiresAt: hint !== undefined ? Math.min(decoded.expiresAt, hint) : decoded.expiresAt,
  };
}

/**
 * Whether an invite is still usable at `now`, by the client margin of spec 05
 * §8.4: expired once `now >= expiresAt - INVITE_EXPIRY_MARGIN_MS` — tighter
 * than the node, so a join is never signed with an invite that would be
 * rejected on arrival. No invite at all is "not usable".
 */
export function inviteUsable(
  notice: ChannelInviteNotice,
  now: number,
): notice is ChannelInviteNotice & { readonly invite: Uint8Array; readonly inviteExpiresAt: number } {
  return (
    notice.invite !== undefined &&
    notice.inviteExpiresAt !== undefined &&
    now < notice.inviteExpiresAt - INVITE_EXPIRY_MARGIN_MS
  );
}

/**
 * Collapse several invites to the SAME channel (re-invites, or one invite
 * listed twice) into one, so a page never joins a channel with one invite and
 * then warns about an older, expired one for the same channel.
 *
 * Ranking matches spec 05 §8.4 and the SDK's `selectPendingInvite`, which
 * drops expired invites FIRST and only then picks the newest:
 *   1. a USABLE invite (envelope present, not expired by the client margin at
 *      `now`) beats an expired one, which beats one with no envelope — so a
 *      newer but already-expired 1h re-invite never displaces an older,
 *      still-valid 7d one;
 *   2. within a tier, the NEWEST signed envelope timestamp wins, later expiry
 *      only as a tie-break. Newest — not longest-lived — matters: after a
 *      kick, an older long-TTL invite is dead at the node (removal cutoff)
 *      while a fresh short-TTL re-invite is valid;
 *   3. among envelope-less invites, the newest notification.
 * Order of first appearance is kept.
 */
function inviteTier(n: ChannelInviteNotice, now: number): number {
  if (n.invite === undefined || n.inviteSignedAt === undefined) return 0;
  return inviteUsable(n, now) ? 2 : 1;
}

function outranks(a: ChannelInviteNotice, b: ChannelInviteNotice, now: number): boolean {
  const aTier = inviteTier(a, now);
  const bTier = inviteTier(b, now);
  if (aTier !== bTier) return aTier > bTier;
  if (aTier === 0) return a.timestamp > b.timestamp;
  const aSigned = a.inviteSignedAt ?? 0;
  const bSigned = b.inviteSignedAt ?? 0;
  if (aSigned !== bSigned) return aSigned > bSigned;
  return (a.inviteExpiresAt ?? 0) > (b.inviteExpiresAt ?? 0);
}

export function bestInvitePerChannel(
  invites: readonly ChannelInviteNotice[],
  now: number,
): ChannelInviteNotice[] {
  const best = new Map<number, ChannelInviteNotice>();
  for (const n of invites) {
    const cur = best.get(n.channelId);
    if (cur === undefined) {
      best.set(n.channelId, n);
      continue;
    }
    if (outranks(n, cur, now)) best.set(n.channelId, n);
  }
  return [...best.values()];
}

/**
 * Pull `channel_invite` entries out of a page of notifications, and report
 * the newest timestamp seen across ALL of them (invite or not) so the caller
 * can advance its cursor even on a page with no invites — otherwise a run
 * that only saw, say, mentions would leave the cursor stuck and re-fetch the
 * same already-seen page forever.
 */
export function extractChannelInvites(
  notifications: readonly RawNotification[],
): { invites: ChannelInviteNotice[]; newestTs: number | null } {
  let newestTs: number | null = null;
  const invites: ChannelInviteNotice[] = [];
  for (const n of notifications) {
    if (newestTs === null || n.timestamp > newestTs) newestTs = n.timestamp;
    if (n.type !== 'channel_invite') continue;
    // channel_id travels as a string on the wire (see sdk-js Notification);
    // a missing or non-numeric one is a malformed entry, not a channel to join.
    const channelId = n.channel_id !== undefined ? Number(n.channel_id) : NaN;
    if (!Number.isInteger(channelId) || channelId < 1) continue;
    const anchorNode =
      typeof n.anchor_node === 'string' &&
      n.anchor_node.length > 0 &&
      n.anchor_node.length <= MAX_ANCHOR_NODE_CHARS
        ? n.anchor_node
        : undefined;
    // l2-node's notification JSON is hand-built via `serde_json::json!` with
    // an `Option<String>` field spliced straight in — that serializes a
    // `None` as JSON `null`, not an omitted key. `RawNotification`'s `?:
    // string` type only promises "may be absent", so a wire `null` reaches
    // here as a real `null` value despite the type. This is exactly the
    // channel this bot has never federated (the node's own local channel
    // record — and with it the display name — doesn't exist yet), so it is
    // NOT a rare edge case for a brand-new cross-node invite: it is the
    // norm. `channelName !== undefined` downstream doesn't catch `null`,
    // and passing `null` to `forLog()` throws ("Cannot read properties of
    // null (reading 'split')") — silently aborting the whole invite before
    // it ever reaches federate/join. Normalize here, once.
    const channelName = typeof n.channel_name === 'string' ? n.channel_name : undefined;
    const parsed = parseInviteEnvelope(n.invite_envelope, n.invite_expires_at, channelId);
    invites.push({
      channelId,
      channelName,
      invitedBy: n.from,
      timestamp: n.timestamp,
      anchorNode,
      invite: parsed?.invite,
      inviteExpiresAt: parsed?.inviteExpiresAt,
      inviteSignedAt: parsed?.inviteSignedAt,
    });
  }
  return { invites, newestTs };
}

/** Persisted auto-join state. */
export interface AutoJoinState {
  /** Unix milliseconds — the newest notification timestamp already handled. */
  readonly lastHandledTs: number;
  /**
   * Channel ids granted answer rights via invite, subject to
   * `maxAutoAnsweredChannels`. Persisted so a restart does not forget the
   * grant and silently stop answering somewhere it already had earned a
   * slot — the cap is checked against this list's length when a NEW invite
   * arrives, not re-derived from scratch each time.
   */
  readonly answerChannelIds: readonly number[];
  /**
   * Channel id → unix milliseconds this channel first showed encrypted-
   * shaped traffic (`enc_content` present) it has never once successfully
   * decrypted, since the last time it DID successfully decrypt something
   * (or since being granted, if never). Cleared the moment a channel
   * answers a command. Past `maxUnservedEncryptedHours`, the channel's slot
   * is freed — see the schema doc comment for why this can't be inferred
   * from the channel's own metadata.
   */
  readonly encryptedSince: Readonly<Record<number, number>>;
}

const EMPTY_STATE: AutoJoinState = { lastHandledTs: 0, answerChannelIds: [], encryptedSince: {} };

interface StoredAutoJoinState {
  version: 1;
  lastHandledTs: number;
  /** Absent in a file written before this field existed — treated as empty. */
  answerChannelIds?: unknown;
  /** Absent in a file written before this field existed — treated as empty. */
  encryptedSince?: unknown;
}

/**
 * Read the persisted state.
 *
 * Missing or corrupt both resolve to the empty state (process the full
 * available history, no channels pre-granted), never a hard failure —
 * unlike the ledger, losing this only means re-checking already-joined
 * channels and re-granting already-earned answer slots, and both
 * `joinChannel` and re-adding an id already in the answer set are harmless.
 * Silently missing an invite would be the worse failure of the two.
 */
export function loadAutoJoinState(path: string, warn: (message: string) => void): AutoJoinState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return EMPTY_STATE;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAutoJoinState>;
    if (parsed.version !== 1 || typeof parsed.lastHandledTs !== 'number') {
      warn(`  warning: auto-join state at "${path}" has an unexpected shape — reprocessing from the start`);
      return EMPTY_STATE;
    }
    const answerChannelIds = Array.isArray(parsed.answerChannelIds)
      ? parsed.answerChannelIds.filter((id): id is number => typeof id === 'number')
      : [];
    const encryptedSince: Record<number, number> = {};
    if (parsed.encryptedSince !== null && typeof parsed.encryptedSince === 'object') {
      for (const [k, v] of Object.entries(parsed.encryptedSince as Record<string, unknown>)) {
        const id = Number(k);
        if (Number.isInteger(id) && typeof v === 'number') encryptedSince[id] = v;
      }
    }
    return { lastHandledTs: parsed.lastHandledTs, answerChannelIds, encryptedSince };
  } catch (err) {
    warn(
      `  warning: auto-join state at "${path}" is corrupt (${err instanceof Error ? err.message : String(err)}) ` +
        '— reprocessing from the start',
    );
    return EMPTY_STATE;
  }
}

/**
 * Persist state atomically (temp file + rename), matching the ledger's and
 * queue's write pattern — a crash mid-write must leave the previous good
 * file intact, not a truncated one that fails to parse on restart.
 */
export function saveAutoJoinState(path: string, state: AutoJoinState): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const payload: StoredAutoJoinState = {
    version: 1,
    lastHandledTs: state.lastHandledTs,
    answerChannelIds: [...state.answerChannelIds],
    encryptedSince: { ...state.encryptedSince },
  };
  const tmp = join(dir, `.${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * How an invite's federate/join/describe failure should be treated.
 *
 * - `rate-limited` (HTTP 429): retry on a later poll AND stop making further
 *   federate/join calls in this poll — the node's limits are per wallet, so
 *   continuing would only hammer it (l2-node: 10 federations per wallet per
 *   10 min, a global bucket, 8 concurrent fetches).
 * - `transient` (HTTP 502/503/504 — 503 is the node's "federation busy" —
 *   or a network/timeout error with no HTTP status): retry on a later poll.
 * - `permanent` (any other HTTP status — 400, 403 "invite proof required",
 *   404 — or a local error such as the SDK's invite pre-check): skip, and let
 *   the cursor move past it. Retrying would get the same answer.
 */
export type InviteFailureKind = 'rate-limited' | 'transient' | 'permanent';

/** Node.js/undici network error codes that mean "the request never got an answer". */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function classifyInviteFailure(err: unknown): InviteFailureKind {
  const status = httpStatusFromError(err);
  if (status === 429) return 'rate-limited';
  if (status === 502 || status === 503 || status === 504) return 'transient';
  if (status !== null) return 'permanent';
  if (!(err instanceof Error)) return 'permanent';
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'transient';
  // undici's fetch rejects with `TypeError: fetch failed`, the real cause in `.cause`.
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return 'transient';
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return 'transient';
  return 'permanent';
}

/**
 * How many polls an invite that keeps failing transiently is retried before
 * it is given up on (logged, cursor allowed past it). With the default
 * 15-minute poll that is a bit over an hour of retries; a Private invite's
 * own expiry margin ends retries sooner when it is reached first.
 */
export const MAX_INVITE_RETRY_ATTEMPTS = 5;

/** Identity of one invite notification across polls (re-fetched after a held-back cursor). */
export function inviteKey(n: Pick<ChannelInviteNotice, 'channelId' | 'timestamp'>): string {
  return `${n.channelId}:${n.timestamp}`;
}
