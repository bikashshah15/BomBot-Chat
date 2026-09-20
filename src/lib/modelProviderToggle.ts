export interface ModelProviderStatus {
  toggleEnabled: boolean;
  providers: Array<{ id: string; label: string; available: boolean }>;
  activeProviderLabel: string;
}

export interface ModelProviderToggleView {
  currentLabel: string;
  options: Array<{ id: string; label: 'Local' | 'OpenAI'; disabled: boolean; note?: string }>;
}

export function modelProviderToggleView(
  status: ModelProviderStatus,
): ModelProviderToggleView | null {
  if (!status.toggleEnabled) return null;
  return {
    currentLabel: status.activeProviderLabel,
    options: status.providers.map((provider, index) => {
      const label = index === 0 ? 'Local' as const : 'OpenAI' as const;
      return {
        id: provider.id,
        label,
        disabled: !provider.available,
        ...(!provider.available && label === 'OpenAI' ? { note: 'OpenAI unavailable' } : {}),
      };
    }),
  };
}

export const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  sbom_required: 'SBOM required.',
  hosted_rate_limited: 'Rate limit reached.',
  demo_access_required: 'Demo access required.',
  hosted_budget_exhausted: 'Budget exhausted.',
};

export function refusalMessage(code: unknown, fallback: string): string {
  return typeof code === 'string' ? REFUSAL_MESSAGES[code] ?? fallback : fallback;
}
