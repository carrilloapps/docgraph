import {
  Document,
  GraphNode,
  GraphEdge,
  SearchResult,
  IndexStats,
  Heading,
  DocumentLink,
  CodeBlock,
} from './entities.js';

/**
 * Ports (interfaces) that the application layer depends on. Concrete adapters
 * live in the infrastructure layer and are wired at the composition root, so
 * the domain and application layers never depend on SQLite, HTTP, or the file
 * system directly (Dependency Inversion Principle).
 */

/** Persistence of documents and full-text search. */
export interface DocumentRepository {
  upsertDocument(doc: Document): void;
  deleteDocument(id: string): void;
  deleteDocumentByPath(path: string): void;
  getDocument(id: string): Document | null;
  getDocumentByPath(path: string): Document | null;
  getAllDocuments(): Document[];
  searchFullText(query: string, limit?: number): SearchResult[];
  getStats(): IndexStats;
  setMetadata(key: string, value: string): void;
  getMetadata(key: string): string | null;
  clear(): void;
  close(): void;
}

/** Persistence of the knowledge graph (nodes + edges). */
export interface GraphRepository {
  upsertNode(node: GraphNode): void;
  upsertEdge(edge: GraphEdge): void;
  clearEdges(): void;
}

/** A repository that stores both documents and their graph. */
export type KnowledgeRepository = DocumentRepository & GraphRepository;

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbeddingOptions {
  text: string;
  model?: string;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  tokens?: number;
  provider: string;
  latencyMs: number;
}

export interface BatchEmbeddingOptions {
  texts: string[];
  model?: string;
}

export interface BatchEmbeddingResult {
  embeddings: number[][];
  model: string;
  tokens?: number;
  provider: string;
  latencyMs: number;
}

export interface ProviderConfig {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeout?: number;
  maxRetries?: number;
}

export interface ProviderStats {
  provider: string;
  model: string;
  calls: number;
  totalTokens: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  lastUsed: number;
}

export interface EmbeddingProvider {
  initialize(): Promise<void>;
  embed(options: EmbeddingOptions): Promise<EmbeddingResult>;
  batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult>;
  getDefaultModel(): string;
  getSupportedModels(): string[];
  isLocal(): boolean;
  getStats(): ProviderStats;
}

// ---------------------------------------------------------------------------
// Vector store
// ---------------------------------------------------------------------------

export interface VectorRecord {
  id: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  vector: number[];
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface VectorSearchResult {
  record: VectorRecord;
  score: number;
}

export interface VectorStoreStats {
  totalVectors: number;
  totalDocuments: number;
  dimensions: number;
  indexSizeBytes: number;
}

export interface VectorStore {
  addVectors(records: VectorRecord[]): Promise<void>;
  search(query: number[], limit: number, minScore?: number): Promise<VectorSearchResult[]>;
  delete(documentId: string): Promise<void>;
  clear(): Promise<void>;
  getStats(): VectorStoreStats;
  close(): void;
}

// ---------------------------------------------------------------------------
// Document ingestion
// ---------------------------------------------------------------------------

/** A single readable source file discovered in the project. */
export interface SourceFile {
  path: string;
  relativePath: string;
  rawContent: string;
  extension: string;
  language: string;
  size: number;
}

/**
 * Discovers and reads candidate files from a project, abstracting away the file
 * system, exclude patterns, extension filters and size limits.
 */
export interface DocumentSource {
  list(): string[];
  read(path: string): SourceFile | null;
  getSupportedExtensions(): string[];
  getExcludePatterns(): string[];
}

/** The structured result of parsing a raw document. */
export interface ParsedDocument {
  content: string;
  language: string;
  title?: string;
  description?: string;
  tags: string[];
  headings: Heading[];
  links: DocumentLink[];
  codeBlocks: CodeBlock[];
}

/** Parses raw file content into structured document data. */
export interface DocumentParser {
  parse(filePath: string, rawContent: string, extension: string, defaultLanguage: string): ParsedDocument;
}
