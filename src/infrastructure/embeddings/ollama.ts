import { BaseEmbeddingProvider, EmbeddingOptions, EmbeddingResult, BatchEmbeddingOptions, BatchEmbeddingResult } from './base-embedding-provider.js';

export interface OllamaConfig {
  baseUrl?: string;
  model?: string;
  timeout?: number;
}

export class OllamaProvider extends BaseEmbeddingProvider {
  private baseUrl: string;
  private model: string;

  constructor(config: OllamaConfig) {
    super({ provider: 'ollama', baseUrl: config.baseUrl, model: config.model });
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.model = config.model || 'nomic-embed-text';
  }

  async initialize(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`Ollama not reachable: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Ollama not available at ${this.baseUrl}. Make sure Ollama is running.`);
    }
  }

  async embed(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;

    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: options.text }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    this.updateStats(0, latencyMs);

    return {
      embedding: data.embedding,
      model,
      provider: 'ollama',
      latencyMs,
    };
  }

  async batchEmbed(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const start = Date.now();
    const model = options.model || this.model;
    const embeddings: number[][] = [];

    for (const text of options.texts) {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${error}`);
      }

      const data = await response.json() as any;
      embeddings.push(data.embedding);
    }

    const latencyMs = Date.now() - start;
    this.updateStats(0, latencyMs);

    return { embeddings, model, provider: 'ollama', latencyMs };
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      const data = await response.json() as any;
      return data.models?.map((m: any) => m.name) || [];
    } catch {
      return [];
    }
  }

  getDefaultModel(): string {
    return 'nomic-embed-text';
  }

  getSupportedModels(): string[] {
    return [
      'nomic-embed-text',
      'mxbai-embed-large',
      'all-minilm',
      'snowflake-arctic-embed',
      'phi3',
    ];
  }

  isLocal(): boolean {
    return true;
  }
}
