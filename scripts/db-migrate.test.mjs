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

test('schema migration adds pinned to a populated conversation_messages table', async (context) => {
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

  try {
    try {
      await client.connect();
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

    const column = await client.query(
      `SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'conversation_messages'
        AND column_name = 'pinned'`,
      [schemaName],
    );
    assert.equal(column.rowCount, 1);
    assert.equal(column.rows[0].is_nullable, 'NO');
    assert.match(String(column.rows[0].column_default), /false/i);

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
  } finally {
    await client.query('RESET search_path').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  }
});
