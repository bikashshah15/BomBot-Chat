import { config, type Config } from '../config.ts';
import {
  createOpenAIProvider,
  type OpenAIProvider,
  type OpenAIProviderOptions,
} from './providers/openai.ts';
import type {
  LlmChunk,
  LlmOperation,
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
  resolve(operation: LlmOperation): Promise<LlmResult>; // INC-06: remove
}

// INC-06: remove — gateway-only operation resolution must not enter LlmProvider.
export interface LlmOperationResolver {
  resolve(operation: LlmOperation): Promise<LlmResult>; // INC-06: remove
}

export interface CreateLlmGatewayOptions {
  settings?: LlmGatewayConfig;
  provider?: LlmProvider;
  resolver?: LlmOperationResolver; // INC-06: remove
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
  const resolver = options.resolver ?? selectedProvider ?? {
    // INC-06: remove — injected local providers resolve their terminal result by identity.
    async resolve(operation: LlmOperation) {
      if (!operation.result) {
        throw new Error('An injected provider requires a resolver for a pending operation');
      }
      return operation.result;
    },
  };

  return Object.freeze({
    complete(req: LlmGatewayRequest) {
      return provider.complete(applyPinnedDecoding(req, settings));
    },
    stream(req: LlmGatewayRequest) {
      return provider.stream(applyPinnedDecoding(req, settings));
    },
    // INC-06: remove — hosted polling disappears with app-owned execution.
    resolve(operation: LlmOperation) {
      return resolver.resolve(operation);
    },
  });
}
