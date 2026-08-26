import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CONFIGURATION_VARIABLES = [
  'PROFILE',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_API_KEY',
  'OSV_MODE',
  'OSV_BASE_URL',
  'RETENTION',
  'LLM_TEMPERATURE',
  'LLM_TOP_P',
  'LLM_MAX_OUTPUT_TOKENS',
  'LLM_SEED',
];

const previousValues = new Map(
  CONFIGURATION_VARIABLES.map(name => [name, process.env[name]]),
);

Object.assign(process.env, {
  PROFILE: 'local',
  LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
  LLM_MODEL: 'synthetic-import-model',
  OSV_MODE: 'offline',
  RETENTION: 'ephemeral',
  LLM_TEMPERATURE: '0',
  LLM_TOP_P: '1',
  LLM_MAX_OUTPUT_TOKENS: '4096',
  LLM_SEED: 'null',
});
delete process.env.LLM_API_KEY;
delete process.env.OSV_BASE_URL;

const { createLlmGateway } = await import('./gateway.ts');

for (const name of CONFIGURATION_VARIABLES) {
  const previousValue = previousValues.get(name);
  if (previousValue === undefined) delete process.env[name];
  else process.env[name] = previousValue;
}

function gatewaySettings(overrides = {}) {
  return {
    PROFILE: 'local',
    LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
    LLM_MODEL: 'synthetic-local-model',
    LLM_API_KEY: undefined,
    LLM_TEMPERATURE: 0,
    LLM_TOP_P: 1,
    LLM_MAX_OUTPUT_TOKENS: 4096,
    LLM_SEED: null,
    ...overrides,
  };
}

function syntheticResponse(overrides = {}) {
  return {
    id: 'resp_synthetic',
    output_text: 'synthetic answer',
    output: [],
    status: 'completed',
    error: null,
    usage: null,
    ...overrides,
  };
}

test('gateway pins decoding parameters for complete and stream requests', async () => {
  const receivedRequests = [];
  const provider = {
    async complete(req) {
      receivedRequests.push(req);
      return { content: '', toolCalls: [], done: true };
    },
    async *stream(req) {
      receivedRequests.push(req);
      yield { done: true };
    },
  };
  const gateway = createLlmGateway({
    settings: gatewaySettings({
      LLM_TEMPERATURE: 0.2,
      LLM_TOP_P: 0.85,
      LLM_MAX_OUTPUT_TOKENS: 3072,
      LLM_SEED: 11,
    }),
    provider,
  });
  const callerRequest = {
    messages: [{ role: 'user', content: 'synthetic request' }],
    temperature: 1.9,
    topP: 0.1,
    maxOutputTokens: 1,
    seed: 99,
  };

  await gateway.complete(callerRequest);
  for await (const _chunk of gateway.stream(callerRequest)) {
    // Consume the stream so the provider receives its request.
  }

  assert.equal(receivedRequests.length, 2);
  for (const request of receivedRequests) {
    assert.equal(request.temperature, 0.2);
    assert.equal(request.topP, 0.85);
    assert.equal(request.maxOutputTokens, 3072);
    assert.equal(request.seed, 11);
  }
});

