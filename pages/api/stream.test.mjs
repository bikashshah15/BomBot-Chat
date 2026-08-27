import assert from 'node:assert/strict';
import test from 'node:test';

import 'dotenv/config';

const {
  createStreamHandler,
  runAssistantTurn,
} = await import('./stream.ts');
const {
  ConversationSequenceConflictError,
} = await import('../../lib/db/conversations.ts');

function responseRecorder() {
  return {
    statusCode: 200,
    headers: new Map(),
    body: '',
    jsonBody: undefined,
    ended: false,
    setHeader(name, value) {
      this.headers.set(name, value);
    },
    flushHeaders() {},
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
    write(chunk) {
      this.body += chunk;
      return true;
    },
    end() {
      this.ended = true;
    },
  };
}

function streamRequest(overrides = {}) {
  return {
    method: 'GET',
    query: {
      conversationId: 'conversation_synthetic',
      sessionId: 'session_synthetic',
      ...overrides,
    },
  };
}

test('stream rejects a cross-session capability before sending SSE headers', async () => {
  const handler = createStreamHandler({
    async getConversationSessionId() {
      return 'session_owner';
    },
    async runTurn() {
      throw new Error('runTurn must not run for a rejected capability');
    },
  });
  const response = responseRecorder();

  await handler(streamRequest({ sessionId: 'session_other' }), response);

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.jsonBody, {
    error: 'Conversation does not belong to this session',
  });
  assert.equal(response.headers.has('Content-Type'), false);
});

test('a simulated 60-second generation receives four 15-second heartbeats and completes', async () => {
  let heartbeatInterval;
  let intervalCleared = false;
  const handler = createStreamHandler({
    async getConversationSessionId() {
      return 'session_synthetic';
    },
    async runTurn(_options, emit) {
      emit('delta', { delta: 'buffered response' });
      emit('done', { response: 'buffered response', status: 'completed' });
    },
    setInterval(callback, interval) {
      heartbeatInterval = interval;
      for (let elapsed = interval; elapsed <= 60_000; elapsed += interval) callback();
      return 1;
    },
    clearInterval() {
      intervalCleared = true;
    },
  });
  const response = responseRecorder();

  await handler(streamRequest(), response);

  assert.equal(heartbeatInterval, 15_000);
  assert.equal(response.body.match(/: heartbeat/g)?.length, 4);
  assert.match(response.body, /event: delta/);
  assert.match(response.body, /event: done/);
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Connection'), 'keep-alive');
  assert.equal(intervalCleared, true);
  assert.equal(response.ended, true);
});

test('tool continuation emits round events and returns the final streamed response', async () => {
  const calls = [];
  const events = [];
  const responses = [{
    content: '',
    toolCalls: [{
      id: 'call_synthetic',
      name: 'query_package_vulnerabilities',
      arguments: '{"name":"synthetic","ecosystem":"npm"}',
    }],
    done: true,
    responseId: 'response_initial',
    status: 'completed',
  }, {
    content: 'final streamed response',
    toolCalls: [],
    done: true,
    responseId: 'response_successor',
    status: 'completed',
  }];

  await runAssistantTurn(
    { conversationId: 'conversation_synthetic', sessionId: 'session_synthetic' },
    (event, data) => events.push({ event, data }),
    {
      async loadHistory() {
        return {
          rows: [{ role: 'user', tool_calls: null }],
          messages: [{ role: 'user', content: 'synthetic turn' }],
          nextSeq: 2,
        };
      },
      async streamMessages(options) {
        calls.push(options);
        await options.onChunk?.({ delta: responses.length === 2 ? 'discarded' : 'final streamed response', done: false });
        return responses.shift();
      },
      async executeTool() {
        return '{"vulns":[]}';
      },
      async updateAiResponse() {
        return [];
      },
    },
  );

  assert.deepEqual(events.map(event => event.event), [
    'delta',
    'tool_start',
    'delta',
    'tool_end',
    'done',
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].continuation, {
    round: 1,
    predecessorResponseId: 'response_initial',
    idempotencyKey: 'bombot-tool-successor-response_initial',
  });
  assert.equal(events.at(-1).data.response, 'final streamed response');
});

test('tool continuation remains bounded by MAX_FUNCTION_CALL_ROUNDS', async () => {
  let streamedResponses = 0;
  let executedTools = 0;

  await assert.rejects(
    runAssistantTurn(
      { conversationId: 'conversation_synthetic', sessionId: 'session_synthetic' },
      () => {},
      {
        async loadHistory() {
          return {
            rows: [{ role: 'user', tool_calls: null }],
            messages: [{ role: 'user', content: 'synthetic turn' }],
            nextSeq: 2,
          };
        },
        async streamMessages() {
          streamedResponses += 1;
          return {
            content: '',
            toolCalls: [{
              id: `call_${streamedResponses}`,
              name: 'query_package_vulnerabilities',
              arguments: '{"name":"synthetic","ecosystem":"npm"}',
            }],
            done: true,
            responseId: `response_${streamedResponses}`,
            status: 'completed',
          };
        },
        async executeTool() {
          executedTools += 1;
          return '{"vulns":[]}';
        },
        async updateAiResponse() {
          return [];
        },
      },
    ),
    /Function calling exceeded the maximum of 8 consecutive rounds/,
  );

  assert.equal(streamedResponses, 9);
  assert.equal(executedTools, 8);
});

test('a sequence conflict after SSE headers is emitted as an error event', async () => {
  const handler = createStreamHandler({
    async getConversationSessionId() {
      return 'session_synthetic';
    },
    async runTurn() {
      throw new ConversationSequenceConflictError('conversation_synthetic', 2);
    },
  });
  const response = responseRecorder();

  await handler(streamRequest(), response);

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /event: error/);
  assert.match(response.body, /conversation_sequence_conflict/);
  assert.equal(response.ended, true);
});

test('failed terminal responses retain their status and error detail', async () => {
  const events = [];

  await runAssistantTurn(
    { conversationId: 'conversation_synthetic', sessionId: 'session_synthetic' },
    (event, data) => events.push({ event, data }),
    {
      async loadHistory() {
        return {
          rows: [{ role: 'user', tool_calls: null }],
          messages: [{ role: 'user', content: 'synthetic turn' }],
          nextSeq: 2,
        };
      },
      async streamMessages() {
        return {
          content: '',
          toolCalls: [],
          done: true,
          responseId: 'response_failed',
          status: 'failed',
          error: { message: 'Synthetic terminal failure' },
        };
      },
      async executeTool() {
        throw new Error('No tool should execute');
      },
      async updateAiResponse() {
        return [];
      },
    },
  );

  assert.deepEqual(events, [{
    event: 'error',
    data: {
      error: 'Synthetic terminal failure',
      responseStatus: 'failed',
      toolCallsProcessed: 0,
    },
  }]);
});
