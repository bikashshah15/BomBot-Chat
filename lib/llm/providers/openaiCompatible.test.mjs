import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAICompatibleProvider } from './openaiCompatible.ts';

function request(overrides = {}) {
  return {
    messages: [
      { role: 'system', content: 'Synthetic instructions' },
      { role: 'user', content: 'Synthetic question' },
    ],
    tools: [{
      name: 'synthetic_tool',
      description: 'Synthetic tool',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      strict: true,
    }],
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 2048,
    seed: 17,
    ...overrides,
  };
}

test('OpenAI-compatible complete maps messages, tools, decoding, result, and usage', async () => {
  const requests = [];
  const provider = createOpenAICompatibleProvider({
    model: 'synthetic-compatible-model',
    baseURL: 'http://model.test/v1/',
    transport: {
      async complete(outboundRequest) {
        requests.push(outboundRequest);
        return {
          id: 'chatcmpl_synthetic',
          created: 1_700_000_000,
          model: 'synthetic-compatible-model',
          object: 'chat.completion',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            logprobs: null,
            message: {
              role: 'assistant',
              content: null,
              refusal: null,
              tool_calls: [{
                id: 'call_synthetic',
                type: 'function',
                function: {
                  name: 'synthetic_tool',
                  arguments: '{"value":"synthetic"}',
                },
              }],
            },
          }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
          },
        };
      },
      async stream() {
        throw new Error('Unexpected stream request');
      },
    },
  });

  const result = await provider.complete(request());

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    model: 'synthetic-compatible-model',
    messages: [
      { role: 'system', content: 'Synthetic instructions' },
      { role: 'user', content: 'Synthetic question' },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'synthetic_tool',
        description: 'Synthetic tool',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        strict: true,
      },
    }],
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 2048,
    seed: 17,
    stream: false,
  });
  assert.deepEqual(result, {
    content: '',
    toolCalls: [{
      id: 'call_synthetic',
      name: 'synthetic_tool',
      arguments: '{"value":"synthetic"}',
    }],
    done: true,
    responseId: 'chatcmpl_synthetic',
    status: 'completed',
    createdAt: 1_700_000_000,
    model: 'synthetic-compatible-model',
    usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    rawUsage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  });
});

test('OpenAI-compatible stream reconstructs fragmented tool calls without a server', async () => {
  const requests = [];
  const provider = createOpenAICompatibleProvider({
    model: 'synthetic-compatible-model',
    baseURL: 'http://model.test/v1',
    transport: {
      async complete() {
        throw new Error('Unexpected complete request');
      },
      async stream(outboundRequest) {
        requests.push(outboundRequest);
        return (async function* chunks() {
          yield {
            id: 'chatcmpl_stream',
            created: 1_700_000_001,
            model: 'synthetic-compatible-model',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              finish_reason: null,
              logprobs: null,
              delta: { role: 'assistant', content: 'Synthetic ' },
            }],
          };
          yield {
            id: 'chatcmpl_stream',
            created: 1_700_000_001,
            model: 'synthetic-compatible-model',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              finish_reason: null,
              logprobs: null,
              delta: {
                content: 'answer',
                tool_calls: [{
                  index: 0,
                  id: 'call_synthetic',
                  type: 'function',
                  function: { name: 'synthetic_', arguments: '{"value":' },
                }],
              },
            }],
          };
          yield {
            id: 'chatcmpl_stream',
            created: 1_700_000_001,
            model: 'synthetic-compatible-model',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
              logprobs: null,
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { name: 'tool', arguments: '"synthetic"}' },
                }],
              },
            }],
          };
        })();
      },
    },
  });

  const chunks = [];
  for await (const chunk of provider.stream(request())) chunks.push(chunk);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].stream, true);
  assert.deepEqual(chunks.slice(0, 2), [
    { delta: 'Synthetic ', done: false },
    { delta: 'answer', done: false },
  ]);
  assert.deepEqual(chunks[2], {
    result: {
      content: 'Synthetic answer',
      toolCalls: [{
        id: 'call_synthetic',
        name: 'synthetic_tool',
        arguments: '{"value":"synthetic"}',
      }],
      done: true,
      responseId: 'chatcmpl_stream',
      status: 'completed',
      createdAt: 1_700_000_001,
      model: 'synthetic-compatible-model',
    },
    done: true,
  });
});

