/**
 * The bot module contract.
 *
 * `ogmara-bot` is no longer only a news bot. A *module* is one optional feature
 * an operator can switch on — news posting today, answering channel slash
 * commands next — and the point of this contract is that a module declares
 * everything about itself in one place:
 *
 *   - its config section AND the Zod schema for it,
 *   - whether it is enabled,
 *   - what must be true before the bot can start with it on,
 *   - how to run one pass, and how to run on a schedule.
 *
 * The payoff compounds: because a module owns its schema, the operator settings
 * page can render itself FROM that schema rather than being hand-written per
 * feature. A contributor adding a module gets config validation, settings UI and
 * documented options in one step, and cannot forget any of the three.
 *
 * ## What is NOT a module
 *
 * `node`, `panel`, `storage` and the wallet identity are CORE. They cannot be
 * switched off — without them there is no bot, and no way back in to fix a
 * misconfiguration. Only genuinely optional features are modules.
 *
 * ## Rules a module must not break
 *
 *   - **Route posting through the shared rate budget, never around it.** A
 *     module that publishes is a new posting path and gets the same budget as
 *     every other.
 *   - **`posting.dryRun` is global and a module cannot opt out of it.** It is
 *     the safety catch that lets an operator run a new module against a live
 *     network without publishing anything.
 *   - **Validate shape and caps in `schema`; never validate anything that
 *     depends on runtime or network state there.** Config load happens before
 *     the node is reachable — that belongs in `preflight`, which runs after.
 *     (Putting a network-dependent check in a Zod `.refine()` is what produced
 *     the 0.12.0 cadence bug.)
 */

import type { ZodTypeAny } from 'zod';
import type { Config, Secrets } from '../config.js';
import type { OgmaraPublisher } from '../ogmara.js';
import type { ScheduledJob } from '../scheduler.js';

/**
 * Everything a module is handed at startup.
 *
 * Deliberately narrow: a module gets the shared, core-owned services and its own
 * slice of config, not the whole process.
 */
export interface BotContext {
  /** Fully parsed config, including this module's own section. */
  readonly config: Config;
  /** Secrets from the environment. Never logged, never written to config. */
  readonly secrets: Secrets;
  /** The shared publisher — owns the wallet, the rate budget and dry-run. */
  readonly publisher: OgmaraPublisher;
  /** Structured console output, so module logs look like core logs. */
  readonly log: (message: string) => void;
  /** Non-fatal warning. */
  readonly warn: (message: string) => void;
}

/**
 * A cron job a module registered, with the expression that produced it.
 *
 * The expression is carried alongside the job because the core needs it: it
 * compares total scheduled attempts per hour against `posting.maxPostsPerHour`
 * and warns when a schedule can out-run the budget. `ScheduledJob` itself does
 * not expose its cron, and a module knowing its own schedules while the core
 * cannot see them would silently drop that warning.
 */
export interface ModuleJob {
  /** Short label for startup output, e.g. the source name. */
  readonly name: string;
  /** The cron expression, already validated by the module's schema. */
  readonly cron: string;
  readonly job: ScheduledJob;
  /**
   * The dotted config path whose value is this job's cron expression, if the
   * module wants it live-reschedulable — e.g. `'sources.rss.schedule'`.
   *
   * Absent means restart-required to change this job's schedule (there is
   * nothing for `index.ts` to wire a `ReconfigureHook` to). Present means
   * `index.ts` will register a hook that calls `job.reschedule(newValue)` —
   * so a module setting this promises `job.reschedule` actually retunes the
   * SAME running job, not merely that a job with this path exists.
   */
  readonly configPath?: string;
}

/** A module's live state, returned by `start`. */
export interface ModuleHandle {
  /**
   * Cron jobs the module registered, so the core can report them at startup and
   * stop them on shutdown. Empty is valid — a module need not be scheduled.
   */
  readonly jobs: readonly ModuleJob[];
  /** Release anything the module holds. Must be safe to call twice. */
  stop(): Promise<void>;
}

/** Something that must be true before the bot may start with this module on. */
export interface PreflightFailure {
  /** Operator-facing explanation, including how to fix it. */
  readonly message: string;
}

/**
 * How one config field is presented and treated by the settings UI.
 *
 * Deliberately NOT derived from the Zod schema. Zod knows a field is
 * `z.int().min(1).max(600)`; it does not know that changing it needs a restart,
 * that it spends money, or what to call it in seven languages. Those are
 * editorial facts about the field, and inventing them from types is how a
 * settings page ends up labelling things `perWalletPerMinute`.
 */
export interface UiField {
  /** i18n key for the label. The UI translates it like any other chrome. */
  readonly label: string;
  /** i18n key for help text shown under the input. */
  readonly help?: string;
  /**
   * Whether the running process picks this up, or it waits for a restart.
   *
   * The operator must never have to guess. A page that says "saved" for a value
   * that is inert until the next boot is worse than one that says nothing.
   */
  readonly restart: boolean;
  /**
   * Needs an explicit confirmation step rather than an autosaving control.
   *
   * For anything whose wrong value is expensive or public: turning off dry run
   * points a live wallet at a live network; spending KLV cannot be undone.
   */
  readonly confirm?: boolean;
  /**
   * Holds a secret. The API reports `{ set: boolean }` and never the value.
   *
   * Nothing in this config is secret today — every secret is an environment
   * variable, which is strictly safer — so this exists for the day a module
   * needs one, and to keep the API's contract honest in the meantime.
   */
  readonly secret?: boolean;
}

export interface BotModule {
  /** Stable id. Matches the module's config key. */
  readonly name: string;

  /**
   * Zod schema for this module's config section(s), keyed by config key.
   *
   * The single source of truth for the section: `config.ts` composes these
   * rather than declaring them, and the settings UI renders from them.
   */
  readonly schemas: Readonly<Record<string, ZodTypeAny>>;

  /**
   * Presentation metadata for this module's fields, keyed by dotted config path
   * (`bot.rateLimit.perWalletPerMinute`).
   *
   * A field with no entry is still editable — it renders from its schema with a
   * humanised label — but is assumed RESTART-required, not live. `describeFields`
   * (panel/settings.ts) defaults a missing `restart` to `true`: "we do not know
   * whether this applies live" must read as "not applied yet," never the other
   * way around, or the settings page ends up promising something no code
   * actually does. Declare `restart: false` explicitly once a real live-apply
   * path exists for a field — see `settingsDeps.ts`'s `ReconfigureHook` for
   * fields that need one, or the surrounding code for ones that don't (already
   * read fresh off `ctx.config` every time). The map is for the facts the
   * schema cannot carry, not a second declaration of every field.
   */
  readonly uiSchema?: Readonly<Record<string, UiField>>;

  /**
   * Whether the operator has switched this module on.
   *
   * An absent or disabled config section means "not started" — never an error.
   * A bot running only the panel, with every module off, is a valid deployment.
   */
  isEnabled(config: Config): boolean;

  /**
   * Checks that need the node, the filesystem or the AI provider — anything
   * unavailable at config-load time. Returning a failure aborts startup with
   * that message rather than starting a module that cannot work.
   */
  preflight?(ctx: BotContext): Promise<PreflightFailure | null>;

  /** Run exactly one pass and return. Backs `--once`. */
  runOnce?(ctx: BotContext): Promise<void>;

  /** Begin scheduled operation. */
  start(ctx: BotContext): Promise<ModuleHandle>;
}
