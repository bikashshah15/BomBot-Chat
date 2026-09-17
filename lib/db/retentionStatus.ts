import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { config } from '../config.ts';

export const RETIREMENT_LEAD = 5_000;
export const STORAGE_CUTOFF = 10_000;
export function retentionWindowMilliseconds(hours: number): number {
  const window = Math.round(hours * 60 * 60 * 1000);
  if (!Number.isFinite(window) || !(window > STORAGE_CUTOFF && STORAGE_CUTOFF > RETIREMENT_LEAD)) {
    throw new RangeError('Invalid retention window ordering');
  }
  return window;
}
export const IDLE_WINDOW_MS = retentionWindowMilliseconds(config.RETENTION_IDLE_HOURS);
export const IDLE_WINDOW_SQL = `INTERVAL '${IDLE_WINDOW_MS} milliseconds'`;
export const idleDeadlineSQL = (column = 'last_activity_at') => `(${column} + ${IDLE_WINDOW_SQL})`;
// Shared by scheduling, sweeping and the locked retirement recheck.
export const RETIREMENT_CUTOFF_SQL = `(${idleDeadlineSQL()} - INTERVAL '${RETIREMENT_LEAD} milliseconds')`;

export interface RetentionCounts {
  unextracted_count: number;
  overdue_deletion_count: number;
  unknown_clock_count: number;
  missing_measure_count: number;
}

/** Content presence, not an empty conversation, establishes an unknown clock.
 * SELECT only: this command is not a second measure writer.
 */
export async function readRetentionCounts(client: Pick<pg.Pool, 'query'>): Promise<RetentionCounts> {
  const result = await client.query(`WITH content_sessions AS (
    SELECT c.session_id FROM conversations c JOIN conversation_messages m ON m.conversation_id=c.id
    UNION SELECT session_id FROM chat_logs
  ), ephemeral_sessions AS (
    SELECT session_id FROM session_retention_rules WHERE retention_mode='ephemeral'
    UNION SELECT c.session_id FROM conversations c WHERE c.retention_mode='ephemeral'
      AND NOT EXISTS (SELECT 1 FROM session_retention_rules r WHERE r.session_id=c.session_id)
  ) SELECT
    (SELECT count(*)::int FROM session_retention_rules r WHERE r.retention_mode='ephemeral'
      AND (r.retired_at IS NOT NULL OR r.purged_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM session_measures m WHERE m.session_id=r.session_id)) AS missing_measure_count,
    (SELECT count(*)::int FROM session_measures WHERE result->>'status'='unextracted') AS unextracted_count,
    (SELECT count(*)::int FROM content_sessions c JOIN session_retention_rules r USING(session_id)
      WHERE r.retention_mode='ephemeral' AND ${idleDeadlineSQL('r.last_activity_at')} <= clock_timestamp()
    ) AS overdue_deletion_count,
    (SELECT count(*)::int FROM content_sessions c JOIN ephemeral_sessions e USING(session_id)
      LEFT JOIN session_retention_rules r USING(session_id)
      WHERE r.last_activity_at IS NULL) AS unknown_clock_count`);
  return result.rows[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2_000 });
  try {
    if (!process.env.DATABASE_URL) throw new Error('Unavailable');
    const counts = await readRetentionCounts(pool);
    console.log(JSON.stringify({ ...counts, idle_window_ms: IDLE_WINDOW_MS }));
    process.exitCode = counts.overdue_deletion_count > 0 || counts.missing_measure_count > 0 ? 1 : 0;
  } catch {
    // No fabricated zero counts, database errors, or participant-shaped output.
    process.exitCode = 2;
  } finally { await pool.end(); }
}
