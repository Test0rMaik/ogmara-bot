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
    const mod = (name: string): never =>
      ({ name, schemas: {}, uiSchema: { 'posting.dryRun': { label: 'x', restart: false } } }) as never;
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
