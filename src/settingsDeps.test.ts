import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLayeredConfig, type Secrets } from './config.js';
import { createSettingsDeps } from './settingsDeps.js';

let dir: string;
let configPath: string;
let overridesPath: string;

const CONFIG_YAML = (extra = '') => `
node:
  url: https://node.example
  network: testnet
posting:
  maxPostsPerHour: 3
settings:
  path: OVERRIDES
  auditPath: AUDIT
${extra}`;

const secrets: Secrets = { walletKeyHex: 'ab'.repeat(32), anthropicApiKey: 'sk-test' };

function makeDeps(extra = ''): ReturnType<typeof createSettingsDeps> {
  writeFileSync(
    configPath,
    CONFIG_YAML(extra).replace('OVERRIDES', overridesPath).replace('AUDIT', join(dir, 'audit.log')),
    'utf8',
  );
  const layered = loadLayeredConfig(configPath, overridesPath, () => {});
  return createSettingsDeps({ configPath, layered, modules: [], secrets });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ogmara-deps-'));
  configPath = join(dir, 'config.yaml');
  overridesPath = join(dir, 'data', 'settings.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('apply', () => {
  it('writes an override and makes it effective', () => {
    const deps = makeDeps();
    expect(deps.apply({ posting: { maxPostsPerHour: 9 } })).toEqual({ ok: true });
    expect(deps.describe().effective.posting.maxPostsPerHour).toBe(9);
    expect(JSON.parse(readFileSync(overridesPath, 'utf8')).values).toEqual({
      posting: { maxPostsPerHour: 9 },
    });
  });

  it('creates data/ on the FIRST save', () => {
    // On a fresh install nothing has written `data/` yet, so the first settings
    // save is exactly the case that used to throw ENOENT and surface as a bare
    // 500 with no audit row explaining it.
    const deps = makeDeps();
    expect(deps.apply({ posting: { maxPostsPerHour: 2 } })).toEqual({ ok: true });
    expect(readFileSync(overridesPath, 'utf8')).toContain('maxPostsPerHour');
  });

  it('leaves BOTH the file and the in-memory state untouched when invalid', () => {
    // A rejected write must not half-apply: the state the next read sees and
    // the state the next boot loads have to be the same one.
    const deps = makeDeps();
    deps.apply({ posting: { maxPostsPerHour: 5 } });
    const result = deps.apply({ posting: { maxPostsPerHour: -1 } });
    expect(result.ok).toBe(false);
    expect(deps.describe().effective.posting.maxPostsPerHour).toBe(5);
    expect(JSON.parse(readFileSync(overridesPath, 'utf8')).values.posting.maxPostsPerHour).toBe(5);
  });

  it('validates the MERGED config, not the change in isolation', () => {
    // A field that is individually valid can still be invalid in combination,
    // and the schema is the only thing that knows.
    const deps = makeDeps();
    expect(deps.apply({ node: { url: 'not-a-url' } }).ok).toBe(false);
  });

  it('accumulates overrides rather than replacing the whole set', () => {
    const deps = makeDeps();
    deps.apply({ posting: { maxPostsPerHour: 4 } });
    deps.apply({ posting: { dryRun: false } });
    const values = JSON.parse(readFileSync(overridesPath, 'utf8')).values;
    expect(values.posting).toEqual({ maxPostsPerHour: 4, dryRun: false });
  });
});

describe('reset', () => {
  it('drops the override so the field tracks config.yaml again', () => {
    const deps = makeDeps();
    deps.apply({ posting: { maxPostsPerHour: 9 } });
    expect(deps.reset('posting.maxPostsPerHour')).toEqual({ ok: true });
    // 3 is what config.yaml says — NOT the schema default.
    expect(deps.describe().effective.posting.maxPostsPerHour).toBe(3);
    expect(deps.describe().fromUi).toEqual({});
  });

  it('keeps tracking config.yaml AFTER a later hand-edit', () => {
    // The point of deleting the override rather than writing the file's value
    // into it: reset means "follow the file", not "freeze today's file value".
    const deps = makeDeps();
    deps.apply({ posting: { maxPostsPerHour: 9 } });
    deps.reset('posting.maxPostsPerHour');
    writeFileSync(
      configPath,
      CONFIG_YAML().replace('maxPostsPerHour: 3', 'maxPostsPerHour: 7')
        .replace('OVERRIDES', overridesPath)
        .replace('AUDIT', join(dir, 'audit.log')),
      'utf8',
    );
    deps.apply({ posting: { dryRun: false } }); // any write re-reads the file
    expect(deps.describe().effective.posting.maxPostsPerHour).toBe(7);
  });

  it('resetting something never overridden is harmless', () => {
    const deps = makeDeps();
    expect(deps.reset('posting.dryRun')).toEqual({ ok: true });
  });
});

