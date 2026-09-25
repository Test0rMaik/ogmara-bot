/**
 * Command handlers.
 *
 * The starting set is deliberately chosen to exercise the PARSER, not just the
 * plumbing: `/about` and `/help` take no arguments, `/latest` takes a numeric
 * one, and `/topic` takes a case-preserving string. A demo set written entirely
 * without arguments would pass while proving nothing about the part most likely
 * to be wrong — see the casing note on `/topic`.
 */

import type { ButtonRow } from '@ogmara/sdk';
import type { Config } from '../../config.js';
import type { BotConfig } from './schema.js';
import { lookupToken } from './prices.js';

/**
 * A reply carrying a button row (protocol §3.3/§3.7's worked example: `/c`'s
 * timeframe row). Plain `string` remains valid for every handler that has no
 * buttons — this is additive, not a breaking change to the interface.
 */
export interface CommandReply {
  text: string;
  buttons?: ButtonRow[];
}

export interface CommandHandler {
  /**
   * Produce a reply, or `null` to stay silent.
   *
   * `args` arrive with their ORIGINAL casing. `/c KLV` yields `["KLV"]` — the
   * SDK lowercases the command token only, never the arguments, because
   * lowercasing a ticker sends the bot looking up a different asset.
   */
  run(args: readonly string[]): Promise<string | CommandReply | null>;
  /**
   * Weight for rate limiting. A cheap lookup is not an AI call, and charging
   * them the same either throttles cheap commands needlessly or lets expensive
   * ones through freely.
   */
  cost?: number;
}

/**
 * Cap on any reply, in BYTES, well under the node's 4096-byte chat limit.
 *
 * Bytes, not characters. `String.length` is UTF-16 code units while the node's
 * `MAX_CHAT_CONTENT` is measured on a Rust `String`, i.e. bytes — so ~1360 CJK
 * characters is under any character-based cap and over the node's byte one. The
 * node then rejects the send *after* the reply budget has already been spent,
 * which costs a quota slot and produces nothing.
 */
const MAX_REPLY_BYTES = 1500;

/** Truncate to a byte budget without splitting a character or a surrogate pair. */
function clip(s: string, maxBytes = MAX_REPLY_BYTES): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  // Iterate by code POINT (`[...s]` respects surrogate pairs, unlike indexing)
  // and stop before the budget, leaving room for the ellipsis.
  let out = '';
  let used = 0;
  for (const ch of s) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > maxBytes - 3) break;
    out += ch;
    used += size;
  }
  return `${out}…`;
}

/**
 * Longest echo of user-supplied text in a reply.
 *
 * Short on purpose: an echo is a courtesy, and every byte of it is an
 * attacker-chosen byte in a message signed by the operator's wallet.
 */
const MAX_ECHO_CHARS = 48;

/**
 * Make user-supplied text safe to place in a message this bot signs.
 *
 * The bot is the highest-trust poster in a channel: Bot-badged, often verified,
 * and backed by a funded wallet. Clients auto-link URLs and render `@klv1…` as
 * a clickable mention pill and `#tag` as a search link (see the SDK's
 * `splitByUrls` and the clients' `FormattedText`), so echoing raw input lets an
 * attacker publish a link or a mention *under the operator's identity* — and
 * the abuse reports, moderation actions and channel bans land on the bot.
 *
 * Whitelist, never blacklist: letters, digits, spaces and a couple of
 * separators survive; everything else — `@`, `#`, backticks, `*`, `_`, `~`,
 * anything that could be a URL, and every control or bidi codepoint — does not.
 */
function safeEcho(input: string): string {
  const kept: string[] = [];
  for (const ch of input) {
    // Iterate by code POINT. Indexing or slicing a string with astral
    // characters in it splits surrogate pairs, which encode as U+FFFD.
    if (!ALLOWED_ECHO_CHAR.test(ch)) continue;
    // Letters and digits are not enough on their own. `\p{L}` includes the
    // Hangul filler codepoints and `\p{N}` includes U+2488-U+249B (`⒈` renders
    // as "1."), so a "letters and digits only" whitelist still admits both
    // INVISIBLE text and a period-shaped glyph — which is most of what is needed
    // to make something read as a domain. Default-ignorable characters are
    // therefore excluded explicitly, and digits are narrowed to `\p{Nd}`.
    if (DEFAULT_IGNORABLE.test(ch)) continue;
    if (kept.length === MAX_ECHO_CHARS) {
      // Only now is something actually being dropped. Returning at `>=` after
      // pushing appended an ellipsis to an echo of exactly MAX_ECHO_CHARS that
      // had lost nothing.
      return `${collapse(kept)}…`;
    }
    kept.push(ch);
  }
  return collapse(kept);
}

