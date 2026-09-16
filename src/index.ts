#!/usr/bin/env node
/**
 * ogmara-bot CLI entry point.
 *
 * Two modes: `--once` executes a single pipeline run and exits (good for cron,
 * systemd timers and testing), while the default runs the configured schedules
 * until interrupted.
 */

import { statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  CHANNEL_TYPE_PRIVATE,
  WalletSigner,
  canPost,
  subscribe,
  type OgmaraClient,
} from '@ogmara/sdk';
import { config as loadDotenv } from 'dotenv';
import { AiConfigError, createProvider } from './ai/index.js';
import { loadTemplate } from './ai/prompt.js';
import {
  ensureConfigFile,
  ensureWalletKey,
  readWalletKeyFromFile,
  type WalletBootstrapResult,
} from './bootstrap.js';
import {
  ConfigError,
  loadConfig,
  loadLayeredConfig,
  loadSecrets,
  type Config,
  type Secrets,
} from './config.js';
import { watchConfigFile, type ConfigWatcher } from './configWatcher.js';
import { applyProfile, checkRegistration, fetchProfile, registerWallet, uploadAvatar } from './identity.js';
import { ChannelKeyService, DeviceIdentityError, loadOrCreateDeviceIdentity } from './channelKeys.js';
import { KleverError, REGISTRATION_COST_KLV } from './klever.js';
import { Ledger } from './ledger.js';
import { LockError, acquireDataLock } from './lock.js';
import {
  InvalidPostError,
  NetworkMismatchError,
  OgmaraPublisher,
  httpStatusFromError,
  type ComposedPost,
} from './ogmara.js';
import { PanelAuth } from './panel/auth.js';
import { TrustedProxies } from './panel/clientip.js';
import { DASHBOARD_POST_LIMIT, fetchPostStats } from './panel/posts.js';
import { MAX_AUDIT_REASON, startPanel, truncate, type Panel } from './panel/server.js';
import { diffForAudit } from './panel/settings.js';
import { PostQueue } from './queue.js';
import { type RunOutcome } from './pipeline.js';
import { createNewsModule, imagedirVisionError } from './modules/news.js';
import { createCommandsModule } from './modules/commands/index.js';
import { enabledModules, preflightAll, startAll, stopAll } from './modules/registry.js';
import type { BotContext, BotModule } from './modules/types.js';
import type { StartedModule } from './modules/registry.js';
import { runsPerHour, schedule, type ScheduledJob } from './scheduler.js';
import { ImageDirSource } from './sources/imagedir.js';
import { RssSource } from './sources/rss.js';
import { TopicsSource } from './sources/topics.js';
import type { Source } from './sources/types.js';
import { aggregateAllPostStats } from './stats.js';
import { StatsHistory } from './statsHistory.js';
import { stripControlSequences } from './terminal.js';
import { WALLET_BACKUP_PATH, acknowledgeBackup, isBackupPending } from './walletBackup.js';
import { createSettingsDeps, type ReconfigureHook } from './settingsDeps.js';
import type { SettingsDeps } from './panel/server.js';

interface CliArgs {
  configPath: string;
  /** Force dry-run regardless of config. Cannot be used to force live posting. */
  forceDryRun: boolean;
  /** Run the pipeline once and exit instead of scheduling. */
  once: boolean;
  /** Publish the configured profile and exit. */
  setProfile: boolean;
  /** Register the wallet on-chain and exit. Spends KLV. */
  register: boolean;
  /** Skip the interactive confirmation on --register. For scripted use. */
  assumeYes: boolean;
  showHelp: boolean;
  /** Scaffold config.yaml / generate a wallet key, then exit. Never overwrites either. */
  init: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    configPath: 'config.yaml',
    forceDryRun: false,
    once: false,
    setProfile: false,
    register: false,
    assumeYes: false,
    showHelp: false,
    init: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') args.showHelp = true;
    else if (arg === '--dry-run') args.forceDryRun = true;
    else if (arg === '--once') args.once = true;
    else if (arg === '--set-profile') args.setProfile = true;
    else if (arg === '--register') args.register = true;
    else if (arg === '--init') args.init = true;
    else if (arg === '--yes' || arg === '-y') args.assumeYes = true;
    else if (arg === '--config') {
      const next = argv[i + 1];
      if (next === undefined) throw new ConfigError('--config requires a path argument');
      args.configPath = next;
      i++;
    } else if (arg.startsWith('--config=')) {
      args.configPath = arg.slice('--config='.length);
    } else {
      throw new ConfigError(`unknown argument "${arg}" (try --help)`);
    }
  }
  return args;
}

const HELP = `ogmara-bot — a modular Ogmara bot: AI-composed news posts and channel commands

Usage: ogmara-bot [options]

Options:
  --once            Run the pipeline once and exit (default: run on schedule)
  --config <path>   Config file to use (default: config.yaml)
  --dry-run         Compose and print without publishing, overriding config
  -h, --help        Show this help

First run:
  --init            Create config.yaml (from config.example.yaml) and, if run
                    interactively, offer to generate a wallet key — then
                    exit so you can review both before running for real.
                    Never overwrites an existing config.yaml or key. Also
                    runs automatically (without needing this flag) whenever
                    config.yaml is missing or no wallet key is configured.

Identity:
  --set-profile     Publish the display name / bio from your config, then exit
  --register        Register this wallet on-chain, then exit. SPENDS ~4.4 KLV
                    and cannot be undone. Raises the node's daily posting
                    ceiling from 50 to 300. Asks for confirmation first.
  -y, --yes         Skip that confirmation (for scripted use)

Control panel:
  Set panel.enabled: true in the config to serve a small web UI for changing
  the display name and registering the wallet, while the bot runs on its
  schedule. The bot always signs with its own wallet; panel.adminWallets
  names the SEPARATE operator wallets allowed to log in and drive it — same
  model as the l2-node dashboard. Always reachable with no login from
  localhost; add panel.adminWallets to allow signed-in remote access.

Secrets come from the environment (or a .env file), never the config file:
  OGMARA_WALLET_KEY   Bot wallet private key, 64 hex characters

Note: --dry-run can only ever make the bot safer. Live posting requires
setting posting.dryRun: false in the config file, deliberately.`;

/**
 * Warn when `.env` is readable by anyone but its owner.
 *
 * The README and `.env.example` both tell operators to `chmod 600`, and
 * nothing checked it. That file holds a key that IS the bot's posting
 * identity, and the audience for this project is people who may not think to
 * verify. (Audit 2026-08-26, SEC-N3.)
 */
function warnIfEnvReadable(): void {
  try {
    const mode = statSync('.env').mode & 0o077;
    if (mode !== 0) {
      console.warn(
        `Warning: .env is accessible to other users on this machine (mode ${(mode | 0o600).toString(8)}).\n` +
          '         It holds your wallet key. Run: chmod 600 .env',
      );
    }
  } catch {
    // No .env (env vars set directly) — nothing to check.
  }
}

