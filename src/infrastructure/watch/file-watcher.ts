import chokidar, { FSWatcher } from 'chokidar';
import { realpathSync } from 'fs';
import { LocalLogger, noopLogger } from '../logging/local-logger.js';

export interface WatchCallbacks {
  /** Called (debounced) with the set of created/modified file paths. */
  onChange: (paths: string[]) => void | Promise<void>;
  /** Called (debounced) with the set of removed file paths. */
  onRemove?: (paths: string[]) => void | Promise<void>;
}

export interface ProjectWatcherOptions {
  /** Debounce window (ms) to coalesce bursts of file events. Default 1000. */
  debounceMs?: number;
  logger?: LocalLogger;
}

/** Directory/segment names never worth watching (perf + noise). */
const HARD_IGNORE = /(^|[\\/])(\.git|\.docgraph|node_modules|dist|dist-test|build|\.next|\.cache|coverage|\.turbo)([\\/]|$)/;

/**
 * Watches a project directory and invokes debounced callbacks when files
 * change, so a long-lived process (the MCP server or `docgraph watch`) can
 * keep its index in sync automatically. Cross-platform via chokidar
 * (FSEvents / inotify / ReadDirectoryChangesW under the hood).
 */
export class ProjectWatcher {
  private watcher: FSWatcher | null = null;
  private readonly changed = new Set<string>();
  private readonly removed = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private readonly debounceMs: number;
  private readonly logger: LocalLogger;

  constructor(
    private readonly projectPath: string,
    private readonly callbacks: WatchCallbacks,
    opts: ProjectWatcherOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 1000;
    this.logger = opts.logger ?? noopLogger;
  }

  start(): void {
    if (this.watcher) return;

    // Watch the canonical (long-form, real-case) path. On Windows, passing a
    // path that contains an 8.3 short name (e.g. `C:\Users\JUNIOR~1\...`) or a
    // case variant makes libuv's native fs-event backend abort the process
    // (`Assertion failed: !_wcsnicmp(...)` in fs-event.c). Resolving to the
    // real path avoids that hard crash.
    let target = this.projectPath;
    try {
      target = realpathSync.native(this.projectPath);
    } catch {
      // Path may not exist yet or realpath unsupported — fall back to as-given.
    }

    // Polling is slower but immune to native-backend quirks (network drives,
    // WSL, exotic filesystems). Opt in via DOCGRAPH_WATCH_POLLING=1.
    const usePolling = process.env.DOCGRAPH_WATCH_POLLING === '1';

    this.watcher = chokidar.watch(target, {
      ignored: (p: string) => HARD_IGNORE.test(p),
      ignoreInitial: true,
      persistent: true,
      usePolling,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    this.watcher
      .on('add', (p) => this.enqueue(this.changed, p))
      .on('change', (p) => this.enqueue(this.changed, p))
      .on('unlink', (p) => this.enqueue(this.removed, p))
      .on('error', (err) => this.logger.logError(err, { component: 'watch' }));

    this.logger.info('watch.started', { projectPath: this.projectPath, debounceMs: this.debounceMs });
  }

  private enqueue(set: Set<string>, path: string): void {
    // A path that is re-created after removal (or vice-versa) should only live
    // in one bucket — the most recent event wins.
    this.changed.delete(path);
    this.removed.delete(path);
    set.add(path);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      // A flush is already running; reschedule so nothing is lost.
      this.timer = setTimeout(() => void this.flush(), this.debounceMs);
      return;
    }
    const changed = [...this.changed];
    const removed = [...this.removed];
    this.changed.clear();
    this.removed.clear();
    if (changed.length === 0 && removed.length === 0) return;

    this.flushing = true;
    try {
      if (removed.length > 0 && this.callbacks.onRemove) {
        await this.callbacks.onRemove(removed);
      }
      if (changed.length > 0) {
        await this.callbacks.onChange(changed);
      }
    } catch (err) {
      this.logger.logError(err, { component: 'watch', phase: 'flush' });
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.logger.info('watch.stopped', { projectPath: this.projectPath });
  }
}
