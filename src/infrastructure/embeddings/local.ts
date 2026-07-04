import {
  BaseEmbeddingProvider,
  EmbeddingOptions,
  EmbeddingResult,
  BatchEmbeddingOptions,
  BatchEmbeddingResult,
} from './base-embedding-provider.js';

export interface LocalConfig {
  model?: string;
  dimension?: number;
}

const DEFAULT_DIMENSION = 256;
const MODEL_NAME = 'local-hash-v1';

/**
 * Zero-dependency, fully offline embedding provider.
 *
 * It turns text into a fixed-length, L2-normalized vector using the
 * "hashing trick" (a.k.a. feature hashing) over token unigrams and bigrams
 * with log-scaled term frequencies. It is deterministic, requires no API key
 * and no model download, and is fast enough to run on every index operation.
 *
 * The vectors are not neural embeddings, so semantic recall is weaker than a
 * hosted model, but they provide meaningful lexical/co-occurrence similarity
 * out of the box and make hybrid search work with no configuration. Configure
 * a cloud provider (OpenAI, Cohere, Voyage, ...) for higher-quality vectors.
 */
export class LocalProvider extends BaseEmbeddingProvider {
  private readonly dimension: number;

  constructor(config: LocalConfig = {}) {
    super({ provider: 'local', model: config.model || MODEL_NAME });
    this.dimension = config.dimension && config.dimension > 0 ? config.dimension : DEFAULT_DIMENSION;
  }

  async initialize(): Promise<void> {
    // Nothing to initialize — the provider is fully local.
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const embedding = this.vectorize(options.text);
    const latencyMs = Date.now() - start;
    this.updateStats(0, latencyMs);
    return {
      embedding,
      model: this.config.model || MODEL_NAME,
      provider: 'local',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const embeddings = options.texts.map((text) => this.vectorize(text));
    const latencyMs = Date.now() - start;
    this.updateStats(0, latencyMs);
    return {
      embeddings,
      model: this.config.model || MODEL_NAME,
      provider: 'local',
      latencyMs,
    };
  }

  getDefaultModel(): string {
    return MODEL_NAME;
  }

  getSupportedModels(): string[] {
    return [MODEL_NAME];
  }

  isLocal(): boolean {
    return true;
  }

  getDimension(): number {
    return this.dimension;
  }

  private vectorize(text: string): number[] {
    const vector = new Array<number>(this.dimension).fill(0);
    const tokens = this.tokenize(text);
    if (tokens.length === 0) {
      return vector;
    }

    const counts = new Map<string, number>();
    for (let i = 0; i < tokens.length; i++) {
      this.addGram(counts, tokens[i]);
      if (i + 1 < tokens.length) {
        this.addGram(counts, `${tokens[i]} ${tokens[i + 1]}`);
      }
    }

    for (const [gram, count] of counts) {
      const bucket = this.hash(gram) % this.dimension;
      const sign = this.hash(`${gram} sign`) % 2 === 0 ? 1 : -1;
      const weight = 1 + Math.log(count);
      vector[bucket] += sign * weight;
    }

    return this.normalize(vector);
  }

  private addGram(counts: Map<string, number>, gram: string): void {
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 0);
  }

  private normalize(vector: number[]): number[] {
    let norm = 0;
    for (const value of vector) {
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (norm === 0) {
      return vector;
    }
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= norm;
    }
    return vector;
  }

  /** FNV-1a 32-bit hash. Returns an unsigned 32-bit integer. */
  private hash(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }
}
