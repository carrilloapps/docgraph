import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface AzureConfig {
  apiKey?: string;
  endpoint?: string;
  apiVersion?: string;
  model?: string;
  timeout?: number;
}

export class AzureProvider extends BaseEmbeddingProvider {
  private apiKey: string;
  private endpoint: string;
  private apiVersion: string;
  private model: string;

  constructor(config: AzureConfig) {
    super({ provider: 'azure', apiKey: config.apiKey, baseUrl: config.endpoint, model: config.model });
    this.apiKey = config.apiKey || process.env.AZURE_OPENAI_API_KEY || '';
    this.endpoint = config.endpoint || process.env.AZURE_OPENAI_ENDPOINT || '';
    this.apiVersion = config.apiVersion || '2024-02-01';
    this.model = config.model || 'text-embedding-3-small';
  }

  async initialize(): Promise<void> {
    if (!this.apiKey || !this.endpoint) {
      throw new Error('Azure OpenAI credentials not provided');
    }
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const url = `${this.endpoint}/openai/deployments/${model}/embeddings?api-version=${this.apiVersion}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
      },
      body: JSON.stringify({
        model,
        input: options.text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Azure OpenAI error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embedding: data.data?.[0]?.embedding || [],
      model: data.model || model,
      provider: 'azure',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const url = `${this.endpoint}/openai/deployments/${model}/embeddings?api-version=${this.apiVersion}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
      },
      body: JSON.stringify({
        model,
        input: options.texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Azure OpenAI error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embeddings: data.data?.map((d: any) => d.embedding) || [],
      model: data.model || model,
      provider: 'azure',
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
