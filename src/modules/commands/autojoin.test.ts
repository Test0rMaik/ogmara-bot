import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractChannelInvites,
  loadAutoJoinState,
  saveAutoJoinState,
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

describe('auto-join state persistence', () => {
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

  it('a missing file starts empty, silently — the normal first-run case', () => {
    expect(loadAutoJoinState(path, warn)).toEqual({
      lastHandledTs: 0,
      answerChannelIds: [],
      encryptedSince: {},
    });
    expect(warnings).toEqual([]);
  });

  it('round-trips a saved state, cursor and answer-channel list together', () => {
    saveAutoJoinState(path, { lastHandledTs: 123456789, answerChannelIds: [17, 42], encryptedSince: {} });
    expect(loadAutoJoinState(path, warn)).toEqual({
      lastHandledTs: 123456789,
      answerChannelIds: [17, 42],
      encryptedSince: {},
    });
    expect(warnings).toEqual([]);
  });

  it('round-trips encryptedSince alongside the rest of the state', () => {
    saveAutoJoinState(path, {
      lastHandledTs: 5,
      answerChannelIds: [17],
      encryptedSince: { 17: 1_700_000_000_000 },
    });
    expect(loadAutoJoinState(path, warn)).toEqual({
      lastHandledTs: 5,
      answerChannelIds: [17],
      encryptedSince: { 17: 1_700_000_000_000 },
    });
    expect(warnings).toEqual([]);
  });

  it('reads a file written before answerChannelIds/encryptedSince existed as empty, not a crash', () => {
    // A live bot already has a state file written by an earlier version of
    // this module — that file must keep loading correctly, not lose its
    // cursor or throw, once a newer field is read from it.
    writeFileSync(path, JSON.stringify({ version: 1, lastHandledTs: 999 }), 'utf8');
    expect(loadAutoJoinState(path, warn)).toEqual({
      lastHandledTs: 999,
      answerChannelIds: [],
      encryptedSince: {},
    });
    expect(warnings).toEqual([]);
  });

  it('a corrupt file resets to empty WITH a warning, rather than refusing to start', () => {
    // Unlike the ledger (where a corrupt file is a hard startup error because
    // silently resetting would repost the whole backlog), losing this state
    // only means re-checking channels this wallet may already be a member of
    // and re-granting answer slots it already earned — both idempotent/
    // harmless to redo — so the safe default is to keep going.
    writeFileSync(path, 'not json at all', 'utf8');
    expect(loadAutoJoinState(path, warn)).toEqual({
      lastHandledTs: 0,
      answerChannelIds: [],
      encryptedSince: {},
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('corrupt');
  });

  it('a wrong-shaped file (e.g. a future version) resets to empty WITH a warning', () => {
    writeFileSync(path, JSON.stringify({ version: 2, somethingElse: true }), 'utf8');
    expect(loadAutoJoinState(path, warn)).toEqual({
      lastHandledTs: 0,
      answerChannelIds: [],
      encryptedSince: {},
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unexpected shape');
  });

  it('drops non-number entries from a tampered/malformed answerChannelIds array', () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, lastHandledTs: 5, answerChannelIds: [1, 'two', null, 3] }),
      'utf8',
    );
    expect(loadAutoJoinState(path, warn)).toEqual({
      lastHandledTs: 5,
      answerChannelIds: [1, 3],
      encryptedSince: {},
    });
  });

  it('drops malformed entries from a tampered encryptedSince map', () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        lastHandledTs: 5,
        answerChannelIds: [7],
        encryptedSince: { '7': 1000, notanumber: 2000, '9': 'nope' },
      }),
      'utf8',
    );
    expect(loadAutoJoinState(path, warn)).toEqual({
      lastHandledTs: 5,
      answerChannelIds: [7],
      encryptedSince: { 7: 1000 },
    });
  });

  it('survives a crash mid-write: the previous good file is untouched until rename', () => {
    saveAutoJoinState(path, { lastHandledTs: 111, answerChannelIds: [1], encryptedSince: {} });
    // saveAutoJoinState writes a temp file then renames over the target —
    // there is no way to observe a partially-written target file from the
    // outside, so the property under test is simply that a second save
    // fully replaces the first rather than corrupting it.
    saveAutoJoinState(path, { lastHandledTs: 222, answerChannelIds: [1, 2], encryptedSince: {} });
    expect(loadAutoJoinState(path, warn)).toEqual({
      lastHandledTs: 222,
      answerChannelIds: [1, 2],
      encryptedSince: {},
    });
    expect(warnings).toEqual([]);
  });
});
