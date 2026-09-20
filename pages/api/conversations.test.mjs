import assert from 'node:assert/strict';
import test from 'node:test';

import 'dotenv/config';

import {
  ConversationCopySessionMismatchError,
} from '../../lib/db/conversations.ts';
import { createConversationsHandler } from './conversations.ts';
import { createChatHandler } from './chat.ts';
import { createStreamHandler } from './stream.ts';

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('conversation creation binds a fixed provider and copy source', async () => {
  let received;
  const handler = createConversationsHandler({
    enableModelToggle: true,
    isProviderId: value => value === 'primary' || value === 'alternate',
    resolveProviderSettings: () => ({}),
    async createConversation(...args) {
      received = args;
      return { id: 'destination-conversation' };
    },
  });
  const response = responseRecorder();
  await handler({ method: 'POST', body: {
    sessionId: 'session-one',
    providerId: 'alternate',
    copyFromConversationId: 'source-conversation',
  } }, response);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(received, ['session-one', 'alternate', 'source-conversation']);
  assert.deepEqual(response.body, { conversationId: 'destination-conversation' });
});

test('copy-forward across sessions is refused', async () => {
  const handler = createConversationsHandler({
    enableModelToggle: true,
    isProviderId: () => true,
    resolveProviderSettings: () => ({}),
    async createConversation() { throw new ConversationCopySessionMismatchError(); },
  });
  const response = responseRecorder();
  await handler({ method: 'POST', body: {
    sessionId: 'other-session', providerId: 'primary', copyFromConversationId: 'source',
  } }, response);
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { error: 'Source conversation does not belong to this session' });
});

test('conversation creation rejects arbitrary provider strings', async () => {
  const handler = createConversationsHandler({ enableModelToggle: true });
  const response = responseRecorder();
  await handler({ method: 'POST', body: { sessionId: 'session', providerId: 'arbitrary' } }, response);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'Unknown model provider' });
});

test('chat and stream still reject provider fields outside conversation creation', async () => {
  const chatResponse = responseRecorder();
  await createChatHandler()({
    method: 'POST',
    body: { providerId: 'alternate' },
  }, chatResponse);
  assert.equal(chatResponse.statusCode, 400);

  const streamResponse = responseRecorder();
  await createStreamHandler()({
    method: 'GET',
    body: { provider: 'alternate' },
    query: {},
  }, streamResponse);
  assert.equal(streamResponse.statusCode, 400);
  assert.deepEqual(chatResponse.body, streamResponse.body);
  assert.deepEqual(chatResponse.body, {
    error: 'Provider may only be selected when creating a conversation',
  });
});
