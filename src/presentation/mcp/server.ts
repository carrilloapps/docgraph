#!/usr/bin/env node
import { resolve } from 'path';
import { existsSync, statSync, realpathSync } from 'fs';
import { Container } from '../../container.js';
import { ProjectRegistry } from '../../project-registry.js';
import { LocalLogger } from '../../infrastructure/logging/local-logger.js';
import { hasReadOnlyFlagOrEnv } from '../cli/args.js';
import { getPackageVersion } from '../../version.js';

// Project path is inferred, never hard-coded: an explicit positional argument
// wins, then the DOCGRAPH_PROJECT env var, then the current working directory
// (which is the project root when launched as a local MCP server by an agent).
const positional = process.argv.slice(2).find((a) => a !== 'serve' && !a.startsWith('-'));
const RESOLVED_PROJECT_PATH = resolve(positional || process.env.DOCGRAPH_PROJECT || process.cwd());
// Canonicalize to the real path (handles Windows 8.3 short names / case) so the
// autosync watcher and the indexer agree on paths.
const DEFAULT_PROJECT_PATH = (() => {
  try {
    return realpathSync.native(RESOLVED_PROJECT_PATH);
  } catch {
    return RESOLVED_PROJECT_PATH;
  }
})();
const DEBUG = process.env.DOCGRAPH_DEBUG === '1' || process.env.DOCGRAPH_DEBUG === 'true';
const REGISTRY_MAX = parseInt(process.env.DOCGRAPH_MAX_PROJECTS || '16', 10);
// Server-wide read-only override: `--read-only` / `DOCGRAPH_READ_ONLY` force
// every project this server loads into read-only mode, regardless of that
// project's own `.docgraph/settings.json`. When neither is set, each project
// still falls back to its own `settings.security.readOnly` (applied inside
// `Container` itself) — see `services()` below, which only forwards `true`,
// never `false`, so a per-project setting is never overridden to "writable".
const SERVER_READ_ONLY = hasReadOnlyFlagOrEnv(process.argv);

// One logger per server process — every project container gets a child
// prefixed with its project name so a single `.docgraph/docgraph.log`
// captures activity from every project the server has loaded.
const serverLogger = new LocalLogger({
  projectPath: DEFAULT_PROJECT_PATH,
  // DOCGRAPH_DEBUG env var is read inside LocalLogger; mirrorStderr defaults
  // to false so server logs never leak into the agent's stderr stream.
});

const registry = new ProjectRegistry({ maxProjects: REGISTRY_MAX, logger: serverLogger });

function services(projectPath?: string): Container {
  const resolved = projectPath || DEFAULT_PROJECT_PATH;
  const child = serverLogger.child({ project: resolved });
  // Only forward `readOnly: true` when the server-wide flag/env is set —
  // `undefined` lets Container fall back to the project's own
  // `settings.security.readOnly` instead of forcing it to `false`.
  return registry.get(resolved, { logger: child, readOnly: SERVER_READ_ONLY || undefined });
}

function sendResponse(id: string | number, result: unknown): void {
  const response = { jsonrpc: '2.0', id, result };
  if (DEBUG) serverLogger.debug('mcp.response', { id, method: typeof result === 'object' ? 'object' : 'scalar' });
  console.log(JSON.stringify(response));
}

function sendError(id: string | number, code: number, message: string, data?: unknown): void {
  const response = { jsonrpc: '2.0', id, error: { code, message, data } };
  console.log(JSON.stringify(response));
}

/**
 * Send a `tools/call` result in MCP's `CallToolResult` shape. The MCP spec
 * requires tool results to carry a `content` array (clients render the text
 * blocks); a raw object as `result` shows as empty in Claude Code and other
 * clients. The pretty-printed JSON goes in a text block, and the original
 * object is also attached as `structuredContent` for clients that consume it.
 */
function sendToolResult(id: string | number, data: unknown): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const result: { content: { type: 'text'; text: string }[]; structuredContent?: object } = {
    content: [{ type: 'text', text }],
  };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    result.structuredContent = data as object;
  }
  sendResponse(id, result);
}

/**
 * Tools exposed over MCP. Each tool that hits the docstore accepts an optional
 * `projectPath` (defaults to the inferred project root) so one MCP process can
 * serve many indexed projects — the same model codegraph uses.
 */
