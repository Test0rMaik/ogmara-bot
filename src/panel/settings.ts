/**
 * The settings API's rules, kept out of the route handler so they can be tested
 * without a server.
 *
 * This module turns the panel from "rename the bot and register its wallet"
 * into full write access over the configuration. Three things follow, and they
 * are the reason this file exists rather than the logic living inline:
 *
 *  1. **`panel:` and `settings:` are file-only.** Anything that controls access
 *     to the settings UI cannot be edited from the settings UI.
 *  2. **The merged result is validated, not the diff.** A field that is
 *     individually valid can still be invalid in combination.
 *  3. **Rejections are as auditable as acceptances.** A refused write is
 *     precisely the event an operator later goes looking for.
 */

import { configFieldTypes, type Config, type ConfigFieldType } from '../config.js';
import { getPath, hasDangerousKey, leafPaths, type Overrides } from '../settings.js';

/**
 * Top-level config sections the API will never write.
 *
 * `panel` — a recovery path must require a strictly stronger credential than
 * the thing it recovers. Shell access outranks a panel session, so keeping
 * panel auth editable only through the file means a lockout is always fixable,
 * and only by someone with shell. It also makes a stolen session strictly
 * non-escalating: it cannot add an attacker wallet to `adminWallets`, cannot
 * remove the owner's, and — sharpest of all — cannot touch `trustedProxies`,
 * where one wrong entry is a full authentication bypass this repo has already
 * been bitten by once.
 *
 * `settings` — these paths decide where the override layer and the audit trail
 * live. A session that could relocate them could erase the record of what it
 * did.
 */
export const FILE_ONLY_SECTIONS: readonly string[] = ['panel', 'settings'];

/** Why a proposed write was refused. */
export interface Rejection {
  readonly path: string;
  readonly reason: string;
}

/**
 * Check a proposed set of changes against the file-only rule.
 *
 * Returns every rejection rather than the first: an operator submitting a form
 * should learn about all of its problems at once, and every refusal is audited.
 */
export function rejectFileOnlyPaths(changes: Overrides): Rejection[] {
  const out: Rejection[] = [];
  for (const path of leafPaths(changes)) {
    // Checked FIRST, and refused rather than quietly stripped, so the attempt
    // lands in the audit log. `{"__proto__":{"settings":{...}}}` produces no
    // leaf path under `settings`, so the file-only test below sees nothing to
    // refuse — and before this check the merged config came back with the audit
    // log relocated, past the very guard meant to prevent it.
    if (hasDangerousKey(path)) {
      out.push({
        path,
        reason:
          'that path manipulates the JavaScript prototype chain and is refused. ' +
          'It is not a configuration key.',
      });
      continue;
    }
    const section = path.split('.')[0] ?? '';
    if (FILE_ONLY_SECTIONS.includes(section)) {
      out.push({
        path,
        reason:
          `"${section}" is configured in config.yaml only. Anything that ` +
          'controls access to this page cannot be changed from this page.',
      });
    }
  }
  return out;
}

/**
 * Reject paths that are not real configuration keys.
 *
 * Zod strips unknown keys rather than rejecting them, so a typo used to be
 * accepted, persisted, and reported saved — with an audit row reading
 * `from: undefined, to: undefined`. Worse, it was then UNREMOVABLE: the UI
 * enumerates fields from the effective config, the stripped key is not in it,
 * so no field and no reset button ever appeared for it. It simply accumulated
 * in the overrides file forever.
 *
 * @param known every dotted path the effective config actually has
 */
export function rejectUnknownPaths(changes: Overrides, known: ReadonlySet<string>): Rejection[] {
  return leafPaths(changes)
    .filter((path) => !known.has(path))
    .map((path) => ({
      path,
      reason: `"${path}" is not a configuration setting. Check the spelling.`,
    }));
}

/** Where a field's effective value came from. */
export type FieldSource = 'default' | 'file' | 'ui';

export interface FieldView {
  readonly path: string;
  readonly value: unknown;
  readonly source: FieldSource;
  /** True when this section is read-only regardless of session. */
  readonly fileOnly: boolean;
  /** Needs a restart to take effect. */
  readonly restart: boolean;
  /** Needs an explicit confirmation step rather than an autosaving control. */
  readonly confirm: boolean;
  /**
   * i18n key for this field's label, when a module supplied one.
   *
   * Absent for a path no module claimed — the UI falls back to a humanised
   * version of the path itself, which is what keeps "nearly free" true for a
   * module that declares no `uiSchema` at all.
   */
  readonly labelKey?: string;
  /** i18n key for help text, when a module supplied one. */
  readonly helpKey?: string;
  /** Shape info from the Zod schema, for choosing an input widget. */
  readonly type: ConfigFieldType;
}

export interface DescribeInput {
  readonly effective: Config;
  readonly fromFile: Record<string, unknown>;
  readonly fromUi: Record<string, unknown>;
  /** Per-path presentation metadata, merged from every enabled module. */
  readonly ui: Readonly<
    Record<string, { restart: boolean; confirm?: boolean; label?: string; help?: string }>
  >;
}

const UNKNOWN_TYPE: ConfigFieldType = { kind: 'unknown' };

/**
 * Describe every field of the effective config, with provenance.
 *
 * Provenance is the difference between "reset to file" restoring a value the
 * operator wrote and silently reverting to a default they have never seen, so
 * it is computed from the raw layers rather than guessed.
 */
