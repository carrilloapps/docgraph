/**
 * Local structured logger. Everything stays on the user's machine — no
 * network calls, no telemetry endpoints. Log lines are JSON Lines written
 * to `.docgraph/docgraph.log`, rotated by size (see {@link DEFAULT_MAX_BYTES}).
 *
 * Equivalent to the local log file codegraph writes alongside its index
 * (`.codegraph/codegraph.log`); this is the docgraph analogue.
 *
 * Log levels (increasing verbosity): `error < warn < info < debug`.
 * Filter via `DOCGRAPH_LOG` env var or `logging.level` in settings.json.
 *
 * To inspect the log without leaving the terminal:
 *
 *   docgraph logs                          # last 50 lines
 *   docgraph logs --tail=200               # last 200 lines
 *   docgraph logs --level=error           # only errors
 *   docgraph logs --grep="vector"          # JSON-field substring search
 *   docgraph logs --follow                # stream new entries as they're written
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync, unlinkSync, readdirSync, openSync, readSync, closeSync } from 'fs';
import { join, basename } from 'path';
import process from 'process';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file before rotation
export const DEFAULT_MAX_FILES = 3; // docgraph.log, .1, .2

/**
 * Maximum size (bytes) of a single serialized log line. Entries that exceed
 * this after truncation are dropped before they ever hit the file. Default
 * 16 KB: long enough for a stack trace, short enough that no single line
 * can saturate rotation windows.
 */
export const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024;
/** Maximum size for a single string field inside an entry's `ctx`. */
export const DEFAULT_MAX_FIELD_BYTES = 4 * 1024;
/** Maximum depth for objects inside `ctx` to keep logging infinite. */
export const DEFAULT_MAX_DEPTH = 4;

const LEVELS = { error: 10, warn: 20, info: 30, debug: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export interface LogContext {
  /** Free-form key-value pairs to attach to every entry the logger emits. */
  [key: string]: unknown;
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  ctx?: LogContext;
}

/** Resolve the active log level from env, settings, then default (info). */
export function resolveLogLevel(projectPath: string): LogLevel {
  const env = process.env.DOCGRAPH_LOG;
  if (env && isLevel(env)) return env;
  const settingsPath = join(projectPath, '.docgraph', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (raw?.logging?.level && isLevel(raw.logging.level)) return raw.logging.level;
    } catch {
      // Malformed settings fall through to default.
    }
  }
  return 'info';
}

function isLevel(value: string): value is LogLevel {
  return value === 'error' || value === 'warn' || value === 'info' || value === 'debug';
}

/**
 * Resolve whether entries should also mirror to stderr, from env, then this
 * project's settings, then default (off). Mirrors {@link resolveLogLevel}'s
 * precedence so `DOCGRAPH_DEBUG` still works as a global override even
 * though the setting itself is per-project.
 */
export function resolveMirrorStderr(projectPath: string): boolean {
  const env = process.env.DOCGRAPH_DEBUG;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  const settingsPath = join(projectPath, '.docgraph', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (typeof raw?.logging?.mirrorStderr === 'boolean') return raw.logging.mirrorStderr;
    } catch {
      // Malformed settings fall through to default.
    }
  }
  return false;
}

/**
 * File-backed structured logger. Each instance writes to a single log file in
 * `.docgraph/` and rotates automatically when the file exceeds the size cap.
 *
 * Thread/IO model: writes are synchronous `appendFileSync` calls, so callers
 * never buffer events past a request boundary. The logger never blocks on
 * disk space larger than one line and never throws (a failing write falls
 * back to `console.error` so the host process never breaks).
 */
export class LocalLogger {
  /**
   * Per-instance active severity threshold. Deliberately NOT static: each
   * project in a multi-project MCP server has its own `.docgraph/settings.json`
   * with its own `logging.level`, so the threshold must live on the logger
   * instance that was constructed for that project, not process-wide.
   * `child()`/`withContext()` create children via `Object.create(this)`, so
   * children that don't set their own value inherit this via the prototype
   * chain — they always see whichever level the *original* project logger
   * resolved at construction.
   */
  private activeLevel: number = LEVELS.info;
  /** When set, every entry is also written to stderr (used by `DOCGRAPH_DEBUG=1` or `logging.mirrorStderr`). Per-instance for the same reason as {@link activeLevel}. */
  private mirrorStderr = false;

