import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INVITE_EXPIRY_MARGIN_MS,
  WalletSigner,
  buildInvite,
  bytesToBase64,
  decodeChannelInvite,
} from '@ogmara/sdk';
import {
  bestInvitePerChannel,
  classifyInviteFailure,
  extractChannelInvites,
  inviteUsable,
  isPrivateChannel,
  loadAutoJoinState,
  saveAutoJoinState,
  type ChannelInviteNotice,
  type RawNotification,
} from './autojoin.js';

const PRIVATE_ID = 397276220293295;

/** A real signed ChannelInvite envelope, as an inviter's client builds it. */
async function makeInvite(channelId: number, expiresInMs = 24 * 3_600_000): Promise<Uint8Array> {
  const inviter = await WalletSigner.generate();
  inviter.network = 'testnet';
  const bot = await WalletSigner.generate();
  return buildInvite(inviter, channelId, bot.address, undefined, { expiresAt: Date.now() + expiresInMs });
}

function inviteNotification(channelId: number, over: Partial<RawNotification> = {}): RawNotification {
  return { type: 'channel_invite', channel_id: String(channelId), from: 'klv1owner', timestamp: 1000, ...over };
}

describe('extractChannelInvites — invite envelope (private join gate)', () => {
  it('leaves invite/inviteExpiresAt undefined when invite_envelope is ABSENT (older node)', () => {
    const [n] = extractChannelInvites([inviteNotification(PRIVATE_ID)]).invites;
    expect(n?.invite).toBeUndefined();
    expect(n?.inviteExpiresAt).toBeUndefined();
  });

  it('normalizes a wire invite_envelope: null (and invite_expires_at: null) to undefined, not a crash', () => {
    const [n] = extractChannelInvites([
      inviteNotification(PRIVATE_ID, { invite_envelope: null, invite_expires_at: null }),
    ]).invites;
    expect(n).toBeDefined();
    expect(n?.invite).toBeUndefined();
    expect(n?.inviteExpiresAt).toBeUndefined();
  });

  it('decodes a PRESENT envelope from standard base64 to the exact signed bytes', async () => {
    const bytes = await makeInvite(PRIVATE_ID);
    const [n] = extractChannelInvites([
      inviteNotification(PRIVATE_ID, { invite_envelope: bytesToBase64(bytes) }),
    ]).invites;
    expect(n?.invite).toEqual(bytes);
    // No hint from the node: the signed envelope's own expiry is used.
    expect(n?.inviteExpiresAt).toBe(decodeChannelInvite(bytes)?.expiresAt);
    expect(n?.inviteSignedAt).toBe(decodeChannelInvite(bytes)?.timestamp);
  });

  it('keeps the signed expiry when invite_expires_at is null alongside a present envelope', async () => {
    const bytes = await makeInvite(PRIVATE_ID);
    const [n] = extractChannelInvites([
      inviteNotification(PRIVATE_ID, { invite_envelope: bytesToBase64(bytes), invite_expires_at: null }),
    ]).invites;
    expect(n?.inviteExpiresAt).toBe(decodeChannelInvite(bytes)?.expiresAt);
  });

  it('tightens to the node hint when it is EARLIER than the signed expiry, never loosens', async () => {
    const bytes = await makeInvite(PRIVATE_ID);
    const signed = decodeChannelInvite(bytes)!.expiresAt;
    const earlier = extractChannelInvites([
      inviteNotification(PRIVATE_ID, { invite_envelope: bytesToBase64(bytes), invite_expires_at: signed - 1000 }),
    ]).invites[0];
    expect(earlier?.inviteExpiresAt).toBe(signed - 1000);
    const later = extractChannelInvites([
      inviteNotification(PRIVATE_ID, { invite_envelope: bytesToBase64(bytes), invite_expires_at: signed + 1000 }),
    ]).invites[0];
    expect(later?.inviteExpiresAt).toBe(signed);
  });

  it('drops a malformed, empty, oversized or non-string envelope without dropping the invite itself', async () => {
    const notifications: RawNotification[] = [
      inviteNotification(PRIVATE_ID, { invite_envelope: '!!!not base64!!!' }),
      inviteNotification(PRIVATE_ID, { invite_envelope: '' }),
      inviteNotification(PRIVATE_ID, { invite_envelope: 'A'.repeat(4000) }),
      inviteNotification(PRIVATE_ID, { invite_envelope: 42 as unknown as string }),
      // Valid base64, but not a ChannelInvite envelope at all.
      inviteNotification(PRIVATE_ID, { invite_envelope: bytesToBase64(new Uint8Array([1, 2, 3, 4])) }),
    ];
    const { invites } = extractChannelInvites(notifications);
    expect(invites).toHaveLength(5);
    for (const n of invites) {
      expect(n.invite).toBeUndefined();
      expect(n.inviteExpiresAt).toBeUndefined();
    }
  });

  it('drops an envelope that is an invite for a DIFFERENT channel than the notification names', async () => {
    const bytes = await makeInvite(PRIVATE_ID + 1);
    const [n] = extractChannelInvites([
      inviteNotification(PRIVATE_ID, { invite_envelope: bytesToBase64(bytes) }),
    ]).invites;
    expect(n?.invite).toBeUndefined();
  });
});

