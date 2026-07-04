import { RemoteDocument, RemoteSource, SourceProvider, SourceConfig } from './types.js';
import { ObsidianProvider } from './obsidian.js';
import { NotionProvider } from './notion.js';
import { JiraProvider } from './jira.js';
import { ConfluenceProvider } from './confluence.js';
import { ConfluenceDcProvider } from './confluence-dc.js';
import { LinearProvider } from './linear.js';
import { GitHubProvider } from './github.js';
import { PostmanProvider, OpenApiProvider } from './api-specs.js';
import { McpConnectorSource } from './mcp-connector.js';
import { mapWithConcurrency } from './http-remote-source.js';
import { ApiSourceItem, McpSourceItem } from '../config/settings.js';
import { LocalLogger, noopLogger } from '../logging/local-logger.js';

/**
 * Catalogue of every {@link SourceProvider} the build ships with. Adding a
 * new remote source = append one provider to this list (no other file needs
 * to change), and add it to the matching config schema in settings.ts.
 */
export const SOURCE_PROVIDERS: SourceProvider[] = [
  ObsidianProvider,
  NotionProvider,
  JiraProvider,
  ConfluenceProvider,
  ConfluenceDcProvider,
  LinearProvider,
  GitHubProvider,
  PostmanProvider,
  OpenApiProvider,
];

/**
 * Catalog of source-id → provider for the dynamic / list-based config
 * blocks (`sources.apis[]` and `sources.mcp[]`). Each entry maps an
 * internally-stable slug to the factory used to instantiate the adapter.
 */
const PROVIDER_BY_TYPE: Record<string, SourceProvider> = {
  openapi: OpenApiProvider,
  swagger: OpenApiProvider,
  scalar: OpenApiProvider,
  postman: PostmanProvider,
};

/**
 * Resolves and instantiates remote sources from configuration. Sources are
 * lazy: nothing is created until the first `getSources()` call, so a project
 * that disables every remote source never touches the network.
 *
 * Supports three flavours of configured source:
 *   - `sources.sources[name]` — classic single-instance adapter (Notion, Jira, ...).
 *   - `sources.apis[]` — a list of API specs (`openapi` / `postman` / ...). Built for
 *     projects that integrate with dozens or hundreds of external APIs.
 *   - `sources.mcp[]` — a list of MCP connector entries. Each spawns an MCP server
 *     over JSON-RPC and ingests whatever read-only tools it exposes.
 */
export class SourceRegistry {
  private readonly providers: Map<string, SourceProvider>;
  private readonly instances = new Map<string, RemoteSource>();
  private readonly logger: LocalLogger;

  constructor(
    private readonly configs: Record<string, SourceConfig>,
    private readonly projectPath: string,
    logger?: LocalLogger,
  ) {
    this.providers = new Map(SOURCE_PROVIDERS.map((p) => [p.name, p]));
    this.logger = logger ?? noopLogger;
  }

  list(): { name: string; description: string; enabled: boolean; configured: boolean }[] {
    const classics = SOURCE_PROVIDERS.map((p) => {
      const cfg = this.configs[p.name];
      return {
        name: p.name,
        description: p.description,
        enabled: Boolean(cfg?.enabled),
        configured: Boolean(cfg),
      };
    });
    return classics;
  }

  /**
   * List every configured remote source, including dynamic API entries
   * and MCP connectors. Returned shape is the same as {@link list} but
   * names are namespaced (`api:<slug>`, `mcp:<name>`) so the caller can
   * tell which flavour they came from.
   */
  listAll(opts: { apis: ApiSourceItem[]; mcp: McpSourceItem[] }): Array<{
    name: string;
    description: string;
    enabled: boolean;
    kind: 'classic' | 'api' | 'mcp';
  }> {
    const result: Array<{ name: string; description: string; enabled: boolean; kind: 'classic' | 'api' | 'mcp' }> = [];
    for (const entry of this.list()) {
      result.push({ ...entry, kind: 'classic' });
    }
    for (const api of opts.apis) {
      const provider = PROVIDER_BY_TYPE[api.type];
      result.push({
        name: `api:${api.name}`,
        description: provider?.description ?? api.title ?? `${api.type} spec`,
        enabled: api.enabled,
        kind: 'api',
      });
    }
    for (const mcp of opts.mcp) {
      result.push({
        name: `mcp:${mcp.name}`,
        description: mcp.description ?? `MCP connector: ${mcp.command.join(' ')}`,
        enabled: mcp.enabled,
        kind: 'mcp',
      });
    }
    return result;
  }

