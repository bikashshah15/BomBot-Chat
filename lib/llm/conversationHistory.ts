import { config } from '../config.ts';
import {
  appendConversationMessageOrThrow,
  getConversationMessages,
} from '../db/conversations.ts';
import type { ConversationMessage } from '../db/types.ts';
import { createLlmGateway } from './gateway.ts';
import type {
  LlmContinuation,
  LlmMessage,
  LlmResult,
  LlmToolDef,
} from './types.ts';

function toLlmMessage(message: ConversationMessage): LlmMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
    ...(message.tool_calls ? { toolCalls: message.tool_calls } : {}),
  };
}

export async function loadConversationHistory(conversationId: string): Promise<{
  rows: ConversationMessage[];
  messages: LlmMessage[];
  nextSeq: number;
}> {
  const rows = await getConversationMessages(conversationId, config.MAX_HISTORY_TURNS);
  return {
    rows,
    messages: rows.map(toLlmMessage),
    nextSeq: (rows.at(-1)?.seq ?? 0) + 1,
  };
}

export async function completeConversationMessages(options: {
  conversationId: string;
  instructions: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  continuation?: LlmContinuation;
}): Promise<LlmResult> {
  const history = await loadConversationHistory(options.conversationId);
  let nextSeq = history.nextSeq;

  for (const message of options.messages) {
    await appendConversationMessageOrThrow({
      conversation_id: options.conversationId,
      seq: nextSeq,
      role: message.role,
      content: message.content,
      tool_call_id: message.toolCallId ?? null,
      tool_calls: message.toolCalls ?? null,
    });
    nextSeq += 1;
  }

  const gateway = createLlmGateway();
  const response = await gateway.complete({
    messages: [
      { role: 'system', content: options.instructions },
      ...history.messages,
      ...options.messages,
    ],
    tools: options.tools,
    ...(options.continuation ? { continuation: options.continuation } : {}),
  });

  await appendConversationMessageOrThrow({
    conversation_id: options.conversationId,
    seq: nextSeq,
    role: 'assistant',
    content: response.content,
    tool_call_id: null,
    tool_calls: response.toolCalls.length > 0 ? response.toolCalls : null,
  });

  return response;
}