/** Render a composed post for human review — the dry-run output. */
function renderPost(post: ComposedPost, address: string): void {
  console.log(`\n${'─'.repeat(68)}`);
  console.log(`DRY RUN — not published   as ${address}`);
  console.log('─'.repeat(68));
  console.log(`Title:   ${stripControlSequences(post.title)}`);
  console.log(
    `Tags:    ${post.tags.length > 0 ? post.tags.map((t) => `#${t}`).join(' ') : '(none)'}`,
  );
  if (post.attachments !== undefined && post.attachments.length > 0) {
    for (const a of post.attachments) {
      const note =
        a.cid === 'dry-run-not-uploaded'
          ? '(validated, not uploaded — dry run)'
          : `cid ${a.cid}`;
      console.log(`Image:   ${a.filename ?? '(unnamed)'} ${note}`);
    }
  }
  console.log('─'.repeat(68));
  console.log(stripControlSequences(post.content));
  console.log(`${'─'.repeat(68)}\n`);
}

/**
 * Build a startup warning when the bot's configured cadence exceeds 80% of
 * the wallet's ACTUAL current daily ceiling — never a hard error. The queue
 * already parks and retries a rate-limited post rather than dropping it, and
 * "will this exceed the node's limit" can only be answered once registration
 * status is known from the chain, which config validation (synchronous, no
 * network) structurally cannot do. Extracted as a pure function so the
 * threshold logic has a direct unit test rather than relying on a full
 * `run()` integration test.
 */
/**
 * Whether the bot should refuse to start, and why.
 *
 * A bot with every module switched off is a VALID deployment — the control
 * panel alone is a reason to run, and it is how an operator configures the thing
 * in the first place. Before the module contract this was a hard error ("no
 * sources are enabled"), which made a panel-only bot impossible.
 *
 * So refuse only when there would be genuinely nothing to do:
 *   - `--once` with no module to run: the process would start and immediately
 *     exit having done nothing.
 *   - long-running with no modules AND no panel: it would idle forever with no
 *     work and no way to reach it.
 *
 * Pure and exported so the policy is testable without standing up a node, a
 * wallet and an AI provider — `run()` itself needs all three.
 *
 * Returns an operator-facing message, or `null` to proceed.
 */
export function startupRefusal(opts: {
  readonly moduleCount: number;
  readonly once: boolean;
  readonly panelEnabled: boolean;
}): string | null {
  if (opts.moduleCount > 0) return null;
  if (!opts.once && opts.panelEnabled) return null;
  return (
    '\nNothing to run: no modules are enabled' +
    (opts.once ? ' (and --once has nothing to do).' : ' and the control panel is off.') +
    '\nEnable a source under `sources:`, or turn on `panel.enabled` to configure ' +
    'the bot from its web UI.'
  );
}

export function dailyBudgetWarning(
  maxPostsPerHour: number,
  dailyLimit: number,
  registered: boolean,
): string | undefined {
  if (maxPostsPerHour * 24 <= dailyLimit * 0.8) return undefined;
  return (
    `Note: posting.maxPostsPerHour (${maxPostsPerHour}) x 24h ` +
    `(${maxPostsPerHour * 24}) exceeds 80% of this wallet's current daily ceiling ` +
    `(${dailyLimit}/day, ${registered ? 'registered' : 'unregistered'} tier). ` +
    'Posts beyond the ceiling are queued and retried, not dropped (see "Rate limits and ' +
    'the retry queue" in the README)' +
    (registered ? '.' : ' — register the wallet to raise this 6x (`--register`).')
  );
}

/** Build the enabled sources from config. */
/** Report a run outcome to the console. */
function reportOutcome(outcome: RunOutcome, address: string): void {
  switch (outcome.status) {
    case 'dry-run':
      renderPost(outcome.post, address);
      console.log('Dry run — set posting.dryRun: false to publish for real.');
      break;
    case 'posted':
      console.log(
        `Published${outcome.fromQueue ? ' (from queue)' : ''} "${outcome.title}" — msg_id ${outcome.msgId}`,
      );
      break;
    case 'nothing-new':
      console.log(`Nothing new to post (${outcome.polled} candidates, all seen).`);
      break;
    case 'refused':
      console.log(
        `Model declined to write about "${outcome.title}"` +
          `${outcome.category !== undefined ? ` (${outcome.category})` : ''} — skipping it.`,
      );
      break;
    case 'compose-failed':
      console.log(`Could not compose "${outcome.title}" — will retry. (${outcome.reason})`);
      break;
    case 'deferred': {
      // Name the actual cause. The previous message said "Rate limited" for
      // all three, which pointed operators at their node even when the bot's
      // own cadence budget was the reason.
      const wait = `${Math.ceil(outcome.retryAfterMs / 1000)}s`;
      const why =
        outcome.cause === 'local-budget'
          ? `Holding to your configured cadence — next slot in ${wait}`
          : outcome.cause === 'node-rate-limit'
            ? `Node rate-limited this wallet — retrying in ${wait}`
            : `Node unreachable (${outcome.detail ?? 'unknown'}) — retrying in ${wait}`;
      console.log(`${why}. ${outcome.queued} post(s) queued.`);
      break;
    }
  }
}

/** Longest a `confirm()` prompt waits before treating silence as "no". */
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

/**
 * Ask the operator to confirm a consequential action (spending KLV,
 * generating a wallet key).
 *
 * Returns false rather than assuming consent whenever nobody can plausibly
 * be there to answer:
 * - Neither stdin nor stdout is a TTY (cron, systemd, a pipe). Checking
 *   both, not just stdin, matters — a session with input attached but output
 *   redirected elsewhere (or vice versa) is exactly as unattended as one
 *   with neither, and treating it as interactive would print a prompt that
 *   silently blocks forever with nobody able to see or answer it.
 * - The prompt sits unanswered for {@link CONFIRM_TIMEOUT_MS}: a TTY can be
 *   attached to a session nobody is actually watching (a detached tmux pane,
 *   an `-it` container under a restart policy), and a wallet-generation or
 *   fund-spending prompt must eventually give up rather than wedge the
 *   process indefinitely.
 *
 * Scripted callers opt in explicitly with --yes rather than relying on this.
 */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Not an interactive terminal — refusing to assume consent.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
  try {
    const answer = await rl.question(`${question} [y/N] `, { signal: controller.signal });
    return /^y(es)?$/i.test(answer.trim());
  } catch (err) {
    if (controller.signal.aborted) {
      console.error('\nNo response — assuming no.');
      return false;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    rl.close();
  }
}

/** `--set-profile`: publish the configured display name / bio. */
async function runSetProfile(config: Config, secrets: Secrets): Promise<number> {
  const publisher = await OgmaraPublisher.create(config, secrets);
  await publisher.health(); // also enforces the network match
  console.log(`Wallet:  ${publisher.address}`);

  const result = await applyProfile(publisher.client, {
    displayName: config.profile.displayName,
    bio: config.profile.bio,
    avatarCid: config.profile.avatarCid,
  });

  if (result.status === 'nothing-to-do') {
    console.error(
      '\nNothing to publish: set profile.displayName (and optionally bio, avatarCid) ' +
        'in your config first.',
    );
    return 2;
  }
  console.log(`Profile updated${result.displayName !== undefined ? ` — display name is now "${result.displayName}"` : ''}.`);
  return 0;
}

