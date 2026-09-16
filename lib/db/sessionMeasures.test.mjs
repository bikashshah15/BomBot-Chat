import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import 'dotenv/config';
import pg from 'pg';

function unreachable(error) {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(unreachable);
  return ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPERM', 'ETIMEDOUT'].includes(error?.code);
}

test('real session extraction persists local alias outcomes, provenance and no content', async context => {
  if (!process.env.DATABASE_URL) { context.skip('DATABASE_URL not configured'); return; }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  let connected = false;
  let pool;
  let keyDirectory;
  let schemaCreated = false;
  const schema = `measures_${randomUUID().replaceAll('-', '')}`;
  const previousDirectory = process.env.SESSION_KEY_DIRECTORY;
  const originalFetch = globalThis.fetch;
  try {
    try { await client.connect(); connected = true; }
    catch (error) { if (unreachable(error)) { context.skip('Postgres unreachable'); return; } throw error; }
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
    keyDirectory = await mkdtemp(path.join(os.tmpdir(), 'bombot-measure-keys-'));
    process.env.SESSION_KEY_DIRECTORY = keyDirectory;
    const { dbPool } = await import('./client.ts');
    pool = dbPool;
    pool.options.options = `-c search_path=${schema},public`;
    const { config } = await import('../config.ts');
    const { createConversation, appendConversationMessage } = await import('./conversations.ts');
    const { extractAndStoreSessionMeasures } = await import('./sessionMeasures.ts');
    globalThis.fetch = () => { throw new Error('Extraction must not use outbound HTTP'); };
    const session = `synthetic-measure-${randomUUID()}`;
    const conversation = await createConversation(session);
    const message = { conversation_id: conversation.id, tool_call_id: null, tool_calls: null };
    await appendConversationMessage({ ...message, seq: 1, role: 'user', pinned: true,
      content: `Private filename inventory.json\n**Minimized Software Context:**\n${JSON.stringify({
        scan_truncated: false, scanned_package_count: 1,
        packages_depends_on: [{ package_name: 'private-package', vulnerabilities: [{ id: 'GHSA-aaaa-bbbb-cccc' }] }],
      })}\n\nPlease summarize.` });
    await appendConversationMessage({ ...message, seq: 2, role: 'assistant',
      content: 'Private assistant answer CVE-2026-1234 CVE-2026-9999' });
    // Put enough newer messages after the emission to exceed replay limits.
    for (let seq = 3; seq < config.MAX_HISTORY_MESSAGES + 4; seq++) {
      await appendConversationMessage({ ...message, seq, role: 'user', content: 'Private later question' });
    }
    const snapshotDate = config.OSV_SNAPSHOT_DATE ?? '2026-09-16';
    const missing = await extractAndStoreSessionMeasures(session);
    assert.equal(missing.resolution_provenance.status, 'missing_snapshot');
    assert.equal(missing.resolution_provenance.snapshot_date, 'unknown');
    assert.equal(missing.unresolved_count, 2);
    await client.query(`INSERT INTO osv_snapshots (snapshot_date, source_url, ecosystem_record_counts)
      VALUES ($1, 'local synthetic fixture', '{}'::jsonb)`, [snapshotDate]);
    await client.query(`INSERT INTO osv_advisories (id, aliases, record)
      VALUES ('GHSA-aaaa-bbbb-cccc', '["CVE-2026-1234"]', '{}')`);
    const result = await extractAndStoreSessionMeasures(session);
    assert.equal(result.emitted_count, 2);
    assert.equal(result.alias_grounded_count, 1);
    assert.equal(result.ungrounded_count, 1);
    assert.equal(result.not_found_count, 1);
    assert.deepEqual(result.scan_provenance, [{ osv_mode: 'unknown', snapshot_date: 'unknown',
      scan_truncated: false, scanned_package_count: 1 }]);
    assert.equal(result.resolution_provenance.snapshot_date, snapshotDate);
    const stored = await client.query('SELECT result FROM session_measures WHERE session_id = $1', [session]);
    assert.deepEqual(stored.rows[0].result, result);
    for (const value of ['Private', 'inventory.json', 'private-package', 'CVE-2026-1234', 'GHSA-aaaa-bbbb-cccc']) {
      assert.equal(JSON.stringify(stored.rows[0].result).includes(value), false);
    }
    await extractAndStoreSessionMeasures(session);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM session_measures')).rows[0].count, 1);
    const encrypted = await client.query('SELECT content, content_ciphertext FROM conversation_messages WHERE seq = 2');
    assert.equal(encrypted.rows[0].content, null);
    assert.ok(Buffer.isBuffer(encrypted.rows[0].content_ciphertext));
    if (config.OSV_SNAPSHOT_DATE) {
      await client.query(`INSERT INTO osv_snapshots (snapshot_date, source_url, ecosystem_record_counts, ingested_at)
        VALUES ('1900-01-01', 'local mismatched fixture', '{}', '2100-01-01')`);
      const unavailable = await extractAndStoreSessionMeasures(session);
      assert.equal(unavailable.resolution_provenance.status, 'pin_mismatch');
      assert.equal(unavailable.unresolved_count, 2);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (pool) await pool.end();
    if (schemaCreated) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (connected) await client.end();
    if (keyDirectory) await rm(keyDirectory, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.SESSION_KEY_DIRECTORY;
    else process.env.SESSION_KEY_DIRECTORY = previousDirectory;
  }
});
