import assert from 'node:assert/strict';
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
  let conversationsCreated = 0;
  const client = {
    conversations: {
      async create() {
        conversationsCreated += 1;
        return { id: 'conv_synthetic' };
      },
    },
    responses: {
      async create(request) {
        requests.push(request);
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
  };

  await gateway.complete(request);
  for await (const _chunk of gateway.stream(request)) {
    // Consume the provider stream.
  }

  assert.equal(conversationsCreated, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].input, [{ role: 'user', content: 'Current turn' }]);
  assert.equal(requests[0].instructions, 'Synthetic instructions');
  assert.equal(requests[0].conversation, 'conv_synthetic');
  assert.equal(requests[0].background, true);
  assert.equal(requests[0].store, true);
  assert.equal(requests[1].stream, true);
  assert.equal(requests[1].conversation, 'conv_synthetic');
  assert.equal(requests[1].store, true);

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
  ];

  await gateway.complete({ messages });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].input, messages);
  assert.equal(requests[0].conversation, undefined);
  assert.equal(requests[0].background, undefined);
  assert.equal(requests[0].store, false);
});
