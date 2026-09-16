/**
 * Wiring between the settings API and the config layers it edits.
 *
 * Kept out of `index.ts` because it holds the one piece of mutable state the
 * settings feature needs — the current override set — and that deserves a named
 * home rather than a closure variable in a 900-line entry point.
 *
 * The state here is deliberately *narrow*: the overrides that have been written
 * to disk, and the effective config they produce. Nothing else is cached, so a
 * read always reflects what a restart would load.
 */

import { appendAudit, readAudit, type AuditEvent } from './audit.js';
import {
  applyConfigInPlace,
  readConfigFileRaw,
  validateConfig,
  type Config,
  type LayeredConfig,
  type Secrets,
} from './config.js';
import { CORE_UI_SCHEMA } from './coreUiSchema.js';
import type { BotModule } from './modules/types.js';
import type { SettingsDeps } from './panel/server.js';
import type { DescribeInput } from './panel/settings.js';
import {
  deletePath,
  getPath,
  mergeOverrides,
  writeOverrides,
  type Overrides,
} from './settings.js';

/**
 * A live-apply callback for one config path. Registered by whichever piece
 * of `index.ts` owns the runtime state that path controls (a rate budget, a
 * ledger's retention, a cron job's schedule) — `settingsDeps.ts` itself
 * knows nothing about what any of these values DO, only that a commit
 * changing this path should call `apply` with the new value.
 *
 * Only fires when the value actually changed — a save that touches other
 * fields, or that reasserts the same value, does not re-trigger it.
 *
 * `apply` may return a `Promise` — rebuilding an AI provider, swapping a
 * network client, or re-initializing a whole module are all genuinely
 * async. `commit()` never awaits it (a save must not block on a live-apply
 * side effect), but it DOES attach its own `.catch()` to whatever `apply`
 * returns, so a rejected promise still reaches the same
 * `console.error("live-apply ... failed")` path a synchronous throw does,
 * rather than becoming an unhandled rejection.
 */
export interface ReconfigureHook {
  readonly path: string;
  readonly apply: (value: unknown, config: Config) => void | Promise<void>;
}

export interface SettingsDepsInput {
  readonly configPath: string;
  readonly layered: LayeredConfig;
  /**
   * ALL constructed modules, for their `uiSchema` metadata — not filtered to
   * enabled ones. A module's own `enabled` flag is itself a field its uiSchema
   * describes (e.g. `bot.enabled`), so passing only the enabled subset meant
   * an operator could never discover or turn on a disabled module from the
   * settings page at all. `uiSchema` is a static property set at
   * construction; it needs no running state to be described correctly.
   */
  readonly modules: readonly BotModule[];
  readonly secrets: Secrets;
  /**
   * Command-line forcing applied on top of every loaded config, e.g.
   * `--dry-run`.
   *
   * Applied on EVERY commit, not just at construction. Handing in an
   * already-forced config was not enough: the first save replaced it with a
   * freshly merged one and the forcing was lost, so the panel reported
   * `dryRun: false` while the process was genuinely in dry run — the page
   * contradicting the thing it administers.
   */
  readonly applyCliOverrides?: (config: Config) => Config;
  /** Live-apply callbacks for paths that don't need a restart. See `ReconfigureHook`. */
  readonly reconfigureHooks?: readonly ReconfigureHook[];
}

/**
 * Which environment secrets are present.
 *
 * Presence only, and computed fresh each call. The wallet key is deliberately
 * absent from the editable surface entirely — it is shown elsewhere as a
 * derived `klv1…` address, never as a field sharing a form with posting
 * cadence.
 */
function secretsPresent(secrets: Secrets): Record<string, boolean> {
  return {
    OGMARA_WALLET_KEY: secrets.walletKeyHex.length > 0,
    ANTHROPIC_API_KEY: (secrets.anthropicApiKey ?? '') !== '',
    OPENAI_API_KEY: (secrets.openaiApiKey ?? '') !== '',
    GEMINI_API_KEY: (secrets.geminiApiKey ?? '') !== '',
    OPENAI_COMPATIBLE_API_KEY: (secrets.openaiCompatibleApiKey ?? '') !== '',
  };
}