describe('inviteUsable', () => {
  const notice = (inviteExpiresAt: number | undefined, invite?: Uint8Array): ChannelInviteNotice => ({
    channelId: PRIVATE_ID,
    channelName: undefined,
    invitedBy: 'klv1owner',
    timestamp: 1,
    anchorNode: undefined,
    invite,
    inviteExpiresAt,
    inviteSignedAt: invite !== undefined ? 1 : undefined,
  });
  const bytes = new Uint8Array([1]);

  it('is false with no invite at all', () => {
    expect(inviteUsable(notice(undefined), 0)).toBe(false);
  });

  it('applies the 5-minute client margin: usable just before, expired AT expiresAt - margin', () => {
    const exp = 10_000_000;
    expect(inviteUsable(notice(exp, bytes), exp - INVITE_EXPIRY_MARGIN_MS - 1)).toBe(true);
    expect(inviteUsable(notice(exp, bytes), exp - INVITE_EXPIRY_MARGIN_MS)).toBe(false);
    expect(inviteUsable(notice(exp, bytes), exp)).toBe(false);
  });
});

describe('bestInvitePerChannel', () => {
  const NOW = 0;
  /** `signedAt`/`exp` given = carries an envelope; omitted = no envelope. */
  const n = (channelId: number, timestamp: number, signedAt?: number, exp?: number): ChannelInviteNotice => ({
    channelId,
    channelName: undefined,
    invitedBy: 'klv1owner',
    timestamp,
    anchorNode: undefined,
    invite: signedAt !== undefined ? new Uint8Array([1]) : undefined,
    inviteExpiresAt: signedAt !== undefined ? exp ?? signedAt + 1000 : undefined,
    inviteSignedAt: signedAt,
  });

  it('keeps one invite per channel — the NEWEST signed invite — in first-seen order', () => {
    const out = bestInvitePerChannel([n(5, 300, 100, 1000), n(9, 250), n(5, 200, 200, 900), n(5, 100)], NOW);
    expect(out.map((x) => [x.channelId, x.inviteSignedAt])).toEqual([
      [5, 200],
      [9, undefined],
    ]);
  });

  it('kick then re-invite: the newest invite wins even though it expires much sooner', () => {
    // Old 14-day invite (pre-kick, now dead at the node via the removal
    // cutoff) and a fresh 1-hour re-invite, in one poll.
    const day = 86_400_000;
    const old = n(5, 1000, 1_000_000, 1_000_000 + 14 * day);
    const fresh = n(5, 2000, 5_000_000, 5_000_000 + 3_600_000);
    expect(bestInvitePerChannel([old, fresh], NOW)[0]).toBe(fresh);
    expect(bestInvitePerChannel([fresh, old], NOW)[0]).toBe(fresh);
  });

  it('a USABLE older invite beats a newer one that is already expired (SDK selectPendingInvite order)', () => {
    const now = 100_000_000;
    const olderValid7d = n(5, 1000, now - 3_600_000, now + 7 * 86_400_000);
    // Newer re-invite, but only 1h TTL and signed long enough ago to be past
    // expiresAt - 5 min.
    const newerExpired = n(5, 2000, now - 3_000_000, now + 60_000);
    expect(bestInvitePerChannel([olderValid7d, newerExpired], now)[0]).toBe(olderValid7d);
    expect(bestInvitePerChannel([newerExpired, olderValid7d], now)[0]).toBe(olderValid7d);
  });

  it('an expired envelope still outranks no envelope at all (so the skip log names the expiry)', () => {
    const expired = n(5, 100, 10, 20);
    const none = n(5, 300);
    expect(bestInvitePerChannel([none, expired], 1_000_000)[0]).toBe(expired);
  });

  it('breaks a signed-timestamp tie by the later expiry', () => {
    const a = n(5, 1000, 500, 800);
    const b = n(5, 900, 500, 1200);
    expect(bestInvitePerChannel([a, b], NOW)[0]).toBe(b);
    expect(bestInvitePerChannel([b, a], NOW)[0]).toBe(b);
  });

  it('prefers an invite WITH an envelope over a newer one without', () => {
    const out = bestInvitePerChannel([n(5, 300), n(5, 100, 50, 1000)], NOW);
    expect(out[0]?.inviteExpiresAt).toBe(1000);
  });

  it('among envelope-less invites keeps the newest notification', () => {
    const out = bestInvitePerChannel([n(5, 100), n(5, 300)], NOW);
    expect(out[0]?.timestamp).toBe(300);
  });
});

