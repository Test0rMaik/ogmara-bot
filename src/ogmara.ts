/**
 * Thin wrapper over `@ogmara/sdk` holding everything the bot needs to publish.
 *
 * The SDK already handles envelope construction, signing, host-bound auth
 * headers and the one-time proof-of-work gate (it auto-solves a `pow_required`
 * 429 and retries). This wrapper adds only what the SDK deliberately leaves to
 * the caller: a local posting budget, plain rate-limit 429 handling, and
 * payload validation against the protocol caps before anything is signed.
 */

import {
  OgmaraClient,
  WalletSigner,
  buildNewsPost,
  type Attachment,
  type ContentRating,
} from '@ogmara/sdk';
import { MAX_CONTENT_BYTES, MAX_TITLE_BYTES, type Config, type Secrets } from './config.js';
import { MAX_TAGS, MAX_TAG_BYTES } from './hashtags.js';

const UTF8 = new TextEncoder();

// Re-exported so the pipeline enforces the protocol cap without importing the
// config module for a constant.
export { MAX_TITLE_BYTES } from './config.js';

/** A post ready to publish, already tag-normalized. */
export interface ComposedPost {
  title: string;
  content: string;
  tags: string[];
  /** Uploaded media, already on IPFS. Empty for text-only posts. */
  attachments?: Attachment[];
  /**
   * Rating for this specific post, overriding the global setting.
   *
   * Lets an image source carry a different label than a news feed — the
   * moderation spec makes misrating reportable, so per-source control matters.
   */
  contentRating?: ContentRating;
}

/**
 * Outcome of a publish attempt.
 *
 * The three non-success outcomes are deliberately distinct. They were once a
 * single `rate-limited`, which conflated cases the caller must treat
 * differently: a local throttle is the bot's own choice and must not count
 * against the queue's retry budget, whereas a node 429 and a transport failure
 * are external and should. (Audit 2026-08-26, M7/M8.)
 */
export type PublishResult =
  | { status: 'published'; msgId: string }
  | { status: 'dry-run' }
  /** The bot's own cadence budget declined — not a failure, and not the node's fault. */
  | { status: 'throttled-locally'; retryAfterMs: number }
  /** The node returned 429. */
  | { status: 'rate-limited'; retryAfterMs: number }
  /** Node unreachable, 5xx, or any other transient transport failure. */
  | { status: 'transport-error'; retryAfterMs: number; reason: string };

/** Raised when a post violates a protocol cap. Never retried — it won't get better. */
export class InvalidPostError extends Error {
  override readonly name = 'InvalidPostError';
}

/**
 * The node's news rate-limit window.
 *
 * Fixed, not sliding — the node resets the counter only once a full hour has
 * elapsed since the window opened, so a 429 means "wait for this window",
 * not "wait 1/limit of an hour". (spec 01-protocol §6.1)
 */
const NODE_RATE_WINDOW_MS = 3_600_000;

/** How long to wait after a transient transport failure before retrying. */
const TRANSPORT_RETRY_MS = 5 * 60_000;

/**
 * Whether an error looks transient — worth queuing and retrying rather than
 * surfacing as a fault.
 *
 * Deliberately conservative: a 4xx other than 429 usually means the request
 * itself is wrong and will fail identically forever, so it is left to throw
 * rather than being retried into a loop. Anything with no HTTP status at all
 * (connection refused, DNS failure, socket timeout) is transport by definition.
 */
function isTransportError(err: unknown): boolean {
  const status = httpStatusFromError(err);
  if (status === null) return true;
  return status >= 500;
}

/**
 * Token-bucket limiter for the bot's own cadence.
 *
 * This exists so the bot self-throttles *before* hitting the node, rather than
 * discovering the limit through rejections. Node-side limits are enforced per
 * ingress node and are invisible over the API, so the bot cannot query its
 * remaining budget — it has to track its own.
 */
export class RateBudget {
  #capacity: number;
  #tokens: number;
  #refillPerMs: number;
  #lastRefill: number;

