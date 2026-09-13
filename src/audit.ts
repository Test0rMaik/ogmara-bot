/**
 * Append-only record of every settings change.
 *
 * The only way to answer "when did this break, and who changed it" — cheap to
 * add while building the settings API, awkward to retrofit afterwards.
 *
 * Four rules this file exists to enforce:
 *
 *  1. **Rejected writes are recorded too.** A refused write to the `panel:`
 *     block is precisely the event an operator most wants to find later.
 *  2. **Never a secret value.** This file gets pasted into bug reports and
 *     support threads, so it has to be safe to paste — no value, no prefix, no
 *     last-4, no length. (Today nothing secret is even reachable from the
 *     settings surface, since every secret is an environment variable. The rule
 *     stands anyway: it must still hold the day that changes.)
 *  3. **Bounded.** An unbounded append-only file on a long-running bot is a
 *     disk-exhaustion vector, and one an attacker with a session could drive.
 *  4. **Never the reason a write fails.** Logging is a side effect of the
 *     change, not a precondition for it — a full disk must not stop an operator
 *     fixing their config.
 *
 * It is a record, never a source of truth. Nothing reads it back to reconstruct
 * state.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * How much of the log's end to read when serving the viewer.
 *
 * Generous next to 200 rows of a few hundred bytes each, and small enough that
 * concurrent reads cannot exhaust memory whatever `auditMaxBytes` is set to.
 */
const TAIL_BYTES = 256 * 1024;

/** What happened to an attempted change. */
export type AuditOutcome = 'applied' | 'restart-pending' | 'rejected';

/** Fields every recorded event carries. */
interface AuditBase {
  /** Wallet address, or `localhost` for a bypassed loopback session. */
  readonly actor: string;
  /** Source IP as resolved by `clientip.ts`. */
  readonly ip: string;
  /** Dotted config path, e.g. `sources.rss.schedule`. */
  readonly path: string;
  readonly outcome: AuditOutcome;
  /** Why, for a rejected write. */
  readonly reason?: string;
}

/**
 * One recorded settings change.
 *
 * A UNION, not one interface with optional fields, so rule 2 is enforced by the
 * compiler rather than by whoever writes the next call site. A `secret` event
 * has no `from`/`to` to populate — there is no way to pass a secret value to
 * this function even by mistake, which is the only kind of mistake that
 * matters for a file designed to be pasted into bug reports.
 */
export type AuditEvent =
  | (AuditBase & {
      readonly kind?: 'value';
      /** Previous value. */
      readonly from?: unknown;
      /** New value. */
      readonly to?: unknown;
    })
  | (AuditBase & {
      readonly kind: 'secret';
      /** What happened, never what it became. */
      readonly action: 'set' | 'cleared';
    });

export interface AuditOptions {
  /** Where to append. */
  readonly path: string;
  /** Rotate once the file exceeds this many bytes. */
  readonly maxBytes: number;
  /** How many rotated generations to keep. */
  readonly keep: number;
}

/**
 * Append one event.
 *
 * Never throws: a logging failure must not be able to fail the change it is
 * describing, or a full disk becomes a config lockout.
 */
export function appendAudit(opts: AuditOptions, event: AuditEvent, now = new Date()): void {
  try {
    // The directory may not exist yet on a fresh install — and an audit log
    // that silently fails to be created is worse than none, because nobody
    // finds out until they go looking for a record that was never written.
    mkdirSync(dirname(opts.path), { recursive: true });
    rotateIfNeeded(opts);
    // `kind` is a compile-time discriminator, not something worth storing.
    const { kind, ...rest } = event as AuditEvent & { kind?: string };
    void kind;
    appendFileSync(opts.path, `${JSON.stringify({ ts: now.toISOString(), ...rest })}\n`, 'utf8');
  } catch (err) {
    // Reported, not raised. Stderr rather than silence, so an operator whose
    // audit log has stopped growing can find out why.
    console.warn(
      `  warning: could not write the settings audit log (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * Rename the current file aside once it is too big, dropping the oldest
 * generation.
 *
 * Size-based rather than time-based: the growth driver is how often settings
 * are written, which has nothing to do with the calendar.
 */
function rotateIfNeeded(opts: AuditOptions): void {
  let size: number;
  try {
    size = statSync(opts.path).size;
  } catch {
    return; // no file yet
  }
  if (size < opts.maxBytes) return;

  // Drop everything at or past the retention limit, then shuffle each surviving
  // generation up one.
  //
  // The loop runs past `keep` deliberately: lowering `auditKeep` used to orphan
  // the higher generations permanently, because nothing ever looked above the
  // new limit again. Disk grew and never shrank.
  for (let i = opts.keep; i <= opts.keep + 20; i += 1) {
    try {
      unlinkSync(`${opts.path}.${i}`);
    } catch {
      /* no such generation — nothing above this exists either */
      break;
    }
  }
  for (let i = opts.keep - 1; i >= 1; i -= 1) {
    try {
      renameSync(`${opts.path}.${i}`, `${opts.path}.${i + 1}`);
    } catch {
      /* that generation does not exist */
    }
  }
  renameSync(opts.path, `${opts.path}.1`);
}

/**
 * Read back recent events, newest first, for the panel's viewer.
 *
 * Only the current file — rotated generations stay on disk for forensics but
 * are not served, so the endpoint's cost is bounded by `maxBytes` rather than
 * by total retention.
 */
export function readAudit(path: string, limit: number): Array<Record<string, unknown>> {
  // Only the TAIL. `auditMaxBytes` may be configured up to 100 MB, and reading
  // the whole file to return 200 rows meant a handful of parallel requests from
  // one session could exhaust memory on a small host.
  let raw: string;
  try {
    const { size } = statSync(path);
    const from = Math.max(0, size - TAIL_BYTES);
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
      // Use what was ACTUALLY read. Ignoring the count left the buffer's NUL
      // padding in place if the file rotated between the stat and the read —
      // at best one corrupted line, at worst a viewer showing 256 KB of NULs.
      const read = readSync(fd, buf, 0, buf.length, from);
      raw = buf.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
    // A partial first line from cutting mid-file is dropped, not guessed at.
    if (from > 0) raw = raw.slice(raw.indexOf('\n') + 1);
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      // A truncated final line from a rotation race is skipped, not fatal.
      if (typeof parsed === 'object' && parsed !== null) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      /* skip an unparseable line rather than failing the whole view */
    }
  }
  return out;
}
