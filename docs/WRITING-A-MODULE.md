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
  readonly uiSchema?: Readonly<Record<string, UiField>>;
  isEnabled(config: Config): boolean;
  preflight?(ctx: BotContext): Promise<PreflightFailure | null>;
  runOnce?(ctx: BotContext): Promise<void>;
  start(ctx: BotContext): Promise<ModuleHandle>;
  reconfigure?(ctx: BotContext): Promise<void>;
}
```

A module declares **everything about itself in one place**: its config section
*and* the schema for it, whether it's on, what must be true before the bot can
start with it on, and how to run.

`uiSchema` is optional presentation metadata, keyed by dotted config path
(`widget.schedule`) — a label, help text, and whether the field applies live
or needs a restart. A field with no entry still works (a humanised label,
assumed restart-required); add an entry once you want a better label or once
a field genuinely applies without one.

**A field defaults to restart-required until you prove otherwise.** Adding
`restart: false` to `uiSchema` is a promise, not a description — it means
either the field is read fresh off `ctx.config` on every use (nothing further
to do), or you've implemented `reconfigure` (below) to actually apply it live.
Never flip the flag first and wire the behavior later; the settings page will
tell the operator their change took effect immediately when it did not.

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

**2. Implement the interface.** Two worked examples, and they differ in a way
worth knowing before you pick one to copy:

- `src/modules/news.ts` — **scheduled**. Registers cron jobs and does its work on
  a timer. Copy this for anything that runs *on its own initiative*.
- `src/modules/commands/` — **reactive**. Holds a subscription and does its work
  when something arrives from the network. Copy this for anything driven by
  *other people's traffic*, and read its rate limiter first: input you did not
  schedule is input an attacker controls the volume of.

**3. Register it** in `index.ts`'s `allModules` array.

That's it. `enabledModules` filters it, `preflightAll` checks it, `startAll`
starts it, and `stopAll` shuts it down.

## Rules that are not negotiable

**Route posting through the shared rate budget, never around it.** A module that
publishes is a new posting path and gets the same budget as everything else. The
budget exists because the node enforces one; a module that bypasses it doesn't
get to post more, it gets the bot rate-limited.

The sharper version, if your module posts in *response* to something: the node
meters one per-wallet quota for everything this bot sends, so your module is
spending the same allowance the news pipeline needs. A registered wallet gets
300 messages a day. Take a bounded share of that and leave the rest — see
`maxShareOfNodeBudget` in the `commands` module — because the failure mode is
not "my module gets throttled", it is "the bot stopped posting news at 09:00 and
nobody knows why".

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

## Going live: `reconfigure` (optional)

Every field starts restart-required — reasonable default, no work needed. Some
fields are worth more: an operator changing a schedule or a limit without
SSHing in to restart. That's `reconfigure`, called on your ALREADY-RUNNING
module whenever a field your `uiSchema` marks `restart: false` actually
changes.

**It must re-derive everything it touches from `ctx.config`, fresh** — the
same way `preflight`/`start` already do — never accept a diff or assume what
changed. Two things the caller does *not* guard for you, because only the
module knows what "safe" means for its own state:

- **No-op if you were never started.** `isEnabled` could have been `false` at
  boot; `reconfigure` still gets called (the caller has no cheap way to know
  otherwise), so check your own "am I running" flag first.
- **No-op — or queue — if a previous call is still in flight.** Two saves
  close together must not race. If your `reconfigure` has no `await` in it at
  all (rebuilding in-memory state only, no network calls), this is free: two
  synchronous calls literally cannot interleave. The moment you add an
  `await`, add a reentrancy guard too — see `commands/index.ts`'s
  `reconfiguring` flag.

**If you manage a dynamic set of jobs** (one source can be switched on or off
live, not just rescheduled), the array on your `ModuleHandle` must be mutated
in place — `jobs.push(...)`/`jobs.splice(...)`, never `jobs = [...]` — because
the *same* array object is what the `ModuleHandle` you already returned from
`start()` still points to. Replacing it silently orphans whatever the core
already holds.

Two real, audited examples worth reading before writing your own:
`commands/index.ts`'s `reconfigure` (awaits real network calls, needs the
reentrancy guard, validates before committing so an invalid change can't take
effect) and `news.ts`'s (fully synchronous, needs the in-place job-array
mutation because sources can be switched on/off live). Both were shipped only
after a security/code audit caught a real bug in the first version — a
rejected change that still took effect, and a race between a shutdown and an
in-flight save — so treat "small, self-contained function" as a trap, not a
reassurance.