  /**
   * Slack allowed when deciding whether a token is available, as a fraction
   * of one token.
   *
   * Without it the budget is unusable in practice. Scheduler ticks arrive at
   * exact interval boundaries, but a token is consumed at tick + poll + AI
   * latency. Consecutive gaps are therefore `interval + (latency_n -
   * latency_{n-1})`, which is *shorter* than the interval on any run that
   * happens to be faster than the one before it — and AI latency varies run to
   * run. A strict `tokens >= 1` test denies those runs, so under the shipped
   * default config roughly every other run was refused and the posting rate
   * halved. 1% of an interval absorbs that jitter and float error while still
   * denying genuine over-rate bursts, which miss by far more than 1%.
   * (Audit 2026-08-26, M4.)
   */
  static readonly TOLERANCE = 0.01;

  constructor(postsPerHour: number, now: number = Date.now()) {
    // Burst of one: the bot should spread posts out, not fire a backlog at once.
    this.#capacity = 1;
    this.#tokens = 1;
    this.#refillPerMs = postsPerHour / 3_600_000;
    this.#lastRefill = now;
  }

  /**
   * Change the posting rate a running budget refills at, without resetting
   * its current token balance — a rate change mid-hour should not also grant
   * or revoke whatever the bot had already earned toward its next post.
   *
   * Refills first, under the OLD rate, up to `now` — otherwise the elapsed
   * time since the last refill would be credited at the NEW rate, letting a
   * rate drop retroactively hand out tokens that were never actually earned.
   */
  setMaxPostsPerHour(postsPerHour: number, now: number = Date.now()): void {
    this.#refill(now);
    this.#refillPerMs = postsPerHour / 3_600_000;
  }

  /**
   * Consume a token if available. Returns false (without consuming) if not.
   *
   * Callers should pass the time the *run* began rather than the moment
   * publishing is reached, so the interval is measured tick-to-tick and does
   * not drift by however long polling and composition took.
   */
  tryConsume(now: number = Date.now()): boolean {
    this.#refill(now);
    if (this.#tokens < 1 - RateBudget.TOLERANCE) return false;
    this.#tokens = Math.max(0, this.#tokens - 1);
    return true;
  }

  /** Milliseconds until the next token is available; 0 if one is ready now. */
  msUntilNext(now: number = Date.now()): number {
    this.#refill(now);
    const needed = 1 - RateBudget.TOLERANCE - this.#tokens;
    if (needed <= 0) return 0;
    return Math.ceil(needed / this.#refillPerMs);
  }

  #refill(now: number): void {
    const elapsed = now - this.#lastRefill;
    if (elapsed <= 0) return;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
    this.#lastRefill = now;
  }
}

/**
 * Extract an HTTP status code from an SDK error.
 *
 * The SDK throws `Error("API error (429): ...")` for non-OK responses rather
 * than a typed error, so the status has to be recovered from the message. This
 * is string-matching against another package's format and will silently stop
 * working if that format changes — hence one place, and a fallback that treats
 * an unrecognized error as non-retryable rather than guessing.
 */
export function httpStatusFromError(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = /^API error \((\d{3})\)/.exec(err.message);
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], 10);
}

/**
 * Validate a composed post against every protocol cap (spec §3.5).
 *
 * All four caps, measured the way the node measures them. Two reasons this
 * matters beyond tidiness:
 *
 * - The node counts **bytes** (`String::len()` in Rust), not UTF-16 code
 *   units. Content was previously checked with `.length`, so Cyrillic or CJK
 *   text at ~22k-33k characters passed here and was rejected by the node.
 *   (The spec text says "chars" at §3.5 while §3.7 and the node use bytes —
 *   the ambiguity is being fixed upstream.)
 * - The tag caps were guaranteed only by `buildTags`, which the **queue path
 *   bypasses**: a queued post is deserialized straight from JSON and published.
 *   Checking here covers both paths, because this runs before signing.
 *
 * (Audit 2026-08-26, M14.)
 */
