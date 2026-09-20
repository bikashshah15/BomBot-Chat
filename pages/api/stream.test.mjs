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

test('stream rejects a request-body provider field', async () => {
  const handler = createStreamHandler();
  const response = responseRecorder();

  await handler({ ...streamRequest(), body: { provider: 'alternate' } }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.headers.has('Content-Type'), false);
});

test('toggle-off stream constructs no alternate provider or gateway', async () => {
  let resolverCalls = 0;
  let runTurnCalls = 0;
  const handler = createStreamHandler({
    async getConversationSessionId() {
      return 'session_synthetic';
    },
    async getConversationProviderId() {
      return 'alternate';
    },
    resolveProviderSettings() {
      resolverCalls += 1;
      throw new Error('alternate resolver must not run');
    },
    enableModelToggle: false,
    async runTurn() {
      runTurnCalls += 1;
    },
  });
  const response = responseRecorder();

  await handler(streamRequest(), response);

  assert.equal(response.statusCode, 403);
  assert.equal(resolverCalls, 0);
  assert.equal(runTurnCalls, 0);
  assert.equal(response.headers.has('Content-Type'), false);
});

test('a simulated 60-second generation receives four 15-second heartbeats and completes', async () => {
  let heartbeatInterval;
  let intervalCleared = false;
  const handler = createStreamHandler({
    async getConversationSessionId() {
      return 'session_synthetic';
    },
    async getConversationProviderId() {
      return 'primary';
    },
    resolveProviderSettings() {
      return { PROFILE: 'local' };
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

test('model tools are absent from every request when model tool calls are disabled', async () => {
  const calls = [];
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
      async streamMessages(options) {
        calls.push(options);
        return {
          content: 'deterministic pre-scan answer',
          toolCalls: [],
          done: true,
          responseId: 'response_without_tools',
          status: 'completed',
        };
      },
      async executeTool() {
        throw new Error('No tool should execute');
      },
      async updateAiResponse() {
        return [];
      },
      enableModelToolCalls: false,
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0], 'tools'), false);
  assert.equal(events.some(event => event.event === 'tool_start'), false);
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
      enableModelToolCalls: true,
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
        enableModelToolCalls: true,
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
    async getConversationProviderId() {
      return 'primary';
    },
    resolveProviderSettings() {
      return { PROFILE: 'local' };
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

function captureConsoleOutput() {
  const entries = [];
  const originals = {};
  for (const level of ['log', 'warn', 'error']) {
    originals[level] = console[level];
    console[level] = (...values) => entries.push(values.map(String).join(' '));
  }
  return {
    entries,
    restore() {
      for (const level of ['log', 'warn', 'error']) console[level] = originals[level];
    },
  };
}

function withoutCallbacks(options) {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => typeof value !== 'function'));
}

test('tools-off turn emits one content-free timing line with deterministic phases (no Postgres)', async () => {
  const canaries = [
    'CANARY-participant-text',
    'lodash@4.17.20',
    'pkg:npm/left-pad@1.3.0',
    'CVE-2021-44228',
    '{"package":"x"}',
    'session-7f3c',
  ];
  const capture = captureConsoleOutput();
  const calls = [];
  let tick = 0;
  try {
    await runAssistantTurn(
      { conversationId: canaries[5], sessionId: canaries[5] },
      () => {},
      {
        async loadHistory() {
          return {
            rows: [{ role: 'user', content: canaries[0], tool_calls: null }],
            messages: [{ role: 'user', content: canaries[0] }],
            nextSeq: 2,
          };
        },
        async streamMessages(options) {
          calls.push(options);
          options.onTiming?.('model_request_start');
          await options.onChunk?.({ delta: canaries[1], done: false });
          options.onTiming?.('model_stream_end');
          return {
            content: canaries[1],
            toolCalls: [],
            done: true,
            responseId: canaries[2],
            status: 'completed',
            usage: { inputTokens: 6, outputTokens: 7, totalTokens: 13 },
          };
        },
        async executeTool() {
          throw new Error('tool must not execute');
        },
        async updateAiResponse() {
          return [];
        },
        enableModelToolCalls: false,
        now: () => tick++,
      },
    );
  } finally {
    capture.restore();
  }

  const timingLines = capture.entries.filter(line => line.includes('"event":"timing_v1"'));
  assert.equal(timingLines.length, 1);
  assert.deepEqual(JSON.parse(timingLines[0]), {
    event: 'timing_v1',
    kind: 'chat_turn',
    provider: 'primary',
    tools_enabled: false,
    outcome: 'completed',
    history_load_ms: 1,
    rounds: [{
      db_prep_ms: 2,
      model_first_chunk_ms: 2,
      model_stream_ms: 4,
      db_append_ms: 2,
      input_tokens: 6,
      output_tokens: 7,
      tool_calls_requested: 0,
    }],
    tools: [],
    persist_ms: null,
    total_ms: 10,
  });
  for (const canary of canaries) {
    assert.equal(capture.entries.some(line => line.includes(canary)), false);
  }

  const { BOMBOT_INSTRUCTIONS } = await import('../../lib/openai-responses.ts');
  assert.deepEqual(withoutCallbacks(calls[0]), {
    conversationId: canaries[5],
    instructions: BOMBOT_INSTRUCTIONS,
    messages: [],
  });
});

test('tools-on two-round turn records a failed tool without logging canaries (no Postgres)', async () => {
  const canaries = [
    'CANARY-participant-text',
    'lodash@4.17.20',
    'pkg:npm/left-pad@1.3.0',
    'CVE-2021-44228',
    '{"package":"x"}',
    'session-7f3c',
  ];
  const capture = captureConsoleOutput();
  const calls = [];
  let tick = 0;
  try {
    await runAssistantTurn(
      { conversationId: canaries[5], sessionId: canaries[5] },
      () => {},
      {
        async loadHistory() {
          return {
            rows: [{ role: 'user', content: canaries[0], tool_calls: null }],
            messages: [{ role: 'user', content: canaries[0] }],
            nextSeq: 2,
          };
        },
        async streamMessages(options) {
          calls.push(options);
          options.onTiming?.('model_request_start');
          if (calls.length === 1) {
            await options.onChunk?.({
              toolCalls: [{ id: canaries[3], name: 'query_cve_details', arguments: canaries[4] }],
              done: false,
            });
            options.onTiming?.('model_stream_end');
            return {
              content: '',
              toolCalls: [{ id: canaries[3], name: 'query_cve_details', arguments: canaries[4] }],
              done: true,
              responseId: canaries[2],
              status: 'completed',
              usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
            };
          }
          await options.onChunk?.({ delta: canaries[1], done: false });
          options.onTiming?.('model_stream_end');
          return {
            content: canaries[1],
            toolCalls: [],
            done: true,
            responseId: 'response_final',
            status: 'completed',
            usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
          };
        },
        async executeTool(_name, arguments_) {
          assert.equal(arguments_, canaries[4]);
          throw new Error(canaries[0]);
        },
        async updateAiResponse() {
          return [];
        },
        enableModelToolCalls: true,
        now: () => tick++,
      },
    );
  } finally {
    capture.restore();
  }

  const timingLines = capture.entries.filter(line => line.includes('"event":"timing_v1"'));
  assert.equal(timingLines.length, 1);
  const timing = JSON.parse(timingLines[0]);
  assert.equal(timing.outcome, 'completed');
  assert.deepEqual(timing.rounds, [{
    db_prep_ms: 2,
    model_first_chunk_ms: 2,
    model_stream_ms: 4,
    db_append_ms: 2,
    input_tokens: 10,
    output_tokens: 1,
    tool_calls_requested: 1,
  }, {
    db_prep_ms: 2,
    model_first_chunk_ms: 2,
    model_stream_ms: 4,
    db_append_ms: 2,
    input_tokens: 20,
    output_tokens: 2,
    tool_calls_requested: 0,
  }]);
  assert.deepEqual(timing.tools, [{ round: 1, tool: 'query_cve_details', ms: 1, ok: false }]);
  assert.equal(timing.total_ms, 19);
  for (const canary of canaries) {
    assert.equal(capture.entries.some(line => line.includes(canary)), false);
  }

  const { BOMBOT_INSTRUCTIONS, BOMBOT_LLM_TOOLS } = await import('../../lib/openai-responses.ts');
  assert.deepEqual(withoutCallbacks(calls[0]), {
    conversationId: canaries[5],
    instructions: BOMBOT_INSTRUCTIONS,
    messages: [],
    tools: BOMBOT_LLM_TOOLS,
  });
  assert.deepEqual(withoutCallbacks(calls[1]), {
    conversationId: canaries[5],
    instructions: BOMBOT_INSTRUCTIONS,
    messages: [{
      role: 'tool',
      toolCallId: canaries[3],
      content: JSON.stringify({ error: canaries[0], success: false }),
    }],
    tools: BOMBOT_LLM_TOOLS,
    continuation: {
      round: 1,
      predecessorResponseId: canaries[2],
      idempotencyKey: `bombot-tool-successor-${canaries[2]}`,
    },
  });
});

test('history-load exception emits exactly one exception timing line (no Postgres)', async () => {
  const capture = captureConsoleOutput();
  let tick = 0;
  try {
    await assert.rejects(runAssistantTurn(
      { conversationId: 'synthetic', sessionId: 'synthetic' },
      () => {},
      {
        async loadHistory() {
          throw new Error('synthetic history failure');
        },
        async streamMessages() {
          throw new Error('must not stream');
        },
        async executeTool() {
          throw new Error('must not execute');
        },
        async updateAiResponse() {
          return [];
        },
        enableModelToolCalls: false,
        now: () => tick++,
      },
    ), /synthetic history failure/);
  } finally {
    capture.restore();
  }

  const timingLines = capture.entries.filter(line => line.includes('"event":"timing_v1"'));
  assert.equal(timingLines.length, 1);
  const timing = JSON.parse(timingLines[0]);
  assert.equal(timing.outcome, 'exception');
  assert.equal(timing.history_load_ms, null);
});

test('timing tool names and round cap remain in parity with model tools (no Postgres)', async () => {
  const { TIMING_ROUNDS_CAP, TIMING_TOOL_NAMES } = await import('../../lib/logging/timing.ts');
  const { BOMBOT_LLM_TOOLS, MAX_FUNCTION_CALL_ROUNDS } = await import('../../lib/openai-responses.ts');
  assert.deepEqual([...TIMING_TOOL_NAMES], BOMBOT_LLM_TOOLS.map(tool => tool.name));
  assert.equal(TIMING_ROUNDS_CAP, MAX_FUNCTION_CALL_ROUNDS + 1);
});