describe('a broken config.yaml', () => {
  it('REFUSES a write instead of merging onto an empty base', () => {
    // Merging onto `{}` produced an error blaming a field the operator never
    // touched ("node: expected object, received undefined"), with nothing
    // pointing at the real problem.
    const deps = makeDeps();
    writeFileSync(configPath, 'node: [this is\n  not: valid: yaml:', 'utf8');
    const result = deps.apply({ posting: { maxPostsPerHour: 2 } });
    expect(result.ok).toBe(false);
    expect((result as { issues: string[] }).issues.join(' ')).toContain('config.yaml');
  });

  it('keeps the last good provenance rather than reporting everything as default', () => {
    // Otherwise every badge flips to `default` while an editor is open, and
    // "reset to file" silently means something else.
    const deps = makeDeps();
    expect(deps.describe().fromFile).toHaveProperty('node');
    writeFileSync(configPath, ': : :', 'utf8');
    expect(deps.describe().fromFile).toHaveProperty('node');
  });
});

describe('a planted overrides file', () => {
  it('keeps the operator\'s real overrides while dropping the smuggled section', () => {
    // One planted section must not revert everything else the operator set.
    writeFileSync(
      configPath,
      CONFIG_YAML().replace('OVERRIDES', overridesPath).replace('AUDIT', join(dir, 'audit.log')),
      'utf8',
    );
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(
      overridesPath,
      JSON.stringify({
        values: {
          posting: { maxPostsPerHour: 9 },
          panel: { requireLogin: false, adminWallets: ['klv1attacker'] },
        },
      }),
      'utf8',
    );
    const warnings: string[] = [];
    const layered = loadLayeredConfig(configPath, overridesPath, (m) => warnings.push(m));
    expect(layered.config.posting.maxPostsPerHour).toBe(9); // real override kept
    // The escalation itself: the planted admin wallet must not be installed.
    // (`requireLogin` is not asserted here — this config sets no `panel:` block,
    // so its value is the schema default either way and would prove nothing.)
    expect(layered.config.panel.adminWallets).not.toContain('klv1attacker');
    expect(layered.config.panel.adminWallets).toEqual([]);
    expect(warnings.join(' ')).toContain('config.yaml only');
  });
});

describe('uiSchema collisions', () => {
  it('refuses two modules claiming the same path, rather than letting order decide', () => {
    // Which module's `restart`/`confirm` applied would otherwise depend on
    // registration order — and a field mislabelled as live when it is not is
    // exactly the lie the restart flag exists to prevent.
    //
    // A path with no core entry, deliberately — using a core path here would
    // also trip the module-vs-core guard below and stop isolating this case.
    const mod = (name: string): never =>
      ({ name, schemas: {}, uiSchema: { 'bot.handle': { label: 'x', restart: false } } }) as never;
    writeFileSync(
      configPath,
      CONFIG_YAML().replace('OVERRIDES', overridesPath).replace('AUDIT', join(dir, 'audit.log')),
      'utf8',
    );
    const layered = loadLayeredConfig(configPath, overridesPath, () => {});
    expect(() =>
      createSettingsDeps({ configPath, layered, modules: [mod('a'), mod('b')], secrets }),
    ).toThrow(/both declare a uiSchema/);
  });

  it('refuses a module claiming a path CORE already owns, not just another module', () => {
    // REGRESSION GUARD. `owner` used to be seeded only inside the module loop,
    // so a module touching a core path (posting.dryRun, node.network, ...)
    // silently overwrote core's entry with no error — including dropping
    // `confirm: true` from a field flagged specifically because a wrong value
    // is expensive (posting.dryRun) or irreversible (node.network). "No
    // current module touches a core path" was true when that code was written
    // and is not a structural guarantee.
    const mod = (name: string): never =>
      ({ name, schemas: {}, uiSchema: { 'posting.dryRun': { label: 'x', restart: false } } }) as never;
    writeFileSync(
      configPath,
      CONFIG_YAML().replace('OVERRIDES', overridesPath).replace('AUDIT', join(dir, 'audit.log')),
      'utf8',
    );
    const layered = loadLayeredConfig(configPath, overridesPath, () => {});
    expect(() =>
      createSettingsDeps({ configPath, layered, modules: [mod('a')], secrets }),
    ).toThrow(/both declare a uiSchema/);
  });

  it('describes a DISABLED module\'s fields just as fully as an enabled one', () => {
    // `collectUiSchema` must never filter by `isEnabled` — this is the
    // invariant a real, user-found bug depended on: `index.ts` used to pass
    // only the ENABLED-module list here (the same list it uses to actually
    // START modules), so a module's own `enabled` flag — a field the
    // module's OWN uiSchema describes, e.g. `bot.enabled` — was
    // undiscoverable and unlabelled from the settings page for as long as it
    // stayed off. An operator could never turn on a disabled module from the
    // panel, only by hand-editing config.yaml first. The fix was entirely at
    // that ONE call site (pass `allModules`, not the enabled-only list) —
    // this file has no seam to unit-test `index.ts`'s own composition
    // directly, so this test instead pins the mechanism the fix relies on:
    // `isEnabled` is set on this fixture and never called by the code under
    // test, which is exactly the property that must hold for `index.ts`'s
    // fix to actually work.
    const mod = { name: 'a', schemas: {}, isEnabled: () => false, uiSchema: {
      'bot.handle': { label: 'field.a.label', help: 'field.a.help', restart: true },
    } } as never;
    writeFileSync(
      configPath,
      CONFIG_YAML().replace('OVERRIDES', overridesPath).replace('AUDIT', join(dir, 'audit.log')),
      'utf8',
    );
    const layered = loadLayeredConfig(configPath, overridesPath, () => {});
    const deps = createSettingsDeps({ configPath, layered, modules: [mod], secrets });
    expect(deps.describe().ui['bot.handle']).toEqual({
      label: 'field.a.label',
      help: 'field.a.help',
      restart: true,
    });
  });
});

