import { config } from '../config.ts';
import { extractSessionMeasures } from '../measures/extract.ts';
import type { MeasureMessage, SessionMeasure } from '../measures/extract.ts';
import { dbPool } from './client.ts';
import { decryptStoredContent } from './encryptedContent.ts';
import { REFERENCE_DEFINITION } from '../measures/extract.ts';
import { readCapturedScanSource } from '../context/scanProvenance.ts';
import type { PoolClient, Pool } from 'pg';
import { STORAGE_CUTOFF, idleDeadlineSQL } from './retentionStatus.ts';

export class MeasurePersistenceError extends Error {
  readonly resolutionProvenance: SessionMeasure['resolution_provenance'];
  constructor(source: SessionMeasure['resolution_provenance']) {
    super('Measure persistence failed');
    this.name = 'MeasurePersistenceError';
    this.resolutionProvenance = source;
  }
}

// The sole result writer serves both extraction and bounded failure records.
async function writeResult(client: PoolClient, id: string, result: unknown, activity?: string) {
  const stored = await client.query(`INSERT INTO session_measures (session_id, result)
    SELECT $1::varchar, $2::jsonb WHERE ($3::timestamptz IS NULL OR EXISTS (
      SELECT 1 FROM session_retention_rules WHERE session_id=$1::varchar AND last_activity_at=$3::timestamptz))
    AND ($2::jsonb->>'status'='unextracted' OR NOT EXISTS (
      SELECT 1 FROM session_retention_rules WHERE session_id=$1::varchar AND retired_at IS NOT NULL))
    AND ($2::jsonb->>'status'='unextracted' OR NOT EXISTS (
      SELECT 1 FROM session_retention_rules WHERE session_id=$1::varchar AND retention_mode='ephemeral'
      AND (last_activity_at IS NULL OR clock_timestamp() >= ${idleDeadlineSQL()}
        - INTERVAL '${STORAGE_CUTOFF} milliseconds')))
    ON CONFLICT (session_id) DO UPDATE SET result = EXCLUDED.result, extracted_at = NOW()
    WHERE session_measures.result->>'status' IS DISTINCT FROM 'unextracted' OR NOT EXISTS (
      SELECT 1 FROM session_retention_rules WHERE session_id=$1::varchar AND retired_at IS NOT NULL)`,
  [id, JSON.stringify(result), activity ?? null]);
  return Boolean(stored.rowCount);
}

export async function recordUnextractedSession(sessionId: string, errorClass: 'extraction_failed' | 'extraction_deadline',
  resolution?: SessionMeasure['resolution_provenance'], activity?: string, pool: Pool = dbPool): Promise<boolean> {
  if (!['extraction_failed', 'extraction_deadline'].includes(errorClass)) throw new Error('Invalid measurement error class');
  const client = await pool.connect();
  try {
    const sources = await client.query(`SELECT m.scan_source FROM conversation_messages m
      JOIN conversations c ON c.id=m.conversation_id WHERE c.session_id=$1 AND m.pinned AND m.role='user'`, [sessionId]);
    const scan_provenance = sources.rows.map(row => readCapturedScanSource(row.scan_source) ?? {
      osv_mode: 'unknown', snapshot_date: 'unknown', scan_truncated: 'unknown', scanned_package_count: 'unknown',
    });
    if (!scan_provenance.length) scan_provenance.push({ osv_mode: 'unknown', snapshot_date: 'unknown',
      scan_truncated: 'unknown', scanned_package_count: 'unknown' });
    const resolution_provenance = resolution?.osv_mode === 'offline'
      && /^(?:unknown|\d{4}-\d{2}-\d{2})$/u.test(resolution.snapshot_date)
      && ['available','missing_snapshot','pin_mismatch'].includes(resolution.status)
      ? { osv_mode: 'offline', snapshot_date: resolution.snapshot_date, status: resolution.status }
      : { osv_mode: 'unknown', snapshot_date: 'unknown', status: 'unavailable' };
    return await writeResult(client, sessionId, {
      status: 'unextracted', recorded_at: new Date().toISOString(), error_class: errorClass,
      reference_definition: REFERENCE_DEFINITION, scan_provenance,
      // A failed attempt cannot establish which alias resolution actually completed.
      resolution_provenance,
    }, activity);
  } finally { client.release(); }
}