  readonly logFile: string;
  readonly projectPath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly maxEntryBytes: number;
  readonly maxFieldBytes: number;
  readonly maxDepth: number;
  private context: LogContext = {};
  private rotationInProgress = false;
  /** Counter of entries dropped because they exceeded the per-entry byte cap. */
  private droppedEntries = 0;

  constructor(
    opts: {
      projectPath: string;
      maxBytes?: number;
      maxFiles?: number;
      level?: LogLevel;
      /** Explicit override; when omitted, resolved from this project's settings (see {@link resolveMirrorStderr}). */
      mirrorStderr?: boolean;
      maxEntryBytes?: number;
      maxFieldBytes?: number;
      maxDepth?: number;
    } = { projectPath: process.cwd() },
  ) {
    this.projectPath = opts.projectPath;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
    this.maxFieldBytes = opts.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.logFile = join(opts.projectPath, '.docgraph', 'docgraph.log');

    // Resolved per-instance from THIS project's settings/env — never shared
    // process-wide, so two ProjectRegistry-managed loggers for two different
    // projects each honour their own `logging.level`/`logging.mirrorStderr`.
    const level = opts.level ?? resolveLogLevel(opts.projectPath);
    this.activeLevel = LEVELS[level];
    this.mirrorStderr = opts.mirrorStderr ?? resolveMirrorStderr(opts.projectPath);

    // Ensure the .docgraph directory exists at construction time so the very
    // first info() call doesn't race the directory creation.
    mkdirSync(join(opts.projectPath, '.docgraph'), { recursive: true });
  }

  /** Read-only access to the drop counter (exposed for `docgraph logs --stats`). */
  get drops(): number {
    return this.droppedEntries;
  }

  /**
   * Bind a static context that is attached to every entry. Used to track
   * fields like `projectPath`, `session`, or `tool_call_name` across the
   * lifetime of a request without re-supplying them.
   */
  withContext(extra: LogContext): LocalLogger {
    const child = Object.create(this) as LocalLogger;
    child.context = { ...this.context, ...extra };
    return child;
  }

