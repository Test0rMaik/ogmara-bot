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
  readonly provider: AiProvider;
  readonly templates: Templates;
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

export function createNewsModule(deps: NewsDeps): BotModule {
  let sources: Source[] = [];
  // Tracks whether the build RAN, not whether it produced anything. Guarding on
  // `sources.length === 0` re-ran it — and re-emitted its warnings — whenever
  // every enabled source was unconfigured, which is exactly the case that warns.
  let built = false;

  const ensureSources = (ctx: BotContext): void => {
    if (built) return;
    sources = buildSources(ctx.config, ctx.warn);
    built = true;
  };

  const pipelineDeps = (ctx: BotContext): Parameters<typeof runPipelineOnce>[0] => ({
    config: ctx.config,
    sources,
    ledger: deps.ledger,
    queue: deps.queue,
    publisher: ctx.publisher,
    provider: deps.provider,
    templates: deps.templates,
  });

  return {
    name: 'news',

    schemas: { sources: sourcesSchema as ZodTypeAny },

    // Cron schedules and the source list are read once, at `start()`, and
    // registered as jobs — there is no live-apply path, so a change is
    // restart-required across the board.
    uiSchema: {
      'sources.rss.enabled': { label: 'field.sources.rss.enabled.label', restart: true },
      'sources.rss.schedule': { label: 'field.sources.rss.schedule.label', restart: true },
      'sources.rss.feeds': {
        label: 'field.sources.rss.feeds.label',
        help: 'field.sources.rss.feeds.help',
        restart: true,
      },
      'sources.topics.enabled': { label: 'field.sources.topics.enabled.label', restart: true },
      'sources.topics.schedule': { label: 'field.sources.topics.schedule.label', restart: true },
      'sources.topics.topics': {
        label: 'field.sources.topics.topics.label',
        help: 'field.sources.topics.topics.help',
        restart: true,
      },
      'sources.imagedir.enabled': { label: 'field.sources.imagedir.enabled.label', restart: true },
      'sources.imagedir.schedule': { label: 'field.sources.imagedir.schedule.label', restart: true },
      'sources.imagedir.directories': {
        label: 'field.sources.imagedir.directories.label',
        help: 'field.sources.imagedir.directories.help',
        restart: true,
      },
    },

    isEnabled: newsEnabled,

    async preflight(ctx: BotContext): Promise<PreflightFailure | null> {
      // Built here rather than in `start`, so a source that is enabled but
      // unconfigured warns before any precondition is judged.
      ensureSources(ctx);

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

      if (!deps.provider.supportsVision) {
        return {
          message:
            `\nsources.imagedir is enabled but the configured model ` +
            `(${deps.provider.id}/${deps.provider.model}) cannot accept images.\n` +
            'Use a vision-capable model, or set ai.compatibleSupportsVision: true if your ' +
            'local model does support them.',
        };
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
      ensureSources(ctx);
      deps.report(await runPipelineOnce(pipelineDeps(ctx)));
    },

    async start(ctx: BotContext): Promise<ModuleHandle> {
      ensureSources(ctx);

      // One job per enabled source, each on its own cron. They share the run
      // pipeline, and the scheduler's overlap guard is per-job, so two sources
      // firing on the same minute run sequentially rather than racing the
      // ledger.
      const wanted: Array<{ name: string; cron: string }> = [];
      if (ctx.config.sources.rss.enabled) {
        wanted.push({ name: 'rss', cron: ctx.config.sources.rss.schedule });
      }
      if (ctx.config.sources.topics.enabled) {
        wanted.push({ name: 'topics', cron: ctx.config.sources.topics.schedule });
      }
      if (ctx.config.sources.imagedir.enabled) {
        wanted.push({ name: 'imagedir', cron: ctx.config.sources.imagedir.schedule });
      }

      ctx.log(`Sources: ${sources.map((src) => src.name).join(', ')}`);

      const jobs: ModuleJob[] = [];
      for (const { name, cron } of wanted) {
        const job = schedule(cron, async () => {
          ctx.log(`\n[${new Date().toISOString()}] ${name} run`);
          deps.report(await runPipelineOnce(pipelineDeps(ctx)));
        });
        jobs.push({ name, cron, job });
        ctx.log(`Schedule: ${name} "${cron}" — next ${job.nextRun()?.toISOString() ?? 'never'}`);
      }

      return {
        jobs,
        async stop(): Promise<void> {
          for (const { job } of jobs) job.stop();
        },
      };
    },
  };
}
