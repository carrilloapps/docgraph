import { resolve as resolvePath } from 'node:path';
import { Container, ContainerOptions } from './container.js';
import { LocalLogger, noopLogger } from './infrastructure/logging/local-logger.js';

export interface ProjectRegistryOptions extends ContainerOptions {
  /** Maximum number of projects kept in memory. */
  maxProjects?: number;
  /** Logger used for registry-level events (evictions, path resolutions). */
  logger?: LocalLogger;
}

/**
 * A cached project's Container plus its LRU/busy bookkeeping. `refCount`
 * tracks in-flight callers (see {@link ProjectRegistry.acquire}); an entry
 * with `refCount > 0` is "pinned" and must not be closed by eviction.
 */
interface CacheEntry {
  container: Container;
  refCount: number;
}

/**
 * Maintains a per-project {@link Container} so a single MCP server process can
 * serve multiple projects. Mirrors codegraph's `projectPath`-per-call model:
 * the project root is inferred from the tool call, the env var
 * `DOCGRAPH_PROJECT`, or the process cwd — and capped to a small LRU so a
 * long-running server doesn't grow unbounded.
 */
export class ProjectRegistry {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxProjects: number;
  private readonly logger: LocalLogger;

  constructor(options: ProjectRegistryOptions = {}) {
    this.maxProjects = options.maxProjects ?? 16;
    this.logger = options.logger ?? noopLogger;
    if (options.onProgress) {
      void options.onProgress;
    }
  }

  resolveProjectPath(explicit: string | undefined): string {
    if (explicit && explicit.trim()) {
      return explicit;
    }
    const envPath = process.env.DOCGRAPH_PROJECT;
    if (envPath && envPath.trim()) {
      return envPath;
    }
    return process.cwd();
  }

  /**
   * Get-or-create the container for a project path. Moves the project to the
   * most-recently-used position so the LRU keeps hot projects alive.
   */
  get(projectPath: string, options: ContainerOptions = {}): Container {
    const normalized = normalizeProjectPath(projectPath);
    const existing = this.cache.get(normalized);
    if (existing) {
      this.cache.delete(normalized);
      this.cache.set(normalized, existing);
      return existing.container;
    }

    this.evictIfNeeded();

    const logger = options.logger ?? this.logger.child({ project: normalized });
    const container = new Container(normalized, { ...options, logger });
    this.logger.info('project.loaded', { project: normalized, cacheSize: this.cache.size + 1 });
    this.cache.set(normalized, { container, refCount: 0 });
    return container;
  }

  has(projectPath: string): boolean {
    return this.cache.has(normalizeProjectPath(projectPath));
  }

  /**
   * Mark a project as busy (in-flight) so eviction won't close its Container
   * while a caller is still using it. The MCP server should call this right
   * after `get()`, before it starts dispatching a tool call against that
   * project's Container, and MUST pair it with a matching `release()` in a
   * `finally` block, e.g.:
   *
   *   const container = registry.get(projectPath);
   *   registry.acquire(projectPath);
   *   try {
   *     // ... use container for the duration of the tool call ...
   *   } finally {
   *     registry.release(projectPath);
   *   }
   *
   * Calls nest safely (an internal ref count), so overlapping tool calls
   * against the same project are each free to acquire/release independently.
   * No-op if the project isn't currently cached.
   */
  acquire(projectPath: string): void {
    const entry = this.cache.get(normalizeProjectPath(projectPath));
    if (entry) entry.refCount++;
  }

  /** Release a busy-mark taken via {@link acquire}. No-op if not cached or not held. */
  release(projectPath: string): void {
    const entry = this.cache.get(normalizeProjectPath(projectPath));
    if (entry && entry.refCount > 0) entry.refCount--;
  }

  /** True if the project is currently pinned by one or more in-flight callers. */
  isBusy(projectPath: string): boolean {
    const entry = this.cache.get(normalizeProjectPath(projectPath));
    return !!entry && entry.refCount > 0;
  }

  invalidate(projectPath: string): void {
    const normalized = normalizeProjectPath(projectPath);
    const existing = this.cache.get(normalized);
    if (existing) {
      if (existing.refCount > 0) {
        // Don't close a Container that's mid-request; the caller can retry
        // once the in-flight tool call releases it.
        this.logger.warn('project.invalidate_skipped_busy', { project: normalized, refCount: existing.refCount });
        return;
      }
      existing.container.close();
      this.cache.delete(normalized);
      this.logger.info('project.invalidated', { project: normalized });
    }
  }

  close(): void {
    for (const entry of this.cache.values()) {
      entry.container.close();
    }
    this.cache.clear();
    this.logger.info('project.registry_closed', { closed: true });
  }

  private evictIfNeeded(): void {
    while (this.cache.size >= this.maxProjects) {
      const victimKey = this.findEvictionCandidate();
      if (!victimKey) {
        // Every cached entry is pinned (in-flight). Refuse to close a
        // Container that's currently servicing a request — correctness beats
        // the memory bound here: closing mid-flight risks a Windows file
        // lock error or handing a caller a closed DB handle. We temporarily
        // allow the cache to grow past maxProjects instead.
        this.logger.warn('project.eviction_skipped_all_busy', { cacheSize: this.cache.size });
        break;
      }
      const victim = this.cache.get(victimKey);
      victim?.container.close();
      this.cache.delete(victimKey);
      this.logger.info('project.evicted', { project: victimKey });
    }
  }

  /**
   * Oldest (least-recently-used) unpinned entry's key, or `undefined` if
   * every cached entry is currently busy. `Map` iterates in insertion order,
   * and `get()` re-inserts on cache hits, so the first unpinned entry found
   * here is genuinely the LRU among the entries eviction is allowed to touch.
   */
  private findEvictionCandidate(): string | undefined {
    for (const [key, entry] of this.cache) {
      if (entry.refCount === 0) return key;
    }
    return undefined;
  }
}

/**
 * Canonicalize a project path into a single cache key so equivalent
 * spellings — different separators (`C:\proj` vs `C:/proj`), relative vs
 * absolute (`./proj`), trailing slashes, or (on Windows) letter case — all
 * resolve to the same registry slot. Without this, two spellings of the same
 * project would each open their own {@link Container}/DB handle, which on
 * Windows risks a file-lock conflict on the same underlying database file.
 */
function normalizeProjectPath(projectPath: string): string {
  const resolved = resolvePath(projectPath);
  // Windows filesystems are case-insensitive (NTFS is case-preserving but not
  // case-sensitive), so fold the whole path to a single case to collapse
  // `C:\Proj`, `c:/proj/`, and `C:\PROJ` into one cache entry.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
