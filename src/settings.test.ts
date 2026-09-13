import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deletePath,
  getPath,
  leafPaths,
  loadOverrides,
  mergeOverrides,
  writeOverrides,
  type Overrides,
} from './settings.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ogmara-settings-'));
  file = join(dir, 'settings.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadOverrides', () => {
  it('treats a missing file as no overrides, not an error', () => {
    // The normal case: most bots never open the settings UI.
    expect(loadOverrides(file)).toEqual({ values: {} });
  });

  it('IGNORES a malformed file rather than failing the boot', () => {
    // This file is written by a web form. A bad write must never be able to
    // stop the bot starting — that is the lockout class from the triage rule.
    writeFileSync(file, '{ this is not json', 'utf8');
    const loaded = loadOverrides(file);
    expect(loaded.values).toEqual({});
    expect(loaded.problem).toContain('not valid JSON');
  });

  it('reports a problem loudly rather than silently, so it can be logged', () => {
    writeFileSync(file, '[]', 'utf8');
    expect(loadOverrides(file).problem).toContain('does not contain a JSON object');
  });

  it('ignores a file with no values object', () => {
    writeFileSync(file, '{"nope": 1}', 'utf8');
    expect(loadOverrides(file).problem).toContain('no "values" object');
  });

  it('round-trips what writeOverrides produced', () => {
    writeOverrides(file, { posting: { dryRun: false } });
    expect(loadOverrides(file).values).toEqual({ posting: { dryRun: false } });
  });
});

describe('writeOverrides', () => {
  it('keeps the previous version as .bak so a bad save is recoverable', () => {
    // Recoverable by deleting one file, rather than by reconstructing it.
    writeOverrides(file, { posting: { maxPostsPerHour: 1 } });
    writeOverrides(file, { posting: { maxPostsPerHour: 99 } });
    expect(loadOverrides(file).values).toEqual({ posting: { maxPostsPerHour: 99 } });
    expect(loadOverrides(`${file}.bak`).values).toEqual({ posting: { maxPostsPerHour: 1 } });
  });

  it('leaves a header saying the file is not hand-edited', () => {
    // Two hand-editable layers is one too many; whoever opens this next needs
    // to know config.yaml is the surface they want.
    writeOverrides(file, { a: 1 });
    expect(readFileSync(file, 'utf8')).toContain('Not a hand-editing surface');
  });

  it('writes readable JSON — inspectable is not the same as hand-editable', () => {
    writeOverrides(file, { nested: { value: 1 } });
    expect(readFileSync(file, 'utf8')).toContain('\n  ');
  });
});

describe('mergeOverrides', () => {
  it('merges nested objects rather than replacing them wholesale', () => {
    const base = { posting: { dryRun: true, maxPostsPerHour: 1 } };
    expect(mergeOverrides(base, { posting: { dryRun: false } })).toEqual({
      posting: { dryRun: false, maxPostsPerHour: 1 },
    });
  });

  it('REPLACES an array instead of concatenating it', () => {
    // A feed list or a channel list is a value the operator set, not an
    // accumulation. Merging element-wise would make removing an entry
    // impossible from the UI.
    const base = { bot: { channels: [1, 2, 3] } };
    expect(mergeOverrides(base, { bot: { channels: [7] } })).toEqual({ bot: { channels: [7] } });
  });

  it('does not mutate the base', () => {
    const base = { posting: { dryRun: true } };
    mergeOverrides(base, { posting: { dryRun: false } });
    expect(base.posting.dryRun).toBe(true);
  });

  it('adds keys the base never had', () => {
    expect(mergeOverrides({ a: 1 } as Record<string, unknown>, { b: 2 })).toEqual({ a: 1, b: 2 });
  });
});

