import { describe, expect, it } from 'vitest';
import type { Config } from '../config.js';
import {
  FILE_ONLY_SECTIONS,
  describeFields,
  diffForAudit,
  redact,
  rejectFileOnlyPaths,
} from './settings.js';

const effective = {
  node: { url: 'https://node.example', network: 'testnet' },
  posting: { dryRun: true, maxPostsPerHour: 1 },
  panel: { enabled: true, port: 8787, adminWallets: ['klv1admin'] },
  settings: { path: 'data/settings.json' },
  bot: { enabled: false, channels: [] },
} as unknown as Config;

const input = {
  effective,
  // config.yaml said these; everything else is a schema default.
  fromFile: { node: { url: 'https://node.example' }, panel: { enabled: true } },
  // the settings UI wrote this one
  fromUi: { posting: { maxPostsPerHour: 1 } },
  ui: { 'node.url': { restart: true }, 'posting.dryRun': { restart: false, confirm: true } },
};

describe('file-only sections', () => {
  it('refuses ANY write touching panel', () => {
    // Anything that controls access to the settings UI cannot be edited from
    // the settings UI. A stolen session must not be able to add an attacker
    // wallet, remove the owner's, or touch trustedProxies — where one wrong
    // entry is a full authentication bypass.
    const refused = rejectFileOnlyPaths({ panel: { adminWallets: ['klv1attacker'] } });
    expect(refused).toHaveLength(1);
    expect(refused[0]!.path).toBe('panel.adminWallets');
    expect(refused[0]!.reason).toContain('config.yaml');
  });

  it('refuses trustedProxies specifically — the sharpest edge', () => {
    expect(rejectFileOnlyPaths({ panel: { trustedProxies: ['0.0.0.0/0'] } })).toHaveLength(1);
  });

  it('refuses a write that would relocate the audit log', () => {
    // A session that could move the audit trail could erase the record of what
    // it did.
    expect(rejectFileOnlyPaths({ settings: { auditPath: '/dev/null' } })).toHaveLength(1);
  });

  it('reports EVERY rejection, not just the first', () => {
    // An operator submitting a form should learn about all of its problems at
    // once — and every refusal is separately audited.
    const refused = rejectFileOnlyPaths({
      panel: { requireLogin: false, port: 9999 },
      settings: { path: 'x' },
    });
    expect(refused.map((r) => r.path).sort()).toEqual([
      'panel.port',
      'panel.requireLogin',
      'settings.path',
    ]);
  });

  it('REFUSES a prototype-chain path, and reports it', () => {
    // `{"__proto__":{"settings":{...}}}` produces no leaf path under
    // `settings`, so the file-only test alone saw nothing to refuse — and the
    // merged config came back with the audit log relocated, past the guard.
    // Refused rather than quietly stripped, so the attempt is audited.
    const refused = rejectFileOnlyPaths(
      JSON.parse('{"__proto__":{"settings":{"auditPath":"/tmp/evil"}}}'),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toContain('prototype chain');
  });

  it('refuses a constructor/prototype path too', () => {
    expect(
      rejectFileOnlyPaths(JSON.parse('{"constructor":{"prototype":{"x":1}}}')),
    ).toHaveLength(1);
  });

  it('allows an ordinary write through untouched', () => {
    expect(rejectFileOnlyPaths({ posting: { maxPostsPerHour: 4 } })).toEqual([]);
  });

  it('names both protected sections', () => {
    expect([...FILE_ONLY_SECTIONS].sort()).toEqual(['panel', 'settings']);
  });
});

describe('credential redaction', () => {
  it('strips embedded userinfo from node.url', () => {
    // `/api/profile` already returns only the ORIGIN of node.url for exactly
    // this reason (0.14.0 security audit). Echoing the value verbatim here put
    // the same credential back into the browser history, devtools and any proxy
    // log — admin session or not.
    const withCreds = {
      ...input,
      effective: { node: { url: 'https://user:hunter2@node.example/path' } } as unknown as Config,
    };
    const field = describeFields(withCreds).find((f) => f.path === 'node.url')!;
    expect(String(field.value)).not.toContain('hunter2');
    expect(String(field.value)).not.toContain('user');
    expect(String(field.value)).toContain('node.example');
  });

  it('leaves an ordinary url untouched', () => {
    const field = describeFields(input).find((f) => f.path === 'node.url')!;
    expect(field.value).toBe('https://node.example');
  });
});

describe('describeFields', () => {
  it('distinguishes a UI override from a file value from a default', () => {
    // This is what makes "reset to file" honest: it has to mean restoring a
    // value the operator wrote, not silently reverting to a default they have
    // never seen.
    const byPath = new Map(describeFields(input).map((f) => [f.path, f]));
    expect(byPath.get('posting.maxPostsPerHour')!.source).toBe('ui');
    expect(byPath.get('node.url')!.source).toBe('file');
    expect(byPath.get('posting.dryRun')!.source).toBe('default');
  });

  it('marks file-only fields so the UI can render them read-only', () => {
    const byPath = new Map(describeFields(input).map((f) => [f.path, f]));
    expect(byPath.get('panel.port')!.fileOnly).toBe(true);
    expect(byPath.get('posting.dryRun')!.fileOnly).toBe(false);
  });

  it('WITHHOLDS the value of a file-only field, not just its editability', () => {
    // This response is exactly the reconnaissance a stolen session wants:
    // adminWallets names whose key to go after, trustedProxies names which
    // header to forge. Asserting only `fileOnly === true` would pass even if
    // every one of those values were still in the body.
    const byPath = new Map(describeFields(input).map((f) => [f.path, f]));
    expect(byPath.get('panel.adminWallets')!.value).toBeNull();
    expect(byPath.get('panel.port')!.value).toBeNull();
    expect(JSON.stringify(describeFields(input))).not.toContain('klv1admin');
    // A non-file-only field still carries its value.
    expect(byPath.get('posting.maxPostsPerHour')!.value).toBe(1);
  });

  it('redacts credentials in ANY url field, not just node.url', () => {
    // Keying on the path name left `ai.baseUrl` — also a URL, also accepting
    // `https://user:pass@host` — leaking into the response and, once redaction
    // was wired into the audit log, into that file permanently.
    expect(redact('ai.baseUrl', 'https://user:s3cret@ai.internal/v1')).not.toContain('s3cret');
    expect(redact('anything.at.all', 'https://u:p@h.example')).not.toContain('p@');
    expect(redact('node.url', 'https://plain.example/')).toBe('https://plain.example/');
    expect(redact('posting.maxPostsPerHour', 7)).toBe(7);
  });

  it('carries restart and confirm from the module metadata', () => {
    // The operator must never have to guess whether a change took effect.
    const byPath = new Map(describeFields(input).map((f) => [f.path, f]));
    expect(byPath.get('node.url')!.restart).toBe(true);
    expect(byPath.get('posting.dryRun')!.confirm).toBe(true);
  });

  it('defaults an UNCLAIMED path to restart-required, never to applied', () => {
    // REGRESSION GUARD, and the sharpest lie this page could tell. Nothing in
    // the process re-reads the effective config after a write — the publisher
    // holds the config it was built with and the panel closes over dryRunFn at
    // boot — so a field no module claimed is inert until a restart.
    //
    // Defaulting to `false` meant the panel reported "applied" for every such
    // field. The worst case was turning dry run ON to stop a bot that was
    // posting: the API said applied, the audit log said applied, and the bot
    // kept publishing to a live network under the operator's wallet.
    const byPath = new Map(describeFields(input).map((f) => [f.path, f]));
    expect(byPath.get('posting.maxPostsPerHour')!.restart).toBe(true);
    expect(byPath.get('bot.enabled')!.restart).toBe(true);
  });

  it('treats an array as one field, not a branch', () => {
    const paths = describeFields(input).map((f) => f.path);
    expect(paths).toContain('panel.adminWallets');
    expect(paths.some((p) => p.startsWith('panel.adminWallets.'))).toBe(false);
  });
});

describe('diffForAudit', () => {
  // `before` is a plain snapshot of `effective` BEFORE whatever reload ran —
  // never the live object itself, since settingsDeps.ts mutates that one in
  // place (see the doc comment on diffForAudit).
  const before = structuredClone(effective);

  it('reports only paths that actually changed', () => {
    const after = { ...input, effective: { ...effective, posting: { ...effective.posting, maxPostsPerHour: 9 } } };
    const rows = diffForAudit(before, after);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: 'posting.maxPostsPerHour', from: 1, to: 9 });
  });

  it('reports nothing when nothing changed', () => {
    expect(diffForAudit(before, input)).toEqual([]);
  });

  it('marks a live (restart: false) path "applied"', () => {
    const after = { ...input, effective: { ...effective, posting: { ...effective.posting, dryRun: false } } };
    const row = diffForAudit(before, after).find((r) => r.path === 'posting.dryRun');
    expect(row?.outcome).toBe('applied');
  });

  it('marks a restart-required path "restart-pending", and an UNCLAIMED path the same way — never "applied" by default', () => {
    const after = {
      ...input,
      effective: {
        ...effective,
        node: { ...effective.node, url: 'https://changed.example' },
        posting: { ...effective.posting, maxPostsPerHour: 9 }, // unclaimed in this fixture's `ui`
      },
    };
    const rows = diffForAudit(before, after);
    expect(rows.find((r) => r.path === 'node.url')?.outcome).toBe('restart-pending');
    expect(rows.find((r) => r.path === 'posting.maxPostsPerHour')?.outcome).toBe('restart-pending');
  });

  it('redacts credentials in the from/to it produces, the same as describeFields', () => {
    const after = {
      ...input,
      effective: {
        ...effective,
        node: { ...effective.node, url: 'https://user:s3cret@node.example' },
      },
    };
    const row = diffForAudit(before, after).find((r) => r.path === 'node.url');
    expect(JSON.stringify(row)).not.toContain('s3cret');
  });

  it('does not mutate `before`, so a caller can keep using its snapshot for later paths', () => {
    const beforeCopy = structuredClone(before);
    diffForAudit(before, input);
    expect(before).toEqual(beforeCopy);
  });

  it('reports a field DELETED between before and after — not just changed values', () => {
    // REGRESSION GUARD. `applyConfigInPlace` genuinely deletes the key for an
    // `.optional()` field with no `.default()` when a hand-edit clears it
    // (e.g. `sources.imagedir.contentRating`) — the key is absent from
    // `after.effective`, not present as `undefined`. An earlier version of
    // this function walked only `after`'s leaf paths and silently dropped
    // exactly this case: a hand-edit that CLEARS a field produced no audit
    // row at all.
    const beforeWithRating = {
      ...effective,
      sources: { imagedir: { enabled: true, contentRating: 'mature' } },
    } as unknown as Config;
    const afterWithoutRating = {
      ...input,
      effective: {
        ...effective,
        sources: { imagedir: { enabled: true } },
      } as unknown as Config,
    };
    const rows = diffForAudit(beforeWithRating, afterWithoutRating);
    const row = rows.find((r) => r.path === 'sources.imagedir.contentRating');
    expect(row).toBeDefined();
    expect(row?.from).toBe('mature');
    expect(row?.to).toBeUndefined();
  });
});
