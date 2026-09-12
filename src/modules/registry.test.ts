import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Config } from '../config.js';
import { enabledModules, preflightAll, startAll, stopAll } from './registry.js';
import type { BotContext, BotModule, ModuleHandle } from './types.js';
import { newsEnabled } from './news.js';

/** Minimal config stub — only the fields the module contract actually reads. */
function configWith(sources: Partial<Record<'rss' | 'topics' | 'imagedir', boolean>>): Config {
  const src = (enabled: boolean): Record<string, unknown> => ({ enabled });
  return {
    sources: {
      rss: src(sources.rss ?? false),
      topics: src(sources.topics ?? false),
      imagedir: src(sources.imagedir ?? false),
    },
  } as unknown as Config;
}

const ctx = {
  config: configWith({}),
  secrets: {},
  publisher: {},
  log: () => {},
  warn: () => {},
} as unknown as BotContext;

function stubModule(name: string, enabled: boolean, over: Partial<BotModule> = {}): BotModule {
  return {
    name,
    schemas: { [name]: z.object({}) },
    isEnabled: () => enabled,
    async start(): Promise<ModuleHandle> {
      return { jobs: [], async stop() {} };
    },
    ...over,
  };
}

describe('enabledModules', () => {
  it('returns only the modules switched on, in registration order', () => {
    const mods = [stubModule('a', true), stubModule('b', false), stubModule('c', true)];
    expect(enabledModules(mods, ctx.config).map((m) => m.name)).toEqual(['a', 'c']);
  });

  it('returns an empty list when nothing is enabled — NOT an error', () => {
    // A bot with every module off is a valid deployment: the panel alone is a
    // reason to run, and it is how an operator configures the thing in the
    // first place. Before the module contract, "no sources enabled" was a fatal
    // startup error, which made a panel-only bot impossible.
    expect(enabledModules([stubModule('a', false)], ctx.config)).toEqual([]);
  });
});

describe('newsEnabled', () => {
  it('is false only when every source is off', () => {
    expect(newsEnabled(configWith({}))).toBe(false);
    expect(newsEnabled(configWith({ rss: true }))).toBe(true);
    expect(newsEnabled(configWith({ topics: true }))).toBe(true);
    expect(newsEnabled(configWith({ imagedir: true }))).toBe(true);
  });
});

describe('preflightAll', () => {
  it('returns the first failure, naming the module that produced it', async () => {
    const mods = [
      stubModule('ok', true, { preflight: async () => null }),
      stubModule('bad', true, { preflight: async () => ({ message: 'needs a vision model' }) }),
      stubModule('never', true, {
        preflight: async () => ({ message: 'should not be reached' }),
      }),
    ];
    const failure = await preflightAll(mods, ctx);
    expect(failure).toEqual({ module: 'bad', message: 'needs a vision model' });
  });

  it('passes when no module declares a preflight', async () => {
    expect(await preflightAll([stubModule('a', true)], ctx)).toBeNull();
  });

  it('runs preflights sequentially, not in parallel', async () => {
    // A preflight may hit the node. Racing several and reporting whichever
    // failed first would attribute a failure to the wrong module.
    const order: string[] = [];
    const slow = stubModule('slow', true, {
      preflight: async () => {
        order.push('slow:start');
        await new Promise((r) => setTimeout(r, 20));
        order.push('slow:end');
        return null;
      },
    });
    const fast = stubModule('fast', true, {
      preflight: async () => {
        order.push('fast:start');
        return null;
      },
    });
    await preflightAll([slow, fast], ctx);
    expect(order).toEqual(['slow:start', 'slow:end', 'fast:start']);
  });
});

describe('stopAll', () => {
  it('stops every module even when one throws', async () => {
    // A shutdown that gives up halfway leaves a cron alive — and a "stopped"
    // bot whose cron survived keeps posting.
    const stopped: string[] = [];
    const started = [
      { name: 'a', handle: { jobs: [], stop: async () => { stopped.push('a'); } } },
      { name: 'boom', handle: { jobs: [], stop: async () => { throw new Error('nope'); } } },
      { name: 'c', handle: { jobs: [], stop: async () => { stopped.push('c'); } } },
    ];
    const warn = vi.fn();
    await stopAll(started, warn);
    expect(stopped).toEqual(['c', 'a']); // reverse start order
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('boom');
  });

  it('stops in reverse start order', async () => {
    const stopped: string[] = [];
    const mk = (name: string) => ({
      name,
      handle: { jobs: [], stop: async () => { stopped.push(name); } },
    });
    await stopAll([mk('first'), mk('second'), mk('third')], () => {});
    expect(stopped).toEqual(['third', 'second', 'first']);
  });
});

describe('startAll', () => {
  it('collects a handle per module', async () => {
    const started = await startAll([stubModule('a', true), stubModule('b', true)], ctx);
    expect(started.map((s) => s.name)).toEqual(['a', 'b']);
    expect(started).toHaveLength(2);
  });

  it('starts nothing when no module is enabled, and that is fine', async () => {
    expect(await startAll([], ctx)).toEqual([]);
  });
});
