import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface OpenAIConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeout?: number;
}

export class OpenAIProvider extends BaseEmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: OpenAIConfig) {
    super({ provider: 'openai', apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.model = config.model || 'text-embedding-3-small';
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key not provided');
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
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(data.usage?.total_tokens || 0, latencyMs);

    return {
      embedding: data.data[0].embedding,
      model: data.model,
      tokens: data.usage?.total_tokens,
      provider: 'openai',
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
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(data.usage?.total_tokens || 0, latencyMs);

    return {
      embeddings: data.data.map((d: any) => d.embedding),
      model: data.model,
      tokens: data.usage?.total_tokens,
      provider: 'openai',
      latencyMs,
    };
  }

  getDefaultModel(): string {
    return 'text-embedding-3-small';
  }

  getSupportedModels(): string[] {
    return [
      'text-embedding-3-small',
      'text-embedding-3-large',
      'text-embedding-ada-002',
    ];
  }

  isLocal(): boolean {
    return false;
  }
}
