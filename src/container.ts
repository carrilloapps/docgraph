import { join } from 'path';
import { loadSettings, DocGraphSettings } from './infrastructure/config/settings.js';
import { SqliteKnowledgeStore } from './infrastructure/persistence/sqlite-knowledge-store.js';
import { SqliteVectorStore } from './infrastructure/persistence/sqlite-vector-store.js';
import { MultiFormatDocumentParser } from './infrastructure/filesystem/document-parser.js';
import { FileSystemDocumentSource } from './infrastructure/filesystem/file-system-document-source.js';
import { EmbeddingProviderFactory } from './infrastructure/embeddings/provider-factory.js';
import { SourceRegistry } from './infrastructure/sources/registry.js';
import { LocalLogger } from './infrastructure/logging/local-logger.js';
import { IndexingService } from './application/indexing-service.js';
import { SearchService } from './application/search-service.js';
import { QueryService } from './application/query-service.js';
import { EmbeddingProvider, VectorStore, DocumentSource, DocumentParser } from './domain/ports.js';

export interface ContainerOptions {
  /** Disable embedding generation and vector search entirely. */
  disableEmbeddings?: boolean;
  /** Progress callback used by the indexing service. */
  onProgress?: (current: number, total: number, file: string) => void;
  /** Disable remote-source pull (defaults to enabling when configured). */
  disableRemoteSources?: boolean;
  /** Inject a pre-built logger (used by the MCP server to share one logger per project). */
  logger?: LocalLogger;
  /**
   * Force read-only mode: no indexing, no embedding writes, no autosync, no
   * settings mutation — only reads (search, explore, get_*, list, stats, logs).
   * When omitted, falls back to `settings.security.readOnly` (precedence:
   * explicit option here > project settings, default `false`).
   */
  readOnly?: boolean;
}

/**
 * Composition root. Instantiates every infrastructure adapter and wires the
 * application services together for a given project. This is the only place
 * that knows about concrete implementations.
 */
export class Container {
  readonly settings: DocGraphSettings;
  readonly projectPath: string;
  readonly dbPath: string;
  readonly logger: LocalLogger;
  private readonly _readOnly: boolean;

  readonly repository: SqliteKnowledgeStore;
  readonly vectorStore: VectorStore | null;
  readonly embeddingProvider: EmbeddingProvider | null;
  readonly source: DocumentSource;
  readonly parser: DocumentParser;
  readonly sourceRegistry: SourceRegistry | null;

  readonly indexing: IndexingService;
  readonly search: SearchService;
  readonly query: QueryService;

