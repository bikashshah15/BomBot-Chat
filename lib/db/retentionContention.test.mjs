import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import 'dotenv/config';
import pg from 'pg';

// Frozen before the first reproduction run: floor(285.353833 ms), the maximum
// of 36 real 803a7a9 fork -> connect -> committed failure-write -> IPC samples.
// Three concurrent builds; four sibling failure forks/batch. Not fitted to red.
const INJECTED_LATENCY_MS = 285;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Structural measurement-schedule and contention tests; deletion guarantees are public.
test('early opportunities reach storage on the last pass and extraction contention stays session-local', async context => {
  if (!process.env.DATABASE_URL) { context.skip('DATABASE_URL not configured'); return; }
  const schema = `contention_probe_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  const oldDirectory = process.env.SESSION_KEY_DIRECTORY;
  const oldWindow = process.env.RETENTION_IDLE_HOURS;
  let connected = false, created = false, directory, pool, stop, vault, originalDestroy;
  const inFlight = new Set();
  try {
    try { await client.connect(); connected = true; }
    catch (error) {
      if (['ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','ENOTFOUND','EPERM','ETIMEDOUT'].includes(error?.code)) {
        context.skip('Postgres unreachable'); return;
      }
      throw error;
    }
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}",public`);
    await client.query(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
    directory = await mkdtemp(path.join(os.tmpdir(), 'contention-probe-keys-'));
    process.env.SESSION_KEY_DIRECTORY = directory;
    process.env.RETENTION_IDLE_HOURS = '1';
    ({ dbPool: pool } = await import('./client.ts'));
    pool.options.options = `-c search_path=${schema},public`;
    ({ sessionKeyVault: vault } = await import('../crypto/sessionKeyStore.ts'));
    const { startRetentionWorker, deleteSessionParticipantData, STORAGE_CUTOFF, IDLE_WINDOW_MS } = await import('./retentionWorker.ts');
    const { createMeasureProvider, EXTRACTION_ATTEMPTS, FIRST_EXTRACTION_LEAD } = await import('../measures/researchProvider.ts');
    const { IDLE_WINDOW_SQL, idleDeadlineSQL } = await import('./retentionStatus.ts');
    const { extractAndStoreSessionMeasures } = await import('./sessionMeasures.ts');
    const { withSessionContentWrite } = await import('./sessionContentWrite.ts');
    // Virtual Date advances eligibility only; real PostgreSQL/SQL guards and
    // real sweep/setTimeout remain active. No wall-clock hour-long test waits.
    const earlyId = 'early-last-pass-fixture';
    const earlyConversation = await client.query("INSERT INTO conversations(session_id,retention_mode) VALUES($1,'ephemeral') RETURNING id", [earlyId]);
    await client.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content,pinned)
      VALUES($1,1,'user','Synthetic early fixture',true)`, [earlyConversation.rows[0].id]);
    await vault.create(earlyId);
    let earlyRevision = (await client.query('SELECT last_activity_at::text AS revision FROM session_retention_rules WHERE session_id=$1', [earlyId])).rows[0].revision;
    const earlyStart = Date.now(), earlyCalls = [];
    context.mock.timers.enable({ apis: ['Date'], now: earlyStart });
    const until = async predicate => {
      for (let poll = 0; poll < 400; poll++) { if (await predicate()) return; await wait(10); }
      assert.fail('structural fixture did not reach its expected checkpoint');
    };
    try {
      stop = await startRetentionWorker(createMeasureProvider({ extract: async (id, revision) => {
        const fallback = (await client.query('SELECT result FROM session_measures WHERE session_id=$1', [id])).rows[0]?.result;
        earlyCalls.push({ activity: revision, started_at: Date.now(), pre_recorded_status: fallback?.status });
        if (earlyCalls.length < EXTRACTION_ATTEMPTS) throw new Error('Synthetic failure before last opportunity');
        await extractAndStoreSessionMeasures(id, revision);
      } }));
      // Several participant writes over more than one ORIGINAL idle quarter;
      // every write resets its epoch before a quarter of inactivity elapses.
      const activeRevisions = [];
      for (let seq = 2; seq <= 7; seq++) {
        context.mock.timers.tick(3 * 60 * 1000);
        await withSessionContentWrite(earlyId, contentClient => contentClient.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content)
          VALUES($1,$2,'user','Synthetic ongoing participant activity')`, [earlyConversation.rows[0].id, seq]));
        activeRevisions.push((await client.query('SELECT last_activity_at::text AS revision FROM session_retention_rules WHERE session_id=$1', [earlyId])).rows[0].revision);
        await wait(250);
      }
      const liveRows = await client.query('SELECT result FROM session_measures WHERE session_id=$1', [earlyId]);
      context.diagnostic(JSON.stringify({ fixture_group: 'ongoing_activity', writes: activeRevisions,
        elapsed_ms: Date.now() - earlyStart, extractor_calls: earlyCalls.length, measure_rows: liveRows.rowCount }));
      assert.equal(new Set(activeRevisions).size, 6, 'six actual participant writes create six epochs');
      assert.equal(earlyCalls.length, 0, 'ongoing participant activity never extracts');
      assert.equal(liveRows.rowCount, 0, 'ongoing participant activity never records a measure');
      earlyRevision = activeRevisions.at(-1);
      const idleStart = Date.now();
      context.mock.timers.tick(IDLE_WINDOW_MS / 4);
      await until(() => earlyCalls.length === 1);
      const firstResult = (await client.query('SELECT result FROM session_measures WHERE session_id=$1', [earlyId])).rows[0].result;
      // Assert no additional attempt is squeezed into the first checkpoint.
      await wait(150);
      assert.equal(earlyCalls.length, 1);
      context.mock.timers.tick(IDLE_WINDOW_MS / 4);
      await until(() => earlyCalls.length === 2);
      const secondResult = (await client.query('SELECT result FROM session_measures WHERE session_id=$1', [earlyId])).rows[0].result;
      context.mock.timers.tick(IDLE_WINDOW_MS / 4);
      await until(async () => (await client.query('SELECT result FROM session_measures WHERE session_id=$1', [earlyId])).rows[0]?.result.status !== 'unextracted');
      const lastResult = (await client.query('SELECT result FROM session_measures WHERE session_id=$1', [earlyId])).rows[0].result;
      context.diagnostic(JSON.stringify({ fixture_group: 'early_opportunities', window_ms: IDLE_WINDOW_MS,
        first_lead_ms: FIRST_EXTRACTION_LEAD, attempts: earlyCalls, first_result: firstResult, second_result: secondResult, last_result: lastResult }));
      assert.equal(earlyCalls.length, EXTRACTION_ATTEMPTS, 'two failed passes followed by the last scheduled pass');
      assert.equal(firstResult.status, 'unextracted'); assert.equal(secondResult.status, 'unextracted');
      assert.notEqual(lastResult.status, 'unextracted', 'last opportunity really stores a successful measure');
      assert.equal(earlyCalls[0].pre_recorded_status, 'unextracted', 'failure is persisted before first extraction');
      assert.ok(earlyCalls[0].started_at <= idleStart + IDLE_WINDOW_MS - FIRST_EXTRACTION_LEAD);
      assert.ok(earlyCalls[0].started_at >= idleStart + IDLE_WINDOW_MS / 4, 'no extraction before an idle quarter');
      for (let index = 1; index < earlyCalls.length; index++)
        assert.ok(earlyCalls[index].started_at - earlyCalls[index - 1].started_at >= IDLE_WINDOW_MS / 4);
      await withSessionContentWrite(earlyId, contentClient => contentClient.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content)
        VALUES($1,8,'user','Synthetic participant writes again'),
          ($1,9,'assistant','Synthetic later activity CVE-2099-12345')`, [earlyConversation.rows[0].id]));
      await assert.rejects(extractAndStoreSessionMeasures(earlyId, earlyRevision), 'old activity token cannot store after participant writes again');
      await wait(250);
      assert.equal(earlyCalls.length, EXTRACTION_ATTEMPTS, 'new activity also waits for an idle quarter');
      context.mock.timers.tick(IDLE_WINDOW_MS / 4);
      await until(async () => (await client.query('SELECT result FROM session_measures WHERE session_id=$1', [earlyId])).rows[0]?.result.emitted_count === 1);
      assert.ok(earlyCalls.some(call => call.activity !== earlyRevision), 'new epoch gets a fresh early attempt');
      assert.equal((await client.query('SELECT result FROM session_measures WHERE session_id=$1', [earlyId])).rows[0].result.emitted_count, 1,
        'fresh early extraction replaces the prior success');
    } finally {
      await stop?.(); stop = undefined; context.mock.timers.reset();
    }
    await deleteSessionParticipantData(earlyId);
    const clusteredIds = ['multi-stalled-fixture', 'multi-fast-fixture', 'multi-retry-fixture', 'multi-fast-second-fixture',
      'multi-fast-third-fixture', 'multi-fast-fourth-fixture', 'multi-fast-fifth-fixture', 'multi-fast-sixth-fixture'];
    const ids = [...clusteredIds, 'multi-failed-fixture'];
    for (const id of ids) {
      const c = await client.query("INSERT INTO conversations(session_id,retention_mode) VALUES($1,'ephemeral') RETURNING id", [id]);
      await client.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content,pinned)
        VALUES($1,1,'user','Synthetic concurrent-deadline fixture',true)`, [c.rows[0].id]);
      await vault.create(id);
    }
    // Same deadline offset as the captured concurrency fixture. Do not move
    // admission past storage cutoff just to obtain extraction_deadline.
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp()-${IDLE_WINDOW_SQL}
      + $2 * INTERVAL '1 millisecond' WHERE session_id=ANY($1::varchar[])`, [ids, STORAGE_CUTOFF + 3000]);
    const deadlines = new Map((await client.query(`SELECT session_id,
      EXTRACT(EPOCH FROM ${idleDeadlineSQL()})*1000 AS deadline FROM session_retention_rules
      WHERE session_id=ANY($1::varchar[])`, [ids])).rows.map(row => [row.session_id, Number(row.deadline)]));
    const destruction = new Map(), successes = new Map(), attempts = new Map(), errors = [];
    originalDestroy = vault.destroy.bind(vault);
    vault.destroy = async id => {
      const result = await originalDestroy(id);
      if (deadlines.has(id)) destruction.set(id, Date.now());
      return result;
    };
    stop = await startRetentionWorker(createMeasureProvider({ extract: (id, revision) => {
      if (Date.now() >= deadlines.get(id)) errors.push({ session_id: id, name: 'LateAttempt' });
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      if (id === ids[0]) return new Promise(() => {});
      if (id === ids[8]) return Promise.reject(new Error('Synthetic permanent failure'));
      const work = (async () => {
        await wait(INJECTED_LATENCY_MS);
        if (id === ids[2] && attempts.get(id) === 1) throw new Error('Synthetic retry failure');
        // The injectable path replaces production extraction on BOTH trees.
        // Finite latency followed by real extraction/storage; no internal hooks.
        await extractAndStoreSessionMeasures(id, revision);
        successes.set(id, (successes.get(id) ?? 0) + 1);
      })();
      inFlight.add(work);
      void work.then(() => inFlight.delete(work), error => { errors.push({ session_id: id, name: error.name }); inFlight.delete(work); });
      return work;
    } }));
    let preRecorded = [];
    const recordLimit = Date.now() + 2000;
    while (Date.now() < recordLimit) {
      preRecorded = (await client.query('SELECT session_id,result FROM session_measures WHERE session_id=ANY($1::varchar[])', [ids])).rows;
      if (preRecorded.length === ids.length) break;
      await wait(5);
    }
    const limit = Math.max(...deadlines.values()) + 1000;
    while (Date.now() < limit && destruction.size < ids.length) await wait(10);
    await stop(); stop = undefined;
    await Promise.allSettled([...inFlight]);
    const results = new Map((await client.query('SELECT session_id,result FROM session_measures WHERE session_id=ANY($1::varchar[])', [ids])).rows.map(row => [row.session_id, row.result]));
    const sessions = ids.map((id, index) => ({ session_id: id, deadline_ms: deadlines.get(id),
      destruction_ms: destruction.get(id) ?? null,
      key_met_deadline: destruction.has(id) && destruction.get(id) <= Math.ceil(deadlines.get(id)),
      status: results.get(id)?.status ?? (results.has(id) ? 'extracted' : 'missing'),
      error_class: results.get(id)?.error_class ?? null, successful_stores: successes.get(id) ?? 0,
      attempts: attempts.get(id) ?? 0, result: results.get(id) ?? null }));
    const lateness = ids.map(id => destruction.get(id) - deadlines.get(id));
    // All diagnostics precede property assertions. No schema/result mutation.
    context.diagnostic(JSON.stringify({ fixture_group: 'eight_measured_deadlines', injected_latency_ms: INJECTED_LATENCY_MS,
      clustered_session_ids: clusteredIds, pre_recorded: preRecorded, sessions, errors, min_key_lateness_ms: Math.min(...lateness), max_key_lateness_ms: Math.max(...lateness) }));
    for (const session of sessions.slice(1, 8)) {
      assert.notEqual(session.status, 'unextracted', `another session cannot cause extraction failure: ${JSON.stringify(session)}`);
      assert.ok(session.successful_stores > 0, 'success replaces the pre-recorded failure');
    }
    assert.equal(sessions[0].status, 'unextracted');
    assert.equal(sessions[8].status, 'unextracted', 'every-attempt failure sacrifices only its measure');
    assert.equal(sessions[8].successful_stores, 0);
    assert.ok(sessions[8].attempts >= EXTRACTION_ATTEMPTS, 'permanently failing session really receives three attempts');
    for (const session of sessions.slice(1, 8)) assert.ok(session.attempts >= EXTRACTION_ATTEMPTS);
    assert.equal(errors.some(error => error.name === 'LateAttempt'), false, 'no extraction begins after its deadline');
  } finally {
    await stop?.();
    await Promise.allSettled([...inFlight]);
    if (vault && originalDestroy) vault.destroy = originalDestroy;
    await pool?.end();
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (connected) await client.end();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (oldDirectory === undefined) delete process.env.SESSION_KEY_DIRECTORY; else process.env.SESSION_KEY_DIRECTORY = oldDirectory;
    if (oldWindow === undefined) delete process.env.RETENTION_IDLE_HOURS; else process.env.RETENTION_IDLE_HOURS = oldWindow;
  }
});

test('three extraction opportunities derive from both configured idle windows', async () => {
  const { extractionOpportunityOffsets, EXTRACTION_ATTEMPTS } = await import('../measures/researchProvider.ts');
  assert.equal(EXTRACTION_ATTEMPTS, 3);
  assert.deepEqual(extractionOpportunityOffsets(24 * 60 * 60 * 1000), [6 * 60 * 60 * 1000, 12 * 60 * 60 * 1000, 18 * 60 * 60 * 1000]);
  assert.deepEqual(extractionOpportunityOffsets(60 * 60 * 1000), [15 * 60 * 1000, 30 * 60 * 1000, 45 * 60 * 1000]);
});
