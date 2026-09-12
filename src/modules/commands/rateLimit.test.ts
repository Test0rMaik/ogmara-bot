import { describe, expect, it } from 'vitest';
import { CommandRateLimiter, NodeBudget, type RateLimitOptions } from './rateLimit.js';

function opts(over: Partial<RateLimitOptions> = {}): RateLimitOptions {
  return {
    perWalletPerMinute: 3,
    globalPerMinute: 100,
    noticeCooldownSeconds: 60,
    ...over,
  };
}

describe('CommandRateLimiter', () => {
  it('allows up to the per-wallet limit, then denies', () => {
    const rl = new CommandRateLimiter(opts());
    const t = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(rl.check('klv1a', t + i).kind).toBe('allow');
    }
    expect(rl.check('klv1a', t + 3).kind).toBe('deny-notify');
  });

  it('tells a throttled wallet ONCE, then goes silent', () => {
    // THE amplifier trap. Replying to every throttled request spends this bot's
    // own wallet and posting budget: a 100-message flood would produce 100
    // "slow down" replies, making the limiter the attack's amplifier.
    const rl = new CommandRateLimiter(opts());
    const t = 1_000_000;
    for (let i = 0; i < 3; i += 1) rl.check('klv1a', t + i);

    expect(rl.check('klv1a', t + 10).kind).toBe('deny-notify');
    const rest = Array.from({ length: 50 }, (_, i) => rl.check('klv1a', t + 11 + i).kind);
    expect(rest.every((k) => k === 'deny-silent')).toBe(true);
  });

  it('tells the wallet again once the notice cooldown has passed', () => {
    // The cooldown must be LONGER than the rate window, or this proves nothing:
    // at t+61s the 60s window has also expired, the wallet is allowed again, and
    // a `.not.toBe('deny-silent')` assertion passes on a path that never
    // touched the re-notify branch at all.
    const rl = new CommandRateLimiter(opts({ perWalletPerMinute: 3, noticeCooldownSeconds: 120 }));
    const t = 1_000_000;
    for (let i = 0; i < 3; i += 1) rl.check('klv1a', t + i);
    expect(rl.check('klv1a', t + 10).kind).toBe('deny-notify');
    expect(rl.check('klv1a', t + 20).kind).toBe('deny-silent');

    // Re-saturate the fresh window, then cross the cooldown: a real notice.
    const later = t + 130_000;
    for (let i = 0; i < 3; i += 1) rl.check('klv1a', later + i);
    expect(rl.check('klv1a', later + 10).kind).toBe('deny-notify');
  });

  it('stops one wallet from taking a whole burst window, however politely it paces', () => {
    // The exploit: 10 commands per 10-minute window is inside
    // perWalletPerMinute, inside globalPerMinute, and inside the node's own
    // limits for the attacker — yet it is 100% of the bot's burst budget every
    // window, and the whole day's replies in under three hours, from one wallet.
    const rl = new CommandRateLimiter(
      opts({ perWalletPerMinute: 100, globalPerMinute: 1000, perWalletPerWindow: () => 3 }),
    );
    const t = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(rl.check('klv1hog', t + i * 1000).kind).toBe('allow');
    }
    // Still well inside the per-minute limit, but the window share is spent.
    expect(rl.check('klv1hog', t + 5000).kind).not.toBe('allow');
    // A different wallet is unaffected.
    expect(rl.check('klv1other', t + 5000).kind).toBe('allow');
  });

  it('releases the window share once the burst window slides', () => {
    const rl = new CommandRateLimiter(
      opts({ perWalletPerMinute: 100, globalPerMinute: 1000, perWalletPerWindow: () => 2 }),
    );
    const t = 1_000_000;
    rl.check('klv1hog', t);
    rl.check('klv1hog', t + 1000);
    expect(rl.check('klv1hog', t + 2000).kind).not.toBe('allow');
    expect(rl.check('klv1hog', t + 11 * 60_000).kind).toBe('allow');
  });

  it('keeps its bound when maxTrackedWallets is explicitly undefined', () => {
    // Spread-then-default lets an explicit `undefined` overwrite the default,
    // and `size >= undefined` is always false — silently turning the cap off,
    // which is the one failure mode a cap must not have.
    // Cast required: `exactOptionalPropertyTypes` blocks this at compile time,
    // which is exactly why the bug would be latent rather than obvious — a JS
    // caller, a JSON config, or a future loosening of the type all reach it.
    const rl = new CommandRateLimiter({
      ...opts(),
      maxTrackedWallets: undefined,
    } as unknown as RateLimitOptions);
    const t = 1_000_000;
    for (let i = 0; i < 12_000; i += 1) rl.check(`klv1a${i}`, t);
    expect(rl.trackedWallets).toBeLessThanOrEqual(10_000);
  });

  it('enforces the global ceiling even when every wallet is individually polite', () => {
    // Per-wallet limits stop ONE abuser. A hundred wallets each sitting under
    // the per-wallet limit still exhausts an AI budget, and a per-wallet-only
    // check waves every one of them through.
    const rl = new CommandRateLimiter(opts({ perWalletPerMinute: 10, globalPerMinute: 5 }));
    const t = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      expect(rl.check(`klv1w${i}`, t).kind).toBe('allow');
    }
    const denied = rl.check('klv1w99', t);
    // SILENT, not a notice. Telling every stranger who arrives during an
    // overload is how a Sybil flood converts the whole reply budget into
    // apologies — and the invoker did nothing wrong and can do nothing about it.
    expect(denied.kind).toBe('deny-silent');
    expect(denied.kind === 'deny-silent' && denied.reason).toBe('global');
  });

  it('never turns a global overload into a flood of notices', () => {
    // The exploit this guards: 200 distinct wallets, the first 20 exhaust the
    // global window, and every one of the remaining 180 is a brand-new entry
    // that would be "due" a notice. The bot would spend its entire budget
    // saying "I am busy" to strangers.
    const rl = new CommandRateLimiter(opts({ perWalletPerMinute: 10, globalPerMinute: 20 }));
    const t = 1_000_000;
    let notices = 0;
    for (let i = 0; i < 200; i += 1) {
      if (rl.check(`klv1sybil${i}`, t).kind === 'deny-notify') notices += 1;
    }
    expect(notices).toBe(0);
  });

  it('charges an expensive command more than a cheap one', () => {
    const rl = new CommandRateLimiter(opts({ perWalletPerMinute: 4 }));
    const t = 1_000_000;
    expect(rl.check('klv1a', t, 3).kind).toBe('allow');
    // 3 spent, limit 4: a cost-3 command no longer fits, a cost-1 still does.
    expect(rl.check('klv1a', t, 3).kind).toBe('deny-notify');
    expect(rl.check('klv1a', t, 1).kind).toBe('allow');
  });

  it('lets the window slide', () => {
    const rl = new CommandRateLimiter(opts());
    const t = 1_000_000;
    for (let i = 0; i < 3; i += 1) rl.check('klv1a', t + i);
    expect(rl.check('klv1a', t + 61_000).kind).toBe('allow');
  });

  it('does not grow without bound on attacker-supplied wallet addresses', () => {
    // The map is keyed on a value the attacker chooses, so an unbounded map is
    // a memory-exhaustion vector that needs no valid wallet at all.
    const rl = new CommandRateLimiter(opts({ maxTrackedWallets: 50 }));
    const t = 1_000_000;
    for (let i = 0; i < 5000; i += 1) rl.check(`klv1attacker${i}`, t);
    expect(rl.trackedWallets).toBeLessThanOrEqual(50);
  });

  it('forgets a wallet once it is outside every window and has no live notice', () => {
    // Past the 10-minute BURST window, not just the 60s minute window — a
    // wallet still inside the burst window is still load-bearing for the
    // per-wallet window cap and must be kept.
    const rl = new CommandRateLimiter(opts({ noticeCooldownSeconds: 60 }));
    const t = 1_000_000;
    rl.check('klv1a', t);
    expect(rl.trackedWallets).toBe(1);
    // Inside klv1a's 10-minute burst window: it is still load-bearing for the
    // per-wallet window cap and must be kept.
    rl.check('klv1b', t + 6 * 60_000);
    expect(rl.trackedWallets).toBe(2);
    // Past klv1a's window but inside klv1b's: exactly one is reclaimed. Asserted
    // exactly — `toBeLessThan(3)` would have passed even if both were evicted.
    rl.check('klv1c', t + 12 * 60_000);
    expect(rl.trackedWallets).toBe(2);
  });
});

