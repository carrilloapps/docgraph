import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface HuggingFaceConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeout?: number;
}

export class HuggingFaceProvider extends BaseEmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: HuggingFaceConfig) {
    super({ provider: 'huggingface', apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
    this.apiKey = config.apiKey || process.env.HUGGINGFACE_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://api-inference.huggingface.co';
    this.model = config.model || 'sentence-transformers/all-MiniLM-L6-v2';
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('HuggingFace API key not provided');
    }
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch(`${this.baseUrl}/pipeline/feature-extraction/${model}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: options.text }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HuggingFace API error: ${response.status} - ${error}`);
    }

    const embeddingData = await response.json();
    const latencyMs = Date.now() - start;
    const embedding = Array.isArray(embeddingData) ? embeddingData : (embeddingData as any).data?.[0] || [];

    this.updateStats(0, latencyMs);

    return {
      embedding: Array.isArray(embedding) ? embedding : [],
      model,
      provider: 'huggingface',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch(`${this.baseUrl}/pipeline/feature-extraction/${model}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: options.texts }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HuggingFace API error: ${response.status} - ${error}`);
    }

    const embeddingsData = await response.json();
    const latencyMs = Date.now() - start;
    const embeddings = Array.isArray(embeddingsData) ? embeddingsData : (embeddingsData as any).data || [];

    this.updateStats(0, latencyMs);

    return {
      embeddings: embeddings,
      model,
      provider: 'huggingface',
      latencyMs,
    };
  }

  getDefaultModel(): string {
    return 'sentence-transformers/all-MiniLM-L6-v2';
  }

  getSupportedModels(): string[] {
    return [
      'sentence-transformers/all-MiniLM-L6-v2',
      'sentence-transformers/all-mpnet-base-v2',
      'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
      'intfloat/e5-base-v2',
      'intfloat/e5-small-v2',
    ];
  }

  isLocal(): boolean {
    return false;
  }
}
