import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ledger } from './ledger.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsbot-ledger-'));
  path = join(dir, 'ledger.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(key: string, title: string, postedAt = Date.now()) {
  return { key, title, postedAt, kind: 'rss' };
}

describe('Ledger', () => {
  it('starts empty when the file does not exist', () => {
    const ledger = Ledger.load(path);
    expect(ledger.size).toBe(0);
    expect(ledger.has('anything')).toBe(false);
  });

  it('records and persists across reloads', () => {
    Ledger.load(path).record(entry('k1', 'First'));
    const reloaded = Ledger.load(path);
    expect(reloaded.has('k1')).toBe(true);
    expect(reloaded.size).toBe(1);
  });

  it('ignores a duplicate key', () => {
    const ledger = Ledger.load(path);
    ledger.record(entry('k1', 'First'));
    ledger.record(entry('k1', 'First again'));
    expect(ledger.size).toBe(1);
  });

  it('returns recent titles newest first', () => {
    const ledger = Ledger.load(path);
    // Timestamps must sit inside the retention window: every record() saves,
    // and save() prunes, so an out-of-window entry is discarded immediately.
    const now = Date.now();
    ledger.record(entry('a', 'Older', now - 2000));
    ledger.record(entry('b', 'Newer', now - 1000));
    expect(ledger.recentTitles()).toEqual(['Newer', 'Older']);
  });

  it('bounds the recent-title window', () => {
    const ledger = Ledger.load(path);
    const now = Date.now();
    for (let i = 0; i < 20; i++) ledger.record(entry(`k${i}`, `Title ${i}`, now - 20_000 + i));
    expect(ledger.size).toBe(20);
    expect(ledger.recentTitles(5)).toHaveLength(5);
  });

  it('prunes entries past the retention window', () => {
    const ledger = Ledger.load(path, 30);
    const old = Date.now() - 40 * 86_400_000;
    ledger.record(entry('old', 'Ancient', old));
    ledger.record(entry('new', 'Fresh'));
    expect(ledger.size).toBe(1);
    expect(ledger.has('old')).toBe(false);
    expect(ledger.has('new')).toBe(true);
  });

  describe('setRetentionDays', () => {
    it('takes effect on the next prune, without a restart', () => {
      const ledger = Ledger.load(path, 30);
      const twentyDaysAgo = Date.now() - 20 * 86_400_000;
      ledger.record(entry('mid', 'In the middle', twentyDaysAgo));
      // Still inside the 30-day window as loaded.
      expect(ledger.has('mid')).toBe(true);
      // Shrink retention to 10 days, live — the next prune (any record())
      // must now drop the 20-day-old entry it was keeping a moment ago.
      ledger.setRetentionDays(10);
      ledger.record(entry('new', 'Fresh'));
      expect(ledger.has('mid')).toBe(false);
      expect(ledger.has('new')).toBe(true);
    });

    it('a widened retention keeps entries that would otherwise now be pruned', () => {
      const ledger = Ledger.load(path, 5);
      const twentyDaysAgo = Date.now() - 20 * 86_400_000;
      ledger.setRetentionDays(30); // widen BEFORE the entry is ever pruned at 5 days
      ledger.record(entry('mid', 'In the middle', twentyDaysAgo));
      expect(ledger.has('mid')).toBe(true);
    });
  });

  it('refuses to start on a corrupt file rather than silently resetting', () => {
    // Silently starting empty would repost the entire backlog — far worse than
    // refusing to start and letting the operator look.
    writeFileSync(path, '{ this is not json');
    expect(() => Ledger.load(path)).toThrow(/corrupt/);
  });

  it('rejects a file with no entries array', () => {
    writeFileSync(path, '{"version":1}');
    expect(() => Ledger.load(path)).toThrow(/no entries array/);
  });

  it('creates the parent directory when it is missing', () => {
    const nested = join(dir, 'a', 'b', 'ledger.json');
    Ledger.load(nested).record(entry('k', 'T'));
    expect(Ledger.load(nested).has('k')).toBe(true);
  });

  it('leaves no temp files behind after a save', () => {
    Ledger.load(path).record(entry('k', 'T'));
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version: number };
    expect(parsed.version).toBe(1);
  });
});
