/**
 * Per-invoker rate limiting for bot commands.
 *
 * This is the bot's own responsibility, not the node's. A slash command is an
 * ordinary chat message and indistinguishable from chat on the wire —
 * deliberately, so a hostile relay cannot selectively drop commands — which
 * means a node cannot identify command traffic, let alone throttle it. It is
 * also the right place: only this bot knows what a given command costs it.
 *
 * Four traps this exists to avoid, all of which look like the obvious
 * implementation:
 *
 *   1. **Replying to every throttled request turns the limiter into an
 *      amplifier.** A 100-message flood would produce 100 "slow down" replies,
 *      each spending this bot's own wallet and posting budget. One notice per
 *      wallet per cooldown, then silence.
 *   2. **A per-minute limit alone does not stop one wallet owning the day.**
 *      Ten commands a minute is polite; sustained, it is the entire daily reply
 *      budget in under three hours, from a single wallet that never broke a
 *      stated limit. Wallets are therefore capped against the *node budget*
 *      window too, not only per minute.
 *   3. **A per-wallet map keyed on attacker-supplied addresses grows without
 *      bound.** Idle entries are evicted and the map is hard-capped.
 *   4. **Telling a wallet about a GLOBAL overload converts the shared budget
 *      into notices.** Every previously-unseen wallet is "due" a notice, so a
 *      Sybil flood gets the bot to spend its whole budget saying "I am busy" to
 *      strangers. Global overload is nobody's fault in particular and nothing
 *      an invoker can act on, so it is answered with silence.
 */

import { NODE_LIMITS } from '../../config.js';

/** How the limiter answers a request. */
export type RateDecision =
  /** Go ahead. */
  | { readonly kind: 'allow' }
  /** Throttled, and this wallet has not been told recently — tell it once. */
  | { readonly kind: 'deny-notify'; readonly reason: 'wallet' }
  /** Throttled, and either already told or not worth telling. Drop silently. */
  | { readonly kind: 'deny-silent'; readonly reason: 'wallet' | 'global' };

export interface RateLimitOptions {
  readonly perWalletPerMinute: number;
  readonly globalPerMinute: number;
  readonly noticeCooldownSeconds: number;
  /**
   * Most replies one wallet may take out of a single node-budget burst window.
   *
   * A FUNCTION, not a number, because it is derived from the wallet's node tier
   * and that tier changes at runtime — an operator can register from the panel
   * mid-run, which raises the ceiling 6x. A value snapshotted at start would
   * keep the bot throttled at the old tier until someone restarted it.
   *
   * Omit to disable — but read trap 2 above before doing so.
   */
  readonly perWalletPerWindow?: () => number;
  /** Hard ceiling on tracked wallets. */
  readonly maxTrackedWallets?: number;
}

interface WalletState {
  /** Timestamps of allowed invocations inside the current MINUTE window. */
  hits: number[];
  /** Timestamps of allowed invocations inside the node BURST window. */
  windowHits: number[];
  /** When this wallet was last sent a throttle notice. */
  lastNotice: number;
  /** Last activity, for eviction. */
  seen: number;
}

const MINUTE_MS = 60_000;
const BURST_WINDOW_MS = NODE_LIMITS.burstWindowMinutes * 60_000;
const DEFAULT_MAX_WALLETS = 10_000;

/**
 * How often the full wallet map is swept.
 *
 * Pruning every wallet on every call is O(tracked wallets) of work — plus an
 * array allocation per wallet — on a path an attacker triggers at will. The
 * touched wallet is always pruned inline, so limits stay exact; the sweep only
 * reclaims memory from wallets nobody is talking about.
 */
const SWEEP_INTERVAL_MS = MINUTE_MS;

