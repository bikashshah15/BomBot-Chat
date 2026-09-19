import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type MeasureFailureClass = 'extraction_failed' | 'extraction_deadline';

export interface MeasureResolutionProvenance {
  osv_mode: 'offline';
  snapshot_date: string;
  status: 'available' | 'missing_snapshot' | 'pin_mismatch';
}

export class MeasureProviderError extends Error {
  readonly resolutionProvenance?: MeasureResolutionProvenance;

  constructor(resolutionProvenance?: MeasureResolutionProvenance) {
    super('Measurement provider failed');
    this.name = 'MeasureProviderError';
    this.resolutionProvenance = resolutionProvenance;
  }
}

export interface MeasureProvider {
  readonly enabled: boolean;
  readonly opportunityOffsets: readonly number[];
  extract(sessionId: string, activityRevision: string, signal: AbortSignal): Promise<void>;
  recordFailure(sessionId: string, activityRevision: string, errorClass: MeasureFailureClass,
    resolution?: MeasureResolutionProvenance): Promise<boolean>;
  close(): Promise<void>;
}

export const noMeasureProvider: MeasureProvider = Object.freeze({
  enabled: false,
  opportunityOffsets: Object.freeze([]),
  async extract() {},
  async recordFailure() { return false; },
  async close() {},
});

export class MeasureProviderLoadError extends Error {
  constructor() {
    super('Configured measurement provider is unavailable');
    this.name = 'MeasureProviderLoadError';
  }
}

function validProvider(value: unknown): value is MeasureProvider {
  if (!value || typeof value !== 'object') return false;
  const provider = value as Partial<MeasureProvider>;
  return provider.enabled === true
    && Array.isArray(provider.opportunityOffsets)
    && provider.opportunityOffsets.every(offset => Number.isFinite(offset) && offset > 0)
    && typeof provider.extract === 'function'
    && typeof provider.recordFailure === 'function'
    && typeof provider.close === 'function';
}

/** Load configured code only from an absolute filesystem path. */
export async function loadMeasureProvider(modulePath?: string): Promise<MeasureProvider> {
  if (modulePath === undefined) return noMeasureProvider;
  if (!path.isAbsolute(modulePath)) throw new MeasureProviderLoadError();
  try {
    const loaded = await import(pathToFileURL(modulePath).href);
    if (typeof loaded.createMeasureProvider !== 'function') throw new MeasureProviderLoadError();
    const provider = await loaded.createMeasureProvider();
    if (!validProvider(provider)) throw new MeasureProviderLoadError();
    return provider;
  } catch {
    throw new MeasureProviderLoadError();
  }
}
