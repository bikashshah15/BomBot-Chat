import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import 'dotenv/config';

const previousAlternateEnvironment = new Map([
  ['ALT_PROFILE', process.env.ALT_PROFILE],
  ['ALT_LLM_BASE_URL', process.env.ALT_LLM_BASE_URL],
  ['ALT_LLM_MODEL', process.env.ALT_LLM_MODEL],
]);
process.env.ALT_PROFILE = 'local';
process.env.ALT_LLM_BASE_URL = 'http://127.0.0.1:11434/v1';
process.env.ALT_LLM_MODEL = 'synthetic-alternate-model';

const previousSessionKeyDirectory = process.env.SESSION_KEY_DIRECTORY;
const sessionKeyDirectory = await mkdtemp(path.join(os.tmpdir(), 'bombot-conversation-keys-'));
process.env.SESSION_KEY_DIRECTORY = sessionKeyDirectory;

after(async () => {
  for (const [name, value] of previousAlternateEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

test('conversation history round-trips in order without duplicating a sequence', async (context) => {
  if (!process.env.DATABASE_URL) {
    context.skip('DATABASE_URL is not configured; skipping Postgres round-trip test');
    return;
  }

  const { dbPool, closeDb } = await import('./client.ts');
  const { config } = await import('../config.ts');
  const { sessionKeyVault } = await import('../crypto/sessionKeyStore.ts');
  const {
    appendConversationMessage,
    appendConversationMessageOrThrow,
    ConversationSequenceConflictError,
    ConversationCopySessionMismatchError,
    createConversation,
    getConversationMessages,
    getConversationProviderId,
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
    const alternateConversation = await createConversation(`${sessionId}-alternate`, 'alternate');
    let pinnedConversation;
    let copySourceConversation;
    let copiedConversation;
    const toolCalls = [{
      id: 'synthetic-tool-call',
      name: 'query_osv',
      arguments: '{"package":"synthetic"}',
    }, {
      id: 'synthetic-tool-call-2',
      name: 'query_osv',
      arguments: '{"package":"synthetic-two"}',
    }];

    try {
      assert.equal(conversation.session_id, sessionId);
      assert.equal(conversation.retention_mode, config.RETENTION);
      assert.equal(await getConversationSessionId(conversation.id), sessionId);
      assert.equal(await getConversationProviderId(conversation.id), 'primary');
      assert.equal(await getConversationProviderId(alternateConversation.id), 'alternate');

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
      await appendConversationMessage({
        conversation_id: conversation.id,
        seq: 3,
        role: 'tool',
        content: '{"result":"first synthetic tool output"}',
        tool_call_id: 'synthetic-tool-call',
        tool_calls: null,
      });
      await appendConversationMessage({
        conversation_id: conversation.id,
        seq: 4,
        role: 'tool',
        content: '{"result":"second synthetic tool output"}',
        tool_call_id: 'synthetic-tool-call-2',
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
      await assert.rejects(
        appendConversationMessageOrThrow({
          conversation_id: conversation.id,
          seq: 1,
          role: 'user',
          content: 'A live caller must observe this conflict',
          tool_call_id: null,
          tool_calls: null,
        }),
        error => {
          assert.equal(error instanceof ConversationSequenceConflictError, true);
          assert.equal(error.conversationId, conversation.id);
          assert.equal(error.seq, 1);
          return true;
        },
      );

      const messages = await getConversationMessages(conversation.id, 20);
      assert.deepEqual(messages.map(message => message.seq), [1, 2, 3, 4]);
      assert.deepEqual(messages.map(message => message.content), [
        'Synthetic conversation question',
        '',
        '{"result":"first synthetic tool output"}',
        '{"result":"second synthetic tool output"}',
      ]);
      assert.deepEqual(messages[1].tool_calls, toolCalls);

      const storedEncryptedRows = await dbPool.query(
        `SELECT content, content_ciphertext, content_nonce, content_auth_tag
        FROM conversation_messages
        WHERE conversation_id = $1
        ORDER BY seq`,
        [conversation.id],
      );
      assert.equal(storedEncryptedRows.rows.every(row => row.content === null), true);
      assert.equal(storedEncryptedRows.rows.every(row => Buffer.isBuffer(row.content_ciphertext)), true);
      assert.equal(storedEncryptedRows.rows.every(row => Buffer.isBuffer(row.content_nonce)), true);
      assert.equal(storedEncryptedRows.rows.every(row => Buffer.isBuffer(row.content_auth_tag)), true);

      const boundarySnappedMessages = await getConversationMessages(conversation.id, 2);
      assert.deepEqual(boundarySnappedMessages.map(message => message.seq), [2, 3, 4]);
      assert.equal(boundarySnappedMessages[0].role, 'assistant');
      assert.deepEqual(boundarySnappedMessages[0].tool_calls, toolCalls);

      await dbPool.query(
        `INSERT INTO conversation_messages (
          conversation_id, seq, role, content, tool_call_id, tool_calls, pinned
        ) VALUES ($1, 5, 'user', $2, NULL, NULL, FALSE)`,
        [conversation.id, 'Synthetic row predating encryption'],
      );
      await appendConversationMessageOrThrow({
        conversation_id: conversation.id,
        seq: 6,
        role: 'assistant',
        content: 'Synthetic row after encryption',
        tool_call_id: null,
        tool_calls: null,
      });
      const mixedMessages = await getConversationMessages(conversation.id, 20);
      assert.deepEqual(mixedMessages.slice(-2).map(message => message.content), [
        'Synthetic row predating encryption',
        'Synthetic row after encryption',
      ]);

      await dbPool.query(
        `UPDATE conversation_messages
        SET content_auth_tag = decode(repeat('00', 16), 'hex')
        WHERE conversation_id = $1 AND seq = 6`,
        [conversation.id],
      );
      await assert.rejects(
        getConversationMessages(conversation.id, 20),
        error => error.name === 'SessionKeyError'
          && error.message === 'Session content decryption failed',
      );

      pinnedConversation = await createConversation(`${sessionId}-pinned`);
      const pinnedToolCall = [{
        id: 'synthetic-pinned-window-call',
        name: 'query_osv',
        arguments: '{"package":"synthetic-pinned-window"}',
      }];
      for (let seq = 1; seq <= 25; seq += 1) {
        const isPinnedScan = seq === 1;
        const isToolCaller = seq === 5;
        const isToolOutput = seq === 6;
        await appendConversationMessageOrThrow({
          conversation_id: pinnedConversation.id,
          seq,
          role: isPinnedScan
            ? 'user'
            : isToolCaller
              ? 'assistant'
              : isToolOutput
                ? 'tool'
                : seq % 2 === 0 ? 'assistant' : 'user',
          content: isPinnedScan
            ? 'Synthetic authoritative vulnerability scan'
            : `Synthetic history row ${seq}`,
          tool_call_id: isToolOutput ? pinnedToolCall[0].id : null,
          tool_calls: isToolCaller ? pinnedToolCall : null,
          pinned: isPinnedScan,
        });
      }

      const pinnedWindow = await getConversationMessages(pinnedConversation.id, 20);
      assert.deepEqual(pinnedWindow.map(message => message.seq), [1, ...Array.from({ length: 21 }, (_, index) => index + 5)]);
      assert.equal(pinnedWindow[0].content, 'Synthetic authoritative vulnerability scan');
      assert.deepEqual([...pinnedWindow].sort((left, right) => left.seq - right.seq), pinnedWindow);
      assert.equal(pinnedWindow.filter(message => message.pinned).length, 1);
      const pinnedScan = pinnedWindow.find(message => message.pinned);
      assert.equal(pinnedScan?.role, 'user');
      assert.equal(pinnedScan?.tool_call_id, null);
      assert.equal(pinnedScan?.tool_calls, null);
      assert.deepEqual(pinnedWindow.find(message => message.seq === 5)?.tool_calls, pinnedToolCall);
      assert.equal(pinnedWindow.find(message => message.seq === 6)?.tool_call_id, pinnedToolCall[0].id);

      copySourceConversation = await createConversation(`${sessionId}-copy-source`);
      const copySourceRows = [
        { role: 'user', content: 'Pinned SBOM upload context', pinned: true, tool_call_id: null, tool_calls: null },
        { role: 'assistant', content: 'First assistant response', pinned: false, tool_call_id: null, tool_calls: null },
        { role: 'assistant', content: '', pinned: false, tool_call_id: null, tool_calls: pinnedToolCall },
        { role: 'tool', content: 'Tool result', pinned: false, tool_call_id: pinnedToolCall[0].id, tool_calls: null },
        { role: 'user', content: 'Unpinned user question', pinned: false, tool_call_id: null, tool_calls: null },
      ];
      for (const [index, row] of copySourceRows.entries()) {
        await appendConversationMessageOrThrow({
          conversation_id: copySourceConversation.id,
          seq: index + 1,
          ...row,
        });
      }
      copiedConversation = await createConversation(
        `${sessionId}-copy-source`,
        'alternate',
        copySourceConversation.id,
      );
      const copiedMessages = await getConversationMessages(copiedConversation.id, 20);
      assert.deepEqual(copiedMessages.map(message => ({
        seq: message.seq,
        role: message.role,
        content: message.content,
        tool_call_id: message.tool_call_id,
        tool_calls: message.tool_calls,
        pinned: message.pinned,
      })), [{
        seq: 1,
        role: 'user',
        content: 'Pinned SBOM upload context',
        tool_call_id: null,
        tool_calls: null,
        pinned: true,
      }]);

      await assert.rejects(
        createConversation('different-session', 'primary', copySourceConversation.id),
        error => error instanceof ConversationCopySessionMismatchError,
      );
    } finally {
      if (copiedConversation) {
        await dbPool.query('DELETE FROM conversations WHERE id = $1', [copiedConversation.id]);
      }
      if (copySourceConversation) {
        await dbPool.query('DELETE FROM conversations WHERE id = $1', [copySourceConversation.id]);
        await sessionKeyVault.destroy(`${sessionId}-copy-source`);
      }
      if (pinnedConversation) {
        await dbPool.query('DELETE FROM conversations WHERE id = $1', [pinnedConversation.id]);
        await sessionKeyVault.destroy(`${sessionId}-pinned`);
      }
      await dbPool.query('DELETE FROM conversations WHERE id = $1', [conversation.id]);
      await dbPool.query('DELETE FROM conversations WHERE id = $1', [alternateConversation.id]);
      await sessionKeyVault.destroy(sessionId);
    }
  } finally {
    await closeDb();
  }
});
