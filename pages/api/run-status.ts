import { NextApiRequest, NextApiResponse } from 'next';
import { updateAiResponse } from '../../lib/db/chatLogs.ts';
import { createLlmGateway } from '../../lib/llm/gateway.ts';
import type { LlmMessage, LlmResult, LlmToolCall } from '../../lib/llm/types.ts';
import {
  BOMBOT_INSTRUCTIONS,
  BOMBOT_LLM_TOOLS,
  executeFunctionCall,
  formatOpenAIError,
  getToolContinuationIdempotencyKey,
  MAX_FUNCTION_CALL_ROUNDS,
  TOOL_ROUND_METADATA_KEY,
} from '../../lib/openai-responses';

function getFunctionCallingRound(response: LlmResult): number {
  const value = response.metadata?.[TOOL_ROUND_METADATA_KEY];
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return 0;
  }

  const round = Number.parseInt(value, 10);
  return Number.isSafeInteger(round) ? round : 0;
}

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

  if (!conversationId || !responseId) {
    return res.status(400).json({
      error: 'Both conversationId and responseId are required',
    });
  }

  try {
    const gateway = createLlmGateway({ openAI: { conversationId } });
    // INC-06: remove — local completion returns the result without hosted polling.
    let response = await gateway.resolve({ responseId, conversationId });
    const effectiveConversationId = response.conversationId || conversationId;
    const successorResponseIds: string[] = [];
    let toolCallsProcessed = 0;

    while (response.status === 'completed' && response.toolCalls.length > 0) {
      const currentRound = getFunctionCallingRound(response);
      if (currentRound >= MAX_FUNCTION_CALL_ROUNDS) {
        throw new Error(`Function calling exceeded the maximum of ${MAX_FUNCTION_CALL_ROUNDS} consecutive rounds`);
      }
      if (!response.responseId) {
        throw new Error('LLM provider did not return a predecessor response ID');
      }

      const predecessorResponseId = response.responseId;
      const toolResultMessages = await buildToolResultMessages(response.toolCalls);
      toolCallsProcessed += response.toolCalls.length;
      response = await gateway.complete({
        messages: [
          { role: 'system', content: BOMBOT_INSTRUCTIONS },
          {
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
          },
          ...toolResultMessages,
        ],
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
    console.error('Response status check error:', error);
    return res.status(500).json({
      error: 'Failed to check response status',
      details: formatOpenAIError(error),
    });
  }
}