test('hosted OpenAI provider preserves current conversation, background, and store behavior', async () => {
  const requests = [];
  const requestOptions = [];
  let conversationsCreated = 0;
  const client = {
    conversations: {
      async create() {
        conversationsCreated += 1;
        return { id: 'conv_synthetic' };
      },
    },
    responses: {
      async create(request, options) {
        requests.push(request);
        requestOptions.push(options);
        if (request.stream) {
          return (async function* syntheticStream() {
            yield { type: 'response.output_text.delta', delta: 'synthetic' };
            yield { type: 'response.completed' };
          })();
        }
        return syntheticResponse({ status: 'queued', output_text: '' });
      },
    },
  };
  const gateway = createLlmGateway({
    settings: gatewaySettings({
      PROFILE: 'hosted',
      LLM_BASE_URL: 'https://api.openai.test/v1',
      LLM_MODEL: 'synthetic-hosted-model',
      LLM_API_KEY: 'synthetic-key',
      LLM_TEMPERATURE: 0.15,
      LLM_TOP_P: 0.95,
      LLM_MAX_OUTPUT_TOKENS: 2048,
    }),
    openAI: { client },
  });
  const request = {
    messages: [
      { role: 'system', content: 'Synthetic instructions' },
      { role: 'user', content: 'Earlier turn' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Current turn' },
    ],
    tools: [{
      name: 'synthetic_tool',
      description: 'Synthetic tool definition',
      parameters: { type: 'object', properties: {} },
      strict: false,
    }],
  };

  await gateway.complete(request);
  for await (const _chunk of gateway.stream(request)) {
    // Consume the provider stream.
  }
  await gateway.complete({
    messages: [
      { role: 'system', content: 'Synthetic instructions' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call_synthetic',
          name: 'synthetic_tool',
          arguments: '{"value":"synthetic"}',
        }],
      },
      {
        role: 'tool',
        toolCallId: 'call_synthetic',
        content: '{"result":"synthetic"}',
      },
    ],
    tools: request.tools,
    continuation: {
      round: 1,
      predecessorResponseId: 'resp_predecessor',
      idempotencyKey: 'bombot-tool-successor-resp_predecessor',
    },
  });

  assert.equal(conversationsCreated, 1);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].input, [{ role: 'user', content: 'Current turn' }]);
  assert.equal(requests[0].instructions, 'Synthetic instructions');
  assert.equal(requests[0].conversation, 'conv_synthetic');
  assert.equal(requests[0].background, true);
  assert.equal(requests[0].store, true);
  assert.equal(requests[0].parallel_tool_calls, true);
  assert.deepEqual(requests[0].metadata, { bombot_tool_round: '0' });
  assert.deepEqual(requests[0].tools, [{
    type: 'function',
    name: 'synthetic_tool',
    description: 'Synthetic tool definition',
    parameters: { type: 'object', properties: {} },
    strict: false,
  }]);
  assert.equal(requests[1].stream, true);
  assert.equal(requests[1].conversation, 'conv_synthetic');
  assert.equal(requests[1].store, true);
  assert.deepEqual(requests[2].input, [{
    type: 'function_call_output',
    call_id: 'call_synthetic',
    output: '{"result":"synthetic"}',
  }]);
  assert.deepEqual(requests[2].metadata, { bombot_tool_round: '1' });
  assert.equal(
    requestOptions[2].idempotencyKey,
    'bombot-tool-successor-resp_predecessor',
  );
  assert.equal(
    requestOptions[2].headers['Idempotency-Key'],
    'bombot-tool-successor-resp_predecessor',
  );

  for (const outboundRequest of requests) {
    assert.equal(outboundRequest.temperature, 0.15);
    assert.equal(outboundRequest.top_p, 0.95);
    assert.equal(outboundRequest.max_output_tokens, 2048);
  }
});

test('local OpenAI-compatible provider sends full caller-owned history without server state', async () => {
  const requests = [];
  const client = {
    conversations: {
      async create() {
        throw new Error('Local profile must not create a server-side conversation');
      },
    },
    responses: {
      async create(request) {
        requests.push(request);
        return syntheticResponse();
      },
    },
  };
  const gateway = createLlmGateway({
    settings: gatewaySettings(),
    openAI: { client },
  });
  const messages = [
    { role: 'system', content: 'Synthetic instructions' },
    { role: 'user', content: 'Earlier turn' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Current turn' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'call_local',
        name: 'synthetic_tool',
        arguments: '{"value":"synthetic"}',
      }],
    },
    {
      role: 'tool',
      toolCallId: 'call_local',
      content: '{"result":"synthetic"}',
    },
  ];

  const result = await gateway.complete({ messages });
  // INC-06: remove — local resolve is identity while hosted polling exists.
  const resolved = await gateway.resolve({ result });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].input, [
    { role: 'system', content: 'Synthetic instructions' },
    { role: 'user', content: 'Earlier turn' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Current turn' },
    {
      type: 'function_call',
      call_id: 'call_local',
      name: 'synthetic_tool',
      arguments: '{"value":"synthetic"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_local',
      output: '{"result":"synthetic"}',
    },
  ]);
  assert.equal(requests[0].conversation, undefined);
  assert.equal(requests[0].background, undefined);
  assert.equal(requests[0].store, false);
  assert.strictEqual(resolved, result);
});

