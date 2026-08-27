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

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('chat, osv-query, and run-status reject a cross-session conversation capability', async (context) => {
  if (!process.env.DATABASE_URL) {
    context.skip('DATABASE_URL is not configured; skipping Postgres binding test');
    return;
  }

  const { dbPool, closeDb } = await import('../lib/db/client.ts');
  const { createConversation } = await import('../lib/db/conversations.ts');

  try {
    try {
      await dbPool.query('SELECT 1');
    } catch (error) {
      if (isDatabaseUnreachable(error)) {
        context.skip('DATABASE_URL is configured but Postgres is unreachable; skipping binding test');
        return;
      }
      throw error;
    }

    const ownerSessionId = `binding-owner-${randomUUID()}`;
    const otherSessionId = `binding-other-${randomUUID()}`;
    const conversation = await createConversation(ownerSessionId);

    try {
      const { default: chatHandler } = await import('../pages/api/chat.ts');
      const { default: osvQueryHandler } = await import('../pages/api/osv-query.ts');
      const { default: runStatusHandler } = await import('../pages/api/run-status.ts');

      const requests = [
        {
          handler: chatHandler,
          request: {
            method: 'POST',
            body: {
              message: 'Synthetic cross-session message',
              conversationId: conversation.id,
              sessionId: otherSessionId,
              messageIndex: 1,
            },
          },
        },
        {
          handler: osvQueryHandler,
          request: {
            method: 'POST',
            body: {
              cve: 'CVE-2024-0001',
              conversationId: conversation.id,
              sessionId: otherSessionId,
            },
          },
        },
        {
          handler: runStatusHandler,
          request: {
            method: 'GET',
            query: {
              conversationId: conversation.id,
              responseId: 'resp_synthetic',
              sessionId: otherSessionId,
            },
          },
        },
      ];

      for (const { handler, request } of requests) {
        const response = responseRecorder();
        await handler(request, response);
        assert.equal(response.statusCode, 403);
        assert.deepEqual(response.body, {
          error: 'Conversation does not belong to this session',
        });
      }
    } finally {
      await dbPool.query('DELETE FROM conversations WHERE id = $1', [conversation.id]);
    }
  } finally {
    await closeDb();
  }
});
