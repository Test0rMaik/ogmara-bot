/**
 * The `news` module — AI-composed posts to the Ogmara News Feed.
 *
 * This is the bot's original and, until the `commands` module lands, only
 * feature. It owns the `sources:` config section, the per-source cron schedules,
 * and the run pipeline.
 *
 * It deliberately WRAPS `pipeline.ts` / `sources/` rather than relocating them.
 * Moving those files would churn imports across the test suite for no
 * behavioural gain; what makes this a module is that enablement, preflight,
 * scheduling and the config schema now live in one place behind a contract,
 * not that the files sit in a particular directory. Relocation can follow later
 * if it ever buys something.
 */

import type { ZodTypeAny } from 'zod';
import type { Config } from '../config.js';
import { sourcesSchema } from '../config.js';
import type { AiProvider } from '../ai/index.js';
import type { Ledger } from '../ledger.js';
import type { PostQueue } from '../queue.js';
import type { Source } from '../sources/types.js';
import { ImageDirSource } from '../sources/imagedir.js';
import { RssSource } from '../sources/rss.js';
import { TopicsSource } from '../sources/topics.js';
import { runOnce as runPipelineOnce, type RunOutcome, type Templates } from '../pipeline.js';
import { schedule } from '../scheduler.js';
import type {
  BotContext,
  BotModule,
  ModuleHandle,
  ModuleJob,
  PreflightFailure,
} from './types.js';

/**
 * Services the news module needs that the core builds once and shares.
 *
 * Passed in rather than constructed here: the ledger and queue are on-disk state
 * guarded by the data lock, and the AI provider is shared with anything else
 * that composes text. A module creating its own would duplicate both.
 */
export interface NewsDeps {
  readonly ledger: Ledger;
  readonly queue: PostQueue;
  /**
   * `ai.provider`/`model`/`baseUrl`/`effort`/`maxTokens` and the three
   * `*PromptPath` fields are all now live-appliable — functions, not plain
   * values, so a reconfigure hook rebuilding the provider or reloading a
   * template file is observed on the very next pipeline run rather than
   * only after a restart. Same live-read idiom as `PanelDeps.dailyLimitFn`
   * etc.
   */
  readonly provider: () => AiProvider;
  readonly templates: () => Templates;
  /** Called with each run's outcome so the core can report it consistently. */
  readonly report: (outcome: RunOutcome) => void;
  /**
   * The node health the core already fetched for its startup banner.
   *
   * Passed in rather than re-fetched: `publisher.health()` is a network round
   * trip, and the pre-refactor code reused this exact value for the imagedir
   * media check. Calling it again would add a second startup round trip for no
   * new information.
   */
  readonly health: { readonly mediaUploads: boolean };
}

/** Build the enabled sources, warning about ones switched on but unconfigured. */
export function buildSources(config: Config, warn: (m: string) => void): Source[] {
  const sources: Source[] = [];

  const rss = config.sources.rss;
  if (rss.enabled) {
    if (rss.feeds.length === 0) {
      warn('Warning: sources.rss is enabled but no feeds are configured.');
    } else {
      sources.push(
        new RssSource({
          feeds: rss.feeds,
          timeoutMs: rss.timeoutMs,
          maxBytes: rss.maxBytes,
          maxAgeDays: rss.maxAgeDays,
        }),
      );
    }
  }

  const topics = config.sources.topics;
  if (topics.enabled) {
    if (topics.topics.length === 0) {
      warn('Warning: sources.topics is enabled but no topics are configured.');
    } else {
      sources.push(
        new TopicsSource({ topics: topics.topics, minIntervalHours: topics.minIntervalHours }),
      );
    }
  }

  const imagedir = config.sources.imagedir;
  if (imagedir.enabled) {
    if (imagedir.directories.length === 0) {
      warn('Warning: sources.imagedir is enabled but no directories are configured.');
    } else {
      sources.push(
        new ImageDirSource({ directories: imagedir.directories, maxBytes: imagedir.maxBytes }),
      );
    }
  }

  return sources;
}

/** Whether any news source is switched on. */
export function newsEnabled(config: Config): boolean {
  const s = config.sources;
  return s.rss.enabled || s.topics.enabled || s.imagedir.enabled;
}

