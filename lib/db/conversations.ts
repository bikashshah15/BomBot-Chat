import { sessionKeyVault } from '../crypto/sessionKeyStore.ts';
import { config } from '../config.ts';
import { dbPool } from './client.ts';
import { decryptStoredContent, encryptStoredContent } from './encryptedContent.ts';
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

interface ConversationMessageRow extends Omit<ConversationMessage, 'content' | 'created_at'> {
  session_id: string;
  content: string | null;
  content_ciphertext: Buffer | null;
  content_nonce: Buffer | null;
  content_auth_tag: Buffer | null;
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

async function toConversationMessage(row: ConversationMessageRow): Promise<ConversationMessage> {
  return {
    conversation_id: row.conversation_id,
    seq: row.seq,
    role: row.role,
    content: await decryptStoredContent(row.session_id, {
      plaintext: row.content,
      ciphertext: row.content_ciphertext,
      nonce: row.content_nonce,
      authTag: row.content_auth_tag,
    }, false) as string,
    tool_call_id: row.tool_call_id,
    tool_calls: row.tool_calls,
    pinned: row.pinned,
    created_at: timestampToString(row.created_at),
  };
}

export async function createConversation(sessionId: string): Promise<Conversation> {
  const result = await dbPool.query<ConversationRow>(
    `INSERT INTO conversations (session_id, retention_mode)
    VALUES ($1, $2)
    RETURNING id, session_id, created_at, retention_mode`,
    [sessionId, config.RETENTION],
  );

  return toConversation(result.rows[0]);
}

export async function appendConversationMessage(
  message: NewConversationMessage,
): Promise<ConversationMessage | null> {
  const sessionId = await getConversationSessionId(message.conversation_id);
  if (sessionId === null) return null;
  await sessionKeyVault.create(sessionId);
  const encrypted = await encryptStoredContent(sessionId, message.content);
  const result = await dbPool.query<ConversationMessageRow>(
    `INSERT INTO conversation_messages (
      conversation_id,
      seq,
      role,
      content,
      content_ciphertext,
      content_nonce,
      content_auth_tag,
      tool_call_id,
      tool_calls,
      pinned
    ) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (conversation_id, seq) DO NOTHING
    RETURNING conversation_id, seq, role, content,
      content_ciphertext, content_nonce, content_auth_tag,
      tool_call_id, tool_calls, pinned, created_at`,
    [
      message.conversation_id,
      message.seq,
      message.role,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.authTag,
      message.tool_call_id,
      message.tool_calls === null ? null : JSON.stringify(message.tool_calls),
      message.pinned ?? false,
    ],
  );

  return result.rows[0]
    ? toConversationMessage({ ...result.rows[0], session_id: sessionId })
    : null;
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
      SELECT conversation_id, seq, role, content,
        content_ciphertext, content_nonce, content_auth_tag,
        tool_call_id, tool_calls, pinned, created_at
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
    SELECT message.conversation_id, message.seq, message.role, message.content,
      message.content_ciphertext, message.content_nonce, message.content_auth_tag,
      message.tool_call_id, message.tool_calls, message.pinned, message.created_at,
      conversation.session_id
    FROM conversation_messages AS message
    JOIN conversations AS conversation ON conversation.id = message.conversation_id
    WHERE message.conversation_id = $1
      AND (seq >= (SELECT seq FROM replay_start) OR pinned)
    ORDER BY seq ASC`,
    [conversationId, limit],
  );

  return Promise.all(result.rows.map(toConversationMessage));
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
