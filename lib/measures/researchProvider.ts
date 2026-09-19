import pg from 'pg';
import { dbPool } from '../db/client.ts';
import {
  extractAndStoreSessionMeasures,
  MeasurePersistenceError,
  recordUnextractedSession,
} from '../db/sessionMeasures.ts';
import { IDLE_WINDOW_MS } from '../db/retentionStatus.ts';
import {
  MeasureProviderError,
  type MeasureProvider,
  type MeasureResolutionProvenance,
} from './provider.ts';

export const EXTRACTION_ATTEMPTS = 3;
export const FIRST_EXTRACTION_LEAD = IDLE_WINDOW_MS * 3 / 4;

export function extractionOpportunityOffsets(windowMs = IDLE_WINDOW_MS): number[] {
  return Array.from(
    { length: EXTRACTION_ATTEMPTS },
    (_, index) => (index + 1) * windowMs / (EXTRACTION_ATTEMPTS + 1),
  );
}

export interface ResearchProviderOverrides {
  extract?: (sessionId: string, activityRevision: string, signal: AbortSignal) => Promise<unknown> | undefined;
}

export function createMeasureProvider(overrides: ResearchProviderOverrides = {}): MeasureProvider {
  const recordingPool = new pg.Pool({ ...dbPool.options, max: 5, connectionTimeoutMillis: 0 });

  return {
    enabled: true,
    opportunityOffsets: extractionOpportunityOffsets(),
    async recordFailure(sessionId, activityRevision, errorClass, resolution) {
      return recordUnextractedSession(sessionId, errorClass, resolution, activityRevision, recordingPool);
    },
    async extract(sessionId, activityRevision, signal) {
      const overridden = overrides.extract?.(sessionId, activityRevision, signal);
      if (overridden) { await overridden; return; }
      const pool = new pg.Pool({ ...dbPool.options, max: 1 });
      const clients = new Set<pg.PoolClient>();
      pool.on('connect', client => { clients.add(client); });
      pool.on('remove', client => { clients.delete(client); });
      pool.on('error', () => {});
      const cancel = () => {
        for (const client of clients) void client.end();
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        await extractAndStoreSessionMeasures(sessionId, activityRevision, pool, signal);
      } catch (error) {
        if (error instanceof MeasurePersistenceError) {
          throw new MeasureProviderError(error.resolutionProvenance as MeasureResolutionProvenance);
        }
        throw error;
      } finally {
        signal.removeEventListener('abort', cancel);
        cancel();
        await pool.end();
      }
    },
    async close() { await recordingPool.end(); },
  };
}
