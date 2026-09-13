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
  readConfigFileRaw,
  validateConfig,
  type Config,
  type LayeredConfig,
  type Secrets,
} from './config.js';
import type { BotModule } from './modules/types.js';
import type { SettingsDeps } from './panel/server.js';
import type { DescribeInput } from './panel/settings.js';
import {
  deletePath,
  mergeOverrides,
  writeOverrides,
  type Overrides,
} from './settings.js';

export interface SettingsDepsInput {
  readonly configPath: string;
  readonly layered: LayeredConfig;
  /** Enabled modules, for their `uiSchema` metadata. */
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
function collectUiSchema(
  modules: readonly BotModule[],
): Record<string, { restart: boolean; confirm?: boolean }> {
  const out: Record<string, { restart: boolean; confirm?: boolean }> = {};
  const owner = new Map<string, string>();
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
      };
    }
  }
  // Core fields no module owns. `dryRun` is a confirmation step rather than a
  // toggle in either direction: turning it OFF points a live wallet at a live
  // network under the operator's identity, and turning it ON is how someone
  // stops a bot that is posting — which is exactly when a wrong answer about
  // whether it took effect does the most damage.
  out['posting.dryRun'] = { restart: true, confirm: true };
  out['node.url'] = { restart: true };
  out['node.network'] = { restart: true, confirm: true };
  return out;
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
  let effective: Config = input.layered.config;
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

    // Paths come from the MERGED result, not from boot. Everything else here
    // re-reads config.yaml, so freezing these two meant a hand-edited
    // `auditPath` showed on the settings page while the log kept being written
    // to the old location — the settings page and the writer disagreeing about
    // the same field.
    writeOverrides(forced.settings.path, next);
    overrides = next;
    effective = forced;
    auditOpts = auditOptionsFor(forced);
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
