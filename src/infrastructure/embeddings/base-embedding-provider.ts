import {
  EmbeddingProvider,
  EmbeddingOptions,
  EmbeddingResult,
  BatchEmbeddingOptions,
  BatchEmbeddingResult,
  ProviderConfig,
  ProviderStats,
} from '../../domain/ports.js';

// Re-export the domain contract types so concrete providers only import from
// this module and stay decoupled from the domain layer's file layout.
export type {
  EmbeddingProvider,
  EmbeddingOptions,
  EmbeddingResult,
  BatchEmbeddingOptions,
  BatchEmbeddingResult,
  ProviderConfig,
  ProviderStats,
} from '../../domain/ports.js';

/**
 * Shared base class for embedding providers: holds configuration and usage
 * statistics so concrete providers only implement the transport-specific bits.
 */
export abstract class BaseEmbeddingProvider implements EmbeddingProvider {
  protected config: ProviderConfig;
  protected stats: ProviderStats;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.stats = {
      provider: config.provider,
      model: config.model || 'unknown',
      calls: 0,
      totalTokens: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
      lastUsed: Date.now(),
    };
  }

  abstract initialize(): Promise<void>;
  abstract embed(options: EmbeddingOptions): Promise<EmbeddingResult>;
  abstract batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult>;
  abstract getDefaultModel(): string;
  abstract getSupportedModels(): string[];
  abstract isLocal(): boolean;

  getStats(): ProviderStats {
    return { ...this.stats };
  }

  getConfig(): ProviderConfig {
    return { ...this.config };
  }

  protected updateStats(tokens: number, latencyMs: number): void {
    this.stats.calls++;
    this.stats.totalTokens += tokens;
    this.stats.totalLatencyMs += latencyMs;
    this.stats.avgLatencyMs = this.stats.totalLatencyMs / this.stats.calls;
    this.stats.lastUsed = Date.now();
  }
}
