import { config } from '../config.ts';
import {
  appendConversationMessageOrThrow,
  getConversationMessages,
} from '../db/conversations.ts';
import type { ConversationMessage } from '../db/types.ts';
import { createLlmGateway } from './gateway.ts';
import type {
  LlmChunk,
  LlmContinuation,
  LlmMessage,
  LlmResult,
  LlmToolDef,
} from './types.ts';

async function appendMessages(
  conversationId: string,
  messages: LlmMessage[],
  nextSeq: number,
  pinned = false,
): Promise<number> {
  for (const message of messages) {
    await appendConversationMessageOrThrow({
      conversation_id: conversationId,
      seq: nextSeq,
      role: message.role,
      content: message.content,
      tool_call_id: message.toolCallId ?? null,
      tool_calls: message.toolCalls ?? null,
      pinned,
    });
    nextSeq += 1;
  }

  return nextSeq;
}

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
  const rows = await getConversationMessages(conversationId, config.MAX_HISTORY_MESSAGES);
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
  tools?: LlmToolDef[];
  continuation?: LlmContinuation;
}): Promise<LlmResult> {
  const history = await loadConversationHistory(options.conversationId);
  const nextSeq = await appendMessages(
    options.conversationId,
    options.messages,
    history.nextSeq,
  );

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
    pinned: false,
  });

  return response;
}

export async function appendConversationMessages(options: {
  conversationId: string;
  messages: LlmMessage[];
  pinned?: boolean;
}): Promise<void> {
  const history = await loadConversationHistory(options.conversationId);
  await appendMessages(
    options.conversationId,
    options.messages,
    history.nextSeq,
    options.pinned ?? false,
  );
}

export async function streamConversationMessages(options: {
  conversationId: string;
  instructions: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  continuation?: LlmContinuation;
  onChunk?: (chunk: LlmChunk) => void | Promise<void>;
}): Promise<LlmResult> {
  const history = await loadConversationHistory(options.conversationId);
  const nextSeq = await appendMessages(
    options.conversationId,
    options.messages,
    history.nextSeq,
  );
  const gateway = createLlmGateway();
  let streamedContent = '';
  const streamedToolCalls = [] as LlmResult['toolCalls'];
  let response: LlmResult | undefined;

  for await (const chunk of gateway.stream({
    messages: [
      { role: 'system', content: options.instructions },
      ...history.messages,
      ...options.messages,
    ],
    tools: options.tools,
    ...(options.continuation ? { continuation: options.continuation } : {}),
  })) {
    if (chunk.delta) streamedContent += chunk.delta;
    if (chunk.toolCalls) streamedToolCalls.push(...chunk.toolCalls);
    if (chunk.result) response = chunk.result;
    await options.onChunk?.(chunk);
  }

  response ??= {
    content: streamedContent,
    toolCalls: streamedToolCalls,
    done: true,
    status: 'completed',
  };
  if (!response.content && streamedContent) response.content = streamedContent;
  if (response.toolCalls.length === 0 && streamedToolCalls.length > 0) {
    response.toolCalls = streamedToolCalls;
  }

  await appendConversationMessageOrThrow({
    conversation_id: options.conversationId,
    seq: nextSeq,
    role: 'assistant',
    content: response.content,
    tool_call_id: null,
    tool_calls: response.toolCalls.length > 0 ? response.toolCalls : null,
    pinned: false,
  });

  return response;
}