/**
 * The imagedir/vision precondition, as a plain message-or-null so both the
 * startup preflight check AND a live `ai.*` reconfigure can enforce it —
 * the latter needs this to survive an operator switching to a text-only
 * model AFTER boot, since preflight itself only ever runs once, at startup.
 */
export function imagedirVisionError(config: Config, provider: AiProvider): string | null {
  if (!config.sources.imagedir.enabled || provider.supportsVision) return null;
  return (
    `sources.imagedir is enabled but the configured model ` +
    `(${provider.id}/${provider.model}) cannot accept images.\n` +
    'Use a vision-capable model, or set ai.compatibleSupportsVision: true if your ' +
    'local model does support them.'
  );
}

/** What `reconfigure()`/`start()` want the news module's job set to look like. */
function wantedJobs(config: Config): Array<{ name: string; cron: string }> {
  const wanted: Array<{ name: string; cron: string }> = [];
  if (config.sources.rss.enabled) wanted.push({ name: 'rss', cron: config.sources.rss.schedule });
  if (config.sources.topics.enabled) {
    wanted.push({ name: 'topics', cron: config.sources.topics.schedule });
  }
  if (config.sources.imagedir.enabled) {
    wanted.push({ name: 'imagedir', cron: config.sources.imagedir.schedule });
  }
  return wanted;
}

