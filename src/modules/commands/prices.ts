/**
 * bitcoin.me price feed (`api.bitcoin.me/tokens`) — the `/c` command's data
 * source (memory `reference_bitcoin_me.md`). Public, keyless, USD-only,
 * mainnet-only. No auth, no per-operator config: this is a shared public
 * endpoint, not something an operator provides credentials for.
 *
 * A worked-example data source, not a trading feed: the sparkline is ~168
 * HOURLY points, so anything finer than 1h resolution is approximated, and
 * that approximation is stated in the reply rather than presented as real
 * sub-hourly precision.
 */

import { fetchText } from '../../http.js';

const TOKENS_URL = 'https://api.bitcoin.me/tokens';

/** One entry from the feed, the fields this module actually uses. */
interface TokenEntry {
  tokenInAbbr: string;
  price: string;
  /** ~168 hourly points, assumed chronological (oldest first, latest last) — the feed documents no explicit order, so this is a best-effort assumption, not a guarantee. */
  sparkline7d: number[];
}

/** What `/c` needs about one token at query time. */
export interface TokenQuote {
  /** Canonical ticker as the feed spells it (not the caller's raw input). */
  symbol: string;
  price: number;
  sparkline: number[];
}

/**
 * Respect the feed's undocumented rate limits (memory: "use 5-min cache, be
 * respectful") — one shared cache for every invocation of this command,
 * across every channel and every wallet, not per-invoker. Process-lifetime
 * only; a restart just re-fetches on the next command.
 */
const CACHE_TTL_MS = 5 * 60_000;
let cached: { at: number; bySymbol: Map<string, TokenEntry> } | null = null;
/** Coalesces concurrent misses into one fetch, so a burst of `/c` invocations while the cache is cold or expired issues exactly one HTTP request rather than one per command. */
let inflight: Promise<Map<string, TokenEntry>> | null = null;

/**
 * Real Ogmara/Klever tickers are short alphanumeric strings (memory
 * `reference_bitcoin_me.md`'s own examples: `KLV`, `KFI`, `SAME`). Anything
 * else is rejected outright, not merely escaped — `tokenInAbbr` ends up
 * BOTH in a bot-signed reply's text (`priceCard`) and, unescaped, inside a
 * button's `command` string (`buildTimeframeButtons`) purely by string
 * interpolation. This is a third-party feed, not this operator's own input,
 * so it gets the same treatment as any other untrusted text that reaches a
 * signed message elsewhere in this codebase (`safeEcho` in handlers.ts) —
 * except here the safest fix is to keep bad entries out of the cache
 * entirely, rather than sanitize on the way out, since the same value also
 * needs to survive round-tripping through a button's literal `command`
 * (security audit, BLOCKING: an unfiltered ticker could carry `@`/`#`/URL-
 * shaped text into a reply signed by the operator's wallet, or exceed
 * l2-node's `MAX_BUTTON_COMMAND` cap and silently kill the whole reply
 * after the quota slot for it was already spent).
 */
const VALID_TICKER = /^[A-Za-z0-9]{1,16}$/;

async function fetchTokens(): Promise<Map<string, TokenEntry>> {
  const hadCache = cached;
  if (hadCache !== null && Date.now() - hadCache.at < CACHE_TTL_MS) return hadCache.bySymbol;
  if (inflight !== null) return inflight;

  inflight = (async () => {
    const text = await fetchText(TOKENS_URL, { timeoutMs: 8_000, maxBytes: 4 * 1024 * 1024 });
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('unexpected response shape (not an array)');
    const bySymbol = new Map<string, TokenEntry>();
    for (const raw of parsed) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      const abbr = entry['tokenInAbbr'];
      const price = entry['price'];
      const sparkline = entry['sparkline7d'];
      if (typeof abbr !== 'string' || !VALID_TICKER.test(abbr)) continue;
      if (typeof price !== 'string') continue;
      const points = Array.isArray(sparkline)
        ? sparkline.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        : [];
      // Case-insensitive lookup key; the feed's own casing is preserved on
      // the entry itself for display.
      bySymbol.set(abbr.toUpperCase(), { tokenInAbbr: abbr, price, sparkline7d: points });
    }
    return bySymbol;
  })();

  try {
    const bySymbol = await inflight;
    // Timestamp taken AFTER the fetch resolves, not before it started — an
    // 8-second-old response must not be treated as if it were fetched 8
    // seconds earlier than it actually completed, which would shorten the
    // effective TTL by up to `timeoutMs` on every genuine fetch.
    cached = { at: Date.now(), bySymbol };
    return bySymbol;
  } finally {
    inflight = null;
  }
}

/**
 * Look up one token by ticker (case-insensitive). Returns `null` on a
 * miss — an unknown symbol, not an error, so a handler can produce a normal
 * reply rather than a thrown exception the operator has to notice in logs.
 *
 * Throws only on genuine fetch/parse failure (network, timeout, malformed
 * response) — the caller decides how to word that to the invoker.
 */
export async function lookupToken(symbol: string): Promise<TokenQuote | null> {
  const bySymbol = await fetchTokens();
  const entry = bySymbol.get(symbol.toUpperCase());
  if (entry === undefined) return null;
  const price = Number.parseFloat(entry.price);
  if (!Number.isFinite(price)) return null;
  return { symbol: entry.tokenInAbbr, price, sparkline: entry.sparkline7d };
}

/** Test-only: force the next {@link lookupToken} call to re-fetch. */
export function _resetPriceCacheForTests(): void {
  cached = null;
  inflight = null;
}
