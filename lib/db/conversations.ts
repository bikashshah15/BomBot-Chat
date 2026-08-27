import { dbPool } from './client.ts';
import type {
  Conversation,
  ConversationMessage,
  NewConversationMessage,
} from './types.ts';

interface ConversationRow extends Omit<Conversation, 'created_at'> {
  created_at: Date | string;
}

interface ConversationMessageRow extends Omit<ConversationMessage, 'created_at'> {
  created_at: Date | string;
}

function timestampToString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    ...row,
    created_at: timestampToString(row.created_at),
  };
}

function toConversationMessage(row: ConversationMessageRow): ConversationMessage {
  return {
    ...row,
    created_at: timestampToString(row.created_at),
  };
}

export async function createConversation(sessionId: string): Promise<Conversation> {
  const result = await dbPool.query<ConversationRow>(
    `INSERT INTO conversations (session_id)
    VALUES ($1)
    RETURNING id, session_id, created_at, retention_mode`,
    [sessionId],
  );

  return toConversation(result.rows[0]);
}

export async function appendConversationMessage(
  message: NewConversationMessage,
): Promise<ConversationMessage | null> {
  const result = await dbPool.query<ConversationMessageRow>(
    `INSERT INTO conversation_messages (
      conversation_id,
      seq,
      role,
      content,
      tool_call_id,
      tool_calls
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (conversation_id, seq) DO NOTHING
    RETURNING conversation_id, seq, role, content, tool_call_id, tool_calls, created_at`,
    [
      message.conversation_id,
      message.seq,
      message.role,
      message.content,
      message.tool_call_id,
      message.tool_calls === null ? null : JSON.stringify(message.tool_calls),
    ],
  );

  return result.rows[0] ? toConversationMessage(result.rows[0]) : null;
}

export async function getConversationMessages(
  conversationId: string,
  limit: number,
): Promise<ConversationMessage[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Conversation message limit must be a positive integer');
  }

  const result = await dbPool.query<ConversationMessageRow>(
    `SELECT conversation_id, seq, role, content, tool_call_id, tool_calls, created_at
    FROM (
      SELECT conversation_id, seq, role, content, tool_call_id, tool_calls, created_at
      FROM conversation_messages
      WHERE conversation_id = $1
      ORDER BY seq DESC
      LIMIT $2
    ) AS recent_messages
    ORDER BY seq ASC`,
    [conversationId, limit],
  );

  return result.rows.map(toConversationMessage);
}

export async function getConversationSessionId(conversationId: string): Promise<string | null> {
  const result = await dbPool.query<{ session_id: string }>(
    `SELECT session_id
    FROM conversations
    WHERE id = $1`,
    [conversationId],
  );

  return result.rows[0]?.session_id ?? null;
}
