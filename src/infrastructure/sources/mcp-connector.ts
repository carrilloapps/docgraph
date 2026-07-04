import { spawn, ChildProcess } from 'child_process';
import { RemoteSource, RemoteDocument } from './types.js';
import { LocalLogger } from '../logging/local-logger.js';
import { getPackageVersion } from '../../version.js';

/**
 * Adapter that speaks JSON-RPC over stdio to any MCP-compatible server.
 * The MCP server's `tools/list` and `tools/call` methods are used to pull
 * its knowledge surface (anything that returns structured documents) into
 * docgraph as a {@link RemoteSource}.
 *
 * Two discovery strategies:
 *   - `static` — call a configured tool with a fixed argument and treat each
 *     result item as a separate document. Suitable for `notion_search`,
 *     `obsidian_list_notes`, `jira_search` and similar.
 *   - `paginated` — call a tool that returns `{ items: [...], nextPage? }`
 *     and walk pages until exhausted. Suitable for large corpora.
 *
 * Every pull cycle ignores anything that returns binary or html and only
 * treats entries that look like documents. Read-only by construction: the
 * adapter never sends a tool call whose name contains `create`, `update`,
 * `delete`, `write`, `set`, `push`, `post`, `patch` or `remove`.
 */

export type McpConnectorStrategy =
  | { kind: 'static'; tool: string; argument: Record<string, unknown> }
  | {
      kind: 'paginated';
      listTool: string;
      listArg: Record<string, unknown>;
      getTool?: string;
      pageSize?: number;
      maxPages?: number;
    };

export interface McpConnectorConfig {
  /** Display name for the source (e.g. `mcp-notion`). */
  name: string;
  /** Native MCP server description. */
  description?: string;
  /** Command + args to spawn the MCP server. */
  command: string[];
  /** Tool-discovery strategy. */
  strategy: McpConnectorStrategy;
  /** Optional env vars passed to the spawned MCP server. */
  env?: Record<string, string>;
  /** Time-to-live for the spawned process in ms (idle timeout before shutdown). */
  idleTimeoutMs?: number;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const DESTRUCTIVE_TOOL_KEYWORDS = [
  'create',
  'update',
  'delete',
  'write',
  'set',
  'push',
  'post',
  'patch',
  'remove',
  'send',
  'execute',
];

export class McpConnectorSource implements RemoteSource {
  readonly name: string;
  readonly description: string;
  private process: ChildProcess | null = null;
  private nextId = 1;
  private buffer = '';
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private config: McpConnectorConfig;
  private readonly logger: LocalLogger;
  private readonly idleTimeoutMs: number;
  private idleTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private maxPagesOverride?: number;

  constructor(config: McpConnectorConfig, logger?: LocalLogger) {
    this.config = config;
    this.name = config.name;
    this.description = config.description ?? `MCP source (${config.name}) — read-only`;
    this.logger = (logger ?? (globalThis as any).__docgraphLogger) || new LocalLogger({
      projectPath: process.cwd(),
      maxEntryBytes: 4 * 1024,
    });
    this.idleTimeoutMs = config.idleTimeoutMs ?? 5_000;
  }

  async list(): Promise<RemoteDocument[]> {
    const tools = await this.listTools();
    if (tools.length === 0) {
      this.logger.warn('mcp.source.no_tools', { source: this.name });
      return [];
    }
    const strategy = this.config.strategy;
    if (strategy.kind === 'static') {
      return this.fetchStatic(strategy.tool, strategy.argument, tools);
    }
    return this.fetchPaginated(strategy, tools);
  }

  async get(id: string): Promise<RemoteDocument | null> {
    const all = await this.list();
    return all.find((d) => d.id === id) ?? null;
  }

  /** See {@link RemoteSource.configureMaxPages}. Caps the `paginated` strategy's page walk. */
  configureMaxPages(maxPages: number): void {
    if (Number.isFinite(maxPages) && maxPages > 0) {
      this.maxPagesOverride = Math.floor(maxPages);
    }
  }

