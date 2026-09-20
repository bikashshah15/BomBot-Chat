import { safeLog, safeValue, errorClass } from '../../lib/logging/redact.ts';
import { createTimer, logTiming, timingToolName } from '../../lib/logging/timing.ts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { config } from '../../lib/config.ts';
import { updateAiResponse } from '../../lib/db/chatLogs.ts';
import {
  ConversationSequenceConflictError,
  getConversationSessionId,
} from '../../lib/db/conversations.ts';
import {
  loadConversationHistory,
  streamConversationMessages,
} from '../../lib/llm/conversationHistory.ts';
import type { LlmMessage, LlmResult, LlmToolCall } from '../../lib/llm/types.ts';
import {
  BOMBOT_INSTRUCTIONS,
  BOMBOT_LLM_TOOLS,
  executeFunctionCall,
  formatOpenAIError,
  getToolContinuationIdempotencyKey,
  MAX_FUNCTION_CALL_ROUNDS,
} from '../../lib/openai-responses.ts';

export type AssistantStreamEvent = 'delta' | 'tool_start' | 'tool_end' | 'done' | 'error';

type EmitEvent = (event: AssistantStreamEvent, data: Record<string, unknown>) => void;

interface AssistantTurnDependencies {
  loadHistory: typeof loadConversationHistory;
  streamMessages: typeof streamConversationMessages;
  executeTool: typeof executeFunctionCall;
  updateAiResponse: typeof updateAiResponse;
  enableModelToolCalls: boolean;
  now?: () => number;
}

const defaultTurnDependencies: AssistantTurnDependencies = {
  loadHistory: loadConversationHistory,
  streamMessages: streamConversationMessages,
  executeTool: executeFunctionCall,
  updateAiResponse,
  enableModelToolCalls: config.ENABLE_MODEL_TOOL_CALLS,
  now: () => performance.now(),
};

interface ToolTimingRecord {
  round: number;
  tool: ReturnType<typeof timingToolName>;
  ms: number;
  ok: boolean;
}

function getResponseErrorMessage(response: LlmResult): string {
  if (response.error?.message) return response.error.message;
  if (response.incompleteDetails?.reason) {
    return `Response incomplete: ${response.incompleteDetails.reason}`;
  }
  if (response.status === 'cancelled') return 'Response was cancelled';
  return 'Response failed with an unknown error';
}

async function buildToolResultMessages(
  toolCalls: LlmToolCall[],
  executeTool: typeof executeFunctionCall,
  round: number,
  timer: ReturnType<typeof createTimer>,
  timingRecords: ToolTimingRecord[],
): Promise<LlmMessage[]> {
  const messages: LlmMessage[] = [];

  for (const toolCall of toolCalls) {
    const startedAt = timer.start();
    let ok = false;
    try {
      safeLog('log', safeValue("Executing function"));
      messages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        content: await executeTool(toolCall.name, toolCall.arguments),
      });
      ok = true;
    } catch (error) {
      safeLog('error', safeValue("Function execution error"), safeValue(errorClass(error)));
      messages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        content: JSON.stringify({
          error: error instanceof Error ? error.message : 'Function execution failed',
          success: false,
        }),
      });
    } finally {
      timingRecords.push({
        round,
        tool: timingToolName(toolCall.name),
        ms: timer.since(startedAt),
        ok,
      });
    }
  }

  return messages;
}

