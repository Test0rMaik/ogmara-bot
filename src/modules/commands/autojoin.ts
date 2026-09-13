/**
 * Auto-join: this wallet joins a channel on its own, in two situations —
 * a channel the operator configured in `bot.channels`, and a channel whose
 * owner invited this wallet directly (protocol §3.9's `ChannelInvite`,
 * surfaced as a `channel_invite` notification — l2-node 0.128.0+).
 *
 * Deliberately narrow: joining only makes this wallet a MEMBER, which is
 * what makes it show up in a channel's member list and clients' "/" picker
 * (`get_channel_bots` filters by membership). It does NOT add the channel to
 * `bot.channels` — that list is what the bot actually ANSWERS commands in,
 * and answering spends the wallet's rate-limited posting quota. Letting an
 * arbitrary channel owner's invite silently expand that list would hand
 * every channel owner on the network a lever over this wallet's posting
 * budget the operator never agreed to. Joining costs nothing; the operator
 * still opts a channel into answering by hand.
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

interface AutoJoinState {
  version: 1;
  /** Unix milliseconds — the newest notification timestamp already handled. */
  lastHandledTs: number;
}

/**
 * Read the "already handled up to" cursor.
 *
 * Missing or corrupt both resolve to 0 (process the full available history),
 * never a hard failure — unlike the ledger, losing this cursor only means
 * re-checking already-joined channels, and `joinChannel` is idempotent
 * server-side, so re-processing costs an extra no-op request, not a repost.
 * Silently missing an invite would be the worse failure of the two.
 */
export function loadAutoJoinCursor(path: string, warn: (message: string) => void): number {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return 0;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AutoJoinState>;
    if (parsed.version === 1 && typeof parsed.lastHandledTs === 'number') {
      return parsed.lastHandledTs;
    }
    warn(`  warning: auto-join state at "${path}" has an unexpected shape — reprocessing from the start`);
    return 0;
  } catch (err) {
    warn(
      `  warning: auto-join state at "${path}" is corrupt (${err instanceof Error ? err.message : String(err)}) ` +
        '— reprocessing from the start',
    );
    return 0;
  }
}

/**
 * Persist the cursor atomically (temp file + rename), matching the ledger's
 * and queue's write pattern — a crash mid-write must leave the previous good
 * file intact, not a truncated one that fails to parse on restart.
 */
export function saveAutoJoinCursor(path: string, lastHandledTs: number): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const payload: AutoJoinState = { version: 1, lastHandledTs };
  const tmp = join(dir, `.${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