test('OpenAI-compatible stream surfaces usage that arrives after the finish reason', async () => {
  const requests = [];
  const provider = createOpenAICompatibleProvider({
    model: 'synthetic-compatible-model',
    baseURL: 'http://model.test/v1',
    transport: {
      async complete() {
        throw new Error('Unexpected complete request');
      },
      async stream(outboundRequest) {
        requests.push(outboundRequest);
        return (async function* chunks() {
          yield {
            id: 'chatcmpl_stream_usage',
            created: 1_700_000_002,
            model: 'synthetic-compatible-model',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              finish_reason: 'stop',
              logprobs: null,
              delta: { role: 'assistant', content: 'Synthetic answer' },
            }],
          };
          yield {
            id: 'chatcmpl_stream_usage',
            created: 1_700_000_002,
            model: 'synthetic-compatible-model',
            object: 'chat.completion.chunk',
            choices: [],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 4,
              total_tokens: 124,
            },
          };
        })();
      },
    },
  });

  const chunks = [];
  for await (const chunk of provider.stream(request())) chunks.push(chunk);

  assert.deepEqual(chunks.at(-1)?.result?.usage, {
    inputTokens: 120,
    outputTokens: 4,
    totalTokens: 124,
  });
  assert.deepEqual(chunks.at(-1)?.result?.rawUsage, {
    prompt_tokens: 120,
    completion_tokens: 4,
    total_tokens: 124,
  });
  assert.deepEqual(requests[0].stream_options, { include_usage: true });
});

test('OpenAI-compatible stream completes normally when the server omits usage', async () => {
  const provider = createOpenAICompatibleProvider({
    model: 'synthetic-compatible-model',
    baseURL: 'http://model.test/v1',
    transport: {
      async complete() {
        throw new Error('Unexpected complete request');
      },
      async stream() {
        return (async function* chunks() {
          yield {
            id: 'chatcmpl_stream_without_usage',
            created: 1_700_000_003,
            model: 'synthetic-compatible-model',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              finish_reason: 'stop',
              logprobs: null,
              delta: { role: 'assistant', content: 'Synthetic answer' },
            }],
          };
        })();
      },
    },
  });

  const chunks = [];
  for await (const chunk of provider.stream(request())) chunks.push(chunk);

  assert.deepEqual(chunks, [
    { delta: 'Synthetic answer', done: false },
    {
      result: {
        content: 'Synthetic answer',
        toolCalls: [],
        done: true,
        responseId: 'chatcmpl_stream_without_usage',
        status: 'completed',
        createdAt: 1_700_000_003,
        model: 'synthetic-compatible-model',
      },
      done: true,
    },
  ]);
});

test('OpenAI-compatible transport failures name the unreachable server boundary', async () => {
  const provider = createOpenAICompatibleProvider({
    model: 'synthetic-compatible-model',
    baseURL: 'http://unreachable.test/v1/',
    transport: {
      async complete() {
        throw new Error('synthetic connection refused');
      },
      async stream() {
        throw new Error('synthetic connection refused');
      },
    },
  });

  await assert.rejects(
    provider.complete(request()),
    /OpenAI-compatible LLM server is unreachable or rejected the request at http:\/\/unreachable\.test\/v1\/chat\/completions: synthetic connection refused/,
  );
  await assert.rejects(
    async () => {
      for await (const _chunk of provider.stream(request())) {
        // Consume the generator so transport setup runs.
      }
    },
    /OpenAI-compatible LLM server is unreachable or rejected the request at http:\/\/unreachable\.test\/v1\/chat\/completions: synthetic connection refused/,
  );
});
