import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import 'dotenv/config';

const previousSessionKeyDirectory = process.env.SESSION_KEY_DIRECTORY;
const sessionKeyDirectory = await mkdtemp(path.join(os.tmpdir(), 'bombot-chat-log-keys-'));
process.env.SESSION_KEY_DIRECTORY = sessionKeyDirectory;

after(async () => {
  if (previousSessionKeyDirectory === undefined) delete process.env.SESSION_KEY_DIRECTORY;
  else process.env.SESSION_KEY_DIRECTORY = previousSessionKeyDirectory;
  await rm(sessionKeyDirectory, { recursive: true, force: true });
});

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
  const { sessionKeyVault } = await import('../crypto/sessionKeyStore.ts');
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

      const storedRows = await dbPool.query(
        `SELECT user_message, user_message_ciphertext, user_message_nonce, user_message_auth_tag,
          ai_response, ai_response_ciphertext, ai_response_nonce, ai_response_auth_tag,
          user_email, user_email_ciphertext, user_email_nonce, user_email_auth_tag
        FROM chat_logs
        WHERE session_id = $1
        ORDER BY message_index`,
        [sessionId],
      );
      assert.equal(storedRows.rows.every(row => row.user_message === null), true);
      assert.equal(storedRows.rows.every(row => Buffer.isBuffer(row.user_message_ciphertext)), true);
      assert.equal(storedRows.rows.every(row => Buffer.isBuffer(row.user_message_nonce)), true);
      assert.equal(storedRows.rows.every(row => Buffer.isBuffer(row.user_message_auth_tag)), true);
      assert.equal(storedRows.rows[0].ai_response, null);
      assert.equal(Buffer.isBuffer(storedRows.rows[0].ai_response_ciphertext), true);
      assert.equal(storedRows.rows[1].user_email, null);
      assert.equal(Buffer.isBuffer(storedRows.rows[1].user_email_ciphertext), true);
    } finally {
      await dbPool.query('DELETE FROM chat_logs WHERE session_id = $1', [sessionId]);
      await sessionKeyVault.destroy(sessionId);
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
