import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface LMStudioConfig {
  baseUrl?: string;
  model?: string;
  timeout?: number;
}

export class LMStudioProvider extends BaseEmbeddingProvider {
  private baseUrl: string;
  private model: string;

  constructor(config: LMStudioConfig) {
    super({ provider: 'lmstudio', baseUrl: config.baseUrl, model: config.model });
    this.baseUrl = config.baseUrl || 'http://localhost:1234/v1';
    this.model = config.model || 'local-model';
  }

  async initialize(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/models`);
      if (!response.ok) {
        throw new Error(`LM Studio not reachable: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`LM Studio not available at ${this.baseUrl}. Make sure LM Studio is running with API enabled.`);
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
      throw new Error(`LM Studio API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embedding: data.data?.[0]?.embedding || data.embedding,
      model: data.model || model,
      provider: 'lmstudio',
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
      throw new Error(`LM Studio API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embeddings: data.data?.map((d: any) => d.embedding) || [],
      model: data.model || model,
      provider: 'lmstudio',
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
