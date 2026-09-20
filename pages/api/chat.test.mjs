import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import 'dotenv/config';

const { createChatHandler } = await import('./chat.ts');
const { closeDb } = await import('../../lib/db/client.ts');

after(async () => {
  await closeDb();
});

function responseRecorder() {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
  };
}

async function captureConsole(action) {
  const methods = ['log', 'error', 'warn', 'info', 'debug'];
  const originals = new Map(methods.map(method => [method, console[method]]));
  const output = [];
  for (const method of methods) console[method] = (...args) => output.push(args);
  try {
    await action();
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }
  return output;
}

test('chat ignores a legacy email field and persists no participant identifier (no Postgres)', async () => {
  const legacyEmail = 'participant@example.invalid';
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const conversationId = 'conversation_legacy_client';
  let writtenRow;
  const handler = createChatHandler({
    async getConversationSessionId() {
      return sessionId;
    },
    async getConversationProviderId() {
      return 'primary';
    },
    resolveProviderSettings() {
      return { PROFILE: 'local' };
    },
    async insertLog(row) {
      writtenRow = row;
      return row;
    },
    async appendConversationMessages() {
      return [];
    },
  });
  const response = responseRecorder();

  const output = await captureConsole(() => handler({
    method: 'POST',
    body: {
      message: 'Synthetic question',
      conversationId,
      sessionId,
      messageIndex: 1,
      userEmail: legacyEmail,
    },
  }, response));

  assert.equal(response.statusCode, 200);
  assert.equal(writtenRow.user_email, null);
  assert.equal(output.flat().some(value => String(value).includes(legacyEmail)), false);
});
