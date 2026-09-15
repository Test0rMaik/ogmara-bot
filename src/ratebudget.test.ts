import { describe, expect, it } from 'vitest';
import { RateBudget } from './ogmara.js';

const HOUR = 3_600_000;

/**
 * These tests exist because their absence let a real bug ship: the budget
 * refilled from the previous *consumption* timestamp (tick + poll + AI
 * latency) while scheduler ticks arrive from the *tick*, so a run that was
 * faster than the previous one found no token and was denied. Under the
 * shipped default config that halved the posting rate.
 * (Audit 2026-08-26, M4.)
 */
describe('RateBudget', () => {
  it('allows the first consumption immediately', () => {
    expect(new RateBudget(1, 0).tryConsume(0)).toBe(true);
  });

  it('denies a second consumption inside the same interval', () => {
    const b = new RateBudget(1, 0);
    expect(b.tryConsume(0)).toBe(true);
    expect(b.tryConsume(HOUR / 2)).toBe(false);
  });

  it('allows one consumption per interval at a steady cadence', () => {
    const b = new RateBudget(1, 0);
    for (let i = 0; i < 5; i++) {
      expect(b.tryConsume(i * HOUR)).toBe(true);
    }
  });

  it('is not disrupted by run-to-run latency jitter', () => {
    // THE REGRESSION TEST. Ticks land on the hour; each run reaches the budget
    // after a variable poll+AI delay. Every tick must still get its token —
    // previously a run faster than its predecessor was denied, halving output.
    const b = new RateBudget(1, 0);
    const latencies = [12_000, 8_000, 15_000, 6_000, 20_000, 9_000, 11_000, 7_000];
    const granted = latencies.filter((lat, i) => b.tryConsume(i * HOUR + lat)).length;
    expect(granted).toBe(latencies.length);
  });

  it('still denies genuine over-rate bursts', () => {
    // The fix must not simply make the budget permissive.
    const b = new RateBudget(1, 0);
    expect(b.tryConsume(0)).toBe(true);
    expect(b.tryConsume(60_000)).toBe(false);
    expect(b.tryConsume(120_000)).toBe(false);
  });

  it('honours a higher rate', () => {
    const b = new RateBudget(4, 0); // 4/hour = one per 15 min
    expect(b.tryConsume(0)).toBe(true);
    expect(b.tryConsume(5 * 60_000)).toBe(false);
    expect(b.tryConsume(15 * 60_000)).toBe(true);
  });

  it('does not accumulate unbounded credit while idle', () => {
    // A bot idle for a day must not then fire a burst.
    const b = new RateBudget(1, 0);
    expect(b.tryConsume(24 * HOUR)).toBe(true);
    expect(b.tryConsume(24 * HOUR + 1000)).toBe(false);
  });

  it('reports the wait until the next slot', () => {
    const b = new RateBudget(1, 0);
    b.tryConsume(0);
    expect(b.msUntilNext(0)).toBeGreaterThan(0);
    expect(b.msUntilNext(0)).toBeLessThanOrEqual(HOUR);
    expect(b.msUntilNext(HOUR)).toBe(0);
  });

  describe('setMaxPostsPerHour', () => {
    it('takes effect on the very next refill, without a restart', () => {
      const b = new RateBudget(1, 0); // 1/hour
      b.tryConsume(0); // spend the initial token
      b.setMaxPostsPerHour(4, 0); // now 4/hour = one per 15 min
      expect(b.tryConsume(5 * 60_000)).toBe(false); // still too soon under the NEW rate
      expect(b.tryConsume(15 * 60_000)).toBe(true);
    });

    it('preserves already-accrued fractional credit — a rate change does not reset the balance to zero', () => {
      const b = new RateBudget(4, 0); // 4/hour: a full token every 15 min
      b.tryConsume(0); // spend the initial token; balance now 0
      // 14 of the 15 minutes elapse under the FAST rate: ~0.933 of a token
      // earned. Then the rate drops steeply, to 1/hour.
      b.setMaxPostsPerHour(1, 14 * 60_000);
      // If the drop had wiped the balance, reaching a token under the new
      // slow (1/hour) rate would take up to another hour. Since the ~0.933
      // already earned survives the change, 4 more minutes is enough to
      // cross the threshold (0.933 + 4/60 ≈ 1.0).
      expect(b.tryConsume(14 * 60_000 + 4 * 60_000)).toBe(true);
    });

    it('credits elapsed time under the OLD rate up to the switch, not the new rate retroactively', () => {
      const b = new RateBudget(1, 0); // 1/hour, slow
      b.tryConsume(0); // spend it; balance now 0
      // 30 minutes elapse under the SLOW rate (0.5 of a token earned), THEN
      // the rate rises steeply, to 4/hour.
      b.setMaxPostsPerHour(4, 30 * 60_000);
      // If the elapsed 30 minutes had been retroactively credited at the
      // FAST rate instead of the slow one actually in effect at the time,
      // the balance at the switch would already be a full token (30/15min
      // = 2, capped at capacity 1) and this would succeed immediately.
      // Correct behavior: only 0.5 was earned under the old rate, so an
      // immediate consume right at the switch still fails.
      expect(b.tryConsume(30 * 60_000)).toBe(false);
    });

    it('still denies genuine over-rate bursts under the new rate', () => {
      const b = new RateBudget(1, 0);
      b.tryConsume(0);
      b.setMaxPostsPerHour(4, 0);
      expect(b.tryConsume(1000)).toBe(false);
    });
  });
});
