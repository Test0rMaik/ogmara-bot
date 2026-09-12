import { describe, expect, it } from 'vitest';
import { encode } from '@msgpack/msgpack';
import { decodeChatPayload } from './payload.js';

/** As the WS delivers it: JSON has no byte array, so the payload is number[]. */
const wire = (obj: unknown): number[] => Array.from(encode(obj));

describe('decodeChatPayload', () => {
  it('reads content and mentions out of a real msgpack payload', () => {
    const p = wire({ content: '/about', mentions: ['klv1bot'] });
    expect(decodeChatPayload(p)).toEqual({ content: '/about', mentions: ['klv1bot'] });
  });

  it('accepts a Uint8Array as well as a number array', () => {
    expect(decodeChatPayload(encode({ content: 'hi', mentions: [] })).content).toBe('hi');
  });

  it('reads a payload with no mentions at all', () => {
    expect(decodeChatPayload(wire({ content: '/help' }))).toEqual({
      content: '/help',
      mentions: [],
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
