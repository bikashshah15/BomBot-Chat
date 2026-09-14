import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import 'dotenv/config';
import pg from 'pg';

const UNREACHABLE_DATABASE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPERM',
  'ETIMEDOUT',
]);

function isDatabaseUnreachable(error) {
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every(isDatabaseUnreachable);
  }
  return Boolean(error && typeof error === 'object' && UNREACHABLE_DATABASE_CODES.has(error.code));
}

test('schema migration adds encryption envelopes to populated content tables', async (context) => {
  if (!process.env.DATABASE_URL) {
    context.skip('DATABASE_URL is not configured; skipping populated-schema migration test');
    return;
  }

  const schemaName = `inc07_migration_${randomUUID().replaceAll('-', '')}`;
  const quotedSchemaName = `"${schemaName}"`;
  const conversationId = randomUUID();
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  });
  let connected = false;

  try {
    try {
      await client.connect();
      connected = true;
    } catch (error) {
      if (isDatabaseUnreachable(error)) {
        context.skip('DATABASE_URL is configured but Postgres is unreachable; skipping populated-schema migration test');
        return;
      }
      throw error;
    }

    await client.query(`CREATE SCHEMA ${quotedSchemaName}`);
    await client.query(`SET search_path TO ${quotedSchemaName}, public`);
    await client.query(`
      CREATE TABLE chat_logs (
        id UUID PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        conversation_id VARCHAR(255),
        message_index INTEGER NOT NULL,
        message_type VARCHAR(20) NOT NULL,
        user_message TEXT,
        ai_response TEXT,
        file_name VARCHAR(255),
        file_size BIGINT,
        vulnerability_count INTEGER,
        user_email VARCHAR(255),
        session_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        session_last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE conversations (
        id UUID PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        retention_mode TEXT NOT NULL DEFAULT 'standard'
      );
      CREATE TABLE conversation_messages (
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_calls JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (conversation_id, seq)
      );
    `);
    await client.query(
      `INSERT INTO chat_logs (
        id, session_id, message_index, message_type, user_message, ai_response, user_email
      ) VALUES ($1, $2, 1, 'user', $3, $4, $5)`,
      [
        randomUUID(),
        'synthetic-pre-migration-session',
        'Synthetic user message before migration',
        'Synthetic AI response before migration',
        'participant@example.test',
      ],
    );
    await client.query(
      `INSERT INTO conversations (id, session_id) VALUES ($1, $2)`,
      [conversationId, 'synthetic-pre-migration-session'],
    );
    await client.query(
      `INSERT INTO conversation_messages (
        conversation_id, seq, role, content, tool_call_id, tool_calls
      ) VALUES ($1, 1, 'user', 'Synthetic row inserted before migration', NULL, NULL)`,
      [conversationId],
    );

    const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
    await client.query(schema);

    const columns = await client.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = $1
        AND (
          (table_name = 'chat_logs' AND column_name IN (
            'user_message_ciphertext', 'user_message_nonce', 'user_message_auth_tag',
            'ai_response_ciphertext', 'ai_response_nonce', 'ai_response_auth_tag',
            'user_email_ciphertext', 'user_email_nonce', 'user_email_auth_tag'
          ))
          OR (table_name = 'conversation_messages' AND column_name IN (
            'content_ciphertext', 'content_nonce', 'content_auth_tag', 'pinned'
          ))
        )
      ORDER BY table_name, column_name`,
      [schemaName],
    );
    assert.equal(columns.rowCount, 13);
    const encryptionColumns = columns.rows.filter(row => row.column_name !== 'pinned');
    assert.equal(encryptionColumns.every(row => row.data_type === 'bytea'), true);
    assert.equal(encryptionColumns.every(row => row.is_nullable === 'YES'), true);
    const pinned = columns.rows.find(row => row.column_name === 'pinned');
    assert.equal(pinned.is_nullable, 'NO');
    assert.match(String(pinned.column_default), /false/i);

    const rows = await client.query(
      `SELECT seq, content, pinned
      FROM conversation_messages
      WHERE conversation_id = $1`,
      [conversationId],
    );
    assert.deepEqual(rows.rows, [{
      seq: 1,
      content: 'Synthetic row inserted before migration',
      pinned: false,
    }]);

    const contentColumn = await client.query(
      `SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'conversation_messages'
        AND column_name = 'content'`,
      [schemaName],
    );
    assert.equal(contentColumn.rows[0].is_nullable, 'YES');

    const contentConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'conversation_messages_content_exactly_one'
        AND conrelid = 'conversation_messages'::regclass`,
    );
    assert.equal(contentConstraint.rowCount, 1);
    assert.match(contentConstraint.rows[0].definition, /content IS NULL/);
    assert.match(contentConstraint.rows[0].definition, /content_ciphertext IS NULL/);

    await assert.rejects(
      client.query(
        `INSERT INTO conversation_messages (
          conversation_id, seq, role, content, content_ciphertext, tool_call_id, tool_calls
        ) VALUES ($1, 2, 'user', NULL, NULL, NULL, NULL)`,
        [conversationId],
      ),
      error => error?.constraint === 'conversation_messages_content_exactly_one',
    );

    const chatRows = await client.query(
      `SELECT user_message, ai_response, user_email,
        user_message_ciphertext, ai_response_ciphertext, user_email_ciphertext
      FROM chat_logs
      WHERE session_id = $1`,
      ['synthetic-pre-migration-session'],
    );
    assert.deepEqual(chatRows.rows, [{
      user_message: 'Synthetic user message before migration',
      ai_response: 'Synthetic AI response before migration',
      user_email: 'participant@example.test',
      user_message_ciphertext: null,
      ai_response_ciphertext: null,
      user_email_ciphertext: null,
    }]);
  } finally {
    if (connected) {
      await client.query('RESET search_path').catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`).catch(() => {});
    }
    await client.end().catch(() => {});
  }
});
