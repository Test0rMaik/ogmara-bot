import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidCron, runsPerHour, schedule } from './scheduler.js';

describe('isValidCron', () => {
  it('accepts a well-formed expression', () => {
    expect(isValidCron('*/30 * * * *')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isValidCron('not a cron expression')).toBe(false);
  });
});

describe('runsPerHour', () => {
  // A fixed reference point, so "the next hour" is deterministic regardless
  // of when the test suite happens to run. Explicit UTC throughout: croner
  // otherwise interprets hour-specific expressions (e.g. "0 6 * * *") in the
  // SYSTEM's local timezone, which would make these tests pass or fail
  // depending on what machine runs them — not something a test should
  // depend on.
  const UTC = { timezone: 'UTC' };
  const NOON = new Date('2026-01-01T12:00:00Z');

  it('counts a twice-hourly schedule as 2 — the exact case this exists to catch', () => {
    expect(runsPerHour('*/30 * * * *', NOON, UTC)).toBe(2);
  });

  it('counts an hourly schedule as 1', () => {
    expect(runsPerHour('0 * * * *', NOON, UTC)).toBe(1);
  });

  it('counts a schedule firing every 10 minutes as 6', () => {
    expect(runsPerHour('*/10 * * * *', NOON, UTC)).toBe(6);
  });

  it('counts a once-daily schedule as 0 for a random hour that misses it', () => {
    // Fires at 06:00; from noon, the next occurrence is >24h away.
    expect(runsPerHour('0 6 * * *', NOON, UTC)).toBe(0);
  });

  it('counts a once-daily schedule as 1 for the hour it actually fires in', () => {
    const justBefore = new Date('2026-01-01T05:59:00Z');
    expect(runsPerHour('0 6 * * *', justBefore, UTC)).toBe(1);
  });

  it('handles a schedule with multiple daily times landing in the same hour', () => {
    // Two fires inside the same 60-minute window.
    const justBefore = new Date('2026-01-01T05:59:00Z');
    expect(runsPerHour('0,30 6 * * *', justBefore, UTC)).toBe(2);
  });

  it('defaults to the system timezone when none is given, same as schedule()', () => {
    // Not asserting a specific count (that would be as machine-dependent as
    // the bug this test structure avoids elsewhere) — just that omitting the
    // option doesn't throw and returns a sane, non-negative result.
    expect(runsPerHour('0 6 * * *', NOON)).toBeGreaterThanOrEqual(0);
  });

  it('counts a seconds-precision schedule correctly, past the old 60/hour assumption', () => {
    // croner accepts an optional 6th SECONDS field, and isValidCron accepts
    // it too, so 60/hour is not actually the ceiling — an earlier version of
    // this function sampled only 100 future runs and silently under-counted
    // anything denser than that. "Every 10 seconds" is a real, valid,
    // accepted-by-isValidCron schedule that exceeds 100/hour.
    expect(runsPerHour('*/10 * * * * *', NOON, UTC)).toBe(360);
  });

  it('counts an every-second schedule as the true 3600, not a sampling artifact', () => {
    expect(runsPerHour('* * * * * *', NOON, UTC)).toBe(3600);
  });
});

describe('schedule().reschedule', () => {
  // A fixed "now" so `nextRun()` — which croner computes from the real clock
  // — is deterministic. UTC throughout for the same reason `runsPerHour`'s
  // tests use it: an hour-specific expression would otherwise depend on the
  // machine's local timezone.
  const UTC = { timezone: 'UTC' };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('changes what nextRun() reports to the NEW expression, not the original one', () => {
    const job = schedule('0 6 * * *', async () => {}, UTC); // next: 2026-01-02T06:00Z
    expect(job.nextRun()?.toISOString()).toBe('2026-01-02T06:00:00.000Z');

    job.reschedule('0 18 * * *'); // next: 2026-01-01T18:00Z — sooner, and a DIFFERENT time
    expect(job.nextRun()?.toISOString()).toBe('2026-01-01T18:00:00.000Z');
  });

  it('stop() after a reschedule stops the NEW job, not a stale reference to the old one', () => {
    const job = schedule('*/5 * * * *', async () => {}, UTC);
    job.reschedule('*/10 * * * *');
    job.stop();
    expect(job.nextRun()).toBeNull();
  });

  it('the OLD underlying job no longer fires after a reschedule', async () => {
    // Reschedule to something that would never fire in the test's window,
    // then advance past where the ORIGINAL schedule would have ticked.
    let calls = 0;
    const job = schedule('*/1 * * * *', async () => {
      calls++;
    });
    job.reschedule('0 0 1 1 *'); // once a year — will not fire in this test
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 5 minutes: the OLD pattern would have ticked 5x
    expect(calls).toBe(0);
  });

  it('a job created fresh by reschedule still fires on its new pattern', async () => {
    let calls = 0;
    const job = schedule('0 0 1 1 *', async () => {
      calls++;
    }); // once a year — would not fire in this test on its own
    job.reschedule('*/1 * * * *'); // every minute
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1000);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("the overlap guard survives a reschedule — a run in flight when reschedule() fires still blocks the NEW job's next tick", async () => {
    // The two `Cron` instances a reschedule produces share one `running`
    // flag by design (see scheduler.ts) — this is the regression test for
    // that specific choice, not just for reschedule() existing at all.
    let resolveTask: (() => void) | undefined;
    let calls = 0;
    const job = schedule('*/1 * * * *', async () => {
      calls++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    await vi.advanceTimersByTimeAsync(60_000); // first tick fires, task is now in flight
    expect(calls).toBe(1);
    expect(resolveTask).toBeDefined();

    job.reschedule('*/1 * * * *'); // same pattern, but a NEW underlying Cron instance
    await vi.advanceTimersByTimeAsync(60_000); // the new job's next tick arrives
    // Still in flight — the shared `running` guard must skip this tick.
    expect(calls).toBe(1);

    resolveTask?.();
    await vi.advanceTimersByTimeAsync(0); // let the .finally() clear `running`
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2); // now free to fire again
  });
});
