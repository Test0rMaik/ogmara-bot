/**
 * Cron scheduling.
 *
 * Wraps `croner` so the rest of the bot never touches the scheduling library
 * directly, and so an invalid cron expression is caught at config-validation
 * time rather than at the first tick — an unattended bot that dies six hours in
 * because of a typo is much worse than one that refuses to start.
 */

import { Cron } from 'croner';

/** A running scheduled job. */
export interface ScheduledJob {
  /** Stop the job. Safe to call more than once. */
  stop(): void;
  /** Next scheduled run, or null if there is none. */
  nextRun(): Date | null;
  /**
   * Replace this job's cron pattern, live, keeping the same task and options.
   *
   * `croner`'s `Cron` has no in-place pattern-mutation API, so this stops the
   * current underlying job and starts a fresh one — but every existing holder
   * of THIS `ScheduledJob` object keeps working unchanged: `stop`/`nextRun`/
   * `reschedule` all act on whichever underlying job is current, since they
   * close over the same mutable reference this function updates. Nothing
   * that stored the returned object (a module's `ModuleJob.job`, `index.ts`'s
   * `coreJobs`) needs to know a reschedule ever happened.
   *
   * Caller's responsibility to have validated `newExpression` first — same
   * trust boundary `schedule()` itself already relies on today.
   */
  reschedule(newExpression: string): void;
}

/** Whether a cron expression is valid. */
export function isValidCron(expression: string): boolean {
  try {
    // Constructed without a handler so it never fires; this is purely a parse
    // check. `croner` throws on malformed patterns.
    const probe = new Cron(expression, { paused: true });
    probe.stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * How many times this cron expression fires in the hour starting at `from`.
 *
 * A snapshot from one point in time, not a guaranteed worst case — an
 * unevenly-spaced schedule (three fixed times a day, say) could fire more
 * times in some other hour than this one. Good enough for a startup
 * diagnostic aimed at the actual common case this exists for: a simple
 * schedule recurring every N minutes that fires more often than
 * `posting.maxPostsPerHour` allows, which is genuinely constant hour to hour
 * and exactly what this catches.
 */
export function runsPerHour(
  expression: string,
  from: Date = new Date(),
  options: ScheduleOptions = {},
): number {
  const probe = new Cron(expression, {
    paused: true,
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
  });
  try {
    const until = new Date(from.getTime() + 3_600_000);
    // 3601: croner accepts an optional 6th SECONDS field (isValidCron accepts
    // it too), so the true ceiling is 3600/hour — once a second — not the
    // 60/hour a minute-only cron would imply. Sampling this many runs even
    // for a sparse once-a-day schedule is ~20ms (measured), so there's no
    // real cost to using the true bound rather than an under-count that
    // silently caps out and reports a number lower than reality.
    return probe.nextRuns(3601, from).filter((d) => d <= until).length;
  } finally {
    probe.stop();
  }
}

/** Options for {@link schedule}. */
export interface ScheduleOptions {
  /** IANA timezone, e.g. "Europe/Berlin". Defaults to the system zone. */
  timezone?: string;
}

/**
 * Run `task` on a cron schedule.
 *
 * Overlapping runs are prevented: if a tick arrives while the previous run is
 * still going, it is skipped rather than queued. A slow feed poll must not be
 * able to stack up concurrent runs that then race on the ledger.
 *
 * A task that throws is caught and reported — one bad run should never kill
 * the schedule.
 */
export function schedule(
  expression: string,
  task: () => Promise<void>,
  options: ScheduleOptions = {},
): ScheduledJob {
  // Shared across every underlying `Cron` instance a `reschedule()` ever
  // creates — overlap protection has to survive a reschedule the same way a
  // still-in-flight run does, and there is exactly one logical job here
  // regardless of how many `Cron` instances back it over time.
  let running = false;

  const makeCron = (expr: string): Cron =>
    new Cron(
      expr,
      { ...(options.timezone !== undefined ? { timezone: options.timezone } : {}) },
      () => {
        if (running) {
          console.warn('  previous run still in progress — skipping this tick');
          return;
        }
        running = true;
        // Promise.resolve().then(task) rather than task(): a synchronous throw
        // from task() would escape before .finally attached and leave `running`
        // stuck true forever — a silent permanent stop. Latent today (the caller
        // is async) but a whole class of bug removed for free.
        void Promise.resolve()
          .then(task)
          .catch((err: unknown) => {
            console.error('  scheduled run failed:', err instanceof Error ? err.message : err);
          })
          .finally(() => {
            running = false;
          });
      },
    );

  let job = makeCron(expression);

  return {
    stop: (): void => {
      job.stop();
    },
    nextRun: (): Date | null => job.nextRun(),
    reschedule: (newExpression: string): void => {
      job.stop();
      job = makeCron(newExpression);
    },
  };
}
