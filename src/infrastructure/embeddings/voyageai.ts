import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface VoyageAIConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
}

export class VoyageAIProvider extends BaseEmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(config: VoyageAIConfig) {
    super({ provider: 'voyageai', apiKey: config.apiKey, model: config.model });
    this.apiKey = config.apiKey || process.env.VOYAGEAI_API_KEY || '';
    this.model = config.model || 'voyage-3';
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Voyage AI API key not provided');
    }
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
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
      throw new Error(`Voyage AI error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embedding: data.data?.[0]?.embedding || [],
      model: data.model || model,
      provider: 'voyageai',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
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
      throw new Error(`Voyage AI error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embeddings: data.data?.map((d: any) => d.embedding) || [],
      model: data.model || model,
      provider: 'voyageai',
      latencyMs,
    };
  }

  getDefaultModel(): string {
    return 'voyage-3';
  }

  getSupportedModels(): string[] {
    return ['voyage-3', 'voyage-3-lite', 'voyage-2'];
  }

  isLocal(): boolean {
    return false;
  }
}
