import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface MistralConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
}

export class MistralProvider extends BaseEmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(config: MistralConfig) {
    super({ provider: 'mistral', apiKey: config.apiKey, model: config.model });
    this.apiKey = config.apiKey || process.env.MISTRAL_API_KEY || '';
    this.model = config.model || 'mistral-embed';
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Mistral API key not provided');
    }
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch('https://api.mistral.ai/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: options.text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Mistral API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embedding: data.data?.[0]?.embedding || [],
      model: data.model || model,
      provider: 'mistral',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch('https://api.mistral.ai/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: options.texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Mistral API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embeddings: data.data?.map((d: any) => d.embedding) || [],
      model: data.model || model,
      provider: 'mistral',
      latencyMs,
    };
  }

  getDefaultModel(): string {
    return 'mistral-embed';
  }

  getSupportedModels(): string[] {
    return ['mistral-embed', 'mistral-embed-small'];
  }

  isLocal(): boolean {
    return false;
  }
}