/** `--register`: register the wallet on-chain after explicit confirmation. */
async function runRegister(config: Config, secrets: Secrets, assumeYes: boolean): Promise<number> {
  const publisher = await OgmaraPublisher.create(config, secrets);
  const network = config.node.network;
  console.log(`Wallet:  ${publisher.address}`);
  console.log(`Network: ${network}\n`);

  const status = await checkRegistration(network, publisher.address);
  if (status.registered) {
    const when = new Date(status.registeredAt * 1000).toISOString().slice(0, 10);
    console.log(`Already registered (since ${when}). Nothing to do.`);
    console.log(
      `Daily posting ceiling: ${config.posting.nodeDailyRegistered} ` +
        `(vs ${config.posting.nodeDailyUnverified} unregistered).`,
    );
    return 0;
  }

  console.log('This wallet is NOT registered on-chain.\n');
  console.log(`  Cost:     ~${REGISTRATION_COST_KLV} KLV, non-refundable`);
  console.log(`  Balance:  ${status.balanceKlv.toFixed(4)} KLV`);
  console.log(
    `  Unlocks:  ${config.posting.nodeDailyRegistered} posts/day instead of ` +
      `${config.posting.nodeDailyUnverified}, and ` +
      `${config.posting.nodeBurstRegistered} per 10 min instead of ` +
      `${config.posting.nodeBurstUnverified}\n`,
  );

  if (!status.canAfford) {
    console.error(
      `Insufficient funds: need ~${REGISTRATION_COST_KLV} KLV, wallet holds ` +
        `${status.balanceKlv.toFixed(4)}. Send KLV to ${publisher.address} and retry.`,
    );
    return 2;
  }

  if (!assumeYes && !(await confirm('Register this wallet on-chain?'))) {
    console.log('Cancelled. Nothing was spent.');
    return 0;
  }

  console.log('\nSubmitting registration…');
  const result = await registerWallet(network, publisher.signer, hexToKey(secrets.walletKeyHex));
  switch (result.status) {
    case 'already-registered':
      console.log('Already registered — nothing was spent.');
      return 0;
    case 'insufficient-funds':
      console.error(`Insufficient funds: need ${result.requiredKlv} KLV, have ${result.balanceKlv}.`);
      return 2;
    case 'registered':
      console.log(`Registered. Transaction: ${result.txHash}`);
      console.log(`  ${result.explorerUrl}`);
      console.log(
        '\nThe node picks this up via its chain scanner, usually within a minute. ' +
          'Raise posting.maxPostsPerHour in your config to use the higher ceiling.',
      );
      return 0;
  }
}

