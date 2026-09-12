/**
 * Module registry — assembles the feature modules an operator has switched on.
 *
 * The core (`node`, `panel`, `storage`, wallet identity) is not registered here:
 * it cannot be switched off, and a bot with no way to reach its own panel is a
 * bot nobody can fix.
 */

import type { Config } from '../config.js';
import type { BotContext, BotModule, ModuleHandle } from './types.js';

/** Modules that are enabled for this config, in registration order. */
export function enabledModules(all: readonly BotModule[], config: Config): BotModule[] {
  return all.filter((m) => m.isEnabled(config));
}

/**
 * Run every module's preflight, returning the first failure.
 *
 * Sequential rather than parallel: a preflight may hit the node (the news
 * module's media check does), and a failure should be reported against the
 * module that caused it rather than racing several and picking one.
 */
export async function preflightAll(
  modules: readonly BotModule[],
  ctx: BotContext,
): Promise<{ module: string; message: string } | null> {
  for (const m of modules) {
    if (m.preflight === undefined) continue;
    const failure = await m.preflight(ctx);
    if (failure !== null) return { module: m.name, message: failure.message };
  }
  return null;
}

/** A started module, paired with its name for shutdown reporting. */
export interface StartedModule {
  readonly name: string;
  readonly handle: ModuleHandle;
}

export async function startAll(
  modules: readonly BotModule[],
  ctx: BotContext,
): Promise<StartedModule[]> {
  const started: StartedModule[] = [];
  for (const m of modules) {
    started.push({ name: m.name, handle: await m.start(ctx) });
  }
  return started;
}

/**
 * Stop every started module, in reverse start order.
 *
 * One module failing to stop must not prevent the others from stopping — a
 * shutdown that leaves a cron alive is how a "stopped" bot keeps posting.
 */
export async function stopAll(
  started: readonly StartedModule[],
  warn: (message: string) => void,
): Promise<void> {
  for (const { name, handle } of [...started].reverse()) {
    try {
      await handle.stop();
    } catch (err) {
      warn(`  warning: module "${name}" failed to stop cleanly (${String(err)})`);
    }
  }
}
