import { NextApiRequest, NextApiResponse } from 'next';
import { supabaseServer } from '@/lib/supabase-server';
import {
  continueFunctionCallingLoop,
  extractResponseText,
  formatOpenAIError,
  getResponseErrorMessage,
  getResponseUsage,
  retrieveResponse,
} from '../../lib/openai-responses';

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
    const retrievedResponse = await retrieveResponse(responseId);
    const effectiveConversationId = retrievedResponse.conversation?.id || conversationId;
    const loopResult = await continueFunctionCallingLoop(
      retrievedResponse,
      effectiveConversationId,
    );
    const response = loopResult.response;
    const responseWasReplaced = response.id !== responseId;

    const ids = {
      conversationId: effectiveConversationId,
      responseId: response.id,
      threadId: effectiveConversationId,
      runId: response.id,
    };

    if (loopResult.toolCallsProcessed > 0 && response.status !== 'completed') {
      return res.status(200).json({
        ...ids,
        status: 'requires_action',
        responseStatus: response.status,
        completed: false,
        action: 'tool_outputs_submitted',
        tool_calls: loopResult.toolCallsProcessed,
        previousResponseId: responseWasReplaced ? responseId : undefined,
        successorResponseIds: loopResult.successorResponseIds,
        run: {
          id: response.id,
          created_at: response.created_at,
        },
      });
    }

    if (response.status === 'completed') {
      const responseText = extractResponseText(response);

      // Log AI response to Supabase if sessionId and messageIndex are provided.
      if (sessionId && messageIndex && responseText) {
        try {
          await supabaseServer
            .from('chat_logs')
            .update({
              ai_response: responseText,
              updated_at: new Date().toISOString(),
            })
            .eq('session_id', sessionId)
            .eq('message_index', parseInt(messageIndex));
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
        successorResponseIds: loopResult.successorResponseIds,
        run: {
          id: response.id,
          created_at: response.created_at,
          completed_at: response.completed_at,
          model: response.model,
          usage: getResponseUsage(response),
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
        successorResponseIds: loopResult.successorResponseIds,
        run: {
          id: response.id,
          created_at: response.created_at,
          failed_at: response.completed_at || null,
          last_error: response.error || response.incomplete_details,
        },
      });
    }

    return res.status(200).json({
      ...ids,
      status: response.status,
      completed: false,
      previousResponseId: responseWasReplaced ? responseId : undefined,
      successorResponseIds: loopResult.successorResponseIds,
      run: {
        id: response.id,
        created_at: response.created_at,
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