function buildTools(projectPath: string) {
  const projectArg = {
    type: 'string',
    description:
      'Absolute path to the indexed project (defaults to the running server’s project root). ' +
      'Use it to query a different project in the same session.',
    default: projectPath,
  } as const;

  return [
    { name: 'index_project', description: 'Index all documents in the project', inputSchema: { type: 'object', properties: { projectPath: projectArg } } },
    {
      name: 'index_file',
      description: 'Index a specific file',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to the file' }, projectPath: projectArg }, required: ['path'] },
    },
    {
      name: 'search',
      description: 'Search documents using hybrid full-text + vector search',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results', default: 20 },
          extension: { type: 'string', description: 'Filter by extension' },
          language: { type: 'string', description: 'Filter by language' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
          fuzzy: { type: 'boolean', description: 'Use fuzzy matching' },
          projectPath: projectArg,
        },
        required: ['query'],
      },
    },
    {
      name: 'explore',
      description: 'Explore a topic with surrounding context',
      inputSchema: { type: 'object', properties: { topic: { type: 'string' }, limit: { type: 'number', default: 10 }, projectPath: projectArg }, required: ['topic'] },
    },
    {
      name: 'get_document',
      description: 'Get a document by ID or path',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, path: { type: 'string' }, projectPath: projectArg } },
    },
    {
      name: 'get_related',
      description: 'Get related documents',
      inputSchema: { type: 'object', properties: { documentId: { type: 'string' }, limit: { type: 'number', default: 10 }, projectPath: projectArg }, required: ['documentId'] },
    },
    { name: 'get_stats', description: 'Get index statistics', inputSchema: { type: 'object', properties: { projectPath: projectArg } } },
    {
      name: 'list_documents',
      description: 'List all indexed documents',
      inputSchema: { type: 'object', properties: { extension: { type: 'string' }, language: { type: 'string' }, limit: { type: 'number', default: 100 }, projectPath: projectArg } },
    },
    {
      name: 'get_document_graph',
      description: 'Get a document node/edge connections',
      inputSchema: { type: 'object', properties: { documentId: { type: 'string' }, projectPath: projectArg }, required: ['documentId'] },
    },
    {
      name: 'list_projects',
      description: 'List projects with an active .docgraph index in this MCP server.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

async function handleRequest(request: any): Promise<void> {
  const { id, method, params } = request;
  const start = Date.now();

  try {
    switch (method) {
      case 'initialize':
        serverLogger.info('mcp.initialize', { client: params?.clientInfo, readOnly: SERVER_READ_ONLY });
        sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'docgraph', version: getPackageVersion(), readOnly: SERVER_READ_ONLY },
        });
        break;

      case 'tools/list':
        sendResponse(id, { tools: buildTools(DEFAULT_PROJECT_PATH) });
        break;

      case 'tools/call':
        serverLogger.info('mcp.tool_call', { name: params?.name, projectPath: params?.arguments?.projectPath });
        await handleToolCall(id, params?.name, params?.arguments ?? {});
        break;

      case 'resources/list':
        sendResponse(id, {
          resources: [
            {
              uri: `docgraph://project/${encodeURIComponent(DEFAULT_PROJECT_PATH)}`,
              name: 'Project Documentation',
              description: 'All indexed project documents',
              type: 'index',
            },
          ],
        });
        break;

      case 'resources/read': {
        const uri = params?.uri || '';
        const docId = decodeURIComponent(uri.replace('docgraph://document/', ''));
        const doc = services().query.getDocument(docId);
        sendResponse(id, { contents: doc ? [{ uri, mimeType: 'text/plain', text: doc.content }] : [] });
        break;
      }

      default:
        sendError(id, -32601, `Unknown method: ${method}`);
    }
    serverLogger.debug('mcp.request', { method, latencyMs: Date.now() - start });
  } catch (err) {
    serverLogger.logError(err, { component: 'mcp', method });
    sendError(id, -32603, `Internal error: ${err}`);
  }
}