  /**
   * Spawn the MCP process lazily on the first call. We keep it alive across
   * multiple `list()` invocations until {@link idleTimeoutMs} of inactivity.
   */
  private async ensureStarted(): Promise<void> {
    if (this.connected && this.process) return;
    if (this.process) {
      try { this.process.kill(); } catch { /* already gone */ }
      this.process = null;
      this.connected = false;
    }
    const [cmd, ...args] = this.config.command;
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.config.env || {}) },
      shell: process.platform === 'win32',
    });
    this.process = child;
    this.buffer = '';
    this.pending.clear();
    this.connected = false;

    child.stdout.on('data', (chunk: Buffer) => this.feed(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      try { this.logger.debug('mcp.source.stderr', { source: this.name, chunk: text.slice(0, 1024) }); } catch { /* ignore */ }
    });
    child.on('exit', (code) => {
      this.connected = false;
      for (const [, p] of this.pending) p.reject(new Error(`mcp source exited (code=${code})`));
      this.pending.clear();
    });
    child.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });

    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'docgraph', version: getPackageVersion() },
    });
    this.connected = true;
    this.scheduleIdleShutdown();
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.shutdown().catch(() => undefined);
    }, this.idleTimeoutMs);
    // Don't let this timer keep the CLI process alive: once the real work is
    // done, the process should exit immediately rather than hang around for
    // up to `idleTimeoutMs` waiting to shut down a spawned MCP child it may
    // never call again.
    this.idleTimer.unref();
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.process && this.process.exitCode === null) {
      try {
        await this.rpc('shutdown', undefined, 2_000).catch(() => undefined);
      } catch { /* ignore */ }
      try { this.process.kill(); } catch { /* already gone */ }
    }
    this.process = null;
    this.connected = false;
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pending.get(response.id);
        if (pending) {
          this.pending.delete(response.id);
          if (response.error) pending.reject(new Error(`mcp: ${response.error.message}`));
          else pending.resolve(response.result);
        }
      } catch (err) {
        this.logger.debug('mcp.source.parse_error', { source: this.name, error: (err as Error).message });
      }
    }
  }

  private rpc(method: string, params?: unknown, timeoutMs = 8_000): Promise<unknown> {
    if (!this.process) return Promise.reject(new Error('mcp source not started'));
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`mcp rpc timeout: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try {
        this.process!.stdin!.write(JSON.stringify(request) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /**
   * Enumerate every tool the MCP server exposes, filtered to read-only names.
   * Used both as a sanity check and to populate the source's "discoverable"
   * surface so the CLI can list what each MCP connector can read.
   */
  async listTools(): Promise<string[]> {
    await this.ensureStarted();
    const result = (await this.rpc('tools/list')) as {
      tools?: { name: string; description?: string }[];
    };
    const tools = (result?.tools || []).map((t) => t.name).filter(isReadOnlyTool);
    return tools;
  }

  private async fetchStatic(tool: string, argument: Record<string, unknown>, allowedTools: string[]): Promise<RemoteDocument[]> {
    if (!isReadOnlyTool(tool)) {
      throw new Error(`Refusing read-only MCP source to call non-safe tool: ${tool}`);
    }
    if (!allowedTools.includes(tool)) {
      throw new Error(`Tool ${tool} not exposed by ${this.name} (or marked destructive)`);
    }
    await this.ensureStarted();
    const result = (await this.rpc('tools/call', { name: tool, arguments: argument })) as ToolCallResult;
    return toolResultToDocuments(result, this.name);
  }

  private async fetchPaginated(
    strategy: Extract<McpConnectorStrategy, { kind: 'paginated' }>,
    allowedTools: string[],
  ): Promise<RemoteDocument[]> {
    if (!isReadOnlyTool(strategy.listTool)) {
      throw new Error(`Refusing read-only MCP source to call non-safe tool: ${strategy.listTool}`);
    }
    if (!allowedTools.includes(strategy.listTool)) {
      throw new Error(`Tool ${strategy.listTool} not exposed by ${this.name} (or marked destructive)`);
    }
    const pageSize = Math.min(strategy.pageSize ?? 100, 250);
    const maxPages = Math.min(this.maxPagesOverride ?? strategy.maxPages ?? 50, 200);

    await this.ensureStarted();
    const documents: RemoteDocument[] = [];
    for (let page = 0; page < maxPages; page++) {
      this.scheduleIdleShutdown();
      const arg = { ...strategy.listArg, page, pageSize, limit: pageSize, offset: page * pageSize };
      const result = (await this.rpc('tools/call', { name: strategy.listTool, arguments: arg })) as ToolCallResult;
      const items = toolResultToDocuments(result, this.name);
      if (items.length === 0) break;
      documents.push(...items);
      if (items.length < pageSize) break;
      if (hasExplicitExhaustion(result)) break;
    }
    return documents;
  }
}

interface ToolCallResult {
  content?: Array<{ type: string; text?: string; data?: unknown; mimeType?: string }>;
  items?: unknown[];
  records?: unknown[];
  results?: unknown[];
  documents?: unknown[];
  nextCursor?: string | null;
  nextPage?: number | null;
  has_more?: boolean;
  hasMore?: boolean;
}

function isReadOnlyTool(name: string): boolean {
  const lower = name.toLowerCase();
  return !DESTRUCTIVE_TOOL_KEYWORDS.some((kw) => lower.includes(kw));
}

function hasExplicitExhaustion(result: ToolCallResult): boolean {
  if (result?.nextCursor === null) return true;
  if (result?.nextCursor === undefined && result?.nextPage === null) return true;
  if (result?.has_more === false) return true;
  if (result?.hasMore === false) return true;
  return false;
}

/**
 * Convert an MCP `tools/call` response into a list of {@link RemoteDocument}.
 * Accepts both the canonical MCP `content` array and the `items/results/...`
 * shortcuts some servers use for ergonomics. Each item gets a deterministic
 * `id` so re-pulls deduplicate against the local index.
 */
function toolResultToDocuments(result: unknown, sourceName: string): RemoteDocument[] {
  const documents: RemoteDocument[] = [];
  if (!result || typeof result !== 'object') return documents;
  const r = result as ToolCallResult;

  // MCP canonical: { content: [{ type: 'text', text: JSON.stringify(...) }, ...] }
  if (Array.isArray(r.content)) {
    for (const entry of r.content) {
      if (typeof entry?.text === 'string') {
        try {
          const parsed = JSON.parse(entry.text);
          for (const doc of coerceDocuments(parsed, sourceName)) documents.push(doc);
          continue;
        } catch {
          documents.push({
            id: `${sourceName}:content-${documents.length}`,
            path: `${sourceName}://content/${documents.length}`,
            content: entry.text,
            extension: '.md',
            tags: [sourceName],
            lastModified: undefined,
            metadata: { source: sourceName, mimeType: entry.mimeType },
          });
        }
      }
    }
  }

  // Shortcut shapes: items / results / documents / records
  for (const field of ['items', 'results', 'documents', 'records'] as const) {
    const arr = (r as any)[field];
    if (Array.isArray(arr)) {
      for (const doc of coerceDocuments(arr, sourceName)) documents.push(doc);
    }
  }

  return documents;
}

