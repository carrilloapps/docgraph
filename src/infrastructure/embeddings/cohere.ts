import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface CohereConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
}

export class CohereProvider extends BaseEmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(config: CohereConfig) {
    super({ provider: 'cohere', apiKey: config.apiKey, model: config.model });
    this.apiKey = config.apiKey || process.env.COHERE_API_KEY || '';
    this.model = config.model || 'embed-english-v3.0';
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Cohere API key not provided');
    }
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch('https://api.cohere.ai/v2/embed', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        texts: [options.text],
        inputType: 'search_document',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cohere API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embedding: data.embeddings?.[0] || [],
      model: data.model || model,
      provider: 'cohere',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch('https://api.cohere.ai/v2/embed', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        texts: options.texts,
        inputType: 'search_document',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cohere API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embeddings: data.embeddings || [],
      model: data.model || model,
      provider: 'cohere',
      latencyMs,
    };
  }

  getDefaultModel(): string {
    return 'embed-english-v3.0';
  }

  getSupportedModels(): string[] {
    return [
      'embed-english-v3.0',
      'embed-english-v3',
      'embed-multilingual-v3.0',
      'embed-multilingual-v2',
      'embed-english-v2',
      'embed-multilingual-light-v3.0',
    ];
  }

  isLocal(): boolean {
    return false;
  }
}