/**
 * Merge every enabled module's UI metadata into one path-keyed map.
 *
 * **Unknown paths are restart-REQUIRED, not live.** Nothing in the process
 * re-reads the effective config after a write: the publisher holds the config
 * it was constructed with, and the panel closes over `dryRunFn` at boot. So
 * every saved change is in fact inert until a restart, and a module has to opt
 * in with `{ restart: false }` *and* a real live-apply path before the panel may
 * say otherwise.
 *
 * Defaulting the other way is how a settings page comes to lie about the one
 * thing an operator most needs to trust — see `describeFields`, where a missing
 * entry used to mean "applied".
 */
type UiMeta = { restart: boolean; confirm?: boolean; label?: string; help?: string };

function collectUiSchema(modules: readonly BotModule[]): Record<string, UiMeta> {
  const out: Record<string, UiMeta> = {};
  // Seeded into `owner` too, not just `out` — a module claiming a path core
  // already owns (say a future module touching `posting.dryRun`) must be
  // refused the same way two modules colliding with each other are refused.
  // Populating `out` without `owner` meant that collision was legal and
  // silent: the module's entry would overwrite core's with no error, quietly
  // taking `confirm: true` off a field specifically flagged for it because a
  // wrong value is expensive or public. "No current module touches a core
  // path" was true when this was written and is not a guarantee.
  const owner = new Map<string, string>();
  for (const path of Object.keys(CORE_UI_SCHEMA)) owner.set(path, 'core');
  for (const [path, field] of Object.entries(CORE_UI_SCHEMA)) {
    out[path] = {
      restart: field.restart,
      ...(field.confirm === true ? { confirm: true } : {}),
      ...(field.label !== undefined ? { label: field.label } : {}),
      ...(field.help !== undefined ? { help: field.help } : {}),
    };
  }

  for (const module of modules) {
    for (const [path, field] of Object.entries(module.uiSchema ?? {})) {
      // Refuse a collision loudly at startup rather than letting the
      // last-registered module win in silence. Which module's `restart` and
      // `confirm` applied would otherwise depend on registration order, and
      // getting that wrong is how the page comes to mislabel a field.
      const previous = owner.get(path);
      if (previous !== undefined) {
        throw new Error(
          `modules "${previous}" and "${module.name}" both declare a uiSchema for "${path}". ` +
            'A config path belongs to exactly one module.',
        );
      }
      owner.set(path, module.name);
      out[path] = {
        restart: field.restart,
        ...(field.confirm === true ? { confirm: true } : {}),
        ...(field.label !== undefined ? { label: field.label } : {}),
        ...(field.help !== undefined ? { help: field.help } : {}),
      };
    }
  }
  return out;
}

