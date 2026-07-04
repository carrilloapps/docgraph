import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface GoogleConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
}

export class GoogleProvider extends BaseEmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(config: GoogleConfig) {
    super({ provider: 'google', apiKey: config.apiKey, model: config.model });
    this.apiKey = config.apiKey || process.env.GOOGLE_API_KEY || '';
    this.model = config.model || 'text-embedding-004';
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Google API key not provided');
    }
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: [{ text: options.text }] },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embedding: data.embedding?.values || [],
      model,
      provider: 'google',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;
    const embeddings: number[][] = [];

    for (const text of options.texts) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: `models/${model}`,
            content: { parts: [{ text }] },
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Google API error: ${response.status} - ${error}`);
      }

      const data = await response.json() as any;
      embeddings.push(data.embedding?.values || []);
    }

    const latencyMs = Date.now() - start;
    this.updateStats(0, latencyMs);

    return { embeddings, model, provider: 'google', latencyMs };
  }

  getDefaultModel(): string {
    return 'text-embedding-004';
  }

  getSupportedModels(): string[] {
    return [
      'text-embedding-004',
      'embedding-001',
      'text-multilingual-embedding-002',
    ];
  }

  isLocal(): boolean {
    return false;
  }
}