export function validatePost(post: ComposedPost): void {
  const titleBytes = UTF8.encode(post.title).length;
  if (titleBytes === 0) throw new InvalidPostError('post title is empty');
  if (titleBytes > MAX_TITLE_BYTES) {
    throw new InvalidPostError(
      `title is ${titleBytes} bytes, protocol maximum is ${MAX_TITLE_BYTES}`,
    );
  }

  const contentBytes = UTF8.encode(post.content).length;
  if (contentBytes === 0) throw new InvalidPostError('post content is empty');
  if (contentBytes > MAX_CONTENT_BYTES) {
    throw new InvalidPostError(
      `content is ${contentBytes} bytes, protocol maximum is ${MAX_CONTENT_BYTES}`,
    );
  }

  if (!Array.isArray(post.tags)) {
    throw new InvalidPostError('post tags must be an array');
  }
  if (post.tags.length > MAX_TAGS) {
    throw new InvalidPostError(
      `post has ${post.tags.length} tags, protocol maximum is ${MAX_TAGS}`,
    );
  }
  for (const tag of post.tags) {
    if (typeof tag !== 'string') throw new InvalidPostError('every tag must be a string');
    const bytes = UTF8.encode(tag).length;
    if (bytes === 0) throw new InvalidPostError('post contains an empty tag');
    if (bytes > MAX_TAG_BYTES) {
      throw new InvalidPostError(
        `tag "${tag.slice(0, 30)}" is ${bytes} bytes, protocol maximum is ${MAX_TAG_BYTES}`,
      );
    }
  }
}

/** Node identity and capabilities, read once at startup. */
export interface NodeHealth {
  version: string;
  peers: number;
  /** False when the node has no reachable IPFS backend — image posts must be skipped. */
  mediaUploads: boolean;
  /**
   * The network this node actually serves.
   *
   * Must be surfaced, not discarded: the SDK sets
   * `signer.networkProvider = () => health.network`, so every signature adopts
   * whatever the node reports. Without comparing it to the operator's config,
   * `node.network` is decoration and the bot can publish to a chain the
   * operator did not intend. (Audit 2026-08-26, M3.)
   */
  network: string;
}

/** Raised when the node serves a different network than the operator configured. */
export class NetworkMismatchError extends Error {
  override readonly name = 'NetworkMismatchError';
}

/** Publishes composed posts to an Ogmara node. */
export class OgmaraPublisher {
  // No longer readonly — see rebuildClient(). Every other read of this
  // field goes through the `client` getter or an internal `this.#client.*`
  // call resolved fresh at call time, so swapping the reference is enough;
  // nothing here caches a client instance across an `await`.
  #client: OgmaraClient;
  readonly #signer: WalletSigner;
  readonly #config: Config;
  readonly #budget: RateBudget;
  /**
   * Whether the wallet is on-chain registered.
   *
   * Set once at startup. The node applies a 6x higher daily ceiling to
   * registered wallets (l2-node 0.122.0), so this decides which limits the
   * bot models and how long it backs off after a 429.
   */
  #registered = false;

  private constructor(client: OgmaraClient, signer: WalletSigner, config: Config) {
    this.#client = client;
    this.#signer = signer;
    this.#config = config;
    this.#budget = new RateBudget(config.posting.maxPostsPerHour);
  }

  /**
   * Build a fresh `OgmaraClient` from the given config/signer — the SDK's
   * client has no in-place reconfigure API (`nodeUrl`/`timeout`/`signer`
   * are all private, only `.withSigner()` and the `onPow*` callbacks are
   * public mutators), so a `node.url`/`network`/`timeoutMs` change means
   * building a whole new client, never patching the old one. Shared by
   * `create()` (startup) and `rebuildClient()` (live-apply) so the two
   * paths can never drift — the PoW callback wiring in particular is easy
   * to forget on a second call site.
   */
  private static buildClient(config: Config, signer: WalletSigner): OgmaraClient {
    const client = new OgmaraClient({
      nodeUrl: config.node.url,
      timeout: config.node.timeoutMs,
    }).withSigner(signer);

    // `.withSigner()` repoints `signer.networkProvider` at THIS client, but
    // the SDK's own `resolveNetwork()` caches into `signer.network` and
    // never consults `networkProvider` again once that cache is set — which
    // happens on the very first signed envelope. Without this, rebuilding
    // the client on a live `node.network`/`node.url` change would silently
    // do nothing for signing: every post after the first would keep
    // embedding whichever network was resolved at first use, no matter how
    // many times the config changes afterward — exactly the cross-network
    // replay `node.network`'s `confirm: true` exists to prevent. Clearing
    // it here forces the NEXT signed envelope to re-resolve through the
    // freshly-repointed `networkProvider`. Harmless at initial construction
    // too: a brand-new signer's `network` is already unset.
    delete signer.network;

    // Surface the one-time PoW solve rather than letting the bot look hung —
    // it takes a couple of seconds and happens on the very first post.
    client.onPowStart = (): void => {
      console.log('  solving one-time proof-of-work for this wallet…');
    };
    client.onPowComplete = (ms: number): void => {
      console.log(`  proof-of-work solved in ${ms} ms`);
    };

    return client;
  }

