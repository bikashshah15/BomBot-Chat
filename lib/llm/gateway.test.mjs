import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CONFIGURATION_VARIABLES = [
  'DATABASE_URL',
  'PROFILE',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_API_KEY',
  'OSV_MODE',
  'OSV_BASE_URL',
  'OSV_MIRROR_BASE_URL',
  'OSV_SNAPSHOT_DATE',
  'RETENTION',
  'RETENTION_IDLE_HOURS',
  'PARTICIPANT_ID_MODE',
  'PARTICIPANT_ID_SALT',
  'ENABLE_MODEL_TOOL_CALLS',
  'LLM_TEMPERATURE',
  'LLM_TOP_P',
  'LLM_MAX_OUTPUT_TOKENS',
  'LLM_SEED',
];

const previousValues = new Map(
  CONFIGURATION_VARIABLES.map(name => [name, process.env[name]]),
);

Object.assign(process.env, {
  DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic',
  PROFILE: 'local',
  LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
  LLM_MODEL: 'synthetic-import-model',
  OSV_MODE: 'offline',
  RETENTION: 'ephemeral',
  RETENTION_IDLE_HOURS: '24',
  LLM_TEMPERATURE: '0',
  LLM_TOP_P: '1',
  LLM_MAX_OUTPUT_TOKENS: '4096',
  LLM_SEED: 'null',
  ENABLE_MODEL_TOOL_CALLS: 'true',
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

test('hosted OpenAI provider sends app-owned history without server state', async () => {
  const requests = [];
  const requestOptions = [];
  const client = {
    responses: {
      async create(request, options) {
        requests.push(request);
        requestOptions.push(options);
        if (request.stream) {
          return (async function* syntheticStream() {
            yield { type: 'response.output_text.delta', delta: 'synthetic' };
            yield { type: 'response.completed', response: syntheticResponse() };
          })();
        }
        return syntheticResponse();
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
    openAICompatible: {
      transport: {
        async complete() {
          throw new Error('Hosted profile must not invoke the compatible transport');
        },
        async stream() {
          throw new Error('Hosted profile must not invoke the compatible transport');
        },
      },
    },
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
  const continuationRequest = {
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
  };
  await gateway.complete(continuationRequest);
  for await (const _chunk of gateway.stream(continuationRequest)) {
    // Consume the streamed continuation so request identity is observable.
  }

  assert.equal(requests.length, 4);
  assert.deepEqual(requests[0].input, [
    { role: 'user', content: 'Earlier turn' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Current turn' },
  ]);
  assert.equal(requests[0].instructions, 'Synthetic instructions');
  assert.equal(requests[0].conversation, undefined);
  assert.equal(requests[0].background, undefined);
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].parallel_tool_calls, true);
  assert.equal(requests[0].metadata, undefined);
  assert.deepEqual(requests[0].tools, [{
    type: 'function',
    name: 'synthetic_tool',
    description: 'Synthetic tool definition',
    parameters: { type: 'object', properties: {} },
    strict: false,
  }]);
  assert.equal(requests[1].stream, true);
  assert.equal(requests[1].conversation, undefined);
  assert.equal(requests[1].store, false);
  assert.deepEqual(requests[2].input, [
    {
      type: 'function_call',
      call_id: 'call_synthetic',
      name: 'synthetic_tool',
      arguments: '{"value":"synthetic"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_synthetic',
      output: '{"result":"synthetic"}',
    },
  ]);
  assert.equal(requests[2].metadata, undefined);
  assert.equal(
    requestOptions[2].idempotencyKey,
    'bombot-tool-successor-resp_predecessor',
  );
  assert.equal(
    requestOptions[2].headers['Idempotency-Key'],
    'bombot-tool-successor-resp_predecessor',
  );
  assert.equal(requests[3].stream, true);
  assert.equal(
    requestOptions[3].idempotencyKey,
    'bombot-tool-successor-resp_predecessor',
  );
  assert.equal(
    requestOptions[3].headers['Idempotency-Key'],
    'bombot-tool-successor-resp_predecessor',
  );

  for (const outboundRequest of requests) {
    assert.equal(outboundRequest.temperature, 0.15);
    assert.equal(outboundRequest.top_p, 0.95);
    assert.equal(outboundRequest.max_output_tokens, 2048);
  }
});

test('local profile selects chat completions and sends full caller-owned history', async () => {
  const requests = [];
  const transport = {
    async complete(request) {
      requests.push(request);
      return {
        id: 'chatcmpl_synthetic',
        created: 1_700_000_000,
        model: 'synthetic-local-model',
        object: 'chat.completion',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: { role: 'assistant', content: 'synthetic answer', refusal: null },
        }],
      };
    },
    async stream() {
      throw new Error('This test exercises the non-streaming transport only');
    },
  };
  const gateway = createLlmGateway({
    settings: gatewaySettings(),
    openAI: {
      client: {
        responses: {
          async create() {
            throw new Error('Local profile must not invoke the hosted Responses provider');
          },
        },
      },
    },
    openAICompatible: { transport },
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

  await gateway.complete({ messages });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].messages, [
    { role: 'system', content: 'Synthetic instructions' },
    { role: 'user', content: 'Earlier turn' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Current turn' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_local',
        type: 'function',
        function: {
          name: 'synthetic_tool',
          arguments: '{"value":"synthetic"}',
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_local',
      content: '{"result":"synthetic"}',
    },
  ]);
  assert.equal(requests[0].model, 'synthetic-local-model');
  assert.equal(requests[0].temperature, 0);
  assert.equal(requests[0].top_p, 1);
  assert.equal(requests[0].max_tokens, 4096);
  assert.equal(requests[0].seed, null);
  assert.equal(requests[0].stream, false);
});

test('all four LLM entry routes use app-owned streaming without legacy model transport', async () => {
  const routePaths = [
    '../../pages/api/chat.ts',
    '../../pages/api/upload.ts',
    '../../pages/api/osv-query.ts',
    '../../pages/api/stream.ts',
  ];
  const legacyTransport = new RegExp(
    ['createBackground', 'Response|retrieve', 'Response|continueFunctionCalling', 'Loop'].join(''),
  );

  for (const routePath of routePaths) {
    const source = await readFile(new URL(routePath, import.meta.url), 'utf8');
    if (routePath.endsWith('stream.ts')) {
      assert.match(source, /streamMessages: streamConversationMessages/);
    } else {
      assert.match(source, /appendConversationMessages\(/);
    }
    assert.doesNotMatch(source, legacyTransport);
  }
});

test('stream keeps terminal response statuses and structured failure details visible', async () => {
  const source = await readFile(
    new URL('../../pages/api/stream.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /responseStatus: response\.status/);
  assert.match(source, /getResponseErrorMessage\(response\)/);
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
