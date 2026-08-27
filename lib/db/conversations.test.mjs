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

test('conversation history round-trips in order without duplicating a sequence', async (context) => {
  if (!process.env.DATABASE_URL) {
    context.skip('DATABASE_URL is not configured; skipping Postgres round-trip test');
    return;
  }

  const { dbPool, closeDb } = await import('./client.ts');
  const {
    appendConversationMessage,
    createConversation,
    getConversationMessages,
    getConversationSessionId,
  } = await import('./conversations.ts');

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

    const sessionId = `conversation-round-trip-${randomUUID()}`;
    const conversation = await createConversation(sessionId);
    const toolCalls = [{
      id: 'synthetic-tool-call',
      name: 'query_osv',
      arguments: '{"package":"synthetic"}',
    }];

    try {
      assert.equal(conversation.session_id, sessionId);
      assert.equal(conversation.retention_mode, 'standard');
      assert.equal(await getConversationSessionId(conversation.id), sessionId);

      await appendConversationMessage({
        conversation_id: conversation.id,
        seq: 2,
        role: 'assistant',
        content: '',
        tool_call_id: null,
        tool_calls: toolCalls,
      });
      await appendConversationMessage({
        conversation_id: conversation.id,
        seq: 1,
        role: 'user',
        content: 'Synthetic conversation question',
        tool_call_id: null,
        tool_calls: null,
      });

      const duplicate = await appendConversationMessage({
        conversation_id: conversation.id,
        seq: 1,
        role: 'user',
        content: 'Duplicate content must not be inserted',
        tool_call_id: null,
        tool_calls: null,
      });
      assert.equal(duplicate, null);

      const messages = await getConversationMessages(conversation.id, 20);
      assert.deepEqual(messages.map(message => message.seq), [1, 2]);
      assert.equal(messages[0].content, 'Synthetic conversation question');
      assert.deepEqual(messages[1].tool_calls, toolCalls);
    } finally {
      await dbPool.query('DELETE FROM conversations WHERE id = $1', [conversation.id]);
    }
  } finally {
    await closeDb();
  }
});
