import assert from 'node:assert/strict';
import test from 'node:test';

const {
  advanceAssistantStreamMessageIndex,
  appendAssistantStreamState,
  discardAssistantStreamState,
  endAssistantStreamState,
  resetAssistantStreamState,
  startAssistantStreamState,
} = await import('./assistantStreamState.ts');

const timestamp = new Date('2026-01-01T00:00:00.000Z');

function start() {
  return startAssistantStreamState({ messages: [], messageIndex: 7 }, 'stream-1', timestamp);
}

test('first and subsequent deltas update the live message in arrival order', () => {
  let state = start();
  state.messages = appendAssistantStreamState(state.messages, 'stream-1', 'first');
  assert.equal(state.messages[0].content, 'first');

  state.messages = appendAssistantStreamState(state.messages, 'stream-1', ' second');
  state.messages = appendAssistantStreamState(state.messages, 'stream-1', ' third');
  assert.equal(state.messages[0].content, 'first second third');
});

test('identical final text does not duplicate the accumulated response', () => {
  let state = start();
  state.messages = appendAssistantStreamState(state.messages, 'stream-1', 'complete response');
  state.messages = endAssistantStreamState(state.messages, 'stream-1', 'complete response');

  assert.equal(state.messages[0].content, 'complete response');
});

test('done fallback replaces an empty buffer with the response exactly once', () => {
  const state = start();
  const messages = endAssistantStreamState(state.messages, 'stream-1', 'fallback response');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'fallback response');
});

test('an error mid-stream removes the partial response before the existing error is added', () => {
  let state = start();
  state.messages = appendAssistantStreamState(state.messages, 'stream-1', 'partial');
  state.messages = discardAssistantStreamState(state.messages, 'stream-1');
  state.messages = [...state.messages, {
    id: 'error-1',
    type: 'assistant',
    content: '⚠️ There was an issue getting my response. Please try again.',
    timestamp,
  }];

  assert.deepEqual(state.messages.map(message => message.content), [
    '⚠️ There was an issue getting my response. Please try again.',
  ]);
});

test('tool start reset clears the live response', () => {
  let state = start();
  state.messages = appendAssistantStreamState(state.messages, 'stream-1', 'pre-tool text');
  state.messages = resetAssistantStreamState(state.messages, 'stream-1');

  assert.equal(state.messages[0].content, '');
});

test('messageIndex advances exactly once across a stream of N deltas', () => {
  let state = start();
  for (const delta of ['one', 'two', 'three', 'four']) {
    state.messages = appendAssistantStreamState(state.messages, 'stream-1', delta);
  }
  state.messages = endAssistantStreamState(state.messages, 'stream-1', 'onetwothreefour');

  assert.equal(state.messageIndex, 8);
  assert.equal(advanceAssistantStreamMessageIndex(7), 8);
});

test('an empty stream is removed at completion', () => {
  const state = start();

  assert.deepEqual(endAssistantStreamState(state.messages, 'stream-1', null), []);
  assert.deepEqual(endAssistantStreamState(state.messages, 'stream-1', ''), []);
});