describe('path helpers', () => {
  it('reads a dotted path', () => {
    expect(getPath({ sources: { rss: { schedule: '0 * * * *' } } }, 'sources.rss.schedule')).toBe(
      '0 * * * *',
    );
  });

  it('returns undefined for a path that is not there', () => {
    expect(getPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(getPath(undefined, 'a')).toBeUndefined();
  });

  it('PRUNES the objects a delete leaves empty', () => {
    // "Reset to file" has to leave no trace. An overrides file full of empty
    // objects is indistinguishable from one with real overrides when deciding
    // whether a field is UI-set.
    const o: Overrides = { sources: { rss: { schedule: 'x' } } };
    deletePath(o, 'sources.rss.schedule');
    expect(o).toEqual({});
  });

  it('prunes only as far as it should, leaving siblings intact', () => {
    const o: Overrides = { sources: { rss: { schedule: 'x' }, topics: { enabled: true } } };
    deletePath(o, 'sources.rss.schedule');
    expect(o).toEqual({ sources: { topics: { enabled: true } } });
  });

  it('deleting something absent is a no-op, not a throw', () => {
    const o: Overrides = { a: { b: 1 } };
    deletePath(o, 'x.y.z');
    expect(o).toEqual({ a: { b: 1 } });
  });

  it('lists leaf paths, treating an array as a leaf', () => {
    expect(
      leafPaths({ posting: { dryRun: true }, bot: { channels: [1, 2] } }).sort(),
    ).toEqual(['bot.channels', 'posting.dryRun']);
  });
});

describe('prototype-manipulating keys', () => {
  it('drops __proto__ when LOADING a file', () => {
    // JSON.parse creates __proto__ as an ordinary OWN property, so a file
    // written by hand — or by an older build — can carry one.
    writeFileSync(
      file,
      JSON.stringify({ values: JSON.parse('{"__proto__":{"settings":{"auditPath":"/tmp/evil"}}}') }),
      'utf8',
    );
    expect(loadOverrides(file).values).toEqual({});
  });

  it('never ASSIGNS __proto__ during a merge', () => {
    // THE ESCALATION this guards. Assigning __proto__ sets the object's
    // prototype rather than a property, so a merged config resolved missing
    // sections through it and Zod read them as real — relocating the audit log
    // past the file-only guard whose entire job is to prevent that.
    const merged = mergeOverrides(
      { node: { url: 'x' } } as Record<string, unknown>,
      JSON.parse('{"__proto__":{"settings":{"auditPath":"/tmp/evil"}}}'),
    );
    expect((merged as { settings?: unknown }).settings).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });

  it('leaves Object.prototype alone', () => {
    mergeOverrides({} as Record<string, unknown>, JSON.parse('{"__proto__":{"polluted":1}}'));
    mergeOverrides(
      {} as Record<string, unknown>,
      JSON.parse('{"constructor":{"prototype":{"polluted":1}}}'),
    );
    expect((({}) as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('refuses to delete through such a path', () => {
    const keep: Overrides = { a: 1 };
    deletePath(keep, 'constructor.prototype.a');
    expect(keep).toEqual({ a: 1 });
  });
});

describe('file-only sections in the overrides FILE', () => {
  it('strips panel: from a planted overrides file, and says so', () => {
    // THE ESCALATION. The file-only rule lived only in the HTTP guard, so the
    // loader happily merged whatever this file contained. Anything able to
    // write one file into `data/` — a second container on a shared volume, any
    // local process — could turn the loopback bypass back on, install its own
    // adminWallets, and point trustedProxies wherever it liked, all on the next
    // restart, without ever touching the API.
    writeFileSync(
      file,
      JSON.stringify({
        values: {
          panel: { requireLogin: false, adminWallets: ['klv1attacker'] },
          posting: { maxPostsPerHour: 4 },
        },
      }),
      'utf8',
    );
    const loaded = loadOverrides(file);
    // The rest of the file SURVIVES. Reporting this as a whole-file problem
    // made the caller discard every override, so one planted section silently
    // reverted all of the operator's real settings — while the message said
    // only that section had been ignored.
    expect(loaded.values).toEqual({ posting: { maxPostsPerHour: 4 } });
    expect(loaded.stripped).toContain('config.yaml only');
    expect(loaded.problem).toBeUndefined();
  });

  it('strips settings: too — the section that relocates the audit trail', () => {
    // It compounded: the overrides file and the audit log are written to paths
    // from `settings:`, so the same write made the next save overwrite an
    // arbitrary file and every audit line land somewhere the attacker chose.
    writeFileSync(
      file,
      JSON.stringify({ values: { settings: { auditPath: '/tmp/attacker.log' } } }),
      'utf8',
    );
    expect(loadOverrides(file).values).toEqual({});
  });

  it('IGNORES an over-deep file rather than silently truncating it', () => {
    // Returning undefined for the over-deep subtree handed back a config that
    // looked valid and was not the one in the file. Loudly ignored beats
    // quietly wrong.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 60; i += 1) deep = { a: deep };
    writeFileSync(file, JSON.stringify({ values: { posting: { x: 1 }, deep } }), 'utf8');
    const loaded = loadOverrides(file);
    expect(loaded.values).toEqual({});
    expect(loaded.problem).toContain('could not be processed');
  });

  it('does not throw on a file nested deeply enough to blow the stack', () => {
    // loadOverrides promises never to throw. A RangeError escaping it reached
    // loadLayeredConfig and stopped the bot booting until someone deleted the
    // file by hand — a config lockout from an untrusted file.
    // Built as text, not via JSON.stringify(deepObject): stringify walks the
    // object graph recursively too, so on a runner with a smaller stack than
    // this machine's it blew ITS OWN stack building the fixture — failing
    // the test before loadOverrides (the thing actually under test) ever ran.
    // String concatenation has no call depth regardless of nesting depth.
    const deepJson = `${'{"a":'.repeat(20_000)}"leaf"${'}'.repeat(20_000)}`;
    writeFileSync(file, `{"values":${deepJson}}`, 'utf8');
    expect(() => loadOverrides(file)).not.toThrow();
  });
});
