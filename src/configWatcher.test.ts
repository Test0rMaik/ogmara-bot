import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchConfigFile, type ConfigWatcher } from './configWatcher.js';

let dir: string;
let configPath: string;
let watcher: ConfigWatcher | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ogmara-configwatcher-'));
  configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, 'node:\n  url: https://node.example\n', 'utf8');
});

afterEach(() => {
  watcher?.close();
  watcher = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Poll until `predicate()` is true or `timeoutMs` elapses, whichever first. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('watchConfigFile', () => {
  it('fires onChange when the watched file is modified', async () => {
    let calls = 0;
    watcher = watchConfigFile(configPath, () => calls++, 20);
    writeFileSync(configPath, 'node:\n  url: https://changed.example\n', 'utf8');
    await waitFor(() => calls >= 1);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('debounces a burst of writes into a single onChange call', async () => {
    let calls = 0;
    watcher = watchConfigFile(configPath, () => calls++, 50);
    for (let i = 0; i < 5; i++) {
      writeFileSync(configPath, `node:\n  url: https://changed-${i}.example\n`, 'utf8');
    }
    // Give the burst time to settle well past the debounce window, then
    // confirm it collapsed to exactly one call, not five.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toBe(1);
  });

  it('close() stops future callbacks from firing', async () => {
    let calls = 0;
    watcher = watchConfigFile(configPath, () => calls++, 20);
    watcher.close();
    writeFileSync(configPath, 'node:\n  url: https://after-close.example\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls).toBe(0);
  });

  it('ignores changes to a DIFFERENT file in the same directory', async () => {
    let calls = 0;
    watcher = watchConfigFile(configPath, () => calls++, 20);
    writeFileSync(join(dir, 'unrelated.txt'), 'noise', 'utf8');
    // Give it a fair chance to (wrongly) fire, then confirm it didn't.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls).toBe(0);
  });

  it('survives a rename-based atomic save — and a SECOND one after that', async () => {
    // The exact bug this module's directory-watch design exists to avoid:
    // an editor that writes a temp file and renames it over the original
    // replaces the inode. A watch tied to the file's own inode (fs.watch on
    // the file path directly, on Linux) goes silently dead after exactly
    // one such save. A directory watch, filtered by filename, does not.
    let calls = 0;
    watcher = watchConfigFile(configPath, () => calls++, 20);

    const tmp1 = `${configPath}.tmp1`;
    writeFileSync(tmp1, 'node:\n  url: https://first-save.example\n', 'utf8');
    renameSync(tmp1, configPath);
    await waitFor(() => calls >= 1);
    expect(calls).toBe(1);

    const tmp2 = `${configPath}.tmp2`;
    writeFileSync(tmp2, 'node:\n  url: https://second-save.example\n', 'utf8');
    renameSync(tmp2, configPath);
    await waitFor(() => calls >= 2);
    expect(calls).toBe(2);
  });

  it('does not throw when the directory does not exist — logs and returns a no-op watcher', () => {
    expect(() => {
      watcher = watchConfigFile(join(dir, 'nonexistent-subdir', 'config.yaml'), () => {}, 20);
    }).not.toThrow();
  });
});
