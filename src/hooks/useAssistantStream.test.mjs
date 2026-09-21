import assert from 'node:assert/strict';
import test from 'node:test';

const { consumeAssistantEventStream } = await import('./useAssistantStream.ts');

test('wire deltas are buffered and the final assistant response renders once at done', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'event: delta\ndata: {"delta":"discarded pre-tool text"}\n\n',
    'event: tool_start\ndata: {"round":1}\n\n',
    ': heartbeat\n\n',
    'event: delta\ndata: {"delta":"final "}\n\n',
    'event: delta\ndata: {"delta":"response"}\n\n',
    'event: tool_end\ndata: {"round":1}\n\n',
    'event: done\ndata: {"response":"final response"}\n\n',
  ];
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
  const renderedResponses = [];
  const toolEvents = [];

  await consumeAssistantEventStream(response, {
    conversationId: 'conversation_synthetic',
    sessionId: 'session_synthetic',
    onDone(responseText) {
      renderedResponses.push(responseText);
    },
    onToolStart(round) {
      toolEvents.push(`start:${round}`);
    },
    onToolEnd(round) {
      toolEvents.push(`end:${round}`);
    },
  });

  assert.deepEqual(renderedResponses, ['final response']);
  assert.deepEqual(toolEvents, ['start:1', 'end:1']);
});

test('onDelta fires for every delta in order while onDone receives the full buffered text', async () => {
  const deltas = [];
  const completed = [];
  let firstDeltaCalls = 0;

  await consumeAssistantEventStream(responseFromChunks([
    'event: delta\ndata: {"delta":"first"}\n\n',
    'event: delta\ndata: {"delta":" second"}\n\n',
    'event: delta\ndata: {"delta":" third"}\n\n',
    'event: done\ndata: {"response":"fallback must not replace the buffer"}\n\n',
  ]), {
    conversationId: 'conversation_deltas',
    sessionId: 'session_deltas',
    onDelta(delta) {
      deltas.push(delta);
    },
    onFirstDelta() {
      firstDeltaCalls += 1;
    },
    onDone(responseText) {
      completed.push(responseText);
    },
  });

  assert.deepEqual(deltas, ['first', ' second', ' third']);
  assert.equal(firstDeltaCalls, 1);
  assert.deepEqual(completed, ['first second third']);
});

test('done response fallback is delivered once when the delta buffer is empty', async () => {
  const deltas = [];
  const completed = [];

  await consumeAssistantEventStream(responseFromChunks([
    'event: done\ndata: {"response":"fallback response"}\n\n',
  ]), {
    conversationId: 'conversation_fallback',
    sessionId: 'session_fallback',
    onDelta(delta) {
      deltas.push(delta);
    },
    onDone(responseText) {
      completed.push(responseText);
    },
  });

  assert.deepEqual(deltas, []);
  assert.deepEqual(completed, ['fallback response']);
});

test('tool_start resets the live stream alongside the buffered response', async () => {
  const liveDeltas = [];
  const events = [];

  await consumeAssistantEventStream(responseFromChunks([
    'event: delta\ndata: {"delta":"discarded"}\n\n',
    'event: tool_start\ndata: {"round":1}\n\n',
    'event: delta\ndata: {"delta":"kept"}\n\n',
    'event: done\ndata: {"response":"fallback"}\n\n',
  ]), {
    conversationId: 'conversation_reset',
    sessionId: 'session_reset',
    onDelta(delta) {
      liveDeltas.push(delta);
    },
    onResetStream() {
      events.push(`reset:${liveDeltas.join('')}`);
      liveDeltas.length = 0;
    },
    onDone(responseText) {
      events.push(`done:${responseText}`);
    },
  });

  assert.deepEqual(liveDeltas, ['kept']);
  assert.deepEqual(events, ['reset:discarded', 'done:kept']);
});

const {
  ASSISTANT_STREAM_INACTIVITY_TIMEOUT_MS,
  ASSISTANT_STREAM_MAX_DURATION_MS,
  createStreamWatchdog,
} = await import('./useAssistantStream.ts');

