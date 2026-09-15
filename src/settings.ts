/**
 * The UI-written override layer.
 *
 * Configuration is layered, and the layers exist to keep two editing surfaces
 * from fighting:
 *
 * ```
 * defaults  <  config.yaml (hand-edited, authoritative, NEVER written here)
 *           <  data/settings.json (written only by the settings UI)
 * ```
 *
 * Secrets sit outside this entirely — they are environment variables and never
 * appear in either file (see `loadSecrets`), which is why nothing in this module
 * has to handle a secret value.
 *
 * ## Why the UI does not write `config.yaml`
 *
 * The comments in that file are substantial operator documentation — the
 * `panel:` block alone explains the loopback bypass and the DNS-rebinding
 * protections. Serialising a parsed object back over it destroys every one of
 * them, and silently overwrites anyone still hand-editing. So the UI writes a
 * separate file containing ONLY the keys actually changed, and "reset to file"
 * deletes an override rather than writing the file's value into it.
 *
 * ## Why a malformed overrides file is ignored rather than fatal
 *
 * This file is written by a web form. A bad write must never be able to stop
 * the bot starting — that is the lockout class from the standing triage rule.
 * A file that will not parse is logged loudly and skipped in favour of
 * `config.yaml`, which is always valid on its own.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Header written into every overrides file, for whoever opens it next. */
const FILE_HEADER =
  'Written by the ogmara-bot settings UI. Not a hand-editing surface — ' +
  'edit config.yaml instead; changes here may be overwritten on the next save.';

/** A nested plain object of override values, mirroring the config shape. */
export type Overrides = Record<string, unknown>;

/**
 * Keys that must never be traversed or assigned.
 *
 * `JSON.parse` creates `__proto__` as an ordinary OWN property, but assigning
 * it — `out[key] = value` — sets the object's prototype instead. A merged
 * config then resolves missing sections through that prototype, and Zod reads
 * them as if they were really there.
 *
 * That was a live escalation, not a theoretical one: a settings write of
 * `{"__proto__":{"settings":{"auditPath":"/tmp/x"}}}` produced no leaf path
 * under `settings`, so the file-only guard saw nothing to refuse — and the
 * merged config came back with the audit log relocated. The guard exists
 * precisely to stop a session moving the record of what it did.
 *
 * Stripped at every layer rather than only at the guard: the load path, the
 * merge, and the path writer each refuse them independently, so no single
 * forgotten check restores the hole.
 */
export const DANGEROUS_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/**
 * Config sections the overrides layer may never carry.
 *
 * Enforced HERE, at the load path, and not only in the HTTP guard — that was
 * the hole: `FILE_ONLY_SECTIONS` lived in the route handler, so anything able
 * to write one file into `data/` (a second container on a shared volume, any
 * local process, a future bug with an attacker-influenced filename) could put
 * `panel:` in the overrides file and, on the next restart, turn the loopback
 * bypass back on, install its own `adminWallets`, and point `trustedProxies`
 * wherever it liked.
 *
 * It compounded: the overrides file and the audit log are written to paths from
 * `settings:`, so the same write relocated both — the next save would overwrite
 * an arbitrary file, and every audit line would append somewhere the attacker
 * chose. The module header claims a session cannot move the record of what it
 * did; that claim is only true with this check at this layer.
 *
 * Duplicated deliberately with `panel/settings.ts`'s copy: the HTTP guard gives
 * a good error message to an operator, this one is the one that actually has to
 * hold.
 */
export const FILE_ONLY_IN_OVERRIDES: readonly string[] = ['panel', 'settings'];

/** Whether any segment of a dotted path is a prototype-manipulating key. */
export function hasDangerousKey(path: string): boolean {
  return path.split('.').some((part) => DANGEROUS_KEYS.includes(part));
}

/**
 * Deepest nesting this will process.
 *
 * No real configuration is close to this — the deepest path the schema declares
 * is three levels (`sources.rss.enabled`). The cap exists because the input is
 * an untrusted file: a few kilobytes of nesting is enough to exhaust the stack,
 * and a `RangeError` escaping the load path stops the bot booting until someone
 * deletes the file by hand.
 */
const MAX_OVERRIDE_DEPTH = 32;

/** Thrown when input is nested past {@link MAX_OVERRIDE_DEPTH}. */
class TooDeepError extends Error {}

