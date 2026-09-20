import { sessionKeyVault } from '../crypto/sessionKeyStore.ts';
import { config } from '../config.ts';
import { dbPool } from './client.ts';
import { currentScanSource } from './scanProvenance.ts';
import { withSessionContentWrite } from './sessionContentWrite.ts';
import { decryptStoredContent, encryptStoredContent, StoredContentShapeError } from './encryptedContent.ts';
import type {
  Conversation,
  ConversationMessage,
  NewConversationMessage,
} from './types.ts';
import {
  resolveProviderSettings,
  type ProviderId,
} from '../llm/providerRegistry.ts';

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

export class SessionRetentionConflictError extends Error {
  constructor() {
    super('Session retention rule conflicts; use a new session');
    this.name = 'SessionRetentionConflictError';
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
  has_tool_calls: boolean | null;
  tool_calls_ciphertext: Buffer | null;
  tool_calls_nonce: Buffer | null;
  tool_calls_auth_tag: Buffer | null;
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
  const toolCalls = await decryptStoredContent(row.session_id, {
    plaintext: row.tool_calls === null ? null : JSON.stringify(row.tool_calls),
    ciphertext: row.tool_calls_ciphertext,
    nonce: row.tool_calls_nonce,
    authTag: row.tool_calls_auth_tag,
  }, true);
  const parsedToolCalls = toolCalls === null ? null : JSON.parse(toolCalls);
  if (parsedToolCalls !== null && !Array.isArray(parsedToolCalls)) throw new StoredContentShapeError();
  if (row.has_tool_calls !== null && row.has_tool_calls !== ((parsedToolCalls?.length ?? 0) > 0)) {
    throw new StoredContentShapeError();
  }
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
    tool_calls: parsedToolCalls,
    pinned: row.pinned,
    created_at: timestampToString(row.created_at),
  };
}

export async function createConversation(
  sessionId: string,
  providerId: ProviderId = 'primary',
): Promise<Conversation> {
  const settings = resolveProviderSettings(providerId);
  try {
  const result = await dbPool.query<ConversationRow>(
    `INSERT INTO conversations (session_id, retention_mode, provider_id, model_id)
    VALUES ($1, $2, $3, $4)
    RETURNING id, session_id, created_at, retention_mode, provider_id, model_id`,
    [sessionId, config.RETENTION, providerId, settings.LLM_MODEL],
  );

  return toConversation(result.rows[0]);
  } catch (error) {
    if (error && typeof error === 'object' && 'constraint' in error
      && error.constraint === 'session_retention_rule_matches') {
      throw new SessionRetentionConflictError();
    }
    throw error;
  }
}

export async function appendConversationMessage(
  message: NewConversationMessage,
): Promise<ConversationMessage | null> {
  const sessionId = await getConversationSessionId(message.conversation_id);
  if (sessionId === null) return null;
  return withSessionContentWrite(sessionId, async client => {
  await sessionKeyVault.create(sessionId);
  const encrypted = await encryptStoredContent(sessionId, message.content);
  const toolCalls = message.tool_calls === null ? null
    : await encryptStoredContent(sessionId, JSON.stringify(message.tool_calls));
  const result = await client.query<ConversationMessageRow>(
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
      tool_calls_ciphertext,
      tool_calls_nonce,
      tool_calls_auth_tag,
      has_tool_calls,
      pinned,
      scan_source
    ) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, NULL, $8, $11, $12, $13, $9, $10::jsonb)
    ON CONFLICT (conversation_id, seq) DO NOTHING
    RETURNING conversation_id, seq, role, content,
      content_ciphertext, content_nonce, content_auth_tag,
      tool_call_id, tool_calls, tool_calls_ciphertext, tool_calls_nonce, tool_calls_auth_tag, has_tool_calls, pinned, created_at`,
    [
      message.conversation_id,
      message.seq,
      message.role,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.authTag,
      message.tool_call_id,
      toolCalls?.ciphertext ?? null,
      message.pinned ?? false,
      message.pinned && message.role === 'user' && currentScanSource()
        ? JSON.stringify(currentScanSource()) : null,
      toolCalls?.nonce ?? null,
      toolCalls?.authTag ?? null,
      (message.tool_calls?.length ?? 0) > 0,
    ],
  );

  return result.rows[0]
    ? toConversationMessage({ ...result.rows[0], session_id: sessionId })
    : null;
  });
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
        tool_call_id, tool_calls, tool_calls_ciphertext, tool_calls_nonce, tool_calls_auth_tag, has_tool_calls, pinned, created_at
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
            AND COALESCE(message.has_tool_calls, jsonb_array_length(COALESCE(message.tool_calls, '[]'::jsonb)) > 0)
          ORDER BY message.seq DESC
          LIMIT 1
        ), window_start.seq)
        ELSE window_start.seq
      END AS seq
      FROM window_start
    )
    SELECT message.conversation_id, message.seq, message.role, message.content,
      message.content_ciphertext, message.content_nonce, message.content_auth_tag,
      message.tool_call_id, message.tool_calls,
      message.tool_calls_ciphertext, message.tool_calls_nonce, message.tool_calls_auth_tag, message.has_tool_calls,
      message.pinned, message.created_at,
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

export async function getConversationProviderId(conversationId: string): Promise<ProviderId | null> {
  const result = await dbPool.query<{ provider_id: string | null }>(
    `SELECT provider_id
    FROM conversations
    WHERE id = $1`,
    [conversationId],
  );

  const row = result.rows[0];
  if (!row) return null;
  return row.provider_id === null ? 'primary' : row.provider_id as ProviderId;
}