  child(extra: LogContext): LocalLogger {
    return this.withContext(extra);
  }

  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }

  /**
   * Mirrors {@link console.error} so callers that already log via console
   * (or use `process.on('uncaughtException')`) don't need a parallel API.
   * The error is normalised into a structured entry first.
   */
  logError(err: unknown, context?: LogContext): void {
    const errInfo =
      err instanceof Error
        ? { message: err.message, stack: err.stack, name: err.name }
        : { message: String(err) };
    this.error('uncaught', { ...errInfo, ...(context || {}) });
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVELS[level] > this.activeLevel) return;

    const entry: LogEntry = { ts: new Date().toISOString(), level, msg: truncateString(message, this.maxEntryBytes) };
    const merged = { ...this.context, ...(context || {}) };
    if (Object.keys(merged).length > 0) {
      // Bounded-depth + bounded-field-width serialisation keeps a single entry
      // below maxEntryBytes no matter how large the upstream context object.
      entry.ctx = sanitiseContext(merged, this.maxDepth, this.maxFieldBytes) as LogContext;
    }

    let line: string;
    try {
      line = JSON.stringify(entry) + '\n';
    } catch {
      line = JSON.stringify({ ts: entry.ts, level, msg: entry.msg }) + '\n';
    }

    if (line.length > this.maxEntryBytes) {
      // If we still exceed the cap (e.g. msg itself is gigantic), drop the
      // verbose fields and emit a short summary record so the entry never
      // grows larger than the cap. If even that exceeds it, drop entirely.
      const minimal = JSON.stringify({
        ts: entry.ts,
        level,
        msg: entry.msg.slice(0, this.maxFieldBytes),
        ctx: { dropped: true, reason: 'entry exceeds maxEntryBytes', originalBytes: line.length },
      }) + '\n';
      if (minimal.length > this.maxEntryBytes) {
        this.droppedEntries++;
        return;
      }
      line = minimal;
    }

    if (this.mirrorStderr) {
      try {
        process.stderr.write(line);
      } catch {
        // Stderr may be closed if the parent has detached; ignore.
      }
    }

    try {
      this.rotateIfNeeded(line);
      appendFileSync(this.logFile, line, 'utf-8');
    } catch (err) {
      // Last resort: log to stderr so the failure is visible during debugging.
      try {
        process.stderr.write(`[docgraph] logger failed: ${(err as Error).message}\n`);
      } catch {
        // ignored
      }
    }
  }

  private rotateIfNeeded(_nextLine: string): void {
    if (this.rotationInProgress) return;
    let stats;
    try {
      stats = statSync(this.logFile);
    } catch {
      return;
    }
    if (stats.size + _nextLine.length <= this.maxBytes) return;

    this.rotationInProgress = true;
    try {
      if (this.maxFiles <= 1) {
        // No room for even one archive: drop old content and start the
        // active file fresh so the total file count never exceeds 1.
        try {
          appendFileSync(this.logFile, '', { flag: 'w' });
        } catch {
          /* ignored */
        }
        return;
      }

      // Shift existing archives up one slot: .{maxFiles-2} -> .{maxFiles-1},
      // ..., .1 -> .2. The oldest archive (.{maxFiles-1}) is overwritten (and
      // thus dropped) by the shift from .{maxFiles-2} — that's the intended
      // eviction of the oldest retained file. Then docgraph.log -> .1. This
      // keeps the TOTAL file count (active log + archives) at exactly
      // `maxFiles`, e.g. for maxFiles=3: docgraph.log, .1, .2 (never a .3).
      for (let i = this.maxFiles - 2; i >= 1; i--) {
        const from = `${this.logFile}.${i}`;
        const to = `${this.logFile}.${i + 1}`;
        if (existsSync(from)) {
          try {
            renameSync(from, to);
          } catch {
            // Best effort; old rotated files we can't move drop off naturally.
          }
        }
      }
      const archived = `${this.logFile}.1`;
      try {
        renameSync(this.logFile, archived);
      } catch {
        // If we can't rotate (Windows file lock), just truncate to keep the file bounded.
        try {
          appendFileSync(this.logFile, '', { flag: 'w' });
        } catch {
          /* ignored */
        }
      }

      // Defensive cleanup: remove any stale archive beyond the retention
      // window (e.g. left over from a previous run with a larger maxFiles),
      // so the count never creeps back above maxFiles.
      for (let i = this.maxFiles; ; i++) {
        const stale = `${this.logFile}.${i}`;
        if (!existsSync(stale)) break;
        try {
          unlinkSync(stale);
        } catch {
          break;
        }
      }
    } finally {
      this.rotationInProgress = false;
    }
  }

  /** Synchronously flushes pending events (writes are sync, so this is a no-op). */
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

/* -------------------------------------------------------------------------- */
/*                            `docgraph logs` CLI                             */
/* -------------------------------------------------------------------------- */

/**
 * Read the tail of the active log file (or any rotated sibling). Used by the
 * `docgraph logs` CLI command — no dependency on the live logger instance so
 * the CLI can run without first opening a Container.
 *
 * When `follow` is set, this doesn't just re-poll a fixed trailing window —
 * it tracks a byte offset into the file and, on every poll, reads only the
 * bytes appended since the last poll (so it keeps working after the file
 * grows past the initial read window, e.g. past 64 KB). Each newly-completed
 * line is parsed and, if it passes the `level`/`grep` filters, appended to
 * the eventual return value AND, if `onEntry` is supplied, delivered to it
 * immediately — so a caller (e.g. the CLI) can print entries live instead of
 * waiting for the returned promise to resolve. The promise itself only
 * resolves on `SIGINT` (Ctrl-C), matching the "run until interrupted"
 * semantics of `tail -f`. If the file shrinks between polls (rotation
 * replaced it with a fresh, smaller file) the offset is reset to 0 so lines
 * written to the new file are picked up from its start.
 */
export interface LogReadOptions {
  logFile?: string;
  tail?: number;
  level?: LogLevel | 'all';
  grep?: string;
  follow?: boolean;
  jsonOutput?: boolean;
  /** Called with each new entry as it's discovered while `follow` is active. Not invoked for the non-follow batch read. */
  onEntry?: (entry: LogEntry) => void;
  /** Poll interval in ms for the `follow` loop. Default 250; mainly exposed for tests. */
  pollIntervalMs?: number;
}

