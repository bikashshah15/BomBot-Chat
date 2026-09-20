import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { beforeEach } from 'node:test';

import 'dotenv/config';

const { createChatHandler, config: chatRouteConfig } = await import('./chat.ts');
const { createStreamHandler } = await import('./stream.ts');
const { createDemoAccessHandler } = await import('./demo-access.ts');
const {
  DEMO_ACCESS_COOKIE,
  acquireHostedStream,
  checkHostedAccess,
  demoCookieValue,
  hostedGuardLimits,
  hostedGuardState,
  hostedGuardVisibility,
  resetHostedGuardStateForTests,
  timingSafeSecretMatch,
} = await import('../../lib/security/hostedGuards.ts');

const pinnedMessages = [{ role: 'user', pinned: true, content: 'SBOM-CONTENT-CANARY' }];

beforeEach(resetHostedGuardStateForTests);

function request(overrides = {}) {
  return {
    method: 'POST',
    headers: { host: 'demo.test' },
    socket: { remoteAddress: '127.0.0.1' },
    query: {},
    ...overrides,
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    jsonBody: undefined,
    headers: new Map(),
    body: '',
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
    setHeader(name, value) { this.headers.set(name, value); },
    redirect(code, location) { this.statusCode = code; this.headers.set('Location', location); return this; },
    flushHeaders() {},
    write(chunk) { this.body += chunk; return true; },
    end() { this.ended = true; },
  };
}

function chatBody(message = 'What is risky?') {
  return {
    message,
    conversationId: 'conversation_guard',
    sessionId: 'session_guard',
    messageIndex: 2,
  };
}

function hostedChat(messages) {
  let appended = 0;
  const handler = createChatHandler({
    async getConversationSessionId() { return 'session_guard'; },
    async getConversationProviderId() { return 'primary'; },
    resolveProviderSettings() { return { PROFILE: 'hosted' }; },
    async getConversationMessages() { return messages; },
    async insertLog() { return {}; },
    async appendConversationMessages() { appended += 1; },
  });
  return { handler, appended: () => appended };
}

test('hosted chat requires a pinned user upload and allows one when present', async () => {
  const missing = hostedChat([]);
  const missingResponse = responseRecorder();
  await missing.handler({ ...request(), body: chatBody() }, missingResponse);
  assert.equal(missingResponse.statusCode, 409);
  assert.equal(missingResponse.jsonBody.code, 'sbom_required');
  assert.equal(missing.appended(), 0);

  const present = hostedChat(pinnedMessages);
  const presentResponse = responseRecorder();
  await present.handler({ ...request(), body: chatBody() }, presentResponse);
  assert.equal(presentResponse.statusCode, 200);
  assert.equal(present.appended(), 1);
});

test('demo gate refuses missing and wrong cookies off loopback and accepts the derived cookie', () => {
  const secret = 'DEMO-TOKEN-CANARY';
  const remote = request({ socket: { remoteAddress: '203.0.113.8' } });
  assert.equal(checkHostedAccess(remote, secret)?.code, 'demo_access_required');
  assert.equal(checkHostedAccess({ ...remote, headers: { cookie: `${DEMO_ACCESS_COOKIE}=wrong` } }, secret)?.code, 'demo_access_required');
  const correct = `${DEMO_ACCESS_COOKIE}=${demoCookieValue(secret)}`;
  assert.equal(checkHostedAccess({ ...remote, headers: { host: 'demo.test', cookie: correct } }, secret), null);
  assert.equal(timingSafeSecretMatch(secret, secret), true);
  assert.equal(timingSafeSecretMatch('wrong', secret), false);
});