function coerceDocuments(value: unknown, sourceName: string): RemoteDocument[] {
  if (Array.isArray(value)) {
    const out: RemoteDocument[] = [];
    for (const item of value) {
      const d = coerceSingleDocument(item, sourceName);
      if (d) out.push(d);
    }
    return out;
  }
  const single = coerceSingleDocument(value, sourceName);
  return single ? [single] : [];
}

function coerceSingleDocument(item: unknown, sourceName: string): RemoteDocument | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const id =
    (typeof obj.id === 'string' && obj.id) ||
    (typeof obj.uri === 'string' && obj.uri) ||
    (typeof obj.key === 'string' && obj.key) ||
    (typeof obj.identifier === 'string' && obj.identifier) ||
    undefined;
  if (!id) return null;
  const path =
    (typeof obj.path === 'string' && obj.path) ||
    (typeof obj.uri === 'string' && obj.uri) ||
    (typeof obj.url === 'string' && obj.url) ||
    `${sourceName}://document/${id}`;
  const title =
    (typeof obj.title === 'string' && obj.title) ||
    (typeof obj.name === 'string' && obj.name) ||
    (typeof obj.summary === 'string' && obj.summary) ||
    undefined;
  const content =
    (typeof obj.content === 'string' && obj.content) ||
    (typeof obj.body === 'string' && obj.body) ||
    (typeof obj.text === 'string' && obj.text) ||
    (typeof obj.description === 'string' && obj.description) ||
    JSON.stringify(obj);
  const tagsRaw = obj.tags || obj.labels || obj.keywords;
  const tags = Array.isArray(tagsRaw) ? tagsRaw.filter((t): t is string => typeof t === 'string') : [];
  const lastModified =
    (typeof obj.updated_at === 'string' && obj.updated_at) ||
    (typeof obj.updatedAt === 'string' && obj.updatedAt) ||
    (typeof obj.lastModified === 'string' && obj.lastModified) ||
    undefined;

  return {
    id: `${sourceName}:${id}`,
    path,
    title,
    content,
    extension: '.md',
    tags,
    lastModified,
    metadata: { source: sourceName, raw: { keys: Object.keys(obj).slice(0, 24) } },
  };
}

/** Tiny helper to share a logger instance with the connector (used by tests). */
export function attachLoggerToConnectors(logger: LocalLogger): void {
  (globalThis as any).__docgraphLogger = logger;
}
