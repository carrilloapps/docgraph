import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface MiniMaxConfig {
  apiKey?: string;
  groupId?: string;
  baseUrl?: string;
  model?: string;
  timeout?: number;
}

export class MiniMaxProvider extends BaseEmbeddingProvider {
  private apiKey: string;
  private groupId: string;
  private baseUrl: string;
  private model: string;

  constructor(config: MiniMaxConfig) {
    super({ provider: 'minimax', apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
    this.apiKey = config.apiKey || process.env.MINIMAX_API_KEY || '';
    this.groupId = config.groupId || process.env.MINIMAX_GROUP_ID || '';
    this.baseUrl = config.baseUrl || 'https://api.minimax.io/v1';
    this.model = config.model || 'embo-01';
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('MiniMax API key not provided');
    }
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: options.text,
        group_id: this.groupId,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MiniMax API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embedding: data.data?.[0]?.embedding || data.embedding,
      model: data.model || model,
      provider: 'minimax',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: options.texts,
        group_id: this.groupId,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MiniMax API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embeddings: data.data?.map((d: any) => d.embedding) || [],
      model: data.model || model,
      provider: 'minimax',
      latencyMs,
    };
  }

  getDefaultModel(): string {
    return 'embo-01';
  }

  getSupportedModels(): string[] {
    return [
      'embo-01',
      'embed-text-v1',
      'embed-text-v2',
    ];
  }

  isLocal(): boolean {
    return false;
  }
}