test('demo secrets use the timing-safe helper rather than plain equality', async () => {
  const source = await readFile(
    new URL('../../lib/security/hostedGuards.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /timingSafeEqual\(/);
  assert.doesNotMatch(source, /candidate\s*===\s*secret|secret\s*===\s*candidate/);
});

test('demo access endpoint sets only an httpOnly strict cookie for a timing-safe token match', () => {
  const secret = 'DEMO-TOKEN-CANARY';
  const handler = createDemoAccessHandler(secret);
  const wrong = responseRecorder();
  handler({ method: 'GET', query: { token: 'wrong' } }, wrong);
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.headers.has('Set-Cookie'), false);

  const correct = responseRecorder();
  handler({ method: 'GET', query: { token: secret } }, correct);
  assert.equal(correct.statusCode, 303);
  assert.match(correct.headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(correct.headers.get('Set-Cookie'), new RegExp(secret));
});

test('session rolling limit rejects N+1, increments the counter, and records accepted requests', () => {
  const req = request();
  for (let index = 0; index < hostedGuardLimits.sessionHourly; index += 1) {
    const acquired = acquireHostedStream(req, 'session_rate', pinnedMessages, index);
    assert.equal(acquired.failure, null);
    acquired.release();
  }
  const rejected = acquireHostedStream(req, 'session_rate', pinnedMessages, 100);
  assert.equal(rejected.failure?.code, 'hosted_rate_limited');
  assert.equal(hostedGuardVisibility('session_rate').hostedRequestsThisSession, hostedGuardLimits.sessionHourly);
  assert.equal(hostedGuardVisibility('session_rate').rateLimitRejections, 1);
});

test('a second hosted stream in the same session is refused until release', () => {
  const first = acquireHostedStream(request(), 'session_concurrent', pinnedMessages);
  assert.equal(first.failure, null);
  const second = acquireHostedStream(request(), 'session_concurrent', pinnedMessages);
  assert.equal(second.failure?.code, 'hosted_stream_busy');
  first.release();
  const third = acquireHostedStream(request(), 'session_concurrent', pinnedMessages);
  assert.equal(third.failure, null);
  third.release();
});

test('process budget refuses hosted streams after exhaustion', () => {
  hostedGuardState.processRequests = hostedGuardLimits.processBudget;
  const acquired = acquireHostedStream(request(), 'session_budget', pinnedMessages);
  assert.equal(acquired.failure?.code, 'hosted_budget_exhausted');
});

test('the coarser IP bucket limits distinct sessions sharing one address', () => {
  const req = request();
  for (let index = 0; index < hostedGuardLimits.ipHourly; index += 1) {
    const acquired = acquireHostedStream(req, `session_ip_${index}`, pinnedMessages, index);
    assert.equal(acquired.failure, null);
    acquired.release();
  }
  const rejected = acquireHostedStream(req, 'session_ip_rejected', pinnedMessages, 100);
  assert.equal(rejected.failure?.code, 'hosted_rate_limited');
});

test('hosted conversation turn cap is enforced before persistence', async () => {
  const messages = [
    ...pinnedMessages,
    ...Array.from({ length: hostedGuardLimits.maxTurnsPerConversation }, (_, index) => ({
      role: 'user', pinned: false, content: `question-${index}`,
    })),
  ];
  const capped = hostedChat(messages);
  const response = responseRecorder();
  await capped.handler({ ...request(), body: chatBody() }, response);
  assert.equal(response.statusCode, 429);
  assert.equal(response.jsonBody.code, 'hosted_turn_limit');
  assert.equal(capped.appended(), 0);
});

test('local chat and stream bypass every hosted bucket', async () => {
  hostedGuardState.processRequests = hostedGuardLimits.processBudget;
  let guardCalls = 0;
  let turns = 0;
  const chat = createChatHandler({
    async getConversationSessionId() { return 'session_guard'; },
    async getConversationProviderId() { return 'primary'; },
    resolveProviderSettings() { return { PROFILE: 'local' }; },
    async getConversationMessages() { throw new Error('local chat must not read guard history'); },
    checkHostedRequest() { guardCalls += 1; throw new Error('local chat must not be guarded'); },
    async insertLog() { return {}; },
    async appendConversationMessages() {},
  });
  const chatResponse = responseRecorder();
  await chat({ ...request({ socket: { remoteAddress: '203.0.113.8' } }), body: chatBody() }, chatResponse);
  assert.equal(chatResponse.statusCode, 200);

  const stream = createStreamHandler({
    async getConversationSessionId() { return 'session_guard'; },
    async getConversationProviderId() { return 'primary'; },
    resolveProviderSettings() { return { PROFILE: 'local' }; },
    async getConversationMessages() { throw new Error('local stream must not read guard history'); },
    acquireHostedStream() { guardCalls += 1; throw new Error('local stream must not be guarded'); },
    async runTurn() { turns += 1; },
    setInterval() { return 1; },
    clearInterval() {},
  });
  const streamResponse = responseRecorder();
  await stream({
    ...request({ method: 'GET', socket: { remoteAddress: '203.0.113.8' } }),
    query: { conversationId: 'conversation_guard', sessionId: 'session_guard' },
  }, streamResponse);
  assert.equal(streamResponse.statusCode, 200);
  assert.equal(turns, 1);
  assert.equal(guardCalls, 0);
});

test('message and body caps reject before provider or gateway work', async () => {
  let resolverCalls = 0;
  const handler = createChatHandler({
    resolveProviderSettings() { resolverCalls += 1; return { PROFILE: 'hosted' }; },
  });
  const response = responseRecorder();
  await handler({ ...request(), body: chatBody('x'.repeat(5000)) }, response);
  assert.equal(response.statusCode, 413);
  assert.equal(response.jsonBody.code, 'message_too_long');
  assert.equal(resolverCalls, 0);
  assert.deepEqual(chatRouteConfig, { api: { bodyParser: { sizeLimit: '32kb' } } });
});

test('cookie-bearing cross-origin requests are refused', () => {
  const failure = checkHostedAccess(request({
    headers: {
      host: 'demo.test',
      origin: 'https://attacker.invalid',
      cookie: `${DEMO_ACCESS_COOKIE}=present`,
    },
  }), undefined);
  assert.equal(failure?.code, 'invalid_origin');
});

test('client fields cannot enable tools and guard logs contain metadata only', async () => {
  let turnOptions;
  const handler = createStreamHandler({
    async getConversationSessionId() { return 'session_guard'; },
    async getConversationProviderId() { return 'primary'; },
    resolveProviderSettings() { return { PROFILE: 'local' }; },
    async runTurn(options) { turnOptions = options; },
    setInterval() { return 1; },
    clearInterval() {},
  });
  await handler({
    ...request({ method: 'GET', body: { enableModelToolCalls: true } }),
    query: { conversationId: 'conversation_guard', sessionId: 'session_guard', enableModelToolCalls: 'true' },
  }, responseRecorder());
  assert.equal(Object.hasOwn(turnOptions, 'enableModelToolCalls'), false);
  const streamSource = await readFile(new URL('./stream.ts', import.meta.url), 'utf8');
  assert.match(streamSource, /enableModelToolCalls: config\.ENABLE_MODEL_TOOL_CALLS/);

  const output = [];
  const originalWarn = console.warn;
  console.warn = (...args) => output.push(args.join(' '));
  try {
    checkHostedAccess(request({
      socket: { remoteAddress: '203.0.113.8' },
      headers: { cookie: `${DEMO_ACCESS_COOKIE}=COOKIE-CANARY` },
    }), 'TOKEN-CANARY');
  } finally {
    console.warn = originalWarn;
  }
  const serialized = output.join('\n');
  for (const canary of ['SBOM-CONTENT-CANARY', 'COOKIE-CANARY', 'TOKEN-CANARY', 'sk-key-canary']) {
    assert.doesNotMatch(serialized, new RegExp(canary));
  }
});
