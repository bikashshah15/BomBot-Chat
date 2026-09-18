import { safeLog, safeValue, errorClass } from '../../lib/logging/redact.ts';
import type { ChatLog } from '../../lib/db/types.ts';

export interface LogChatMessageParams {
  sessionId: string;
  conversationId?: string | null;
  messageIndex: number;
  messageType: 'user' | 'assistant' | 'file_upload';
  userMessage?: string | null;
  aiResponse?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  vulnerabilityCount?: number | null;
  userEmail?: string | null;
}

export class ChatLogger {
  static async logMessage(params: LogChatMessageParams): Promise<ChatLog | null> {
    try {
      const response = await fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'log_message',
          ...params,
        }),
      });

      if (!response.ok) {
        safeLog('error', safeValue("Chat logging request failed"), safeValue(response.status));
        return null;
      }

      const body = await response.json();
      return body.log ?? null;
    } catch (error) {
      safeLog('error', safeValue("Error in ChatLogger.logMessage:"), safeValue(errorClass(error)));
      return null;
    }
  }

  static async initializeSession(sessionId: string): Promise<boolean> {
    try {
      const response = await fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'initialize_session',
          sessionId,
        }),
      });

      if (!response.ok) {
        safeLog('error', safeValue("Session initialization request failed"), safeValue(response.status));
        return false;
      }

      return true;
    } catch (error) {
      safeLog('error', safeValue("Error in ChatLogger.initializeSession:"), safeValue(errorClass(error)));
      return false;
    }
  }
}
