import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import type { AiProvider } from '../ai/index.js';
import type { BotContext } from './types.js';
import {
  buildSources,
  createNewsModule,
  imagedirVisionError,
  newsEnabled,
  type NewsDeps,
} from './news.js';

function configWith(over: {
  rss?: { enabled?: boolean; feeds?: unknown[]; schedule?: string };
  topics?: { enabled?: boolean; topics?: unknown[]; schedule?: string };
  imagedir?: { enabled?: boolean; directories?: unknown[]; schedule?: string };
}): Config {
  return {
    sources: {
      rss: {
        enabled: false,
        feeds: [],
        schedule: '0 * * * *',
        timeoutMs: 1000,
        maxBytes: 1000,
        maxAgeDays: 2,
        ...over.rss,
      },
      topics: {
        enabled: false,
        topics: [],
        schedule: '0 * * * *',
        minIntervalHours: 1,
        ...over.topics,
      },
      imagedir: {
        enabled: false,
        directories: [],
        schedule: '0 * * * *',
        maxBytes: 1000,
        ...over.imagedir,
      },
    },
  } as unknown as Config;
}

function ctxWith(config: Config, warn = vi.fn()): { ctx: BotContext; warn: ReturnType<typeof vi.fn> } {
  return {
    ctx: {
      config,
      secrets: {},
      publisher: { health: vi.fn() },
      log: () => {},
      warn,
    } as unknown as BotContext,
    warn,
  };
}

function depsWith(over: Partial<NewsDeps> = {}): NewsDeps {
  return {
    ledger: {} as NewsDeps['ledger'],
    queue: {} as NewsDeps['queue'],
    provider: (() => ({ id: 'openai', model: 'gpt-x', supportsVision: true })) as NewsDeps['provider'],
    templates: (() => ({ rss: '', topics: '', imagedir: '' })) as NewsDeps['templates'],
    report: () => {},
    health: { mediaUploads: true },
    ...over,
  };
}

describe('newsEnabled', () => {
  it('reports enabled from the flags alone, before anything is configured', () => {
    // Deliberate: enablement is "the operator switched it on", which is a
    // different question from "it is usable". The second is preflight's job —
    // see the fatal-when-unconfigured test below.
    expect(newsEnabled(configWith({ rss: { enabled: true, feeds: [] } }))).toBe(true);
    expect(newsEnabled(configWith({}))).toBe(false);
  });
});

describe('imagedirVisionError', () => {
  const visionProvider = { id: 'openai', model: 'gpt-x', supportsVision: true } as AiProvider;
  const textOnlyProvider = { id: 'openai', model: 'text-only-x', supportsVision: false } as AiProvider;

  it('is null when imagedir is disabled, regardless of the model', () => {
    expect(imagedirVisionError(configWith({}), textOnlyProvider)).toBeNull();
  });

  it('is null when imagedir is enabled and the model supports vision', () => {
    expect(imagedirVisionError(configWith({ imagedir: { enabled: true } }), visionProvider)).toBeNull();
  });

  it('names the offending model when imagedir is enabled on a text-only model', () => {
    const message = imagedirVisionError(configWith({ imagedir: { enabled: true } }), textOnlyProvider);
    expect(message).not.toBeNull();
    expect(message).toContain('text-only-x');
    expect(message).toContain('cannot accept images');
  });
});

