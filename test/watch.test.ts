import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectWatcher } from '../src/infrastructure/watch/file-watcher.js';

/**
 * Exercises the chokidar-backed `ProjectWatcher` end to end: real filesystem
 * writes/deletes against a real watcher instance, asserting the debounced
 * `onChange` / `onRemove` callbacks fire with the affected paths. Timing is
 * inherently asynchronous (chokidar's own `awaitWriteFinish` stability
 * window plus our debounce), so tests await a deferred promise instead of a
 * fixed sleep, guarded by a generous `Promise.race` timeout so a genuine
 * regression fails cleanly rather than hanging the suite.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const normalize = (p: string): string => p.replace(/\\/g, '/');

test('ProjectWatcher fires onChange for a newly created file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-watch-'));
  const changed = deferred<string[]>();
  const watcher = new ProjectWatcher(
    dir,
    {
      onChange: (paths) => changed.resolve(paths),
      onRemove: () => {},
    },
    { debounceMs: 150 },
  );

  try {
    watcher.start();
    // Give chokidar's initial directory scan time to settle before creating
    // the file — writing immediately after `start()` risks the create event
    // landing before the watcher has finished wiring up its listeners.
    await sleep(500);

    const filePath = join(dir, 'new-file.md');
    writeFileSync(filePath, '# New file\n\nHello world.\n', 'utf-8');

    const paths = await withTimeout(changed.promise, 20_000, 'onChange did not fire within 20s');
    assert.ok(
      paths.some((p) => normalize(p).endsWith('new-file.md')),
      `expected changed paths to include new-file.md, got ${JSON.stringify(paths)}`,
    );
  } finally {
    await watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ProjectWatcher fires onRemove for a deleted file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-watch-rm-'));
  const filePath = join(dir, 'to-delete.md');
  writeFileSync(filePath, '# Bye\n\nThis file will be removed.\n', 'utf-8');

  const removed = deferred<string[]>();
  const watcher = new ProjectWatcher(
    dir,
    {
      onChange: () => {},
      onRemove: (paths) => removed.resolve(paths),
    },
    { debounceMs: 150 },
  );

  try {
    watcher.start();
    // Let the watcher finish its initial scan (which will notice the
    // pre-existing file but must not report it, since ignoreInitial is on)
    // before deleting it.
    await sleep(500);

    rmSync(filePath);

    const paths = await withTimeout(removed.promise, 20_000, 'onRemove did not fire within 20s');
    assert.ok(
      paths.some((p) => normalize(p).endsWith('to-delete.md')),
      `expected removed paths to include to-delete.md, got ${JSON.stringify(paths)}`,
    );
  } finally {
    await watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ProjectWatcher start() is idempotent and stop() can be called without start()', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docgraph-watch-idem-'));
  const watcher = new ProjectWatcher(dir, { onChange: () => {} }, { debounceMs: 150 });
  try {
    watcher.start();
    // Calling start() again while already running must not throw or create
    // a second underlying watcher.
    assert.doesNotThrow(() => watcher.start());
  } finally {
    await watcher.stop();
    // Calling stop() a second time (already stopped) must also be safe.
    await assert.doesNotReject(() => watcher.stop());
    rmSync(dir, { recursive: true, force: true });
  }
});
