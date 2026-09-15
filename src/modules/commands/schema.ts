/**
 * Config schema for the `commands` module — the `bot:` section.
 *
 * Owned here rather than in `config.ts`, per the module contract: the module is
 * the source of truth for its own section, which is what later lets the operator
 * settings page render itself from the schema instead of being hand-written.
 *
 * Everything validated here is SHAPE and CAPS only. Nothing in this file may
 * depend on the node, the network or the filesystem — those checks belong in the
 * module's `preflight`, which runs after config load. Putting a
 * network-dependent check in a Zod `.refine()` is what produced the 0.12.0
 * cadence bug.
 */

import { z } from 'zod';
import { isValidCron } from '../../scheduler.js';

/**
 * Node-enforced caps (protocol §3.11), mirrored so a bad descriptor fails at
 * config load with a useful message instead of being rejected by the node at
 * startup.
 *
 * `@ogmara/sdk` exports the same numbers as `BOT_LIMITS` and validates again
 * before signing. Duplicated deliberately: this layer turns a typo in a YAML
 * file into a line number, which an SDK exception cannot.
 */
export const COMMAND_LIMITS = {
  MAX_COMMANDS: 32,
  MAX_NAME_BYTES: 32,
  MAX_DESCRIPTION_BYTES: 128,
  MAX_ARGS_HINT_BYTES: 64,
  MIN_HANDLE: 3,
  MAX_HANDLE: 32,
} as const;

/** UTF-8 byte length — what the node actually measures. */
const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Codepoints the node rejects in descriptor text, mirroring the SDK's
 * `FORBIDDEN_DESCRIPTOR_CHARS` exactly.
 *
 * Checked here as well as there because the SDK throws at *signing* time — at
 * startup, against a live node — while this turns the same mistake into a YAML
 * line number, which is the whole reason this file exists.
 *
 * Note what is deliberately NOT here: U+200C and U+200D (ZWNJ/ZWJ). They are
 * required for emoji sequences and for correct Persian and Indic orthography,
 * so banning them would make legitimate descriptions unwritable in those
 * scripts. The bidi *overrides* are what enable spoofing, and those are banned.
 */
const FORBIDDEN_DESCRIPTOR_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/u;

const noForbiddenChars = {
  message: 'must not contain control or bidirectional-override codepoints',
} as const;

const commandSchema = z.object({
  /**
   * Lowercase, no leading `/`. The node refuses anything else, and consumers
   * match case-insensitively — so declaring `/Dom` would create a command that
   * can never be distinguished from `/dom`.
   */
  name: z
    .string()
    .regex(/^[a-z0-9_]+$/, 'must be lowercase letters, digits or underscore, with no leading "/"')
    .refine((v) => utf8(v) <= COMMAND_LIMITS.MAX_NAME_BYTES, {
      message: `must be at most ${COMMAND_LIMITS.MAX_NAME_BYTES} bytes`,
    }),
  /**
   * Shown in every client's `/`-picker. Full Unicode — CJK, Cyrillic, emoji and
   * Persian/Indic text all render.
   *
   * Measured in BYTES, not characters: a CJK character costs three, so 128
   * characters of Chinese is 384 bytes and the node will refuse it.
   */
  description: z
    .string()
    .min(1)
    .refine((v) => utf8(v) <= COMMAND_LIMITS.MAX_DESCRIPTION_BYTES, {
      message: `must be at most ${COMMAND_LIMITS.MAX_DESCRIPTION_BYTES} bytes (non-ASCII costs more than one byte per character)`,
    })
    .refine((v) => !FORBIDDEN_DESCRIPTOR_CHARS.test(v), noForbiddenChars),
  /** e.g. `"<symbol> [days]"`. */
  argsHint: z
    .string()
    .refine((v) => utf8(v) <= COMMAND_LIMITS.MAX_ARGS_HINT_BYTES, {
      message: `must be at most ${COMMAND_LIMITS.MAX_ARGS_HINT_BYTES} bytes`,
    })
    .refine((v) => !FORBIDDEN_DESCRIPTOR_CHARS.test(v), noForbiddenChars)
    .optional(),
});

/**
 * Per-invoker rate limiting, which is the BOT's job rather than the node's.
 *
 * A slash command is an ordinary chat message and indistinguishable from chat on
 * the wire — deliberately, so a hostile relay cannot filter commands — which
 * means a node cannot identify or throttle command traffic even if it wanted to.
 * It is also the right place for it: only this bot knows what a given command
 * costs it to answer.
 */
