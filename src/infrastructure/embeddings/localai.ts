import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface LocalAIConfig {
  baseUrl?: string;
  model?: string;
  timeout?: number;
}

export class LocalAIProvider extends BaseEmbeddingProvider {
  private baseUrl: string;
  private model: string;

  constructor(config: LocalAIConfig) {
    super({ provider: 'localai', baseUrl: config.baseUrl, model: config.model });
    this.baseUrl = config.baseUrl || 'http://localhost:8080/v1';
    this.model = config.model || 'local-model';
  }

  async initialize(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/models`);
      if (!response.ok) {
        throw new Error(`LocalAI not reachable: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`LocalAI not available at ${this.baseUrl}. Make sure LocalAI is running.`);
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
      throw new Error(`LocalAI error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embedding: data.embedding || data.data?.[0]?.embedding || [],
      model: data.model || model,
      provider: 'localai',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: options.texts }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LocalAI error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embeddings: data.embeddings || data.data?.map((d: any) => d.embedding) || [],
      model: data.model || model,
      provider: 'localai',
      latencyMs,
    };
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