export class CommandRateLimiter {
  readonly #opts: Required<Omit<RateLimitOptions, 'perWalletPerWindow'>> & {
    perWalletPerWindow: (() => number) | undefined;
  };
  readonly #wallets = new Map<string, WalletState>();
  /** Timestamps of every allowed invocation, for the global ceiling. */
  #globalHits: number[] = [];
  #lastSweep = 0;

  constructor(opts: RateLimitOptions) {
    this.#opts = {
      ...opts,
      // AFTER the spread, not before. Spread-then-default lets an explicit
      // `undefined` overwrite the default, and `size >= undefined` is always
      // false — silently turning the cap off, which is the one failure mode a
      // cap must not have.
      maxTrackedWallets: opts.maxTrackedWallets ?? DEFAULT_MAX_WALLETS,
      perWalletPerWindow: opts.perWalletPerWindow,
    };
  }

  /** Tracked wallets — exposed so a test can assert the bound actually holds. */
  get trackedWallets(): number {
    return this.#wallets.size;
  }

  /**
   * Decide whether `wallet` may invoke a command now.
   *
   * `cost` weights expensive commands: a chart lookup is not an AI call, and
   * charging them the same either throttles cheap commands needlessly or lets
   * expensive ones through freely.
   */
  check(wallet: string, now: number, cost = 1): RateDecision {
    this.#sweep(now);
    this.#globalHits = dropExpiredPrefix(this.#globalHits, now - MINUTE_MS);

    // The global ceiling is checked FIRST. A hundred wallets each sitting
    // politely under the per-wallet limit still exhausts an AI budget, and the
    // per-wallet check would wave every one of them through.
    if (this.#globalHits.length + cost > this.#opts.globalPerMinute) {
      // Silent by design — see trap 4. The invoker did nothing wrong and can do
      // nothing about it, and telling every stranger who arrives during an
      // overload is how the overload gets spent on apologies.
      return { kind: 'deny-silent', reason: 'global' };
    }

    const state = this.#wallets.get(wallet) ?? this.#track(wallet, now);
    state.seen = now;
    this.#pruneWallet(state, now);

    const overMinute = state.hits.length + cost > this.#opts.perWalletPerMinute;
    const windowCap = this.#opts.perWalletPerWindow?.();
    const overWindow = windowCap !== undefined && state.windowHits.length + cost > windowCap;
    if (overMinute || overWindow) return this.#notice(state, now);

    // `cost` units, while NodeBudget spends one unit per message. Identical
    // while every handler costs 1; the first costlier handler makes this
    // per-wallet cap stricter than its name suggests, which is the safe
    // direction — a wallet gets fewer expensive commands, never more.
    for (let i = 0; i < cost; i += 1) {
      state.hits.push(now);
      state.windowHits.push(now);
      this.#globalHits.push(now);
    }
    return { kind: 'allow' };
  }

  #notice(state: WalletState, now: number): RateDecision {
    const cooldownMs = this.#opts.noticeCooldownSeconds * 1000;
    if (now - state.lastNotice < cooldownMs) return { kind: 'deny-silent', reason: 'wallet' };
    state.lastNotice = now;
    return { kind: 'deny-notify', reason: 'wallet' };
  }

  #track(wallet: string, now: number): WalletState {
    if (this.#wallets.size >= this.#opts.maxTrackedWallets) {
      // Evict the least recently seen. Map preserves insertion order, not
      // recency, so find the actual oldest rather than taking the first key.
      let oldestKey: string | undefined;
      let oldestSeen = Infinity;
      for (const [key, st] of this.#wallets) {
        if (st.seen < oldestSeen) {
          oldestSeen = st.seen;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) this.#wallets.delete(oldestKey);
    }
    // `lastNotice: 0` is correct HERE, and only because global overload is
    // answered with silence (trap 4). A fresh entry is therefore "due" a notice
    // only on the path where it deserves one: a wallet that has actually
    // exceeded its own limit, which should be told the first time it happens.
    // Were global denials to notify, this 0 would hand every stranger arriving
    // during an overload a notice, which is the Sybil amplification trap.
    const state: WalletState = { hits: [], windowHits: [], lastNotice: 0, seen: now };
    this.#wallets.set(wallet, state);
    return state;
  }

  /** Drop this wallet's expired hits. Always run for the wallet being touched. */
  #pruneWallet(state: WalletState, now: number): void {
    // Both arrays are appended in time order, so what expires is always a
    // prefix — find the first survivor and slice once, rather than allocating a
    // fresh array per call via `filter`.
    state.hits = dropExpiredPrefix(state.hits, now - MINUTE_MS);
    state.windowHits = dropExpiredPrefix(state.windowHits, now - BURST_WINDOW_MS);
  }

  /**
   * Reclaim memory from wallets nobody is talking about.
   *
   * Amortised: this is O(tracked wallets) and runs on a path an attacker can
   * trigger at will, so it must not run per call. Limits stay exact regardless,
   * because the wallet being checked is always pruned inline.
   */
  #sweep(now: number): void {
    if (now - this.#lastSweep < SWEEP_INTERVAL_MS) return;
    this.#lastSweep = now;
    const noticeCutoff = now - this.#opts.noticeCooldownSeconds * 1000;

    for (const [wallet, state] of this.#wallets) {
      this.#pruneWallet(state, now);
      // Keep a wallet only while it has activity in a window OR a notice still
      // inside its cooldown — otherwise it is indistinguishable from a wallet
      // never seen, and holding it is pure growth.
      if (
        state.hits.length === 0 &&
        state.windowHits.length === 0 &&
        state.lastNotice <= noticeCutoff
      ) {
        this.#wallets.delete(wallet);
      }
    }
  }
}

