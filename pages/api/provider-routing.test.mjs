import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import 'dotenv/config';

const { createChatHandler } = await import('./chat.ts');
const { createUploadHandler } = await import('./upload.ts');
const { closeDb } = await import('../../lib/db/client.ts');

after(closeDb);

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

test('chat rejects a request-body provider field', async () => {
  const response = responseRecorder();
  await createChatHandler()({
    method: 'POST',
    body: {
      message: 'Synthetic question',
      conversationId: 'conversation_synthetic',
      sessionId: 'session_synthetic',
      messageIndex: 1,
      providerId: 'alternate',
    },
  }, response);
  assert.equal(response.statusCode, 400);
});

test('toggle-off chat rejects alternate before provider resolution', async () => {
  let resolverCalls = 0;
  let appendCalls = 0;
  const response = responseRecorder();
  const handler = createChatHandler({
    async getConversationSessionId() { return 'session_synthetic'; },
    async getConversationProviderId() { return 'alternate'; },
    resolveProviderSettings() {
      resolverCalls += 1;
      throw new Error('alternate resolver must not run');
    },
    enableModelToggle: false,
    async appendConversationMessages() { appendCalls += 1; },
  });

  await handler({
    method: 'POST',
    body: {
      message: 'Synthetic question',
      conversationId: 'conversation_synthetic',
      sessionId: 'session_synthetic',
      messageIndex: 1,
    },
  }, response);

  assert.equal(response.statusCode, 403);
  assert.equal(resolverCalls, 0);
  assert.equal(appendCalls, 0);
});

test('toggle-off upload rejects alternate before provider resolution or conversation creation', async () => {
  let resolverCalls = 0;
  let createCalls = 0;
  const response = responseRecorder();
  const handler = createUploadHandler({
    async parseForm() {
      return {
        fields: { sessionId: 'session_synthetic', providerId: 'alternate' },
        files: { file: { filepath: '/not-read', originalFilename: 'synthetic.json', size: 1 } },
      };
    },
    enableModelToggle: false,
    resolveProviderSettings() {
      resolverCalls += 1;
      throw new Error('alternate resolver must not run');
    },
    async createConversation() {
      createCalls += 1;
      return { id: 'must_not_be_created' };
    },
  });

  await handler({ method: 'POST' }, response);

  assert.equal(response.statusCode, 403);
  assert.equal(resolverCalls, 0);
  assert.equal(createCalls, 0);
});
