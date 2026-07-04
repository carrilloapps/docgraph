import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface FireworksConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
}

export class FireworksProvider extends BaseEmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(config: FireworksConfig) {
    super({ provider: 'fireworks', apiKey: config.apiKey, model: config.model });
    this.apiKey = config.apiKey || process.env.FIREWORKS_API_KEY || '';
    this.model = config.model || 'nomic-ai/nomic-embed-text-v1.5';
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Fireworks AI API key not provided');
    }
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch('https://api.fireworks.ai/v1/embeddings', {
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
      throw new Error(`Fireworks AI error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embedding: data.data?.[0]?.embedding || [],
      model: data.model || model,
      provider: 'fireworks',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch('https://api.fireworks.ai/v1/embeddings', {
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
      throw new Error(`Fireworks AI error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embeddings: data.data?.map((d: any) => d.embedding) || [],
      model: data.model || model,
      provider: 'fireworks',
      latencyMs,
    };
  }

  getDefaultModel(): string {
    return 'nomic-ai/nomic-embed-text-v1.5';
  }

  getSupportedModels(): string[] {
    return [
      'nomic-ai/nomic-embed-text-v1.5',
      'nomic-ai/nomic-embed-text-v1',
      'thenlper/gte-base',
      'thenlper/gte-small',
    ];
  }

  isLocal(): boolean {
    return false;
  }
}
