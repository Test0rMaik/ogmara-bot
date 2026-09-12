import { describe, expect, it } from 'vitest';
import { COMMAND_LIMITS, botSchema } from './schema.js';

const parse = (bot: Record<string, unknown>): ReturnType<typeof botSchema.safeParse> =>
  botSchema.safeParse(bot);

describe('bot config schema', () => {
  it('defaults to disabled, so an absent section is never an error', () => {
    const cfg = botSchema.parse({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.commands).toEqual([]);
  });

  it('rejects a command name with a leading slash', () => {
    // The config carries bare names; the "/" is display only. Accepting "/help"
    // would publish a command called "/help" that no client can ever match.
    expect(parse({ commands: [{ name: '/help', description: 'x' }] }).success).toBe(false);
  });

  it('rejects an uppercase command name', () => {
    // Consumers match case-insensitively, so "/Dom" would be a command that can
    // never be distinguished from "/dom".
    expect(parse({ commands: [{ name: 'Dom', description: 'x' }] }).success).toBe(false);
  });

  it('measures description length in BYTES, not characters', () => {
    // The trap: a CJK character costs three bytes, so 128 characters of Chinese
    // is 384 bytes and the node refuses the descriptor. A `.max(128)` on the
    // string would pass config load and fail at startup against a live node,
    // where the error is far less legible.
    const ascii = 'a'.repeat(COMMAND_LIMITS.MAX_DESCRIPTION_BYTES);
    expect(parse({ commands: [{ name: 'x', description: ascii }] }).success).toBe(true);

    const cjk = '价'.repeat(COMMAND_LIMITS.MAX_DESCRIPTION_BYTES / 3 + 1); // > 128 bytes
    const result = parse({ commands: [{ name: 'x', description: cjk }] });
    expect(result.success).toBe(false);
  });

  it('accepts CJK that fits inside the byte budget', () => {
    // The cap must not become "ASCII only" by accident — the picker has to
    // render Chinese, Cyrillic and Persian descriptions.
    const cjk = '价'.repeat(40); // 120 bytes
    expect(parse({ commands: [{ name: 'x', description: cjk }] }).success).toBe(true);
  });

  it('accepts emoji and Persian descriptions', () => {
    expect(parse({ commands: [{ name: 'x', description: '📊 قیمت' }] }).success).toBe(true);
  });

  it('rejects control and bidi-override codepoints in a description', () => {
    // These throw at SIGNING time in the SDK — at startup, against a live node.
    // Catching them here is the whole reason this schema exists: it turns the
    // mistake into a YAML line number instead of a stack trace on boot.
    const rlo = 'price \u202E tsoc';
    expect(parse({ commands: [{ name: 'x', description: rlo }] }).success).toBe(false);
    expect(parse({ commands: [{ name: 'x', description: 'a\u0000b' }] }).success).toBe(false);
    expect(parse({ commands: [{ name: 'x', description: 'a\u200Bb' }] }).success).toBe(false);
    expect(
      parse({ commands: [{ name: 'x', description: 'ok', argsHint: '<a\u202Db>' }] }).success,
    ).toBe(false);
  });

  it('PERMITS zero-width joiner and non-joiner', () => {
    // Deliberately not banned: ZWJ/ZWNJ are required for emoji sequences and for
    // correct Persian and Indic orthography. Banning them would make legitimate
    // descriptions unwritable in those scripts, and they carry none of the
    // spoofing power the bidi *overrides* do.
    expect(parse({ commands: [{ name: 'x', description: 'a\u200Cb' }] }).success).toBe(true);
    expect(parse({ commands: [{ name: 'x', description: 'a\u200Db' }] }).success).toBe(true);
  });

  it('caps how many channels may be listed', () => {
    const many = Array.from({ length: 65 }, (_, i) => i + 1);
    expect(parse({ channels: many }).success).toBe(false);
  });

  it('rejects an empty description', () => {
    expect(parse({ commands: [{ name: 'x', description: '' }] }).success).toBe(false);
  });

  it('caps the number of commands', () => {
    const many = Array.from({ length: COMMAND_LIMITS.MAX_COMMANDS + 1 }, (_, i) => ({
      name: `c${i}`,
      description: 'x',
    }));
    expect(parse({ commands: many }).success).toBe(false);
  });

  it('requires an ASCII handle', () => {
    // The handle is a display convenience for `/cmd@handle`. Non-ASCII there
    // would make disambiguation depend on the invoker's keyboard.
    expect(parse({ handle: 'newsbot' }).success).toBe(true);
    expect(parse({ handle: 'ニュース' }).success).toBe(false);
    expect(parse({ handle: 'ab' }).success).toBe(false); // under MIN_HANDLE
  });

  it('defaults the reply budget to half the wallet quota, not all of it', () => {
    // The other half stays reserved for the news pipeline. A default of 1 would
    // let a busy channel exhaust the daily quota and silently stop the posting
    // the bot exists for.
    expect(botSchema.parse({}).rateLimit.maxShareOfNodeBudget).toBe(0.5);
  });

  it('rejects a share of zero', () => {
    expect(parse({ rateLimit: { maxShareOfNodeBudget: 0 } }).success).toBe(false);
  });
});