/** No request-path caller. Read all history, not the model's replay window.
 * A repeatable-read transaction binds reference and local corpus; a fresh
 * activity-token check guards storage without locking the retirement row.
 * Failures propagate to the worker, which records them without extending deletion.
 */
export async function extractAndStoreSessionMeasures(sessionId: string, activity?: string): Promise<SessionMeasure> {
  const client = await dbPool.connect();
  let completedResolution: SessionMeasure['resolution_provenance'];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout='4s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='1s'");
    const measure = await extractSessionMeasures(sessionId, {
      async readMessages() {
        const result = await client.query(`SELECT m.* FROM conversation_messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE c.session_id = $1 ORDER BY c.created_at, c.id, m.seq`, [sessionId]);
        const messages: MeasureMessage[] = [];
        for (const row of result.rows) {
          if (row.role !== 'assistant' && !(row.role === 'user' && row.pinned)) continue;
          messages.push({ role: row.role, pinned: row.pinned, scan_source: row.scan_source,
            content: await decryptStoredContent(sessionId, {
              plaintext: row.content, ciphertext: row.content_ciphertext,
              nonce: row.content_nonce, authTag: row.content_auth_tag,
            }, false) as string });
        }
        return messages;
      },
      async resolveLocally(identifiers) {
        const snapshot = await client.query(`SELECT snapshot_date::text AS date
          FROM osv_snapshots ORDER BY ingested_at DESC, snapshot_date DESC LIMIT 1`);
        const date = snapshot.rows[0]?.date ?? 'unknown';
        const status = date === 'unknown' ? 'missing_snapshot'
          : config.OSV_SNAPSHOT_DATE && date !== config.OSV_SNAPSHOT_DATE ? 'pin_mismatch' : 'available';
        const primaryByIdentifier = new Map<string, string>();
        if (status === 'available' && identifiers.length > 0) {
          // Local SQL only. Case folding and exact-primary preference match the
          // harness. No OSV client, scanner, HTTP or network fallback is imported.
          const result = await client.query(`SELECT requested.identifier, matched.id
            FROM unnest($1::text[]) AS requested(identifier)
            CROSS JOIN LATERAL (
              SELECT id FROM osv_advisories
              WHERE upper(id) = requested.identifier OR EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(COALESCE(aliases, '[]'::jsonb)) alias
                WHERE upper(alias) = requested.identifier)
              ORDER BY (upper(id) = requested.identifier) DESC, id LIMIT 1
            ) matched`, [identifiers]);
          for (const row of result.rows) primaryByIdentifier.set(row.identifier, row.id);
        }
        return { source: { osv_mode: 'offline', snapshot_date: date, status }, primaryByIdentifier };
      },
      async store(id, measure) {
        completedResolution = measure.resolution_provenance;
        // Finish the reference read before checking the activity token against
        // current committed state. Measurement must NEVER lock the retirement
        // row: even a separate pool cannot free a deletion waiting on that lock.
        await client.query('COMMIT');
        await client.query('BEGIN');
        const state = await client.query(`SELECT retention_mode,retired_at,
          ${idleDeadlineSQL()} > clock_timestamp() AS time_remaining
          FROM session_retention_rules WHERE session_id=$1 AND (retention_mode<>'ephemeral'
          OR (retired_at IS NULL AND ${idleDeadlineSQL()}>clock_timestamp()))`, [id]);
        if (activity && !state.rowCount) throw new Error('Measurement reference is no longer current');
        if (!await writeResult(client, id, measure, activity)) throw new Error('Measurement reference is no longer current');
      },
    });
    await client.query('COMMIT');
    return measure;
  } catch (error) {
    await client.query('ROLLBACK');
    if (completedResolution) throw new MeasurePersistenceError(completedResolution);
    throw error;
  } finally {
    client.release();
  }
}
