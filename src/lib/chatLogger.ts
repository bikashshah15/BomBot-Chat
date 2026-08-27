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
        console.error(`Chat logging request failed with HTTP ${response.status}`);
        return null;
      }

      const body = await response.json();
      return body.log ?? null;
    } catch (error) {
      console.error('Error in ChatLogger.logMessage:', error);
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
        console.error(`Session initialization request failed with HTTP ${response.status}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error in ChatLogger.initializeSession:', error);
      return false;
    }
  }
}