const collapse = (chars: string[]): string => chars.join('').replace(/ +/gu, ' ').trim();

/**
 * Letters, decimal digits, space and hyphen. Nothing else survives.
 *
 * `\p{Nd}` rather than ASCII `0-9` is a deliberate call. Narrowing to ASCII
 * would block Arabic-Indic and other non-Latin digits, and this project ships in
 * seven languages — a Persian or Hindi topic name is a legitimate thing to ask
 * about. The cost of keeping them is that U+0660 (`٠`) renders as a dot, so an
 * echo can be made to *look* like a domain. It cannot become one: clients
 * linkify a URL pattern, and nothing here can produce `:`, `/` or a real `.`,
 * so a reader would have to retype it by hand. Cosmetic resemblance is the
 * lesser harm.
 */
const ALLOWED_ECHO_CHAR = /[\p{L}\p{Nd} \-]/u;

/**
 * Codepoints that render as nothing.
 *
 * Excluded separately because "invisible" and "control" are different sets: the
 * Hangul fillers are ordinary `\p{L}` letters that happen to be invisible, so a
 * letters-only whitelist lets an attacker pad a reply with characters the reader
 * cannot see.
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

export function buildHandlers(config: Config, bot: BotConfig): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();

  handlers.set('about', {
    async run(): Promise<string> {
      return clip(
        'I am an ogmara-bot instance. I post AI-composed news to the Ogmara feed and ' +
          'answer a few commands here. Source: https://github.com/Test0rMaik/ogmara-bot',
      );
    },
  });

  handlers.set('help', {
    async run(): Promise<string> {
      // Earns its place beyond the clients' `/`-picker: it is the fallback for
      // any client that has not shipped the picker yet, and for people who type
      // it out of habit.
      if (bot.commands.length === 0) return 'I am not advertising any commands right now.';
      const lines = bot.commands.map((c) => {
        const args = c.argsHint !== undefined ? ` ${c.argsHint}` : '';
        return `/${c.name}${args} — ${c.description}`;
      });
      return clip(`Commands I answer:\n${lines.join('\n')}`);
    },
  });

  handlers.set('sources', {
    async run(): Promise<string> {
      const on: string[] = [];
      if (config.sources.rss.enabled && config.sources.rss.feeds.length > 0) {
        on.push(`${config.sources.rss.feeds.length} news feed(s)`);
      }
      if (config.sources.topics.enabled && config.sources.topics.topics.length > 0) {
        on.push(`${config.sources.topics.topics.length} topic(s)`);
      }
      if (config.sources.imagedir.enabled) on.push('an image folder');
      // Deliberately counts rather than naming feeds: an operator's feed list is
      // their business, and a bot that enumerates its configuration on request
      // is a small information-disclosure surface for no benefit.
      return on.length === 0
        ? 'I am not posting from any source right now.'
        : clip(`I post from ${on.join(', ')}.`);
    },
  });

  handlers.set('latest', {
    async run(args): Promise<string> {
      // A numeric argument, so the parser's argument handling is exercised
      // rather than assumed.
      const raw = args[0];
      const n = raw === undefined ? 1 : Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1 || n > 5) {
        return 'Usage: /latest [1-5] — how many recent posts to summarise.';
      }
      return `I would show my ${n} most recent post(s) here. (Not wired to the feed yet.)`;
    },
    // Cost 1 while this is a placeholder that does no work. Raise it when the
    // handler actually reads the feed — but note what that then requires: a
    // command costing more than the per-wallet window cap can never be invoked,
    // and on an UNREGISTERED wallet that cap floors at 1. Preflight refuses such
    // a config rather than letting it ship, so a costed command means the
    // operator must register the wallet or widen the budget shares.
    cost: 1,
  });

  handlers.set('topic', {
    async run(args): Promise<string> {
      // THE argument-casing test in live form. `/topic Klever` must keep its
      // capital K: the SDK lowercases the command token only, never the
      // arguments. A handler written against `/topic klever` would pass a test
      // suite and then quietly look up the wrong thing in production.
      const topic = args.join(' ').trim();
      if (topic.length === 0) return 'Usage: /topic <name> — do I cover this topic?';
      const covered = config.sources.topics.enabled
        ? config.sources.topics.topics.some((t) => t.toLowerCase() === topic.toLowerCase())
        : false;
      // The echo goes through `safeEcho`, never raw. `topic` is up to ~4 KB of
      // attacker-chosen text, and this reply is signed by the operator's wallet.
      const echo = safeEcho(topic);
      if (echo.length === 0) return 'That does not look like a topic name.';
      return clip(
        covered
          ? `Yes — "${echo}" is one of the topics I post about.`
          : `No — I do not currently post about "${echo}".`,
      );
    },
  });

  handlers.set('c', {
    async run(args): Promise<string | CommandReply> {
      const symbol = args[0];
      if (symbol === undefined || symbol.trim().length === 0) {
        return 'Usage: /c <symbol> [15m|30m|1h|4h|1d] — price and recent change for a KDA token.';
      }
      const tf = parseTimeframe(args[1]);

      let quote: Awaited<ReturnType<typeof lookupToken>>;
      try {
        quote = await lookupToken(symbol);
      } catch (err) {
        // A feed outage or a malformed response — not the caller's fault,
        // and not worth surfacing the raw error text (an upstream detail
        // this bot's readers cannot act on) beyond "try again".
        return clip(
          `Could not fetch a price right now (${err instanceof Error ? err.message : 'unknown error'}). Try again shortly.`,
        );
      }
      if (quote === null) {
        // The echo goes through `safeEcho`, never raw — `symbol` is
        // attacker-chosen text in a reply signed by the operator's wallet,
        // same rule as `/topic` above.
        const echo = safeEcho(symbol);
        return echo.length === 0
          ? 'That does not look like a token symbol.'
          : clip(`I do not have a price for "${echo}".`);
      }
      return {
        text: clip(priceCard(quote.symbol, quote.price, quote.sparkline, tf)),
        // The button row's own `command` strings carry the feed's CANONICAL
        // ticker (`quote.symbol`), never the caller's raw input — this is
        // what makes a press safe to trust as "a real, known symbol" without
        // re-validating it, and is a second, independent reason (beyond
        // `safeEcho` above) the raw argument never reaches a signed message.
        buttons: buildTimeframeButtons(quote.symbol),
      };
    },
    // Cost 1: the upstream fetch is shared and 5-minute-cached across every
    // invocation (`prices.ts`), so a burst of `/c` presses costs this bot at
    // most one HTTP round trip per window, not one per press.
    cost: 1,
  });

  return handlers;
}

/** The button row's own labels — also the only accepted second `/c` argument. */
const TIMEFRAMES = ['15m', '30m', '1h', '4h', '1d'] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

