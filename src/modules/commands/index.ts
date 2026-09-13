/**
 * The `commands` module — answers slash commands in channels.
 *
 * Declares this wallet a bot (protocol §3.11) so clients render its commands in
 * their `/`-autocomplete, then listens for invocations and replies.
 *
 * ## How an invocation arrives
 *
 * A slash command is an **ordinary chat message** whose content starts with
 * `/name`, with this bot's wallet in the envelope's `mentions[]`. There is no
 * command message type — deliberately, so the traffic is indistinguishable from
 * chat and a hostile relay cannot selectively drop it.
 *
 * The cost of that design lands here: because a node cannot identify command
 * traffic, it cannot rate-limit it either. Per-invoker limiting is this module's
 * job, and it is the right place — only this bot knows what a command costs it.
 */

import type { ZodTypeAny } from 'zod';
import { MSG_TYPE_NAME, MessageType, parseCommand, type Envelope, type Notification } from '@ogmara/sdk';
import { NODE_LIMITS, type Config } from '../../config.js';
import { schedule } from '../../scheduler.js';
import type { BotContext, BotModule, ModuleHandle, ModuleJob, PreflightFailure } from '../types.js';
import { botSchema, type BotConfig } from './schema.js';
import { CommandRateLimiter, NodeBudget, capFor } from './rateLimit.js';
import { buildHandlers, type CommandHandler } from './handlers.js';
import { decodeChatPayload } from './payload.js';
import { extractChannelInvites, loadAutoJoinCursor, saveAutoJoinCursor } from './autojoin.js';

/** What preflight needs to know about a channel before listening in it. */
export interface ChannelFacts {
  readonly name: string;
  /** True for a force-encrypted private channel. */
  readonly encrypted: boolean;
  /** Whether this wallet is allowed to post here at all. */
  readonly canPost: boolean;
}

/** Services the module needs that the core or another module owns. */
export interface CommandsDeps {
  /** Send a plain chat message. Routed through the shared posting path. */
  readonly reply: (channelId: number, text: string, mentions: string[]) => Promise<void>;
  /** Subscribe to channel messages. Returns a close function. */
  readonly subscribeChannels: (
    channels: number[],
    onMessage: (envelope: Envelope) => void,
  ) => Promise<() => void>;
  /**
   * Describe a channel, for the preflight checks.
   *
   * Three outcomes, deliberately distinguished:
   *   - facts       — the channel is there and usable
   *   - `null`      — it does not exist, or is not visible to this wallet: a
   *                   config error, which will not fix itself
   *   - `'unreachable'` — the node could not answer. NOT a config error, and
   *                   reported as its own thing so the operator is not told to
   *                   fix channel ids because their node was restarting.
   */
  readonly describeChannel: (channelId: number) => Promise<ChannelFacts | null | 'unreachable'>;
  /** Publish the bot descriptor. */
  readonly publishDescriptor: (descriptor: {
    handle?: string;
    commands: Array<{ name: string; description: string; args_hint?: string }>;
  }) => Promise<void>;
  /** Join a channel by id — a real signed write, subject to `posting.dryRun`. */
  readonly joinChannel: (channelId: number) => Promise<void>;
  /**
   * Fetch this wallet's notifications, newest first, optionally since a
   * timestamp and/or filtered to one type. The type filter matters here: an
   * untyped page mixes every notification together, and a mention fires on
   * every command invocation — for a busy answering bot that can crowd
   * `channel_invite` out of the page long before this wallet ever sees it.
   */
  readonly getNotifications: (
    since?: number,
    limit?: number,
    type?: Notification['type'],
  ) => Promise<readonly Notification[]>;
  /**
   * Override the handler table. Tests only.
   *
   * Exists because every built-in handler costs 1, which makes the cost gates in
   * `preflight` unreachable from config alone — and an unreachable guard is an
   * untested guard. The gates are what caught a command that could never be
   * answered on the default tier, so they need a test that fails when they are
   * removed, not one that restates their arithmetic.
   */
  readonly handlersOverride?: (config: Config, bot: BotConfig) => Map<string, CommandHandler>;
}

/**
 * Make text safe to print to the operator's terminal.
 *
 * First line only, control characters and escapes removed — a reply can carry
 * text an attacker chose, and ANSI escapes in a terminal can rewrite or hide
 * what the operator is looking at.
 */