export interface LogReadResult {
  entries: LogEntry[];
  stats: {
    total: number;
    byLevel: Record<LogLevel, number>;
  };
}

export async function readLog(projectPath: string, opts: LogReadOptions = {}): Promise<LogReadResult> {
  const logFile = opts.logFile ?? join(projectPath, '.docgraph', 'docgraph.log');
  if (!existsSync(logFile)) return { entries: [], stats: { total: 0, byLevel: defaultLevelCounts() } };

  // Limit filter: omit entries more verbose than the chosen level.
  // Severity hierarchy: error(10) < warn(20) < info(30) < debug(40).
  const maxSeverity = opts.level && opts.level !== 'all' ? LEVELS[opts.level] : Number.POSITIVE_INFINITY;
  const entries: LogEntry[] = [];

  /** Parse one line into a LogEntry, applying level/grep filters. Returns null for malformed or filtered-out lines. */
  const parseLine = (line: string): LogEntry | null => {
    if (!line) return null;
    try {
      const entry = JSON.parse(line) as LogEntry;
      if (LEVELS[entry.level] > maxSeverity) return null;
      if (opts.grep && !JSON.stringify(entry).includes(opts.grep)) return null;
      return entry;
    } catch {
      // Skip malformed lines silently — partial writes during rotation.
      return null;
    }
  };

  const processEntries = (raw: string): void => {
    for (const line of raw.split('\n')) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }
  };

  const tail = opts.tail ?? 50;
  // Always read at least 64 KB so we can survive long entries (a single
  // ERROR log with stack context can easily exceed 4 KB); the slice below
  // trims back to `tail` after filtering.
  const readBytes = Math.max(tail * 1024, 64 * 1024);
  if (opts.follow) {
    // Track a byte OFFSET into the file rather than re-reading a fixed
    // trailing window on every poll. Re-reading a fixed window (the old
    // approach) plateaus once the file grows past that window — `data.length`
    // stops increasing even though new lines keep landing beyond the window,
    // so `data.length > cursor` goes permanently false and new entries are
    // silently missed. Reading exactly the bytes appended since the last
    // offset has no such ceiling: it keeps working correctly no matter how
    // large the file grows.
    let size: number;
    try {
      size = statSync(logFile).size;
    } catch {
      size = 0;
    }
    // Initial tail: start `readBytes` back from EOF (or 0 if the file is
    // smaller than that), same window as the non-follow path, so `--follow`
    // shows recent context before streaming new lines.
    let offset = Math.max(0, size - readBytes);
    // Holds a line fragment that hasn't seen its trailing `\n` yet, in case a
    // poll lands mid-write; carried over to the next poll instead of being
    // parsed (and likely failing) prematurely.
    let pending = '';

    const consume = (raw: string): void => {
      pending += raw;
      const lines = pending.split('\n');
      pending = lines.pop() ?? ''; // last element has no trailing \n yet (or is '')
      for (const line of lines) {
        const entry = parseLine(line);
        if (entry) {
          entries.push(entry);
          opts.onEntry?.(entry);
        }
      }
    };

    if (size > offset) {
      consume(readRange(logFile, offset, size - offset));
      offset = size;
    }

    const pollIntervalMs = opts.pollIntervalMs ?? 250;
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        let currentSize: number;
        try {
          currentSize = statSync(logFile).size;
        } catch {
          // File may be momentarily missing mid-rotation (renamed away, not
          // yet recreated); try again next tick.
          return;
        }
        if (currentSize < offset) {
          // The file shrank — rotation replaced it with a fresh, smaller
          // file. Start over from its beginning so we don't miss its lines.
          offset = 0;
          pending = '';
        }
        if (currentSize > offset) {
          consume(readRange(logFile, offset, currentSize - offset));
          offset = currentSize;
        }
      };
      const watcher = setInterval(poll, pollIntervalMs);
      process.once('SIGINT', () => {
        clearInterval(watcher);
        resolve();
      });
    });
  } else {
    const raw = readTail(logFile, readBytes);
    processEntries(raw);
  }

  // Apply the tail window AFTER level/grep filtering so the result honours the user's intent.
  const sliced = entries.slice(-tail);
  const byLevel: Record<LogLevel, number> = defaultLevelCounts();
  for (const entry of sliced) byLevel[entry.level]++;

  return { entries: sliced, stats: { total: sliced.length, byLevel } };
}

