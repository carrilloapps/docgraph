import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface TogetherAIConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
}

export class TogetherAIProvider extends BaseEmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(config: TogetherAIConfig) {
    super({ provider: 'togetherai', apiKey: config.apiKey, model: config.model });
    this.apiKey = config.apiKey || process.env.TOGETHER_API_KEY || '';
    this.model = config.model || 'togethercomputer/m2-bert-80m';
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Together AI API key not provided');
    }
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch('https://api.together.xyz/v1/embeddings', {
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
      throw new Error(`Together AI error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embedding: data.data?.[0]?.embedding || [],
      model: data.model || model,
      provider: 'togetherai',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch('https://api.together.xyz/v1/embeddings', {
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
      throw new Error(`Together AI error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embeddings: data.data?.map((d: any) => d.embedding) || [],
      model: data.model || model,
      provider: 'togetherai',
      latencyMs,
    };
  }

  getDefaultModel(): string {
    return 'togethercomputer/m2-bert-80m';
  }

  getSupportedModels(): string[] {
    return [
      'togethercomputer/m2-bert-80m',
      'togethercomputer/m2-bert-80m-8k',
      'togethercomputer/embed-5B',
      'togethercomputer/llama-3-8b',
    ];
  }

  isLocal(): boolean {
    return false;
  }
}