async function handleToolCall(id: string | number, name: string, args: any): Promise<void> {
  const rawPath = args?.projectPath;
  // Validate an explicit projectPath before touching disk, so a hallucinated or
  // typo'd path can't silently create a stray `.docgraph/` directory.
  if (rawPath !== undefined) {
    if (typeof rawPath !== 'string' || !existsSync(rawPath) || !statSync(rawPath).isDirectory()) {
      sendError(id, -32602, `Invalid projectPath (not an existing directory): ${String(rawPath)}`);
      return;
    }
  }

  const projectKey = rawPath || DEFAULT_PROJECT_PATH;
  // Pin the project so a concurrent eviction / shutdown can't close its DB
  // handle while this tool call is mid-flight.
  registry.acquire(projectKey);
  const app = services(projectKey);

  try {
    switch (name) {
      case 'index_project': {
        if (app.readonly) {
          sendError(id, -32603, 'read-only mode: indexing is disabled');
          break;
        }
        const result = await app.indexing.indexProject();
        sendToolResult(id, { success: true, projectPath: app.projectPath, ...result, stats: app.query.getStats() });
        break;
      }
      case 'index_file': {
        if (app.readonly) {
          sendError(id, -32603, 'read-only mode: indexing is disabled');
          break;
        }
        const result = await app.indexing.indexFile(args.path);
        sendToolResult(id, { success: !!result, projectPath: app.projectPath, ...result });
        break;
      }
      case 'search': {
        const results = await app.search.search({
          query: args.query,
          limit: args.limit || 20,
          extension: args.extension,
          language: args.language,
          tags: args.tags,
          fuzzyMatch: args.fuzzy || false,
        });
        sendToolResult(id, { projectPath: app.projectPath, results });
        break;
      }
      case 'explore': {
        const results = await app.search.explore(args.topic, args.limit || 10);
        sendToolResult(id, { projectPath: app.projectPath, topic: args.topic, results });
        break;
      }
      case 'get_document': {
        const doc = args.id
          ? app.query.getDocument(args.id)
          : args.path
            ? app.query.getDocumentByPath(args.path)
            : null;
        sendToolResult(id, { projectPath: app.projectPath, document: doc });
        break;
      }
      case 'get_related': {
        const results = await app.search.getRelated(args.documentId, args.limit || 10);
        sendToolResult(id, { projectPath: app.projectPath, results });
        break;
      }
      case 'get_stats': {
        sendToolResult(id, { projectPath: app.projectPath, stats: app.query.getStats() });
        break;
      }
      case 'list_documents': {
        const docs = app.query.listDocuments({
          extension: args.extension,
          language: args.language,
          limit: args.limit || 100,
        });
        sendToolResult(id, {
          projectPath: app.projectPath,
          documents: docs.map((d) => ({
            id: d.id,
            path: d.relativePath,
            title: d.title,
            extension: d.extension,
            language: d.language,
            tags: d.tags,
            lineCount: d.lineCount,
            indexedAt: d.indexedAt,
          })),
          total: app.query.getStats().totalDocuments,
        });
        break;
      }
      case 'get_document_graph': {
        sendToolResult(id, { projectPath: app.projectPath, graph: app.query.getDocumentGraph(args.documentId) });
        break;
      }
      case 'list_projects': {
        const projects = Array.from((registry as any).cache?.keys() ?? []);
        sendToolResult(id, { projects, defaultProject: DEFAULT_PROJECT_PATH, readOnly: SERVER_READ_ONLY });
        break;
      }
      default:
        sendError(id, -32601, `Unknown tool: ${name}`);
    }
  } catch (err) {
    app.logger.logError(err, { component: 'mcp.tool', tool: name, projectPath: app.projectPath });
    sendError(id, -32603, `Tool failed: ${(err as Error).message}`);
  } finally {
    registry.release(projectKey);
  }
}

// In-flight tool calls, tracked so we can drain them before closing the
// registry (which would otherwise close SQLite handles out from under a
// running request).
const inflight = new Set<Promise<void>>();
function track(p: Promise<void>): void {
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

let stopAutosync: (() => Promise<void>) | null = null;

/** Start the autosync file watcher for the default project, unless disabled. */
async function startAutosync(): Promise<void> {
  const disabled = process.argv.includes('--no-watch') || process.env.DOCGRAPH_NO_WATCH === '1';
  if (disabled) return;
  const app = services();
  // Read-only mode never writes — including autosync reindexing — whether
  // it's forced server-wide (`--read-only` / `DOCGRAPH_READ_ONLY`) or set in
  // this project's own `.docgraph/settings.json` (`app.readonly` already
  // reflects both, via `Container`'s precedence resolution).
  if (app.readonly) {
    serverLogger.info('autosync.disabled_read_only', { projectPath: app.projectPath });
    return;
  }
  if (!app.settings.watch.enabled) return;

  const { ProjectWatcher } = await import('../../infrastructure/watch/file-watcher.js');
  const watcher = new ProjectWatcher(
    DEFAULT_PROJECT_PATH,
    {
      onChange: async (paths) => {
        registry.acquire(DEFAULT_PROJECT_PATH);
        try {
          const n = await app.syncChanged(paths);
          if (n > 0) serverLogger.info('autosync.reindexed', { count: n });
        } finally {
          registry.release(DEFAULT_PROJECT_PATH);
        }
      },
      onRemove: async (paths) => {
        registry.acquire(DEFAULT_PROJECT_PATH);
        try {
          await app.removePaths(paths);
        } finally {
          registry.release(DEFAULT_PROJECT_PATH);
        }
      },
    },
    { debounceMs: app.settings.watch.debounceMs, logger: serverLogger },
  );
  watcher.start();
  stopAutosync = () => watcher.stop();
}

function main(): void {
  serverLogger.info('mcp.server.started', { projectPath: DEFAULT_PROJECT_PATH, maxProjects: REGISTRY_MAX });
  void startAutosync();
  let buffer = '';

  process.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          track(handleRequest(JSON.parse(line)));
        } catch (err) {
          serverLogger.warn('mcp.invalid_json', { error: (err as Error).message });
        }
      }
    }
  });

  process.stdin.on('end', () => {
    void (async () => {
      const line = buffer.trim();
      if (line) {
        try {
          track(handleRequest(JSON.parse(line)));
        } catch (err) {
          serverLogger.warn('mcp.invalid_json', { error: (err as Error).message });
        }
      }
      // Drain in-flight tool calls before tearing down DB handles.
      await Promise.allSettled([...inflight]);
      if (stopAutosync) await stopAutosync();
      registry.close();
      void serverLogger.flush();
    })();
  });

  process.on('uncaughtException', (err) => {
    serverLogger.logError(err, { component: 'mcp', phase: 'uncaughtException' });
  });
  process.on('unhandledRejection', (reason) => {
    serverLogger.logError(reason, { component: 'mcp', phase: 'unhandledRejection' });
  });
}

main();