  /** Build a publisher, deriving the bot's wallet address from its key. */
  static async create(config: Config, secrets: Secrets): Promise<OgmaraPublisher> {
    const signer = await WalletSigner.fromHex(secrets.walletKeyHex);
    const client = OgmaraPublisher.buildClient(config, signer);
    return new OgmaraPublisher(client, signer, config);
  }

  /**
   * Live-apply a `node.url`/`node.network`/`node.timeoutMs` change: build a
   * fresh SDK client from the CURRENT config (already updated in place by
   * the time this runs — see `applyConfigInPlace`) and swap it in.
   *
   * `.withSigner()` re-attaches the SAME shared `WalletSigner`, repointing
   * its `networkProvider` resolution at the new client — this is the
   * intended mechanism ("every signature adopts whatever the node
   * reports"), not a leftover reference to the old client.
   *
   * Swap-safe for in-flight calls: every method below reads `this.#client`
   * exactly once, immediately consumed by an `await` — an in-flight
   * `publish()`/`health()` keeps running against whichever client it
   * already started with; only calls issued AFTER this returns see the
   * new one.
   */
  rebuildClient(): void {
    this.#client = OgmaraPublisher.buildClient(this.#config, this.#signer);
  }

  /**
   * The underlying SDK client, for operations outside the publish path
   * (profile updates). Exposed rather than proxied so the identity module —
   * and later the web panel — can use the SDK directly without this class
   * growing a method per feature.
   */
  get client(): OgmaraClient {
    return this.#client;
  }

  /** The wallet signer, for callers that must sign outside the publish path. */
  get signer(): WalletSigner {
    return this.#signer;
  }

  /** Tell the publisher the wallet's on-chain tier. */
  setRegistered(registered: boolean): void {
    this.#registered = registered;
  }

  /** Live-apply a new `posting.maxPostsPerHour` without restarting. */
  setMaxPostsPerHour(postsPerHour: number): void {
    this.#budget.setMaxPostsPerHour(postsPerHour);
  }

  /** Whether the wallet is currently believed to be registered on-chain. */
  get registered(): boolean {
    return this.#registered;
  }

  /** The node's daily ceiling for this wallet's current tier. */
  get dailyLimit(): number {
    return this.#registered
      ? this.#config.posting.nodeDailyRegistered
      : this.#config.posting.nodeDailyUnverified;
  }

  /** The node's burst ceiling for this wallet's current tier. */
  get burstLimit(): number {
    return this.#registered
      ? this.#config.posting.nodeBurstRegistered
      : this.#config.posting.nodeBurstUnverified;
  }

  /** The bot's wallet address — the identity every post is attributed to. */
  get address(): string {
    return this.#signer.address;
  }