function parseTimeframe(raw: string | undefined): Timeframe {
  const lower = raw?.toLowerCase();
  return (TIMEFRAMES as readonly string[]).includes(lower ?? '') ? (lower as Timeframe) : '1h';
}

/**
 * Hourly-sparkline offset for a timeframe. `null` for 15m/30m: the feed's
 * `sparkline7d` is ~168 HOURLY points (memory `reference_bitcoin_me.md`), so
 * there is no real sub-hourly history to compute a genuine window change
 * from — `priceCard` says so explicitly rather than fabricating a number
 * from adjacent hourly points.
 */
const TIMEFRAME_HOURS: Record<Timeframe, number | null> = {
  '15m': null,
  '30m': null,
  '1h': 1,
  '4h': 4,
  '1d': 24,
};

/**
 * THIS is the in-place-menu-edit worked example (protocol §3.7, §2.6): the
 * button's `command` is `/c <symbol> <tf>` — a literal, self-contained
 * invocation, not an opaque token — so pressing any button re-runs this same
 * handler with a different `args[1]`, and `index.ts`'s dispatch (not this
 * file) is what turns that into an EDIT of the original card instead of a
 * new post, using `decoded.viaButton`/`decoded.replyTo`.
 */
function buildTimeframeButtons(symbol: string): ButtonRow[] {
  return [{ buttons: TIMEFRAMES.map((tf) => ({ label: tf, command: `/c ${symbol} ${tf}` })) }];
}

/**
 * Format a price at a sensible number of significant digits — a fixed
 * decimal count either truncates a sub-cent KDA price to "0.00" or pads a
 * five-figure one with meaningless trailing zeros. `Number(...)` after
 * `toPrecision` trims the trailing zeros/decimal point `toPrecision` itself
 * would otherwise leave on a round number.
 */
function formatPrice(price: number): string {
  return Number(price.toPrecision(price >= 1 ? 6 : 4)).toString();
}

function priceCard(symbol: string, price: number, sparkline: number[], tf: Timeframe): string {
  const priceStr = formatPrice(price);
  const hours = TIMEFRAME_HOURS[tf];
  if (hours === null) {
    return `${symbol} — $${priceStr} (${tf}: this feed only has ~1h resolution — showing latest price, no sub-hourly change)`;
  }
  const past = sparkline[sparkline.length - 1 - hours];
  if (past === undefined || past <= 0) {
    return `${symbol} — $${priceStr} (${tf}: not enough price history yet)`;
  }
  const changePct = ((price - past) / past) * 100;
  const sign = changePct >= 0 ? '+' : '';
  return `${symbol} — $${priceStr} (${tf}: ${sign}${changePct.toFixed(2)}%)`;
}
