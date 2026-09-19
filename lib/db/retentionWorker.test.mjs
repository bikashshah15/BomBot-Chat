import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import 'dotenv/config';
import pg from 'pg';

function unreachable(error) {
  if (error instanceof AggregateError) return error.errors.every(unreachable);
  return ['ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','ENOTFOUND','EPERM','ETIMEDOUT'].includes(error?.code);
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function runStatus(schema, providerConfigured) {
  const environment = { ...process.env, PGOPTIONS: `-c search_path=${schema},public` };
  if (providerConfigured) environment.MEASURE_PROVIDER_MODULE = path.resolve('lib/measures/researchProvider.ts');
  else delete environment.MEASURE_PROVIDER_MODULE;
  try {
    const stdout = execFileSync(process.execPath,
      ['--experimental-strip-types','--import','dotenv/config','lib/db/retentionStatus.ts'], {
        cwd: new URL('../../', import.meta.url), encoding: 'utf8', stdio: ['ignore','pipe','pipe'],
        env: environment,
      });
    return { status: 0, output: JSON.parse(stdout) };
  } catch (error) {
    assert.equal(error.stderr, '');
    return { status: error.status, output: JSON.parse(error.stdout) };
  }
}

test('provider loader accepts only an absolute module and fails closed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bombot-provider-loader-'));
  try {
    const module = path.join(directory, 'provider.mjs');
    await writeFile(module, `export function createMeasureProvider(){return {
      enabled:true, opportunityOffsets:[1], async extract(){}, async recordFailure(){return true}, async close(){}
    }}`);
    const { loadMeasureProvider, noMeasureProvider } = await import('../measures/provider.ts');
    assert.equal(await loadMeasureProvider(), noMeasureProvider);
    assert.equal((await loadMeasureProvider(module)).enabled, true);
    for (const invalid of ['package-name', './relative.mjs', 'data:text/javascript,export default 1',
      path.join(directory, 'missing.mjs')]) {
      await assert.rejects(loadMeasureProvider(invalid), error => {
        assert.equal(error.name, 'MeasureProviderLoadError');
        assert.equal(error.message.includes(invalid), false);
        return true;
      });
    }
    const configuredValue = 'private-provider-specifier';
    try {
      execFileSync(process.execPath, ['--experimental-strip-types','--import','dotenv/config',
        'lib/db/retentionWorker.ts'], {
        cwd: new URL('../../', import.meta.url), encoding: 'utf8', stdio: ['ignore','pipe','pipe'],
        env: { ...process.env, MEASURE_PROVIDER_MODULE: configuredValue },
      });
      assert.fail('configured invalid provider must stop worker startup');
    } catch (error) {
      assert.equal(error.status, 1);
      const output = `${error.stdout}${error.stderr}`;
      assert.match(output, /retention_worker_start_failed/);
      assert.equal(output.includes(configuredValue), false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public worker destroys clustered keys and purges content despite stalled and failing providers', async context => {
  if (!process.env.DATABASE_URL) { context.skip('DATABASE_URL not configured'); return; }
  const schema = `public_retention_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  const oldDirectory = process.env.SESSION_KEY_DIRECTORY;
  const oldWindow = process.env.RETENTION_IDLE_HOURS;
  let connected = false, created = false, directory, pool, stop;
  try {
    try { await client.connect(); connected = true; }
    catch (error) { if (unreachable(error)) { context.skip('Postgres unreachable'); return; } throw error; }
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}",public`);
    await client.query(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
    directory = await mkdtemp(path.join(os.tmpdir(), 'public-retention-keys-'));
    process.env.SESSION_KEY_DIRECTORY = directory;
    process.env.RETENTION_IDLE_HOURS = '1';
    ({ dbPool: pool } = await import('./client.ts'));
    pool.options.options = `-c search_path=${schema},public`;
    const { sessionKeyVault: vault } = await import('../crypto/sessionKeyStore.ts');
    const { deleteSessionParticipantData, startRetentionWorker, IDLE_WINDOW_MS, RETIREMENT_LEAD } = await import('./retentionWorker.ts');
    const { IDLE_WINDOW_SQL, idleDeadlineSQL, readRetentionCounts } = await import('./retentionStatus.ts');
    const { withSessionContentWrite, SessionRetentionStateError } = await import('./sessionContentWrite.ts');

    await context.test('participant deletion immediately tombstones, destroys keys, purges content, and rejects later writes in both provider modes', async () => {
      for (const mode of ['no-provider', 'failing-provider']) {
        const id = `participant-delete-${mode}`;
        const conversation = await client.query("INSERT INTO conversations(session_id,retention_mode) VALUES($1,'ephemeral') RETURNING id", [id]);
        await client.query("INSERT INTO conversation_messages(conversation_id,seq,role,content) VALUES($1,1,'user','Synthetic participant deletion content')", [conversation.rows[0].id]);
        await client.query("INSERT INTO chat_logs(id,session_id,message_index,message_type,user_message) VALUES(uuid_generate_v4(),$1,1,'user','Synthetic participant deletion log')", [id]);
        await vault.create(id);
        let attempts = 0;
        const participantProvider = mode === 'no-provider' ? undefined : {
          enabled: true, opportunityOffsets: [1], async recordFailure() { return true; },
          async extract() { attempts++; throw new Error('Synthetic provider failure'); }, async close() {},
        };
        stop = await startRetentionWorker(participantProvider);
        if (participantProvider) {
          for (let limit = Date.now() + 1000; attempts === 0 && Date.now() < limit;) await wait(10);
          assert.ok(attempts > 0, 'the failing test-double provider was exercised');
        }
        assert.equal(await deleteSessionParticipantData(id), true);
        const state = (await client.query('SELECT retired_at,purged_at FROM session_retention_rules WHERE session_id=$1', [id])).rows[0];
        assert.ok(state.retired_at, 'participant deletion commits the retirement tombstone');
        assert.ok(state.purged_at, 'participant deletion records completed purge');
        assert.equal(await vault.has(id), false, 'participant deletion destroys the key immediately');
        assert.deepEqual((await client.query(`SELECT
          (SELECT count(*)::int FROM conversations WHERE session_id=$1) AS conversations,
          (SELECT count(*)::int FROM chat_logs WHERE session_id=$1) AS logs`, [id])).rows[0], { conversations: 0, logs: 0 });
        await assert.rejects(withSessionContentWrite(id, async () => assert.fail('retired content write ran')), SessionRetentionStateError);
        await stop(); stop = undefined;
      }
    });

    const noProviderId = 'public-no-provider';
    const noProviderConversation = await client.query("INSERT INTO conversations(session_id,retention_mode) VALUES($1,'ephemeral') RETURNING id", [noProviderId]);
    await client.query("INSERT INTO conversation_messages(conversation_id,seq,role,content) VALUES($1,1,'user','Synthetic public content')", [noProviderConversation.rows[0].id]);
    await vault.create(noProviderId);
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp()-${IDLE_WINDOW_SQL}
      + ($2 + 600) * INTERVAL '1 millisecond' WHERE session_id=$1`, [noProviderId, RETIREMENT_LEAD]);
    stop = await startRetentionWorker();
    for (let limit = Date.now() + 3000; await vault.has(noProviderId) && Date.now() < limit;) await wait(20);
    await stop(); stop = undefined;
    assert.equal(await vault.has(noProviderId), false);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM conversations WHERE session_id=$1', [noProviderId])).rows[0].count, 0);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM session_measures WHERE session_id=$1', [noProviderId])).rows[0].count, 0);

    const ids = ['public-stalled','public-failed','public-fast-one','public-fast-two','public-fast-three',
      'public-fast-four','public-fast-five','public-fast-six','public-fast-seven'];
    for (const id of ids) {
      const conversation = await client.query("INSERT INTO conversations(session_id,retention_mode) VALUES($1,'ephemeral') RETURNING id", [id]);
      await client.query("INSERT INTO conversation_messages(conversation_id,seq,role,content) VALUES($1,1,'user','Synthetic clustered content')", [conversation.rows[0].id]);
      await vault.create(id);
    }
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp()-${IDLE_WINDOW_SQL}
      + 13000 * INTERVAL '1 millisecond' WHERE session_id=ANY($1::varchar[])`, [ids]);
    const deadlines = new Map((await client.query(`SELECT session_id,EXTRACT(EPOCH FROM ${idleDeadlineSQL()})*1000 AS deadline
      FROM session_retention_rules WHERE session_id=ANY($1::varchar[])`, [ids])).rows.map(row => [row.session_id, Number(row.deadline)]));
    const destroyed = new Map();
    const originalDestroy = vault.destroy.bind(vault);
    vault.destroy = async id => { const result = await originalDestroy(id); if (deadlines.has(id)) destroyed.set(id, Date.now()); return result; };
    const attempts = new Map();
    const provider = {
      enabled: true,
      opportunityOffsets: [IDLE_WINDOW_MS - 20_000],
      async recordFailure() { return true; },
      async extract(id) {
        attempts.set(id, (attempts.get(id) ?? 0) + 1);
        if (id === ids[0]) return new Promise(() => {});
        if (id === ids[1]) throw new Error('Synthetic provider failure');
      },
      async close() {},
    };
    stop = await startRetentionWorker(provider);
    for (let limit = Math.max(...deadlines.values()) + 1000;
      (await Promise.all(ids.map(id => vault.has(id)))).some(Boolean) && Date.now() < limit;) await wait(10);
    await stop(); stop = undefined;
    vault.destroy = originalDestroy;
    const keys = await Promise.all(ids.map(id => vault.has(id)));
    const remainingContent = (await client.query('SELECT count(*)::int AS count FROM conversations WHERE session_id=ANY($1::varchar[])', [ids])).rows[0].count;
    const measureRows = (await client.query('SELECT count(*)::int AS count FROM session_measures WHERE session_id=ANY($1::varchar[])', [ids])).rows[0].count;
    const lateness = ids.map(id => destroyed.get(id) - deadlines.get(id));
    context.diagnostic(JSON.stringify({ deadlines: Object.fromEntries(deadlines), destroyed: Object.fromEntries(destroyed), attempts: Object.fromEntries(attempts), measure_rows: measureRows }));
    assert.deepEqual(keys, Array(ids.length).fill(false));
    assert.equal(remainingContent, 0);
    assert.equal(measureRows, 0, 'test-double provider cannot write session measures');
    assert.ok(Math.max(...ids.slice(0, 8).map(id => deadlines.get(id))) - Math.min(...ids.slice(0, 8).map(id => deadlines.get(id))) < 1000);
    for (const value of lateness) assert.ok(value >= -RETIREMENT_LEAD && value <= 0, 'key destruction stays inside the public deadline');
    assert.ok((attempts.get(ids[0]) ?? 0) > 0, 'stalled provider was exercised');
    assert.ok((attempts.get(ids[1]) ?? 0) > 0, 'failing provider was exercised');

    const noMeasures = await readRetentionCounts(client, false);
    assert.equal(Object.hasOwn(noMeasures, 'missing_measure_count'), false);
    assert.equal(Object.hasOwn(noMeasures, 'unextracted_count'), false);
    assert.deepEqual(runStatus(schema, false), { status: 0,
      output: { overdue_deletion_count: 0, unknown_clock_count: 0, idle_window_ms: IDLE_WINDOW_MS } });
    const researchStatus = runStatus(schema, true);
    assert.equal(researchStatus.status, 1);
    assert.ok(researchStatus.output.missing_measure_count >= ids.length + 1);

    const overdue = await client.query("INSERT INTO conversations(session_id,retention_mode) VALUES('public-overdue','ephemeral') RETURNING id");
    await client.query("INSERT INTO conversation_messages(conversation_id,seq,role,content) VALUES($1,1,'user','Synthetic overdue content')", [overdue.rows[0].id]);
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp()-${IDLE_WINDOW_SQL}-INTERVAL '1 second' WHERE session_id='public-overdue'`);
    for (const configured of [false, true]) {
      const status = runStatus(schema, configured);
      assert.equal(status.status, 1, 'overdue deletion fails in both provider configurations');
      assert.equal(status.output.overdue_deletion_count, 1);
    }
  } finally {
    await stop?.();
    await pool?.end();
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (connected) await client.end();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (oldDirectory === undefined) delete process.env.SESSION_KEY_DIRECTORY; else process.env.SESSION_KEY_DIRECTORY = oldDirectory;
    if (oldWindow === undefined) delete process.env.RETENTION_IDLE_HOURS; else process.env.RETENTION_IDLE_HOURS = oldWindow;
  }
});

test('configured retention has one home and absolute margins cannot invert', async () => {
  const { retentionWindowMilliseconds, STORAGE_CUTOFF, RETIREMENT_LEAD, IDLE_WINDOW_MS } = await import('./retentionStatus.ts');
  assert.ok(STORAGE_CUTOFF > RETIREMENT_LEAD);
  assert.ok(IDLE_WINDOW_MS > STORAGE_CUTOFF);
  assert.throws(() => retentionWindowMilliseconds(STORAGE_CUTOFF / (60 * 60 * 1000)), RangeError);
  const publicFiles = ['retentionWorker.ts','retentionStatus.ts','sessionContentWrite.ts','../../db/schema.sql'];
  const optionalPrivateFiles = ['sessionMeasures.ts'];
  const sources = [];
  for (const file of [...publicFiles, ...optionalPrivateFiles]) {
    try { sources.push([file, await readFile(new URL(file, import.meta.url), 'utf8')]); }
    catch (error) {
      if (error.code !== 'ENOENT' || publicFiles.includes(file)) throw error;
    }
  }
  for (const [file, source] of sources)
    assert.doesNotMatch(source, /INTERVAL\s*'24\s*hours?'|\b24\s*\*\s*60/iu, file);
  const homes = sources.map(([, source]) => source.match(/config\.RETENTION_IDLE_HOURS/gu)?.length ?? 0);
  assert.equal(homes.reduce((a, b) => a + b, 0), 1, 'one configured window derivation');
});

test('both startup configurations automatically start the worker with the app key volume', async context=>{
  try { execFileSync('docker', ['--version'], {stdio:'ignore'}); }
  catch(error) {
    if(error.code==='ENOENT') { context.skip('Docker binary is absent'); return; }
    throw error;
  }
  for(const file of ['docker-compose.yml','docker-compose.dev.yml']) {
    const source=await readFile(new URL(`../../${file}`,import.meta.url),'utf8');
    const service=source.match(/^  retention-worker:\n([\s\S]*?)(?=^  [\w-]+:|^volumes:|^networks:)/m)?.[1];
    assert.ok(service,file);
    assert.match(service,/command: \["node", "--experimental-strip-types", "lib\/db\/retentionWorker.ts"\]/);
    assert.match(service,/restart: unless-stopped/);
    assert.match(service,/bombot_session_keys:\/var\/lib\/bombot\/session-keys/);
    assert.match(service,/condition: service_healthy/);
    assert.doesNotMatch(service,/profiles:|ports:/);
    const config=JSON.parse(execFileSync('docker',['compose','--env-file','/dev/null','-f',file,'config','--no-env-resolution','--format','json'],{
      cwd:new URL('../../',import.meta.url),encoding:'utf8',env:{...process.env,
        POSTGRES_PASSWORD:'synthetic-compose-password',OLLAMA_IMAGE:`ollama/ollama@sha256:${'a'.repeat(64)}`,LLM_MODEL:'synthetic-model'},
    }));
    assert.deepEqual(config.services['retention-worker'].command,['node','--experimental-strip-types','lib/db/retentionWorker.ts']);
    assert.equal(config.services['retention-worker'].restart,'unless-stopped');
    assert.ok(config.services['retention-worker'].volumes.some(v=>v.target==='/var/lib/bombot/session-keys'));
    if(file==='docker-compose.yml') assert.equal(config.networks.data_private.internal,true);
  }
});
