import { createHash } from 'crypto';
import { basename } from 'path';
import { Document, GraphNode, GraphEdge } from '../domain/entities.js';
import {
  KnowledgeRepository,
  DocumentSource,
  DocumentParser,
  EmbeddingProvider,
  VectorStore,
} from '../domain/ports.js';
import { chunkText, ChunkOptions } from '../domain/chunker.js';
import { SourceRegistry } from '../infrastructure/sources/registry.js';
import { mapWithConcurrency } from '../infrastructure/sources/http-remote-source.js';
import { McpConnectorSource } from '../infrastructure/sources/mcp-connector.js';
import { ApiSourceItem, McpSourceItem } from '../infrastructure/config/settings.js';
import { RemoteDocument, RemoteSource } from '../infrastructure/sources/types.js';
import { LocalLogger, noopLogger } from '../infrastructure/logging/local-logger.js';

/** Default cap on pages traversed per remote source when `maxPagesPerSource` isn't configured. */
const DEFAULT_MAX_PAGES_PER_SOURCE = 50;
/** Default number of remote sources pulled concurrently when `maxConcurrentSources` isn't configured. */
const DEFAULT_MAX_CONCURRENT_SOURCES = 4;

export interface IndexResult {
  documents: number;
  nodes: number;
  edges: number;
  vectors: number;
  skipped: number;
  remoteSources?: Record<string, number>;
}

export interface FileIndexResult {
  nodes: number;
  edges: number;
  vectors: number;
}

export interface IndexingServiceDeps {
  repository: KnowledgeRepository;
  source: DocumentSource;
  parser: DocumentParser;
  chunkOptions: ChunkOptions;
  generateOnIndex: boolean;
  embeddingProvider?: EmbeddingProvider | null;
  vectorStore?: VectorStore | null;
  onProgress?: (current: number, total: number, file: string) => void;
  /** Optional SourceRegistry: when present, remote documents are pulled and indexed alongside filesystem. */
  sourceRegistry?: SourceRegistry | null;
  /** Dynamic API list from `settings.sources.apis[]`. */
  dynamicApis?: ApiSourceItem[];
  /** Dynamic MCP connector list from `settings.sources.mcp[]`. */
  dynamicMcp?: McpSourceItem[];
  logger?: LocalLogger;
  /**
   * Mirrors `settings.sources.pullOnIndex`: whether a plain `indexProject()`
   * call (i.e. `indexProject()` / `indexProject({ isReindex: false })`)
   * should pull remote sources at all. Defaults to `true` (current
   * behaviour) so existing callers that don't pass this dep are unaffected.
   */
  pullOnIndex?: boolean;
  /**
   * Mirrors `settings.sources.pullOnReindex`: whether `indexProject({ isReindex: true })`
   * should pull remote sources. Defaults to `true`.
   */
  pullOnReindex?: boolean;
  /**
   * Mirrors `settings.sources.maxPagesPerSource`: upper bound on the number
   * of pages (or paginated batches) any single remote source will traverse
   * per pull, forwarded to each source via `configureMaxPages()`. Defaults
   * to {@link DEFAULT_MAX_PAGES_PER_SOURCE}.
   */
  maxPagesPerSource?: number;
  /**
   * Mirrors `settings.sources.maxConcurrentSources`: how many remote sources
   * are pulled in parallel instead of one at a time. Defaults to
   * {@link DEFAULT_MAX_CONCURRENT_SOURCES}.
   */
  maxConcurrentSources?: number;
}

/**
 * Adapter that presents a {@link RemoteSource} as a `DocumentSource`. Each
 * remote document is marshalled into the same {@link SourceFile} shape the
 * rest of the indexing pipeline consumes, so the knowledge graph and the
 * vector store index remote + local content with one code path.
 */
function remoteToSourceFile(doc: RemoteDocument, sourceName: string): {
  path: string;
  relativePath: string;
  rawContent: string;
  extension: string;
  language: string;
} | null {
  if (!doc?.id || !doc?.path || typeof doc.content !== 'string') return null;
  const extension = doc.extension || guessExtension(doc.path);
  return {
    path: `${sourceName}:${doc.path}`,
    relativePath: `[${sourceName}] ${doc.path.replace(/^\w+:\/\//, '')}`,
    rawContent: doc.content,
    extension,
    language: languageFromExtension(extension),
  };
}