describe('buildSources', () => {
  it('warns, and yields nothing, for a source enabled but unconfigured', () => {
    const warn = vi.fn();
    const sources = buildSources(configWith({ rss: { enabled: true, feeds: [] } }), warn);
    expect(sources).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('sources.rss is enabled but no feeds');
  });

  it('skips sources that are switched off entirely, without warning', () => {
    const warn = vi.fn();
    expect(buildSources(configWith({}), warn)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('news module preflight', () => {
  it('is FATAL when every enabled source is unconfigured', async () => {
    // REGRESSION GUARD. Before the module refactor this was a hard startup
    // error. Extracting news behind the contract briefly turned it into a
    // silent no-op: the module counted as "enabled" from the flag, startup
    // proceeded, and a cron was scheduled that called an empty pipeline
    // forever — so an operator who mistyped a config key saw a running bot
    // that never posted and never said why.
    const { ctx } = ctxWith(configWith({ rss: { enabled: true, feeds: [] } }));
    const mod = createNewsModule(depsWith());
    const failure = await mod.preflight!(ctx);
    expect(failure).not.toBeNull();
    expect(failure!.message).toContain('unconfigured');
  });

  it('passes when at least one source is actually configured', async () => {
    const { ctx } = ctxWith(
      configWith({ rss: { enabled: true, feeds: [{ url: 'https://example.com/f.xml' }] } }),
    );
    expect(await createNewsModule(depsWith()).preflight!(ctx)).toBeNull();
  });

  it('re-warns on every rebuild, not just the first — required for sources.* to be live', async () => {
    // Was "warns exactly once, not twice": a `built` guard used to make
    // `buildSources` run only on the module's FIRST call, specifically to
    // avoid re-emitting this exact warning on a second call against the
    // same unchanged config. That guard is gone: a live reconfigure() has
    // to re-run `buildSources` to ever pick up an operator's fix (adding a
    // feed, say) — a "build once, never again" module could not make
    // sources.* live at all. Re-warning once per call against a config
    // that is STILL unconfigured is the accepted, minor cost of that; an
    // operator actively checking on a source they just tried to fix
    // benefits from seeing the CURRENT state every time, not a stale
    // "already warned, staying silent forever" one.
    const { ctx, warn } = ctxWith(configWith({ rss: { enabled: true, feeds: [] } }));
    const mod = createNewsModule(depsWith());
    await mod.preflight!(ctx);
    await mod.runOnce!(ctx).catch(() => {}); // pipeline stubs are empty; only the warn count matters
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('refuses imagedir on a model that cannot see, naming the model', async () => {
    const { ctx } = ctxWith(
      configWith({ imagedir: { enabled: true, directories: ['/tmp/pics'] } }),
    );
    const deps = depsWith({
      provider: (() => ({
        id: 'openai',
        model: 'text-only-x',
        supportsVision: false,
      })) as NewsDeps['provider'],
    });
    const failure = await createNewsModule(deps).preflight!(ctx);
    expect(failure!.message).toContain('cannot accept images');
    expect(failure!.message).toContain('text-only-x');
  });

  it('refuses imagedir when the node has no media uploads', async () => {
    const { ctx } = ctxWith(
      configWith({ imagedir: { enabled: true, directories: ['/tmp/pics'] } }),
    );
    const deps = depsWith({ health: { mediaUploads: false } });
    const failure = await createNewsModule(deps).preflight!(ctx);
    expect(failure!.message).toContain('media uploads are unavailable');
  });

  it('does not re-fetch node health — it uses what the core already had', async () => {
    // `publisher.health()` is a network round trip the core already made for its
    // startup banner. The pre-refactor code reused that value; re-fetching here
    // would add a second round trip at every startup for no new information.
    const { ctx } = ctxWith(
      configWith({ imagedir: { enabled: true, directories: ['/tmp/pics'] } }),
    );
    await createNewsModule(depsWith()).preflight!(ctx);
    expect((ctx.publisher as unknown as { health: ReturnType<typeof vi.fn> }).health)
      .not.toHaveBeenCalled();
  });

  it('reads deps.provider() fresh on every call — a live provider swap is observed without recreating the module', async () => {
    // Regression guard for the ai.* hot-reload path: `deps.provider` is a
    // function precisely so a reconfigure hook rebuilding the provider (see
    // index.ts's rebuildAiProvider) takes effect on the module's NEXT run,
    // not only for a module built fresh after a restart.
    let current: AiProvider = { id: 'openai', model: 'gpt-x', supportsVision: true } as AiProvider;
    const { ctx } = ctxWith(
      configWith({ imagedir: { enabled: true, directories: ['/tmp/pics'] } }),
    );
    const mod = createNewsModule(depsWith({ provider: () => current }));

    expect(await mod.preflight!(ctx)).toBeNull();

    current = { id: 'openai', model: 'text-only-x', supportsVision: false } as AiProvider;
    const failure = await mod.preflight!(ctx);
    expect(failure).not.toBeNull();
    expect(failure!.message).toContain('text-only-x');
  });
});

describe('news module start', () => {
  it('registers one job per enabled source, carrying its cron expression', async () => {
    // The cron travels on the handle because the core compares total scheduled
    // attempts per hour against posting.maxPostsPerHour — a warning it can only
    // produce if it can see the schedules the module registered.
    const { ctx } = ctxWith(
      configWith({
        rss: { enabled: true, feeds: [{ url: 'https://example.com/f.xml' }], schedule: '0 * * * *' },
        topics: { enabled: true, topics: ['klever'], schedule: '30 * * * *' },
      }),
    );
    const mod = createNewsModule(depsWith());
    await mod.preflight!(ctx);
    const handle = await mod.start(ctx);
    try {
      expect(handle.jobs.map((j) => j.name)).toEqual(['rss', 'topics']);
      expect(handle.jobs.map((j) => j.cron)).toEqual(['0 * * * *', '30 * * * *']);
    } finally {
      await handle.stop();
    }
  });

  it('stop() is safe to call twice', async () => {
    // Both SIGINT and SIGTERM can arrive in the same forceful kill.
    const { ctx } = ctxWith(
      configWith({ rss: { enabled: true, feeds: [{ url: 'https://example.com/f.xml' }] } }),
    );
    const mod = createNewsModule(depsWith());
    await mod.preflight!(ctx);
    const handle = await mod.start(ctx);
    await handle.stop();
    await expect(handle.stop()).resolves.toBeUndefined();
  });
});

describe('news module reconfigure', () => {
  it('adds a job for a newly-enabled source without disturbing the existing one', async () => {
    const { ctx: ctx1 } = ctxWith(
      configWith({ rss: { enabled: true, feeds: [{ url: 'https://example.com/f.xml' }] } }),
    );
    const mod = createNewsModule(depsWith());
    await mod.preflight!(ctx1);
    const handle = await mod.start(ctx1);
    const rssJob = handle.jobs.find((j) => j.name === 'rss');

    const { ctx: ctx2 } = ctxWith(
      configWith({
        rss: { enabled: true, feeds: [{ url: 'https://example.com/f.xml' }] },
        topics: { enabled: true, topics: ['klever'], schedule: '30 * * * *' },
      }),
    );
    await mod.reconfigure!(ctx2);

    // The SAME ModuleHandle.jobs array reflects the addition — mutated in
    // place, not replaced — and the original rss job is untouched.
    expect(handle.jobs.map((j) => j.name).sort()).toEqual(['rss', 'topics']);
    expect(handle.jobs.find((j) => j.name === 'rss')?.job).toBe(rssJob?.job);
    await handle.stop();
  });

  it('stops and removes the job for a source disabled live', async () => {
    const { ctx: ctx1 } = ctxWith(
      configWith({
        rss: { enabled: true, feeds: [{ url: 'https://example.com/f.xml' }] },
        topics: { enabled: true, topics: ['klever'] },
      }),
    );
    const mod = createNewsModule(depsWith());
    await mod.preflight!(ctx1);
    const handle = await mod.start(ctx1);
    const rssJob = handle.jobs.find((j) => j.name === 'rss')?.job;
    const stopSpy = rssJob ? vi.spyOn(rssJob, 'stop') : undefined;

    const { ctx: ctx2 } = ctxWith(
      configWith({ topics: { enabled: true, topics: ['klever'] } }), // rss now disabled
    );
    await mod.reconfigure!(ctx2);

    expect(handle.jobs.map((j) => j.name)).toEqual(['topics']);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it('reschedules the SAME job object in place when only the schedule changes', async () => {
    const { ctx: ctx1 } = ctxWith(
      configWith({
        rss: { enabled: true, feeds: [{ url: 'https://example.com/f.xml' }], schedule: '0 * * * *' },
      }),
    );
    const mod = createNewsModule(depsWith());
    await mod.preflight!(ctx1);
    const handle = await mod.start(ctx1);
    const before = handle.jobs.find((j) => j.name === 'rss')?.job;

    const { ctx: ctx2 } = ctxWith(
      configWith({
        rss: { enabled: true, feeds: [{ url: 'https://example.com/f.xml' }], schedule: '30 * * * *' },
      }),
    );
    await mod.reconfigure!(ctx2);

    expect(handle.jobs.find((j) => j.name === 'rss')?.cron).toBe('30 * * * *');
    // Same underlying ScheduledJob — reschedule()'d in place, not a stop
    // for one job and a create for another that would orphan whatever
    // else might reference the original.
    expect(handle.jobs.find((j) => j.name === 'rss')?.job).toBe(before);
    await handle.stop();
  });

  it('rebuilds sources so a feed added live is actually used on the next run', async () => {
    const { ctx: ctx1 } = ctxWith(configWith({ rss: { enabled: true, feeds: [] } }));
    const mod = createNewsModule(depsWith());
    await mod.preflight!(ctx1);
    const handle = await mod.start(ctx1);

    const { ctx: ctx2 } = ctxWith(
      configWith({ rss: { enabled: true, feeds: [{ url: 'https://example.com/f.xml' }] } }),
    );
    await mod.reconfigure!(ctx2);

    // No direct getter for `sources` — proven indirectly: a SECOND
    // reconfigure back to zero feeds warns again (buildSources actually
    // re-ran and re-evaluated feeds.length, rather than caching the
    // first, empty result forever).
    const { ctx: ctx3, warn } = ctxWith(configWith({ rss: { enabled: true, feeds: [] } }));
    await mod.reconfigure!(ctx3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('sources.rss is enabled but no feeds');
    await handle.stop();
  });

  it('stop() after a reconfigure stops the CURRENT jobs, not stale ones', async () => {
    const { ctx: ctx1 } = ctxWith(
      configWith({ rss: { enabled: true, feeds: [{ url: 'https://example.com/f.xml' }] } }),
    );
    const mod = createNewsModule(depsWith());
    await mod.preflight!(ctx1);
    const handle = await mod.start(ctx1);

    const { ctx: ctx2 } = ctxWith(
      configWith({ topics: { enabled: true, topics: ['klever'] } }), // rss out, topics in
    );
    await mod.reconfigure!(ctx2);
    const topicsJob = handle.jobs.find((j) => j.name === 'topics')?.job;
    const stopSpy = topicsJob ? vi.spyOn(topicsJob, 'stop') : undefined;

    await handle.stop();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
