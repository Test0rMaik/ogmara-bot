import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractChannelInvites,
  loadAutoJoinCursor,
  saveAutoJoinCursor,
  type RawNotification,
} from './autojoin.js';

describe('extractChannelInvites', () => {
  it('picks out channel_invite entries and ignores everything else', () => {
    const notifications: RawNotification[] = [
      { type: 'mention', from: 'klv1a', timestamp: 100 },
      {
        type: 'channel_invite',
        channel_id: '12',
        channel_name: 'Bots & Co.',
        from: 'klv1owner',
        timestamp: 200,
      },
      { type: 'dm', from: 'klv1b', timestamp: 150 },
    ];
    const { invites, newestTs } = extractChannelInvites(notifications);
    expect(invites).toEqual([
      { channelId: 12, channelName: 'Bots & Co.', invitedBy: 'klv1owner', timestamp: 200 },
    ]);
    // The newest timestamp across ALL entries, not just invites — a page
    // with no invites still has to advance the cursor past what it saw.
    expect(newestTs).toBe(200);
  });

  it('advances newestTs even when NOTHING on the page is an invite', () => {
    // REGRESSION GUARD. If newestTs only tracked invite timestamps, a page
    // of pure mentions/DMs would report newestTs: null, and the caller would
    // never advance its cursor — re-fetching the exact same page forever.
    const notifications: RawNotification[] = [
      { type: 'mention', from: 'klv1a', timestamp: 100 },
      { type: 'dm', from: 'klv1b', timestamp: 300 },
    ];
    const { invites, newestTs } = extractChannelInvites(notifications);
    expect(invites).toEqual([]);
    expect(newestTs).toBe(300);
  });

  it('returns newestTs: null for a genuinely empty page', () => {
    expect(extractChannelInvites([])).toEqual({ invites: [], newestTs: null });
  });

  it('drops an invite with a missing or non-numeric channel_id rather than crashing', () => {
    const notifications: RawNotification[] = [
      { type: 'channel_invite', from: 'klv1owner', timestamp: 50 },
      { type: 'channel_invite', channel_id: 'not-a-number', from: 'klv1owner', timestamp: 60 },
    ];
    const { invites, newestTs } = extractChannelInvites(notifications);
    expect(invites).toEqual([]);
    // Still advances past the malformed entries — they are not retried forever.
    expect(newestTs).toBe(60);
  });

  it('rejects channel id 0 and negative ids the same way as malformed ones', () => {
    const notifications: RawNotification[] = [
      { type: 'channel_invite', channel_id: '0', from: 'klv1owner', timestamp: 10 },
      { type: 'channel_invite', channel_id: '-3', from: 'klv1owner', timestamp: 20 },
    ];
    expect(extractChannelInvites(notifications).invites).toEqual([]);
  });
});

describe('auto-join cursor persistence', () => {
  let dir: string;
  let path: string;
  const warnings: string[] = [];
  const warn = (m: string): number => warnings.push(m);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ogmara-autojoin-'));
    path = join(dir, 'autojoin.json');
    warnings.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a missing file starts from 0, silently — the normal first-run case', () => {
    expect(loadAutoJoinCursor(path, warn)).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('round-trips a saved cursor', () => {
    saveAutoJoinCursor(path, 123456789);
    expect(loadAutoJoinCursor(path, warn)).toBe(123456789);
    expect(warnings).toEqual([]);
  });

  it('a corrupt file resets to 0 WITH a warning, rather than refusing to start', () => {
    // Unlike the ledger (where a corrupt file is a hard startup error because
    // silently resetting would repost the whole backlog), losing this cursor
    // only means re-checking channels this wallet may already be a member
    // of — joinChannel is idempotent, so the safe default is to keep going.
    writeFileSync(path, 'not json at all', 'utf8');
    expect(loadAutoJoinCursor(path, warn)).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('corrupt');
  });

  it('a wrong-shaped file (e.g. a future version) resets to 0 WITH a warning', () => {
    writeFileSync(path, JSON.stringify({ version: 2, somethingElse: true }), 'utf8');
    expect(loadAutoJoinCursor(path, warn)).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unexpected shape');
  });

  it('survives a crash mid-write: the previous good file is untouched until rename', () => {
    saveAutoJoinCursor(path, 111);
    // saveAutoJoinCursor writes a temp file then renames over the target —
    // there is no way to observe a partially-written target file from the
    // outside, so the property under test is simply that a second save
    // fully replaces the first rather than corrupting it.
    saveAutoJoinCursor(path, 222);
    expect(loadAutoJoinCursor(path, warn)).toBe(222);
    expect(warnings).toEqual([]);
  });
});