function responseFromChunks(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

test('onActivity fires once per complete frame including heartbeats and split frames', async () => {
  const chunks = [
    'event: delta\ndata: {"delta":"discarded',
    ' pre-tool text"}\n\nevent: tool_start\ndata: {"round":1}\n\n',
    ': heartbeat\n\n',
    'event: delta\ndata: {"delta":"final "}\n\n',
    'event: delta\ndata: {"delta":"response"}\n\n',
    'event: tool_end\ndata: {"round":1}\n\n',
    'event: done\ndata: {"response":"final response"}\n\n',
  ];
  let activityCount = 0;

  await consumeAssistantEventStream(responseFromChunks(chunks), {
    conversationId: 'conversation_activity',
    sessionId: 'session_activity',
    onActivity() {
      activityCount += 1;
    },
    onDone() {},
  });

  assert.equal(activityCount, 7);
});

test('onActivity leaves response rendering and tool callback forwarding unchanged', async () => {
  const renderedResponses = [];
  const toolEvents = [];

  await consumeAssistantEventStream(responseFromChunks([
    'event: delta\ndata: {"delta":"discarded"}\n\n',
    'event: tool_start\ndata: {"round":2}\n\n',
    ': heartbeat\n\n',
    'event: delta\ndata: {"delta":"kept"}\n\n',
    'event: tool_end\ndata: {"round":2}\n\n',
    'event: done\ndata: {"response":"fallback"}\n\n',
  ]), {
    conversationId: 'conversation_rendering',
    sessionId: 'session_rendering',
    onActivity() {},
    onDone(responseText) {
      renderedResponses.push(responseText);
    },
    onToolStart(round) {
      toolEvents.push(`start:${round}`);
    },
    onToolEnd(round) {
      toolEvents.push(`end:${round}`);
    },
  });

  assert.deepEqual(renderedResponses, ['kept']);
  assert.deepEqual(toolEvents, ['start:2', 'end:2']);
});

test('watchdog stays active through 29 minutes of 15-second activity', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const expirations = [];
  const watchdog = createStreamWatchdog({
    inactivityMs: ASSISTANT_STREAM_INACTIVITY_TIMEOUT_MS,
    maxDurationMs: ASSISTANT_STREAM_MAX_DURATION_MS,
    onExpire(reason) {
      expirations.push(reason);
    },
  });

  for (let elapsed = 15_000; elapsed <= 29 * 60_000; elapsed += 15_000) {
    context.mock.timers.tick(15_000);
    watchdog.touch();
  }

  assert.deepEqual(expirations, []);
});

test('watchdog expires once for 120 seconds of inactivity', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const expirations = [];
  createStreamWatchdog({
    inactivityMs: ASSISTANT_STREAM_INACTIVITY_TIMEOUT_MS,
    maxDurationMs: ASSISTANT_STREAM_MAX_DURATION_MS,
    onExpire(reason) {
      expirations.push(reason);
    },
  });

  context.mock.timers.tick(ASSISTANT_STREAM_INACTIVITY_TIMEOUT_MS);
  context.mock.timers.tick(ASSISTANT_STREAM_MAX_DURATION_MS);

  assert.deepEqual(expirations, ['inactivity']);
});

test('watchdog expires once at the overall maximum despite continuous activity', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const expirations = [];
  const watchdog = createStreamWatchdog({
    inactivityMs: ASSISTANT_STREAM_INACTIVITY_TIMEOUT_MS,
    maxDurationMs: ASSISTANT_STREAM_MAX_DURATION_MS,
    onExpire(reason) {
      expirations.push(reason);
    },
  });

  for (let elapsed = 15_000; elapsed <= 31 * 60_000; elapsed += 15_000) {
    context.mock.timers.tick(15_000);
    watchdog.touch();
  }

  assert.deepEqual(expirations, ['max_duration']);
});

test('watchdog stop prevents later expiry', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const expirations = [];
  const watchdog = createStreamWatchdog({
    inactivityMs: ASSISTANT_STREAM_INACTIVITY_TIMEOUT_MS,
    maxDurationMs: ASSISTANT_STREAM_MAX_DURATION_MS,
    onExpire(reason) {
      expirations.push(reason);
    },
  });

  watchdog.stop();
  context.mock.timers.tick(ASSISTANT_STREAM_MAX_DURATION_MS * 2);

  assert.deepEqual(expirations, []);
});

test('watchdog permits a ten-minute heartbeat stream to complete normally', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const expirations = [];
  const watchdog = createStreamWatchdog({
    inactivityMs: ASSISTANT_STREAM_INACTIVITY_TIMEOUT_MS,
    maxDurationMs: ASSISTANT_STREAM_MAX_DURATION_MS,
    onExpire(reason) {
      expirations.push(reason);
    },
  });

  for (let elapsed = 15_000; elapsed <= 10 * 60_000; elapsed += 15_000) {
    context.mock.timers.tick(15_000);
    watchdog.touch();
  }
  watchdog.stop();

  assert.deepEqual(expirations, []);
});
