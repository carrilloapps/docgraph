import { EmbeddingProvider } from '../../domain/ports.js';
import { LocalProvider, LocalConfig } from './local.js';
import { OpenAIProvider, OpenAIConfig } from './openai.js';
import { MiniMaxProvider, MiniMaxConfig } from './minimax.js';
import { OllamaProvider, OllamaConfig } from './ollama.js';
import { LMStudioProvider, LMStudioConfig } from './lmstudio.js';
import { HuggingFaceProvider, HuggingFaceConfig } from './huggingface.js';
import { GoogleProvider, GoogleConfig } from './google.js';
import { CohereProvider, CohereConfig } from './cohere.js';
import { VoyageAIProvider, VoyageAIConfig } from './voyageai.js';
import { MistralProvider, MistralConfig } from './mistral.js';
import { FireworksProvider, FireworksConfig } from './fireworks.js';
import { TogetherAIProvider, TogetherAIConfig } from './togetherai.js';
import { AzureProvider, AzureConfig } from './azure.js';
import { LocalAIProvider, LocalAIConfig } from './localai.js';
import { JanProvider, JanConfig } from './jan.js';
import { ReplicateProvider, ReplicateConfig } from './replicate.js';

export interface ProviderSettings {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeout?: number;
  maxRetries?: number;
  batchSize?: number;
  dimension?: number;
}

export type ProviderType =
  | 'local'
  | 'openai'
  | 'minimax'
  | 'ollama'
  | 'lmstudio'
  | 'huggingface'
  | 'google'
  | 'cohere'
  | 'voyageai'
  | 'mistral'
  | 'fireworks'
  | 'togetherai'
  | 'azure'
  | 'localai'
  | 'jan'
  | 'replicate';

export const PROVIDER_LIST: ProviderType[] = [
  'local',
  'openai',
  'minimax',
  'ollama',
  'lmstudio',
  'huggingface',
  'google',
  'cohere',
  'voyageai',
  'mistral',
  'fireworks',
  'togetherai',
  'azure',
  'localai',
  'jan',
  'replicate',
];

export interface ProviderInfo {
  name: string;
  supportsBatch: boolean;
  isLocal: boolean;
  requiresApiKey: boolean;
  /** Environment variable inspected during `auto` resolution. */
  apiKeyEnv?: string;
  description: string;
}

export const PROVIDER_INFO: Record<ProviderType, ProviderInfo> = {
  local: {
    name: 'Local (built-in)',
    supportsBatch: true,
    isLocal: true,
    requiresApiKey: false,
    description: 'Zero-dependency offline hashing embeddings. Default, no setup required.',
  },
  openai: {
    name: 'OpenAI',
    supportsBatch: true,
    isLocal: false,
    requiresApiKey: true,
    apiKeyEnv: 'OPENAI_API_KEY',
    description: 'text-embedding-3-small, text-embedding-3-large, ada-002',
  },
  minimax: {
    name: 'MiniMax',
    supportsBatch: true,
    isLocal: false,
    requiresApiKey: true,
    apiKeyEnv: 'MINIMAX_API_KEY',
    description: 'embo-01, embed-text-v1/v2',
  },
  ollama: {
    name: 'Ollama',
    supportsBatch: false,
    isLocal: true,
    requiresApiKey: false,
    description: 'nomic-embed-text, mxbai-embed-large, any local Ollama model',
  },
  lmstudio: {
    name: 'LM Studio',
    supportsBatch: true,
    isLocal: true,
    requiresApiKey: false,
    description: 'Any embedding model loaded in LM Studio',
  },
  huggingface: {
    name: 'HuggingFace',
    supportsBatch: true,
    isLocal: false,
    requiresApiKey: true,
    apiKeyEnv: 'HUGGINGFACE_API_KEY',
    description: 'sentence-transformers, e5, all-MiniLM (Inference API)',
  },
  google: {
    name: 'Google AI',
    supportsBatch: false,
    isLocal: false,
    requiresApiKey: true,
    apiKeyEnv: 'GOOGLE_API_KEY',
    description: 'text-embedding-004, embedding-001',
  },
  cohere: {
    name: 'Cohere',
    supportsBatch: true,
    isLocal: false,
    requiresApiKey: true,
    apiKeyEnv: 'COHERE_API_KEY',
    description: 'embed-english-v3.0, embed-multilingual-v3.0',
  },
  voyageai: {
    name: 'Voyage AI',
    supportsBatch: true,
    isLocal: false,
    requiresApiKey: true,
    apiKeyEnv: 'VOYAGE_API_KEY',
    description: 'voyage-3, voyage-3-lite, voyage-2',
  },
  mistral: {
    name: 'Mistral AI',
    supportsBatch: true,
    isLocal: false,
    requiresApiKey: true,
    apiKeyEnv: 'MISTRAL_API_KEY',
    description: 'mistral-embed',
  },
  fireworks: {
    name: 'Fireworks AI',
    supportsBatch: true,
    isLocal: false,
    requiresApiKey: true,
    apiKeyEnv: 'FIREWORKS_API_KEY',
    description: 'nomic-embed-text-v1.5, gte-base, gte-large',
  },
  togetherai: {
    name: 'Together AI',
    supportsBatch: true,
    isLocal: false,
    requiresApiKey: true,
    apiKeyEnv: 'TOGETHER_API_KEY',
    description: 'm2-bert-80m, bge-base, bge-large',
  },
  azure: {
    name: 'Azure OpenAI',
    supportsBatch: true,
    isLocal: false,
    requiresApiKey: true,
    apiKeyEnv: 'AZURE_OPENAI_API_KEY',
    description: 'Embedding deployments on Azure OpenAI Service',
  },
  localai: {
    name: 'LocalAI',
    supportsBatch: true,
    isLocal: true,
    requiresApiKey: false,
    description: 'Self-hosted models via LocalAI (OpenAI-compatible API)',
  },
  jan: {
    name: 'Jan',
    supportsBatch: false,
    isLocal: true,
    requiresApiKey: false,
    description: 'Local models served by Jan (OpenAI-compatible API)',
  },
  replicate: {
    name: 'Replicate',
    supportsBatch: false,
    isLocal: false,
    requiresApiKey: true,
    apiKeyEnv: 'REPLICATE_API_TOKEN',
    description: 'Embedding models hosted on Replicate',
  },
};