function guessExtension(path: string): string {
  const m = path.match(/\.[a-zA-Z0-9]+$/);
  return m ? m[0] : '.md';
}

function languageFromExtension(ext: string): string {
  const map: Record<string, string> = {
    '.md': 'markdown',
    '.mdx': 'markdown',
    '.markdown': 'markdown',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.txt': 'text',
    '.adoc': 'asciidoc',
  };
  return map[ext] ?? 'text';
}

/**
 * Application use case that indexes documents: discovery and reading are
 * delegated to a {@link DocumentSource}, parsing to a {@link DocumentParser},
 * persistence to a {@link KnowledgeRepository}, and (optionally) embeddings to
 * an {@link EmbeddingProvider} + {@link VectorStore}. When a {@link SourceRegistry}
 * is injected, remote sources (Notion, Jira, Obsidian...) are pulled and
 * indexed in the same pass.
 */
export class IndexingService {
  private readonly logger: LocalLogger;

  constructor(private readonly deps: IndexingServiceDeps) {
    this.logger = this.deps.logger ?? noopLogger;
  }

  /**
   * @param options.isReindex Set by callers doing a clear-and-rebuild pass
   *   (`docgraph reindex`) so this method reads `pullOnReindex` instead of
   *   `pullOnIndex` to decide whether remote sources are pulled. Optional —
   *   defaults to `false` (plain index) so existing call sites (`indexProject()`
   *   with no arguments) keep working unchanged.
   */
  async indexProject(options: { isReindex?: boolean } = {}): Promise<IndexResult> {
    const files = this.deps.source.list();
    const total = files.length;
    let documents = 0;
    let nodes = 0;
    let edges = 0;
    let vectors = 0;
    let skipped = 0;

    this.logger.info('indexing.start', { files: total, scope: 'filesystem' });

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      this.deps.onProgress?.(i + 1, total, file);

      try {
        const result = await this.indexFile(file);
        if (result === null) {
          skipped++;
        } else {
          documents++;
          nodes += result.nodes;
          edges += result.edges;
          vectors += result.vectors;
        }
      } catch (err) {
        this.logger.logError(err, { component: 'indexing', file });
        skipped++;
      }
    }

    // `sources.pullOnIndex` / `sources.pullOnReindex` let a project opt out
    // of touching the network on a given pass (e.g. CI runs that only want
    // the filesystem indexed). Default to `true` so behaviour is unchanged
    // for callers that don't wire these deps yet.
    const pullEnabled = options.isReindex ? (this.deps.pullOnReindex ?? true) : (this.deps.pullOnIndex ?? true);
    const remoteSources = this.deps.sourceRegistry && pullEnabled ? await this.pullRemoteSources() : undefined;

    this.logger.info('indexing.complete', {
      documents,
      nodes,
      edges,
      vectors,
      skipped,
      remoteSources,
    });