export function createNewsModule(deps: NewsDeps): BotModule {
  let sources: Source[] = [];
  // The SAME array `ModuleHandle.jobs` (from `start()`) exposes, mutated in
  // place by `reconfigure()` rather than ever replaced — this is what lets
  // a job created/removed long after `start()` returned still show up
  // correctly to whatever holds the original `ModuleHandle` (index.ts's
  // `started` list, its shutdown loop). See `reconfigure()`'s own comment
  // for why sources.* needed this and bot.* (B4) did not.
  const jobs: ModuleJob[] = [];

  // Rebuilt fresh on every call — preflight/runOnce/start/reconfigure all
  // need the CURRENT config's sources, not whatever was true the first time
  // this ran. `buildSources` itself is cheap (no I/O, just constructing
  // plain option objects) and its warnings are one line per genuinely
  // unconfigured-but-enabled source, which is exactly the information an
  // operator needs to see again if they just changed something and it is
  // STILL unconfigured.
  const rebuildSources = (ctx: BotContext): void => {
    sources = buildSources(ctx.config, ctx.warn);
  };

  const runSourceJob = (ctx: BotContext, name: string) => async (): Promise<void> => {
    ctx.log(`\n[${new Date().toISOString()}] ${name} run`);
    deps.report(await runPipelineOnce(pipelineDeps(ctx)));
  };

  const pipelineDeps = (ctx: BotContext): Parameters<typeof runPipelineOnce>[0] => ({
    config: ctx.config,
    sources,
    ledger: deps.ledger,
    queue: deps.queue,
    publisher: ctx.publisher,
    // Called fresh here, on every pipeline run — not once at module
    // construction — so a live ai.* reconfigure is observed on the very
    // next run. `pipeline.ts` itself still takes plain values: a one-shot
    // run doesn't need to re-read anything mid-flight.
    provider: deps.provider(),
    templates: deps.templates(),
  });

  return {
    name: 'news',

    schemas: { sources: sourcesSchema as ZodTypeAny },

    // `enabled`/`schedule`/`feeds`/`topics`/`directories` (+ rss's
    // `maxAgeDays`/`timeoutMs`/`maxBytes`) are all live via `reconfigure()`
    // below, which rebuilds `sources: Source[]` fresh and reconciles the
    // cron job set to match. The remaining fields (fetchImages, the two
    // image-size/timeout caps, imagedir's contentRating) were already live
    // — read fresh out of `config.sources.*` on every pipeline run, no
    // reconfigure hook ever needed for those.
    uiSchema: {
      'sources.rss.enabled': { label: 'field.sources.rss.enabled.label', restart: false },
      'sources.rss.schedule': { label: 'field.sources.rss.schedule.label', restart: false },
      'sources.rss.feeds': {
        label: 'field.sources.rss.feeds.label',
        help: 'field.sources.rss.feeds.help',
        restart: false,
      },
      'sources.rss.maxAgeDays': { label: 'field.sources.rss.maxAgeDays.label', restart: false },
      'sources.rss.timeoutMs': { label: 'field.sources.rss.timeoutMs.label', restart: false },
      'sources.rss.maxBytes': { label: 'field.sources.rss.maxBytes.label', restart: false },
      'sources.rss.fetchImages': {
        label: 'field.sources.rss.fetchImages.label',
        restart: false, // read live: pipeline.ts
      },
      'sources.rss.maxImageBytes': {
        label: 'field.sources.rss.maxImageBytes.label',
        restart: false, // read live: pipeline.ts
      },
      'sources.rss.imageTimeoutMs': {
        label: 'field.sources.rss.imageTimeoutMs.label',
        restart: false, // read live: pipeline.ts
      },
      'sources.topics.enabled': { label: 'field.sources.topics.enabled.label', restart: false },
      'sources.topics.schedule': { label: 'field.sources.topics.schedule.label', restart: false },
      'sources.topics.topics': {
        label: 'field.sources.topics.topics.label',
        help: 'field.sources.topics.topics.help',
        restart: false,
      },
      'sources.topics.minIntervalHours': {
        label: 'field.sources.topics.minIntervalHours.label',
        restart: false,
      },
      'sources.imagedir.enabled': { label: 'field.sources.imagedir.enabled.label', restart: false },
      'sources.imagedir.schedule': { label: 'field.sources.imagedir.schedule.label', restart: false },
      'sources.imagedir.directories': {
        label: 'field.sources.imagedir.directories.label',
        help: 'field.sources.imagedir.directories.help',
        restart: false,
      },
      'sources.imagedir.maxBytes': {
        label: 'field.sources.imagedir.maxBytes.label',
        restart: false, // read live: pipeline.ts
      },
      'sources.imagedir.contentRating': {
        label: 'field.sources.imagedir.contentRating.label',
        restart: false, // read live: pipeline.ts
      },
    },

    isEnabled: newsEnabled,

    async preflight(ctx: BotContext): Promise<PreflightFailure | null> {
      // Built here rather than in `start`, so a source that is enabled but
      // unconfigured warns before any precondition is judged.
      rebuildSources(ctx);

      // Every source switched on, none actually configured — e.g.
      // `rss.enabled: true` with `feeds: []`. This was a FATAL startup condition
      // before the module refactor and must stay one: otherwise the bot happily
      // schedules a cron that calls an empty pipeline forever, and an operator
      // who mistyped a config key sees a running bot that silently never posts.
      // The schema cannot catch this (`feeds` legitimately defaults to `[]`),
      // which is precisely what preflight is for.
      if (sources.length === 0) {
        return {
          message:
            '\nEvery enabled source under `sources:` is unconfigured — rss has no feeds, ' +
            'topics has no topics, or imagedir has no directories.\n' +
            'Configure at least one, or set its `enabled: false` if you did not mean to ' +
            'switch it on.',
        };
      }

      // Both checks below are imagedir-only and both need state that does not
      // exist at config-load time — the provider's capabilities and the node's
      // health — which is exactly why they live in preflight rather than in a
      // Zod refinement.
      if (!ctx.config.sources.imagedir.enabled) return null;

      const visionError = imagedirVisionError(ctx.config, deps.provider());
      if (visionError !== null) {
        return { message: `\n${visionError}` };
      }

      if (!deps.health.mediaUploads) {
        return {
          message:
            '\nsources.imagedir is enabled but the node reports media uploads are unavailable ' +
            '(its IPFS backend is offline).\nStart IPFS on the node, or point the bot at a ' +
            'media-capable node.',
        };
      }

      return null;
    },

    async runOnce(ctx: BotContext): Promise<void> {
      rebuildSources(ctx);
      deps.report(await runPipelineOnce(pipelineDeps(ctx)));
    },

    async start(ctx: BotContext): Promise<ModuleHandle> {
      rebuildSources(ctx);

      // One job per enabled source, each on its own cron. They share the run
      // pipeline, and the scheduler's overlap guard is per-job, so two sources
      // firing on the same minute run sequentially rather than racing the
      // ledger.
      ctx.log(`Sources: ${sources.map((src) => src.name).join(', ')}`);

      for (const { name, cron } of wantedJobs(ctx.config)) {
        const job = schedule(cron, runSourceJob(ctx, name));
        jobs.push({ name, cron, job });
        ctx.log(`Schedule: ${name} "${cron}" — next ${job.nextRun()?.toISOString() ?? 'never'}`);
      }

      return {
        // The SAME array, not a copy — `reconfigure()` mutates it in place
        // (push/splice), so whatever holds this `ModuleHandle` (index.ts's
        // `started` list) sees every later add/remove without needing to
        // know a reconfigure ever happened. `stop()` below reads it fresh
        // for the identical reason.
        jobs,
        async stop(): Promise<void> {
          for (const { job } of jobs) job.stop();
        },
      };
    },

    /**
     * Live-apply any `sources.*` field this module's `uiSchema` marks
     * `restart: false`: `enabled`/`schedule`/`feeds`/`topics`/`directories`/
     * rss's `maxAgeDays`/`timeoutMs`/`maxBytes`/topics's `minIntervalHours`.
     *
     * Unlike `commands`'s `reconfigure()` (B4), this one genuinely needs
     * `jobs` mutated in place rather than replaced wholesale: a source
     * toggled on/off live must add or remove exactly its OWN cron job
     * without disturbing the other two, which is precisely the "job list
     * must be mutated in place, never replaced" concern the original
     * hot-reload plan flagged as a prerequisite before any module's job set
     * could change shape after `start()` — B4 didn't end up needing it (its
     * one job, `autoJoinJob`, is never touched by `reconfigure()`); this is
     * the phase where it actually bites.
     *
     * No validation gate before committing, unlike `commands`'s
     * `reconfigure()`: an enabled-but-unconfigured source is a WARN, not a
     * FATAL condition here (see `buildSources`) — `preflight()`'s FATAL
     * case is "EVERY enabled source is unconfigured," which `sourcesSchema`
     * itself now refuses at the config layer before a save can ever reach
     * this function (see `config.ts`'s `sourcesSchema.superRefine`,
     * mirroring `commands/schema.ts`'s identical fix for `bot.channels`) —
     * so there is no invalid-but-schema-valid combination left for this
     * function to reject the way `commands`'s `reconfigure()` must.
     *
     * Fully synchronous internally (`buildSources`/job create-stop-
     * reschedule are all synchronous — the Source constructors do no I/O,
     * only `.poll()` does), so — unlike `commands`'s `reconfigure()` — this
     * needs no reentrancy guard: with no `await` inside, two hooks firing
     * in the same `commit()` dispatch tick cannot interleave; the first
     * call's entire body runs to completion before the second one starts.
     */
    async reconfigure(ctx: BotContext): Promise<void> {
      rebuildSources(ctx);
      ctx.log(`Sources: ${sources.map((src) => src.name).join(', ')}`);

      const wanted = wantedJobs(ctx.config);
      const wantedByName = new Map(wanted.map((w) => [w.name, w.cron]));

      // Stop and drop jobs for sources no longer enabled. Iterated backwards
      // so `splice` doesn't skip the element after the one just removed.
      for (let i = jobs.length - 1; i >= 0; i -= 1) {
        const job = jobs[i];
        if (job !== undefined && !wantedByName.has(job.name)) {
          job.job.stop();
          jobs.splice(i, 1);
        }
      }

      for (const { name, cron } of wanted) {
        const i = jobs.findIndex((j) => j.name === name);
        if (i === -1) {
          // Newly enabled: create its job and add it to the shared array.
          const job = schedule(cron, runSourceJob(ctx, name));
          jobs.push({ name, cron, job });
          ctx.log(`Sources: ${name} enabled — schedule "${cron}"`);
          continue;
        }
        const existing = jobs[i];
        if (existing !== undefined && existing.cron !== cron) {
          // Still enabled, schedule changed: reschedule the SAME job object
          // in place (see ScheduledJob.reschedule's own doc comment — every
          // existing holder keeps working unchanged), then replace the
          // array element to keep its `cron` field (readonly) accurate.
          existing.job.reschedule(cron);
          jobs[i] = { name, cron, job: existing.job };
          ctx.log(`Sources: ${name} rescheduled to "${cron}"`);
        }
      }
    },
  };
}