/**
 * Drop leading entries at or before `cutoff` from a time-ordered array.
 *
 * Returns the same array when nothing has expired, so the steady state
 * allocates nothing at all — which is the point, on a path an attacker can
 * trigger at will.
 *
 * Equivalent to `.filter(t => t > cutoff)` only while the array is sorted, and
 * it is: every push takes wall-clock time at the moment of the push. The one
 * thing that can break that is the clock itself stepping backwards (NTP), and
 * the failure is benign — an out-of-order entry is RETAINED rather than dropped,
 * so the window over-counts and the limiter becomes briefly stricter. It cannot
 * under-count, which is the direction that would matter.
 */
function dropExpiredPrefix(times: number[], cutoff: number): number[] {
  let i = 0;
  while (i < times.length && times[i]! <= cutoff) i += 1;
  return i === 0 ? times : times.slice(i);
}

/**
 * Replies allowed per window/day for a given node limit and share.
 *
 * Exported so PREFLIGHT and the running limiter cannot drift. Preflight has to
 * compute this before a {@link NodeBudget} exists, and a second hand-written
 * copy of the formula is exactly how the startup check came to validate a
 * different limit from the one actually enforced.
 *
 * The `max(1, …)` floor matters: a small tier times a small share rounds to
 * zero, and a budget of zero means the bot answers nothing at all while every
 * log line looks healthy.
 */
export function capFor(limit: number, share: number): number {
  return Math.max(1, Math.floor(limit * share));
}

/**
 * The bot's share of its own NODE-side posting quota.
 *
 * The per-wallet and global limits above bound ABUSE. This bounds something
 * different and more dangerous: a reply is an ordinary chat message, so it
 * spends the same per-wallet quota the node meters for everything this wallet
 * sends — including the news pipeline.
 *
 * Without this layer the defaults are catastrophic rather than merely wrong. A
 * registered wallet gets 20 messages per 10-minute burst window and 300 per day
 * (l2-node 0.122.0). A popular channel could exhaust the daily quota before
 * breakfast, and the bot would then post NO NEWS for the rest of the day — the
 * feature it exists for, silently killed by the feature that was added second.
 *
 * So commands get a capped SHARE of the wallet's quota and news keeps the rest.
 * The caps derive from the live tier limits rather than being configured
 * directly, because the ceiling moves 6x when a wallet registers on-chain and a
 * hand-set number would be wrong on one side of that.
 *
 * **Known limit:** this lives in memory, so a restart resets the daily count.
 * The reservation is per-process rather than per-day, and a crash loop defeats
 * it. The node's own metering is the real backstop — the bot cannot actually
 * exceed its quota, it can only lose the headroom reserved for news.
 */
export class NodeBudget {
  readonly #burstMs: number;
  #burstHits: number[] = [];
  #dailyHits: number[] = [];

  /**
   * @param burstLimit  node messages allowed per burst window, read LIVE
   * @param dailyLimit  node messages allowed per day, read LIVE
   * @param share       fraction of each the commands module may spend
   * @param burstWindowMinutes  the node's burst window
   *
   * The two limits are read through functions on every use rather than
   * snapshotted, because the wallet's tier changes at runtime: an operator can
   * register from the control panel mid-run, and a failed chain check at startup
   * makes even a registered wallet fall back to the unverified tier for that
   * check. A snapshot would leave the bot throttled at 1/6 of its real budget
   * until someone restarted it — the "one-shot sync, permanent divergence" shape
   * this codebase has hit before.
   */
  constructor(
    private readonly burstLimit: () => number,
    private readonly dailyLimit: () => number,
    private readonly share: number,
    burstWindowMinutes = NODE_LIMITS.burstWindowMinutes,
  ) {
    this.#burstMs = burstWindowMinutes * 60_000;
  }

  /**
   * Replies allowed per burst window at the CURRENT tier.
   *
   * At least one, or a small tier times a small share floors to zero and the bot
   * answers nothing at all while every log line looks healthy.
   */
  get burstCap(): number {
    return capFor(this.burstLimit(), this.share);
  }

  get dailyCap(): number {
    return capFor(this.dailyLimit(), this.share);
  }

  /** Replies still available today, for operator-facing logging. */
  remainingToday(now: number): number {
    this.#prune(now);
    return Math.max(0, this.dailyCap - this.#dailyHits.length);
  }

  /** Whether one more reply fits, WITHOUT consuming it. */
  peek(now: number): boolean {
    this.#prune(now);
    return this.#burstHits.length < this.burstCap && this.#dailyHits.length < this.dailyCap;
  }

  /** Consume one reply's worth of quota. Returns false when there is none. */
  consume(now: number): boolean {
    if (!this.peek(now)) return false;
    this.#burstHits.push(now);
    this.#dailyHits.push(now);
    return true;
  }

  #prune(now: number): void {
    this.#burstHits = dropExpiredPrefix(this.#burstHits, now - this.#burstMs);
    this.#dailyHits = dropExpiredPrefix(this.#dailyHits, now - 86_400_000);
  }
}