/**
 * Whether two values a `ReconfigureHook` path resolved to, before and after
 * a commit, represent the SAME config — not merely the same object.
 *
 * `commit()` re-derives the whole config tree from scratch on every save
 * via `validateConfig` (a full Zod parse over the merged result), which
 * constructs brand-new array/object instances for every array/object field
 * REGARDLESS of whether that field's own value actually changed in this
 * particular save. A plain `===` comparison would then see every
 * array/object-valued hook path as "changed" on every single commit, no
 * matter which field the operator actually touched — every primitive-typed
 * hook already shipped (numbers/strings: `node.url`, `queue.maxAttempts`,
 * `ai.model`, …) happens to survive a fresh parse with `===` intact, which
 * is what let this go unnoticed until the first array-valued hook path
 * (`bot.channels`/`bot.commands`) was registered. `JSON.stringify` is safe
 * here specifically because config values are always JSON-safe (sourced
 * from YAML + a JSON overrides file, Zod-validated) and Zod always emits
 * object keys in schema-declaration order for both sides of this
 * comparison, so two semantically-equal values serialize identically.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function auditOptionsFor(config: Config): { path: string; maxBytes: number; keep: number } {
  return {
    path: config.settings.auditPath,
    maxBytes: config.settings.auditMaxBytes,
    keep: config.settings.auditKeep,
  };
}

export function createSettingsDeps(input: SettingsDepsInput): SettingsDeps {
  // The only mutable state: what has been written to the overrides file.
  let overrides: Overrides = structuredClone(input.layered.fromUi) as Overrides;
  // NEVER reassigned — see `commit()`. `index.ts` hands this exact object to
  // `ctx.config`, `OgmaraPublisher`, and everything else built at startup;
  // a save has to mutate its fields in place, or every one of those holds a
  // stale copy forever, observing nothing a save ever does.
  const effective: Config = input.layered.config;
  const reconfigureHooks = input.reconfigureHooks ?? [];
  const ui = collectUiSchema(input.modules);
  const force = input.applyCliOverrides ?? ((c: Config): Config => c);
  let lastGoodFile: Record<string, unknown> = input.layered.fromFile;
  let auditOpts = auditOptionsFor(input.layered.config);

  const describe = (): DescribeInput => {
    // Re-read each time so an operator who hand-edits config.yaml sees the
    // provenance change without restarting the bot. The file is theirs; the
    // panel should not pretend otherwise.
    //
    // An UNREADABLE file yields no `fromFile` — which would make every field
    // report `default` and the provenance badges lie — so the last good read is
    // kept instead, and `commit` refuses while the file is broken.
    const raw = readConfigFileRaw(input.configPath);
    if (raw.ok) lastGoodFile = raw.values;
    return { effective, fromFile: lastGoodFile, fromUi: overrides, ui };
  };

  /**
   * Validate a candidate override set against the MERGED result and, if it
   * holds, persist it.
   *
   * The merged result, never the diff: a field that is individually valid can
   * still be invalid in combination, and the schema is the only thing that
   * knows. Nothing is written unless the result would load.
   */
  const commit = (next: Overrides): { ok: true } | { ok: false; issues: string[] } => {
    const raw = readConfigFileRaw(input.configPath);
    if (!raw.ok) {
      // Refuse rather than merge onto an empty base: the resulting error would
      // blame a field the operator never touched, with nothing pointing at the
      // real problem.
      return {
        ok: false,
        issues: [
          `config.yaml cannot be read right now (${raw.reason}). ` +
            'Fix or finish saving that file, then try again.',
        ],
      };
    }
    const merged = validateConfig(mergeOverrides(raw.values, next));
    if (!merged.ok) return { ok: false, issues: merged.issues };
    const forced = force(merged.config);

    // Snapshot the paths any hook cares about BEFORE mutating `effective` —
    // once `applyConfigInPlace` runs, `effective` IS the new state, so this
    // is the only point where "before" and "after" are actually different
    // objects to compare.
    const before = reconfigureHooks.map((hook) => getPath(effective, hook.path));

    // Paths come from the MERGED result, not from boot. Everything else here
    // re-reads config.yaml, so freezing these two meant a hand-edited
    // `auditPath` showed on the settings page while the log kept being written
    // to the old location — the settings page and the writer disagreeing about
    // the same field.
    writeOverrides(forced.settings.path, next);
    overrides = next;
    applyConfigInPlace(effective, forced);
    auditOpts = auditOptionsFor(effective);

    // The write and the in-memory mutation above already succeeded — from
    // here on this is a best-effort NOTIFICATION, not a step the save can
    // still fail on. A throwing hook must not stop the REST of the hooks
    // from running, and must not turn an already-persisted save into a
    // request that reports failure to the operator (the save genuinely
    // went through; only the live-apply side of one field did not).
    reconfigureHooks.forEach((hook, i) => {
      const after = getPath(effective, hook.path);
      if (sameValue(after, before[i])) return;
      const reportFailure = (err: unknown): void => {
        console.error(
          `  warning: live-apply for "${hook.path}" failed (the save itself succeeded): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      };
      // `apply` may be sync or async — wrapping the CALL itself in try/catch
      // only ever catches a synchronous throw; an async hook's rejection
      // would otherwise escape as an unhandled promise rejection instead of
      // reaching the same warning a sync throw does. `Promise.resolve(...)`
      // normalizes either shape into one path.
      try {
        Promise.resolve(hook.apply(after, effective)).catch(reportFailure);
      } catch (err) {
        reportFailure(err);
      }
    });

    return { ok: true };
  };

  return {
    describe,
    secretsPresent: () => secretsPresent(input.secrets),
    // Read through the CURRENT options, not a boot-time snapshot.
    audit: (event: AuditEvent) => appendAudit(auditOpts, event),
    readAudit: (limit: number) => readAudit(auditOpts.path, limit),

    apply: (changes: Overrides) => commit(mergeOverrides(overrides, changes)),

    reset: (path: string) => {
      // Deletes the override rather than writing the file's value into it, so
      // "reset to file" keeps tracking the file if the file later changes.
      const next = structuredClone(overrides) as Overrides;
      deletePath(next, path);
      return commit(next);
    },
  };
}
