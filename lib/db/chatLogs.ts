import { createHmac } from 'node:crypto';

import { sessionKeyVault } from '../crypto/sessionKeyStore.ts';
import { config } from '../config.ts';
import { dbPool } from './client.ts';
import { withSessionContentWrite } from './sessionContentWrite.ts';
import { decryptStoredContent, encryptStoredContent } from './encryptedContent.ts';
import type { ChatLog, NewChatLog } from './types.ts';

interface ChatLogRow extends Omit<ChatLog, 'file_size' | 'session_started_at' | 'session_last_activity' | 'created_at' | 'updated_at'> {
  user_message_ciphertext: Buffer | null;
  user_message_nonce: Buffer | null;
  user_message_auth_tag: Buffer | null;
  ai_response_ciphertext: Buffer | null;
  ai_response_nonce: Buffer | null;
  ai_response_auth_tag: Buffer | null;
  user_email_ciphertext: Buffer | null;
  user_email_nonce: Buffer | null;
  user_email_auth_tag: Buffer | null;
  file_size: number | string | null;
  session_started_at: Date | string;
  session_last_activity: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function timestampToString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function toChatLog(row: ChatLogRow): Promise<ChatLog> {
  return {
    id: row.id,
    session_id: row.session_id,
    conversation_id: row.conversation_id,
    message_index: row.message_index,
    message_type: row.message_type,
    user_message: await decryptStoredContent(row.session_id, {
      plaintext: row.user_message,
      ciphertext: row.user_message_ciphertext,
      nonce: row.user_message_nonce,
      authTag: row.user_message_auth_tag,
    }, true),
    ai_response: await decryptStoredContent(row.session_id, {
      plaintext: row.ai_response,
      ciphertext: row.ai_response_ciphertext,
      nonce: row.ai_response_nonce,
      authTag: row.ai_response_auth_tag,
    }, true),
    file_name: row.file_name,
    file_size: row.file_size === null ? null : Number(row.file_size),
    vulnerability_count: row.vulnerability_count,
    user_email: await decryptStoredContent(row.session_id, {
      plaintext: row.user_email,
      ciphertext: row.user_email_ciphertext,
      nonce: row.user_email_nonce,
      authTag: row.user_email_auth_tag,
    }, true),
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
  return withSessionContentWrite(log.session_id, async client => {
  const participantId = participantIdForStorage(log.user_email);
  const protectedValues = [log.user_message, log.ai_response, participantId]
    .filter((value): value is string => value !== null);
  if (protectedValues.length > 0) await sessionKeyVault.create(log.session_id);
  const [userMessage, aiResponse, userEmail] = await Promise.all([
    log.user_message === null ? null : encryptStoredContent(log.session_id, log.user_message),
    log.ai_response === null ? null : encryptStoredContent(log.session_id, log.ai_response),
    participantId === null ? null : encryptStoredContent(log.session_id, participantId),
  ]);
  const result = await client.query<ChatLogRow>(
    `INSERT INTO chat_logs (
      id,
      session_id,
      conversation_id,
      message_index,
      message_type,
      user_message,
      user_message_ciphertext,
      user_message_nonce,
      user_message_auth_tag,
      ai_response,
      ai_response_ciphertext,
      ai_response_nonce,
      ai_response_auth_tag,
      file_name,
      file_size,
      vulnerability_count,
      user_email,
      user_email_ciphertext,
      user_email_nonce,
      user_email_auth_tag,
      created_at,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      NULL, $6, $7, $8,
      NULL, $9, $10, $11,
      $12, $13, $14,
      NULL, $15, $16, $17,
      $18, $19
    )
    RETURNING *`,
    [
      log.id,
      log.session_id,
      log.conversation_id,
      log.message_index,
      log.message_type,
      userMessage?.ciphertext ?? null,
      userMessage?.nonce ?? null,
      userMessage?.authTag ?? null,
      aiResponse?.ciphertext ?? null,
      aiResponse?.nonce ?? null,
      aiResponse?.authTag ?? null,
      log.file_name,
      log.file_size,
      log.vulnerability_count,
      userEmail?.ciphertext ?? null,
      userEmail?.nonce ?? null,
      userEmail?.authTag ?? null,
      log.created_at,
      log.updated_at,
    ],
  );

  return toChatLog(result.rows[0]);
  });
}

export async function updateAiResponse(
  sessionId: string,
  messageIndex: number,
  aiResponse: string,
): Promise<ChatLog[]> {
  return withSessionContentWrite(sessionId, async client => {
  await sessionKeyVault.create(sessionId);
  const encrypted = await encryptStoredContent(sessionId, aiResponse);
  const result = await client.query<ChatLogRow>(
    `UPDATE chat_logs
    SET ai_response = NULL,
      ai_response_ciphertext = $1,
      ai_response_nonce = $2,
      ai_response_auth_tag = $3,
      updated_at = NOW()
    WHERE session_id = $4 AND message_index = $5
    RETURNING *`,
    [encrypted.ciphertext, encrypted.nonce, encrypted.authTag, sessionId, messageIndex],
  );

  return Promise.all(result.rows.map(toChatLog));
  });
}

export async function getSessionHistory(sessionId: string): Promise<ChatLog[]> {
  const result = await dbPool.query<ChatLogRow>(
    `SELECT *
    FROM chat_logs
    WHERE session_id = $1
    ORDER BY message_index ASC, created_at ASC`,
    [sessionId],
  );

  return Promise.all(result.rows.map(toChatLog));
}
