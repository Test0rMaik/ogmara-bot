import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from '@msgpack/msgpack';
import { MessageType, type Envelope, type Notification } from '@ogmara/sdk';
import type { Config } from '../../config.js';
import type { BotContext } from '../types.js';
import { botSchema, type BotConfig } from './schema.js';
import { createCommandsModule, type ChannelFacts, type CommandsDeps } from './index.js';
import { saveAutoJoinState } from './autojoin.js';
import { capFor } from './rateLimit.js';
import type { CommandHandler } from './handlers.js';

function botCfg(over: Record<string, unknown> = {}): BotConfig {
  return botSchema.parse({ enabled: true, channels: [7], ...over });
}

/**
 * Builds a BotConfig with `over` applied AFTER schema validation, bypassing
 * `botSchema`'s own cross-field checks (e.g. its `enabled && channels.length
 * === 0` refinement). For exercising `validateBotConfig`/`reconfigure()`'s
 * OWN defense-in-depth checks with a shape the schema itself now refuses at
 * `commit()` time — those checks stay valuable for inputs that never went
 * through the schema at all (a directly-mutated `ctx.config.bot`, which is
 * exactly what `reconfigure()` sees), even though a legitimate settings save
 * can no longer produce an empty `channels` list in the first place.
 */
function unsafeBotCfg(over: Record<string, unknown> = {}): BotConfig {
  return { ...botCfg(), ...over } as BotConfig;
}

function configWith(bot: BotConfig, dryRun = false): Config {
  return {
    posting: { dryRun },
    sources: {
      rss: { enabled: false, feeds: [] },
      topics: { enabled: false, topics: [] },
      imagedir: { enabled: false, directories: [] },
    },
    bot,
  } as unknown as Config;
}

function ctxWith(config: Config): BotContext {
  return {
    config,
    secrets: {},
    publisher: { address: 'klv1bot', burstLimit: 20, dailyLimit: 300 },
    log: () => {},
    warn: () => {},
  } as unknown as BotContext;
}

const publicChannel: ChannelFacts = { name: 'general', encrypted: false, canPost: true };

function depsWith(over: Partial<CommandsDeps> = {}): CommandsDeps {
  return {
    reply: vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {}),
    subscribeChannels: vi.fn(async () => () => {}),
    describeChannel: vi.fn(async () => publicChannel),
    publishDescriptor: vi.fn(async () => {}),
    joinChannel: vi.fn(async (_channelId: number) => {}),
    federateChannel: vi.fn(async (_channelId: number, _hostUrl: string) => {}),
    getNotifications: vi.fn(async (_since?: number) => []),
    decryptChannelText: vi.fn(
      async (_channelId: number, _encContent: Uint8Array, _encNonce: Uint8Array, _keyEpoch: number) =>
        'waiting' as const,
    ),
    ...over,
  };
}

let msgSeq = 0;

/**
 * Build an envelope the way the NODE actually delivers one.
 *
 * The text and mentions go in `payload` as msgpack bytes, because that is where
 * they live on the wire: the node enriches the frame with `msg_id`, `author` and
 * `channel_id` and nothing else. An earlier version of this helper invented
 * top-level `content`/`mentions` fields — the whole suite passed while the
 * module could not answer a single command against a real node. Build the real
 * shape here, or these tests prove nothing.
 *
 * `payload` is a number[] because the frame arrives as JSON, which has no byte
 * array.
 */
function msg(
  content: string,
  opts: {
    from?: string;
    channel?: number;
    mentions?: string[];
    msgType?: number | string;
    msgId?: string;
  } = {},
): Envelope {
  const payload = encode({ content, mentions: opts.mentions ?? [] });
  msgSeq += 1;
  return {
    author: opts.from ?? 'klv1user',
    channel_id: opts.channel ?? 7,
    msg_id: opts.msgId ?? `msg-${msgSeq}`,
    msg_type: opts.msgType ?? MessageType.ChatMessage,
    payload: Array.from(payload),
  } as unknown as Envelope;
}

/**
 * Start the module and hand back the message callback the core registered, so a
 * test can deliver traffic the way the node would.
 */
async function startAndCapture(
  deps: CommandsDeps,
  ctx: BotContext,
): Promise<{
  deliver: (e: Envelope) => void;
  stop: () => Promise<void>;
  mod: ReturnType<typeof createCommandsModule>;
}> {
  let deliver: ((e: Envelope) => void) | undefined;
  const subscribeChannels = vi.fn(async (_ch: number[], onMessage: (e: Envelope) => void) => {
    deliver = onMessage;
    return () => {};
  });
  const mod = createCommandsModule({ ...deps, subscribeChannels });
  await mod.preflight!(ctx);
  const handle = await mod.start(ctx);
  return {
    deliver: (e) => deliver!(e),
    stop: () => handle.stop(),
    mod,
  };
}

