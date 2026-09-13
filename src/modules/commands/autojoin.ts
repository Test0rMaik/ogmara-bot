/**
 * Auto-join: this wallet joins a channel on its own, in two situations —
 * a channel the operator configured in `bot.channels`, and a channel whose
 * owner invited this wallet directly (protocol §3.9's `ChannelInvite`,
 * surfaced as a `channel_invite` notification — l2-node 0.128.0+).
 *
 * Joining only makes this wallet a MEMBER, which is what makes it show up
 * in a channel's member list and clients' "/" picker (`get_channel_bots`
 * filters by membership). Whether an invited channel ALSO gets answered —
 * `bot.autoJoin.answerInvitedChannels` — is a separate decision, because
 * answering spends the wallet's rate-limited posting quota: an unbounded
 * number of channel owners could otherwise each grant themselves a slice of
 * one wallet's budget just by inviting it, competing with (and potentially
 * starving) whatever else that wallet posts, news included. Bounded by
 * `bot.autoJoin.maxAutoAnsweredChannels` — past the cap, further invited
 * channels still get MEMBERSHIP, just not a share of the answer budget,
 * until the operator raises the cap or manages `bot.channels` by hand.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One channel-invite notification, narrowed to what this module needs. */
export interface ChannelInviteNotice {
  readonly channelId: number;
  readonly channelName: string | undefined;
  readonly invitedBy: string;
  readonly timestamp: number;
}

/** The shape `getNotifications` returns one entry as, narrowed to what this module reads. */
export interface RawNotification {
  readonly type: string;
  readonly channel_id?: string;
  readonly channel_name?: string;
  readonly from: string;
  readonly timestamp: number;
}

/**
 * Pull `channel_invite` entries out of a page of notifications, and report
 * the newest timestamp seen across ALL of them (invite or not) so the caller
 * can advance its cursor even on a page with no invites — otherwise a run
 * that only saw, say, mentions would leave the cursor stuck and re-fetch the
 * same already-seen page forever.
 */
export function extractChannelInvites(
  notifications: readonly RawNotification[],
): { invites: ChannelInviteNotice[]; newestTs: number | null } {
  let newestTs: number | null = null;
  const invites: ChannelInviteNotice[] = [];
  for (const n of notifications) {
    if (newestTs === null || n.timestamp > newestTs) newestTs = n.timestamp;
    if (n.type !== 'channel_invite') continue;
    // channel_id travels as a string on the wire (see sdk-js Notification);
    // a missing or non-numeric one is a malformed entry, not a channel to join.
    const channelId = n.channel_id !== undefined ? Number(n.channel_id) : NaN;
    if (!Number.isInteger(channelId) || channelId < 1) continue;
    invites.push({
      channelId,
      channelName: n.channel_name,
      invitedBy: n.from,
      timestamp: n.timestamp,
    });
  }
  return { invites, newestTs };
}

/** Persisted auto-join state. */
export interface AutoJoinState {
  /** Unix milliseconds — the newest notification timestamp already handled. */
  readonly lastHandledTs: number;
  /**
   * Channel ids granted answer rights via invite, subject to
   * `maxAutoAnsweredChannels`. Persisted so a restart does not forget the
   * grant and silently stop answering somewhere it already had earned a
   * slot — the cap is checked against this list's length when a NEW invite
   * arrives, not re-derived from scratch each time.
   */
  readonly answerChannelIds: readonly number[];
}

const EMPTY_STATE: AutoJoinState = { lastHandledTs: 0, answerChannelIds: [] };

interface StoredAutoJoinState {
  version: 1;
  lastHandledTs: number;
  /** Absent in a file written before this field existed — treated as empty. */
  answerChannelIds?: unknown;
}

/**
 * Read the persisted state.
 *
 * Missing or corrupt both resolve to the empty state (process the full
 * available history, no channels pre-granted), never a hard failure —
 * unlike the ledger, losing this only means re-checking already-joined
 * channels and re-granting already-earned answer slots, and both
 * `joinChannel` and re-adding an id already in the answer set are harmless.
 * Silently missing an invite would be the worse failure of the two.
 */
export function loadAutoJoinState(path: string, warn: (message: string) => void): AutoJoinState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return EMPTY_STATE;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAutoJoinState>;
    if (parsed.version !== 1 || typeof parsed.lastHandledTs !== 'number') {
      warn(`  warning: auto-join state at "${path}" has an unexpected shape — reprocessing from the start`);
      return EMPTY_STATE;
    }
    const answerChannelIds = Array.isArray(parsed.answerChannelIds)
      ? parsed.answerChannelIds.filter((id): id is number => typeof id === 'number')
      : [];
    return { lastHandledTs: parsed.lastHandledTs, answerChannelIds };
  } catch (err) {
    warn(
      `  warning: auto-join state at "${path}" is corrupt (${err instanceof Error ? err.message : String(err)}) ` +
        '— reprocessing from the start',
    );
    return EMPTY_STATE;
  }
}

/**
 * Persist state atomically (temp file + rename), matching the ledger's and
 * queue's write pattern — a crash mid-write must leave the previous good
 * file intact, not a truncated one that fails to parse on restart.
 */
export function saveAutoJoinState(path: string, state: AutoJoinState): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const payload: StoredAutoJoinState = {
    version: 1,
    lastHandledTs: state.lastHandledTs,
    answerChannelIds: [...state.answerChannelIds],
  };
  const tmp = join(dir, `.${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
