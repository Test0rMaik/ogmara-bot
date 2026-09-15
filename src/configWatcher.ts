/**
 * Watches `config.yaml` for hand-edits and re-applies the running config
 * through the SAME path a settings-panel save uses — one code path, two
 * triggers. Without this, an operator who edits `config.yaml` directly over
 * SSH (instead of using the panel) sees the change reflected in the panel's
 * OWN provenance display (`describe()` re-reads the file on every call) but
 * NOT in the running process, until they also happen to save something
 * through the UI — a hand-edit and a UI save should not behave differently.
 */

import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

export interface ConfigWatcher {
  /** Stop watching. Safe to call more than once. */
  close(): void;
}

/**
 * `fs.watch` on `config.yaml`, debounced.
 *
 * Watches the DIRECTORY rather than the file itself, filtering events by
 * filename — most editors save by writing a temp file and renaming it over
 * the original, which replaces the inode. On Linux, `fs.watch` on a file
 * path is backed by an inotify watch on that specific inode: after a
 * rename-based save the watch is left pointing at a file nothing writes to
 * again, and every SUBSEQUENT edit goes silently unnoticed. A directory
 * watch has no such tie to one inode.
 *
 * Debounced (trailing edge) because a single logical save can fire several
 * raw fs events in quick succession (truncate, write, rename) — `onChange`
 * should run once per save settling, not once per underlying event.
 *
 * Failure to watch at all (an unsupported platform, a missing directory) is
 * logged and non-fatal: this is a convenience on top of the working restart
 * path, not something the bot should refuse to start over.
 */
export function watchConfigFile(
  path: string,
  onChange: () => void,
  debounceMs = 300,
): ConfigWatcher {
  const dir = dirname(path);
  const name = basename(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;

  const scheduleOnChange = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, debounceMs);
  };

  try {
    watcher = watch(dir, (_eventType, filename) => {
      // `filename` can be null on some platforms/filesystems — treat that as
      // "something in the directory changed, could be ours" rather than
      // silently ignoring the event.
      if (filename === null || filename === name) scheduleOnChange();
    });
    watcher.on('error', (err) => {
      console.warn(
        `  warning: config.yaml watcher stopped (${err instanceof Error ? err.message : String(err)}) — ` +
          'hand-edits will need a restart to take effect until the bot is restarted.',
      );
    });
  } catch (err) {
    console.warn(
      `  warning: could not watch config.yaml for changes (${err instanceof Error ? err.message : String(err)}) — ` +
        'hand-edits will need a restart to take effect.',
    );
  }

  return {
    close(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      watcher?.close();
    },
  };
}
