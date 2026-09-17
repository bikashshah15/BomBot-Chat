import type { PoolClient } from 'pg';
import { config } from '../config.ts';
import { dbPool } from './client.ts';
import { idleDeadlineSQL } from './retentionStatus.ts';

export class SessionRetentionStateError extends Error {
  constructor() {
    super('Session retention history is unknown or conflicting; use a new session');
    this.name = 'SessionRetentionStateError';
  }
}

/** Lock the session rule before creating/reading its key or saving content.
 * Content triggers update the authoritative clock in this same transaction.
 * The deletion worker must take this same row lock before retiring a session.
 */
export async function withSessionContentWrite<T>(sessionId: string,
  save: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT retention_mode FROM session_retention_rules WHERE session_id=$1 FOR UPDATE', [sessionId]);
    if (existing.rowCount === 0) {
      const history = await client.query('SELECT DISTINCT retention_mode FROM conversations WHERE session_id=$1', [sessionId]);
      if (history.rows.length > 1 || history.rows.some(row => !['study', 'ephemeral'].includes(row.retention_mode))) {
        throw new SessionRetentionStateError();
      }
      if (history.rows.length === 0) {
        const legacy = await client.query('SELECT 1 FROM chat_logs WHERE session_id=$1 LIMIT 1', [sessionId]);
        if (legacy.rowCount) throw new SessionRetentionStateError();
      }
      // A recorded conversation is evidence. Current config is used only for a
      // genuinely new session, never to manufacture the policy of old content.
      await client.query(`INSERT INTO session_retention_rules(session_id,retention_mode) VALUES($1,$2)
        ON CONFLICT(session_id) DO UPDATE SET retention_mode=session_retention_rules.retention_mode`,
      [sessionId, history.rows[0]?.retention_mode ?? config.RETENTION]);
    }
    const state = await client.query(`SELECT retired_at, retention_mode='ephemeral'
      AND ${idleDeadlineSQL()} <= clock_timestamp() AS expired
      FROM session_retention_rules WHERE session_id=$1 FOR UPDATE`, [sessionId]);
    if (state.rows[0]?.retired_at || state.rows[0]?.expired) throw new SessionRetentionStateError();
    const result = await save(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
