import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface ReplicateConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
}

export class ReplicateProvider extends BaseEmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(config: ReplicateConfig) {
    super({ provider: 'replicate', apiKey: config.apiKey, model: config.model });
    this.apiKey = config.apiKey || process.env.REPLICATE_API_KEY || '';
    this.model = config.model || 'replicate/vision';
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Replicate API key not provided');
    }
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: model,
        input: { text: options.text },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Replicate API error: ${response.status} - ${error}`);
    }

    const prediction = await response.json() as any;

    let status = prediction.status;
    let result = prediction;

    while (status !== 'succeeded' && status !== 'failed') {
      await new Promise(r => setTimeout(r, 1000));
      const getRes = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
      });
      result = await getRes.json() as any;
      status = result.status;
    }

    const latencyMs = Date.now() - start;
    this.updateStats(0, latencyMs);

    if (status === 'failed') {
      throw new Error(`Replicate prediction failed: ${result.error}`);
    }

    return {
      embedding: result.output?.embedding || result.output?.[0] || [],
      model,
      provider: 'replicate',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;
    const embeddings: number[][] = [];

    for (const text of options.texts) {
      const response = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: model,
          input: { text },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Replicate API error: ${response.status} - ${error}`);
      }

      const prediction = await response.json() as any;

      let status = prediction.status;
      let result = prediction;

      while (status !== 'succeeded' && status !== 'failed') {
        await new Promise(r => setTimeout(r, 1000));
        const getRes = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
          headers: { 'Authorization': `Bearer ${this.apiKey}` },
        });
        result = await getRes.json() as any;
        status = result.status;
      }

      if (status === 'failed') {
        throw new Error(`Replicate prediction failed: ${result.error}`);
      }

      embeddings.push(result.output?.embedding || result.output?.[0] || []);
    }

    const latencyMs = Date.now() - start;
    this.updateStats(0, latencyMs);

    return { embeddings, model, provider: 'replicate', latencyMs };
  }

  getDefaultModel(): string {
    return 'replicate/vision';
  }

  getSupportedModels(): string[] {
    return [
      'replicate/vision',
      'methexis-inc/clip-vit-large-patch14-336',
    ];
  }

  isLocal(): boolean {
    return false;
  }
}