test('hosted resolve preserves each terminal status and its structured details', async () => {
  const responses = new Map([
    ['resp_failed', syntheticResponse({
      id: 'resp_failed',
      status: 'failed',
      error: {
        code: 'rate_limit_exceeded',
        message: 'Synthetic rate limit response failure',
      },
      incomplete_details: null,
      conversation: { id: 'conv_resolved' },
    })],
    ['resp_cancelled', syntheticResponse({
      id: 'resp_cancelled',
      status: 'cancelled',
      error: null,
      incomplete_details: null,
    })],
    ['resp_incomplete', syntheticResponse({
      id: 'resp_incomplete',
      status: 'incomplete',
      error: null,
      incomplete_details: { reason: 'max_output_tokens' },
    })],
  ]);
  const client = {
    conversations: {
      async create() {
        throw new Error('Resolve must not create a conversation');
      },
    },
    responses: {
      async retrieve(responseId) {
        return responses.get(responseId);
      },
    },
  };
  const gateway = createLlmGateway({
    settings: gatewaySettings({
      PROFILE: 'hosted',
      LLM_BASE_URL: 'https://api.openai.test/v1',
      LLM_API_KEY: 'synthetic-key',
    }),
    openAI: { client, conversationId: 'conv_requested' },
  });

  // INC-06: remove — these assertions cover the temporary hosted resolve surface.
  const failed = await gateway.resolve({ responseId: 'resp_failed' });
  // INC-06: remove — these assertions cover the temporary hosted resolve surface.
  const cancelled = await gateway.resolve({ responseId: 'resp_cancelled' });
  // INC-06: remove — these assertions cover the temporary hosted resolve surface.
  const incomplete = await gateway.resolve({ responseId: 'resp_incomplete' });

  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, {
    code: 'rate_limit_exceeded',
    message: 'Synthetic rate limit response failure',
  });
  assert.equal(failed.conversationId, 'conv_resolved');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error, undefined);
  assert.equal(incomplete.status, 'incomplete');
  assert.deepEqual(incomplete.incompleteDetails, { reason: 'max_output_tokens' });
});

test('all four LLM routes use the gateway without legacy model transport', async () => {
  const routePaths = [
    '../../pages/api/chat.ts',
    '../../pages/api/upload.ts',
    '../../pages/api/osv-query.ts',
    '../../pages/api/run-status.ts',
  ];

  for (const routePath of routePaths) {
    const source = await readFile(new URL(routePath, import.meta.url), 'utf8');
    assert.match(source, /createLlmGateway/);
    if (routePath.endsWith('run-status.ts')) {
      assert.match(source, /gateway\.resolve\(/);
      assert.match(source, /gateway\.complete\(/);
    } else {
      assert.match(source, /gateway\.complete\(/);
    }
    assert.doesNotMatch(
      source,
      /createBackgroundResponse|createConversation|retrieveResponse|continueFunctionCallingLoop/,
    );
  }
});

test('run-status keeps terminal response status and structured failure details visible', async () => {
  const source = await readFile(
    new URL('../../pages/api/run-status.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /responseStatus: response\.status/);
  assert.match(source, /last_error: response\.error \?\? response\.incompleteDetails/);
  assert.match(source, /response\.status === 'failed'/);
  assert.match(source, /response\.status === 'cancelled'/);
  assert.match(source, /response\.status === 'incomplete'/);
});

test('OSV outbound callers use validated config instead of process.env', async () => {
  const sourcePaths = [
    '../openai-responses.ts',
    '../../pages/api/upload.ts',
    '../../pages/api/osv-query.ts',
  ];

  for (const sourcePath of sourcePaths) {
    const source = await readFile(new URL(sourcePath, import.meta.url), 'utf8');
    assert.match(source, /config\.OSV_BASE_URL|environmentConfig\.OSV_BASE_URL/);
    assert.doesNotMatch(source, /process\.env\.OSV_BASE_URL/);
  }
});
