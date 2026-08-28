import assert from 'node:assert/strict';
import test from 'node:test';

import 'dotenv/config';

const { default: handler } = await import('./osv-query.ts');

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

test('osv-query rejects a traversal-shaped CVE before making an outbound request', async () => {
  const originalFetch = globalThis.fetch;
  let outboundRequests = 0;
  globalThis.fetch = async () => {
    outboundRequests += 1;
    throw new Error('Invalid CVE input must not reach OSV');
  };

  try {
    const response = responseRecorder();
    await handler({
      method: 'POST',
      body: {
        cve: '../../etc/passwd',
        sessionId: '00000000-0000-4000-8000-000000000001',
      },
    }, response);

    assert.equal(response.statusCode, 400);
    assert.equal(response.jsonBody.error, 'Invalid CVE ID');
    assert.match(response.jsonBody.details, /Expected a CVE identifier/);
    assert.equal(outboundRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