function forLog(text: string): string {
  const firstLine = text.split('\n')[0] ?? '';
  // eslint-disable-next-line no-control-regex
  return firstLine.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E]/gu, '');
}

/**
 * Whether a frame is a new chat message.
 *
 * Accepts BOTH encodings on purpose: the envelope type declares `msg_type` as a
 * number, but the WebSocket serialises the Rust enum as its variant NAME, so a
 * numeric-only check silently rejects every live frame while passing every
 * hand-built test fixture.
 */
/**
 * The WebSocket's spelling of a chat message.
 *
 * Hoisted with a literal fallback because the indexed lookup is
 * `string | undefined`: were the SDK ever to drop the key, comparing against
 * `undefined` would make `isChatMessage(undefined)` true and let every
 * unlabelled frame through.
 */
const CHAT_MESSAGE_NAME: string = MSG_TYPE_NAME[MessageType.ChatMessage] ?? 'ChatMessage';

function isChatMessage(msgType: unknown): boolean {
  return msgType === MessageType.ChatMessage || msgType === CHAT_MESSAGE_NAME;
}

/**
 * Longest wallet address or message id this module will retain.
 *
 * A bech32 address is ~62 characters and a msg_id is a hex digest; both are
 * comfortably under this. The point is not to validate them — the node already
 * did — but to keep an untrusted string from being stored at all.
 */
const MAX_ID_CHARS = 128;

/**
 * Replies one wallet may take from a single burst window.
 *
 * One helper, used by the limiter, the startup log and the preflight check —
 * because three copies of this arithmetic is how the preflight came to validate
 * a different limit from the one that actually applies.
 */
function walletWindowCap(burstCap: number, cfg: BotConfig): number {
  return capFor(burstCap, cfg.rateLimit.perWalletShareOfBudget);
}

function botConfig(config: Config): BotConfig {
  return config.bot;
}

