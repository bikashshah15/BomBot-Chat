import { config } from '../config.ts';
import { extractSessionMeasures } from '../measures/extract.ts';
import type { MeasureMessage, SessionMeasure } from '../measures/extract.ts';
import { dbPool } from './client.ts';
import { decryptStoredContent } from './encryptedContent.ts';

/** No request-path caller. Read all history, not the model's replay window.
 * A repeatable-read transaction binds reference, local corpus and result write.
 * Database/decryption failures propagate: a future caller must NOT shred on failure.
 */
export async function extractAndStoreSessionMeasures(sessionId: string): Promise<SessionMeasure> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const measure = await extractSessionMeasures(sessionId, {
      async readMessages() {
        const result = await client.query(`SELECT m.* FROM conversation_messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE c.session_id = $1 ORDER BY c.created_at, c.id, m.seq`, [sessionId]);
        const messages: MeasureMessage[] = [];
        for (const row of result.rows) {
          if (row.role !== 'assistant' && !(row.role === 'user' && row.pinned)) continue;
          messages.push({ role: row.role, pinned: row.pinned,
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
        await client.query(`INSERT INTO session_measures (session_id, result)
          VALUES ($1, $2::jsonb)
          ON CONFLICT (session_id) DO UPDATE SET result = EXCLUDED.result, extracted_at = NOW()`,
        [id, JSON.stringify(measure)]);
      },
    });
    await client.query('COMMIT');
    return measure;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