  /**
   * Check the node is reachable and report its capabilities.
   *
   * Throws {@link NetworkMismatchError} when the node serves a different
   * network than the config declares. This is a refusal to start, not a
   * warning: testnet and mainnet share wallet keys, so posting to the wrong
   * chain is irreversible and attributed to the operator's real identity.
   */
  async health(): Promise<NodeHealth> {
    // Snapshotted BEFORE the await, not read fresh after it: `#config` is
    // the same shared object a settings save mutates in place, and
    // `node.url`/`node.network` are now live-appliable (see
    // `rebuildClient()`). Reading them again after `await` would compare
    // the OLD node's response against a NEW expected value if a save
    // raced this call — a pre-existing hazard that live-reload makes
    // meaningfully more likely to matter in practice.
    const expectedUrl = this.#config.node.url;
    const expectedNetwork = this.#config.node.network;
    const raw = await this.#client.health();
    const network = raw.network ?? '';

    if (network.length > 0 && network !== expectedNetwork) {
      throw new NetworkMismatchError(
        `Node at ${expectedUrl} serves "${network}", but your config says ` +
          `node.network: ${expectedNetwork}.\n` +
          'Every signature adopts the NODE\'s network, so continuing would publish to ' +
          `"${network}" — irreversibly, under your wallet. Fix whichever is wrong.`,
      );
    }

    return {
      version: raw.version,
      peers: raw.peers,
      // Nodes older than 0.48.7 omit the field entirely; absence means
      // "no signal", which the spec says to treat as available.
      mediaUploads: raw.media_uploads !== false,
      network,
    };
  }

  /** Milliseconds until the bot's own budget allows another post. */
  msUntilNextSlot(): number {
    return this.#budget.msUntilNext();
  }

  /**
   * Publish a post, honouring dry-run and the local rate budget.
   *
   * Throws {@link InvalidPostError} for payloads that can never succeed, and
   * rethrows transport errors. A node-side rate limit comes back as a
   * `rate-limited` result rather than an exception, since it is expected and
   * the caller should re-queue rather than treat it as failure.
   */
  async publish(post: ComposedPost, runStartedAt: number = Date.now()): Promise<PublishResult> {
    validatePost(post);

    if (this.#config.posting.dryRun) {
      return { status: 'dry-run' };
    }

    // Measured from when the run began, not from here: polling and composition
    // take a variable few seconds, and charging that to the interval is what
    // made consecutive gaps fall short of it. See RateBudget.TOLERANCE.
    if (!this.#budget.tryConsume(runStartedAt)) {
      return { status: 'throttled-locally', retryAfterMs: this.#budget.msUntilNext(runStartedAt) };
    }

    // Snapshotted ONCE, before either await below — not read fresh a second
    // time after `buildNewsPost` — so a `rebuildClient()` landing mid-call
    // (a `node.url` save racing an in-flight publish) can't sign against
    // one client's identity and send through a different one. Matches
    // `health()`'s own single-read discipline. (Code audit, this session.)
    const client = this.#client;
    try {
      // Built explicitly rather than via `client.postNews`, whose options
      // accept only `{tags, attachments}` — it hardcodes the rating to
      // `general`. Operators who set `contentRating: mature` were therefore
      // publishing as General while believing they had labelled the post, and
      // per spec 08-compliance §2.4 misrating is a reportable offence.
      // `buildNewsPost` does take the field. (Audit 2026-08-26, M9.)
      const envelope = await buildNewsPost(this.#signer, {
        title: post.title,
        content: post.content,
        contentRating: post.contentRating ?? this.#config.posting.contentRating,
        tags: post.tags,
        ...(post.attachments !== undefined && post.attachments.length > 0
          ? { attachments: post.attachments }
          : {}),
      });
      const { msg_id } = await client.sendMessageEnvelope(envelope);
      return { status: 'published', msgId: msg_id };
    } catch (err) {
      if (httpStatusFromError(err) === 429) {
        // The node's window is FIXED, not sliding: it resets only once a full
        // hour has passed since the window opened. Retrying at 1/limit
        // intervals therefore walks straight back into the same wall and burns
        // a queue attempt each time. Back off a whole window.
        // (Audit 2026-08-26, SPEC-W5.)
        return { status: 'rate-limited', retryAfterMs: NODE_RATE_WINDOW_MS };
      }
      // Anything else transient — node restarting, 5xx, connection refused,
      // DNS blip. Previously this threw, which escaped runOnce BEFORE the
      // composed post could be queued, discarding output an AI call was
      // already paid for. That is precisely the loss the queue exists to
      // prevent. (Audit 2026-08-26, M7.)
      if (isTransportError(err)) {
        return {
          status: 'transport-error',
          retryAfterMs: TRANSPORT_RETRY_MS,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      throw err;
    }
  }
}
