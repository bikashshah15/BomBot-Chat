import assert from 'node:assert/strict';
import test from 'node:test';

import 'dotenv/config';

const { default: handler } = await import('./model-providers.ts');

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

test('model provider status exposes counters and labels but no URL or key material', async () => {
  const response = responseRecorder();
  await handler({ method: 'GET', query: {} }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.jsonBody.toggleEnabled, 'boolean');
  assert.deepEqual(response.jsonBody.providers.map(provider => provider.id), ['primary', 'alternate']);
  assert.equal(Number.isInteger(response.jsonBody.hostedRequestsThisSession), true);
  assert.equal(Number.isInteger(response.jsonBody.rateLimitRejections), true);
  assert.equal(typeof response.jsonBody.activeProviderLabel, 'string');
  const serialized = JSON.stringify(response.jsonBody);
  assert.doesNotMatch(serialized, /sk-/i);
  assert.doesNotMatch(serialized, /http/i);
  assert.doesNotMatch(serialized, /key/i);
});