  /**
   * Mark an API list entry as disabled without losing its config.
   * The new state is persisted by the caller (CLI reads/writes the
   * settings.json file directly so callers stay in charge of I/O).
   */
  static disable(name: string, opts: { apis: ApiSourceItem[]; mcp: McpSourceItem[] }): boolean {
    const apiIdx = opts.apis.findIndex((a) => a.name === name);
    if (apiIdx >= 0) {
      opts.apis[apiIdx].enabled = false;
      return true;
    }
    const mcpIdx = opts.mcp.findIndex((a) => a.name === name);
    if (mcpIdx >= 0) {
      opts.mcp[mcpIdx].enabled = false;
      return true;
    }
    return false;
  }

  get(name: string): RemoteSource | null {
    if (this.instances.has(name)) return this.instances.get(name)!;
    const provider = this.providers.get(name);
    if (!provider) return null;
    const cfg = this.configs[name];
    if (!cfg?.enabled) return null;
    try {
      const instance = provider.create(cfg.options || {}, this.projectPath);
      this.instances.set(name, instance);
      this.logger.info('source.initialised', { source: name });
      return instance;
    } catch (err) {
      this.logger.logError(err, { component: 'sources', source: name, phase: 'init' });
      return null;
    }
  }

  /**
   * Lazy fetch for every enabled classic source. Returns name → documents.
   *
   * @param opts.maxPages Forwarded to each source's `configureMaxPages()`
   *   (from `settings.sources.maxPagesPerSource`) so no single source can
   *   traverse an unbounded number of pages.
   * @param opts.concurrency Max number of sources pulled at once (from
   *   `settings.sources.maxConcurrentSources`, default 4) instead of pulling
   *   every source fully sequentially.
   */
  async fetchAll(opts: { maxPages?: number; concurrency?: number } = {}): Promise<Record<string, Awaited<ReturnType<RemoteSource['list']>>>> {
    const out: Record<string, Awaited<ReturnType<RemoteSource['list']>>> = {};
    const enabled = this.list().filter((entry) => this.configs[entry.name]?.enabled);

    await mapWithConcurrency(enabled, opts.concurrency ?? 4, async ({ name }) => {
      const source = this.get(name);
      if (!source) return;
      if (opts.maxPages && typeof source.configureMaxPages === 'function') {
        source.configureMaxPages(opts.maxPages);
      }
      try {
        out[name] = await source.list();
      } catch (err) {
        this.logger.logError(err, { component: 'sources', source: name, phase: 'list' });
        out[name] = [];
      }
    });

    return out;
  }

  /**
   * Build an instance for a dynamic API entry (Postman / OpenAPI / etc.).
   * One MCP connector can also be built here so the same try / catch path
   * covers all dynamic pulls.
   *
   * The {@link ApiSourceItem} is flattened into the provider's expected
   * `options` object so the same `create(options, projectPath)` signature
   * works for both static and dynamic sources.
   */
  buildForConfig(opts: { apis?: ApiSourceItem[]; mcp?: McpSourceItem[] }): RemoteSource[] {
    const result: RemoteSource[] = [];
    for (const api of opts.apis ?? []) {
      if (!api.enabled) continue;
      const provider = PROVIDER_BY_TYPE[api.type];
      if (!provider) {
        this.logger.warn('sources.unknown_api_type', { name: api.name, type: api.type });
        continue;
      }
      const providerOptions = {
        type: api.type,
        ...(api.url ? { url: api.url } : {}),
        ...(api.path ? { path: api.path } : {}),
        ...(api.auth ? { auth: api.auth } : {}),
        ...(api.title ? { title: api.title } : {}),
      };
      try {
        const source = provider.create(providerOptions, this.projectPath);
        // Override name so log lines and doc ids are stable across restarts.
        Object.defineProperty(source, 'name', { value: api.name, writable: false, configurable: false });
        result.push(source);
      } catch (err) {
        this.logger.logError(err, { component: 'sources', phase: 'api-init', name: api.name });
      }
    }
    for (const mcp of opts.mcp ?? []) {
      if (!mcp.enabled) continue;
      try {
        result.push(
          new McpConnectorSource(
            {
              name: mcp.name,
              description: mcp.description,
              command: mcp.command,
              env: mcp.env,
              strategy: mcp.strategy,
            },
            this.logger.child({ component: 'sources', name: `mcp:${mcp.name}` }),
          ),
        );
      } catch (err) {
        this.logger.logError(err, { component: 'sources', phase: 'mcp-init', name: mcp.name });
      }
    }
    return result;
  }

  static describeProvider(name: string): { description: string; configSchema: SourceProvider['configSchema'] } | null {
    const provider = SOURCE_PROVIDERS.find((p) => p.name === name);
    if (!provider) return null;
    return { description: provider.description, configSchema: provider.configSchema };
  }
}