function defaultLevelCounts(): Record<LogLevel, number> {
  return { error: 0, warn: 0, info: 0, debug: 0 };
}

/**
 * Read the last N bytes of a file, returning the content as a UTF-8 string.
 * On read failure (e.g. rotated mid-read) returns whatever was readable.
 */
function readTail(filePath: string, maxBytes: number): string {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return '';
  }
  const size = stats.size;
  const start = Math.max(0, size - maxBytes);
  return readRange(filePath, start, size - start);
}

/**
 * Read exactly `length` bytes starting at byte `start`, returning the
 * content as a UTF-8 string. Used by the `--follow` loop to read only the
 * bytes appended since the last poll (as opposed to re-reading a fixed
 * trailing window every time, which is what let new lines silently plateau
 * once the file grew past that window). Returns '' on read failure (e.g. the
 * file vanished mid-rotation) so a poll tick never throws.
 */
function readRange(filePath: string, start: number, length: number): string {
  if (length <= 0) return '';
  let fh: number;
  try {
    fh = openSync(filePath, 'r');
  } catch {
    return '';
  }
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fh, buffer, 0, length, start);
    return buffer.toString('utf-8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    closeSync(fh);
  }
}

/**
 * Enumerate every rotated log file (`docgraph.log`, `docgraph.log.1`, ...).
 * Used by `docgraph logs --all` to inspect older archives.
 */
export function listLogFiles(projectPath: string): string[] {
  const dir = join(projectPath, '.docgraph');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f === basename(DEFAULT_LOG_NAME) || f.startsWith(basename(DEFAULT_LOG_NAME) + '.'))
    .map((f) => join(dir, f));
}

const DEFAULT_LOG_NAME = 'docgraph.log';
export { DEFAULT_LOG_NAME as LOG_FILE_NAME };

/* -------------------------------------------------------------------------- */
/*                            Serialisation helpers                           */
/* -------------------------------------------------------------------------- */

function truncateString(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  if (max <= 16) return s.slice(0, max);
  return s.slice(0, max - 14) + '…[truncated]';
}

/**
 * Recursively serialise an arbitrary context object into a form guaranteed
 * to fit in the per-entry byte budget. Strings are length-capped, arrays
 * are bounded in length, and objects deeper than {@link maxDepth} are
 * flattened into a placeholder.
 */
function sanitiseContext(value: unknown, maxDepth: number, maxFieldBytes: number, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= maxDepth) return '[depth-truncated]';
  if (typeof value === 'string') return truncateString(value, maxFieldBytes);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (Array.isArray(value)) {
    if (value.length > 32) return { '[array.length]': value.length, sample: value.slice(0, 4).map((v) => sanitiseContext(v, maxDepth, maxFieldBytes, depth + 1)) };
    return value.map((v) => sanitiseContext(v, maxDepth, maxFieldBytes, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > 64) {
      out['[keys.truncated]'] = keys.length;
      keys = keys.slice(0, 64);
    }
    for (const key of keys) {
      try {
        out[key] = sanitiseContext((value as Record<string, unknown>)[key], maxDepth, maxFieldBytes, depth + 1);
      } catch {
        out[key] = '[unserializable]';
      }
    }
    return out;
  }
  return '[unknown]';
}

/**
 * No-op logger for callers that haven't been given a real one yet (tests,
 * library callers that don't care about logs). Every method is a typed
 * black-hole so missing-logger bugs surface as test failures, not crashes.
 */
export const noopLogger: LocalLogger = {
  logFile: '',
  projectPath: '',
  maxBytes: 0,
  maxFiles: 0,
  maxEntryBytes: 0,
  maxFieldBytes: 0,
  maxDepth: 0,
  drops: 0,
  withContext: () => noopLogger,
  child: () => noopLogger,
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  logError: () => {},
  flush: () => Promise.resolve(),
} as unknown as LocalLogger;

void rotateLegacyFileNameHint;

function rotateLegacyFileNameHint() {
  return DEFAULT_LOG_NAME;
}
