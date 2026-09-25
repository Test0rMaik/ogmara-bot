import { describe, expect, it } from 'vitest';
import { encode } from '@msgpack/msgpack';
import { decodeChatPayload } from './payload.js';

/** As the WS delivers it: JSON has no byte array, so the payload is number[]. */
const wire = (obj: unknown): number[] => Array.from(encode(obj));

describe('decodeChatPayload', () => {
  it('reads content and mentions out of a real msgpack payload', () => {
    const p = wire({ content: '/about', mentions: ['klv1bot'] });
    expect(decodeChatPayload(p)).toEqual({
      content: '/about',
      mentions: ['klv1bot'],
      encrypted: false,
      encContent: null,
      encNonce: null,
      keyEpoch: null,
      viaButton: false,
      replyTo: null,
    });
  });

  it('accepts a Uint8Array as well as a number array', () => {
    expect(decodeChatPayload(encode({ content: 'hi', mentions: [] })).content).toBe('hi');
  });

  it('reads a payload with no mentions at all', () => {
    expect(decodeChatPayload(wire({ content: '/help' }))).toEqual({
      content: '/help',
      mentions: [],
      encrypted: false,
      encContent: null,
      encNonce: null,
      keyEpoch: null,
      viaButton: false,
      replyTo: null,
    });
  });

  describe('encrypted flag', () => {
    it('is true when the payload carries enc_content — a real v2 encrypted message', () => {
      // REGRESSION GUARD. A real encrypted message decodes SUCCESSFULLY as
      // msgpack (it is a normal envelope shape) with `content` as an EMPTY
      // STRING, not absent — matching the live raw payload this was built
      // from. `content === null` can never distinguish this case; only
      // enc_content's presence can.
      const p = wire({
        content: '',
        mentions: [],
        enc_content: new Uint8Array([1, 2, 3]),
        enc_nonce: new Uint8Array([4, 5, 6]),
        key_epoch: 1,
      });
      const out = decodeChatPayload(p);
      expect(out.encrypted).toBe(true);
      expect(out.content).toBe(''); // present, empty — NOT null
    });

    it('is false for an ordinary plaintext message', () => {
      expect(decodeChatPayload(wire({ content: '/about', mentions: [] })).encrypted).toBe(false);
    });

    it('is false (not a crash) for anything that fails to decode at all', () => {
      expect(decodeChatPayload([0xc1, 0xff, 0x00]).encrypted).toBe(false);
      expect(decodeChatPayload(null).encrypted).toBe(false);
    });

    it('treats an explicit null enc_content the same as absent', () => {
      const p = wire({ content: '', mentions: [], enc_content: null });
      expect(decodeChatPayload(p).encrypted).toBe(false);
    });
  });

  describe('encrypted fields', () => {
    it('extracts encContent/encNonce/keyEpoch from a well-formed encrypted payload', () => {
      const encContent = new Uint8Array([1, 2, 3, 4]);
      const encNonce = new Uint8Array(24).fill(9);
      const p = wire({
        content: '',
        mentions: [],
        enc_content: encContent,
        enc_nonce: encNonce,
        key_epoch: 3,
      });
      const out = decodeChatPayload(p);
      expect(out.encrypted).toBe(true);
      expect(out.encContent).toEqual(encContent);
      expect(out.encNonce).toEqual(encNonce);
      expect(out.keyEpoch).toBe(3);
    });

    it('drops encNonce that is not exactly 24 bytes', () => {
      const p = wire({
        content: '',
        mentions: [],
        enc_content: new Uint8Array([1]),
        enc_nonce: new Uint8Array(23),
        key_epoch: 1,
      });
      const out = decodeChatPayload(p);
      expect(out.encrypted).toBe(true); // still a real encrypted message…
      expect(out.encNonce).toBeNull(); // …but this field can't be trusted
    });

    it('drops enc_content larger than the node\'s real MAX_CHAT_CIPHERTEXT cap (8192 bytes)', () => {
      // REGRESSION GUARD (spec-compliance finding, 2026-09-15): an earlier
      // version of this cap was derived from the PLAINTEXT content limit
      // (4096 + 256 = 4352), which silently rejected legitimate, node-
      // accepted encrypted messages between ~4.3KB and the real 8KB cap —
      // enc_content is a separate, independently-capped, MessagePack-framed
      // AEAD blob, not a byte-for-byte seal of the plaintext cap.
      const p = wire({
        content: '',
        mentions: [],
        enc_content: new Uint8Array(8192 + 1),
        enc_nonce: new Uint8Array(24),
        key_epoch: 1,
      });
      expect(decodeChatPayload(p).encContent).toBeNull();
    });

    it('accepts enc_content right up to the 8192-byte cap', () => {
      const p = wire({
        content: '',
        mentions: [],
        enc_content: new Uint8Array(8192),
        enc_nonce: new Uint8Array(24),
        key_epoch: 1,
      });
      expect(decodeChatPayload(p).encContent).not.toBeNull();
    });

    it('drops a non-positive or non-integer key_epoch', () => {
      const base = { content: '', mentions: [], enc_content: new Uint8Array([1]), enc_nonce: new Uint8Array(24) };
      expect(decodeChatPayload(wire({ ...base, key_epoch: 0 })).keyEpoch).toBeNull();
      expect(decodeChatPayload(wire({ ...base, key_epoch: -1 })).keyEpoch).toBeNull();
      expect(decodeChatPayload(wire({ ...base, key_epoch: 1.5 })).keyEpoch).toBeNull();
    });

    it('never populates the encrypted fields for a plaintext message', () => {
      const out = decodeChatPayload(wire({ content: '/about', mentions: [] }));
      expect(out.encContent).toBeNull();
      expect(out.encNonce).toBeNull();
      expect(out.keyEpoch).toBeNull();
    });
  });

  describe('viaButton / replyTo (button lifecycle, protocol §3.7)', () => {
    it('reads via_button and a well-formed 32-byte reply_to', () => {
      const replyTo = new Uint8Array(32).fill(0xab);
      const out = decodeChatPayload(
        wire({ content: '/c BTC 1h', mentions: [], via_button: true, reply_to: replyTo }),
      );
      expect(out.viaButton).toBe(true);
      expect(out.replyTo).toBe('ab'.repeat(32));
    });

    it('defaults viaButton to false and replyTo to null when absent', () => {
      const out = decodeChatPayload(wire({ content: '/about', mentions: [] }));
      expect(out.viaButton).toBe(false);
      expect(out.replyTo).toBeNull();
    });

    it('treats anything other than the literal boolean true as not-via-button', () => {
      expect(decodeChatPayload(wire({ content: 'x', mentions: [], via_button: 1 })).viaButton).toBe(false);
      expect(decodeChatPayload(wire({ content: 'x', mentions: [], via_button: 'true' })).viaButton).toBe(
        false,
      );
    });

    it('drops a reply_to that is not exactly 32 bytes', () => {
      expect(
        decodeChatPayload(wire({ content: 'x', mentions: [], reply_to: new Uint8Array(31) })).replyTo,
      ).toBeNull();
      expect(
        decodeChatPayload(wire({ content: 'x', mentions: [], reply_to: new Uint8Array(33) })).replyTo,
      ).toBeNull();
    });

    it('drops a non-binary reply_to rather than coercing it', () => {
      expect(
        decodeChatPayload(wire({ content: 'x', mentions: [], reply_to: 'not-bytes' })).replyTo,
      ).toBeNull();
    });
  });

  it('returns empty for a payload that is not a chat message', () => {
    // A news post, say. Not an error — just not a command.
    expect(decodeChatPayload(wire({ title: 'x', body: 'y' })).content).toBeNull();
  });

  it('never throws on malformed bytes', () => {
    // These arrive from any wallet on the network via a node this process does
    // not control. A throw here would take down the message handler.
    expect(decodeChatPayload([0xc1, 0xff, 0x00]).content).toBeNull();
    expect(decodeChatPayload([]).content).toBeNull();
    expect(decodeChatPayload('not bytes').content).toBeNull();
    expect(decodeChatPayload(null).content).toBeNull();
    expect(decodeChatPayload(undefined).content).toBeNull();
    expect(decodeChatPayload({ payload: 'nested' }).content).toBeNull();
  });

  it('rejects an oversized payload without scanning or copying it', () => {
    // Length-capped BEFORE the per-element scan and the Uint8Array copy —
    // otherwise an oversized array pays for a full pass and a full-size copy
    // before the decoder's own caps ever get a chance to reject it.
    const huge = new Array<number>((1 << 20) + 1).fill(0);
    const started = Date.now();
    expect(decodeChatPayload(huge).content).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('rejects an array carrying anything that is not a byte', () => {
    expect(decodeChatPayload([1, 2, 999]).content).toBeNull();
    expect(decodeChatPayload([1, 2, -1]).content).toBeNull();
    expect(decodeChatPayload([1, 2, 1.5]).content).toBeNull();
    expect(decodeChatPayload([1, 2, 'x']).content).toBeNull();
  });

  it('ignores non-string entries in mentions rather than passing them on', () => {
    const p = wire({ content: '/about', mentions: ['klv1a', 42, null, 'klv1b'] });
    expect(decodeChatPayload(p).mentions).toEqual(['klv1a', 'klv1b']);
  });

  it('keeps the bot\'s own address even when it is mentioned last', () => {
    // REGRESSION GUARD. Truncating to the first N mentions silently broke a
    // legitimate invocation: a message @-mentioning many people before the bot
    // lost the bot's own address, leaving a non-empty list that does not name it
    // — which `parseCommand` reads as "addressed to someone else".
    const many = [...Array.from({ length: 200 }, (_, i) => `klv1m${i}`), 'klv1bot'];
    const out = decodeChatPayload(wire({ content: '/x', mentions: many }));
    expect(out.mentions).toContain('klv1bot');
  });

  it('drops a mention entry too long to be an address', () => {
    const out = decodeChatPayload(
      wire({ content: '/x', mentions: ['klv1ok', 'z'.repeat(500)] }),
    );
    expect(out.mentions).toEqual(['klv1ok']);
  });

  it('refuses content longer than the node would ever have accepted', () => {
    // The node caps chat at 4096 bytes, and `parseCommand` splits this string on
    // whitespace BEFORE the rate limiter runs — so an uncapped 1 MB content buys
    // a ~500,000-element array per message, for free.
    const tooLong = 'a'.repeat(4097);
    expect(decodeChatPayload(wire({ content: tooLong, mentions: [] })).content).toBeNull();
    expect(decodeChatPayload(wire({ content: 'a'.repeat(4096), mentions: [] })).content).not.toBeNull();
  });

  it('refuses a payload whose arrays exceed the decoder cap outright', () => {
    const tooMany = Array.from({ length: 500 }, (_, i) => `klv1m${i}`);
    expect(decodeChatPayload(wire({ content: '/x', mentions: tooMany })).content).toBeNull();
  });

  it('treats a non-string content as absent', () => {
    expect(decodeChatPayload(wire({ content: 42, mentions: [] })).content).toBeNull();
  });

  it('refuses a decoder bomb rather than allocating for it', () => {
    // @msgpack/msgpack defaults every max* option to UINT32_MAX, so decoding
    // without caps lets one hostile payload force enormous allocation before any
    // check of ours runs. A string past maxStrLength must be refused.
    const bomb = wire({ content: 'a'.repeat((1 << 20) + 10), mentions: [] });
    expect(decodeChatPayload(bomb).content).toBeNull();
  });
});
