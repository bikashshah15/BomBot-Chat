import { config, type Config } from '../config.ts';
import {
  createOpenAIProvider,
  type OpenAIProvider,
  type OpenAIProviderOptions,
} from './providers/openai.ts';
import type {
  LlmChunk,
  LlmProvider,
  LlmRequest,
  LlmResult,
} from './types.ts';

export type LlmGatewayRequest = Omit<
  LlmRequest,
  'temperature' | 'topP' | 'maxOutputTokens' | 'seed'
>;

export type LlmGatewayConfig = Pick<
  Config,
  | 'PROFILE'
  | 'LLM_BASE_URL'
  | 'LLM_MODEL'
  | 'LLM_API_KEY'
  | 'LLM_TEMPERATURE'
  | 'LLM_TOP_P'
  | 'LLM_MAX_OUTPUT_TOKENS'
  | 'LLM_SEED'
>;

export interface LlmGateway {
  complete(req: LlmGatewayRequest): Promise<LlmResult>;
  stream(req: LlmGatewayRequest): AsyncIterable<LlmChunk>;
}

export interface CreateLlmGatewayOptions {
  settings?: LlmGatewayConfig;
  provider?: LlmProvider;
  openAI?: Pick<OpenAIProviderOptions, 'client'>;
}

export function selectLlmProvider(
  settings: LlmGatewayConfig,
  openAI: Pick<OpenAIProviderOptions, 'client'> = {},
): OpenAIProvider {
  if (settings.PROFILE === 'hosted' && !settings.LLM_API_KEY && !openAI.client) {
    throw new Error('LLM_API_KEY is required for the hosted LLM provider');
  }

  return createOpenAIProvider({
    model: settings.LLM_MODEL,
    apiKey: settings.PROFILE === 'local'
      ? settings.LLM_API_KEY ?? 'local-openai-compatible'
      : settings.LLM_API_KEY,
    baseURL: settings.LLM_BASE_URL,
    client: openAI.client,
  });
}

function applyPinnedDecoding(
  req: LlmGatewayRequest,
  settings: LlmGatewayConfig,
): LlmRequest {
  return {
    ...req,
    temperature: settings.LLM_TEMPERATURE,
    topP: settings.LLM_TOP_P,
    maxOutputTokens: settings.LLM_MAX_OUTPUT_TOKENS,
    seed: settings.LLM_SEED,
  };
}

export function createLlmGateway(options: CreateLlmGatewayOptions = {}): LlmGateway {
  const settings = options.settings ?? config;
  const selectedProvider = options.provider
    ? undefined
    : selectLlmProvider(settings, options.openAI);
  const provider = options.provider ?? selectedProvider as LlmProvider;

  return Object.freeze({
    complete(req: LlmGatewayRequest) {
      return provider.complete(applyPinnedDecoding(req, settings));
    },
    stream(req: LlmGatewayRequest) {
      return provider.stream(applyPinnedDecoding(req, settings));
    },
  });
}
