import { safeLog, safeValue, errorClass } from '../../lib/logging/redact.ts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { insertLog } from '../../lib/db/chatLogs.ts';
import {
  ConversationSequenceConflictError,
  getConversationProviderId,
  getConversationSessionId,
} from '../../lib/db/conversations.ts';
import { appendConversationMessages } from '../../lib/llm/conversationHistory.ts';
import { config } from '../../lib/config.ts';
import { resolveProviderSettings } from '../../lib/llm/providerRegistry.ts';
import { formatOpenAIError } from '../../lib/openai-responses.ts';
import { v4 as uuidv4 } from 'uuid';

interface ChatRequest {
  message: string;
  conversationId?: string;
  threadId?: string;
  sessionId: string;
  messageIndex: number;
  userEmail?: string;
}

interface ChatHandlerDependencies {
  insertLog: typeof insertLog;
  getConversationSessionId: typeof getConversationSessionId;
  appendConversationMessages: typeof appendConversationMessages;
  getConversationProviderId: typeof getConversationProviderId;
  resolveProviderSettings: typeof resolveProviderSettings;
  enableModelToggle: boolean;
}

export function createChatHandler(overrides: Partial<ChatHandlerDependencies> = {}) {
  const dependencies: ChatHandlerDependencies = {
    insertLog,
    getConversationSessionId,
    appendConversationMessages,
    getConversationProviderId,
    resolveProviderSettings,
    enableModelToggle: config.ENABLE_MODEL_TOGGLE,
    ...overrides,
  };

  return async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (req.body && (Object.prototype.hasOwnProperty.call(req.body, 'provider')
    || Object.prototype.hasOwnProperty.call(req.body, 'providerId'))) {
    return res.status(400).json({ error: 'Provider may only be selected when creating a conversation' });
  }

  const { message, conversationId: requestedConversationId, threadId, sessionId, messageIndex, userEmail }: ChatRequest = req.body;
  const conversationId = requestedConversationId || threadId;

  if (!message || !conversationId || !sessionId || messageIndex === undefined) {
    return res.status(400).json({ 
      error: 'Message, conversationId, sessionId, and messageIndex are required'
    });
  }

  try {
    // This session UUID is a bearer capability, not authentication. It limits practical
    // conversation enumeration but does not protect a capability obtained by another party.
    if (await dependencies.getConversationSessionId(conversationId) !== sessionId) {
      return res.status(403).json({ error: 'Conversation does not belong to this session' });
    }


    const providerId = await dependencies.getConversationProviderId(conversationId);
    if (!providerId) return res.status(404).json({ error: 'Conversation not found' });
    if (!dependencies.enableModelToggle && providerId !== 'primary') {
      return res.status(403).json({ error: 'Model provider selection is disabled' });
    }
    dependencies.resolveProviderSettings(providerId);

    // Log user message to the application-owned datastore.
    try {
      const now = new Date().toISOString();
      await dependencies.insertLog({
        id: uuidv4(),
        session_id: sessionId,
        conversation_id: conversationId,
        message_index: messageIndex,
        message_type: 'user',
        user_message: message,
        ai_response: null,
        file_name: null,
        file_size: null,
        vulnerability_count: null,
        user_email: userEmail ?? null,
        created_at: now,
        updated_at: now,
      });
    } catch (logError) {
      safeLog('error', safeValue("Error logging user message:"), safeValue(errorClass(logError)));
      // Continue with the chat even if logging fails
    }

    await dependencies.appendConversationMessages({
      conversationId,
      messages: [{ role: 'user', content: message }],
    });

    return res.status(200).json({ 
      success: true,
      conversationId,
      threadId: conversationId,
      message: message,
      sessionId: sessionId,
      messageIndex: messageIndex
    });

  } catch (error) {
    if (error instanceof ConversationSequenceConflictError) {
      return res.status(409).json({ error: 'Conversation changed while this message was submitted' });
    }
    safeLog('error', safeValue("Chat API error:"), safeValue(errorClass(error)));
    res.status(500).json({ 
      error: 'Failed to send message to assistant',
      details: formatOpenAIError(error)
    });
  }
  };
}

export default createChatHandler();
