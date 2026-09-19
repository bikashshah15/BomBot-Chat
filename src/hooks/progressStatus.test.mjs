import assert from 'node:assert/strict';
import test from 'node:test';

const { consumeAssistantEventStream } = await import('./useAssistantStream.ts');
const {
  formatElapsed,
  getProgressStatus,
} = await import('./progressStatus.ts');

test('progress status uses exact response strings and elapsed formatting', () => {
  const cases = [
    [0, '0s'],
    [59_000, '59s'],
    [60_000, '1m 0s'],
    [72_000, '1m 12s'],
    [1_166_000, '19m 26s'],
  ];

  for (const [elapsedMs, expected] of cases) {
    assert.equal(formatElapsed(elapsedMs), expected);
    const status = getProgressStatus({
      phase: 'response',
      elapsedMs,
      msSinceActivity: 0,
    });
    assert.equal(status.primary, 'Preparing response…');
    assert.equal(status.elapsed, expected);
  }
});

test('progress notices appear at their exact thresholds in the required order', () => {
  assert.deepEqual(getProgressStatus({
    phase: 'response',
    elapsedMs: 59_999,
    msSinceActivity: 29_999,
  }).notices, []);

  assert.deepEqual(getProgressStatus({
    phase: 'response',
    elapsedMs: 60_000,
    msSinceActivity: 30_000,
  }).notices, [
    'This response is taking longer than usual. Please keep this page open.',
    'Still waiting for the server…',
  ]);
});

test('upload progress ignores elapsed time and inactivity', () => {
  assert.deepEqual(getProgressStatus({
    phase: 'upload',
    elapsedMs: 9_999_999,
    msSinceActivity: 9_999_999,
  }), {
    primary: 'Uploading and scanning your SBOM…',
    elapsed: null,
    notices: [],
  });
});

function responseFromFrames(frames) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`));
      controller.close();
    },
  }));
}

async function replayStatusSequence(frames, activityTimes, durationMs) {
  const observedActivityTimes = [];
  await consumeAssistantEventStream(responseFromFrames(frames), {
    conversationId: 'conversation_parity',
    sessionId: 'session_parity',
    onActivity() {
      observedActivityTimes.push(activityTimes[observedActivityTimes.length]);
    },
    onDone() {},
  });

  assert.deepEqual(observedActivityTimes, activityTimes);
  const sequence = [];
  for (let elapsedMs = 0; elapsedMs <= durationMs; elapsedMs += 1_000) {
    const priorActivity = observedActivityTimes.filter((time) => time <= elapsedMs).at(-1) ?? 0;
    sequence.push(getProgressStatus({
      phase: 'response',
      elapsedMs,
      msSinceActivity: elapsedMs - priorActivity,
    }));
  }
  return sequence;
}

test('tools-on and tools-off frame replays produce identical status sequences', async () => {
  const activityTimes = [0, 10_000, 20_000, 40_000, 45_000];
  const toolsOnFrames = [
    'event: delta\ndata: {"delta":"draft"}',
    'event: tool_start\ndata: {"round":1}',
    'event: tool_end\ndata: {"round":1}',
    ': heartbeat',
    'event: done\ndata: {"response":"complete"}',
  ];
  const toolsOffFrames = [
    'event: delta\ndata: {"delta":"part one"}',
    ': heartbeat',
    ': heartbeat',
    ': heartbeat',
    'event: done\ndata: {"response":"part one"}',
  ];

  const [toolsOn, toolsOff] = await Promise.all([
    replayStatusSequence(toolsOnFrames, activityTimes, 45_000),
    replayStatusSequence(toolsOffFrames, activityTimes, 45_000),
  ]);

  assert.deepEqual(toolsOn, toolsOff);
});
