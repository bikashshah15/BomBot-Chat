import { safeLog, safeValue } from '../logging/redact.ts';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import pg from 'pg';
import { dbPool } from './client.ts';
import { sessionKeyVault } from '../crypto/sessionKeyStore.ts';
import { extractAndStoreSessionMeasures, recordUnextractedSession, MeasurePersistenceError } from './sessionMeasures.ts';
import { readRetentionCounts, RETIREMENT_CUTOFF_SQL, STORAGE_CUTOFF, RETIREMENT_LEAD, IDLE_WINDOW_MS } from './retentionStatus.ts';
export { STORAGE_CUTOFF, RETIREMENT_LEAD, IDLE_WINDOW_MS } from './retentionStatus.ts';

const PREPARE_MS = 60_000;

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
 * Extraction starts in the last minute; deadline callbacks do not await it.
 */
export async function startRetentionWorker(extract?: (id: string, activity: string) => Promise<unknown> | undefined): Promise<() => Promise<void>> {
  safeLog('warn', safeValue(JSON.stringify({ event: 'retention_worker_start', idle_window_ms: IDLE_WINDOW_MS })));
  // Extraction (including a stalled injected extractor) cannot borrow these
  // connections. Production attempts additionally have killable private pools.
  const deletionPool = new pg.Pool({ ...dbPool.options, max: 5 });
  // Failure writes have their own pool and are NOT cancelled at retirement.
  // They touch no retirement-row lock and cannot consume deletion connections.
  const recordingPool = new pg.Pool({ ...dbPool.options, max: 5, connectionTimeoutMillis: 0 });
  const recordings = new Set<Promise<boolean>>();
  const record = (id: string, revision: string, errorClass: 'extraction_failed' | 'extraction_deadline',
    resolution?: MeasurePersistenceError['resolutionProvenance']) => {
    const pending = (async () => {
      try { return await recordUnextractedSession(id, errorClass, resolution, revision, recordingPool); }
      catch { safeLog('error', safeValue('{"event":"retention_failure_record_unavailable"}')); return false; }
    })();
    recordings.add(pending);
    void pending.then(() => { recordings.delete(pending); });
    return pending;
  };
  const jobs = new Set<ReturnType<typeof fork>>();
  const isolated = (kind: 'extract' | 'failure', id: string, revision: string, budget: number,
    resolution?: MeasurePersistenceError['resolutionProvenance'],
    captureResolution?: (source: MeasurePersistenceError['resolutionProvenance']) => void): Promise<boolean> => new Promise(resolve => {
    const child = fork(fileURLToPath(import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, PGOPTIONS: dbPool.options.options ?? process.env.PGOPTIONS },
    });
    jobs.add(child);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); jobs.delete(child);
      child.kill('SIGKILL'); resolve(ok);
    };
    const timer = setTimeout(() => finish(false), budget);
    child.once('message', message => {
      const failure = message as {resolution?: MeasurePersistenceError['resolutionProvenance']};
      if (failure?.resolution) captureResolution?.(failure.resolution);
      finish(message === 'ok');
    });
    child.once('error', () => finish(false));
    child.once('exit', () => finish(false));
    child.send({ kind, id, revision, resolution,
      errorClass: Date.now() >= Number(revision && new Date(revision).getTime()) + IDLE_WINDOW_MS - STORAGE_CUTOFF
        ? 'extraction_deadline' : 'extraction_failed' });
  });
  const scheduled = new Map<string, { revision: string; timer: ReturnType<typeof setTimeout>; done: boolean; running: boolean; retryAt: number; deadline: number; recording: Promise<boolean> }>();
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
      for (const row of result.rows) {
        if (row.retired_at) { void retire(row.session_id); continue; }
        // Preserve PostgreSQL microseconds; JS Date would silently round them.
        const revision = row.activity_revision as string;
        const old = scheduled.get(row.session_id);
        const remaining = Number(row.remaining_ms);
        if (old && old.revision !== revision) { clearTimeout(old.timer); scheduled.delete(row.session_id); }
        if (remaining > PREPARE_MS) { scheduled.delete(row.session_id); continue; }
        // The timer is installed FIRST. Even a never-settling extractor cannot
        // prevent deadline deletion. SQL rechecks activity under the writer lock.
        let entry = scheduled.get(row.session_id);
        if (!entry) {
          const timer = setTimeout(() => { scheduled.delete(row.session_id); void retire(row.session_id); }, Math.max(0, Math.ceil(remaining)));
          const errorClass = remaining + RETIREMENT_LEAD <= STORAGE_CUTOFF ? 'extraction_deadline' : 'extraction_failed';
          entry = { revision, timer, done: false, running: false, retryAt: 0, deadline: Date.now() + remaining,
            recording: record(row.session_id, revision, errorClass) };
          scheduled.set(row.session_id, entry);
        }
        if (remaining <= 0 || entry.done || entry.running || Date.now() < entry.retryAt) continue;
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
          let persistenceFailure: MeasurePersistenceError | undefined;
          const budget = Math.max(1, Math.min(5_000, remaining - Math.min(500, remaining / 2)));
          const ok = extract ? await boundedAttempt(async () => {
            try {
              const overridden = extract(row.session_id, revision);
              if (overridden) return await overridden;
              if (!await isolated('extract', row.session_id, revision, budget)) throw new Error('Extraction failed');
            }
            catch (error) { if (error instanceof MeasurePersistenceError) persistenceFailure = error; throw error; }
          }, budget) : await isolated('extract', row.session_id, revision, budget, undefined,
            source => { persistenceFailure = new MeasurePersistenceError(source); });
          if (ok) attempt.done = true;
          else if (!stopped && persistenceFailure && scheduled.get(row.session_id) === attempt)
            await record(row.session_id, revision, 'extraction_failed', persistenceFailure.resolutionProvenance);
          attempt.running = false;
          attempt.retryAt = Date.now() + 100;
        })();
      }
      if (Date.now() >= nextReport) {
        const counts = await readRetentionCounts(deletionPool);
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
    for (const job of jobs) job.kill('SIGKILL');
    const deletionDrained = deletionPool.end();
    // Drain queued failure writes, including those outliving the deadline.
    return Promise.all([deletionDrained, Promise.all([...recordings]).then(() => recordingPool.end())]).then(() => {});
  };
}

if (process.send) {
  process.once('message', async (message: {kind: string; id: string; revision: string; errorClass: 'extraction_failed' | 'extraction_deadline'; resolution?: MeasurePersistenceError['resolutionProvenance']}) => {
    try {
      if (message.kind === 'extract') await extractAndStoreSessionMeasures(message.id, message.revision);
      else await recordUnextractedSession(message.id, message.errorClass, message.resolution, message.revision);
      process.send?.('ok');
    } catch (error) {
      process.send?.({ resolution: error instanceof MeasurePersistenceError ? error.resolutionProvenance : undefined });
    }
    finally { await dbPool.end(); }
  });
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startRetentionWorker().then(stop => {
    const shutdown = () => { stop(); void dbPool.end(); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }).catch(() => { safeLog('error', safeValue('{"event":"retention_worker_start_failed"}')); process.exitCode = 1; });
}