  constructor(projectPath: string, options: ContainerOptions = {}) {
    this.projectPath = projectPath;
    this.settings = loadSettings(projectPath);
    this.dbPath = join(projectPath, '.docgraph', 'docgraph.db');
    this.logger = options.logger ?? new LocalLogger({ projectPath, level: this.settings.logging.level });

    // Precedence: explicit `options.readOnly` (threaded from --read-only /
    // DOCGRAPH_READ_ONLY by the CLI/MCP layers) beats the project's own
    // `settings.security.readOnly` (default false).
    this._readOnly = options.readOnly ?? this.settings.security.readOnly;

    this.repository = new SqliteKnowledgeStore(this.dbPath, { readonly: this._readOnly });

    let vectorStore: VectorStore | null = null;
    let embeddingProvider: EmbeddingProvider | null = null;
    if (!options.disableEmbeddings) {
      try {
        vectorStore = new SqliteVectorStore(this.dbPath, { readonly: this._readOnly });
        embeddingProvider = EmbeddingProviderFactory.create(this.settings.embedding);
        this.logger.info('embeddings.enabled', {
          provider: this.settings.embedding.provider,
          resolvedProvider: EmbeddingProviderFactory.resolve(this.settings.embedding),
        });
      } catch (err) {
        this.logger.warn('embeddings.disabled', { error: (err as Error).message });
        vectorStore = null;
        embeddingProvider = null;
      }
    }
    this.vectorStore = vectorStore;
    this.embeddingProvider = embeddingProvider;

    this.parser = new MultiFormatDocumentParser(projectPath);
    this.source = new FileSystemDocumentSource(projectPath, this.settings);

    // Build the registry whenever sources are configured OR explicitly enabled —
    // even if every source is disabled, the registry's `list()` provides
    // accurate enable / configure status for `docgraph sources list`.
    this.sourceRegistry =
      options.disableRemoteSources
        ? null
        : new SourceRegistry(this.settings.sources.sources, projectPath, this.logger.child({ component: 'sources' }));

    this.indexing = new IndexingService({
      repository: this.repository,
      source: this.source,
      parser: this.parser,
      chunkOptions: {
        chunkSize: this.settings.indexing.chunkSize,
        chunkOverlap: this.settings.indexing.chunkOverlap,
      },
      generateOnIndex: this.settings.indexing.generateOnIndex,
      embeddingProvider: this.embeddingProvider,
      vectorStore: this.vectorStore,
      onProgress: options.onProgress,
      sourceRegistry: this.sourceRegistry,
      dynamicApis: this.settings.sources.apis,
      dynamicMcp: this.settings.sources.mcp,
      // Remote-pull knobs (wired from settings.sources.*).
      pullOnIndex: this.settings.sources.pullOnIndex,
      pullOnReindex: this.settings.sources.pullOnReindex,
      maxPagesPerSource: this.settings.sources.maxPagesPerSource,
      maxConcurrentSources: this.settings.sources.maxConcurrentSources,
      logger: this.logger.child({ component: 'indexing' }),
    });

    this.search = new SearchService({
      repository: this.repository,
      vectorStore: this.vectorStore,
      embeddingProvider: this.embeddingProvider,
      config: {
        vectorWeight: this.settings.search.vectorWeight,
        textWeight: this.settings.search.textWeight,
        minScore: this.settings.search.minScore,
        limit: this.settings.search.limit,
      },
      logger: this.logger.child({ component: 'search' }),
    });

    this.query = new QueryService(this.repository, this.logger.child({ component: 'query' }));
  }

  /** The concrete embedding provider `auto` resolves to (for display). */
  get resolvedProvider(): string {
    return EmbeddingProviderFactory.resolve(this.settings.embedding);
  }

  /**
   * Effective read-only flag for this container instance: `options.readOnly`
   * if explicitly passed to the constructor, otherwise this project's
   * `settings.security.readOnly` (default `false`). When `true`, every
   * mutating store method throws and callers (CLI/MCP) must not start
   * autosync or dispatch write commands/tools.
   */
  get readonly(): boolean {
    return this._readOnly;
  }

  /**
   * Incrementally (re)index a set of changed file paths — used by the file
   * watcher (autosync). Unsupported/unchanged files are skipped by the
   * indexer. Returns the number of documents actually (re)indexed.
   *
   * Callers must not invoke this in read-only mode (autosync is disabled by
   * the CLI/MCP layers when read-only); guarded here too so an accidental
   * call fails loudly instead of silently swallowing a write error.
   */
  async syncChanged(paths: string[]): Promise<number> {
    if (this._readOnly) {
      this.logger.warn('watch.sync_skipped_read_only', { count: paths.length });
      return 0;
    }
    let count = 0;
    for (const path of paths) {
      try {
        const result = await this.indexing.indexFile(path);
        if (result) count++;
      } catch (err) {
        this.logger.logError(err, { component: 'watch', phase: 'indexFile', path });
      }
    }
    return count;
  }

  /**
   * Drop documents (and their vectors) for files that were deleted on disk —
   * used by the file watcher (autosync). Returns the number removed.
   *
   * Guarded the same way as {@link syncChanged} for read-only mode.
   */
  async removePaths(paths: string[]): Promise<number> {
    if (this._readOnly) {
      this.logger.warn('watch.remove_skipped_read_only', { count: paths.length });
      return 0;
    }
    let count = 0;
    for (const path of paths) {
      const doc = this.repository.getDocumentByPath(path);
      if (doc) {
        await this.vectorStore?.delete(doc.id);
        this.repository.deleteDocument(doc.id);
        count++;
      }
    }
    return count;
  }

  close(): void {
    this.repository.close();
    this.vectorStore?.close();
    void this.logger.flush();
  }
}