describe('window pruning under a backwards clock step', () => {
  it('over-counts rather than under-counts when the clock jumps back', () => {
    // Expiry is a prefix scan, which is equivalent to a filter only while the
    // array is sorted. `Date.now()` is not monotonic, so an NTP step backwards
    // can append an out-of-order entry. The failure must be in the strict
    // direction: a stale entry is kept (the window counts one too many) rather
    // than a live one being dropped (which would let a wallet exceed its limit).
    const rl = new CommandRateLimiter(opts({ perWalletPerMinute: 3 }));
    const t = 1_000_000;
    rl.check('klv1a', t);
    rl.check('klv1a', t + 1000);
    // Clock steps back 30s, then the window would have expired the early hits.
    rl.check('klv1a', t - 30_000);
    // Whatever the ordering did, the wallet must not have gained headroom.
    const after = rl.check('klv1a', t + 2000);
    expect(after.kind).not.toBe('allow');
  });
});

describe('NodeBudget', () => {
  it('caps replies at the configured share of the burst window', () => {
    // Registered tier: 20 per 10 minutes. Half of it is the commands module's.
    const b = new NodeBudget(() => 20, () => 300, 0.5);
    expect(b.burstCap).toBe(10);
    const t = 1_000_000;
    for (let i = 0; i < 10; i += 1) expect(b.consume(t + i)).toBe(true);
    expect(b.consume(t + 11)).toBe(false);
  });

  it('caps replies at the configured share of the DAILY quota', () => {
    // The one that actually bites: a popular channel could otherwise exhaust
    // the 300/day wallet quota before breakfast, and the bot would post no news
    // for the rest of the day — the feature it exists for, killed silently.
    const b = new NodeBudget(() => 10_000, () => 20, 0.5);
    expect(b.dailyCap).toBe(10);
    let t = 1_000_000;
    for (let i = 0; i < 10; i += 1) {
      // Spread across burst windows so only the daily cap can bind.
      t += 11 * 60_000;
      expect(b.consume(t)).toBe(true);
    }
    t += 11 * 60_000;
    expect(b.consume(t)).toBe(false);
  });

  it('never rounds down to a budget of zero', () => {
    // Unverified tier is 5/10min. A 5% share floors to 0, and the bot would
    // answer nothing at all while every log line looked healthy.
    const b = new NodeBudget(() => 5, () => 50, 0.05);
    expect(b.burstCap).toBe(1);
    expect(b.dailyCap).toBe(2);
    expect(b.consume(1_000_000)).toBe(true);
  });

  it('leaves headroom for the news pipeline rather than taking the lot', () => {
    const b = new NodeBudget(() => 20, () => 300, 0.5);
    expect(b.dailyCap).toBeLessThan(300);
  });

  it('peek does not consume', () => {
    // handleMessage peeks BEFORE running a handler that may spend an AI call,
    // then consumes at send time. A peek that consumed would burn the budget
    // on every message that turned out to produce no reply.
    const b = new NodeBudget(() => 2, () => 100, 1);
    const t = 1_000_000;
    expect(b.peek(t)).toBe(true);
    expect(b.peek(t)).toBe(true);
    expect(b.consume(t)).toBe(true);
    expect(b.consume(t)).toBe(true);
    expect(b.peek(t)).toBe(false);
  });

  it('recovers as the burst window slides', () => {
    const b = new NodeBudget(() => 2, () => 1000, 1);
    const t = 1_000_000;
    b.consume(t);
    b.consume(t);
    expect(b.consume(t + 60_000)).toBe(false);
    expect(b.consume(t + 601_000)).toBe(true);
  });
});