export async function runAssistantTurn(
  options: {
    conversationId: string;
    sessionId: string;
    messageIndex?: string;
  },
  emit: EmitEvent,
  dependencies: AssistantTurnDependencies = defaultTurnDependencies,
): Promise<void> {
  const timer = createTimer(dependencies.now ?? (() => performance.now()));
  const totalStartedAt = timer.start();
  let historyLoadMs: number | null = null;
  let persistMs: number | null = null;
  let outcome: 'completed' | 'model_error' | 'exception' | 'sequence_conflict' = 'exception';
  const rounds: Array<{
    db_prep_ms: number | null;
    model_first_chunk_ms: number | null;
    model_stream_ms: number | null;
    db_append_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    tool_calls_requested: number | null;
  }> = [];
  const tools: ToolTimingRecord[] = [];

  try {
  const historyStartedAt = timer.start();
  const history = await dependencies.loadHistory(options.conversationId);
  historyLoadMs = timer.since(historyStartedAt);
  const latestMessage = history.rows.at(-1);
  if (!latestMessage || latestMessage.role !== 'user') {
    throw new Error('Conversation has no pending user message to stream');
  }

  const currentTurnStart = history.rows.map(message => message.role).lastIndexOf('user');
  const storedToolCallResponses = history.rows
    .slice(Math.max(currentTurnStart, 0))
    .filter(message => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0)
    .length;
  let currentRound = Math.max(storedToolCallResponses - 1, 0);

  const streamMessages = async (messages: LlmMessage[], continuation?: {
    round: number;
    predecessorResponseId: string;
    idempotencyKey: string;
  }) => {
    const callStartedAt = timer.start();
    let modelStartedAt: number | null = null;
    let modelEndedAt: number | null = null;
    let dbPrepMs: number | null = null;
    let firstChunkMs: number | null = null;
    let modelStreamMs: number | null = null;
    let response: LlmResult | undefined;
    try {
      response = await dependencies.streamMessages({
        conversationId: options.conversationId,
        instructions: BOMBOT_INSTRUCTIONS,
        messages,
        ...(dependencies.enableModelToolCalls ? { tools: BOMBOT_LLM_TOOLS } : {}),
        ...(continuation ? { continuation } : {}),
        onChunk(chunk) {
          if (firstChunkMs === null && modelStartedAt !== null
            && (Boolean(chunk.delta) || (chunk.toolCalls?.length ?? 0) > 0)) {
            firstChunkMs = timer.since(modelStartedAt);
          }
          if (chunk.delta) emit('delta', { delta: chunk.delta });
        },
        onTiming(mark) {
          if (mark === 'model_request_start') {
            modelStartedAt = timer.start();
            dbPrepMs = timer.since(callStartedAt);
          } else if (modelStartedAt !== null) {
            modelEndedAt = timer.start();
            modelStreamMs = timer.since(modelStartedAt);
          }
        },
      });
      return response;
    } finally {
      rounds.push({
        db_prep_ms: dbPrepMs,
        model_first_chunk_ms: firstChunkMs,
        model_stream_ms: modelStreamMs,
        db_append_ms: modelEndedAt === null ? null : timer.since(modelEndedAt),
        input_tokens: response?.usage?.inputTokens ?? null,
        output_tokens: response?.usage?.outputTokens ?? null,
        tool_calls_requested: response?.toolCalls.length ?? null,
      });
    }
  };

  let response = await streamMessages([]);
  let toolCallsProcessed = 0;

  while (response.status === 'completed' && response.toolCalls.length > 0) {
    if (currentRound >= MAX_FUNCTION_CALL_ROUNDS) {
      throw new Error(
        `Function calling exceeded the maximum of ${MAX_FUNCTION_CALL_ROUNDS} consecutive rounds`,
      );
    }
    if (!response.responseId) {
      throw new Error('LLM provider did not return a predecessor response ID');
    }

    const predecessorResponseId = response.responseId;
    const nextRound = currentRound + 1;
    emit('tool_start', { round: nextRound, toolCalls: response.toolCalls.length });
    const toolResultMessages = await buildToolResultMessages(
      response.toolCalls,
      dependencies.executeTool,
      nextRound,
      timer,
      tools,
    );
    toolCallsProcessed += response.toolCalls.length;
    response = await streamMessages(toolResultMessages, {
      round: nextRound,
      predecessorResponseId,
      idempotencyKey: getToolContinuationIdempotencyKey(predecessorResponseId),
    });
    currentRound = nextRound;
    emit('tool_end', { round: currentRound, toolCalls: toolResultMessages.length });
  }

  if (response.status === 'failed' || response.status === 'cancelled' || response.status === 'incomplete') {
    outcome = 'model_error';
    emit('error', {
      error: getResponseErrorMessage(response),
      responseStatus: response.status,
      toolCallsProcessed,
    });
    return;
  }

  if (response.status !== 'completed') {
    outcome = 'model_error';
    emit('error', {
      error: `Response ended with non-terminal status: ${response.status}`,
      responseStatus: response.status,
      toolCallsProcessed,
    });
    return;
  }

  if (!response.responseId) {
    throw new Error('LLM provider did not return a response ID');
  }

  if (options.messageIndex && response.content) {
    const persistStartedAt = timer.start();
    try {
      const updatedRows = await dependencies.updateAiResponse(
        options.sessionId,
        Number.parseInt(options.messageIndex, 10),
        response.content,
      );
      if (updatedRows.length === 0) {
        throw new Error('No chat log row matched the AI response update');
      }
    } catch (logError) {
      safeLog('error', safeValue("Error logging AI response:"), safeValue(errorClass(logError)));
    } finally {
      persistMs = timer.since(persistStartedAt);
    }
  }

  outcome = 'completed';
  emit('done', {
    conversationId: options.conversationId,
    responseId: response.responseId,
    response: response.content,
    status: response.status,
    toolCallsProcessed,
  });
  } catch (error) {
    outcome = error instanceof ConversationSequenceConflictError
      ? 'sequence_conflict'
      : 'exception';
    throw error;
  } finally {
    logTiming({
      kind: 'chat_turn',
      tools_enabled: Boolean(dependencies.enableModelToolCalls),
      outcome,
      history_load_ms: historyLoadMs,
      rounds,
      tools,
      persist_ms: persistMs,
      total_ms: timer.since(totalStartedAt),
    });
  }
}

