import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendAudit, readAudit, type AuditEvent, type AuditOptions } from './audit.js';

let dir: string;
let opts: AuditOptions;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ogmara-audit-'));
  opts = { path: join(dir, 'audit.log'), maxBytes: 1024, keep: 3 };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = { actor: 'klv1admin', ip: '127.0.0.1' };

describe('appendAudit', () => {
  it('records an applied change with both values', () => {
    appendAudit(opts, { ...base, path: 'posting.dryRun', outcome: 'applied', from: true, to: false });
    const [event] = readAudit(opts.path, 10);
    expect(event).toMatchObject({
      actor: 'klv1admin',
      path: 'posting.dryRun',
      outcome: 'applied',
      from: true,
      to: false,
    });
    expect(typeof event!['ts']).toBe('string');
  });

  it('records REJECTED writes too', () => {
    // A refused write to the panel block is precisely the event an operator
    // most wants to find later — "why did my change not take effect".
    appendAudit(opts, {
      ...base,
      path: 'panel.adminWallets',
      outcome: 'rejected',
      reason: 'panel settings are file-only',
    });
    expect(readAudit(opts.path, 10)[0]).toMatchObject({
      outcome: 'rejected',
      reason: 'panel settings are file-only',
    });
  });

  it('never writes a secret value — not even a length or a prefix', () => {
    // This file gets pasted into bug reports. It has to be safe to paste.
    // Asserted on the parsed KEYS, not on substrings: "actor" contains "to".
    appendAudit(opts, {
      ...base,
      kind: 'secret',
      path: 'ai.anthropic.apiKey',
      outcome: 'applied',
      action: 'set',
    });
    const event = readAudit(opts.path, 1)[0]!;
    expect(event['action']).toBe('set');
    expect(Object.keys(event)).not.toContain('from');
    expect(Object.keys(event)).not.toContain('to');
    // The discriminator is a compile-time device; it has no business on disk.
    expect(Object.keys(event)).not.toContain('kind');
  });

  it('makes passing a secret VALUE a compile error, not a review item', () => {
    // The real guarantee is structural: a `secret` event has no from/to to
    // populate. This documents it, and fails to compile if the union is ever
    // flattened back into optional fields.
    // @ts-expect-error - a secret event cannot carry a value
    const bad: AuditEvent = { ...base, kind: 'secret', path: 'a', outcome: 'applied', action: 'set', to: 'sk-live-123' };
    expect(bad).toBeDefined();
  });

  it('returns ISO-8601 UTC timestamps', () => {
    appendAudit(opts, { ...base, path: 'a', outcome: 'applied' }, new Date('2026-09-12T10:11:12Z'));
    expect(readAudit(opts.path, 1)[0]!['ts']).toBe('2026-09-12T10:11:12.000Z');
  });

  it('NEVER throws, so a logging failure cannot fail the change it describes', () => {
    // A full disk must not become a config lockout.
    //
    // Forced by putting a regular FILE where a parent directory belongs, so
    // mkdirSync fails with ENOTDIR. A merely missing directory no longer fails —
    // appendAudit creates it now, which is the point of the next test.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'x', 'utf8');
    const broken: AuditOptions = { path: join(blocker, 'audit.log'), maxBytes: 10, keep: 1 };
    expect(() => appendAudit(broken, { ...base, path: 'a', outcome: 'applied' })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('creates the data directory if it does not exist yet', () => {
    // On a fresh install nothing has written `data/` before the first post, so
    // the FIRST audit event is exactly the case that failed without this — and
    // a log that silently never gets created is worse than none, because nobody
    // finds out until they go looking for a record that was never written.
    const nested: AuditOptions = { path: join(dir, 'data', 'audit.log'), maxBytes: 1024, keep: 3 };
    appendAudit(nested, { ...base, path: 'posting.dryRun', outcome: 'applied', to: false });
    expect(readAudit(nested.path, 1)).toHaveLength(1);
  });
});

describe('rotation', () => {
  it('rotates once the file exceeds maxBytes', () => {
    // Unbounded append-only growth on a long-running bot is a disk-exhaustion
    // vector, and one an attacker holding a session could drive deliberately.
    const small: AuditOptions = { path: join(dir, 'a.log'), maxBytes: 2000, keep: 3 };
    for (let i = 0; i < 200; i += 1) {
      appendAudit(small, { ...base, path: `field.number${i}`, outcome: 'applied', to: i });
    }
    expect(existsSync(`${small.path}.1`)).toBe(true);
    // Rotation is checked BEFORE an append, so the live file can exceed the cap
    // by at most one event — that is the honest bound, and it is tight here
    // because one event is ~130 bytes against a 2000-byte cap. Asserting
    // `< maxBytes * 2` instead could not have failed in either direction.
    const live = readFileSync(small.path, 'utf8').length;
    expect(live).toBeLessThan(small.maxBytes + 300);
  });

  it('keeps only the configured number of generations', () => {
    const small: AuditOptions = { path: join(dir, 'a.log'), maxBytes: 200, keep: 2 };
    for (let i = 0; i < 80; i += 1) {
      appendAudit(small, { ...base, path: `f${i}`, outcome: 'applied', to: i });
    }
    expect(existsSync(`${small.path}.1`)).toBe(true);
    expect(existsSync(`${small.path}.2`)).toBe(true);
    // `.3` is unreachable for keep: 2 whatever the code does, so asserting it is
    // absent proves nothing. Assert the real invariant instead: exactly `keep`
    // generations exist, and nothing beyond.
    const generations = readdirSync(dir).filter((f) => /^a\.log\.\d+$/.test(f));
    expect(generations.sort()).toEqual(['a.log.1', 'a.log.2']);
  });
});

describe('lowering auditKeep', () => {
  it('reclaims generations above the new limit instead of orphaning them', () => {
    // Nothing used to look above the current `keep`, so lowering it left the
    // higher generations on disk forever: the log grew and never shrank.
    const wide: AuditOptions = { path: join(dir, 'a.log'), maxBytes: 200, keep: 5 };
    for (let i = 0; i < 200; i += 1) {
      appendAudit(wide, { ...base, path: `f${i}`, outcome: 'applied', to: i });
    }
    expect(existsSync(`${wide.path}.4`)).toBe(true);

    const narrow: AuditOptions = { ...wide, keep: 2 };
    for (let i = 0; i < 60; i += 1) {
      appendAudit(narrow, { ...base, path: `g${i}`, outcome: 'applied', to: i });
    }
    const generations = readdirSync(dir).filter((f) => /^a\.log\.\d+$/.test(f));
    expect(generations.sort()).toEqual(['a.log.1', 'a.log.2']);
  });
});

describe('readAudit', () => {
  it('returns newest first', () => {
    appendAudit(opts, { ...base, path: 'first', outcome: 'applied' });
    appendAudit(opts, { ...base, path: 'second', outcome: 'applied' });
    expect(readAudit(opts.path, 10).map((e) => e['path'])).toEqual(['second', 'first']);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 10; i += 1) {
      appendAudit(opts, { ...base, path: `f${i}`, outcome: 'applied' });
    }
    expect(readAudit(opts.path, 3)).toHaveLength(3);
  });

  it('skips an unparseable line rather than failing the whole view', () => {
    // A truncated final line from a rotation race must not blank the viewer.
    appendAudit(opts, { ...base, path: 'good', outcome: 'applied' });
    writeFileSync(opts.path, `${readFileSync(opts.path, 'utf8')}{"truncated":\n`, 'utf8');
    expect(readAudit(opts.path, 10).map((e) => e['path'])).toEqual(['good']);
  });

  it('returns nothing for a missing file', () => {
    expect(readAudit(join(dir, 'nope.log'), 10)).toEqual([]);
  });
});