    return { documents, nodes, edges, vectors, skipped, remoteSources };
  }

  /**
   * Pull documents from every enabled remote source and index them through
   * the same pipeline as local files. Each remote document becomes a virtual
   * file in the knowledge graph; the relative path is prefixed with the
   * source name (e.g. `[notion] page-id-abc123`) so it's distinguishable in
   * results.
   *
   * The pull walks three flavours of configured source:
   *   - classic single-instance sources (Notion, Jira, ...) via SourceRegistry
   *   - the dynamic `apis[]` list (OpenAPI / Postman / Scalar specs)
   *   - the dynamic `mcp[]` list (external MCP servers over JSON-RPC)
   *
   * All three are bounded in size via `maxPagesPerSource` (forwarded to each
   * source's `configureMaxPages()`) and pulled with at most
   * `maxConcurrentSources` sources in flight at once — so a project that
   * integrates with hundreds of APIs stays manageable and doesn't hammer
   * every provider at the same time.
   */
  async pullRemoteSources(): Promise<Record<string, number>> {
    const registry = this.deps.sourceRegistry;
    if (!registry) return {};

    const maxPagesPerSource = this.deps.maxPagesPerSource ?? DEFAULT_MAX_PAGES_PER_SOURCE;
    const maxConcurrentSources = this.deps.maxConcurrentSources ?? DEFAULT_MAX_CONCURRENT_SOURCES;

    const counts: Record<string, number> = {};
    this.logger.info('indexing.remote_pull', { sources: 'starting', maxPagesPerSource, maxConcurrentSources });

    // 1. Classic single-instance sources. The registry itself applies the
    //    page cap and concurrency bound (each source may implement
    //    `configureMaxPages`).
    const classic = await registry.fetchAll({ maxPages: maxPagesPerSource, concurrency: maxConcurrentSources });
    for (const [sourceName, docs] of Object.entries(classic)) {
      const partial = await this.ingestDocs(sourceName, docs);
      Object.assign(counts, partial);
    }

    // 2. + 3. Dynamic api/mcp entries from settings.json.
    //    We don't have direct access to the container here, so we expose
    //    a closure via the registry: it builds sources on demand for each
    //    list entry. Each invocation respects the `enabled` flag and the
    //    page budget from settings. Pulled with the same concurrency bound
    //    as classic sources (`maxConcurrentSources`) instead of one at a time.
    const dynamic = registry.buildForConfig({
      apis: this.deps.dynamicApis,
      mcp: this.deps.dynamicMcp,
    });
    await mapWithConcurrency(dynamic, maxConcurrentSources, async (source: RemoteSource) => {
      // `buildForConfig()` concatenates API-spec sources (OpenAPI/Postman)
      // and MCP-connector sources into one array with no other tag telling
      // them apart, so namespace by concrete type — matching the convention
      // `registry.listAll()` already uses (`api:<name>` vs `mcp:<name>`).
      // Every dynamic source used to get labelled `mcp:*`, which mislabelled
      // OpenAPI/Postman sources in `remoteSources` counts and downstream
      // document paths.
      const namespace = source instanceof McpConnectorSource ? `mcp:${source.name}` : `api:${source.name}`;
      try {
        if (typeof source.configureMaxPages === 'function') {
          source.configureMaxPages(maxPagesPerSource);
        }
        const docs = await source.list();
        const c = await this.ingestDocs(namespace, docs);
        for (const [id, count] of Object.entries(c)) counts[id] = count;
      } catch (err) {
        this.logger.logError(err, { component: 'indexing', source: namespace, phase: 'remote-list' });
      }
    });

    return counts;
  }

  private async ingestDocs(sourceName: string, docs: RemoteDocument[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = { [sourceName]: 0 };
    for (const doc of docs) {
      try {
        const result = await this.indexRemoteDocument(sourceName, doc);
        if (result) counts[sourceName]++;
      } catch (err) {
        this.logger.logError(err, { component: 'indexing', source: sourceName, remoteId: doc.id });
      }
    }
    this.logger.info('indexing.remote_source_complete', { source: sourceName, count: counts[sourceName] });
    return counts;
  }

  /**
   * Index a single remote document, returning the indexing result or null if
   * skipped. Mirrors {@link indexFile}'s unchanged-content short-circuit: a
   * remote pull re-fetches every document on every run (there's no
   * filesystem mtime to check cheaply beforehand), so without this hash
   * comparison every doc gets re-embedded on every pull regardless of
   * whether its content actually changed.
   */
  async indexRemoteDocument(sourceName: string, doc: RemoteDocument): Promise<FileIndexResult | null> {
    const marshalled = remoteToSourceFile(doc, sourceName);
    if (!marshalled) return null;

    const hash = this.computeHash(marshalled.rawContent);
    const existing = this.deps.repository.getDocumentByPath(marshalled.path);
    if (existing && existing.hash === hash) {
      return null;
    }
    if (existing) {
      this.deps.repository.deleteDocument(existing.id);
    }

    const parser = this.deps.parser;
    const parsed = parser.parse(marshalled.path, marshalled.rawContent, marshalled.extension, marshalled.language);
    const document: Document = {
      id: this.generateId(marshalled.path),
      path: marshalled.path,
      relativePath: marshalled.relativePath,
      content: parsed.content,
      rawContent: marshalled.rawContent,
      extension: marshalled.extension,
      language: parsed.language,
      title: doc.title || parsed.title,
      description: parsed.description,
      tags: Array.from(new Set([...(doc.tags || []), ...(parsed.tags || [])])),
      headings: parsed.headings,
      links: parsed.links,
      codeBlocks: parsed.codeBlocks,
      lineCount: marshalled.rawContent.split('\n').length,
      wordCount: marshalled.rawContent.split(/\s+/).filter((w) => w.length > 0).length,
      hash,
      indexedAt: Date.now(),
    };

    this.deps.repository.upsertDocument(document);
    const nodes = this.buildNodes(document);
    const edges = this.buildEdges(document, nodes);
    for (const node of nodes) this.deps.repository.upsertNode(node);
    for (const edge of edges) this.deps.repository.upsertEdge(edge);
    const vectors = await this.indexEmbeddings(document);
    return { nodes: nodes.length, edges: edges.length, vectors };
  }

  async indexFile(path: string): Promise<FileIndexResult | null> {
    const source = this.deps.source.read(path);
    if (!source) return null;

    const hash = this.computeHash(source.rawContent);
    const existing = this.deps.repository.getDocumentByPath(source.path);
    if (existing && existing.hash === hash) {
      return null;
    }
    if (existing) {
      this.deps.repository.deleteDocument(existing.id);
    }

    const parsed = this.deps.parser.parse(source.path, source.rawContent, source.extension, source.language);
    const document: Document = {
      id: this.generateId(source.path),
      path: source.path,
      relativePath: source.relativePath,
      content: parsed.content,
      rawContent: source.rawContent,
      extension: source.extension,
      language: parsed.language,
      title: parsed.title,
      description: parsed.description,
      tags: parsed.tags,
      headings: parsed.headings,
      links: parsed.links,
      codeBlocks: parsed.codeBlocks,
      lineCount: source.rawContent.split('\n').length,
      wordCount: source.rawContent.split(/\s+/).filter((w) => w.length > 0).length,
      hash,
      indexedAt: Date.now(),
    };

    this.deps.repository.upsertDocument(document);

    const nodes = this.buildNodes(document);
    const edges = this.buildEdges(document, nodes);
    for (const node of nodes) this.deps.repository.upsertNode(node);
    for (const edge of edges) this.deps.repository.upsertEdge(edge);

    const vectors = await this.indexEmbeddings(document);

    return { nodes: nodes.length, edges: edges.length, vectors };
  }

  private buildNodes(document: Document): GraphNode[] {
    return [
      { id: document.id, type: 'document', label: document.title || basename(document.path), path: document.path },
      ...document.headings.map((h, i) => ({
        id: `${document.id}#heading-${i}`,
        type: 'heading' as const,
        label: h.text,
        path: document.path,
        metadata: { level: h.level, anchor: h.anchor },
      })),
      ...document.tags.map((tag) => ({ id: `tag:${tag}`, type: 'tag' as const, label: tag })),
    ];
  }

  private buildEdges(document: Document, nodes: GraphNode[]): GraphEdge[] {
    return [
      ...nodes
        .filter((n) => n.type !== 'document')
        .map((n) => ({ source: document.id, target: n.id, type: 'contains' as const })),
      ...document.links
        .filter((l) => l.isInternal && l.targetPath)
        .map((l) => ({ source: document.id, target: this.generateId(l.targetPath!), type: 'linksTo' as const, label: l.text })),
      ...document.tags.map((tag) => ({ source: document.id, target: `tag:${tag}`, type: 'hasTag' as const })),
    ];
  }

  private async indexEmbeddings(document: Document): Promise<number> {
    const { embeddingProvider, vectorStore, generateOnIndex } = this.deps;
    if (!embeddingProvider || !vectorStore || !generateOnIndex) {
      return 0;
    }

    const source = document.content && document.content.trim().length > 0 ? document.content : document.rawContent;
    const chunks = chunkText(source, this.deps.chunkOptions);
    if (chunks.length === 0) {
      return 0;
    }

    await vectorStore.delete(document.id);
    const { embeddings } = await embeddingProvider.batchEmbed({ texts: chunks });
    const createdAt = Date.now();

    const records = embeddings.map((vector, index) => ({
      id: `${document.id}:${index}`,
      documentId: document.id,
      chunkIndex: index,
      text: chunks[index],
      vector,
      metadata: { relativePath: document.relativePath },
      createdAt,
    }));

    await vectorStore.addVectors(records);
    return records.length;
  }

  private generateId(filePath: string): string {
    return Buffer.from(filePath).toString('base64').replace(/[/+=]/g, '_');
  }

  private computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}

// Re-export for callers that only want the remote adapter.
export { remoteToSourceFile as remoteDocumentToSourceFile };