describe('classifyInviteFailure', () => {
  it('429 is rate-limited; 502/503/504 are transient; other statuses are permanent', () => {
    expect(classifyInviteFailure(new Error('API error (429): slow down'))).toBe('rate-limited');
    for (const s of [502, 503, 504]) expect(classifyInviteFailure(new Error(`API error (${s}): x`))).toBe('transient');
    for (const s of [400, 403, 404, 500]) expect(classifyInviteFailure(new Error(`API error (${s}): x`))).toBe('permanent');
  });

  it('network and timeout errors are transient', () => {
    expect(classifyInviteFailure(new TypeError('fetch failed'))).toBe('transient');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyInviteFailure(abort)).toBe('transient');
    const reset = Object.assign(new Error('socket'), { code: 'ECONNRESET' });
    expect(classifyInviteFailure(reset)).toBe('transient');
    expect(classifyInviteFailure(new Error('wrapped', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }))).toBe('transient');
  });

  it('local errors (SDK invite pre-check) and non-errors are permanent', () => {
    expect(classifyInviteFailure(new Error('invite is addressed to a different account'))).toBe('permanent');
    expect(classifyInviteFailure('boom')).toBe('permanent');
  });
});

describe('isPrivateChannel', () => {
  it('trusts a known record over the id namespace', () => {
    expect(isPrivateChannel(99, true)).toBe(true);
    expect(isPrivateChannel(PRIVATE_ID, false)).toBe(false);
  });

  it('falls back to the private id floor (2^32) for a channel not known locally', () => {
    expect(isPrivateChannel(PRIVATE_ID, undefined)).toBe(true);
    expect(isPrivateChannel(2 ** 32, undefined)).toBe(false);
    expect(isPrivateChannel(99, undefined)).toBe(false);
  });
});

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

  it('carries anchor_node through as anchorNode (cross-node invite delivery)', () => {
    const notifications: RawNotification[] = [
      {
        type: 'channel_invite',
        channel_id: '12',
        from: 'klv1owner',
        timestamp: 200,
        anchor_node: 'https://host.example',
      },
    ];
    expect(extractChannelInvites(notifications).invites[0]?.anchorNode).toBe('https://host.example');
  });

  it('drops a malformed anchor_node rather than passing it on', () => {
    const notifications: RawNotification[] = [
      { type: 'channel_invite', channel_id: '1', from: 'klv1owner', timestamp: 1, anchor_node: '' },
      {
        type: 'channel_invite',
        channel_id: '2',
        from: 'klv1owner',
        timestamp: 2,
        anchor_node: 'x'.repeat(2049),
      },
    ];
    const { invites } = extractChannelInvites(notifications);
    expect(invites[0]?.anchorNode).toBeUndefined();
    expect(invites[1]?.anchorNode).toBeUndefined();
  });

  it('keeps anchor_node exactly at the length cap, drops one byte over it', () => {
    const notifications: RawNotification[] = [
      { type: 'channel_invite', channel_id: '1', from: 'klv1owner', timestamp: 1, anchor_node: 'x'.repeat(2048) },
      { type: 'channel_invite', channel_id: '2', from: 'klv1owner', timestamp: 2, anchor_node: 'x'.repeat(2049) },
    ];
    const { invites } = extractChannelInvites(notifications);
    expect(invites[0]?.anchorNode).toBe('x'.repeat(2048));
    expect(invites[1]?.anchorNode).toBeUndefined();
  });

  it('leaves anchorNode undefined when the notification has no anchor_node (older node)', () => {
    const notifications: RawNotification[] = [
      { type: 'channel_invite', channel_id: '12', from: 'klv1owner', timestamp: 200 },
    ];
    expect(extractChannelInvites(notifications).invites[0]?.anchorNode).toBeUndefined();
  });

  it('normalizes a wire channel_name: null to undefined, not a crash (live bug, 2026-09-15)', () => {
    // REGRESSION GUARD. l2-node's notification JSON splices Option<String>
    // straight into serde_json::json!, which serializes None as JSON null,
    // not an omitted key — so channel_name arrives as a REAL null, not
    // absent, for exactly the case this whole feature exists for: a
    // brand-new channel the invitee's own node has never federated (no
    // local channel record yet, so no name to look up). Downstream code
    // checks `channelName !== undefined`, which null slips past, and then
    // hands it to forLog(), which throws
    // ("Cannot read properties of null (reading 'split')") — silently
    // killing the whole invite before it ever reaches federate/join. Caught
    // live: the exact symptom was "checked for channel invites — 1
    // notification(s), 1 invite(s)" followed by nothing else at all.
    const notifications: RawNotification[] = [
      { type: 'channel_invite', channel_id: '397276220293295', from: 'klv1owner', timestamp: 1000, channel_name: null },
    ];
    const { invites } = extractChannelInvites(notifications);
    expect(invites).toHaveLength(1);
    expect(invites[0]?.channelName).toBeUndefined();
  });

  it('normalizes a wire anchor_node: null to undefined too', () => {
    const notifications: RawNotification[] = [
      { type: 'channel_invite', channel_id: '12', from: 'klv1owner', timestamp: 1000, anchor_node: null },
    ];
    expect(extractChannelInvites(notifications).invites[0]?.anchorNode).toBeUndefined();
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
