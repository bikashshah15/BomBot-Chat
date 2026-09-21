import assert from 'node:assert/strict';
import test from 'node:test';

const { createOpenAIProvider } = await import('./openai.ts');

function response(cachedTokens) {
  return {
    id: 'resp_synthetic',
    output_text: 'synthetic',
    output: [],
    status: 'completed',
    created_at: 1,
    completed_at: 2,
    model: 'synthetic-model',
    error: null,
    incomplete_details: null,
    metadata: {},
    usage: {
      input_tokens: 12,
      input_tokens_details: cachedTokens === undefined ? {} : { cached_tokens: cachedTokens },
      output_tokens: 4,
      output_tokens_details: {},
      total_tokens: 16,
    },
  };
}

function request() {
  return {
    messages: [{ role: 'user', content: 'synthetic' }],
    temperature: 0,
    topP: 1,
    maxOutputTokens: 64,
  };
}

async function streamResult(cachedTokens) {
  const terminal = response(cachedTokens);
  const client = {
    responses: {
      async create() {
        return (async function* events() {
          yield { type: 'response.completed', response: terminal };
        })();
      },
    },
  };
  const chunks = [];
  for await (const chunk of createOpenAIProvider({ model: 'synthetic', client }).stream(request())) {
    chunks.push(chunk);
  }
  return chunks.at(-1).result;
}

test('OpenAI streaming provider surfaces cached input tokens when Responses usage supplies them', async () => {
  const result = await streamResult(8);

  assert.equal(typeof result.usage.cachedInputTokens, 'number');
  assert.equal(result.usage.cachedInputTokens, 8);
});

test('OpenAI streaming provider omits cached input tokens when Responses usage omits them', async () => {
  const result = await streamResult();

  assert.equal(Object.hasOwn(result.usage, 'cachedInputTokens'), false);
});