/**
 * Resolve the `auto` provider to a concrete one:
 * pick the first cloud provider whose API key is present in the environment,
 * otherwise fall back to the always-available local provider.
 */
export function detectProvider(settings: ProviderSettings): ProviderType {
  if (settings.apiKey) {
    return 'openai';
  }
  for (const type of PROVIDER_LIST) {
    const info = PROVIDER_INFO[type];
    if (info.apiKeyEnv && process.env[info.apiKeyEnv]) {
      return type;
    }
  }
  return 'local';
}

export class EmbeddingProviderFactory {
  static create(settings: ProviderSettings): EmbeddingProvider {
    let provider = settings.provider;
    if (!provider || provider === 'auto') {
      provider = detectProvider(settings);
    }

    const config = {
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model && settings.model !== 'auto' ? settings.model : undefined,
      timeout: settings.timeout,
      maxRetries: settings.maxRetries,
    };

    switch (provider) {
      case 'local':
        return new LocalProvider({ model: config.model, dimension: settings.dimension } as LocalConfig);
      case 'openai':
        return new OpenAIProvider(config as OpenAIConfig);
      case 'minimax':
        return new MiniMaxProvider(config as MiniMaxConfig);
      case 'ollama':
        return new OllamaProvider(config as OllamaConfig);
      case 'lmstudio':
        return new LMStudioProvider(config as LMStudioConfig);
      case 'huggingface':
        return new HuggingFaceProvider(config as HuggingFaceConfig);
      case 'google':
        return new GoogleProvider(config as GoogleConfig);
      case 'cohere':
        return new CohereProvider(config as CohereConfig);
      case 'voyageai':
        return new VoyageAIProvider(config as VoyageAIConfig);
      case 'mistral':
        return new MistralProvider(config as MistralConfig);
      case 'fireworks':
        return new FireworksProvider(config as FireworksConfig);
      case 'togetherai':
        return new TogetherAIProvider(config as TogetherAIConfig);
      case 'azure':
        return new AzureProvider(config as AzureConfig);
      case 'localai':
        return new LocalAIProvider(config as LocalAIConfig);
      case 'jan':
        return new JanProvider(config as JanConfig);
      case 'replicate':
        return new ReplicateProvider(config as ReplicateConfig);
      default:
        throw new Error(`Unknown embedding provider: ${provider}`);
    }
  }

  static getInfo(provider: ProviderType): ProviderInfo {
    return PROVIDER_INFO[provider];
  }

  static getAllProviders(): ProviderType[] {
    return [...PROVIDER_LIST];
  }

  /** Resolve `auto` to the concrete provider that would be used. */
  static resolve(settings: ProviderSettings): ProviderType {
    if (!settings.provider || settings.provider === 'auto') {
      return detectProvider(settings);
    }
    return settings.provider as ProviderType;
  }
}
