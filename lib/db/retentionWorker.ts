import { safeLog, safeValue } from '../logging/redact.ts';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { dbPool } from './client.ts';
import { sessionKeyVault } from '../crypto/sessionKeyStore.ts';
import { config } from '../config.ts';
import {
  loadMeasureProvider,
  MeasureProviderError,
  noMeasureProvider,
  type MeasureFailureClass,
  type MeasureProvider,
  type MeasureResolutionProvenance,
} from '../measures/provider.ts';
import { readRetentionCounts, RETIREMENT_CUTOFF_SQL, STORAGE_CUTOFF, RETIREMENT_LEAD, IDLE_WINDOW_MS } from './retentionStatus.ts';
export { STORAGE_CUTOFF, RETIREMENT_LEAD, IDLE_WINDOW_MS } from './retentionStatus.ts';

/** Bounded work: a stalled measurement is never a deletion prerequisite. */
export async function boundedAttempt(work: () => Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      Promise.resolve().then(work).then(() => true, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally { clearTimeout(timer!); }
}

/** Shared with explicit participant deletion. Tombstones survive content removal.
 * Commit the tombstone before unlinking: no concurrent writer can recreate a key.
 * A failed purge is retried from the tombstone on the next sweep/restart.
 */
export async function deleteSessionParticipantData(sessionId: string, idleOnly = false, pool = dbPool): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const state = await client.query(`SELECT *, clock_timestamp() >= ${RETIREMENT_CUTOFF_SQL} AS retirement_ready FROM session_retention_rules
      WHERE session_id=$1 FOR UPDATE`, [sessionId]);
    const row = state.rows[0];
    if (!row || (idleOnly && !row.retired_at && (row.retention_mode !== 'ephemeral'
      || !row.last_activity_at || !row.retirement_ready))) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('UPDATE session_retention_rules SET retired_at=COALESCE(retired_at,clock_timestamp()) WHERE session_id=$1', [sessionId]);
    await client.query('COMMIT');
    await sessionKeyVault.destroy(sessionId);
    await client.query('BEGIN');
    await client.query('DELETE FROM chat_logs WHERE session_id=$1', [sessionId]);
    await client.query('DELETE FROM conversations WHERE session_id=$1', [sessionId]);
    await client.query('UPDATE session_retention_rules SET purged_at=COALESCE(purged_at,clock_timestamp()) WHERE session_id=$1', [sessionId]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export interface PreparationDependencies {
  extract: () => Promise<unknown>;
  recordFailure: () => Promise<unknown>;
}
export async function prepareDeletion(deps: PreparationDependencies, budgetMs = 5_000): Promise<void> {
  if (!await boundedAttempt(deps.extract, budgetMs)) {
    if (!await boundedAttempt(deps.recordFailure, Math.min(budgetMs, 1_000))) {
      safeLog('error', safeValue(JSON.stringify({ event: 'retention_failure_record_unavailable' })));
    }
  }
}

/** Automatic worker, never imported by a request route. Uses DB time for deadlines.
 * Extraction starts after one idle quarter and has spaced opportunities; deletion never awaits it.
 */
export async function startRetentionWorker(provider: MeasureProvider = noMeasureProvider): Promise<() => Promise<void>> {
  safeLog('warn', safeValue(JSON.stringify({ event: 'retention_worker_start', idle_window_ms: IDLE_WINDOW_MS })));
  // Extraction (including a stalled injected extractor) cannot borrow these
  // connections. Production attempts have private connections and killable scoring threads.
  const deletionPool = new pg.Pool({ ...dbPool.options, max: 5 });
  const recordings = new Set<Promise<boolean>>();
  const record = (id: string, revision: string, errorClass: MeasureFailureClass,
    resolution?: MeasureResolutionProvenance) => {
    const pending = (async () => {
      try { return await provider.recordFailure(id, revision, errorClass, resolution); }
      catch { safeLog('error', safeValue('{"event":"retention_failure_record_unavailable"}')); return false; }
    })();
    recordings.add(pending);
    void pending.then(() => { recordings.delete(pending); });
    return pending;
  };
  const cancellations = new Set<() => void>();
  const extractions = new Set<Promise<boolean>>();
  const isolated = (id: string, revision: string, budget: number,
    captureResolution?: (source: MeasureResolutionProvenance) => void): Promise<boolean> => {
    const pending = (async () => {
      const controller = new AbortController();
      const cancel = () => { controller.abort(); };
      cancellations.add(cancel);
      try {
        return await boundedAttempt(async () => {
          try { await provider.extract(id, revision, controller.signal); }
          catch (error) {
            if (error instanceof MeasureProviderError && error.resolutionProvenance)
              captureResolution?.(error.resolutionProvenance);
            throw error;
          }
        }, budget);
      } finally {
        cancellations.delete(cancel); cancel();
      }
    })();
    extractions.add(pending);
    void pending.then(() => { extractions.delete(pending); }, () => { extractions.delete(pending); });
    return pending;
  };
  const scheduled = new Map<string, { revision: string; timer: ReturnType<typeof setTimeout>; done: boolean; attempts: number; running: boolean; retryAt: number; deadline: number; recording?: Promise<boolean> }>();
  let stopped = false;
  let sweeping = false;
  let nextReport = 0;
  const retire = async (id: string) => {
    try { await deleteSessionParticipantData(id, true, deletionPool); }
    catch { safeLog('error', safeValue(JSON.stringify({ event: 'retention_deletion_failed' }))); }
  };
  const sweep = async () => {
    if (stopped || sweeping) return;
    sweeping = true;
    try {
      const result = await deletionPool.query(`SELECT session_id,last_activity_at,last_activity_at::text AS activity_revision,retired_at,
        EXTRACT(EPOCH FROM (${RETIREMENT_CUTOFF_SQL} - clock_timestamp()))*1000 AS remaining_ms
        FROM session_retention_rules WHERE retention_mode='ephemeral'
        AND purged_at IS NULL AND (retired_at IS NOT NULL OR last_activity_at IS NOT NULL)`);
      const present = new Set<string>(result.rows.map(row => row.session_id));
      for (const [id, entry] of scheduled) if (!present.has(id)) {
        clearTimeout(entry.timer); scheduled.delete(id);
      }
      for (const row of result.rows) {
        if (row.retired_at) {
          const entry = scheduled.get(row.session_id);
          if (entry) clearTimeout(entry.timer);
          scheduled.delete(row.session_id);
          void retire(row.session_id); continue;
        }
        // Preserve PostgreSQL microseconds; JS Date would silently round them.
        const revision = row.activity_revision as string;
        const old = scheduled.get(row.session_id);
        const remaining = Number(row.remaining_ms);
        if (old && old.revision !== revision) { clearTimeout(old.timer); scheduled.delete(row.session_id); }
        // The timer is installed FIRST. Even a never-settling extractor cannot
        // prevent deadline deletion. SQL rechecks activity under the writer lock.
        let entry = scheduled.get(row.session_id);
        if (!entry) {
          // Keep this epoch admitted until retirement is visible to the sweep.
          // Removing it in the callback lets an in-flight sweep re-admit the
          // same epoch and overwrite its successful measure with a fallback.
          const timer = setTimeout(() => { void retire(row.session_id); }, Math.max(0, Math.min(2_147_483_647, Math.ceil(remaining))));
          entry = { revision, timer, done: false, attempts: 0, running: false, retryAt: 0, deadline: Date.now() + remaining,
            recording: undefined };
          scheduled.set(row.session_id, entry);
        }
        // Public mode still installs and executes the same retirement timer;
        // it simply has no measurement opportunities or result writer.
        if (remaining <= 0) { void retire(row.session_id); continue; }
        if (!provider.enabled) continue;
        // No history/provenance read or result row while activity keeps the
        // epoch younger than its first idle quarter. Persist failure only when
        // that opportunity is due, still before any extraction (even if late).
        const firstDueAt = entry.deadline + RETIREMENT_LEAD - IDLE_WINDOW_MS
          + provider.opportunityOffsets[0];
        if (!entry.recording && Date.now() >= firstDueAt) {
          const errorClass = remaining + RETIREMENT_LEAD <= STORAGE_CUTOFF ? 'extraction_deadline' : 'extraction_failed';
          entry.recording = record(row.session_id, revision, errorClass);
        }
        // The locked DB-time recheck can refuse a timer firing a fraction early.
        // Retry retirement from sweeps without re-admitting/recording this epoch.
        // Storage closes before retirement. No useful extraction can start there.
        if (remaining + RETIREMENT_LEAD <= STORAGE_CUTOFF) continue;
        const opportunity = provider.opportunityOffsets[entry.attempts];
        const dueAt = opportunity === undefined ? entry.retryAt
          : entry.deadline + RETIREMENT_LEAD - IDLE_WINDOW_MS + opportunity;
        // Even early success receives the remaining spaced passes. Once all
        // three have run, only failed epochs retry; success stops further work.
        if (!entry.recording || (entry.done && entry.attempts >= provider.opportunityOffsets.length) || entry.running
          || Date.now() < Math.max(dueAt, entry.retryAt)) continue;
        const attempt = entry;
        attempt.running = true;
        void (async () => {
          // Persist the failure BEFORE extraction. Success replaces it. A slow
          // recorder may finish after retirement, but is never killed by it.
          const recorded = await attempt.recording;
          if (!recorded || stopped || scheduled.get(row.session_id) !== attempt || Date.now() >= attempt.deadline) {
            if (!recorded && !stopped && Date.now() < attempt.deadline)
              attempt.recording = record(row.session_id, revision, 'extraction_failed');
            attempt.running = false; attempt.retryAt = Date.now() + 100;
            return;
          }
          attempt.attempts++;
          let persistenceFailure: MeasureProviderError | undefined;
          const budget = Math.max(1, Math.min(5_000, remaining - Math.min(500, remaining / 2)));
          const ok = await isolated(row.session_id, revision, budget,
            source => { persistenceFailure = new MeasureProviderError(source); });
          attempt.done = ok;
          if (!ok && !stopped && persistenceFailure && scheduled.get(row.session_id) === attempt)
            await record(row.session_id, revision, 'extraction_failed', persistenceFailure.resolutionProvenance);
          attempt.running = false;
          attempt.retryAt = Date.now() + 100;
        })();
      }
      if (Date.now() >= nextReport) {
        const counts = await readRetentionCounts(deletionPool, provider.enabled);
        safeLog('warn', safeValue(JSON.stringify({ event: 'retention_daily_counts', ...counts })));
        nextReport = Date.now() + IDLE_WINDOW_MS;
      }
    } catch { safeLog('error', safeValue(JSON.stringify({ event: 'retention_worker_database_unavailable' }))); }
    finally { sweeping = false; }
  };
  await sweep();
  const interval = setInterval(() => { void sweep(); }, 100);
  return () => {
    stopped = true; clearInterval(interval);
    for (const entry of scheduled.values()) clearTimeout(entry.timer);
    for (const cancel of cancellations) cancel();
    const deletionDrained = deletionPool.end();
    // Drain queued failure writes, including those outliving the deadline.
    return Promise.all([deletionDrained, Promise.all([...extractions]),
      Promise.all([...recordings]).then(() => provider.close())]).then(() => {});
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadMeasureProvider(config.MEASURE_PROVIDER_MODULE).then(startRetentionWorker).then(stop => {
    const shutdown = () => { stop(); void dbPool.end(); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }).catch(() => { safeLog('error', safeValue('{"event":"retention_worker_start_failed"}')); process.exitCode = 1; });
}