describe('--dry-run forcing', () => {
  it('survives a save, so the page never contradicts the running process', () => {
    // Handing in an already-forced config was not enough: `commit` replaced it
    // with a freshly merged one and the forcing was lost, so saving ANY
    // unrelated setting made the page report `dryRun: false` while the bot was
    // genuinely in dry run.
    writeFileSync(
      configPath,
      CONFIG_YAML('  dryRun: false\n').replace('OVERRIDES', overridesPath)
        .replace('AUDIT', join(dir, 'audit.log'))
        .replace('posting:\n  maxPostsPerHour: 3', 'posting:\n  maxPostsPerHour: 3\n  dryRun: false'),
      'utf8',
    );
    const layered = loadLayeredConfig(configPath, overridesPath, () => {});
    const force = (c: typeof layered.config): typeof layered.config => ({
      ...c,
      posting: { ...c.posting, dryRun: true },
    });
    const deps = createSettingsDeps({
      configPath,
      layered: { ...layered, config: force(layered.config) },
      modules: [],
      secrets,
      applyCliOverrides: force,
    });

    expect(deps.describe().effective.posting.dryRun).toBe(true);
    deps.apply({ posting: { maxPostsPerHour: 5 } }); // an UNRELATED save
    expect(deps.describe().effective.posting.dryRun).toBe(true);
  });
});

describe('writeOverrides', () => {
  it('does not rewrite unchanged content, so the .bak survives', () => {
    // Every save overwrote the backup, including a reset of a field that was
    // never overridden — so "recoverable by deleting one file" survived exactly
    // one more click anywhere in the UI.
    const deps = makeDeps();
    deps.apply({ posting: { maxPostsPerHour: 5 } });
    deps.apply({ posting: { maxPostsPerHour: 9 } });
    expect(JSON.parse(readFileSync(`${overridesPath}.bak`, 'utf8')).values.posting.maxPostsPerHour)
      .toBe(5);
    // A no-op save must not consume the backup.
    deps.apply({ posting: { maxPostsPerHour: 9 } });
    expect(JSON.parse(readFileSync(`${overridesPath}.bak`, 'utf8')).values.posting.maxPostsPerHour)
      .toBe(5);
  });
});

describe('secrets', () => {
  it('reports presence only — never a value', () => {
    const present = makeDeps().secretsPresent();
    expect(present.ANTHROPIC_API_KEY).toBe(true);
    expect(present.OPENAI_API_KEY).toBe(false);
    expect(JSON.stringify(present)).not.toContain('sk-test');
  });
});

