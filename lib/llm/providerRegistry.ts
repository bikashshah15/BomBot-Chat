import { config } from '../config.ts';
import type { LlmGatewayConfig } from './gateway.ts';

export const PROVIDER_IDS = ['primary', 'alternate'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

function incompleteAlternateProvider(): never {
  throw new Error('Alternate model provider is unavailable');
}

export function resolveProviderSettings(id: ProviderId): LlmGatewayConfig;
export function resolveProviderSettings(id: string): LlmGatewayConfig;
export function resolveProviderSettings(id: string): LlmGatewayConfig {
  if (id === 'primary') return config;
  if (id !== 'alternate') throw new Error('Unknown model provider');

  const profile = config.ALT_PROFILE;
  const baseURL = config.ALT_LLM_BASE_URL;
  const model = config.ALT_LLM_MODEL;
  if (!profile || !baseURL || !model) return incompleteAlternateProvider();
  if (profile === 'hosted' && !config.ALT_LLM_API_KEY) return incompleteAlternateProvider();

  return {
    PROFILE: profile,
    LLM_BASE_URL: baseURL,
    LLM_MODEL: model,
    LLM_API_KEY: config.ALT_LLM_API_KEY,
    LLM_TEMPERATURE: config.LLM_TEMPERATURE,
    LLM_TOP_P: config.LLM_TOP_P,
    LLM_MAX_OUTPUT_TOKENS: config.LLM_MAX_OUTPUT_TOKENS,
    LLM_REASONING_EFFORT: config.ALT_LLM_REASONING_EFFORT,
    LLM_SEED: config.LLM_SEED,
  };
}

export function isProviderAvailable(id: ProviderId): boolean;
export function isProviderAvailable(id: string): boolean;
export function isProviderAvailable(id: string): boolean {
  try {
    resolveProviderSettings(id);
    return true;
  } catch {
    return false;
  }
}

export function providerLabel(id: ProviderId): string;
export function providerLabel(id: string): string;
export function providerLabel(id: string): string {
  const settings = resolveProviderSettings(id);
  return `${settings.PROFILE === 'local' ? 'Local' : 'OpenAI'} — ${settings.LLM_MODEL}`;
}
