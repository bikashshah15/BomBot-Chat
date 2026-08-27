import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import 'dotenv/config';

const UNREACHABLE_DATABASE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPERM',
  'ETIMEDOUT',
]);

function isDatabaseUnreachable(error) {
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every(isDatabaseUnreachable);
  }

  return Boolean(
    error
    && typeof error === 'object'
    && UNREACHABLE_DATABASE_CODES.has(error.code),
  );
}

test('chat log round trip survives insert, AI update, and history read', async (context) => {
  if (!process.env.DATABASE_URL) {
    context.skip('DATABASE_URL is not configured; skipping Postgres round-trip test');
    return;
  }

  const { dbPool, closeDb } = await import('./client.ts');
  const { getSessionHistory, insertLog, updateAiResponse } = await import('./chatLogs.ts');

  try {
    try {
      await dbPool.query('SELECT 1');
    } catch (error) {
      if (isDatabaseUnreachable(error)) {
        context.skip('DATABASE_URL is configured but Postgres is unreachable; skipping round-trip test');
        return;
      }
      throw error;
    }

    const sessionId = `round-trip-${randomUUID()}`;
    const conversationId = `conversation-${randomUUID()}`;
    const now = new Date().toISOString();

    try {
      await insertLog({
        id: randomUUID(),
        session_id: sessionId,
        conversation_id: conversationId,
        message_index: 1,
        message_type: 'user',
        user_message: 'Synthetic round-trip question',
        ai_response: null,
        file_name: null,
        file_size: null,
        vulnerability_count: null,
        user_email: null,
        created_at: now,
        updated_at: now,
      });

      await insertLog({
        id: randomUUID(),
        session_id: sessionId,
        conversation_id: conversationId,
        message_index: 2,
        message_type: 'file_upload',
        user_message: 'Uploaded SBOM file: synthetic.json',
        ai_response: null,
        file_name: 'synthetic.json',
        file_size: 1_234,
        vulnerability_count: 7,
        user_email: 'participant@example.invalid',
        created_at: now,
        updated_at: now,
      });

      const updatedRows = await updateAiResponse(
        sessionId,
        1,
        'Synthetic round-trip answer',
      );
      assert.equal(updatedRows.length, 1);

      const history = await getSessionHistory(sessionId);
      assert.equal(history.length, 2);
      assert.equal(history[0].conversation_id, conversationId);
      assert.equal(history[0].user_message, 'Synthetic round-trip question');
      assert.equal(history[0].ai_response, 'Synthetic round-trip answer');
      assert.equal(history[0].user_email, null);
      assert.equal(history[1].message_type, 'file_upload');
      assert.equal(history[1].file_name, 'synthetic.json');
      assert.equal(history[1].file_size, 1_234);
      assert.equal(history[1].vulnerability_count, 7);
    } finally {
      await dbPool.query('DELETE FROM chat_logs WHERE session_id = $1', [sessionId]);
    }
  } finally {
    await closeDb();
  }
});

test('pseudonymous participant IDs are deterministic and do not retain the raw email', async () => {
  const { pseudonymizeParticipantId } = await import('./chatLogs.ts');
  const rawEmail = 'Participant@Example.Invalid';
  const salt = 'synthetic-participant-salt-32chars';

  const first = pseudonymizeParticipantId(rawEmail, salt);
  const second = pseudonymizeParticipantId(rawEmail.toLowerCase(), salt);

  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.equal(first.includes(rawEmail), false);
});