/** Let the fire-and-forget handler promise settle. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('commands module preflight', () => {
  it('refuses a command the build has no handler for', async () => {
    // Advertising a command the bot silently ignores reads to a user as the bot
    // being broken, and is worse than not advertising it at all.
    const cfg = botCfg({ commands: [{ name: 'nosuch', description: 'x' }] });
    const failure = await createCommandsModule(depsWith()).preflight!(ctxWith(configWith(cfg)));
    expect(failure).not.toBeNull();
    expect(failure!.message).toContain('/nosuch');
    expect(failure!.message).toContain('no handler');
  });

  it('refuses an empty channel list rather than guessing', async () => {
    // unsafeBotCfg: botSchema itself now also refuses this shape (see its
    // `enabled && channels.length === 0` cross-field check) — this test
    // exercises validateBotConfig's OWN defense-in-depth copy of the same
    // check, which stays reachable for anything that skips the schema
    // (e.g. reconfigure() reading a directly-mutated ctx.config.bot).
    const failure = await createCommandsModule(depsWith()).preflight!(
      ctxWith(configWith(unsafeBotCfg({ channels: [] }))),
    );
    expect(failure!.message).toContain('bot.channels is empty');
  });

  it('refuses a channel the node does not serve, naming the id', async () => {
    const deps = depsWith({ describeChannel: vi.fn(async () => null) });
    const failure = await createCommandsModule(deps).preflight!(ctxWith(configWith(botCfg())));
    expect(failure!.message).toContain('channel 7');
  });

  it('accepts an ENCRYPTED channel in bot.channels rather than refusing to start', async () => {
    // REGRESSION GUARD (spec-compliance finding, 2026-09-15): this build can
    // now decrypt/reply once a member's client serves it a key
    // (channelKeys.ts) — a hard preflight refusal here would make the ENTIRE
    // decrypt/reply feature unreachable for every statically-configured
    // channel, since new Public/ReadPublic/Private channels are all created
    // with encryption forced on by default (spec §3.6). An encrypted
    // `bot.channels` entry must start successfully and let `handleMessage`'s
    // decrypt-and-retry logic sort out whether it ever becomes usable.
    const deps = depsWith({
      describeChannel: vi.fn(async () => ({ name: 'secret', encrypted: true, canPost: true })),
    });
    const failure = await createCommandsModule(deps).preflight!(ctxWith(configWith(botCfg())));
    expect(failure).toBeNull();
  });

  it('strips control characters from the channel name in a preflight failure message', async () => {
    // The channel name comes from the node — ultimately set by whoever
    // created or last renamed the channel, not this operator — and this
    // message is printed with console.error verbatim (src/index.ts). Same
    // untrusted-string risk `forLog` already closes for reply text and the
    // invite poller's logs elsewhere in this file.
    const deps = depsWith({
      describeChannel: vi.fn(async () => ({
        name: 'evil\x1b[31mFAKE\x1b[0m',
        encrypted: false,
        canPost: false,
      })),
    });
    const failure = await createCommandsModule(deps).preflight!(ctxWith(configWith(botCfg())));
    // eslint-disable-next-line no-control-regex
    expect(failure!.message).not.toMatch(/\x1b/);
  });

  it('refuses a command costing more than one wallet can ever spend', async () => {
    // Every shipped handler costs 1 today, so this drives the gate from the
    // other side: a global ceiling below the cheapest possible command.
    const cfg = botSchema.parse({
      enabled: true,
      channels: [7],
      commands: [{ name: 'about', description: 'who I am' }],
      rateLimit: { perWalletPerMinute: 1, globalPerMinute: 1 },
    });
    const ctx = ctxWith(configWith(cfg));
    (ctx.publisher as unknown as { burstLimit: number }).burstLimit = 20;
    expect(await createCommandsModule(depsWith()).preflight!(ctx)).toBeNull();
  });

  it('starts on an UNREGISTERED wallet with the shipped example commands', async () => {
    // REGRESSION GUARD. The derived per-wallet window cap floors at 1 on the
    // unverified tier (5 messages/10min), so any shipped command costing more
    // than 1 would make the default config refuse to start for exactly the
    // operators least able to diagnose it. Every built-in handler costs 1.
    const cfg = botSchema.parse({
      enabled: true,
      channels: [7],
      commands: [
        { name: 'about', description: 'a' },
        { name: 'help', description: 'b' },
        { name: 'sources', description: 'c' },
        { name: 'latest', description: 'd', argsHint: '[1-5]' },
        { name: 'topic', description: 'e', argsHint: '<name>' },
      ],
    });
    const ctx = ctxWith(configWith(cfg));
    (ctx.publisher as unknown as { burstLimit: number }).burstLimit = 5; // unregistered
    expect(await createCommandsModule(depsWith()).preflight!(ctx)).toBeNull();
  });

  it('refuses a costly command at EACH of the three gates', async () => {
    // These assertions fail if the gate loop is removed — the previous version
    // restated the arithmetic locally and passed either way, which is the same
    // vacuous-test shape that let the original bug through.
    //
    // Every built-in costs 1, so the gates are unreachable from config alone;
    // the handler override exists precisely so this guard can be tested.
    const costly = (): Map<string, CommandHandler> =>
      new Map([['pricey', { run: async () => 'x', cost: 4 }]]);
    const base = {
      enabled: true,
      channels: [7],
      commands: [{ name: 'pricey', description: 'expensive' }],
    };

    // Gate 1: per-wallet per minute.
    let failure = await createCommandsModule(depsWith({ handlersOverride: costly })).preflight!(
      ctxWith(configWith(botSchema.parse({ ...base, rateLimit: { perWalletPerMinute: 3 } }))),
    );
    expect(failure!.message).toContain('perWalletPerMinute');

    // Gate 2: the global ceiling — denied SILENTLY at runtime, so nothing at all
    // would be logged, which makes catching it at startup more important.
    failure = await createCommandsModule(depsWith({ handlersOverride: costly })).preflight!(
      ctxWith(
        configWith(
          botSchema.parse({ ...base, rateLimit: { perWalletPerMinute: 10, globalPerMinute: 2 } }),
        ),
      ),
    );
    expect(failure!.message).toContain('globalPerMinute');

    // Gate 3: the DERIVED per-wallet window cap. Registered tier gives
    // capFor(20, 0.5) = 10, then capFor(10, 0.25) = 2 — under a cost of 4.
    failure = await createCommandsModule(depsWith({ handlersOverride: costly })).preflight!(
      ctxWith(configWith(botSchema.parse(base))),
    );
    expect(failure!.message).toContain('per-wallet window cap');
    expect(failure!.message).toContain('/pricey');
  });

  it('names the MOST expensive blocked command, not the first', async () => {
    const many = (): Map<string, CommandHandler> =>
      new Map([
        ['cheapish', { run: async () => 'x', cost: 4 }],
        ['dear', { run: async () => 'x', cost: 9 }],
      ]);
    const failure = await createCommandsModule(depsWith({ handlersOverride: many })).preflight!(
      ctxWith(
        configWith(
          botSchema.parse({
            enabled: true,
            channels: [7],
            commands: [
              { name: 'cheapish', description: 'a' },
              { name: 'dear', description: 'b' },
            ],
            rateLimit: { perWalletPerMinute: 3 },
          }),
        ),
      ),
    );
    // The expensive one sets the limit the operator actually has to clear.
    expect(failure!.message).toContain('/dear');
    expect(failure!.message).toContain('costs 9');
  });

  it('reports an unreachable node as a node problem, not a bad channel id', async () => {
    // A 5xx or a timeout used to be indistinguishable from "no such channel",
    // so a restarting node told the operator to fix channel ids that were
    // perfectly correct — and, under systemd, did it in a restart loop.
    const deps = depsWith({ describeChannel: vi.fn(async () => 'unreachable' as const) });
    const failure = await createCommandsModule(deps).preflight!(ctxWith(configWith(botCfg())));
    expect(failure!.message).toContain('Could not reach the node');
    expect(failure!.message).not.toContain('Check the id');
  });

  it('pins the derived per-wallet window cap, which is what shipped broken', () => {
    // The gate has three limits and the tightest is DERIVED from the node tier,
    // not configured. On an unregistered wallet it floors at 1:
    //
    //   burstCap        = max(1, floor(5 * 0.5))  = 2
    //   perWalletWindow = max(1, floor(2 * 0.25)) = 1
    //
    // `/latest` shipped at cost 2, in config.example.yaml. The preflight
    // validated only `perWalletPerMinute` (10, satisfied), so the default config
    // on the default tier carried a command that could never be answered — and
    // the bot told the user they were going too fast. Every built-in now costs
    // 1, and the preflight checks all three gates, so a future costed handler
    // cannot reintroduce this silently.
    // The SHIPPED helper, not a local copy — a restated formula cannot notice
    // `capFor` changing, which is the drift that caused the bug.
    const cap = (burst: number, share: number, walletShare: number): number =>
      capFor(capFor(burst, share), walletShare);

    expect(cap(5, 0.5, 0.25)).toBe(1); // unregistered — the broken case
    expect(cap(20, 0.5, 0.25)).toBe(2); // registered
    expect(cap(20, 1, 1)).toBe(20); // operator hands it the whole quota
  });


  it('refuses a channel where the wallet cannot post', async () => {
    const deps = depsWith({
      describeChannel: vi.fn(async () => ({ name: 'announce', encrypted: false, canPost: false })),
    });
    const failure = await createCommandsModule(deps).preflight!(ctxWith(configWith(botCfg())));
    expect(failure!.message).toContain('not allowed to post');
  });

  it('passes for a public channel with known commands', async () => {
    const cfg = botCfg({ commands: [{ name: 'about', description: 'who I am' }] });
    expect(
      await createCommandsModule(depsWith()).preflight!(ctxWith(configWith(cfg))),
    ).toBeNull();
  });
});

describe('commands module start', () => {
  it('republishes the descriptor UNCONDITIONALLY, tracking no local state', async () => {
    // Local "last published" state desyncs from what a node actually holds —
    // after a node wipe, on a fresh node, or on a dropped gossip message — and
    // the bot would then believe its commands were advertised while every
    // client saw nothing. The node suppresses its own broadcast when content is
    // unchanged, so republishing costs nothing.
    const publishDescriptor = vi.fn(async (_d: Parameters<CommandsDeps['publishDescriptor']>[0]) => {});
    const deps = depsWith({ publishDescriptor });
    const cfg = botCfg({ commands: [{ name: 'about', description: 'who I am' }] });
    const ctx = ctxWith(configWith(cfg));

    for (let i = 0; i < 3; i += 1) {
      const mod = createCommandsModule(deps);
      await mod.preflight!(ctx);
      await (await mod.start(ctx)).stop();
    }
    expect(publishDescriptor).toHaveBeenCalledTimes(3);
  });

  it('sends argsHint under its WIRE name, not the config name', async () => {
    // Config says `argsHint`, the protocol says `args_hint`. Getting this wrong
    // publishes a descriptor whose hints silently vanish in every client.
    const publishDescriptor = vi.fn(async (_d: Parameters<CommandsDeps['publishDescriptor']>[0]) => {});
    const cfg = botCfg({
      commands: [{ name: 'latest', description: 'recent posts', argsHint: '[1-5]' }],
    });
    const ctx = ctxWith(configWith(cfg));
    const mod = createCommandsModule(depsWith({ publishDescriptor }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    expect(publishDescriptor.mock.calls[0]![0]).toEqual({
      commands: [{ name: 'latest', description: 'recent posts', args_hint: '[1-5]' }],
    });
  });

  it('stop() is safe to call twice', async () => {
    const ctx = ctxWith(configWith(botCfg()));
    const mod = createCommandsModule(depsWith());
    await mod.preflight!(ctx);
    const handle = await mod.start(ctx);
    await handle.stop();
    await expect(handle.stop()).resolves.toBeUndefined();
  });
});

describe('commands module reconfigure', () => {
  it('is a no-op before start() has ever run', async () => {
    const deps = depsWith();
    const mod = createCommandsModule(deps);
    await mod.reconfigure!(ctxWith(configWith(botCfg())));
    expect(deps.subscribeChannels).not.toHaveBeenCalled();
    expect(deps.publishDescriptor).not.toHaveBeenCalled();
  });

  it('re-subscribes to a changed channel list and republishes the descriptor', async () => {
    const closeFns: Array<ReturnType<typeof vi.fn>> = [];
    const subscribeChannels = vi.fn(async (_channels: number[]) => {
      const close = vi.fn();
      closeFns.push(close);
      return close;
    });
    const deps = depsWith({ subscribeChannels });
    const mod = createCommandsModule(deps);
    const ctx1 = ctxWith(configWith(botCfg({ channels: [7] })));
    await mod.preflight!(ctx1);
    await mod.start(ctx1);
    expect(subscribeChannels).toHaveBeenCalledTimes(1);
    expect(subscribeChannels.mock.calls[0]![0]).toEqual([7]);

    const ctx2 = ctxWith(configWith(botCfg({ channels: [7, 9] })));
    await mod.reconfigure!(ctx2);

    // The OLD subscription was actually torn down, not merely superseded —
    // a leak here would mean the bot double-answers on channel 7 forever.
    expect(closeFns[0]).toHaveBeenCalledTimes(1);
    expect(subscribeChannels).toHaveBeenCalledTimes(2);
    expect(subscribeChannels.mock.calls[1]![0]).toEqual([7, 9]);
    expect(deps.publishDescriptor).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid change and keeps the previous configuration running', async () => {
    // REGRESSION GUARD, same shape as B3's imagedirVisionError: bot.channels
    // is now live, so a save that empties it must not be allowed to silently
    // tear down a working subscription — the same precondition preflight()
    // already enforces at startup has to hold here too.
    const deps = depsWith();
    const mod = createCommandsModule(deps);
    const ctx1 = ctxWith(configWith(botCfg({ channels: [7] })));
    await mod.preflight!(ctx1);
    await mod.start(ctx1);
    vi.mocked(deps.publishDescriptor).mockClear();
    vi.mocked(deps.subscribeChannels).mockClear();

    // unsafeBotCfg: simulates the real-world shape reconfigure() actually
    // has to defend against — a directly-mutated ctx.config.bot, which is
    // what commit() produces BEFORE this module's own validation runs
    // (botSchema's own cross-field check can no longer let a legitimate
    // save reach this shape at all, but reconfigure() must still cope with
    // it since it reads whatever ctx.config.bot currently holds).
    const warn = vi.fn();
    const ctx2 = { ...ctxWith(configWith(unsafeBotCfg({ channels: [] }))), warn } as BotContext;
    await mod.reconfigure!(ctx2);

    expect(deps.publishDescriptor).not.toHaveBeenCalled();
    expect(deps.subscribeChannels).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('bot.channels is empty');
  });

  it('drops a second reconfigure that arrives while one is still in flight', async () => {
    const deps = depsWith(); // default describeChannel resolves immediately
    const mod = createCommandsModule(deps);
    const ctx = ctxWith(configWith(botCfg({ channels: [7] })));
    await mod.preflight!(ctx);
    await mod.start(ctx);

    // Swapped in AFTER start()/preflight() complete — both already called
    // describeChannel via the default fixture, and gating it from the start
    // would hang preflight() itself, never reaching the calls under test.
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const describeChannel = vi.fn(async () => {
      await gate;
      return publicChannel;
    });
    Object.assign(deps, { describeChannel });

    const first = mod.reconfigure!(ctx); // blocks inside validateBotConfig on `gate`
    const second = mod.reconfigure!(ctx); // must be dropped, not queued
    await second;
    expect(describeChannel).toHaveBeenCalledTimes(1);

    resolveFirst!();
    await first;
  });

  it('accepts a later reconfigure after an earlier one was rejected', async () => {
    // Proves the reentrancy guard's `finally` actually clears — a rejected
    // call must not permanently wedge every future reconfigure.
    const deps = depsWith();
    const mod = createCommandsModule(deps);
    const ctx = ctxWith(configWith(botCfg({ channels: [7] })));
    await mod.preflight!(ctx);
    await mod.start(ctx);

    await mod.reconfigure!(ctxWith(configWith(unsafeBotCfg({ channels: [] }))));
    vi.mocked(deps.subscribeChannels).mockClear();

    await mod.reconfigure!(ctxWith(configWith(botCfg({ channels: [9] }))));
    expect(deps.subscribeChannels).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.subscribeChannels).mock.calls[0]![0]).toEqual([9]);
  });

  it('does not resurrect the subscription if stop() races an in-flight reconfigure', async () => {
    // REGRESSION GUARD, found by code audit before ship: reconfigure() only
    // checked `running` once, at entry, before its own real awaits
    // (describeChannel/joinChannel/publishDescriptor). A shutdown landing
    // during one of those would call stop() — running=false, subscription
    // closed, module reported stopped — and the stale reconfigure, unaware,
    // would resume and OPEN A NEW subscription: a stopped bot that keeps
    // listening, the same failure class `running` exists to prevent for
    // message handling.
    const deps = depsWith();
    const mod = createCommandsModule(deps);
    const ctx = ctxWith(configWith(botCfg({ channels: [7] })));
    await mod.preflight!(ctx);
    const handle = await mod.start(ctx);
    vi.mocked(deps.subscribeChannels).mockClear();

    let resolveJoin: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolveJoin = r;
    });
    const joinChannel = vi.fn(async () => {
      await gate;
    });
    Object.assign(deps, { joinChannel });

    const reconfigurePromise = mod.reconfigure!(ctx); // blocks inside the join loop
    await handle.stop(); // shutdown races ahead of the still-pending save
    resolveJoin!();
    await reconfigurePromise;

    expect(deps.subscribeChannels).not.toHaveBeenCalled();
  });

  it('a rejected reconfigure does not let handleMessage observe the corrupted live config', async () => {
    // REGRESSION GUARD, CRITICAL finding from security audit. In production,
    // settingsDeps.ts's commit() mutates ctx.config.bot IN PLACE (and
    // persists to disk) BEFORE any ReconfigureHook — including this
    // module's own validateBotConfig() — ever runs. `cfg = botConfig(ctx
    // .config)` is an ALIAS into that same object, not a snapshot: even
    // when reconfigure() correctly rejects an invalid save and leaves
    // handlers/limiter/close untouched, handleMessage's channel gate was
    // reading straight through that alias and would have gone deaf anyway.
    // This test reproduces the REAL ordering — mutate ctx.config.bot in
    // place, THEN call reconfigure() — which is exactly what the earlier
    // "rejects an invalid change" test above does NOT do (it builds a
    // fresh, already-invalid ctx up front), and exactly why that test did
    // not catch this.
    const cfg = botCfg({
      channels: [7],
      commands: [{ name: 'about', description: 'who I am' }],
    });
    const config = configWith(cfg);
    const ctx = ctxWith(config);
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, mod } = await startAndCapture(depsWith({ reply }), ctx);

    // Simulate commit()'s applyConfigInPlace: REASSIGN (not mutate) the
    // shared bot object's `channels` field to a fresh, invalid array — this
    // is what real applyConfigInPlace does for array-typed leaf fields
    // (reference swap, never an in-place element mutation), and it matters
    // here: a shallow-copied snapshot keeps pointing at the OLD array
    // object only if this is a reassignment, not a truncation of that same
    // array.
    (config.bot as BotConfig).channels = [];

    await mod.reconfigure!(ctx);

    deliver(msg('/about', { mentions: ['klv1bot'], channel: 7 }));
    await settle();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('leaves close cleared, not stale, when re-subscribing fails', async () => {
    const deps = depsWith();
    const mod = createCommandsModule(deps);
    const ctx = ctxWith(configWith(botCfg({ channels: [7] })));
    await mod.preflight!(ctx);
    await mod.start(ctx);

    const subscribeChannels = vi.fn(async () => {
      throw new Error('connection refused');
    });
    Object.assign(deps, { subscribeChannels });
    const warn = vi.fn();

    await mod.reconfigure!({ ...ctx, warn } as BotContext);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('could not re-subscribe');
    // A second reconfigure attempt must not throw trying to close a stale
    // reference left over from the failed attempt above.
    Object.assign(deps, { subscribeChannels: vi.fn(async () => () => {}) });
    await expect(mod.reconfigure!(ctx)).resolves.toBeUndefined();
  });
});

describe('commands module auto-join', () => {
  let stateDir: string;
  let statePath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'ogmara-autojoin-'));
    statePath = join(stateDir, 'autojoin.json');
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  function cfgWithAutoJoin(over: Record<string, unknown> = {}): BotConfig {
    return botCfg({
      autoJoin: { statePath },
      commands: [{ name: 'about', description: 'who I am' }],
      ...over,
    });
  }

  it('joins every configured channel on start', async () => {
    const joinChannel = vi.fn(async (_id: number) => {});
    const ctx = ctxWith(configWith(cfgWithAutoJoin({ channels: [7, 12] })));
    const mod = createCommandsModule(depsWith({ joinChannel }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    expect(joinChannel).toHaveBeenCalledWith(7);
    expect(joinChannel).toHaveBeenCalledWith(12);
  });

  it('does NOT join configured channels in dry run', async () => {
    const joinChannel = vi.fn(async (_id: number) => {});
    const ctx = ctxWith(configWith(cfgWithAutoJoin(), true));
    const mod = createCommandsModule(depsWith({ joinChannel }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    expect(joinChannel).not.toHaveBeenCalled();
  });

  it('a join failure for one configured channel does not stop the others or crash start()', async () => {
    const joinChannel = vi.fn(async (id: number) => {
      if (id === 7) throw new Error('node said no');
    });
    const ctx = ctxWith(configWith(cfgWithAutoJoin({ channels: [7, 12] })));
    const mod = createCommandsModule(depsWith({ joinChannel }));
    await mod.preflight!(ctx);
    await expect((await mod.start(ctx)).stop()).resolves.toBeUndefined();

    expect(joinChannel).toHaveBeenCalledWith(12);
  });

  it('joins a channel it was invited to, from a channel_invite notification', async () => {
    const joinChannel = vi.fn(async (_id: number) => {});
    const describeChannel = vi.fn(async (_id: number): Promise<ChannelFacts> => ({
      name: 'Bots & Co.',
      encrypted: false,
      canPost: true,
    }));
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      channel_name: 'Bots & Co.',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const ctx = ctxWith(configWith(cfgWithAutoJoin()));
    const mod = createCommandsModule(depsWith({ joinChannel, describeChannel, getNotifications }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    // Once for the configured channel (7), once for the invite (99).
    expect(joinChannel).toHaveBeenCalledWith(99);
  });

  it('auto-answers an invited PLAINTEXT channel by default — end to end', async () => {
    // answerInvitedChannels defaults to true: inviting the bot should be
    // enough by itself, with no separate operator step, for it to actually
    // become usable in that channel — not just a member.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const { deliver, stop } = await startAndCapture(
      depsWith({ reply, getNotifications }),
      ctxWith(configWith(cfgWithAutoJoin({ channels: [7] }))),
    );
    deliver(msg('/about', { channel: 99, mentions: ['klv1bot'] }));
    await settle();
    expect(reply).toHaveBeenCalledWith(99, expect.any(String), expect.any(Array));
    await stop();
  });

  it('does NOT auto-answer an invited channel when answerInvitedChannels is false', async () => {
    // The opt-out: still joins (membership), never answers.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const joinChannel = vi.fn(async (_id: number) => {});
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const { deliver, stop } = await startAndCapture(
      depsWith({ reply, joinChannel, getNotifications }),
      ctxWith(configWith(cfgWithAutoJoin({ channels: [7], autoJoin: { statePath, answerInvitedChannels: false } }))),
    );
    deliver(msg('/about', { channel: 99, mentions: ['klv1bot'] }));
    await settle();
    expect(joinChannel).toHaveBeenCalledWith(99);
    expect(reply).not.toHaveBeenCalled();
    await stop();
  });

  it('stops auto-answering new invites once maxAutoAnsweredChannels is reached', async () => {
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const notifications: Notification[] = [
      { type: 'channel_invite', channel_id: '98', from: 'klv1a', timestamp: 1000 },
      { type: 'channel_invite', channel_id: '99', from: 'klv1b', timestamp: 2000 },
    ];
    const getNotifications = vi.fn(async (_since?: number) => notifications);
    const { deliver, stop } = await startAndCapture(
      depsWith({ reply, getNotifications }),
      ctxWith(
        configWith(cfgWithAutoJoin({ autoJoin: { statePath, maxAutoAnsweredChannels: 1 } })),
      ),
    );
    deliver(msg('/about', { channel: 98, mentions: ['klv1bot'] }));
    deliver(msg('/about', { channel: 99, mentions: ['klv1bot'] }));
    await settle();
    // The FIRST invite processed gets the one available slot; the second is
    // joined (proven by the earlier "joins every invite" tests) but not
    // answered.
    expect(reply).toHaveBeenCalledWith(98, expect.any(String), expect.any(Array));
    expect(reply).not.toHaveBeenCalledWith(99, expect.any(String), expect.any(Array));
    await stop();
  });

  it('an auto-answer grant survives a restart, without a fresh invite', async () => {
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const ctx = ctxWith(configWith(cfgWithAutoJoin()));

    // First run: earns the grant.
    const first = await startAndCapture(depsWith({ getNotifications }), ctx);
    await first.stop();

    // Second run: NO new invite (getNotifications now returns nothing new),
    // yet the channel must still be answered — the grant is state, not a
    // one-time reaction to seeing the invite.
    const noNewInvites = vi.fn(async (_since?: number) => []);
    const second = await startAndCapture(depsWith({ reply, getNotifications: noNewInvites }), ctx);
    second.deliver(msg('/about', { channel: 99, mentions: ['klv1bot'] }));
    await settle();
    expect(reply).toHaveBeenCalledWith(99, expect.any(String), expect.any(Array));
    await second.stop();
  });

  it('flipping answerInvitedChannels to false stops answering an ALREADY-granted channel on restart', async () => {
    // REGRESSION GUARD. This is the incident-response "turn it off" reflex —
    // it has to actually revoke existing grants on the next restart, not
    // just refuse NEW ones, or the one manual override this design offers
    // during abuse does not work.
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);

    const first = await startAndCapture(
      depsWith({ getNotifications }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );
    await first.stop();

    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const noNewInvites = vi.fn(async (_since?: number) => []);
    const second = await startAndCapture(
      depsWith({ reply, getNotifications: noNewInvites }),
      ctxWith(configWith(cfgWithAutoJoin({ autoJoin: { statePath, answerInvitedChannels: false } }))),
    );
    second.deliver(msg('/about', { channel: 99, mentions: ['klv1bot'] }));
    await settle();
    expect(reply).not.toHaveBeenCalled();
    await second.stop();
  });

  it('re-enabling answerInvitedChannels resumes a previously-earned grant, no fresh invite needed', async () => {
    // The flip side of the test above: turning it back on must not require
    // re-inviting from scratch — the persisted grant is preserved even
    // while paused, only the LIVE set is emptied while the flag is off.
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const noNewInvites = vi.fn(async (_since?: number) => []);

    const first = await startAndCapture(
      depsWith({ getNotifications }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );
    await first.stop();
    const paused = await startAndCapture(
      depsWith({ getNotifications: noNewInvites }),
      ctxWith(configWith(cfgWithAutoJoin({ autoJoin: { statePath, answerInvitedChannels: false } }))),
    );
    await paused.stop();

    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const resumed = await startAndCapture(
      depsWith({ reply, getNotifications: noNewInvites }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );
    resumed.deliver(msg('/about', { channel: 99, mentions: ['klv1bot'] }));
    await settle();
    expect(reply).toHaveBeenCalledWith(99, expect.any(String), expect.any(Array));
    await resumed.stop();
  });

  it('lowering maxAutoAnsweredChannels on restart trims the live set down to the new cap', async () => {
    // REGRESSION GUARD. Without this, an operator lowering the cap after
    // several channels were already granted would see NO effect at all
    // until every one of those channels happened to churn — the cap would
    // bound future growth only, never the actual live total.
    const notifications: Notification[] = [
      { type: 'channel_invite', channel_id: '10', from: 'klv1a', timestamp: 1000 },
      { type: 'channel_invite', channel_id: '20', from: 'klv1b', timestamp: 2000 },
      { type: 'channel_invite', channel_id: '30', from: 'klv1c', timestamp: 3000 },
    ];
    const getNotifications = vi.fn(async (_since?: number) => notifications);
    const first = await startAndCapture(
      depsWith({ getNotifications }),
      ctxWith(configWith(cfgWithAutoJoin({ autoJoin: { statePath, maxAutoAnsweredChannels: 10 } }))),
    );
    await first.stop();

    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const noNewInvites = vi.fn(async (_since?: number) => []);
    const second = await startAndCapture(
      depsWith({ reply, getNotifications: noNewInvites }),
      ctxWith(configWith(cfgWithAutoJoin({ autoJoin: { statePath, maxAutoAnsweredChannels: 1 } }))),
    );
    second.deliver(msg('/about', { channel: 10, mentions: ['klv1bot'] }));
    second.deliver(msg('/about', { channel: 20, mentions: ['klv1bot'] }));
    second.deliver(msg('/about', { channel: 30, mentions: ['klv1bot'] }));
    await settle();
    // Exactly one of the three restored grants survives the trim — which
    // one is an implementation detail (array order), the COUNT is the point.
    expect(reply).toHaveBeenCalledTimes(1);
    await second.stop();
  });

  it('removes a channel from the auto-answer set once it is no longer visible — freeing the slot', async () => {
    // REGRESSION GUARD (security-audit finding). Without this, a cheap
    // throwaway channel — invite the bot, then delete the channel or get it
    // kicked/banned — permanently occupies one of the limited auto-answer
    // slots forever, since nothing else ever frees one. An attacker could
    // exhaust every slot this way for the cost of maxAutoAnsweredChannels
    // disposable channels, denying the feature to every legitimate future
    // inviter.
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const first = await startAndCapture(depsWith({ getNotifications }), ctxWith(configWith(cfgWithAutoJoin())));
    await first.stop();

    // Second run: the channel has since become invisible (deleted, or this
    // wallet's membership/visibility was lost) — describeChannel now
    // returns null for it. No new invites this poll.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const describeChannel = vi.fn(async (id: number): Promise<ChannelFacts | null> =>
      id === 99 ? null : publicChannel,
    );
    const noNewInvites = vi.fn(async (_since?: number) => []);
    const second = await startAndCapture(
      depsWith({ reply, describeChannel, getNotifications: noNewInvites }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );
    second.deliver(msg('/about', { channel: 99, mentions: ['klv1bot'] }));
    await settle();
    expect(reply).not.toHaveBeenCalled();

    // The freed slot must be PERSISTED too, or a further restart would
    // restore the stale, now-invalid grant right back from the state file.
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.answerChannelIds).not.toContain(99);
    await second.stop();
  });

  it('keeps the auto-answer grant when a channel transitions to encrypted, rather than revoking on sight', async () => {
    // REGRESSION GUARD (spec-compliance finding, 2026-09-15): 0.27.0-era
    // behavior revoked a grant the instant a channel's metadata turned
    // encrypted, because that build could never decrypt anything there,
    // ever. This build can, once a member's client serves it a key — so the
    // transition alone must not cost the slot; the channel is treated like
    // any other that hasn't yet proven it can decrypt (see
    // `maxUnservedEncryptedHours`), not revoked on sight.
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const first = await startAndCapture(depsWith({ getNotifications }), ctxWith(configWith(cfgWithAutoJoin())));
    await first.stop();

    const describeChannel = vi.fn(async (id: number): Promise<ChannelFacts> =>
      id === 99 ? { name: 'now secret', encrypted: true, canPost: true } : publicChannel,
    );
    const noNewInvites = vi.fn(async (_since?: number) => []);
    const second = await startAndCapture(
      depsWith({ describeChannel, getNotifications: noNewInvites }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );
    await settle();

    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.answerChannelIds).toContain(99);
    await second.stop();
  });

  it('reaps a slot whose channel never decrypts, even though its OWN metadata still says unencrypted', async () => {
    // REGRESSION GUARD (security-audit finding, 2026-09-15). A channel's
    // metadata declaring itself unencrypted is NOT proof its traffic is
    // readable — a Public/ReadPublic channel legitimately stays
    // `encrypted: false` forever while every message it carries fabricated
    // enc_content/enc_nonce/key_epoch fields that never decrypt (no real
    // key was ever wrapped for it). The two existing checks above (gone /
    // now-genuinely-encrypted) never fire for this case, so without this
    // check a cheap, permanently-empty channel could squat a slot forever
    // for the price of one invite.
    const encryptedPayload = Array.from(
      encode({
        content: '',
        mentions: ['klv1bot'],
        enc_content: new Uint8Array([1, 2, 3]),
        enc_nonce: new Uint8Array(24).fill(9),
        key_epoch: 1,
      }),
    );
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const decryptChannelText = vi.fn<CommandsDeps['decryptChannelText']>(async () => 'waiting');
    const first = await startAndCapture(
      depsWith({ getNotifications, decryptChannelText }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );
    first.deliver({ ...msg('', { channel: 99, mentions: ['klv1bot'] }), payload: encryptedPayload } as Envelope);
    await settle();
    await first.stop();

    // The channel has sat unserved for well past the (default 24h) grace
    // period — simulated by backdating the recorded first-unserved
    // timestamp directly in the state file, rather than needing fake timers.
    const midState = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(midState.encryptedSince).toHaveProperty('99'); // sanity: tracking actually started
    saveAutoJoinState(statePath, {
      lastHandledTs: midState.lastHandledTs,
      answerChannelIds: midState.answerChannelIds,
      encryptedSince: { 99: Date.now() - 25 * 3_600_000 },
    });

    // Second run: metadata STILL says unencrypted (the attack's whole
    // point), and it never decrypts anything this run either.
    const reply = vi.fn(async () => {});
    const noNewInvites = vi.fn(async (_since?: number) => []);
    const second = await startAndCapture(
      depsWith({ reply, getNotifications: noNewInvites, decryptChannelText }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );
    second.deliver({ ...msg('', { channel: 99, mentions: ['klv1bot'] }), payload: encryptedPayload } as Envelope);
    await settle();

    expect(reply).not.toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.answerChannelIds).not.toContain(99); // the slot was freed
    await second.stop();
  });

  it('does NOT free a slot for a merely UNREACHABLE channel — a node hiccup must not cost the grant', async () => {
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const first = await startAndCapture(depsWith({ getNotifications }), ctxWith(configWith(cfgWithAutoJoin())));
    await first.stop();

    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const describeChannel = vi.fn(async (id: number): Promise<ChannelFacts | 'unreachable'> =>
      id === 99 ? 'unreachable' : publicChannel,
    );
    const noNewInvites = vi.fn(async (_since?: number) => []);
    const second = await startAndCapture(
      depsWith({ reply, describeChannel, getNotifications: noNewInvites }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );
    second.deliver(msg('/about', { channel: 99, mentions: ['klv1bot'] }));
    await settle();
    // Still answered — the grant is a live JS Set check independent of this
    // poll's describeChannel outcome; only a REMOVED grant would block it.
    expect(reply).toHaveBeenCalledWith(99, expect.any(String), expect.any(Array));
    await second.stop();
  });

  it('an invite to a channel already in bot.channels is a pure no-op — no cap slot spent', async () => {
    const joinChannel = vi.fn(async (_id: number) => {});
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '7', // already in bot.channels via cfgWithAutoJoin's default
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const ctx = ctxWith(configWith(cfgWithAutoJoin({ autoJoin: { statePath, maxAutoAnsweredChannels: 0 } })));
    const mod = createCommandsModule(depsWith({ joinChannel, getNotifications }));
    await mod.preflight!(ctx);
    // maxAutoAnsweredChannels: 0 would normally refuse a NEW grant and warn
    // — if channel 7 were processed as an invite at all, start() would log
    // that warning even though 7 already answers unconditionally. Proven
    // indirectly here via joinChannel: the static loop in start() already
    // joins every cfg.channels entry once, so a SECOND call for the same id
    // from the invite path would be the tell that it was processed twice.
    await (await mod.start(ctx)).stop();
    expect(joinChannel).toHaveBeenCalledTimes(1);
  });

  it('JOINS an invite to an ENCRYPTED channel', async () => {
    // A private channel is currently the ONLY channel type the client UI can
    // even invite to, so refusing to join an encrypted invite would make
    // invite-driven auto-join a no-op in every real-world case that exists
    // today. There is no confirmation step on this wallet's side anywhere in
    // the pipeline (an explicit design choice — the bot owner never approves
    // invites one by one).
    const joinChannel = vi.fn(async (_id: number) => {});
    const describeChannel = vi.fn(async (id: number): Promise<ChannelFacts> =>
      id === 99 ? { name: 'Secret', encrypted: true, canPost: true } : publicChannel,
    );
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const ctx = ctxWith(configWith(cfgWithAutoJoin()));
    const mod = createCommandsModule(depsWith({ joinChannel, describeChannel, getNotifications }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    expect(joinChannel).toHaveBeenCalledWith(99);
  });

  it('ALSO grants an encrypted invited channel an answer slot, same as a plaintext one', async () => {
    // REGRESSION GUARD (spec-compliance finding, 2026-09-15): this build can
    // now decrypt/reply once a member's client serves it a key
    // (channelKeys.ts), so an encrypted invite must be granted an answer
    // slot exactly like a plaintext one, subject to the same cap — treating
    // it as membership-only forever (the 0.27.0-era behavior) would make
    // this feature permanently unreachable through the invite path, since
    // new Public/ReadPublic/Private channels are all created encrypted by
    // default (spec §3.6).
    const describeChannel = vi.fn(async (id: number): Promise<ChannelFacts> =>
      id === 99 ? { name: 'Secret', encrypted: true, canPost: true } : publicChannel,
    );
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const ctx = ctxWith(configWith(cfgWithAutoJoin({ channels: [7] })));
    const mod = createCommandsModule(depsWith({ describeChannel, getNotifications }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.answerChannelIds).toContain(99);
  });

  it('never expands the WebSocket subscription list with an auto-answered channel', async () => {
    // `subscribeChannels` takes only the statically-configured `cfg.channels`
    // — an invite-granted channel joins `autoAnsweredChannels` (a live JS-side
    // set `handleMessage` checks directly) rather than causing a
    // re-subscription, since the node broadcasts every public-channel
    // message to every connected client regardless of what it subscribed to.
    const subscribeChannels = vi.fn(async (_channels: number[]) => () => {});
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const ctx = ctxWith(configWith(cfgWithAutoJoin({ channels: [7] })));
    const mod = createCommandsModule(depsWith({ subscribeChannels, getNotifications }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    expect(subscribeChannels).toHaveBeenCalledWith([7], expect.any(Function));
  });

  it('does NOT join an invited channel in dry run either', async () => {
    const joinChannel = vi.fn(async (_id: number) => {});
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const ctx = ctxWith(configWith(cfgWithAutoJoin(), true));
    const mod = createCommandsModule(depsWith({ joinChannel, getNotifications }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    expect(joinChannel).not.toHaveBeenCalled();
  });

  it('persists the cursor so a later start does not re-fetch the same notification', async () => {
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 5000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const ctx = ctxWith(configWith(cfgWithAutoJoin()));
    const mod = createCommandsModule(depsWith({ getNotifications }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.lastHandledTs).toBe(5000);

    // A second start must pass the persisted cursor, not start over from 0.
    const mod2 = createCommandsModule(depsWith({ getNotifications }));
    await mod2.preflight!(ctx);
    await (await mod2.start(ctx)).stop();
    expect(getNotifications).toHaveBeenLastCalledWith(5000, 200, 'channel_invite');
  });

  it('an unreachable node while checking an invited channel does not crash start()', async () => {
    const describeChannel = vi.fn(async (_id: number) => 'unreachable' as const);
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const ctx = ctxWith(configWith(cfgWithAutoJoin()));
    const mod = createCommandsModule(depsWith({ describeChannel, getNotifications }));
    await mod.preflight!(ctx);
    await expect((await mod.start(ctx)).stop()).resolves.toBeUndefined();
  });

  it('requests the channel_invite TYPE explicitly, not just the raw feed', async () => {
    // REGRESSION GUARD. An untyped page mixes every notification type
    // together, and a mention fires on every command invocation — for a
    // busy bot that crowds channel_invite out of the page long before this
    // wallet would ever see it. The type filter is what makes l2-node widen
    // its own scan instead of the caller's page size.
    const getNotifications = vi.fn(async (_since?: number) => []);
    const ctx = ctxWith(configWith(cfgWithAutoJoin()));
    const mod = createCommandsModule(depsWith({ getNotifications }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();
    expect(getNotifications).toHaveBeenCalledWith(0, 200, 'channel_invite');
  });

  it('logs a summary EVERY poll, including when nothing was found', async () => {
    // REGRESSION GUARD. Without this, "the poller ran and found nothing new"
    // is indistinguishable from "the poller never ran," "it crashed
    // silently," or "the invite never reached the node" — the operator's
    // log alone can't tell those apart, which is exactly what made a live
    // reported "the bot doesn't seem to join" impossible to diagnose.
    const log = vi.fn();
    const ctx = { ...ctxWith(configWith(cfgWithAutoJoin())), log } as unknown as BotContext;
    const getNotifications = vi.fn(async (_since?: number) => []);
    const mod = createCommandsModule(depsWith({ getNotifications }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    const summary = log.mock.calls.map((c) => String(c[0])).find((m) => m.includes('checked for channel invites'));
    expect(summary).toBeDefined();
    expect(summary).toContain('0 notification(s)');
    expect(summary).toContain('0 invite(s)');
  });

  it('strips control characters from an attacker-chosen inviter address before logging it', async () => {
    // REGRESSION GUARD. `invite.invitedBy`/the channel name both come from
    // another wallet's ChannelInvite payload — untrusted the same way reply
    // text is, which is why `forLog` exists and is already applied to reply
    // text and error strings elsewhere in this file. This closes the one
    // place that skipped it.
    const warn = vi.fn();
    const ctx = { ...ctxWith(configWith(cfgWithAutoJoin())), warn } as unknown as BotContext;
    const describeChannel = vi.fn(async (_id: number) => null); // "cannot see it" branch
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner\x1b[31mFAKE ERROR\x1b[0m',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const mod = createCommandsModule(depsWith({ describeChannel, getNotifications }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    const loggedInvitedBy = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('klv1owner'));
    expect(loggedInvitedBy).toBeDefined();
    // eslint-disable-next-line no-control-regex
    expect(loggedInvitedBy).not.toMatch(/\x1b/);
  });

  it('strips control characters from anchor_node before logging it in dry run', async () => {
    // REGRESSION GUARD (code-audit finding, 2026-09-15). anchor_node comes
    // from the SAME untrusted, other-wallet-controlled payload as
    // invitedBy/channel_name — the dry-run federate log line was the one
    // place that logged it without forLog first.
    const log = vi.fn();
    const ctx = { ...ctxWith(configWith(cfgWithAutoJoin(), true)), log } as unknown as BotContext;
    const describeChannel = vi.fn(async (_id: number) => null);
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
      anchor_node: 'https://host.example\x1b[31mFAKE\x1b[0m',
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const mod = createCommandsModule(depsWith({ describeChannel, getNotifications }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    const loggedFederate = log.mock.calls.map((c) => String(c[0])).find((m) => m.includes('federate'));
    expect(loggedFederate).toBeDefined();
    // eslint-disable-next-line no-control-regex
    expect(loggedFederate).not.toMatch(/\x1b/);
  });

  it('one invite whose describeChannel call throws does not abort the rest of the page', async () => {
    // Not reachable through the real wiring today (every real
    // describeChannel resolves rather than rejects), but the contract isn't
    // enforced by the type — this pins that a rejection is isolated per
    // invite, not left to abort the loop (and with it, saving the cursor).
    const joinChannel = vi.fn(async (_id: number) => {});
    const describeChannel = vi.fn(async (id: number) => {
      if (id === 98) throw new Error('boom');
      return publicChannel;
    });
    const notifications: Notification[] = [
      { type: 'channel_invite', channel_id: '98', from: 'klv1a', timestamp: 1000 },
      { type: 'channel_invite', channel_id: '99', from: 'klv1b', timestamp: 2000 },
    ];
    const getNotifications = vi.fn(async (_since?: number) => notifications);
    const ctx = ctxWith(configWith(cfgWithAutoJoin()));
    const mod = createCommandsModule(depsWith({ joinChannel, describeChannel, getNotifications }));
    await mod.preflight!(ctx);
    await expect((await mod.start(ctx)).stop()).resolves.toBeUndefined();

    expect(joinChannel).toHaveBeenCalledWith(99);
    // The cursor must still advance — a mid-page failure must not make the
    // NEXT poll re-fetch (and re-attempt) the whole page from scratch.
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.lastHandledTs).toBe(2000);
  });

  it('federates a channel from anchor_node before joining when this wallet\'s node has never heard of it', async () => {
    // Cross-node private-channel invite fix (2026-09-15): a brand-new
    // private channel only exists on its host node until some node
    // federates (replicates) it — describeChannel returning null for an
    // invited channel means THIS wallet's own node has never heard of it,
    // not that the channel doesn't exist. anchor_node names the host;
    // federate from there, then the channel becomes locally known and the
    // invite proceeds exactly like the already-working case.
    let federated = false;
    const federateChannel = vi.fn(async (_id: number, _hostUrl: string) => {
      federated = true;
    });
    const describeChannel = vi.fn(async (id: number) => {
      if (id === 99 && !federated) return null;
      return publicChannel;
    });
    const joinChannel = vi.fn(async (_id: number) => {});
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
      anchor_node: 'https://host.example',
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const ctx = ctxWith(configWith(cfgWithAutoJoin()));
    const mod = createCommandsModule(
      depsWith({ federateChannel, describeChannel, joinChannel, getNotifications }),
    );
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    expect(federateChannel).toHaveBeenCalledWith(99, 'https://host.example');
    expect(joinChannel).toHaveBeenCalledWith(99);
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.answerChannelIds).toContain(99);
  });

  it('does NOT attempt to federate when the invite carries no anchor_node', async () => {
    // Older node, or the inviter's own node URL wasn't a public https
    // address — falls back to today's "cannot see it" outcome, unchanged.
    const federateChannel = vi.fn(async (_id: number, _hostUrl: string) => {});
    const describeChannel = vi.fn(async (id: number) => (id === 99 ? null : publicChannel));
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const ctx = ctxWith(configWith(cfgWithAutoJoin()));
    const mod = createCommandsModule(depsWith({ federateChannel, describeChannel, getNotifications }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    expect(federateChannel).not.toHaveBeenCalled();
  });

  it('does not crash on a channel_name: null invite — the real live bug, 2026-09-15', async () => {
    // REGRESSION GUARD. l2-node's notification JSON serializes an absent
    // channel display name as JSON `null` (a spliced-in `Option<String>`),
    // never an omitted key — and that's the NORMAL case for exactly the
    // scenario this whole feature exists for: a brand-new channel this
    // bot's own node has no local record for yet, so no name to look up.
    // `channel_name: null` reached `forLog()` and threw ("Cannot read
    // properties of null (reading 'split')"), silently killing the poll
    // before it ever federated or joined — live symptom was "checked for
    // channel invites — 1 notification(s), 1 invite(s)" and then nothing.
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '397276220293295',
      channel_name: null,
      from: 'klv1owner',
      timestamp: 1000,
      anchor_node: 'https://host.example',
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const federateChannel = vi.fn(async (_id: number, _hostUrl: string) => {});
    const describeChannel = vi.fn(async (id: number) =>
      id === 397276220293295 ? null : publicChannel,
    );
    const ctx = ctxWith(configWith(cfgWithAutoJoin()));
    const mod = createCommandsModule(
      depsWith({ getNotifications, federateChannel, describeChannel }),
    );
    await mod.preflight!(ctx);
    await expect((await mod.start(ctx)).stop()).resolves.toBeUndefined();

    expect(federateChannel).toHaveBeenCalledWith(397276220293295, 'https://host.example');
  });

  it('skips an invite whose federate attempt fails, without aborting the rest of the poll', async () => {
    const federateChannel = vi.fn(async (_id: number, _hostUrl: string) => {
      throw new Error('host unreachable');
    });
    const joinChannel = vi.fn(async (_id: number) => {});
    const describeChannel = vi.fn(async (id: number) => (id === 99 ? null : publicChannel));
    const notifications: Notification[] = [
      { type: 'channel_invite', channel_id: '99', from: 'klv1a', timestamp: 1000, anchor_node: 'https://host.example' },
      { type: 'channel_invite', channel_id: '7', from: 'klv1b', timestamp: 2000 },
    ];
    const getNotifications = vi.fn(async (_since?: number) => notifications);
    const ctx = ctxWith(configWith(cfgWithAutoJoin()));
    const mod = createCommandsModule(
      depsWith({ federateChannel, describeChannel, joinChannel, getNotifications }),
    );
    await mod.preflight!(ctx);
    await expect((await mod.start(ctx)).stop()).resolves.toBeUndefined();

    expect(joinChannel).toHaveBeenCalledWith(7);
    expect(joinChannel).not.toHaveBeenCalledWith(99);
    // The cursor must still advance past the failed one.
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.lastHandledTs).toBe(2000);
  });

  it('does NOT federate in dry run — nothing reaches the network', async () => {
    const federateChannel = vi.fn(async (_id: number, _hostUrl: string) => {});
    const describeChannel = vi.fn(async (id: number) => (id === 99 ? null : publicChannel));
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
      anchor_node: 'https://host.example',
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const ctx = ctxWith(configWith(cfgWithAutoJoin(), true));
    const mod = createCommandsModule(depsWith({ federateChannel, describeChannel, getNotifications }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();

    expect(federateChannel).not.toHaveBeenCalled();
  });

  /** Build a real encrypted-message wire payload, as `buildEncryptedChannelMessage` would. */
  function encryptedPayload(mentions: string[]): number[] {
    return Array.from(
      encode({
        content: '',
        mentions,
        enc_content: new Uint8Array([1, 2, 3]),
        enc_nonce: new Uint8Array(24).fill(9),
        key_epoch: 1,
      }),
    );
  }

  it('keeps the auto-answer grant and does not reply while still waiting for a channel key', async () => {
    // Real channel-key handling (2026-09-15) replaced the 0.27.0 stop-gap,
    // which revoked the grant on the FIRST encrypted message because that
    // build could never decrypt anything, ever. A build that CAN decrypt
    // must instead keep the grant and keep retrying — the only reason to
    // still be unable to read a message is that no other member's client
    // has yet wrapped the current epoch key to this device (spec §8.1.1),
    // which resolves itself once one comes online.
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const decryptChannelText = vi.fn<CommandsDeps['decryptChannelText']>(async () => 'waiting');
    const reply = vi.fn(async () => {});
    const { deliver, stop } = await startAndCapture(
      depsWith({ getNotifications, decryptChannelText, reply }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );

    const encryptedMsg = msg('', { channel: 99, mentions: ['klv1bot'] });
    deliver({ ...encryptedMsg, payload: encryptedPayload(['klv1bot']) } as Envelope);
    await settle();

    expect(decryptChannelText).toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.answerChannelIds).toContain(99);

    // Not just "the persisted file still says 99" — the IN-MEMORY grant must
    // still be live too, or this channel's traffic would be silently dropped
    // by the `cfg.channels`/`autoAnsweredChannels` gate on every later
    // message even though nothing ever rewrote the file. Prove it by
    // delivering a second message, now with a key available, and checking it
    // actually gets answered.
    decryptChannelText.mockResolvedValueOnce({ text: '/about' });
    deliver({
      ...msg('', { channel: 99, mentions: ['klv1bot'] }),
      payload: encryptedPayload(['klv1bot']),
    } as Envelope);
    await settle();
    expect(reply).toHaveBeenCalled();

    await stop();
  });

  it('keeps the auto-answer grant when a message fails to decrypt with the key this bot has', async () => {
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const decryptChannelText = vi.fn(async () => 'error' as const);
    const reply = vi.fn(async () => {});
    const { deliver, stop } = await startAndCapture(
      depsWith({ getNotifications, decryptChannelText, reply }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );

    const encryptedMsg = msg('', { channel: 99, mentions: ['klv1bot'] });
    deliver({ ...encryptedMsg, payload: encryptedPayload(['klv1bot']) } as Envelope);
    await settle();

    expect(reply).not.toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.answerChannelIds).toContain(99);
    await stop();
  });

  it('starts the unserved-encrypted clock even when decryptChannelText REJECTS outright', async () => {
    // REGRESSION GUARD (re-audit finding, 2026-09-15). `decryptChannelText`'s
    // real implementation rethrows anything it can't recognize as a clean
    // 404 (a transient node 5xx, a network timeout) rather than resolving
    // 'error' — and `key_epoch` on an incoming message is fully attacker-
    // controlled, so a crafted value that makes the node answer with
    // something other than a 404 would otherwise dodge `markUnservedEncrypted`
    // and let the channel squat its slot forever, exactly the hole
    // `maxUnservedEncryptedHours` exists to close. A rejection MUST be
    // treated the same as an 'error' outcome, not silently swallowed.
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const decryptChannelText = vi.fn<CommandsDeps['decryptChannelText']>(async () => {
      throw new Error('API error (500): node hiccup');
    });
    const reply = vi.fn(async () => {});
    const { deliver, stop } = await startAndCapture(
      depsWith({ getNotifications, decryptChannelText, reply }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );

    const encryptedMsg = msg('', { channel: 99, mentions: ['klv1bot'] });
    deliver({ ...encryptedMsg, payload: encryptedPayload(['klv1bot']) } as Envelope);
    await settle();

    expect(reply).not.toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.answerChannelIds).toContain(99); // still a member/grant, just tracked as unserved
    expect(saved.encryptedSince).toHaveProperty('99'); // the reap clock DID start
    await stop();
  });

  it('starts the unserved-encrypted clock for a malformed encrypted message too', async () => {
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const { deliver, stop } = await startAndCapture(
      depsWith({ getNotifications }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );

    // enc_content present (genuinely `encrypted`) but enc_nonce is the wrong
    // length — decodeChatPayload yields encNonce: null, which handleMessage
    // must treat as unserved rather than silently ignoring.
    const malformed = Array.from(
      encode({
        content: '',
        mentions: ['klv1bot'],
        enc_content: new Uint8Array([1, 2, 3]),
        enc_nonce: new Uint8Array(10), // wrong length — not 24 bytes
        key_epoch: 1,
      }),
    );
    deliver({ ...msg('', { channel: 99, mentions: ['klv1bot'] }), payload: malformed } as Envelope);
    await settle();

    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.encryptedSince).toHaveProperty('99');
    await stop();
  });

  it('answers a command decrypted out of a genuinely encrypted channel', async () => {
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const decryptChannelText = vi.fn(async () => ({ text: '/about' }));
    const reply = vi.fn(async () => {});
    const { deliver, stop } = await startAndCapture(
      depsWith({
        getNotifications,
        decryptChannelText,
        reply,
        handlersOverride: () =>
          new Map([['about', { cost: 1, run: async () => 'hi' }]]),
      }),
      ctxWith(configWith(cfgWithAutoJoin({ commands: [{ name: 'about', description: 'who I am' }] }))),
    );

    // The decoded content is irrelevant here — `decryptChannelText` is mocked
    // to return the real command text regardless of ciphertext — only the
    // envelope shape (genuinely `encrypted`) matters for reaching that call.
    const encryptedMsg = msg('', { channel: 99, mentions: ['klv1bot'] });
    deliver({ ...encryptedMsg, payload: encryptedPayload(['klv1bot']) } as Envelope);
    await settle();

    expect(decryptChannelText).toHaveBeenCalledWith(99, expect.any(Uint8Array), expect.any(Uint8Array), 1);
    expect(reply).toHaveBeenCalledWith(99, 'hi', ['klv1user']);
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.answerChannelIds).toContain(99); // never revoked
    await stop();
  });

  it('answers in a channel correctly flagged encrypted by its own metadata — the real-world case', async () => {
    // REGRESSION GUARD (spec-compliance finding, 2026-09-15): every other
    // decrypt/reply test in this file uses `describeChannel` returning
    // `encrypted: false` (the metadata-mismatch case `maxUnservedEncryptedHours`
    // guards against), which meant NONE of them actually exercised the real-
    // world path — a channel truthfully reporting `encrypted: true` — because
    // the preflight/invite-loop/revalidation gates removed in this same
    // change used to make that path unreachable outright. This is the one
    // that proves the feature works for the case it was built for.
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const describeChannel = vi.fn(async (id: number): Promise<ChannelFacts> =>
      id === 99 ? { name: 'Secret', encrypted: true, canPost: true } : publicChannel,
    );
    const decryptChannelText = vi.fn(async () => ({ text: '/about' }));
    const reply = vi.fn(async () => {});
    const { deliver, stop } = await startAndCapture(
      depsWith({
        getNotifications,
        describeChannel,
        decryptChannelText,
        reply,
        handlersOverride: () => new Map([['about', { cost: 1, run: async () => 'hi' }]]),
      }),
      ctxWith(configWith(cfgWithAutoJoin({ commands: [{ name: 'about', description: 'who I am' }] }))),
    );

    const encryptedMsg = msg('', { channel: 99, mentions: ['klv1bot'] });
    deliver({ ...encryptedMsg, payload: encryptedPayload(['klv1bot']) } as Envelope);
    await settle();

    expect(reply).toHaveBeenCalledWith(99, 'hi', ['klv1user']);
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.answerChannelIds).toContain(99);
    await stop();
  });

  it('does NOT revoke anything for an ordinary empty/blank message — only a genuinely encrypted one', async () => {
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const notification: Notification = {
      type: 'channel_invite',
      channel_id: '99',
      from: 'klv1owner',
      timestamp: 1000,
    };
    const getNotifications = vi.fn(async (_since?: number) => [notification]);
    const { deliver, stop } = await startAndCapture(
      depsWith({ reply, getNotifications }),
      ctxWith(configWith(cfgWithAutoJoin())),
    );

    deliver(msg('just chatting, not a command', { channel: 99, mentions: [] }));
    await settle();
    // Still granted — a blank/off-topic message is normal traffic, not
    // evidence of encryption.
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.answerChannelIds).toContain(99);

    // And it still answers a real command afterward.
    deliver(msg('/about', { channel: 99, mentions: ['klv1bot'] }));
    await settle();
    expect(reply).toHaveBeenCalledWith(99, expect.any(String), expect.any(Array));
    await stop();
  });
});

