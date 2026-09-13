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

import type { Config } from '../config.js';
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
}

export interface DescribeInput {
  readonly effective: Config;
  readonly fromFile: Record<string, unknown>;
  readonly fromUi: Record<string, unknown>;
  /** Per-path presentation metadata, merged from every enabled module. */
  readonly ui: Readonly<Record<string, { restart: boolean; confirm?: boolean }>>;
}

/**
 * Describe every field of the effective config, with provenance.
 *
 * Provenance is the difference between "reset to file" restoring a value the
 * operator wrote and silently reverting to a default they have never seen, so
 * it is computed from the raw layers rather than guessed.
 */
export function describeFields(input: DescribeInput): FieldView[] {
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

function sourceOf(path: string, input: DescribeInput): FieldSource {
  if (getPath(input.fromUi, path) !== undefined) return 'ui';
  if (getPath(input.fromFile, path) !== undefined) return 'file';
  return 'default';
}
