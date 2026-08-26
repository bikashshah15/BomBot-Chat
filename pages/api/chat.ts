import { NextApiRequest, NextApiResponse } from 'next';
import { supabaseServer } from '@/lib/supabase-server';
import { createLlmGateway } from '../../lib/llm/gateway.ts';
import {
  BOMBOT_INSTRUCTIONS,
  BOMBOT_LLM_TOOLS,
  formatOpenAIError,
} from '../../lib/openai-responses';
import { v4 as uuidv4 } from 'uuid';

interface ChatRequest {
  message: string;
  conversationId?: string;
  threadId?: string;
  sessionId: string;
  messageIndex: number;
  userEmail?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { message, conversationId: requestedConversationId, threadId, sessionId, messageIndex, userEmail }: ChatRequest = req.body;
  const conversationId = requestedConversationId || threadId;

  if (!message || !conversationId || !sessionId || messageIndex === undefined) {
    return res.status(400).json({ 
      error: 'Message, conversationId, sessionId, and messageIndex are required'
    });
  }

  try {
    // Log user message to Supabase
    try {
              await supabaseServer
        .from('chat_logs')
        .insert([{
          id: uuidv4(),
          session_id: sessionId,
          thread_id: conversationId,
          message_index: messageIndex,
          message_type: 'user',
          user_message: message,
          ai_response: null,
          file_name: null,
          file_size: null,
          vulnerability_count: null,
          user_email: userEmail,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }]);
    } catch (logError) {
      console.error('Error logging user message:', logError);
      // Continue with the chat even if logging fails
    }

    const gateway = createLlmGateway({ openAI: { conversationId } });
    const response = await gateway.complete({
      messages: [
        { role: 'system', content: BOMBOT_INSTRUCTIONS },
        { role: 'user', content: message },
      ],
      tools: BOMBOT_LLM_TOOLS,
    });

    if (!response.responseId) {
      throw new Error('LLM provider did not return a response ID');
    }

    return res.status(200).json({ 
      success: true,
      conversationId,
      responseId: response.responseId,
      threadId: conversationId,
      runId: response.responseId,
      message: message,
      sessionId: sessionId,
      messageIndex: messageIndex
    });

  } catch (error) {
    console.error('Chat API error:', error);
    res.status(500).json({ 
      error: 'Failed to send message to assistant',
      details: formatOpenAIError(error)
    });
  }
}