/** Recursively drop prototype-manipulating keys from parsed JSON. */
function stripDangerousKeys(value: unknown, depth = 0): unknown {
  // THROWS rather than returning undefined. Returning undefined silently
  // truncated the offending subtree, which would hand back a config that looks
  // valid and is not the one in the file — quietly wrong beats loudly ignored
  // only if you never have to debug it. The caller turns this into the same
  // "ignored, warned" outcome as any other malformed file.
  if (depth > MAX_OVERRIDE_DEPTH) {
    throw new TooDeepError(`nested deeper than ${MAX_OVERRIDE_DEPTH} levels`);
  }
  if (Array.isArray(value)) return value.map((v) => stripDangerousKeys(v, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.includes(key)) continue;
    out[key] = stripDangerousKeys(child, depth + 1);
  }
  return out;
}

/** What `loadOverrides` found, and whether it was usable. */
export interface LoadedOverrides {
  readonly values: Overrides;
  /**
   * The whole file was unusable and `values` is empty. Loud, and fatal to the
   * override layer — but never to the boot.
   */
  readonly problem?: string;
  /**
   * Part of the file was dropped and the REST OF `values` still applies.
   *
   * Distinct from `problem` because the caller does different things with them:
   * conflating the two made one planted section revert every real override.
   */
  readonly stripped?: string;
}

/**
 * Read the overrides file.
 *
 * Never throws. A missing file is the normal case; a malformed one yields empty
 * overrides plus a `problem` for the caller to log.
 */
