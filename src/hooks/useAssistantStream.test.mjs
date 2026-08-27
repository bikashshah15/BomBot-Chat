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
