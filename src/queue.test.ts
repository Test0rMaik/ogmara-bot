import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposedPost } from './ogmara.js';
import { PostQueue } from './queue.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsbot-queue-'));
  path = join(dir, 'queue.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const POST: ComposedPost = { title: 'T', content: 'C', tags: ['bot'] };

function entry(key: string) {
  return { key, sourceTitle: `Source ${key}`, kind: 'rss', post: POST };
}

describe('PostQueue', () => {
  it('starts empty when the file does not exist', () => {
    expect(PostQueue.load(path).size).toBe(0);
  });

  it('persists across reloads', () => {
    PostQueue.load(path).enqueue(entry('a'));
    expect(PostQueue.load(path).size).toBe(1);
  });

  it('stores the composed post, not the source candidate', () => {
    // The whole point of the queue: composition already cost an AI call.
    const q = PostQueue.load(path);
    q.enqueue(entry('a'));
    expect(PostQueue.load(path).next()?.post).toEqual(POST);
  });

  it('ignores a duplicate key', () => {
    const q = PostQueue.load(path);
    q.enqueue(entry('a'));
    q.enqueue(entry('a'));
    expect(q.size).toBe(1);
  });

  it('reports whether a key is queued', () => {
    const q = PostQueue.load(path);
    q.enqueue(entry('a'));
    expect(q.has('a')).toBe(true);
    expect(q.has('b')).toBe(false);
  });

  it('returns entries FIFO', () => {
    const q = PostQueue.load(path);
    q.enqueue(entry('first'));
    q.enqueue(entry('second'));
    expect(q.next()?.key).toBe('first');
  });

  it('removes an entry after successful publication', () => {
    const q = PostQueue.load(path);
    q.enqueue(entry('a'));
    q.remove('a');
    expect(q.size).toBe(0);
    expect(PostQueue.load(path).size).toBe(0);
  });

  it('drops an entry after exhausting its attempts', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const q = PostQueue.load(path, 3);
    q.enqueue(entry('a'));
    q.recordAttempt('a');
    q.recordAttempt('a');
    expect(q.size).toBe(1);
    q.recordAttempt('a');
    expect(q.size).toBe(0);
  });

  it('discards entries older than the age cap', () => {
    // Stale news is worse than no news — publishing a day-old story because
    // the bot was throttled is not a good outcome.
    const q = PostQueue.load(path, 5, 24);
    const now = Date.now();
    q.enqueue(entry('old'), now - 48 * 3_600_000);
    q.enqueue(entry('fresh'), now);
    expect(q.next(now)?.key).toBe('fresh');
    expect(q.size).toBe(1);
  });

  it('expires entries on read, not only on write', () => {
    // A queue that sat untouched across an outage must not hand back stale
    // news on the next run.
    const q = PostQueue.load(path, 5, 24);
    q.enqueue(entry('a'), Date.now());
    const muchLater = Date.now() + 48 * 3_600_000;
    expect(q.next(muchLater)).toBeUndefined();
  });

  describe('setMaxAttempts', () => {
    it('takes effect on the next recordAttempt(), without a restart', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const q = PostQueue.load(path, 5); // starts at 5 attempts
      q.enqueue(entry('a'));
      q.setMaxAttempts(2); // shrink live
      q.recordAttempt('a');
      expect(q.size).toBe(1); // 1 of 2 — not dropped yet
      q.recordAttempt('a');
      expect(q.size).toBe(0); // 2 of 2 — now dropped
    });

    it('a widened cap keeps an entry that would otherwise now be dropped', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const q = PostQueue.load(path, 1);
      q.enqueue(entry('a'));
      q.setMaxAttempts(5); // widen BEFORE the entry is ever dropped at 1
      q.recordAttempt('a');
      expect(q.size).toBe(1);
    });
  });

  describe('setMaxAgeHours', () => {
    it('takes effect on the next prune, without a restart', () => {
      const q = PostQueue.load(path, 5, 24);
      const now = Date.now();
      q.enqueue(entry('mid'), now - 12 * 3_600_000); // 12h old, inside the 24h window
      expect(q.next(now)?.key).toBe('mid');
      q.setMaxAgeHours(6); // shrink live — the 12h-old entry is now too old
      expect(q.next(now)).toBeUndefined();
    });

    it('a widened age cap keeps an entry that would otherwise now be expired', () => {
      const q = PostQueue.load(path, 5, 6);
      const now = Date.now();
      q.setMaxAgeHours(48); // widen BEFORE the entry is ever expired at 6h
      q.enqueue(entry('old'), now - 24 * 3_600_000);
      expect(q.next(now)?.key).toBe('old');
    });
  });

  it('recovers from a corrupt file instead of refusing to start', () => {
    // Unlike the ledger: losing a few pending posts is recoverable, whereas a
    // reset ledger reposts everything. An unattended bot should keep running.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(path, 'not json at all');
    const q = PostQueue.load(path);
    expect(q.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('ignores recordAttempt for an unknown key', () => {
    const q = PostQueue.load(path);
    expect(() => q.recordAttempt('nope')).not.toThrow();
  });

  it('creates the parent directory when missing', () => {
    const nested = join(dir, 'x', 'y', 'queue.json');
    PostQueue.load(nested).enqueue(entry('a'));
    expect(PostQueue.load(nested).size).toBe(1);
  });
});