describe('commands module message handling', () => {
  const cfg = botCfg({
    commands: [
      { name: 'about', description: 'who I am' },
      { name: 'topic', description: 'do I cover this', argsHint: '<name>' },
    ],
  });

  it('answers an addressed command', async () => {
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(configWith(cfg)));
    deliver(msg('/about', { mentions: ['klv1bot'] }));
    await settle();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![1]).toContain('ogmara-bot');
    await stop();
  });

  it('never answers its OWN messages', async () => {
    // Without this a reply that itself begins with "/" loops forever, with the
    // bot spending its own wallet quota on every iteration.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(configWith(cfg)));
    deliver(msg('/about', { from: 'klv1bot', mentions: ['klv1bot'] }));
    await settle();
    expect(reply).not.toHaveBeenCalled();
    await stop();
  });

  it('stays SILENT on a command it does not implement', async () => {
    // A bare `/foo` with no handle and no mentions is "addressed" for EVERY bot
    // in the channel — none can tell it was meant for another — so replying
    // "unknown command" makes a three-bot channel answer every typo three times.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(configWith(cfg)));
    deliver(msg('/nosuchthing', { mentions: ['klv1bot'] }));
    await settle();
    expect(reply).not.toHaveBeenCalled();
    await stop();
  });

  it('ignores ordinary chat', async () => {
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(configWith(cfg)));
    deliver(msg('just talking about /about really'));
    await settle();
    expect(reply).not.toHaveBeenCalled();
    await stop();
  });

  it('ignores a channel it was never configured for', async () => {
    // Second lock behind the scoped subscription: a shared socket or a
    // reconnect re-subscribing from stale state would otherwise have the bot
    // answering — and spending quota — somewhere the operator never listed.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(configWith(cfg)));
    deliver(msg('/about', { channel: 999, mentions: ['klv1bot'] }));
    await settle();
    expect(reply).not.toHaveBeenCalled();
    await stop();
  });

  it('preserves argument CASE', async () => {
    // The SDK lowercases the command token only, never the arguments —
    // lowercasing a ticker or a topic sends the bot looking up a different
    // thing. `/topic Klever` must reach the handler as "Klever".
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const config = configWith(
      botSchema.parse({
        enabled: true,
        channels: [7],
        commands: [{ name: 'topic', description: 'do I cover this' }],
      }),
    );
    (config as unknown as { sources: { topics: { enabled: boolean; topics: string[] } } }).sources.topics = {
      enabled: true,
      topics: ['Klever'],
    };
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(config));
    deliver(msg('/topic Klever', { mentions: ['klv1bot'] }));
    await settle();
    expect(reply.mock.calls[0]![1]).toContain('"Klever"');
    await stop();
  });

  it('does not reply after stop(), even for a message already dispatched', async () => {
    // Closing the socket does not un-dispatch a message already handed to the
    // callback, and handling is async. Without the guard a module that has been
    // stopped still spends the wallet's quota after shutdown was reported.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(configWith(cfg)));
    deliver(msg('/about', { mentions: ['klv1bot'] }));
    await stop();
    await settle();
    expect(reply).not.toHaveBeenCalled();
  });

  it('ignores an EDIT of a message, even one whose text is a command', async () => {
    // The node broadcasts edits, reactions and deletes under the same frame
    // type, and an edit payload carries the full replacement text. Without a
    // type check, a user can edit one message in a loop and draw a fresh reply —
    // and a fresh quota slot — every time.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(configWith(cfg)));
    deliver(msg('/about', { mentions: ['klv1bot'], msgType: MessageType.ChatEdit }));
    await settle();
    expect(reply).not.toHaveBeenCalled();
    await stop();
  });

  it('accepts the msg_type the WebSocket actually sends (the variant NAME)', async () => {
    // The envelope type says `msg_type: number`, but the node serialises the
    // Rust enum as its name. A numeric-only check passes every hand-built
    // fixture and rejects every live frame.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(configWith(cfg)));
    deliver(msg('/about', { mentions: ['klv1bot'], msgType: 'ChatMessage' }));
    await settle();
    expect(reply).toHaveBeenCalledTimes(1);
    await stop();
  });

  it('answers a re-delivered message only once', async () => {
    // A reconnect replays, and the same frame reaches every connection.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(configWith(cfg)));
    for (let i = 0; i < 4; i += 1) {
      deliver(msg('/about', { mentions: ['klv1bot'], msgId: 'same-id' }));
      await settle();
    }
    expect(reply).toHaveBeenCalledTimes(1);
    await stop();
  });

  it('ignores a command that is implemented but NOT declared in config', async () => {
    // `bot.commands` is the single source of truth for both the descriptor and
    // the dispatch table. Otherwise an operator who omits `/topic` to keep their
    // topic list private still gets an exact-match oracle over it, one guess at
    // a time — and `/help` would lie about what the bot answers.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const onlyAbout = botCfg({ commands: [{ name: 'about', description: 'who I am' }] });
    const { deliver, stop } = await startAndCapture(
      depsWith({ reply }),
      ctxWith(configWith(onlyAbout)),
    );
    deliver(msg('/topic Klever', { mentions: ['klv1bot'] }));
    deliver(msg('/sources', { mentions: ['klv1bot'] }));
    await settle();
    expect(reply).not.toHaveBeenCalled();

    deliver(msg('/about', { mentions: ['klv1bot'] }));
    await settle();
    expect(reply).toHaveBeenCalledTimes(1);
    await stop();
  });

  it('never echoes a link or a mention back into a message it signs', async () => {
    // The bot is the highest-trust poster in a channel: Bot-badged, often
    // verified, funded wallet. Clients auto-link URLs and render @klv1… as a
    // clickable pill, so echoing raw input publishes an attacker's link under
    // the operator's identity — and the abuse reports land on the bot.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(configWith(cfg)));
    deliver(
      msg('/topic @klv1victim verify at https://evil.example #urgent', { mentions: ['klv1bot'] }),
    );
    await settle();
    const sent = reply.mock.calls[0]?.[1] ?? '';
    expect(sent).not.toContain('@klv1victim');
    expect(sent).not.toContain('https://');
    expect(sent).not.toContain('#urgent');
    await stop();
  });

  it('never echoes INVISIBLE characters back either', async () => {
    // "Letters and digits only" is not enough. The Hangul fillers are ordinary
    // `\p{L}` letters that render as nothing, and `\p{N}` includes U+2488 (`⒈`,
    // which renders as "1.") — so a letters-and-digits whitelist still admits
    // both invisible padding and a period-shaped glyph, which is most of what is
    // needed to make an echo read as a domain.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(configWith(cfg)));
    deliver(msg('/topic \u3164\u1160\u115F\uFFA0evil\u2488com', { mentions: ['klv1bot'] }));
    await settle();
    const sent = reply.mock.calls[0]?.[1] ?? '';
    expect(sent).not.toContain('\u3164');
    expect(sent).not.toContain('\u2488');
    expect(sent).toContain('evilcom');
    await stop();
  });

  it('does not publish the descriptor in dry run', async () => {
    // setBotCommands is a real signed ProfileUpdate against the live network.
    // An operator testing a config would otherwise have already told everyone
    // they are a bot, and published their whole command list, before deciding
    // to go live.
    const publishDescriptor = vi.fn(async (_d: Parameters<CommandsDeps['publishDescriptor']>[0]) => {});
    const ctx = ctxWith(configWith(cfg, true));
    const mod = createCommandsModule(depsWith({ publishDescriptor }));
    await mod.preflight!(ctx);
    await (await mod.start(ctx)).stop();
    expect(publishDescriptor).not.toHaveBeenCalled();
  });

  it('keeps running when the descriptor publish fails', async () => {
    // One PUT to the profile endpoint. A 429 or 5xx there must not throw out of
    // start(), out of startAll, and take down the news pipeline with it.
    const publishDescriptor = vi.fn(async () => {
      throw new Error('API error (429)');
    });
    const ctx = ctxWith(configWith(cfg));
    const mod = createCommandsModule(depsWith({ publishDescriptor }));
    await mod.preflight!(ctx);
    const handle = await mod.start(ctx);
    expect(handle).toBeDefined();
    await handle.stop();
  });

  it('publishes NOTHING in dry run', async () => {
    // dryRun is the safety catch that lets an operator test a config against a
    // live network. A command reply is a real post under the bot's real wallet,
    // so it is not exempt.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const { deliver, stop } = await startAndCapture(
      depsWith({ reply }),
      ctxWith(configWith(cfg, true)),
    );
    deliver(msg('/about', { mentions: ['klv1bot'] }));
    await settle();
    expect(reply).not.toHaveBeenCalled();
    await stop();
  });

  it('stops replying once the wallet-quota share is spent', async () => {
    // Burst limit 20 x share 0.5 = 10 replies per 10-minute window; the rest of
    // the wallet's quota stays reserved for the news pipeline.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const config = configWith(
      botSchema.parse({
        enabled: true,
        channels: [7],
        commands: [{ name: 'about', description: 'who I am' }],
        rateLimit: { perWalletPerMinute: 600, globalPerMinute: 600 },
      }),
    );
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(config));
    for (let i = 0; i < 30; i += 1) {
      deliver(msg('/about', { from: `klv1u${i}`, mentions: ['klv1bot'] }));
      await settle();
    }
    expect(reply).toHaveBeenCalledTimes(10);
    await stop();
  });

  it('does not spend the last of the quota announcing that the quota is gone', async () => {
    // The throttle notice is itself a chat message and costs node quota, so it
    // goes through the same budget as a real reply — the amplifier trap in its
    // purest form.
    const reply = vi.fn(async (_channelId: number, _text: string, _mentions: string[]) => {});
    const config = configWith(
      botSchema.parse({
        enabled: true,
        channels: [7],
        commands: [{ name: 'about', description: 'who I am' }],
        rateLimit: { perWalletPerMinute: 1, globalPerMinute: 600 },
        // 20 * 0.05 -> floor 1: exactly one message of quota exists.
        ...{},
      }),
    );
    (config.bot.rateLimit as { maxShareOfNodeBudget: number }).maxShareOfNodeBudget = 0.05;
    const { deliver, stop } = await startAndCapture(depsWith({ reply }), ctxWith(config));

    deliver(msg('/about', { from: 'klv1u', mentions: ['klv1bot'] }));
    await settle();
    expect(reply).toHaveBeenCalledTimes(1); // the answer consumed the only slot

    for (let i = 0; i < 5; i += 1) {
      deliver(msg('/about', { from: 'klv1u', mentions: ['klv1bot'] }));
      await settle();
    }
    expect(reply).toHaveBeenCalledTimes(1); // no notices squeezed past the budget
    await stop();
  });
});