export function describeFields(input: DescribeInput): FieldView[] {
  // Computed once per call, not per field — walking the schema is a few tens
  // of microseconds, but there is no reason to pay it 80 times over.
  const types = configFieldTypes();
  return leafPaths(input.effective as unknown as Record<string, unknown>).map((path) => {
    const section = path.split('.')[0] ?? '';
    const meta = input.ui[path];
    const fileOnly = FILE_ONLY_SECTIONS.includes(section);
    return {
      path,
      // A file-only field's VALUE is withheld, not just its editability. This
      // response is exactly the reconnaissance a stolen session wants —
      // `adminWallets` tells an attacker whose key to go after, `trustedProxies`
      // tells them which header to forge. The page only needs to show that the
      // section exists and is edited elsewhere.
      value: fileOnly ? null : redact(path, getPath(input.effective, path)),
      source: sourceOf(path, input),
      fileOnly,
      ...(meta?.label !== undefined ? { labelKey: meta.label } : {}),
      ...(meta?.help !== undefined ? { helpKey: meta.help } : {}),
      type: types.get(path) ?? UNKNOWN_TYPE,
      // Restart-required by DEFAULT. A path with no metadata is one no module
      // claimed, and nothing in the process re-reads the config after a write —
      // so "we do not know" must read as "not applied yet", never as "applied".
      restart: meta?.restart ?? true,
      confirm: meta?.confirm ?? false,
    };
  });
}

/**
 * Strip credentials from a value before it goes into a response body.
 *
 * `node.url` is validated as a URL but not restricted from carrying embedded
 * userinfo (`https://user:pass@host`). `/api/profile` already returns only its
 * ORIGIN for exactly this reason — a 0.14.0 security-audit decision recorded in
 * `server.ts` — and echoing the same value verbatim here would put that
 * credential straight back into the browser's history, its devtools, and any
 * proxy log, admin session or not.
 *
 * Exported because the AUDIT LOG needs it just as much: redacting the read but
 * not the write recorded the credential permanently, in the one file whose
 * stated purpose is being safe to paste into a bug report.
 */
export function redact(_path: string, value: unknown): unknown {
  // Keyed on the VALUE, not on a path name. Naming `node.url` explicitly left
  // `ai.baseUrl` — also a URL, also accepting `https://user:pass@host` — leaking
  // into the response and, once redaction was wired into the audit log, into
  // that file permanently. Any future URL field would have leaked too.
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.username === '' && url.password === '') return value;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    // Not parseable as a URL; the schema would have refused it, and returning
    // it unchanged is no worse than the config already is.
    return value;
  }
}

/** One field a config reload actually changed, ready to hand to `settings.audit`. */
export interface ConfigChangeRow {
  readonly path: string;
  readonly outcome: 'applied' | 'restart-pending';
  readonly from: unknown;
  readonly to: unknown;
}

/**
 * Diff two config snapshots down to the leaf paths that actually changed,
 * for a trigger that reapplies the WHOLE config rather than a targeted set
 * of edits — today, only `configWatcher.ts`'s hand-edit-to-config.yaml
 * path. A panel save already knows exactly which paths it touched (the
 * request body); a filesystem reload does not, so this recovers the same
 * granularity by comparing before and after.
 *
 * `before` must be a genuine snapshot (e.g. `structuredClone`'d) taken
 * BEFORE whatever mutated the live config object — `settingsDeps.ts`
 * mutates its `effective` object IN PLACE, so a bare reference captured
 * "before" would already show the new values by the time this runs.
 *
 * Same restart-vs-applied rule `describeFields` uses: a path with no live
 * uiSchema entry is restart-pending by default, never assumed applied.
 *
 * Compares by VALUE (`JSON.stringify`), not `!==`: `leafPaths` treats an
 * array or an empty object as a single leaf (see its own doc comment), so
 * `from`/`to` for a path like `bot.channels` are two independent array
 * instances even when every element is identical — `before` came from a
 * `structuredClone`, `after.effective` from a fresh parse. A reference
 * comparison would report EVERY array-valued field as "changed" on every
 * single reload, including a genuine no-op re-read, which would have made
 * this function worse than not calling it at all.
 *
 * Walks the UNION of `before`'s and `after`'s leaf paths, not just
 * `after`'s: `applyConfigInPlace` (config.ts) genuinely DELETES a key when
 * an `.optional()` field with no `.default()` (e.g.
 * `sources.imagedir.contentRating`) goes from set to unset — the key is
 * absent from `after.effective`, not present-as-`undefined` — so a path
 * this walk skipped every time `after` didn't have it would silently drop
 * exactly the kind of change (a hand-edit CLEARING a field) this function
 * exists to record.
 */
export function diffForAudit(before: Config, after: DescribeInput): ConfigChangeRow[] {
  const rows: ConfigChangeRow[] = [];
  const beforePaths = leafPaths(before as unknown as Record<string, unknown>);
  const afterPaths = leafPaths(after.effective as unknown as Record<string, unknown>);
  for (const path of new Set([...beforePaths, ...afterPaths])) {
    const from = getPath(before, path);
    const to = getPath(after.effective, path);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    rows.push({
      path,
      outcome: after.ui[path]?.restart === false ? 'applied' : 'restart-pending',
      from: redact(path, from),
      to: redact(path, to),
    });
  }
  return rows;
}

function sourceOf(path: string, input: DescribeInput): FieldSource {
  if (getPath(input.fromUi, path) !== undefined) return 'ui';
  if (getPath(input.fromFile, path) !== undefined) return 'file';
  return 'default';
}
