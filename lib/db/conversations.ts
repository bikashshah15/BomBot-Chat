import { dbPool } from './client.ts';
import type {
  Conversation,
  ConversationMessage,
  NewConversationMessage,
} from './types.ts';

export class ConversationSequenceConflictError extends Error {
  readonly conversationId: string;
  readonly seq: number;

  constructor(conversationId: string, seq: number) {
    super(`Conversation sequence ${seq} is already stored`);
    this.name = 'ConversationSequenceConflictError';
    this.conversationId = conversationId;
    this.seq = seq;
  }
}

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

export async function appendConversationMessageOrThrow(
  message: NewConversationMessage,
): Promise<ConversationMessage> {
  const inserted = await appendConversationMessage(message);
  if (!inserted) {
    throw new ConversationSequenceConflictError(message.conversation_id, message.seq);
  }
  return inserted;
}

export async function getConversationMessages(
  conversationId: string,
  limit: number,
): Promise<ConversationMessage[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Conversation message limit must be a positive integer');
  }

  const result = await dbPool.query<ConversationMessageRow>(
    `WITH recent_messages AS (
      SELECT conversation_id, seq, role, content, tool_call_id, tool_calls, created_at
      FROM conversation_messages
      WHERE conversation_id = $1
      ORDER BY seq DESC
      LIMIT $2
    ), window_start AS (
      SELECT seq, role
      FROM recent_messages
      ORDER BY seq ASC
      LIMIT 1
    ), replay_start AS (
      SELECT CASE
        WHEN window_start.role = 'tool' THEN COALESCE((
          SELECT message.seq
          FROM conversation_messages AS message
          WHERE message.conversation_id = $1
            AND message.seq < window_start.seq
            AND message.role = 'assistant'
            AND jsonb_array_length(COALESCE(message.tool_calls, '[]'::jsonb)) > 0
          ORDER BY message.seq DESC
          LIMIT 1
        ), window_start.seq)
        ELSE window_start.seq
      END AS seq
      FROM window_start
    )
    SELECT conversation_id, seq, role, content, tool_call_id, tool_calls, created_at
    FROM conversation_messages
    WHERE conversation_id = $1
      AND seq >= (SELECT seq FROM replay_start)
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