/** Decode the operator's 64-char hex wallet key to raw bytes. */
function hexToKey(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function run(args: CliArgs): Promise<number> {
  // config.yaml first, then the settings UI's overrides on top. A bad or stale
  // overrides file is reported and ignored rather than fatal — it is written by
  // a web form, and a bad save must never stop the bot starting.
  const bootstrap = loadConfig(args.configPath);
  const layered = loadLayeredConfig(args.configPath, bootstrap.settings.path);
  const config: Config = layered.config;
  const secrets: Secrets = loadSecrets();

  const effective: Config = args.forceDryRun
    ? { ...config, posting: { ...config.posting, dryRun: true } }
    : config;

  const publisher = await OgmaraPublisher.create(effective, secrets);
  console.log(`Wallet:  ${publisher.address}`);
  console.log(`Node:    ${effective.node.url} (${effective.node.network})`);

  // health.version comes from the node, so it is remote text like any other.
  const health = await publisher.health();
  console.log(
    `Health:  v${stripControlSequences(health.version)}, ${health.peers} peers, ` +
      `media ${health.mediaUploads ? 'available' : 'UNAVAILABLE'}`,
  );

  // Before touching the ledger: two instances sharing a data directory
  // overwrite each other's records and republish items.
  acquireDataLock(effective.storage.ledgerPath);

  // Registration decides the node's ceiling for this wallet (6x on the daily
  // limit), so the publisher must know it before modelling any budget. A
  // failure here is non-fatal — the chain being unreachable should not stop
  // the bot posting at the conservative unregistered rate.
  try {
    const reg = await checkRegistration(effective.node.network, publisher.address);
    publisher.setRegistered(reg.registered);
    console.log(
      `Wallet:  ${reg.registered ? 'REGISTERED' : 'unregistered'} on-chain — ` +
        `node allows ${publisher.dailyLimit}/day, ${publisher.burstLimit}/10min` +
        `${reg.registered ? '' : '  (run --register to raise this 6x)'}`,
    );
  } catch (err) {
    console.warn(
      `  warning: could not check on-chain registration (${err instanceof Error ? err.message : err}); ` +
        'assuming unregistered limits.',
    );
  }

  // Device encryption identity — required for ANY other client to wrap a
  // channel key to this bot (spec §2.4). Load/create is allowed to throw
  // (DeviceIdentityError, caught below) rather than silently mint a fresh
  // identity over a corrupt one: that would orphan every key already
  // wrapped to the old device.
  const deviceIdentity = loadOrCreateDeviceIdentity(effective.storage.deviceEncPath);
  const channelKeys = new ChannelKeyService(publisher.client, publisher.signer, deviceIdentity, (m) =>
    console.warn(m),
  );
  // Both best-effort — a hiccup here must not stop the bot starting, since
  // posting/news work regardless. It only means this run cannot receive new
  // channel keys (binding) or recover previously-known ones (vault) yet.
  await channelKeys.ensureBinding(publisher.address, effective.node.network);
  await channelKeys.restoreFromVault();
  console.log(`DeviceEnc: bound (device ${deviceIdentity.deviceId.slice(0, 12)}…) for encrypted channels`);

  const ledger = Ledger.load(effective.storage.ledgerPath, effective.storage.retentionDays);
  console.log(`Ledger:  ${effective.storage.ledgerPath} (${ledger.size} entries)`);

  const queue = PostQueue.load(
    effective.queue.path,
    effective.queue.maxAttempts,
    effective.queue.maxAgeHours,
  );
  console.log(`Queue:   ${effective.queue.path} (${queue.size} pending)`);

  // `let`, not `const` — ai.provider/model/baseUrl/effort/maxTokens are now
  // live-appliable (see the reconfigureHooks entries below); the news
  // module reads this THROUGH an accessor function passed into
  // createNewsModule, never capturing the object itself.
  let currentProvider = await createProvider(effective.ai, secrets);
  console.log(`AI:      ${currentProvider.id} / ${currentProvider.model}`);

  if (effective.profile.applyOnStart) {
    const result = await applyProfile(publisher.client, {
      displayName: effective.profile.displayName,
      bio: effective.profile.bio,
      avatarCid: effective.profile.avatarCid,
    });
    if (result.status === 'updated') console.log('Profile: published from config');
  }

  // Same reasoning as `currentProvider` — each `*PromptPath` reconfigure
  // hook reloads just its own entry, replacing the whole object so nothing
  // ever observes a partially-updated one.
  let currentTemplates = {
    rss: loadTemplate(effective.ai.promptPath),
    topics: loadTemplate(effective.ai.topicPromptPath),
    imagedir: loadTemplate(effective.ai.imagePromptPath),
  };

  // --- Modules -------------------------------------------------------------
  //
  // Optional features the operator switches on. Core — node, panel, storage,
  // wallet identity — is deliberately NOT a module: it cannot be turned off,
  // and a bot with no reachable panel is a bot nobody can fix.
  const ctx: BotContext = {
    config: effective,
    secrets,
    publisher,
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
  };

  // Set only while the commands module's channel-listening WS stream is
  // actually connected (between subscribeChannels() and its returned
  // close()). `subscribe()`'s connection is bound to whichever `node.url`
  // was current at CALL time — the SDK has no live URL-change API (same
  // as `OgmaraClient` itself) — so a live `node.url` change needs this to
  // tear down and reconnect, or the listener silently keeps talking to
  // the OLD node forever even though publishing correctly moved to the
  // new one via `publisher.rebuildClient()`.
  let reconnectChannelSubscription: (() => void) | undefined;

  const commandsModule = createCommandsModule({
      reply: async (channelId, text, mentions) => {
        // Encrypted first: a channel this bot has ever gotten a key for
        // always replies encrypted — silently plaintext-replying into a
        // channel it knows is encrypted would leak the reply to the node
        // (and to anyone who can read public traffic) in cleartext.
        const envelope = await channelKeys.encryptedReplyEnvelope(channelId, text, mentions);
        if (envelope !== null) {
          await publisher.client.sendMessageEnvelope(envelope);
          return;
        }
        await publisher.client.sendMessage(channelId, text, { mentions });
      },
      decryptChannelText: (channelId, encContent, encNonce, keyEpoch) =>
        channelKeys.decryptChannelMessage(channelId, encContent, encNonce, keyEpoch),
      subscribeChannels: async (channels, onMessage) => {
        const connect = (): ReturnType<typeof subscribe> =>
          subscribe({
            // Read fresh on every (re)connect, not captured once — this is
            // what makes a live node.url change actually take effect the
            // moment reconnectChannelSubscription() is called below.
            nodeUrl: effective.node.url,
            channels: channels.map((id) => String(id)),
            signer: publisher.signer,
            onEvent: (event) => {
              if (event.type === 'message') onMessage(event.envelope);
            },
            onError: (err) => {
              console.warn(`  warning: command listener could not connect (${err.message})`);
            },
          });
        let sub = connect();
        reconnectChannelSubscription = () => {
          sub.close();
          sub = connect();
        };
        return () => {
          reconnectChannelSubscription = undefined;
          sub.close();
        };
      },
      describeChannel: async (channelId) => {
        try {
          const { channel } = await publisher.client.getChannel(channelId);
          return {
            name: channel.display_name ?? channel.slug,
            // NOT just `channel_type === PRIVATE`. New Public and ReadPublic
            // channels are created with encryption forced ON, so a private-only
            // test would wave through most modern public channels — where the
            // bot would read ciphertext it cannot decrypt and answer nothing,
            // which is precisely what this check exists to prevent.
            encrypted:
              channel.channel_type === CHANNEL_TYPE_PRIVATE || channel.encryption_enabled === true,
            // `isModerator: false` deliberately — the bot should be usable
            // without moderator rights, so preflight must pass on the weaker
            // assumption rather than one that could be revoked later.
            canPost: canPost(channel, publisher.address, false),
          };
        } catch (err) {
          // ONLY "this channel is not there for us" is a config error. A 5xx, a
          // timeout or a restarting node becomes 'unreachable' instead, so the
          // operator gets a sentence about their node rather than being told to
          // fix channel ids that are perfectly correct — which, under systemd,
          // would be a restart loop blaming them for a node hiccup.
          const status = httpStatusFromError(err);
          if (status === 404 || status === 403) return null;
          return 'unreachable';
        }
      },
      publishDescriptor: async (descriptor) => {
        await publisher.client.setBotCommands(descriptor);
      },
      joinChannel: async (channelId) => {
        await publisher.client.joinChannel(channelId);
      },
      federateChannel: async (channelId, hostUrl) => {
        await publisher.client.federateChannel(channelId, hostUrl);
      },
      getNotifications: async (since, limit, type) => {
        const { notifications } = await publisher.client.getNotifications(since, limit, type);
        return notifications;
      },
    });
  const newsModule = createNewsModule({
    ledger,
    queue,
    provider: () => currentProvider,
    templates: () => currentTemplates,
    report: (outcome: RunOutcome) => reportOutcome(outcome, publisher.address),
    // The health already fetched above for the startup banner — passed in so
    // the module's media-uploads precondition does not make a second network
    // round trip for information the core already has.
    health,
  });
  const allModules: BotModule[] = [newsModule, commandsModule];
  const modules = enabledModules(allModules, effective);

  console.log(
    effective.posting.dryRun
      ? 'Mode:    dry run — nothing will be published'
      : `Mode:    LIVE — up to ${effective.posting.maxPostsPerHour} post(s)/hour`,
  );
  console.log(`Modules: ${modules.length > 0 ? modules.map((m) => m.name).join(', ') : 'none enabled'}`);

  // A bot with every module off is a VALID deployment — the panel alone is a
  // reason to run, and it is how an operator configures the thing in the first
  // place. Only refuse when there would be nothing to do at all, which for
  // `--once` means nothing to run and no panel to serve.
  const refusal = startupRefusal({
    moduleCount: modules.length,
    once: args.once,
    panelEnabled: effective.panel.enabled,
  });
  if (refusal !== null) {
    console.error(refusal);
    return 2;
  }

  // Preconditions that need the node, the filesystem or the AI provider —
  // anything unavailable at config-load time, which is why these are not Zod
  // refinements.
  const failure = await preflightAll(modules, ctx);
  if (failure !== null) {
    console.error(failure.message);
    return 2;
  }

  if (args.once) {
    for (const m of modules) {
      if (m.runOnce !== undefined) await m.runOnce(ctx);
    }
    return 0;
  }

  // The panel only makes sense for a long-running instance — `--once` exits
  // immediately, which would start a server nobody could ever reach.
  let panel: Panel | undefined;
  // Same reasoning: a one-shot run exits long before a hand-edit could ever
  // land, so there's nothing for a watcher to usefully do.
  let configWatcher: ConfigWatcher | undefined;
  // Loaded only when the panel is on: it's the only consumer, per
  // config.ts's statsSchema comment.
  let statsHistory: StatsHistory | undefined;
  // Takes a snapshot on demand, sharing ONE in-flight guard across every
  // trigger source: the startup snapshot below, the recurring cron tick, and
  // the panel's manual "Refresh" button (added after operator feedback that
  // clicking refresh didn't actually update the chart — it only re-read
  // whatever was already on disk). A concurrent caller joins the SAME
  // in-flight aggregation rather than starting a second one or silently
  // no-op'ing, so "trigger a snapshot" always means "wait until one is
  // available," regardless of who else asked for it at the same time.
  let takeStatsSnapshotNow: (() => Promise<void>) | undefined;
  // Built here, mutable, and handed to `createSettingsDeps` by reference —
  // NOT as an inline array literal — because `commit()` reads whatever this
  // array currently holds at commit time, not a frozen snapshot from
  // construction. That matters because the schedule-reschedule hooks below
  // can only be built once `startAll()` has produced real `ScheduledJob`
  // handles to reschedule, and that happens LATER in this function, after
  // the panel (and therefore `createSettingsDeps`) is already up — a module
  // needs the panel's `ctx` no more than the panel needs a module's cron
  // handle, so neither construction order is obviously "right," and
  // reordering either risks the kind of startup-sequencing regression this
  // file's existing comments are full of warnings about. A mutable array
  // sidesteps the ordering question entirely.
  /**
   * Live-apply a `node.url`/`node.network`/`node.timeoutMs` change: rebuild
   * the SDK client from the current config (already updated in place by
   * the time this runs) and propagate it to every OTHER place that held
   * its own separate reference to the old one — `OgmaraClient` itself has
   * no in-place reconfigure API, so a whole new client is the only option.
   */
  function rebuildNodeConnections(): void {
    publisher.rebuildClient();
    channelKeys.setClient(publisher.client);
    // Undefined if the commands module isn't enabled, or its subscription
    // isn't currently connected — nothing to reconnect in that case.
    reconnectChannelSubscription?.();
  }

  /**
   * Live-apply an `ai.provider`/`model`/`baseUrl`/`effort`/`maxTokens`
   * change: rebuild the provider client from the current config. All five
   * paths funnel into this SAME rebuild — `createProvider` takes the whole
   * `ai` section, not one field, and it's cheap (a thin, stateless HTTP
   * client wrapper) either way. If the new config is invalid (e.g. no API
   * key for the newly-selected provider), `createProvider` rejects and
   * `currentProvider` is simply never reassigned — the bot keeps
   * publishing with the last-known-good provider rather than being left
   * with none, and the rejection reaches the operator via the existing
   * "live-apply ... failed" log (see settingsDeps.ts's async hook
   * dispatch).
   *
   * Also re-checks the same imagedir/vision precondition `news.ts`'s
   * `preflight()` enforces at startup. Preflight only ever runs once, at
   * boot — a live provider swap has no other gate, so without this check
   * an operator could switch to a text-only model while `sources.imagedir`
   * is enabled and only discover it from an opaque per-item compose
   * failure on the next imagedir run, instead of the same clear,
   * actionable message preflight already gives. Checked BEFORE
   * `currentProvider` is reassigned, for the same last-known-good reason
   * as the rejection case above.
   */
  async function rebuildAiProvider(): Promise<void> {
    const next = await createProvider(effective.ai, secrets);
    const visionError = imagedirVisionError(effective, next);
    if (visionError !== null) throw new AiConfigError(visionError);
    currentProvider = next;
  }

  /**
   * Live-apply one `ai.*PromptPath` change: reload just that one template
   * file's contents. Replaces the whole `currentTemplates` object (rather
   * than mutating one field of it) so nothing reading it mid-update ever
   * observes a partially-updated set.
   */
  function reloadTemplate(key: keyof typeof currentTemplates, path: string): void {
    currentTemplates = { ...currentTemplates, [key]: loadTemplate(path) };
  }

  const reconfigureHooks: ReconfigureHook[] = [
    // The values below are the ones the uiSchema promises are live
    // (`restart: false`) specifically BECAUSE something baked them into a
    // constructor rather than re-reading `ctx.config` — every other
    // `restart: false` field needs no entry here at all, since fixing the
    // config-object disconnect alone already makes a plain property read
    // observe a save immediately.
    {
      path: 'posting.maxPostsPerHour',
      apply: (v) => publisher.setMaxPostsPerHour(v as number),
    },
    {
      path: 'storage.retentionDays',
      apply: (v) => ledger.setRetentionDays(v as number),
    },
    {
      path: 'stats.retentionDays',
      // `statsHistory` isn't constructed yet at this exact line (only once
      // `effective.panel.enabled`, a few lines below) — this closure reads
      // it lazily, by the time a save could ever actually trigger it.
      apply: (v) => statsHistory?.setRetentionDays(v as number),
    },
    {
      path: 'queue.maxAttempts',
      apply: (v) => queue.setMaxAttempts(v as number),
    },
    {
      path: 'queue.maxAgeHours',
      apply: (v) => queue.setMaxAgeHours(v as number),
    },
    // `node.url`/`node.network`/`node.timeoutMs` all three trigger the SAME
    // rebuild — the SDK client has no partial-update API, so there is no
    // cheaper path for changing just one of them, and rebuilding twice in
    // one save (if two of the three changed together) would only redo
    // identical, cheap work. `rebuildNodeConnections` reads the current
    // `effective.node.*` fresh each time it runs, so it does not matter
    // which of the three paths actually triggered it.
    { path: 'node.url', apply: () => rebuildNodeConnections() },
    { path: 'node.network', apply: () => rebuildNodeConnections() },
    { path: 'node.timeoutMs', apply: () => rebuildNodeConnections() },
    // Same "one shared rebuild, several trigger paths" shape as node.* above.
    { path: 'ai.provider', apply: () => rebuildAiProvider() },
    { path: 'ai.model', apply: () => rebuildAiProvider() },
    { path: 'ai.baseUrl', apply: () => rebuildAiProvider() },
    { path: 'ai.effort', apply: () => rebuildAiProvider() },
    { path: 'ai.maxTokens', apply: () => rebuildAiProvider() },
    {
      path: 'ai.promptPath',
      apply: (v) => reloadTemplate('rss', v as string),
    },
    {
      path: 'ai.topicPromptPath',
      apply: (v) => reloadTemplate('topics', v as string),
    },
    {
      path: 'ai.imagePromptPath',
      apply: (v) => reloadTemplate('imagedir', v as string),
    },
    // `commandsModule.reconfigure()` is a no-op if `bot.enabled` was false at
    // boot (module never started) or a previous call is still in flight —
    // both guarded inside the module itself, not here. All 8 leaf paths
    // funnel into the SAME re-derive-from-config call, same "one shared
    // rebuild, several trigger paths" shape as node.*/ai.* above; it
    // internally re-validates the new config and keeps the old one running
    // if the combination would be invalid (see its own doc comment).
    { path: 'bot.handle', apply: () => commandsModule.reconfigure?.(ctx) },
    { path: 'bot.channels', apply: () => commandsModule.reconfigure?.(ctx) },
    { path: 'bot.commands', apply: () => commandsModule.reconfigure?.(ctx) },
    {
      path: 'bot.rateLimit.perWalletPerMinute',
      apply: () => commandsModule.reconfigure?.(ctx),
    },
    { path: 'bot.rateLimit.globalPerMinute', apply: () => commandsModule.reconfigure?.(ctx) },
    {
      path: 'bot.rateLimit.noticeCooldownSeconds',
      apply: () => commandsModule.reconfigure?.(ctx),
    },
    {
      path: 'bot.rateLimit.maxShareOfNodeBudget',
      apply: () => commandsModule.reconfigure?.(ctx),
    },
    {
      path: 'bot.rateLimit.perWalletShareOfBudget',
      apply: () => commandsModule.reconfigure?.(ctx),
    },
    // Same shape again: every leaf path under `sources.*` that isn't
    // ALREADY read fresh off `ctx.config` by pipeline.ts (fetchImages, the
    // two image-size/timeout caps, imagedir's contentRating — no hook
    // needed for those) funnels into `newsModule.reconfigure()`, which
    // rebuilds `sources: Source[]` and reconciles the per-source cron job
    // set to match. `sourcesSchema`'s own cross-field check (config.ts)
    // already refuses an unconfigured-but-enabled combination that would
    // leave every source empty, at the write itself — so unlike
    // `commands`'s reconfigure(), this one has nothing left to validate.
    { path: 'sources.rss.enabled', apply: () => newsModule.reconfigure?.(ctx) },
    { path: 'sources.rss.schedule', apply: () => newsModule.reconfigure?.(ctx) },
    { path: 'sources.rss.feeds', apply: () => newsModule.reconfigure?.(ctx) },
    { path: 'sources.rss.maxAgeDays', apply: () => newsModule.reconfigure?.(ctx) },
    { path: 'sources.rss.timeoutMs', apply: () => newsModule.reconfigure?.(ctx) },
    { path: 'sources.rss.maxBytes', apply: () => newsModule.reconfigure?.(ctx) },
    { path: 'sources.topics.enabled', apply: () => newsModule.reconfigure?.(ctx) },
    { path: 'sources.topics.schedule', apply: () => newsModule.reconfigure?.(ctx) },
    { path: 'sources.topics.topics', apply: () => newsModule.reconfigure?.(ctx) },
    { path: 'sources.topics.minIntervalHours', apply: () => newsModule.reconfigure?.(ctx) },
    { path: 'sources.imagedir.enabled', apply: () => newsModule.reconfigure?.(ctx) },
    { path: 'sources.imagedir.schedule', apply: () => newsModule.reconfigure?.(ctx) },
    { path: 'sources.imagedir.directories', apply: () => newsModule.reconfigure?.(ctx) },
  ];
  if (effective.panel.enabled) {
    statsHistory = StatsHistory.load(effective.stats.path, effective.stats.retentionDays);
    const history = statsHistory;
    let inFlight: Promise<void> | undefined;
    takeStatsSnapshotNow = (): Promise<void> => {
      if (inFlight === undefined) {
        inFlight = takeStatsSnapshot(publisher.client, publisher.address, history, effective.stats).finally(
          () => {
            inFlight = undefined;
          },
        );
      }
      return inFlight;
    };
    // Built here rather than inside the panel: this is the only scope that
    // has the config layers, every module's uiSchema, and the paths the
    // overrides and audit log live at.
    //
    // ALL modules, not `modules` (the enabled-only list) — a module's
    // `enabled` flag is itself a field ITS OWN uiSchema describes
    // (`bot.enabled`), so passing only already-enabled modules meant an
    // operator could never discover or turn on a disabled module from the
    // settings page at all: the one uiSchema entry that would have shown
    // it a proper label/help text was gated behind the module already
    // being on. `uiSchema` is a static property set at module construction
    // — it needs no running state — so this changes nothing about which
    // modules actually START (still `modules`, everywhere else in this
    // file), only which modules the settings page can describe.
    const settingsDeps = createSettingsDeps({
      configPath: args.configPath,
      layered: { ...layered, config: effective },
      modules: allModules,
      secrets,
      // Re-applied on every commit, not just here: a freshly merged config
      // would otherwise drop `--dry-run` on the first save, and the panel
      // would report `dryRun: false` while the bot was genuinely in dry run.
      applyCliOverrides: (c) =>
        args.forceDryRun ? { ...c, posting: { ...c.posting, dryRun: true } } : c,
      // By reference — see the comment where `reconfigureHooks` is
      // declared. Entries pushed onto it AFTER this call (the schedule
      // hooks, once modules and the stats job actually exist) still fire,
      // since `commit()` reads the array fresh on every save rather than
      // capturing its contents at construction.
      reconfigureHooks,
    });

    // A hand-edit to config.yaml over SSH must apply exactly the way a
    // panel save does — the operator should never need to remember "did I
    // use the UI or the file" to know whether a restart is needed. `apply`
    // with no changes re-reads config.yaml, re-merges the UNCHANGED
    // overrides onto it, and re-applies — the exact same path a save takes,
    // just triggered by the filesystem instead of a request. A no-op
    // edit (or a burst of fs events from one logical save) costs nothing:
    // `writeOverrides` skips writing when the overrides content it would
    // produce is unchanged, and no reconfigure hook fires unless a value
    // actually changed.
    configWatcher = watchConfigFile(args.configPath, () => {
      // A hand-edit needs the same audit trail a panel save gets — this is
      // exactly the "posting.dryRun took effect and nobody can tell when or
      // from where" gap a code-audit flagged for this feature: a trigger
      // that bypasses `panel/server.ts`'s HTTP handlers (the only other
      // caller of `settings.audit(...)` today) must not also bypass the
      // audit log itself just because there's no request to hang it off.
      const beforeEffective = structuredClone(settingsDeps.describe().effective);
      const result = settingsDeps.apply({});
      const actor = 'filesystem';
      const ip = '-';
      if (!result.ok) {
        console.warn(
          `  warning: config.yaml changed but could not be applied: ${result.issues.join('; ')}`,
        );
        settingsDeps.audit({
          actor,
          ip,
          path: '(config.yaml)',
          outcome: 'rejected',
          reason: truncate(result.issues.join('; '), MAX_AUDIT_REASON),
        });
        return;
      }
      for (const row of diffForAudit(beforeEffective, settingsDeps.describe())) {
        settingsDeps.audit({ actor, ip, ...row });
      }
    });

    panel = await startControlPanel(
      effective,
      secrets,
      publisher,
      queue,
      statsHistory,
      takeStatsSnapshotNow,
      settingsDeps,
    );
  }

  // Each module registers its own crons. The scheduler's overlap guard is
  // per-job, so two jobs firing on the same minute run sequentially rather than
  // racing the ledger.
  const started: StartedModule[] = await startAll(modules, ctx);
  const moduleJobs = started.flatMap((m) => [...m.handle.jobs]);
  // A module job that declared a `configPath` gets a live-reschedule hook,
  // pushed onto the SAME array `createSettingsDeps` was handed above (a
  // no-op if the panel is off — nothing ever reads this array then). The
  // job's OWN `ScheduledJob` object is the one already stored on its
  // module's `ModuleHandle.jobs` and iterated at shutdown — `reschedule()`
  // mutates that object's internal timer in place (see scheduler.ts), so
  // nothing else holding the same reference needs to know a reschedule ever
  // happened.
  for (const job of moduleJobs) {
    if (job.configPath !== undefined) {
      const scheduledJob = job.job;
      reconfigureHooks.push({
        path: job.configPath,
        apply: (v) => scheduledJob.reschedule(v as string),
      });
    }
  }
  // CORE crons only — the stats snapshot below. Module crons live on their
  // module handles and are stopped through the registry; keeping the two lists
  // separate is what stops a module's job being stopped twice, or a core job
  // not at all.
  const coreJobs: ScheduledJob[] = [];

  // The dashboard's history chart, not the posting pipeline — a separate
  // cron entirely, so its cadence (and whether it runs at all) is
  // independent of how often the bot actually posts. `stats.enabled`
  // controls only this automatic cadence — the panel's manual "Refresh"
  // trigger (wired above, into takeStatsSnapshotNow) works regardless, since
  // an explicit ask is different from an unattended background job.
  if (takeStatsSnapshotNow !== undefined && effective.stats.enabled) {
    const takeSnapshot = takeStatsSnapshotNow;
    // Fire one immediately rather than waiting for the first cron tick — a
    // freshly enabled panel would otherwise show an empty chart for up to a
    // full `stats.schedule` interval (6 hours, by default) with nothing
    // explaining why. Not awaited: a full history walk shouldn't hold up
    // startup, and a failure here is logged, never fatal.
    void takeSnapshot().catch((err) => {
      console.warn(`  warning: initial stats snapshot failed: ${err instanceof Error ? err.message : err}`);
    });
    const job = schedule(effective.stats.schedule, async () => {
      try {
        await takeSnapshot();
      } catch (err) {
        console.warn(`  warning: stats snapshot failed: ${err instanceof Error ? err.message : err}`);
      }
    });
    coreJobs.push(job);
    reconfigureHooks.push({ path: 'stats.schedule', apply: (v) => job.reschedule(v as string) });
  }

  // A schedule controls WHEN the bot attempts a post; posting.maxPostsPerHour
  // is a separate, independent ceiling on how many of those attempts actually
  // publish. Setting a source to fire twice an hour does nothing on its own
  // if the budget is still 1 — the second attempt is queued, not dropped, but
  // that is easy to mistake for the schedule simply not being applied. Only
  // meaningful in LIVE mode: dry-run posts are never budget-checked at all.
  if (!effective.posting.dryRun) {
    const attemptsPerHour = moduleJobs.reduce((sum, j) => sum + runsPerHour(j.cron), 0);
    if (attemptsPerHour > effective.posting.maxPostsPerHour) {
      console.log(
        `\nNote: your schedule(s) can attempt up to ${attemptsPerHour} post(s) in an hour, ` +
          `but posting.maxPostsPerHour is ${effective.posting.maxPostsPerHour} — the extra ` +
          'attempts are queued and published later (see "Rate limits and the retry queue" ' +
          'in the README), not dropped. Raise posting.maxPostsPerHour if you want them ' +
          'published as soon as they happen instead.',
      );
    }

    // Same idea, checked against the wallet's REAL current tier (known only
    // after the registration check above, hence a runtime warning here
    // rather than a config-time error — config validation is synchronous
    // and has no way to ask the chain whether this wallet is registered).
    const budgetWarning = dailyBudgetWarning(
      effective.posting.maxPostsPerHour,
      publisher.dailyLimit,
      publisher.registered,
    );
    if (budgetWarning !== undefined) console.log(`\n${budgetWarning}`);
  }

  console.log('\nRunning. Press Ctrl+C to stop.');

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      // Both SIGINT and SIGTERM can arrive in the same forceful kill; without
      // this guard a second signal re-stops already-stopped jobs, prints
      // "Stopping…" twice, and calls panel.close() a second time.
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\nStopping…');
      // Before any of the crons it might otherwise react to mid-shutdown.
      configWatcher?.close();
      // Core crons first, then every module through the registry — a module may
      // hold more than crons, and one module failing to stop must not leave the
      // others running. A "stopped" bot whose cron survived keeps posting.
      for (const job of coreJobs) job.stop();
      // AWAITED, not fire-and-forget. With one module whose stop is synchronous
      // nothing currently survives shutdown — but that is an accident of there
      // being one module. The moment a second registers, or a stop does real
      // async I/O, an un-awaited shutdown could resolve and exit while a cron is
      // still alive, and a "stopped" bot that keeps posting is the failure this
      // whole path exists to prevent.
      void stopAll(started, (m) => console.warn(m))
        .then(() => (panel === undefined ? undefined : panel.close().catch(() => {})))
        .finally(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  return 0;
}

/** Aggregate current engagement totals and append one snapshot to the history. */
async function takeStatsSnapshot(
  client: OgmaraClient,
  address: string,
  history: StatsHistory,
  statsConfig: Config['stats'],
): Promise<void> {
  const agg = await aggregateAllPostStats(
    (addr, options) => client.getUserPosts(addr, options),
    address,
    statsConfig.pageSize,
    statsConfig.maxPostsScanned,
  );
  history.append({ timestamp: Date.now(), ...agg });
}

/**
 * Start the control panel, translating config validation errors and bind
 * failures into the same "fail loudly at startup" style as the rest of `run`.
 */
async function startControlPanel(
  config: Config,
  secrets: Secrets,
  publisher: OgmaraPublisher,
  queue: PostQueue,
  statsHistory: StatsHistory,
  takeStatsSnapshotNow: () => Promise<void>,
  settingsDeps: SettingsDeps,
): Promise<Panel> {
  let trustedProxies: TrustedProxies;
  try {
    trustedProxies = new TrustedProxies(config.panel.trustedProxies);
  } catch (err) {
    // Reachable in principle even though the schema also validates CIDR shape
    // (config.ts's superRefine): keeping the check here too means a future
    // schema change can't silently drop it and leave this constructor as the
    // only backstop against a malformed trusted-proxy list.
    throw new ConfigError(
      `invalid panel.trustedProxies: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const auth = new PanelAuth({
    adminWallets: config.panel.adminWallets,
    botAddress: publisher.address,
    network: () => config.node.network,
    sessionTtlHours: config.panel.sessionTtlHours,
  });

  const panel = await startPanel(config.panel.bind, config.panel.port, {
    auth,
    trustedProxies,
    network: () => config.node.network,
    client: () => publisher.client,
    signer: publisher.signer,
    botAddress: publisher.address,
    walletKeyHex: secrets.walletKeyHex,
    dailyLimitFn: () => publisher.dailyLimit,
    burstLimitFn: () => publisher.burstLimit,
    dryRunFn: () => config.posting.dryRun,
    checkRegistration,
    applyProfile,
    registerWallet,
    allowedHosts: config.panel.allowedHosts,
    requireLogin: config.panel.requireLogin,
    isWalletBackupPending: () => isBackupPending(WALLET_BACKUP_PATH),
    acknowledgeWalletBackup: () => acknowledgeBackup(WALLET_BACKUP_PATH),
    fetchPostStats: () =>
      fetchPostStats(
        (address, options) => publisher.client.getUserPosts(address, options),
        publisher.address,
        DASHBOARD_POST_LIMIT,
      ),
    queuedCountFn: () => queue.size,
    fetchStatsHistory: () => Promise.resolve(statsHistory.all()),
    refreshStatsHistory: async () => {
      await takeStatsSnapshotNow();
      return statsHistory.all();
    },
    nodeUrl: () => config.node.url,
    fetchProfile: () => fetchProfile(publisher.client, publisher.address),
    setRegistered: (registered) => publisher.setRegistered(registered),
    settings: settingsDeps,
    botDescriptor: () => ({
      enabled: config.bot.enabled,
      ...(config.bot.handle !== undefined ? { handle: config.bot.handle } : {}),
      channels: config.bot.channels,
      commands: config.bot.commands,
    }),
    uploadAvatar: (bytes, mimeType, filename) => uploadAvatar(publisher.client, bytes, mimeType, filename),
  });

  console.log(
    `Panel:   http://${config.panel.bind}:${panel.port} ` +
      `(${auth.remoteLoginEnabled ? `${config.panel.adminWallets.length} wallet(s) authorised` : 'localhost-only, no remote login configured'})`,
  );
  if (!auth.remoteLoginEnabled && !config.panel.requireLogin) {
    console.log(
      '  Anyone able to reach this port from 127.0.0.1 gets full access with no login — ' +
        'that includes a reverse proxy on this host that forwards WITHOUT setting ' +
        'X-Forwarded-For. If you front this panel, either configure that header or set ' +
        'panel.requireLogin: true.',
    );
  }
  return panel;
}

/**
 * First-run convenience: scaffold `config.yaml` if it's missing, and — only
 * when a human is actually present to see and back it up — offer to
 * generate a wallet key if none is configured.
 *
 * @returns whether a summary was printed. When true, the caller should stop
 *          here: either something was just created (worth reviewing before
 *          a real run) or `--init` was passed explicitly as a status check.
 */
async function runBootstrap(args: CliArgs): Promise<boolean> {
  const configCreated = ensureConfigFile(args.configPath);

  const currentKey = process.env['OGMARA_WALLET_KEY'];
  const alreadyConfigured = currentKey !== undefined && currentKey.trim() !== '';

  let walletResult: WalletBootstrapResult = { generated: false };
  if (!alreadyConfigured) {
    // `--init` is itself the explicit ask; a bare run at a real terminal
    // still confirms first, since generating a wallet mints a real identity
    // and shouldn't happen as a side effect nobody consciously agreed to.
    // Neither path is taken for an unattended process (no TTY, no --init) —
    // that keeps today's behavior (a clear ConfigError) exactly as it was.
    const shouldGenerate =
      args.init ||
      (process.stdin.isTTY === true &&
        (await confirm('No wallet key is configured for this bot. Generate a new one now?')));
    if (shouldGenerate) {
      walletResult = await ensureWalletKey('.env', currentKey, WALLET_BACKUP_PATH);
    }
  }

  const hasNews = configCreated || walletResult.generated || walletResult.writeError !== undefined;
  if (!hasNews && !args.init) return false;

  console.log('');
  console.log(
    configCreated
      ? `Created ${args.configPath} from config.example.yaml — edit it before running for real.`
      : `${args.configPath} already exists.`,
  );

  if (walletResult.writeError !== undefined) {
    // Deliberately no key material here — see bootstrap.ts's WalletBootstrapResult
    // doc comment for why a freshly generated, unfunded key is discarded
    // rather than printed as a "last resort".
    console.log(
      `\nCould not save a new wallet key to "${walletResult.writeError.path}": ` +
        `${walletResult.writeError.message}`,
    );
    console.log('Fix that (permissions, disk space, path exists), then run --init again.');
  } else if (walletResult.generated) {
    console.log(`\nGenerated a new bot wallet: ${walletResult.address}`);
    console.log('Saved to .env.');
    console.log(
      '\n*** BACK UP YOUR .env FILE. This key is the only copy of this identity and\n' +
        '*** cannot be recovered if lost — anyone who obtains it can post as this\n' +
        '*** bot. The control panel will keep reminding you until you confirm the\n' +
        '*** backup there (panel.enabled: true).',
    );
  } else {
    // `process.env` can disagree with the file — that disagreement is
    // exactly what ensureWalletKey guards against (see bootstrap.ts's module
    // comment), and it means `alreadyConfigured` alone isn't trustworthy for
    // reporting either. Fall back to reading the file directly before ever
    // telling the operator "no key configured", so a refused-but-safe
    // generation attempt (the whole point of that guard) can't ALSO look
    // like the key went missing.
    const fileKey = alreadyConfigured ? currentKey : readWalletKeyFromFile('.env');
    if (fileKey !== undefined) {
      let address = 'unknown — check OGMARA_WALLET_KEY';
      try {
        address = (await WalletSigner.fromHex(fileKey)).address;
      } catch {
        // Leave the placeholder; loadSecrets will explain the real problem
        // in detail the next time something actually needs the key.
      }
      console.log(`\nWallet key already configured (${address}).`);
    } else {
      console.log(
        '\nNo wallet key configured yet. Run this again from a terminal to be asked, ' +
          'or set OGMARA_WALLET_KEY in .env yourself.',
      );
    }
  }

  console.log(
    `\nNext: edit ${args.configPath} (enable at least one source under sources:), ` +
      'add an AI provider key to .env, then run again.',
  );
  return true;
}

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  warnIfEnvReadable();

  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  if (args.showHelp) {
    console.log(HELP);
    return;
  }

  try {
    if (await runBootstrap(args)) return;

    if (args.setProfile || args.register) {
      const config = loadConfig(args.configPath);
      const secrets = loadSecrets();
      process.exitCode = args.setProfile
        ? await runSetProfile(config, secrets)
        : await runRegister(config, secrets, args.assumeYes);
      return;
    }
    process.exitCode = await run(args);
  } catch (err) {
    // Config and payload problems are the operator's to fix and deserve a
    // clean message; anything else is a genuine fault and keeps its stack.
    if (
      err instanceof ConfigError ||
      err instanceof InvalidPostError ||
      err instanceof AiConfigError ||
      err instanceof LockError ||
      err instanceof KleverError ||
      err instanceof NetworkMismatchError ||
      err instanceof DeviceIdentityError
    ) {
      console.error(`\n${err.name}: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    // err.stack, not the object: Node's inspector appends an error's own
    // enumerable properties, which on SDK errors means attached response
    // metadata. This is the one unbounded, unattended output path.
    console.error('\nUnexpected error:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

await main();
