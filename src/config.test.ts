import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configFieldTypes, configPaths, loadConfig, sourcesSchema } from './config.js';
import { FILE_ONLY_IN_OVERRIDES, leafPaths } from './settings.js';
import { FILE_ONLY_SECTIONS } from './panel/settings.js';

/**
 * Regression coverage for a real user-reported bug: `posting.maxPostsPerHour`
 * used to be validated at config-load time against `nodeDailyUnverified`
 * ALWAYS, regardless of the wallet's actual on-chain registration status.
 * Config validation is synchronous with no network access, so it has no way
 * to know a wallet is registered — the check was really "would this be safe
 * for a wallet that never registers," which made it a hard startup failure
 * for anyone who registered and then raised their cadence to match. The
 * real per-tier check now happens in index.ts's `dailyBudgetWarning`
 * (index.test.ts) once registration status is actually known, as a
 * non-fatal warning rather than a ConfigError.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsbot-cfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function load(postingYaml: string) {
  const path = join(dir, 'config.yaml');
  writeFileSync(path, `node:\n  url: http://localhost:8080\n${postingYaml}`);
  return loadConfig(path);
}

describe('sourcesSchema', () => {
  it('rejects every enabled source left fully unconfigured', () => {
    // REGRESSION GUARD, same shape as commands/schema.ts's bot.channels fix:
    // this combination was already fatal at preflight() (news.ts), but that
    // check runs too late once sources.*.enabled/feeds/topics/directories
    // are live-appliable — the bad value would already be written to disk
    // before preflight ever saw it. Closing it here means commit() refuses
    // the write outright.
    expect(sourcesSchema.safeParse({ rss: { enabled: true, feeds: [] } }).success).toBe(false);
    expect(sourcesSchema.safeParse({ topics: { enabled: true, topics: [] } }).success).toBe(false);
    expect(
      sourcesSchema.safeParse({ imagedir: { enabled: true, directories: [] } }).success,
    ).toBe(false);
  });

  it('accepts an unconfigured source as long as ANOTHER enabled one is configured', () => {
    expect(
      sourcesSchema.safeParse({
        rss: { enabled: true, feeds: [] },
        topics: { enabled: true, topics: ['klever'] },
      }).success,
    ).toBe(true);
  });

  it('accepts every source disabled and unconfigured — the all-off default', () => {
    expect(sourcesSchema.safeParse({}).success).toBe(true);
  });

  it('accepts an unconfigured source as long as it is disabled', () => {
    expect(sourcesSchema.safeParse({ rss: { enabled: false, feeds: [] } }).success).toBe(true);
  });
});

describe('posting.maxPostsPerHour', () => {
  it('no longer fails config load for a cadence that only exceeds the UNVERIFIED tier', () => {
    // 2 posts/hour x 24h = 48, which is > 50 (default nodeDailyUnverified) x
    // 0.8 = 40 — this used to be a hard ConfigError even for a registered
    // wallet, which caps out at 300/day.
    const config = load('posting:\n  dryRun: false\n  maxPostsPerHour: 2');
    expect(config.posting.maxPostsPerHour).toBe(2);
  });

  it('still accepts the default of 1', () => {
    expect(load('').posting.maxPostsPerHour).toBe(1);
  });

  it('still rejects a genuinely out-of-range value via its own bound', () => {
    expect(() => load('posting:\n  maxPostsPerHour: 1000')).toThrow(/invalid configuration/);
  });

  it('accepts a cadence appropriate for a REGISTERED wallet (up to 300/day)', () => {
    // 10/hour x 24h = 240, comfortably under the registered daily ceiling —
    // this is exactly the case a registered operator should be able to
    // configure without a startup failure.
    const config = load('posting:\n  dryRun: false\n  maxPostsPerHour: 10');
    expect(config.posting.maxPostsPerHour).toBe(10);
  });
});

describe('configPaths', () => {
  it('declares EXACTLY the paths a fully populated config has', () => {
    // The one test that catches the whole class. `configPaths` walks the Zod
    // schema unwrapping optional/default/prefault; if a section ever gains a
    // `.transform()` or `.pipe()`, `walkSchema` stops at it and every child
    // under it becomes unsettable through the API — silently re-breaking the
    // regression that made `profile.displayName` and `bot.handle` impossible to
    // set, with an error blaming the operator for a typo.
    //
    // config.example.yaml exercises far more of the schema than a minimal file;
    // the only legitimate difference is optional fields it leaves unset.
    const config = loadConfig('config.example.yaml');
    const present = new Set(leafPaths(config as unknown as Record<string, unknown>));
    const declared = configPaths();

    const missing = [...present].filter((p) => !declared.has(p));
    expect(missing, 'settable paths missing from configPaths').toEqual([]);

    // Everything declared but absent must be an optional field, not a typo.
    const extra = [...declared].filter((p) => !present.has(p));
    expect(extra.sort()).toEqual(
      ['ai.baseUrl', 'profile.avatarCid', 'profile.bio', 'profile.displayName'].sort(),
    );
  });

  it('reaches nested module paths, not just top-level sections', () => {
    const declared = configPaths();
    expect(declared.has('bot.rateLimit.perWalletPerMinute')).toBe(true);
    expect(declared.has('sources.rss.feeds')).toBe(true);
  });
});

describe('configFieldTypes', () => {
  // The settings UI picks a widget — checkbox, number spinner, dropdown, plain
  // text — entirely from this. `configPaths` (above) only proves the path SET
  // is right; none of those tests would notice the TYPE data being wrong, so a
  // boolean field could silently render as a text box and nothing here would
  // fail.
  it('reports the right kind for a boolean, enum, number and array field', () => {
    const types = configFieldTypes();
    expect(types.get('posting.dryRun')).toEqual({ kind: 'boolean' });
    expect(types.get('node.network')).toEqual({ kind: 'enum', enumValues: ['testnet', 'mainnet'] });
    expect(types.get('sources.rss.feeds')?.kind).toBe('array');
    const perMinute = types.get('bot.rateLimit.perWalletPerMinute');
    expect(perMinute?.kind).toBe('number');
    expect(perMinute?.min).toBe(1);
    expect(perMinute?.max).toBe(600);
  });

  it('gives a fractional field a fractional step, and an integer field none', () => {
    // z.int() carries no `step`, so the input keeps the browser default of 1.
    // Getting this backwards would give an integer-only field a 0.01 step
    // (harmless but wrong) or a genuinely fractional field a step of 1, which
    // makes the native spinner arrows unable to reach most of its range.
    const types = configFieldTypes();
    expect(types.get('bot.rateLimit.perWalletPerMinute')?.step).toBeUndefined();
    expect(types.get('bot.rateLimit.maxShareOfNodeBudget')).toMatchObject({
      kind: 'number',
      min: 0.05,
      max: 1,
      step: 0.01,
    });
  });

  it('every enum lists its values in DECLARATION order, for a stable dropdown', () => {
    expect(configFieldTypes().get('ai.provider')?.enumValues).toEqual([
      'anthropic',
      'openai',
      'gemini',
      'openai-compatible',
    ]);
  });

  it('configPaths() and configFieldTypes() enumerate the identical key set', () => {
    // configPaths() is now DERIVED from configFieldTypes() rather than an
    // independent walk — this is what makes that true rather than assumed.
    expect(new Set(configFieldTypes().keys())).toEqual(configPaths());
  });
});

describe('file-only section lists', () => {
  it('the loader and the HTTP guard protect the SAME sections', () => {
    // Two copies, deliberately — the guard gives a good error message, the
    // loader is the one that actually has to hold. Nothing asserted they agreed,
    // so a section added to one and not the other would be protected at the API
    // and wide open in the file.
    expect([...FILE_ONLY_IN_OVERRIDES].sort()).toEqual([...FILE_ONLY_SECTIONS].sort());
  });
});
