/**
 * Public library API.
 *
 * DocGraph is layered following Clean Architecture:
 *   - `domain`         — entities, ports (interfaces) and pure services.
 *   - `application`    — use cases (indexing, search, queries).
 *   - `infrastructure` — adapters (SQLite, embeddings, filesystem, config).
 *   - `presentation`   — entry points (CLI, MCP server).
 *   - `container`      — the composition root that wires everything together.
 *
 * The CLI and MCP server have their own executable entry points
 * (`presentation/cli/cli.ts` and `presentation/mcp/server.ts`).
 */
export * from './domain/entities.js';
export * from './domain/ports.js';
export * from './domain/chunker.js';

export { Container } from './container.js';
export type { ContainerOptions } from './container.js';

export { IndexingService } from './application/indexing-service.js';
export type { IndexResult, FileIndexResult, IndexingServiceDeps } from './application/indexing-service.js';
export { SearchService } from './application/search-service.js';
export type { SearchOptions, SearchConfig, SearchServiceDeps } from './application/search-service.js';
export { QueryService } from './application/query-service.js';
export type { ListOptions, DocumentGraph } from './application/query-service.js';

export { SqliteKnowledgeStore } from './infrastructure/persistence/sqlite-knowledge-store.js';
export { SqliteVectorStore } from './infrastructure/persistence/sqlite-vector-store.js';
export { MultiFormatDocumentParser } from './infrastructure/filesystem/document-parser.js';
export { FileSystemDocumentSource } from './infrastructure/filesystem/file-system-document-source.js';
export { LocalProvider } from './infrastructure/embeddings/local.js';
export { EmbeddingProviderFactory, PROVIDER_INFO, PROVIDER_LIST } from './infrastructure/embeddings/provider-factory.js';
export type { ProviderType, ProviderInfo, ProviderSettings } from './infrastructure/embeddings/provider-factory.js';

export {
  loadSettings,
  createDefaultSettings,
  getEffectiveExcludePatterns,
  getAllSupportedExtensions,
  resolveEnvVariables,
  DEFAULT_EXCLUDE_PATTERNS,
  SUPPORTED_EXTENSIONS,
} from './infrastructure/config/settings.js';
export type { DocGraphSettings } from './infrastructure/config/settings.js';
