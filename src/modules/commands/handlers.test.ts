import { describe, expect, it } from 'vitest';
import type { Config } from '../../config.js';
import { botSchema } from './schema.js';
import { buildHandlers } from './handlers.js';

function configWith(topics: string[] = []): Config {
  return {
    sources: {
      rss: { enabled: false, feeds: [] },
      topics: { enabled: topics.length > 0, topics },
      imagedir: { enabled: false, directories: [] },
    },
  } as unknown as Config;
}

const handlers = (topics: string[] = ['Klever']) =>
  buildHandlers(configWith(topics), botSchema.parse({ commands: [] }));

const run = async (name: string, args: string[]): Promise<string> => {
  const result = await handlers().get(name)!.run(args);
  if (result === null) return '';
  return typeof result === 'string' ? result : result.text;
};

describe('command handlers', () => {
  it('preserves argument CASE', async () => {
    // The SDK lowercases the command token only, never the arguments —
    // lowercasing a ticker or a topic sends the bot looking up a different
    // thing entirely.
    expect(await run('topic', ['Klever'])).toContain('Yes');
    expect(await run('topic', ['KLEVER'])).toContain('Yes');
  });

  it('every built-in costs 1', async () => {
    // REGRESSION GUARD. A cost above 1 is unaffordable on the unregistered tier
    // (the derived per-wallet window cap floors at 1), and startup then refuses
    // the whole config — so a costed built-in breaks the default setup for
    // exactly the operators least able to diagnose it.
    for (const [name, h] of handlers()) {
      expect(h.cost ?? 1, `/${name} must cost 1`).toBe(1);
    }
  });

  it('clips a reply by BYTES, not UTF-16 units', async () => {
    // The node measures its 4096-byte chat cap in bytes. ~1360 CJK characters
    // is under any character-based cap and over the byte one, and the node then
    // rejects the send AFTER the reply budget has been spent on it.
    const cjk = '\u4ef7'.repeat(2000);
    const out = await run('topic', [cjk]);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1600);
  });

  it('never splits a surrogate pair when truncating', async () => {
    const astral = '\u{20000}'.repeat(200);
    const out = await run('topic', [astral]);
    expect(out).not.toContain('\uFFFD');
  });

  it('says so plainly when an argument survives sanitising as nothing', async () => {
    // An all-emoji or all-invisible topic reduces to the empty string, and
    // `Yes — "" is one of the topics` would be nonsense.
    expect(await run('topic', ['\u{1F680}\u{1F680}'])).toContain('does not look like');
  });

  it('lists only commands the operator declared, in /help', async () => {
    const declared = botSchema.parse({
      commands: [{ name: 'about', description: 'who I am', argsHint: '[x]' }],
    });
    const h = buildHandlers(configWith(), declared);
    const out = (await h.get('help')!.run([])) ?? '';
    expect(out).toContain('/about [x]');
    expect(out).not.toContain('/topic');
  });

  it('reports source COUNTS rather than naming an operator\'s feeds', async () => {
    // An operator's feed list is their business, and a bot that enumerates its
    // configuration on request is an information-disclosure surface for no gain.
    const out = (await handlers(['Klever']).get('sources')!.run([])) ?? '';
    expect(out).toContain('1 topic');
    expect(out).not.toContain('Klever');
  });
});
