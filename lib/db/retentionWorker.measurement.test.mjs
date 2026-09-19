import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import 'dotenv/config';
import pg from 'pg';

function unreachable(error) {
  if (error instanceof AggregateError) return error.errors.every(unreachable);
  return ['ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','ENOTFOUND','EPERM','ETIMEDOUT'].includes(error?.code);
}

test('failure records, measure survival, and extraction contention preserve measurement semantics', async context => {
  if (!process.env.DATABASE_URL) { context.skip('DATABASE_URL not configured'); return; }
  const schema = `retention_fixture_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  let connected=false, created=false, pool, directory;
  const oldDirectory=process.env.SESSION_KEY_DIRECTORY;
  const oldWindow=process.env.RETENTION_IDLE_HOURS;
  try {
    try { await client.connect(); connected=true; }
    catch(error) { if(unreachable(error)) { context.skip('Postgres unreachable'); return; } throw error; }
    await client.query(`CREATE SCHEMA "${schema}"`); created=true;
    await client.query(`SET search_path TO "${schema}",public`);
    await client.query(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'));
    directory=await mkdtemp(path.join(os.tmpdir(),'retention-worker-fixture-keys-'));
    process.env.SESSION_KEY_DIRECTORY=directory;
    process.env.RETENTION_IDLE_HOURS='1';
    const { dbPool }=await import('./client.ts'); pool=dbPool;
    pool.options.options=`-c search_path=${schema},public`;
    const { sessionKeyVault }=await import('../crypto/sessionKeyStore.ts');
    const { deleteSessionParticipantData, startRetentionWorker, RETIREMENT_LEAD, STORAGE_CUTOFF }=await import('./retentionWorker.ts');
    const { createMeasureProvider }=await import('../measures/researchProvider.ts');
    const { IDLE_WINDOW_SQL, idleDeadlineSQL }=await import('./retentionStatus.ts');
    const { recordUnextractedSession, extractAndStoreSessionMeasures, MeasurePersistenceError }=await import('./sessionMeasures.ts');
    for(const [id,mode] of [['expired','ephemeral'],['live','ephemeral']]) {
      const c=await client.query('INSERT INTO conversations(session_id,retention_mode) VALUES($1,$2) RETURNING id',[id,mode]);
      await sessionKeyVault.create(id);
      const envelope=await sessionKeyVault.encrypt(id,'Synthetic encrypted fixture content');
      await client.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content,content_ciphertext,content_nonce,content_auth_tag)
        VALUES($1,1,'user',NULL,$2,$3,$4)`,[c.rows[0].id,envelope.ciphertext,envelope.nonce,envelope.authTag]);
      await client.query(`INSERT INTO chat_logs(id,session_id,message_index,message_type,user_message,user_message_ciphertext,user_message_nonce,user_message_auth_tag)
        VALUES(uuid_generate_v4(),$1,1,'user',NULL,$2,$3,$4)`,[id,envelope.ciphertext,envelope.nonce,envelope.authTag]);
    }
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp()-${IDLE_WINDOW_SQL}-INTERVAL '1 minute' WHERE session_id='expired'`);
    await recordUnextractedSession('expired','extraction_failed');
    const failure=(await client.query(`SELECT result FROM session_measures WHERE session_id='expired'`)).rows[0].result;
    assert.equal(failure.status,'unextracted');
    assert.equal(failure.scan_provenance[0].osv_mode,'unknown');
    assert.equal(failure.resolution_provenance.osv_mode,'unknown');
    assert.equal(JSON.stringify(failure).includes('participant-shaped'),false);
    assert.equal(JSON.stringify(failure).includes('expired'),false,'the row key must not leak into the failure body');
    const {readRetentionCounts}=await import('./retentionStatus.ts');
    await deleteSessionParticipantData('expired',true);
    assert.equal((await client.query(`SELECT result FROM session_measures WHERE session_id='expired'`)).rows[0].result.status,'unextracted');
    await client.query(`CREATE FUNCTION reject_measure_fixture() RETURNS trigger AS $$ BEGIN
      IF NEW.result->>'status' IS DISTINCT FROM 'unextracted' THEN RAISE EXCEPTION 'Synthetic persistence failure'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_measure_fixture BEFORE INSERT ON session_measures FOR EACH ROW EXECUTE FUNCTION reject_measure_fixture()`);
    let persistenceError;
    await assert.rejects(extractAndStoreSessionMeasures('live'),error=>{
      persistenceError=error; return error instanceof MeasurePersistenceError;
    });
    await recordUnextractedSession('live','extraction_failed',persistenceError.resolutionProvenance);
    const knownResolution=(await client.query(`SELECT result FROM session_measures WHERE session_id='live'`)).rows[0].result;
    assert.equal(knownResolution.resolution_provenance.osv_mode,'offline','completed local resolution provenance survives a failed write');
    assert.equal(knownResolution.resolution_provenance.status,'missing_snapshot');
    await client.query('DROP TRIGGER reject_measure_fixture ON session_measures');
    const previous=(await client.query(`SELECT last_activity_at::text AS activity FROM session_retention_rules WHERE session_id='live'`)).rows[0].activity;
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp() WHERE session_id='live'`);
    await recordUnextractedSession('live','extraction_deadline',undefined,previous);
    assert.equal((await client.query(`SELECT result FROM session_measures WHERE session_id='live'`)).rows[0].result.error_class,'extraction_failed','a stale attempt cannot overwrite a newer activity epoch');
    const current=(await client.query(`SELECT last_activity_at::text AS activity FROM session_retention_rules WHERE session_id='live'`)).rows[0].activity;
    await recordUnextractedSession('live','extraction_deadline',undefined,current);
    assert.equal((await client.query(`SELECT result FROM session_measures WHERE session_id='live'`)).rows[0].result.error_class,'extraction_deadline','a current microsecond-precision activity token is accepted');
    assert.equal((await extractAndStoreSessionMeasures('live',current)).emitted_count,0);
    assert.notEqual((await client.query(`SELECT result FROM session_measures WHERE session_id='live'`)).rows[0].result.status,
      'unextracted','success replaces the pre-recorded failure for the current activity epoch');
    await client.query(`INSERT INTO conversations(session_id,retention_mode) VALUES('deliberately-unmeasured','ephemeral')`);
    await sessionKeyVault.create('deliberately-unmeasured');
    await deleteSessionParticipantData('deliberately-unmeasured');
    assert.equal((await readRetentionCounts(client,true)).missing_measure_count,1,'absence of a row after deletion is counted');
    try {
      execFileSync(process.execPath,['--experimental-strip-types','--import','dotenv/config','lib/db/retentionStatus.ts'],{
        encoding:'utf8',env:{...process.env,MEASURE_PROVIDER_MODULE:path.resolve('lib/measures/researchProvider.ts'),PGOPTIONS:`-c search_path=${schema},public`},stdio:['ignore','pipe','pipe'],
      });
      assert.fail('missing measures alone must produce a non-zero operator exit');
    } catch(error) {
      assert.equal(error.status,1); assert.equal(error.stderr,'');
      const output=JSON.parse(error.stdout);
      assert.equal(output.missing_measure_count,1);
      assert.ok(Object.values(output).every(value=>typeof value==='number'),'operator output is numeric only');
      assert.equal(error.stdout.includes('deliberately-unmeasured'),false);
    }
    const laterEnvelope=await sessionKeyVault.encrypt('live','Synthetic later response CVE-2099-12345');
    await client.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content,content_ciphertext,content_nonce,content_auth_tag)
      SELECT id,2,'assistant',NULL,$1,$2,$3 FROM conversations WHERE session_id='live'`,
      [laterEnvelope.ciphertext,laterEnvelope.nonce,laterEnvelope.authTag]);
    await assert.rejects(extractAndStoreSessionMeasures('live',current),MeasurePersistenceError,
      'later participant activity invalidates a successful earlier extraction revision');
    assert.equal(await recordUnextractedSession('live','extraction_failed',undefined,current),false,
      'stale activity cannot overwrite a completed result');
    const laterRevision=(await client.query(`SELECT last_activity_at::text AS activity FROM session_retention_rules WHERE session_id='live'`)).rows[0].activity;
    assert.equal(await recordUnextractedSession('live','extraction_failed',undefined,laterRevision),true,
      'a new activity epoch can replace an earlier successful measure with its own fallback');
    assert.equal((await extractAndStoreSessionMeasures('live',laterRevision,pool,new AbortController().signal)).emitted_count,1,'a fresh pass replaces the earlier result');
    assert.equal(await recordUnextractedSession('live','extraction_deadline',undefined,laterRevision),false,
      'same-epoch fallback cannot overwrite successful extraction, including during retirement admission races');
    assert.equal((await client.query(`SELECT result FROM session_measures WHERE session_id='live'`)).rows[0].result.emitted_count,1);
    await client.query(`INSERT INTO conversations(session_id,retention_mode) VALUES('committed-tombstone-fixture','ephemeral')`);
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp(),retired_at=clock_timestamp()
      WHERE session_id='committed-tombstone-fixture'`);
    await assert.rejects(extractAndStoreSessionMeasures('committed-tombstone-fixture'),MeasurePersistenceError,
      'a completed result cannot be stored after a committed tombstone');
    const scheduled=await client.query(`INSERT INTO conversations(session_id,retention_mode) VALUES('scheduled','ephemeral') RETURNING id`);
    await client.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content,pinned)
      VALUES($1,1,'user','Synthetic timer fixture',true)`,[scheduled.rows[0].id]);
    await sessionKeyVault.create('scheduled');
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp()-${IDLE_WINDOW_SQL}
      + $1 * INTERVAL '1 millisecond' WHERE session_id='scheduled'`,[RETIREMENT_LEAD+2000]);
    const scheduledRevision=(await client.query(`SELECT last_activity_at::text AS revision FROM session_retention_rules WHERE session_id='scheduled'`)).rows[0].revision;
    await assert.rejects(extractAndStoreSessionMeasures('scheduled',scheduledRevision),MeasurePersistenceError,
      'a result inside the storage cutoff is refused');
    const stop=await startRetentionWorker(createMeasureProvider({extract:()=>new Promise(()=>{})}));
    try {
      const limit=Date.now()+3000;
      while(await sessionKeyVault.has('scheduled') && Date.now()<limit) await new Promise(resolve=>setTimeout(resolve,20));
      const outcome=(await client.query(`SELECT result FROM session_measures WHERE session_id='scheduled'`)).rows[0].result;
      assert.equal(outcome.status,'unextracted');
      assert.equal(outcome.error_class,'extraction_deadline','failure records remain writable after result storage closes');
    } finally { stop(); }
    const finalIds=['record-contended-one','record-contended-two','record-contended-three',
      'record-contended-four','record-contended-five','record-contended-six','record-contended-seven'];
    for(const id of finalIds) {
      const conversation=await client.query(`INSERT INTO conversations(session_id,retention_mode) VALUES($1,'ephemeral') RETURNING id`,[id]);
      await client.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content)
        VALUES($1,1,'user','Synthetic final-window recording fixture')`,[conversation.rows[0].id]);
      await sessionKeyVault.create(id);
    }
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp()-${IDLE_WINDOW_SQL}
      + $2 * INTERVAL '1 millisecond' WHERE session_id=ANY($1::varchar[])`,[finalIds,RETIREMENT_LEAD+600]);
    const finalBlocker=new pg.Client({connectionString:process.env.DATABASE_URL});
    await finalBlocker.connect(); await finalBlocker.query(`SET search_path TO "${schema}",public`);
    await finalBlocker.query('BEGIN'); await finalBlocker.query('LOCK TABLE session_measures IN ACCESS EXCLUSIVE MODE');
    const finalRelease=setTimeout(async()=>{
      await finalBlocker.query('COMMIT');
    },3000);
    let finalStop;
    try {
      finalStop=await startRetentionWorker(createMeasureProvider({extract:()=>new Promise(()=>{})}));
      await finalStop(); finalStop=undefined; // Drain queued writers, never delay retirement.
      const outcomes=await client.query('SELECT session_id,result FROM session_measures WHERE session_id=ANY($1::varchar[])',[finalIds]);
      assert.equal(outcomes.rowCount,finalIds.length,'every final-window failure write survives contention past retirement and pool queuing');
      for(const row of outcomes.rows) {
        assert.equal(row.result.status,'unextracted'); assert.equal(row.result.error_class,'extraction_deadline');
        assert.equal(JSON.stringify(row.result).includes(row.session_id),false);
      }
    } finally {
      clearTimeout(finalRelease); await finalBlocker.query('ROLLBACK'); await finalStop?.(); await finalBlocker.end();
    }
    const ids=['multi-stalled-fixture','multi-fast-fixture','multi-retry-fixture','multi-fast-second-fixture'];
    for(const id of ids) {
      const conversation=await client.query(`INSERT INTO conversations(session_id,retention_mode) VALUES($1,'ephemeral') RETURNING id`,[id]);
      await client.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content,pinned)
        VALUES($1,1,'user','Synthetic concurrent-deadline fixture',true)`,[conversation.rows[0].id]);
      await sessionKeyVault.create(id);
    }
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp()-${IDLE_WINDOW_SQL}
      + $2 * INTERVAL '1 millisecond' WHERE session_id=ANY($1::varchar[])`,[ids,STORAGE_CUTOFF+3000]);
    const deadlines=new Map((await client.query(`SELECT session_id,
      EXTRACT(EPOCH FROM ${idleDeadlineSQL()})*1000 AS deadline
      FROM session_retention_rules WHERE session_id=ANY($1::varchar[])`,[ids])).rows.map(row=>[row.session_id,Number(row.deadline)]));
    const held=await Promise.all(Array.from({length:5},()=>pool.connect()));
    const logs=[];
    const originals={warn:console.warn,error:console.error};
    console.warn=(...args)=>logs.push(args.join(' '));
    console.error=(...args)=>logs.push(args.join(' '));
    let retryAttempts=0;
    let lateAttemptCount=0;
    const concurrentStop=await startRetentionWorker(createMeasureProvider({extract:id=>{
      if(Date.now()>=deadlines.get(id)) lateAttemptCount++;
      if(id===ids[0]) return new Promise(()=>{});
      if(id===ids[2] && retryAttempts++===0) return Promise.reject(new Error('Synthetic retry failure'));
      return undefined; // Real extraction on a private connection/killable scoring thread.
    }}));
    try {
      const limit=Date.now()+STORAGE_CUTOFF+4000;
      while((await Promise.all(ids.map(id=>sessionKeyVault.has(id)))).some(Boolean) && Date.now()<limit)
        await new Promise(resolve=>setTimeout(resolve,10));
      const outcomes=new Map((await client.query('SELECT session_id,result FROM session_measures WHERE session_id=ANY($1::varchar[])',[ids])).rows
        .map(row=>[row.session_id,row.result]));
      const evidence=ids.map(id=>({session_id:id,deadline_ms:deadlines.get(id),
        status:outcomes.has(id)?outcomes.get(id).status??'extracted':'missing',error_class:outcomes.get(id)?.error_class??null}));
      context.diagnostic(JSON.stringify({fixture_group:'concurrent_deadlines',sessions:evidence,
        logs,retry_attempts:retryAttempts,late_attempt_count:lateAttemptCount}));
      assert.ok(retryAttempts>=2,'a failed attempt is retried while the session window remains open');
      assert.equal(lateAttemptCount,0,'no extraction attempt starts after its session deadline');
      for(const id of ids.slice(1)) {
        const outcome=outcomes.get(id);
        const details=JSON.stringify(evidence.find(row=>row.session_id===id));
        assert.ok(outcome,`every non-stalled session stores a result: ${details}`);
        assert.notEqual(outcome.status,'unextracted',`another session cannot cause extraction failure: ${details}`);
      }
      assert.equal((await client.query('SELECT result FROM session_measures WHERE session_id=$1',[ids[0]])).rows[0].result.status,
        'unextracted','a stalled session retains its pre-recorded failure under real recording contention');
      for(const line of logs) for(const id of ids) assert.equal(line.includes(id),false,'aggregate logs contain no fixture session ID');
    } finally {
      await concurrentStop();
      for(const connection of held) connection.release();
      console.warn=originals.warn; console.error=originals.error;
    }
  } finally {
    if(pool) await pool.end();
    if(created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    if(connected) await client.end();
    if(directory) await rm(directory,{recursive:true,force:true});
    if(oldDirectory===undefined) delete process.env.SESSION_KEY_DIRECTORY; else process.env.SESSION_KEY_DIRECTORY=oldDirectory;
    if(oldWindow===undefined) delete process.env.RETENTION_IDLE_HOURS; else process.env.RETENTION_IDLE_HOURS=oldWindow;
  }
});
