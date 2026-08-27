import { createHmac } from 'node:crypto';

import { config } from '../config.ts';
import { dbPool } from './client.ts';
import type { ChatLog, NewChatLog } from './types.ts';

interface ChatLogRow extends Omit<ChatLog, 'file_size' | 'session_started_at' | 'session_last_activity' | 'created_at' | 'updated_at'> {
  file_size: number | string | null;
  session_started_at: Date | string;
  session_last_activity: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function timestampToString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toChatLog(row: ChatLogRow): ChatLog {
  return {
    ...row,
    file_size: row.file_size === null ? null : Number(row.file_size),
    session_started_at: timestampToString(row.session_started_at),
    session_last_activity: timestampToString(row.session_last_activity),
    created_at: timestampToString(row.created_at),
    updated_at: timestampToString(row.updated_at),
  };
}

export function pseudonymizeParticipantId(userEmail: string, salt: string): string {
  return createHmac('sha256', salt)
    .update(userEmail.trim().toLowerCase(), 'utf8')
    .digest('hex');
}

function participantIdForStorage(userEmail: string | null): string | null {
  if (userEmail === null || config.PARTICIPANT_ID_MODE === 'email') {
    return userEmail;
  }

  if (!config.PARTICIPANT_ID_SALT) {
    throw new Error('PARTICIPANT_ID_SALT is unavailable in pseudonymous mode');
  }

  return pseudonymizeParticipantId(userEmail, config.PARTICIPANT_ID_SALT);
}

export async function insertLog(log: NewChatLog): Promise<ChatLog> {
  const result = await dbPool.query<ChatLogRow>(
    `INSERT INTO chat_logs (
      id,
      session_id,
      conversation_id,
      message_index,
      message_type,
      user_message,
      ai_response,
      file_name,
      file_size,
      vulnerability_count,
      user_email,
      created_at,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *`,
    [
      log.id,
      log.session_id,
      log.conversation_id,
      log.message_index,
      log.message_type,
      log.user_message,
      log.ai_response,
      log.file_name,
      log.file_size,
      log.vulnerability_count,
      participantIdForStorage(log.user_email),
      log.created_at,
      log.updated_at,
    ],
  );

  return toChatLog(result.rows[0]);
}

export async function updateAiResponse(
  sessionId: string,
  messageIndex: number,
  aiResponse: string,
): Promise<ChatLog[]> {
  const result = await dbPool.query<ChatLogRow>(
    `UPDATE chat_logs
    SET ai_response = $1, updated_at = NOW()
    WHERE session_id = $2 AND message_index = $3
    RETURNING *`,
    [aiResponse, sessionId, messageIndex],
  );

  return result.rows.map(toChatLog);
}

export async function getSessionHistory(sessionId: string): Promise<ChatLog[]> {
  const result = await dbPool.query<ChatLogRow>(
    `SELECT *
    FROM chat_logs
    WHERE session_id = $1
    ORDER BY message_index ASC, created_at ASC`,
    [sessionId],
  );

  return result.rows.map(toChatLog);
}
