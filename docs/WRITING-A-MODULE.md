# Writing a module

`ogmara-bot` is a small core plus optional **modules**. A module is one feature an
operator can switch on — news posting today, answering channel slash commands
next. This describes how to add one.

## What is and isn't a module

**Core, and not switchable off:** `node`, `panel`, `storage`, and the wallet
identity. Without them there is no bot, and — more to the point — no way back in
to fix a misconfiguration. A bot you can't reach the panel of is a bot you can't
repair.

**A module:** anything genuinely optional. If a sensible operator might run the
bot without it, it's a module.

## The contract

One interface, in [`src/modules/types.ts`](../src/modules/types.ts):

```ts
export interface BotModule {
  readonly name: string;
  readonly schemas: Readonly<Record<string, ZodTypeAny>>;
  isEnabled(config: Config): boolean;
  preflight?(ctx: BotContext): Promise<PreflightFailure | null>;
  runOnce?(ctx: BotContext): Promise<void>;
  start(ctx: BotContext): Promise<ModuleHandle>;
}
```

A module declares **everything about itself in one place**: its config section
*and* the schema for it, whether it's on, what must be true before the bot can
start with it on, and how to run.

That last point is why `schemas` exists rather than the config file declaring
everything centrally. Because a module owns its schema, the operator settings
page can render itself *from* that schema instead of being hand-written per
feature — so adding a module gets you config validation, settings UI and
documented options in one step, and you can't forget any of the three.

## Adding one

**1. Declare your config schema next to your module**, not in `config.ts`:

```ts
export const widgetSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: z.string().default('0 * * * *').refine(isValidCron, {
    message: 'not a valid cron expression',
  }),
});
```

Then compose it in `config.ts`'s `configSchema` and expose it in your module's
`schemas` map under the same key.

**2. Implement the interface.** `src/modules/news.ts` is the worked example.

**3. Register it** in `index.ts`'s `allModules` array.

That's it. `enabledModules` filters it, `preflightAll` checks it, `startAll`
starts it, and `stopAll` shuts it down.

## Rules that are not negotiable

**Route posting through the shared rate budget, never around it.** A module that
publishes is a new posting path and gets the same budget as everything else. The
budget exists because the node enforces one; a module that bypasses it doesn't
get to post more, it gets the bot rate-limited.

**`posting.dryRun` is global and you cannot opt out of it.** It's the safety
catch that lets an operator run your brand-new module against a live network
without publishing anything. Respect it or nobody will trust the module enough to
switch it on.

**Validate shape and caps in `schema`; never validate anything that depends on
runtime or network state there.** Config load happens before the node is
reachable. Anything needing the node, the filesystem or the AI provider belongs
in `preflight`, which runs after.

> This one has bitten this codebase: a network-dependent check inside a Zod
> `.refine()` produced the 0.12.0 cadence bug. The schema is for shape. Preflight
> is for reality.

**Being disabled is never an error.** An absent or `enabled: false` section means
"don't start" — not "misconfigured". A bot running only the panel, with every
module off, is a valid deployment and is how an operator sets the thing up in the
first place.

**Bound anything you cache or accumulate.** A map keyed by something a remote
peer controls needs an eviction policy, not a comment saying it's bounded in
practice.

## Preflight vs. schema, concretely

The news module's imagedir source needs two things that can't be known at config
load: whether the configured AI model accepts images, and whether the node's
media backend is up. Both live in `preflight`, and both return a message telling
the operator how to fix it rather than a stack trace.

```ts
async preflight(ctx) {
  if (!ctx.config.sources.imagedir.enabled) return null;
  if (!deps.provider.supportsVision) {
    return { message: 'sources.imagedir is enabled but the model cannot accept images…' };
  }
  return null;
}
```

Returning a failure aborts startup with that message. Starting a module that
can't work is worse than refusing to start.

## Lifecycle

`start` returns a `ModuleHandle` carrying the cron jobs you registered and a
`stop`. Carry the cron *expression* alongside each job, not just the job: the
core compares total scheduled attempts per hour against
`posting.maxPostsPerHour` and warns when a schedule can out-run the budget, and
it can only do that if it can see your crons.

`stop` must be safe to call twice — both `SIGINT` and `SIGTERM` can arrive in the
same forceful kill. One module throwing on stop does not prevent the others
stopping; a shutdown that gives up halfway leaves a cron alive, and a "stopped"
bot whose cron survived keeps posting.
