/**
 * DocumentSource port implementation surface.
 *
 * Concrete sources (filesystem, Notion, Obsidian, Jira, Confluence, Linear,
 * GitHub, etc.) implement {@link RemoteSource} and {@link RemoteDocument} so
 * the indexing pipeline can absorb remote content as if it were local.
 *
 * The {@link SourceRegistry} discovers every registered adapter and lets the
 * indexing service fetch documents by a `source:<name>:<id>` URI.
 */

export interface RemoteDocument {
  /** Stable identifier (e.g. Notion page id, Jira issue key, Obsidian path). */
  id: string;
  /** Absolute or virtual path used by the indexing pipeline. */
  path: string;
  /** Short title. */
  title?: string;
  /** Raw text content. Markdown preferred, plain text otherwise. */
  content: string;
  /** Front-matter metadata (front matter from Notion properties, Jira fields, etc.). */
  metadata?: Record<string, unknown>;
  /** ISO 8601 timestamp of last edit (best-effort). */
  lastModified?: string;
  /** Source-specific extension (e.g. .md, .mdx, .adoc). */
  extension?: string;
  /** Optional tags (labels in Jira, topics in Notion, etc.). */
  tags?: string[];
}

export interface RemoteSource {
  /** Unique name (e.g. `notion`, `obsidian`, `jira`). */
  readonly name: string;
  /** Human-readable description shown in `docgraph sources list`. */
  readonly description: string;
  /** List all documents the source has access to (paginated internally). */
  list(): Promise<RemoteDocument[]>;
  /** Fetch a single document by its id. */
  get(id: string): Promise<RemoteDocument | null>;
  /** Optional: only fetch documents updated after this timestamp. */
  listSince?(since: Date): Promise<RemoteDocument[]>;
  /**
   * Optional: cap the number of pages (or paginated batches) a subsequent
   * `list()`/`listSince()` call will traverse. Implemented by paginated
   * sources (HTTP page-based, cursor-based, MCP connectors); sources that
   * always return a single batch (Obsidian, Postman, OpenAPI) can ignore it.
   * Wired by {@link IndexingService} from `settings.sources.maxPagesPerSource`.
   */
  configureMaxPages?(maxPages: number): void;
}

export interface SourceConfig {
  /** Whether this source is enabled. */
  enabled: boolean;
  /** Source-specific configuration. */
  options: Record<string, unknown>;
}

export interface SourceProvider {
  name: string;
  description: string;
  configSchema: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean; secret?: boolean }>;
  create(config: Record<string, unknown>, projectPath: string): RemoteSource;
}
