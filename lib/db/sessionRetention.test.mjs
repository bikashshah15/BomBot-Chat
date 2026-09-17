import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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

test('session retention is durable, conflict-safe, concurrent-safe and preserves legacy rows and separate keys', async context => {
  if (!process.env.DATABASE_URL) { context.skip('DATABASE_URL not configured'); return; }
  const schema = `session_rule_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  let connected = false, created = false, pool, keys;
  try {
    try { await client.connect(); connected = true; }
    catch (error) { if (unreachable(error)) { context.skip('Postgres unreachable'); return; } throw error; }
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query(execFileSync('git', ['show', '4c89844:db/schema.sql'], { encoding: 'utf8' }));
    // Pre-change recorded modes, including one genuine out-of-vocabulary fixture.
    await client.query('ALTER TABLE conversations DROP CONSTRAINT conversations_retention_mode_valid');
    await client.query(`INSERT INTO conversations(session_id, retention_mode) VALUES
      ('legacy-study','study'), ('legacy-ephemeral','ephemeral'), ('legacy-unknown','standard'),
      ('legacy-mixed','study'), ('legacy-mixed','ephemeral')`);
    const before = (await client.query('SELECT id,session_id,retention_mode FROM conversations ORDER BY id')).rows;
    const currentSchema = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8');
    await client.query(currentSchema);
    await client.query(currentSchema);
    assert.deepEqual((await client.query('SELECT id,session_id,retention_mode FROM conversations ORDER BY id')).rows, before);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM session_retention_rules')).rows[0].count, 0,
      'migration must not infer or backfill session rules');

    const insert = (session, mode) => client.query('INSERT INTO conversations(session_id,retention_mode) VALUES($1,$2)', [session, mode]);
    const conflict = error => error.code === '23514' && error.constraint === 'session_retention_rule_matches';
    await insert('legacy-study', 'study');
    await insert('legacy-ephemeral', 'ephemeral');
    await assert.rejects(insert('legacy-study', 'ephemeral'), conflict);
    await assert.rejects(insert('legacy-ephemeral', 'study'), conflict);
    await assert.rejects(insert('legacy-unknown', 'study'), conflict);
    await assert.rejects(insert('legacy-mixed', 'study'), conflict);
    await assert.rejects(insert('legacy-mixed', 'ephemeral'), conflict);
    for (const row of before) {
      assert.deepEqual((await client.query('SELECT id,session_id,retention_mode FROM conversations WHERE id=$1', [row.id])).rows[0], row);
    }
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM session_retention_rules
      WHERE session_id IN ('legacy-unknown','legacy-mixed')`)).rows[0].count, 0, 'rejected creation must roll back its rule');
    await assert.rejects(client.query(`UPDATE session_retention_rules SET retention_mode='ephemeral' WHERE session_id='legacy-study'`), conflict);
    await assert.rejects(client.query(`UPDATE conversations SET retention_mode='ephemeral' WHERE session_id='legacy-study'`), conflict);

    // Removing only this test's conversations must not enable policy/key reuse.
    await insert('removed-fixture', 'ephemeral');
    await client.query(`DELETE FROM conversations WHERE session_id='removed-fixture'`);
    await assert.rejects(insert('removed-fixture', 'study'), conflict);

    const racers = [0, 1].map(() => new pg.Client({ connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema},public` }));
    try {
      await Promise.all(racers.map(connection => connection.connect()));
      const outcomes = await Promise.allSettled(racers.map((connection, index) => connection.query(
        'INSERT INTO conversations(session_id,retention_mode) VALUES($1,$2)', ['concurrent-first', index ? 'ephemeral' : 'study'])));
      assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
      const loser = outcomes.find(outcome => outcome.status === 'rejected');
      assert.ok(conflict(loser.reason));
      const rule = (await client.query(`SELECT retention_mode FROM session_retention_rules WHERE session_id='concurrent-first'`)).rows[0];
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM conversations
        WHERE session_id='concurrent-first' AND retention_mode=$1`, [rule.retention_mode])).rows[0].count, 1);
    } finally { await Promise.all(racers.map(connection => connection.end())); }

    const { dbPool } = await import('./client.ts'); pool = dbPool;
    pool.options.options = `-c search_path=${schema},public`;
    const { config } = await import('../config.ts');
    const { createConversation, SessionRetentionConflictError } = await import('./conversations.ts');
    const incompatible = config.RETENTION === 'study' ? 'ephemeral' : 'study';
    await insert('adapter-conflict', incompatible);
    await assert.rejects(createConversation('adapter-conflict'), SessionRetentionConflictError);
    const same = await createConversation('adapter-new');
    assert.equal(same.retention_mode, config.RETENTION);
    assert.equal((await createConversation('adapter-new')).retention_mode, config.RETENTION);

    keys = await mkdtemp(path.join(os.tmpdir(), 'bombot-session-rule-keys-'));
    const { FileSessionKeyVault, SessionKeyError } = await import('../crypto/sessionKeys.ts');
    const vault = new FileSessionKeyVault(keys);
    await vault.create('separate-study'); await vault.create('separate-ephemeral');
    const study = await vault.encrypt('separate-study', 'Synthetic retained text');
    const ephemeral = await vault.encrypt('separate-ephemeral', 'Synthetic ephemeral text');
    await assert.rejects(vault.decrypt('separate-study', ephemeral), SessionKeyError);
    await vault.destroy('separate-ephemeral');
    await assert.rejects(vault.decrypt('separate-ephemeral', ephemeral), SessionKeyError);
    assert.equal(await vault.decrypt('separate-study', study), 'Synthetic retained text');
  } finally {
    if (pool) await pool.end();
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (connected) await client.end();
    if (keys) await rm(keys, { recursive: true, force: true });
  }
});