describe('config object identity (the hot-reload disconnect fix)', () => {
  it('a save mutates the SAME config object index.ts was handed, rather than replacing it', () => {
    // This is the regression this whole feature exists to fix: `index.ts`
    // threads ONE config object into `ctx.config`, `OgmaraPublisher`, etc.
    // If `commit()` ever goes back to reassigning its own local variable
    // instead of mutating that object's fields, every one of those holders
    // freezes at boot-time values again and every "live" badge in the panel
    // goes back to being false advertising.
    writeFileSync(
      configPath,
      CONFIG_YAML().replace('OVERRIDES', overridesPath).replace('AUDIT', join(dir, 'audit.log')),
      'utf8',
    );
    const layered = loadLayeredConfig(configPath, overridesPath, () => {});
    const configRef = layered.config;
    const deps = createSettingsDeps({ configPath, layered, modules: [], secrets });

    expect(deps.apply({ posting: { maxPostsPerHour: 9 } })).toEqual({ ok: true });

    // The object `index.ts` is still holding a reference to must show the
    // new value directly — not just what `describe()` reports.
    expect(configRef.posting.maxPostsPerHour).toBe(9);
    expect(configRef).toBe(deps.describe().effective);
  });

  it('mutates nested section objects in place too, not just the top-level config', () => {
    // A module that captured `ctx.config.posting` itself (not `ctx.config`)
    // must also observe the write — `applyConfigInPlace` has to recurse,
    // not just replace `effective.posting` with a new object.
    writeFileSync(
      configPath,
      CONFIG_YAML().replace('OVERRIDES', overridesPath).replace('AUDIT', join(dir, 'audit.log')),
      'utf8',
    );
    const layered = loadLayeredConfig(configPath, overridesPath, () => {});
    const postingRef = layered.config.posting;
    const deps = createSettingsDeps({ configPath, layered, modules: [], secrets });

    deps.apply({ posting: { maxPostsPerHour: 11 } });
    expect(postingRef.maxPostsPerHour).toBe(11);
  });
});

describe('clearing an optional field with no default (the applyConfigInPlace omitted-key bug)', () => {
  it('sources.imagedir.contentRating actually disappears from `effective` after a reset, not just from the file', () => {
    // `contentRating` is `z.optional()` with NO `.default()` — Zod omits it
    // from the parsed config entirely when unset, it is not merely
    // `undefined`. `applyConfigInPlace` (config.ts) has to delete it from
    // the live object on a clearing save, or `effective` keeps reporting
    // the stale value forever while a restart (or `describe()`'s own
    // separate re-read of the file for provenance) would correctly show it
    // unset — the exact "settings page and the process disagree" bug this
    // whole feature exists to close, for the one field shape that isn't a
    // plain overwrite.
    const deps = makeDeps();
    expect(deps.apply({ sources: { imagedir: { contentRating: 'mature' } } })).toEqual({ ok: true });
    expect(deps.describe().effective.sources.imagedir.contentRating).toBe('mature');

    expect(deps.reset('sources.imagedir.contentRating')).toEqual({ ok: true });
    expect(deps.describe().effective.sources.imagedir.contentRating).toBeUndefined();
  });
});