const rateLimitSchema = z.object({
  /** Commands one wallet may invoke per minute, before weighting. */
  perWalletPerMinute: z.int().min(1).max(600).default(10),
  /**
   * Ceiling across ALL wallets, per minute.
   *
   * Per-wallet limits stop one abuser; this stops a hundred wallets each sitting
   * politely under the per-wallet limit from exhausting an AI budget or an
   * upstream API quota.
   */
  globalPerMinute: z.int().min(1).max(10_000).default(20),
  /**
   * How long before a throttled wallet is told again that it is throttled.
   *
   * Replying to every throttled request turns the limiter into an amplifier
   * driven by this bot's own wallet and posting budget: a 100-message flood
   * would produce 100 replies. One reply per wallet per window, then silence.
   */
  noticeCooldownSeconds: z.int().min(1).max(3600).default(300),
  /**
   * Share of the wallet's NODE-side posting quota that commands may spend.
   *
   * The limits above bound abuse. This bounds something more dangerous: a reply
   * is an ordinary chat message, so it spends the same per-wallet quota the node
   * meters for everything this wallet sends — including news posts. A registered
   * wallet gets 20 per 10-minute window and 300 per day, so an unbounded command
   * module could exhaust the daily quota before breakfast and the bot would post
   * no news for the rest of the day.
   *
   * Expressed as a share rather than a count because the node ceiling moves 6x
   * when a wallet registers on-chain; a hand-set number would be wrong on one
   * side of that.
   */
  maxShareOfNodeBudget: z.number().min(0.05).max(1).default(0.5),
  /**
   * Most of one node-budget burst window a SINGLE wallet may take.
   *
   * `perWalletPerMinute` alone does not stop one wallet owning the day: ten
   * commands a minute is a polite rate, and sustained it is the entire daily
   * reply budget in under three hours — from one wallet that never exceeded a
   * stated limit, and never exceeded the node's own limits either. This bounds a
   * wallet against the quota that actually exists rather than against the clock.
   */
  perWalletShareOfBudget: z.number().min(0.05).max(1).default(0.25),
});

export const botSchema = z.object({
  /** Declare this wallet a bot and answer commands in the channels it is in. */
  enabled: z.boolean().default(false),
  /**
   * Display convenience for `/cmd@handle` disambiguation. ASCII-only, NOT
   * unique, NOT enforced, NOT identity — the wallet address is identity.
   */
  handle: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/, 'must be ASCII letters, digits or underscore')
    .refine(
      (v) => utf8(v) >= COMMAND_LIMITS.MIN_HANDLE && utf8(v) <= COMMAND_LIMITS.MAX_HANDLE,
      { message: `must be ${COMMAND_LIMITS.MIN_HANDLE}-${COMMAND_LIMITS.MAX_HANDLE} bytes` },
    )
    .optional(),
  /**
   * Commands to advertise. Empty is valid and means "a bot with no commands" —
   * it still gets the Bot badge in clients.
   */
  commands: z.array(commandSchema).max(COMMAND_LIMITS.MAX_COMMANDS).default([]),
  /**
   * Channels to answer in, by id. REQUIRED when enabled — startup refuses an
   * empty list rather than guessing.
   *
   * There is deliberately no "every channel I have joined" default: answering
   * spends the wallet's posting quota, so where that happens should be something
   * the operator wrote down rather than something the bot inferred.
   */
  channels: z.array(z.int().min(1)).max(64).default([]),
  rateLimit: rateLimitSchema.prefault({}),
  autoJoin: z
    .object({
      /**
       * How often to check for new channel-invite notifications addressed to
       * this wallet, so a channel owner can add the bot without the operator
       * touching `channels` above. Also runs once immediately on every
       * startup, so a restart does not wait for the first tick.
       */
      schedule: z
        .string()
        .default('*/15 * * * *')
        .refine(isValidCron, { message: 'not a valid cron expression' }),
      /** Where the "already handled up to" cursor and answer grants are persisted. */
      statePath: z.string().min(1).default('data/autojoin.json'),
      /**
       * Whether an invited, non-encrypted channel also gets ANSWERED, not
       * just joined. Membership always happens regardless of this setting;
       * this only controls whether the channel is also added to the live
       * answering set. Defaults on, so inviting the bot is enough by itself
       * — no separate operator step needed to make it usable in a channel
       * someone else invited it to. Bounded by `maxAutoAnsweredChannels`
       * below, since answering spends the wallet's posting quota and an
       * unbounded grant would let any number of channel owners each claim a
       * slice of it just by inviting.
       */
      answerInvitedChannels: z.boolean().default(true),
      /**
       * Cap on how many invite-granted channels may be in the live
       * answering set at once (on top of `channels` above, which has no
       * cap of its own — the operator wrote that list down by hand). Past
       * the cap, further invited channels still get MEMBERSHIP, just not a
       * share of the answer budget, until the operator raises this or adds
       * a channel to `channels` themselves.
       */
      maxAutoAnsweredChannels: z.int().min(0).max(500).default(20),
      /**
       * Hours an invite-granted channel may sit in the answering set without
       * EVER successfully decrypting a single message before its slot is
       * freed. Exists because a channel's own metadata is not proof its
       * traffic is genuinely readable: a channel can legally declare itself
       * unencrypted while every message it sends still carries fabricated
       * `enc_content`/`enc_nonce`/`key_epoch` fields that will never
       * decrypt (no real key was ever wrapped for it) — that traffic never
       * flips the channel's own metadata to "encrypted", so the existing
       * "free the slot once it turns encrypted" cleanup never triggers, and
       * a cheap, permanently-empty channel could otherwise squat a slot
       * forever for the price of one invite. A channel that HAS answered at
       * least once is exempt regardless of how long it then goes quiet —
       * this only reaps a slot that has never once proven useful.
       */
      maxUnservedEncryptedHours: z.int().min(1).max(24 * 30).default(24),
    })
    .prefault({}),
});

export type BotConfig = z.infer<typeof botSchema>;