export function createCommandsModule(deps: CommandsDeps): BotModule {
  let limiter: CommandRateLimiter | undefined;
  let nodeBudget: NodeBudget | undefined;
  let handlers: Map<string, CommandHandler> = new Map();
  let close: (() => void) | undefined;
  /**
   * False before start and after stop.
   *
   * Closing the socket does not un-dispatch a message already handed to the
   * callback, and handling is async — so without this a module that has been
   * stopped can still send a reply, spending the wallet's quota after shutdown
   * has been reported. "A stopped bot that keeps posting" is the same failure
   * the registry guards against for crons.
   */
  let running = false;
  /**
   * Message ids already answered, newest last.
   *
   * The WebSocket can re-deliver — a reconnect replays, and the node fans the
   * same frame to every connection — and an edit of an existing message arrives
   * as another broadcast carrying the full replacement text. Without this, one
   * message can be answered repeatedly, each time spending a quota slot, and a
   * user can drive that on purpose by editing their own message in a loop.
   */
  const answered = new Set<string>();
  /** Bound on `answered`; oldest entries are evicted first (insertion order). */
  const MAX_ANSWERED = 2048;
  /** When the reply budget last blocked, so the log says it once, not per message. */
  let budgetWarnedAt = 0;

  return {
    name: 'commands',

    schemas: { bot: botSchema as ZodTypeAny },

    // Every one of these is read once, at `start()`, and closed over — there
    // is no live-apply path, so all of them are restart-required. Left explicit
    // rather than relying on the settings page's restart-by-default fallback:
    // that default exists for paths NO module claimed, and silently matching it
    // here would make it easy to forget when a live-apply path is eventually
    // added for one of these.
    uiSchema: {
      'bot.enabled': {
        label: 'field.bot.enabled.label',
        help: 'field.bot.enabled.help',
        restart: true,
      },
      'bot.handle': {
        label: 'field.bot.handle.label',
        help: 'field.bot.handle.help',
        restart: true,
      },
      'bot.channels': {
        label: 'field.bot.channels.label',
        help: 'field.bot.channels.help',
        restart: true,
      },
      'bot.commands': {
        label: 'field.bot.commands.label',
        help: 'field.bot.commands.help',
        restart: true,
      },
      'bot.rateLimit.perWalletPerMinute': {
        label: 'field.bot.rateLimit.perWalletPerMinute.label',
        restart: true,
      },
      'bot.rateLimit.globalPerMinute': {
        label: 'field.bot.rateLimit.globalPerMinute.label',
        restart: true,
      },
      'bot.rateLimit.noticeCooldownSeconds': {
        label: 'field.bot.rateLimit.noticeCooldownSeconds.label',
        restart: true,
      },
      'bot.rateLimit.maxShareOfNodeBudget': {
        label: 'field.bot.rateLimit.maxShareOfNodeBudget.label',
        help: 'field.bot.rateLimit.maxShareOfNodeBudget.help',
        restart: true,
      },
      'bot.rateLimit.perWalletShareOfBudget': {
        label: 'field.bot.rateLimit.perWalletShareOfBudget.label',
        help: 'field.bot.rateLimit.perWalletShareOfBudget.help',
        restart: true,
      },
      'bot.autoJoin.schedule': {
        label: 'field.bot.autoJoin.schedule.label',
        help: 'field.bot.autoJoin.schedule.help',
        restart: true,
      },
      'bot.autoJoin.statePath': {
        label: 'field.bot.autoJoin.statePath.label',
        help: 'field.bot.autoJoin.statePath.help',
        restart: true,
      },
    },

    isEnabled: (config) => botConfig(config).enabled,

    async preflight(ctx: BotContext): Promise<PreflightFailure | null> {
      const cfg = botConfig(ctx.config);
      handlers = (deps.handlersOverride ?? buildHandlers)(ctx.config, cfg);

      // Every declared command must have a handler, or the bot advertises
      // something it will silently ignore — which reads to a user as the bot
      // being broken, and is worse than not advertising it at all.
      const undeclared = cfg.commands.filter((c) => !handlers.has(c.name)).map((c) => c.name);
      if (undeclared.length > 0) {
        return {
          message:
            `\nbot.commands declares ${undeclared.map((n) => `"/${n}"`).join(', ')}, ` +
            'which this build has no handler for.\n' +
            `Known commands: ${[...handlers.keys()].map((n) => `/${n}`).join(', ')}.\n` +
            'Remove the unknown entries, or the bot would advertise commands it silently ignores.',
        };
      }

      // Explicit rather than "every channel this wallet has joined". There is no
      // membership query to resolve that against, and probing every channel is
      // unbounded network work at startup — but more to the point, "answer
      // everywhere I have ever joined" is a surprising default for something
      // that spends the wallet's posting quota.
      // A command costing more than a limit can never be invoked: every attempt
      // is refused, and the user is told they are going too fast when in fact
      // they can never go slowly enough.
      //
      // Checked against EVERY gate, not just the per-minute one. There are three,
      // and the tightest is derived rather than configured — on an unregistered
      // wallet (5 messages per 10 min) the per-wallet window cap floors at 1,
      // which is below the cost of a command shipped in config.example.yaml.
      // Validating only `perWalletPerMinute` let that through.
      // Same helper the running NodeBudget uses, so this check cannot validate a
      // limit different from the one enforced.
      const burstCap = capFor(ctx.publisher.burstLimit, cfg.rateLimit.maxShareOfNodeBudget);
      const windowCap = walletWindowCap(burstCap, cfg);
      const gates: Array<{ limit: number; name: string; hint: string }> = [
        {
          limit: cfg.rateLimit.perWalletPerMinute,
          name: 'bot.rateLimit.perWalletPerMinute',
          hint: 'Raise it to at least the command\'s cost.',
        },
        {
          // Silent denial, which is worse: nothing is logged and nothing is sent.
          limit: cfg.rateLimit.globalPerMinute,
          name: 'bot.rateLimit.globalPerMinute',
          hint: 'Raise it to at least the command\'s cost.',
        },
        {
          limit: windowCap,
          name:
            `the per-wallet window cap (${windowCap} per ${NODE_LIMITS.burstWindowMinutes}min, ` +
            "derived from this wallet's node quota)",
          hint:
            'Register the wallet on-chain for 6x the node quota, or raise ' +
            'bot.rateLimit.maxShareOfNodeBudget / perWalletShareOfBudget.',
        },
      ];
      for (const gate of gates) {
        const blocked = cfg.commands
          .map((c) => ({ name: c.name, cost: handlers.get(c.name)?.cost ?? 1 }))
          .filter((c) => c.cost > gate.limit);
        if (blocked.length === 0) continue;
        // The most expensive, not merely the first: it is the one that sets the
        // limit the operator has to clear.
        const worst = blocked.reduce((a, b) => (b.cost > a.cost ? b : a));
        return {
          message:
            `\n"/${worst.name}" costs ${worst.cost}, which is more than ${gate.name} ` +
            `allows (${gate.limit}).\nNo wallet could ever invoke it — every attempt would ` +
            `be refused.\n${gate.hint}`,
        };
      }

      if (cfg.channels.length === 0) {
        return {
          message:
            '\nbot.enabled is true but bot.channels is empty.\n' +
            'List the channel ids the bot should answer in, e.g.\n  bot:\n    channels: [1, 7]',
        };
      }

      for (const id of cfg.channels) {
        const facts = await deps.describeChannel(id);
        if (facts === 'unreachable') {
          // A PreflightFailure, not a thrown error: preflight already has a
          // clean "print this and exit 2" path, whereas a throw lands in the
          // process-level catch-all and prints a stack trace at an operator
          // whose node is simply down.
          return {
            message:
              `\nCould not reach the node to check channel ${id}.\n` +
              'This is the node being unavailable rather than a config problem — ' +
              'the bot will retry when it restarts.',
          };
        }
        if (facts === null) {
          return {
            message:
              `\nbot.channels lists channel ${id}, which this node does not serve or this ` +
              'wallet cannot see.\nCheck the id, and that the bot has joined the channel.',
          };
        }
        if (facts.encrypted) {
          // Refused rather than attempted. In an encrypted channel the bot reads
          // ciphertext it has no key for, so it would answer nothing at all —
          // and a plaintext reply would downgrade a channel whose policy is
          // encrypt-on-send. Note this is NOT only private channels: new public
          // channels are created with encryption forced on.
          return {
            message:
              `\nbot.channels lists channel ${id} ("${forLog(facts.name)}"), which is end-to-end ` +
              'encrypted.\nThis build reads and replies in plaintext only, so it would answer ' +
              'nothing there. Remove it from bot.channels.',
          };
        }
        if (!facts.canPost) {
          return {
            message:
              `\nbot.channels lists channel ${id} ("${forLog(facts.name)}"), where this wallet is not ` +
              'allowed to post.\nIt could read commands but never answer them.',
          };
        }
      }
      return null;
    },

    async start(ctx: BotContext): Promise<ModuleHandle> {
      const cfg = botConfig(ctx.config);
      if (handlers.size === 0) handlers = (deps.handlersOverride ?? buildHandlers)(ctx.config, cfg);

      // Join every configured channel, UNCONDITIONALLY on every start, the
      // same way the descriptor is republished below — no local "already a
      // member" check, relying on the join being idempotent server-side.
      // Preflight already refused any of these that are encrypted or
      // unpostable, so this is a direct attempt, not a recheck. Best-effort
      // per channel: one failure must not stop the module from starting and
      // answering in the channels that DID work.
      for (const channelId of cfg.channels) {
        if (ctx.config.posting.dryRun) {
          ctx.log(`  [dry run] would join channel ${channelId}`);
          continue;
        }
        try {
          await deps.joinChannel(channelId);
        } catch (err) {
          ctx.warn(`  warning: could not join channel ${channelId} (${forLog(String(err))})`);
        }
      }
      // Read through getters, not snapshotted: the node's ceiling moves 6x when a
      // wallet registers on-chain, which an operator can do from the control
      // panel while the bot is running.
      nodeBudget = new NodeBudget(
        () => ctx.publisher.burstLimit,
        () => ctx.publisher.dailyLimit,
        cfg.rateLimit.maxShareOfNodeBudget,
      );
      const budget = nodeBudget;
      limiter = new CommandRateLimiter({
        ...cfg.rateLimit,
        // Built from the budget that actually exists, so no single wallet can
        // take the whole window however politely it paces itself.
        perWalletPerWindow: () => walletWindowCap(budget.burstCap, cfg),
      });


      // Republish the descriptor UNCONDITIONALLY on every start, and do not
      // track what was last published (protocol §3.11). That local state
      // desyncs from what a node actually holds — after a node wipe, on a fresh
      // node, or on a dropped gossip message — and the bot would then believe
      // its commands were advertised while every client saw nothing. The node
      // compares content and suppresses its broadcast when nothing changed, so
      // republishing costs nothing.
      const descriptor = {
        ...(cfg.handle !== undefined ? { handle: cfg.handle } : {}),
        commands: cfg.commands.map((c) => ({
          name: c.name,
          description: c.description,
          ...(c.argsHint !== undefined ? { args_hint: c.argsHint } : {}),
        })),
      };
      if (ctx.config.posting.dryRun) {
        // Publishing the descriptor is a real signed ProfileUpdate against the
        // live network. Dry run means nothing reaches the network, and that has
        // to include declaring yourself a bot to everyone — otherwise an
        // operator testing a config has already published their handle and
        // command list before deciding to go live.
        ctx.log(`  [dry run] would advertise ${descriptor.commands.length} command(s)`);
      } else {
        try {
          await deps.publishDescriptor(descriptor);
        } catch (err) {
          // NOT fatal. This is one PUT to the profile endpoint; a 429 or a 5xx
          // there would otherwise throw out of start(), out of startAll, and
          // take down the news pipeline, which had nothing to do with it. A bot
          // that answers commands without an advertised picker is far better
          // than a bot that does not run.
          ctx.warn(
            `  warning: could not publish the bot descriptor (${forLog(String(err))}). ` +
              'Commands still work for anyone who types them; clients will not ' +
              'offer them in the "/" picker until the next restart succeeds.',
          );
        }
      }
      ctx.log(
        `Commands: advertising ${cfg.commands.length} command(s)` +
          (cfg.handle !== undefined ? ` as @${cfg.handle}` : '') +
          (cfg.commands.length > 0
            ? ` — ${cfg.commands.map((c) => `/${c.name}`).join(', ')}`
            : ''),
      );

      const perWalletWindow = walletWindowCap(nodeBudget.burstCap, cfg);
      ctx.log(
        `Commands: reply budget ${nodeBudget.burstCap}/10min, ${nodeBudget.dailyCap}/day ` +
          `(${Math.round(cfg.rateLimit.maxShareOfNodeBudget * 100)}% of this wallet's node quota; ` +
          'the rest stays reserved for posting)',
      );
      // Stated explicitly because it is the number users actually run into, and
      // it is derived rather than configured — an operator reading only
      // `perWalletPerMinute: 10` would have no idea the real ceiling is this.
      ctx.log(
        `Commands: any one wallet may take ${perWalletWindow} of those per 10min ` +
          `(perWalletShareOfBudget ${cfg.rateLimit.perWalletShareOfBudget})` +
          (perWalletWindow < 3 && !ctx.publisher.registered
            ? ' — low, because this wallet is unregistered; registering raises the node quota 6x'
            : perWalletWindow < 3
              ? ' — low; raise maxShareOfNodeBudget or perWalletShareOfBudget for a chattier bot'
              : ''),
      );

      ctx.log(`Commands: listening in channel(s) ${cfg.channels.join(', ')}`);

      running = true;
      close = await deps.subscribeChannels([...cfg.channels], (envelope) => {
        void handleMessage(ctx, cfg, envelope).catch((err) => {
          // Through `forLog`: the SDK embeds up to 200 characters of the node's
          // raw response body in the message, so this text is not ours.
          ctx.warn(`  warning: command handling failed (${forLog(String(err))})`);
        });
      });

      // Catch up once immediately (so a restart doesn't wait for the first
      // scheduled tick before noticing an invite that arrived while the bot
      // was down), then keep checking on a schedule. Awaited like the
      // descriptor publish above: non-fatal on failure, but start() should
      // not report "running" before this wallet's channel membership has
      // actually settled.
      try {
        await pollForInvites(ctx, cfg);
      } catch (err) {
        ctx.warn(`  warning: initial invite check failed (${forLog(String(err))})`);
      }
      const autoJoinJob = schedule(cfg.autoJoin.schedule, () => pollForInvites(ctx, cfg));
      ctx.log(
        `Commands: checking for channel invites "${cfg.autoJoin.schedule}" — next ` +
          `${autoJoinJob.nextRun()?.toISOString() ?? 'never'}`,
      );
      const jobs: ModuleJob[] = [
        { name: 'commands-autojoin', cron: cfg.autoJoin.schedule, job: autoJoinJob },
      ];

      return {
        jobs,
        async stop(): Promise<void> {
          running = false;
          close?.();
          close = undefined;
          autoJoinJob.stop();
        },
      };
    },
  };

  /**
   * Check for `channel_invite` notifications since the last handled cursor
   * and join each one. Joins ONLY — see the module doc comment for why this
   * never adds the channel to `bot.channels` on its own.
   *
   * A failed join or a node hiccup on ONE invite is logged and skipped, not
   * retried: the cursor advances past every notification seen this poll
   * regardless of per-invite outcome, trading a rare missed invite (an
   * unlikely transient failure right when an invite happens to land) for a
   * simple, single-timestamp cursor rather than a per-invite retry queue.
   * An operator who notices can always add the channel to `bot.channels`
   * by hand — nothing about a missed auto-join is unrecoverable.
   */
  async function pollForInvites(ctx: BotContext, cfg: BotConfig): Promise<void> {
    const cursorPath = cfg.autoJoin.statePath;
    const since = loadAutoJoinCursor(cursorPath, ctx.warn);
    let notifications: readonly Notification[];
    try {
      // The type filter matters, not just a nicety: an untyped page mixes
      // every notification together, and a mention fires on every command
      // invocation — for a busy bot that can crowd channel_invite out of
      // the page before this wallet ever sees it (l2-node 0.129.0 widens
      // its own scan for a type filter specifically to prevent that). The
      // max page size (200) is extra headroom on top of that, in case this
      // wallet is itself invited to many channels between polls.
      notifications = await deps.getNotifications(since, 200, 'channel_invite');
    } catch (err) {
      ctx.warn(`  warning: could not check for channel invites (${forLog(String(err))})`);
      return;
    }
    const { invites, newestTs } = extractChannelInvites(notifications);
    // Always logged, including the zero-result case — otherwise there is no
    // way to tell "the poller ran and found nothing" apart from "the poller
    // never ran," "it crashed silently," or "the invite never reached the
    // node" from the operator's log alone.
    ctx.log(
      `Commands: checked for channel invites — ${notifications.length} notification(s), ` +
        `${invites.length} invite(s)`,
    );
    for (const invite of invites) {
      // Both wire strings from a payload another wallet controls, so both
      // get the same treatment reply text and error text get elsewhere in
      // this file: `forLog` strips control characters and ANSI escapes that
      // could otherwise rewrite or hide what the operator's terminal shows.
      const invitedBy = forLog(invite.invitedBy);
      const noticeName = invite.channelName !== undefined ? forLog(invite.channelName) : undefined;

      let facts: ChannelFacts | null | 'unreachable';
      try {
        facts = await deps.describeChannel(invite.channelId);
      } catch (err) {
        // Not part of describeChannel's documented contract today (every
        // real implementation resolves to null/'unreachable' instead of
        // rejecting), but this loop must not let one bad invite abort the
        // rest of the page — or skip saving the cursor for invites already
        // handled above it.
        ctx.warn(
          `  warning: could not check channel ${invite.channelId} ` +
            `(${forLog(String(err))}) — skipping`,
        );
        continue;
      }
      if (facts === 'unreachable') {
        ctx.warn(
          `  warning: invited to channel ${invite.channelId}` +
            (noticeName !== undefined ? ` ("${noticeName}")` : '') +
            ` by ${invitedBy}, but could not reach the node to check it — not retried, ` +
            'see bot.channels to add it by hand',
        );
        continue;
      }
      if (facts === null) {
        ctx.warn(
          `  warning: invited to channel ${invite.channelId}` +
            (noticeName !== undefined ? ` ("${noticeName}")` : '') +
            ` by ${invitedBy}, but this wallet cannot see it — skipping`,
        );
        continue;
      }
      const name = forLog(facts.name);
      // Membership only — deliberately NOT added to cfg.channels/answering.
      // canPost is irrelevant here: even a read-public channel this wallet
      // cannot post in is a legitimate one to just be a member of.
      //
      // Joined EVEN IF encrypted, unlike the static bot.channels preflight
      // check (which refuses one outright, since answering there would be
      // pointless). An explicit invite is a channel owner asking for this
      // wallet specifically, with no confirmation step on this wallet's
      // side at any point in the pipeline — a private channel is currently
      // the ONLY channel type the client UI can even invite to, so refusing
      // to join it would make invite-driven auto-join a no-op in practice.
      // This build still cannot decrypt or answer there; only membership
      // (visible in the member list and to `get_channel_bots`) results.
      // `bot.channels` remains the one and only thing that makes it answer
      // anywhere, and its own preflight check is unaffected by this.
      if (ctx.config.posting.dryRun) {
        ctx.log(`  [dry run] would join channel ${invite.channelId} ("${name}"), invited by ${invitedBy}`);
        continue;
      }
      try {
        await deps.joinChannel(invite.channelId);
        ctx.log(
          `Commands: joined channel ${invite.channelId} ("${name}"), invited by ${invitedBy}.` +
            (facts.encrypted
              ? ' It is end-to-end encrypted, so this build cannot read or answer there — ' +
                'membership only.'
              : ' Add it to bot.channels to answer commands there too.'),
        );
      } catch (err) {
        ctx.warn(
          `  warning: could not join channel ${invite.channelId} (${forLog(String(err))})`,
        );
      }
    }
    if (newestTs !== null) saveAutoJoinCursor(cursorPath, newestTs);
  }

  async function handleMessage(
    ctx: BotContext,
    cfg: BotConfig,
    envelope: Envelope,
  ): Promise<void> {
    if (!running) return;

    // Length-guard the two node-supplied strings this module RETAINS. Both end
    // up as keys in bounded collections — `author` in the rate-limiter map
    // (10,000 entries) and `msg_id` in the dedup set (2,048) — and those bounds
    // count entries, not bytes. A bech32 address is ~62 characters and a msg_id
    // is a hex digest, so anything longer is not a real one; without this, a
    // hostile or compromised node could park gigabytes in maps that look
    // correctly bounded.
    const author = envelope.author;
    if (typeof author !== 'string' || author.length === 0 || author.length > MAX_ID_CHARS) return;
    const msgId =
      typeof envelope.msg_id === 'string' &&
      envelope.msg_id.length > 0 &&
      envelope.msg_id.length <= MAX_ID_CHARS
        ? envelope.msg_id
        : undefined;

    const me = ctx.publisher.address;
    // Never answer our own messages. Without this a reply that itself begins
    // with "/" — or any future command that echoes input — loops forever.
    if (author === me) return;

    // Only a NEW chat message. `broadcast_channel_message` carries edits,
    // reactions and deletes under the same frame type, and an edit payload holds
    // the full replacement text — so without this, editing a message to start
    // with "/about" produces a fresh reply every time it is edited.
    if (!isChatMessage(envelope.msg_type)) return;

    const channelId = envelope.channel_id;
    if (channelId === undefined) return;
    // This is the ONLY channel lock, not a second one: the node's public
    // WebSocket audience is everyone, so every public-channel message on the
    // node reaches this bot regardless of what it subscribed to. Checked before
    // any decoding, so out-of-scope traffic costs almost nothing.
    if (!cfg.channels.includes(channelId)) return;

    // Re-delivery is normal — a reconnect replays, and the same frame reaches
    // every connection. Answering twice doubles the quota spend and looks like
    // a malfunctioning bot.
    if (msgId !== undefined && answered.has(msgId)) return;

    // The text is NOT on the envelope. The node enriches the frame with msg_id,
    // author and channel_id and nothing else; the content and the mention list
    // live inside `payload` as msgpack bytes, which is why the SDK's
    // `parseCommand` takes a decoded object rather than an envelope. Decoding is
    // a trust boundary — see payload.ts.
    const { content, mentions } = decodeChatPayload(envelope.payload);
    if (content === null) return;

    const parsed = parseCommand({ content, mentions }, me, cfg.handle ?? null);
    if (parsed === null || !parsed.addressed) return;

    // `bot.commands` is the single source of truth for BOTH the advertised
    // descriptor and what actually gets answered. Dispatching on the handler
    // table alone would answer commands the operator deliberately did not
    // declare — and `/topic` against an undeclared handler is an exact-match
    // oracle over the operator's private topic list, one guess at a time.
    if (!cfg.commands.some((c) => c.name === parsed.name)) return;

    const handler = handlers.get(parsed.name);
    // Fall through SILENTLY on a command we do not implement. A bare `/foo`
    // with no handle and no mentions is `addressed` for EVERY bot in the
    // channel — none can tell it was meant for another — so replying "unknown
    // command" makes a three-bot channel answer every typo three times.
    if (handler === undefined) return;

    const now = Date.now();
    const decision = limiter!.check(author, now, handler.cost ?? 1);
    if (decision.kind === 'deny-silent') return;
    if (decision.kind === 'deny-notify') {
      // The notice is itself a chat message and costs node quota, so it goes
      // through the same budget as a real reply. When the budget is gone the
      // notice is dropped: spending the last of the wallet's quota to announce
      // that the quota is gone is the amplifier trap in its purest form.
      await send(
        ctx,
        channelId,
        author,
        'You are sending commands faster than I can answer them — try again shortly.',
        now,
      );
      return;
    }

    // Checked BEFORE running the handler, not after. A handler may spend an AI
    // call or an upstream API quota, and paying for an answer that can never be
    // delivered is pure waste.
    //
    // A peek is not a reservation: concurrent invocations can all see the last
    // slot and all run their handlers, and only one will get to send. The cap
    // still holds (consume re-checks), so this is a wasted-work guarantee that
    // is sequential-only — worth tightening into a real reservation if a handler
    // ever costs money per call.
    if (!nodeBudget!.peek(now)) {
      warnBudgetExhausted(ctx, now);
      return;
    }

    // Recorded BEFORE the handler runs, not after. A slow handler would
    // otherwise leave a window in which a re-delivery is answered a second time,
    // spending a second quota slot.
    //
    // The trade-off, stated so it is a decision rather than an oversight: if the
    // reply then fails to send, this message is never answered. That is the
    // right way round — WebSocket re-delivery is a reconnect replaying history,
    // not a retry mechanism, so treating it as one would mean double-answering
    // every message after every reconnect. A user whose answer was lost can type
    // the command again, which arrives with a new id.
    if (msgId !== undefined) remember(msgId);

    const text = await handler.run(parsed.args);
    if (text === null) return;
    await send(ctx, channelId, author, text, Date.now());
  }

    /** Record an answered message id, evicting the oldest once the bound is hit. */
  function remember(msgId: string): void {
    if (answered.size >= MAX_ANSWERED) {
      // Set iteration is insertion order, so the first key is the oldest.
      const oldest = answered.values().next();
      if (!oldest.done) answered.delete(oldest.value);
    }
    answered.add(msgId);
  }

  /**
   * Say once — not per message — that the reply budget is spent.
   *
   * Silent exhaustion is the failure an operator cannot diagnose: the bot simply
   * stops answering, with no log line, and the first signal is a user reporting
   * it. Once per burst window is enough to explain it without becoming a flood
   * of its own.
   */
  function warnBudgetExhausted(ctx: BotContext, now: number): void {
    if (now - budgetWarnedAt < 10 * 60_000) return;
    budgetWarnedAt = now;
    ctx.warn(
      '  warning: command reply budget spent for now — not answering until it refills ' +
        `(${nodeBudget!.remainingToday(now)} reply slots left today). ` +
        'Raise bot.rateLimit.maxShareOfNodeBudget to give commands more of the wallet quota, ' +
        'at the cost of headroom reserved for posting.',
    );
  }

  /**
   * Send one chat message, honouring dry-run and the node-side quota.
   *
   * Every outbound message in this module goes through here — replies and
   * throttle notices alike — so there is exactly one place where the wallet's
   * quota can be spent.
   */
  async function send(
    ctx: BotContext,
    channelId: number,
    to: string,
    text: string,
    now: number,
  ): Promise<void> {
    if (!running) return;
    // Consumed in dry run too. The budget is what stops handlers running
    // unthrottled, and a dry run that skips it does not exercise the behaviour
    // it exists to preview.
    // Consumed BEFORE the network call, so a send that then fails still costs a
    // slot. Deliberate: the slot models the node's own quota, and a request that
    // reached the node counts against it whether or not we liked the response.
    // Consuming afterwards would let a run of failures spend the real quota
    // while this budget believed it was untouched.
    if (!nodeBudget!.consume(now)) {
      warnBudgetExhausted(ctx, now);
      return;
    }
    if (ctx.config.posting.dryRun) {
      // Dry run means "nothing reaches the network". A command reply is a real
      // post under the bot's real wallet, so it is not exempt — an operator
      // testing a config would otherwise be posting to a live channel.
      //
      // Control characters are stripped: the reply can contain text an attacker
      // chose, and this goes to the operator's terminal, where ANSI escapes can
      // rewrite what they see.
      ctx.log(`  [dry run] would reply in channel ${channelId}: ${forLog(text)}`);
      return;
    }
    await deps.reply(channelId, text, [to]);
  }
}
