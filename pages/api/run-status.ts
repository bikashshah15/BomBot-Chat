import type { NextApiRequest, NextApiResponse } from 'next';
import { ConversationSequenceConflictError, getConversationSessionId } from '../../lib/db/conversations.ts';
import { updateAiResponse } from '../../lib/db/chatLogs.ts';
import { completeConversationMessages, loadConversationHistory } from '../../lib/llm/conversationHistory.ts';
import { createLlmGateway } from '../../lib/llm/gateway.ts';
import type { LlmMessage, LlmResult, LlmToolCall } from '../../lib/llm/types.ts';
import {
  BOMBOT_INSTRUCTIONS,
  BOMBOT_LLM_TOOLS,
  executeFunctionCall,
  formatOpenAIError,
  getToolContinuationIdempotencyKey,
  MAX_FUNCTION_CALL_ROUNDS,
} from '../../lib/openai-responses.ts';

function getResponseErrorMessage(response: LlmResult): string {
  if (response.error?.message) {
    return response.error.message;
  }

  if (response.incompleteDetails?.reason) {
    return `Response incomplete: ${response.incompleteDetails.reason}`;
  }

  if (response.status === 'cancelled') {
    return 'Response was cancelled';
  }

  return 'Response failed with an unknown error';
}

async function buildToolResultMessages(toolCalls: LlmToolCall[]): Promise<LlmMessage[]> {
  const messages: LlmMessage[] = [];

  for (const toolCall of toolCalls) {
    try {
      console.log(`Executing function: ${toolCall.name}`);
      messages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        content: await executeFunctionCall(toolCall.name, toolCall.arguments),
      });
    } catch (error) {
      console.error(`Function execution error for ${toolCall.name}:`, error);
      messages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        content: JSON.stringify({
          error: error instanceof Error ? error.message : 'Function execution failed',
          success: false,
        }),
      });
    }
  }

  return messages;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const {
    conversationId: requestedConversationId,
    responseId: requestedResponseId,
    threadId,
    runId,
    sessionId,
    messageIndex,
  } = req.query as {
    conversationId?: string;
    responseId?: string;
    threadId?: string;
    runId?: string;
    sessionId?: string;
    messageIndex?: string;
  };

  const conversationId = requestedConversationId || threadId;
  const responseId = requestedResponseId || runId;

  if (!conversationId || !responseId || !sessionId) {
    return res.status(400).json({
      error: 'conversationId, responseId, and sessionId are required',
    });
  }

  try {
    // This session UUID is a bearer capability, not authentication. It limits practical
    // conversation enumeration but does not protect a capability obtained by another party.
    if (await getConversationSessionId(conversationId) !== sessionId) {
      return res.status(403).json({ error: 'Conversation does not belong to this session' });
    }

    const history = await loadConversationHistory(conversationId);
    const latestMessage = history.rows.at(-1);
    if (!latestMessage || latestMessage.role !== 'assistant') {
      throw new Error('Conversation has no assistant response to resolve');
    }

    const currentTurnStart = history.rows.map(message => message.role).lastIndexOf('user');
    const storedToolCallResponses = history.rows
      .slice(Math.max(currentTurnStart, 0))
      .filter(message => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0)
      .length;
    let currentRound = Math.max(storedToolCallResponses - 1, 0);

    const gateway = createLlmGateway();
    // INC-06: remove — local completion returns the result without hosted polling.
    let response = await gateway.resolve({
      result: {
        content: latestMessage.content,
        toolCalls: latestMessage.tool_calls ?? [],
        done: true,
        responseId,
        conversationId,
        status: 'completed',
      },
    });
    const effectiveConversationId = conversationId;
    const successorResponseIds: string[] = [];
    let toolCallsProcessed = 0;

    while (response.status === 'completed' && response.toolCalls.length > 0) {
      if (currentRound >= MAX_FUNCTION_CALL_ROUNDS) {
        throw new Error(`Function calling exceeded the maximum of ${MAX_FUNCTION_CALL_ROUNDS} consecutive rounds`);
      }
      if (!response.responseId) {
        throw new Error('LLM provider did not return a predecessor response ID');
      }

      const predecessorResponseId = response.responseId;
      const toolResultMessages = await buildToolResultMessages(response.toolCalls);
      toolCallsProcessed += response.toolCalls.length;
      response = await completeConversationMessages({
        conversationId,
        instructions: BOMBOT_INSTRUCTIONS,
        messages: toolResultMessages,
        tools: BOMBOT_LLM_TOOLS,
        continuation: {
          round: currentRound + 1,
          predecessorResponseId,
          idempotencyKey: getToolContinuationIdempotencyKey(predecessorResponseId),
        },
      });
      if (!response.responseId) {
        throw new Error('LLM provider did not return a successor response ID');
      }
      currentRound += 1;
      successorResponseIds.push(response.responseId);
    }

    if (!response.responseId) {
      throw new Error('LLM provider did not return a response ID');
    }
    const responseWasReplaced = response.responseId !== responseId;

    const ids = {
      conversationId: effectiveConversationId,
      responseId: response.responseId,
      threadId: effectiveConversationId,
      runId: response.responseId,
    };

    if (toolCallsProcessed > 0 && response.status !== 'completed') {
      return res.status(200).json({
        ...ids,
        status: 'requires_action',
        responseStatus: response.status,
        completed: false,
        action: 'tool_outputs_submitted',
        tool_calls: toolCallsProcessed,
        previousResponseId: responseWasReplaced ? responseId : undefined,
        successorResponseIds,
        run: {
          id: response.responseId,
          created_at: response.createdAt,
        },
      });
    }

    if (response.status === 'completed') {
      const responseText = response.content;

      // Log AI response to the application-owned datastore when row identity is present.
      if (sessionId && messageIndex && responseText) {
        try {
          const updatedRows = await updateAiResponse(
            sessionId,
            Number.parseInt(messageIndex, 10),
            responseText,
          );
          if (updatedRows.length === 0) {
            throw new Error('No chat log row matched the AI response update');
          }
        } catch (logError) {
          console.error('Error logging AI response:', logError);
          // Continue even if logging fails.
        }
      }

      return res.status(200).json({
        ...ids,
        status: response.status,
        completed: true,
        response: responseText,
        previousResponseId: responseWasReplaced ? responseId : undefined,
        successorResponseIds,
        run: {
          id: response.responseId,
          created_at: response.createdAt,
          completed_at: response.completedAt,
          model: response.model,
          usage: response.rawUsage ?? response.usage ?? null,
        },
      });
    }

    if (response.status === 'failed' || response.status === 'cancelled' || response.status === 'incomplete') {
      return res.status(200).json({
        ...ids,
        status: 'failed',
        responseStatus: response.status,
        completed: true,
        error: getResponseErrorMessage(response),
        previousResponseId: responseWasReplaced ? responseId : undefined,
        successorResponseIds,
        run: {
          id: response.responseId,
          created_at: response.createdAt,
          failed_at: response.completedAt || null,
          last_error: response.error ?? response.incompleteDetails,
        },
      });
    }

    return res.status(200).json({
      ...ids,
      status: response.status,
      completed: false,
      previousResponseId: responseWasReplaced ? responseId : undefined,
      successorResponseIds,
      run: {
        id: response.responseId,
        created_at: response.createdAt,
        started_at: null,
      },
    });
  } catch (error) {
    if (error instanceof ConversationSequenceConflictError) {
      return res.status(409).json({ error: 'Conversation changed while tool results were submitted' });
    }
    console.error('Response status check error:', error);
    return res.status(500).json({
      error: 'Failed to check response status',
      details: formatOpenAIError(error),
    });
  }
}