describe('reconfigureHooks', () => {
  function makeDepsWithHooks(
    hooks: import('./settingsDeps.js').ReconfigureHook[],
  ): ReturnType<typeof createSettingsDeps> {
    writeFileSync(
      configPath,
      CONFIG_YAML().replace('OVERRIDES', overridesPath).replace('AUDIT', join(dir, 'audit.log')),
      'utf8',
    );
    const layered = loadLayeredConfig(configPath, overridesPath, () => {});
    return createSettingsDeps({ configPath, layered, modules: [], secrets, reconfigureHooks: hooks });
  }

  it('fires when its path actually changes', () => {
    const calls: unknown[] = [];
    const deps = makeDepsWithHooks([
      { path: 'posting.maxPostsPerHour', apply: (v) => { calls.push(v); } },
    ]);
    deps.apply({ posting: { maxPostsPerHour: 9 } });
    expect(calls).toEqual([9]);
  });

  it('does NOT fire when an unrelated field changes', () => {
    const calls: unknown[] = [];
    const deps = makeDepsWithHooks([
      { path: 'posting.maxPostsPerHour', apply: (v) => { calls.push(v); } },
    ]);
    deps.apply({ posting: { dryRun: false } });
    expect(calls).toEqual([]);
  });

  it('does NOT fire when the save reasserts the value already in effect', () => {
    const calls: unknown[] = [];
    const deps = makeDepsWithHooks([
      { path: 'posting.maxPostsPerHour', apply: (v) => { calls.push(v); } },
    ]);
    deps.apply({ posting: { maxPostsPerHour: 3 } }); // config.yaml already says 3
    expect(calls).toEqual([]);
  });

  it('does NOT fire on a rejected (invalid) save', () => {
    const calls: unknown[] = [];
    const deps = makeDepsWithHooks([
      { path: 'posting.maxPostsPerHour', apply: (v) => { calls.push(v); } },
    ]);
    const result = deps.apply({ posting: { maxPostsPerHour: -1 } });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('fires each independently-changed hook exactly once, ignores untouched ones', () => {
    const changed: string[] = [];
    const deps = makeDepsWithHooks([
      { path: 'posting.maxPostsPerHour', apply: () => { changed.push('rate'); } },
      { path: 'posting.dryRun', apply: () => { changed.push('dryRun'); } },
      { path: 'storage.retentionDays', apply: () => { changed.push('retention'); } },
    ]);
    deps.apply({ posting: { maxPostsPerHour: 9, dryRun: false } });
    expect(changed.sort()).toEqual(['dryRun', 'rate']);
  });

  it('a throwing hook does not fail the save or block later hooks from running', () => {
    // The write and the in-memory mutation already succeeded by the time
    // hooks run — a hook is a best-effort notification, not a step the
    // save can still fail on.
    const ran: string[] = [];
    const deps = makeDepsWithHooks([
      {
        path: 'posting.maxPostsPerHour',
        apply: () => {
          throw new Error('boom');
        },
      },
      { path: 'posting.dryRun', apply: () => { ran.push('dryRun'); } },
    ]);
    const result = deps.apply({ posting: { maxPostsPerHour: 9, dryRun: false } });
    expect(result).toEqual({ ok: true });
    expect(ran).toEqual(['dryRun']);
    // The save itself is unaffected by the throw.
    expect(deps.describe().effective.posting.maxPostsPerHour).toBe(9);
  });

  describe('async hooks', () => {
    // `apply()` may return a Promise — rebuilding an AI provider, swapping
    // a network client, or a module's own reconfigure() are all genuinely
    // async. `commit()` never awaits it (a save must not block on a
    // live-apply side effect); these tests confirm that guarantee AND that
    // an async hook's eventual success/failure is still observable and
    // still doesn't disturb the rest of the hook loop.

    it("apply() returning a pending Promise does not make deps.apply() wait for it", () => {
      let resolveHook: (() => void) | undefined;
      const deps = makeDepsWithHooks([
        {
          path: 'posting.maxPostsPerHour',
          apply: () =>
            new Promise<void>((resolve) => {
              resolveHook = resolve;
            }),
        },
      ]);
      const result = deps.apply({ posting: { maxPostsPerHour: 9 } });
      // Synchronous return, even though the hook's own promise is still
      // pending — proven by the fact resolveHook was captured but never
      // called, and the save already reports success.
      expect(result).toEqual({ ok: true });
      expect(resolveHook).toBeDefined();
    });

    it('an async hook that eventually resolves does not throw or reject anywhere observable', async () => {
      let resolved = false;
      const deps = makeDepsWithHooks([
        {
          path: 'posting.maxPostsPerHour',
          apply: async () => {
            await Promise.resolve();
            resolved = true;
          },
        },
      ]);
      deps.apply({ posting: { maxPostsPerHour: 9 } });
      await new Promise((r) => setTimeout(r, 0)); // let the microtask queue drain
      expect(resolved).toBe(true);
    });

    it('an async hook that REJECTS does not become an unhandled rejection, and does not block later hooks', async () => {
      const ran: string[] = [];
      const deps = makeDepsWithHooks([
        {
          path: 'posting.maxPostsPerHour',
          apply: async () => {
            await Promise.resolve();
            throw new Error('async boom');
          },
        },
        { path: 'posting.dryRun', apply: () => { ran.push('dryRun'); } },
      ]);
      const unhandled: unknown[] = [];
      const onUnhandled = (err: unknown): void => {
        unhandled.push(err);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const result = deps.apply({ posting: { maxPostsPerHour: 9, dryRun: false } });
        expect(result).toEqual({ ok: true });
        expect(ran).toEqual(['dryRun']);
        await new Promise((r) => setTimeout(r, 0)); // let the rejection's .catch() run
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  });

  it('receives the up-to-date effective config as its second argument', () => {
    let seenRate: number | undefined;
    const deps = makeDepsWithHooks([
      {
        path: 'posting.maxPostsPerHour',
        apply: (_v, config) => {
          seenRate = config.posting.maxPostsPerHour;
        },
      },
    ]);
    deps.apply({ posting: { maxPostsPerHour: 9 } });
    expect(seenRate).toBe(9);
  });
});