export function loadOverrides(path: string): LoadedOverrides {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Missing is normal — most bots never touch the settings UI.
    return { values: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      values: {},
      problem: `"${path}" is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { values: {}, problem: `"${path}" does not contain a JSON object` };
  }

  const obj = parsed as Record<string, unknown>;
  const values = obj['values'];
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    return { values: {}, problem: `"${path}" has no "values" object` };
  }
  // Stripped on the way IN, so a file hand-edited, written by an older build,
  // or planted by another process cannot smuggle anything into the merge.
  let cleaned: Overrides;
  try {
    cleaned = stripDangerousKeys(values) as Overrides;
  } catch (err) {
    // Deeply nested input can exhaust the stack. This function promises never
    // to throw — a file that blows the stack must degrade to "ignored and
    // warned" like every other malformed case, not stop the bot booting.
    return {
      values: {},
      problem: `"${path}" could not be processed (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  const smuggled = FILE_ONLY_IN_OVERRIDES.filter((section) => section in cleaned);
  for (const section of smuggled) delete cleaned[section];
  if (smuggled.length > 0) {
    // `stripped`, not `problem`: the rest of the file is still good, and the
    // caller keeps it. Reporting this as a plain problem made the caller
    // discard EVERY override — so one planted section silently reverted all of
    // the operator's real settings, while the message said only that section
    // had been ignored.
    return {
      values: cleaned,
      stripped:
        `"${path}" contained ${smuggled.map((x) => `"${x}"`).join(' and ')}, which ` +
        'is configured in config.yaml only. Those sections were ignored; the rest of ' +
        'the file was applied. Something other than the settings UI wrote it.',
    };
  }
  return { values: cleaned };
}

/**
 * Write the overrides file atomically, keeping the previous version as `.bak`.
 *
 * Temp-file-plus-rename so a crash mid-write cannot leave a half-written file
 * that the next boot then ignores; the `.bak` means a bad save is recoverable
 * by deleting one file rather than by reconstructing it.
 */
export function writeOverrides(path: string, values: Overrides): void {
  const body = `${JSON.stringify({ _comment: FILE_HEADER, values }, null, 2)}\n`;
  const dir = dirname(path);
  // The directory may not exist yet: on a fresh install nothing has written
  // `data/` until the first post, so the FIRST settings save is exactly the
  // case that fails without this. Every other writer in this repo does the
  // same — ledger, queue, stats history, the lock file, the wallet backup.
  mkdirSync(dir, { recursive: true });

  // Unchanged content is not written at all. Otherwise every save — including
  // resetting a field that was never overridden — overwrites the `.bak`, and
  // "a bad save is recoverable by deleting one file" survives exactly one more
  // click anywhere in the UI.
  let current: string | undefined;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    /* no file yet */
  }
  if (current === body) return;

  // Back up by COPYING, then replace with a single atomic rename. Renaming the
  // live file aside first left a window with no settings file at all: if the
  // second rename then failed, the overrides were simply gone, and nothing
  // noticed until the next boot loaded none of them.
  if (current !== undefined) {
    try {
      writeFileSync(`${path}.bak`, current, 'utf8');
    } catch {
      /* a missing backup must not stop the save itself */
    }
  }

  const tmp = join(dir, `.${process.pid}.${Date.now()}.settings.tmp`);
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    // Never leave the temp file behind to accumulate in `data/`.
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

/**
 * Merge overrides onto a base object, returning a new object.
 *
 * Deep for plain objects, replace-wholesale for everything else. An array is
 * replaced rather than concatenated: a list of feeds or channel ids is a value
 * the operator set, not an accumulation, and merging element-wise would make
 * removing an entry impossible.
 */
export function mergeOverrides<T extends Record<string, unknown>>(
  base: T,
  over: Overrides,
  depth = 0,
): T {
  if (depth > MAX_OVERRIDE_DEPTH) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    // Never assign a prototype-manipulating key: the assignment would change
    // the object's prototype rather than adding a property, and every later
    // read would resolve through it.
    if (DANGEROUS_KEYS.includes(key)) continue;
    const existing = out[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = mergeOverrides(existing, value, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Read a dotted path out of a nested object. */
export function getPath(obj: unknown, path: string): unknown {
  let cursor: unknown = obj;
  for (const part of path.split('.')) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/**
 * Remove a dotted path, pruning any object it leaves empty.
 *
 * Pruning matters: an override file full of empty objects is indistinguishable
 * from one with real overrides when deciding whether a field is UI-set, and
 * "reset to file" has to leave no trace behind.
 */
export function deletePath(obj: Overrides, path: string): void {
  if (hasDangerousKey(path)) return;
  const parts = path.split('.');
  const last = parts.pop();
  if (last === undefined) return;

  const chain: Overrides[] = [obj];
  let cursor: Overrides = obj;
  for (const part of parts) {
    const next = cursor[part];
    if (!isPlainObject(next)) return; // nothing to delete
    cursor = next;
    chain.push(cursor);
  }
  delete cursor[last];

  for (let i = chain.length - 1; i > 0; i -= 1) {
    const node = chain[i]!;
    if (Object.keys(node).length > 0) break;
    const parentKey = parts[i - 1]!;
    delete chain[i - 1]![parentKey];
  }
}

/**
 * Whether any KEY in a nested object contains a dot.
 *
 * A literal key `"posting.dryRun"` flattens to exactly the same string as the
 * real nested path `posting` -> `dryRun`, so every check downstream — the
 * file-only guard, the known-path check — sees a legitimate path and waves it
 * through. Zod then strips the root key, so the write changes nothing, reports
 * "saved", and leaves junk in the overrides file that no reset can address
 * because `deletePath` walks segments the object does not have.
 *
 * Caught HERE, on the raw shape, before anything flattens it.
 */
export function findDottedKeys(obj: unknown, prefix = '', depth = 0): string[] {
  if (depth > MAX_OVERRIDE_DEPTH || !isPlainObject(obj)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const where = prefix === '' ? key : `${prefix}.${key}`;
    if (key.includes('.')) out.push(where);
    else out.push(...findDottedKeys(value, where, depth + 1));
  }
  return out;
}

/** Every dotted leaf path present in a nested object. */
export function leafPaths(obj: unknown, prefix = '', depth = 0): string[] {
  // Same cap as the load path. This walks an untrusted REQUEST body, and a
  // 16 KB payload reaches ~3,000 levels — enough to exhaust the stack and turn
  // every request into a 500. Capping one walker and not its sibling was the
  // asymmetry, not the depth itself.
  if (depth > MAX_OVERRIDE_DEPTH) return prefix === '' ? [] : [prefix];
  if (!isPlainObject(obj)) return prefix === '' ? [] : [prefix];
  const entries = Object.entries(obj);
  // An EMPTY object is itself a leaf. Returning nothing for it made
  // `{"panel":{}}` produce no paths at all — so the file-only guard found
  // nothing to refuse, the audit loop had nothing to record, and a write to a
  // protected section reached disk with no trace. Every caller here is driven
  // by this function, so a gap in it is a gap in all of them.
  if (entries.length === 0) return prefix === '' ? [] : [prefix];

  const out: string[] = [];
  for (const [key, value] of entries) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    // An array is a leaf VALUE, not a branch — see mergeOverrides.
    if (isPlainObject(value)) out.push(...leafPaths(value, path, depth + 1));
    else out.push(path);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
