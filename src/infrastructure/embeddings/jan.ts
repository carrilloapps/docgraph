import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface JanConfig {
  baseUrl?: string;
  model?: string;
  timeout?: number;
}

export class JanProvider extends BaseEmbeddingProvider {
  private baseUrl: string;
  private model: string;

  constructor(config: JanConfig) {
    super({ provider: 'jan', baseUrl: config.baseUrl, model: config.model });
    this.baseUrl = config.baseUrl || 'http://localhost:1337/v1';
    this.model = config.model || 'local-model';
  }

  async initialize(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/models`);
      if (!response.ok) {
        throw new Error(`Jan not reachable: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Jan not available at ${this.baseUrl}. Make sure Jan is running.`);
    }
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: options.text }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jan API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embedding: data.embedding || data.data?.[0]?.embedding || [],
      model: data.model || model,
      provider: 'jan',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;
    const embeddings: number[][] = [];

    for (const text of options.texts) {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Jan API error: ${response.status} - ${error}`);
      }

      const data = await response.json() as any;
      embeddings.push(data.embedding || data.data?.[0]?.embedding || []);
    }

    const latencyMs = Date.now() - start;
    this.updateStats(0, latencyMs);

    return { embeddings, model, provider: 'jan', latencyMs };
  }

  getDefaultModel(): string {
    return 'local-model';
  }

  getSupportedModels(): string[] {
    return ['local-model'];
  }

  isLocal(): boolean {
    return true;
  }
}