interface StreamHandlerDependencies {
  getConversationSessionId: typeof getConversationSessionId;
  runTurn: typeof runAssistantTurn;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

const defaultHandlerDependencies: StreamHandlerDependencies = {
  getConversationSessionId,
  runTurn: runAssistantTurn,
  setInterval,
  clearInterval,
};

export function createStreamHandler(
  overrides: Partial<StreamHandlerDependencies> = {},
) {
  const dependencies = { ...defaultHandlerDependencies, ...overrides };

  return async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { conversationId, sessionId, messageIndex } = req.query as {
      conversationId?: string;
      sessionId?: string;
      messageIndex?: string;
    };
    if (!conversationId || !sessionId) {
      return res.status(400).json({ error: 'conversationId and sessionId are required' });
    }

    try {
      // This session UUID is a bearer capability, not authentication. It limits practical
      // conversation enumeration but does not protect a capability obtained by another party.
      if (await dependencies.getConversationSessionId(conversationId) !== sessionId) {
        return res.status(403).json({ error: 'Conversation does not belong to this session' });
      }
    } catch (error) {
      safeLog('error', safeValue("Stream binding check error:"), safeValue(errorClass(error)));
      return res.status(500).json({ error: 'Failed to validate conversation session' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const emit: EmitEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = dependencies.setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15_000);

    try {
      await dependencies.runTurn({ conversationId, sessionId, messageIndex }, emit);
    } catch (error) {
      const sequenceConflict = error instanceof ConversationSequenceConflictError;
      if (!sequenceConflict) safeLog('error', safeValue("Assistant stream error:"), safeValue(errorClass(error)));
      emit('error', {
        error: sequenceConflict
          ? 'Conversation changed while the assistant response was streamed'
          : formatOpenAIError(error),
        ...(sequenceConflict ? { code: 'conversation_sequence_conflict' } : {}),
      });
    } finally {
      dependencies.clearInterval(heartbeat);
      res.end();
    }
  };
}

export default createStreamHandler();
