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

test('failed extraction records a failure without postponing destruction; participant deletion preserves results', async context => {
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
    const { prepareDeletion, deleteSessionParticipantData, startRetentionWorker, RETIREMENT_LEAD, STORAGE_CUTOFF, IDLE_WINDOW_MS }=await import('./retentionWorker.ts');
    const { IDLE_WINDOW_SQL, idleDeadlineSQL }=await import('./retentionStatus.ts');
    assert.equal(IDLE_WINDOW_MS,60*60*1000,'configured one-hour window is effective');
    assert.ok(STORAGE_CUTOFF>RETIREMENT_LEAD,'storage closes strictly before retirement opens');
    const { recordUnextractedSession, extractAndStoreSessionMeasures, MeasurePersistenceError }=await import('./sessionMeasures.ts');
    const { withSessionContentWrite, SessionRetentionStateError }=await import('./sessionContentWrite.ts');
    const counts=async id => (await client.query(`SELECT
      (SELECT count(*)::int FROM chat_logs WHERE session_id=$1) AS logs,
      (SELECT count(*)::int FROM conversations WHERE session_id=$1) AS conversations,
      (SELECT count(*)::int FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.session_id=$1) AS messages`,[id])).rows[0];
    const envelopes=new Map();
    for(const [id,mode] of [['expired','ephemeral'],['live','ephemeral'],['retained','study']]) {
      const c=await client.query('INSERT INTO conversations(session_id,retention_mode) VALUES($1,$2) RETURNING id',[id,mode]);
      await sessionKeyVault.create(id);
      const envelope=await sessionKeyVault.encrypt(id,'Synthetic encrypted fixture content'); envelopes.set(id,envelope);
      await client.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content,content_ciphertext,content_nonce,content_auth_tag)
        VALUES($1,1,'user',NULL,$2,$3,$4)`,[c.rows[0].id,envelope.ciphertext,envelope.nonce,envelope.authTag]);
      await client.query(`INSERT INTO chat_logs(id,session_id,message_index,message_type,user_message,user_message_ciphertext,user_message_nonce,user_message_auth_tag)
        VALUES(uuid_generate_v4(),$1,1,'user',NULL,$2,$3,$4)`,[id,envelope.ciphertext,envelope.nonce,envelope.authTag]);
    }
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp()-${IDLE_WINDOW_SQL}-INTERVAL '1 minute' WHERE session_id IN ('expired','retained')`);
    await assert.rejects(withSessionContentWrite('expired',async()=>assert.fail('expired content save must not run')),SessionRetentionStateError,
      'the configured one-hour expiry rejects content even though 24 hours have not elapsed');
    await prepareDeletion({ extract: async()=>{ throw new Error('Must never persist this participant-shaped error'); },
      recordFailure: ()=>recordUnextractedSession('expired','extraction_failed') },1000);
    const failure=(await client.query(`SELECT result FROM session_measures WHERE session_id='expired'`)).rows[0].result;
    assert.equal(failure.status,'unextracted');
    assert.equal(failure.scan_provenance[0].osv_mode,'unknown');
    assert.equal(failure.resolution_provenance.osv_mode,'unknown');
    assert.equal(JSON.stringify(failure).includes('participant-shaped'),false);
    assert.equal(JSON.stringify(failure).includes('expired'),false,'the row key must not leak into the failure body');
    const {readRetentionCounts}=await import('./retentionStatus.ts');
    await client.query(`INSERT INTO conversations(session_id,retention_mode) VALUES('empty-clock-fixture','ephemeral')`);
    assert.deepEqual(await readRetentionCounts(client),{unextracted_count:1,overdue_deletion_count:1,unknown_clock_count:0,missing_measure_count:0});
    await client.query(`UPDATE session_retention_rules SET last_activity_at=NULL WHERE session_id='live'`);
    assert.equal((await readRetentionCounts(client)).unknown_clock_count,1,'content with an unknown clock is counted, empty conversations are not');
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp() WHERE session_id='live'`);
    let statusOutput;
    try {
      execFileSync(process.execPath,['--experimental-strip-types','--import','dotenv/config','lib/db/retentionStatus.ts'],{
        encoding:'utf8',env:{...process.env,PGOPTIONS:`-c search_path=${schema},public`},stdio:['ignore','pipe','pipe'],
      });
      assert.fail('overdue content must produce a non-zero operator exit');
    } catch(error) { assert.equal(error.status,1); statusOutput=error.stdout; assert.equal(error.stderr,''); }
    assert.deepEqual(JSON.parse(statusOutput),{unextracted_count:1,overdue_deletion_count:1,unknown_clock_count:0,missing_measure_count:0,idle_window_ms:IDLE_WINDOW_MS});
    assert.equal(await deleteSessionParticipantData('expired',true),true);
    assert.deepEqual(await counts('expired'),{logs:0,conversations:0,messages:0});
    await assert.rejects(sessionKeyVault.encrypt('expired','Synthetic probe'));
    await assert.rejects(sessionKeyVault.decrypt('expired',envelopes.get('expired')),'a retained ciphertext envelope cannot be recovered after unlink');
    assert.equal(await sessionKeyVault.decrypt('live',envelopes.get('live')),'Synthetic encrypted fixture content');
    assert.equal((await client.query(`SELECT result FROM session_measures WHERE session_id='expired'`)).rows[0].result.status,'unextracted');
    assert.equal(await deleteSessionParticipantData('live',true),false);
    assert.equal(await deleteSessionParticipantData('retained',true),false);
    assert.deepEqual(await counts('live'),{logs:1,conversations:1,messages:1});
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
    assert.equal((await readRetentionCounts(client)).missing_measure_count,1,'absence of a row after deletion is counted');
    assert.equal((await readRetentionCounts(client)).overdue_deletion_count,0);
    try {
      execFileSync(process.execPath,['--experimental-strip-types','--import','dotenv/config','lib/db/retentionStatus.ts'],{
        encoding:'utf8',env:{...process.env,PGOPTIONS:`-c search_path=${schema},public`},stdio:['ignore','pipe','pipe'],
      });
      assert.fail('missing measures alone must produce a non-zero operator exit');
    } catch(error) {
      assert.equal(error.status,1); assert.equal(error.stderr,'');
      const output=JSON.parse(error.stdout);
      assert.equal(output.missing_measure_count,1); assert.equal(output.overdue_deletion_count,0);
      assert.ok(Object.values(output).every(value=>typeof value==='number'),'operator output is numeric only');
      assert.equal(error.stdout.includes('deliberately-unmeasured'),false);
    }
    const laterEnvelope=await sessionKeyVault.encrypt('live','Synthetic later response CVE-2099-12345');
    await client.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content,content_ciphertext,content_nonce,content_auth_tag)
      SELECT id,2,'assistant',NULL,$1,$2,$3 FROM conversations WHERE session_id='live'`,
      [laterEnvelope.ciphertext,laterEnvelope.nonce,laterEnvelope.authTag]);
    await assert.rejects(extractAndStoreSessionMeasures('live',current),MeasurePersistenceError,
      'later participant activity invalidates a successful earlier extraction revision');
    const laterRevision=(await client.query(`SELECT last_activity_at::text AS activity FROM session_retention_rules WHERE session_id='live'`)).rows[0].activity;
    assert.equal((await extractAndStoreSessionMeasures('live',laterRevision)).emitted_count,1,'a fresh pass replaces the earlier result');
    const saving=await pool.connect();
    await saving.query('BEGIN');
    await saving.query(`SELECT 1 FROM session_retention_rules WHERE session_id='live' FOR UPDATE`);
    await saving.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp()-${IDLE_WINDOW_SQL}
      + $1 * INTERVAL '1 millisecond' WHERE session_id='live'`,[RETIREMENT_LEAD]);
    const waitingRetirer=await pool.connect();
    const racingRetirement=deleteSessionParticipantData('live',true,{connect:async()=>waitingRetirer});
    const lockLimit=Date.now()+1000;
    let waitingOnLock=false;
    while(Date.now()<lockLimit) {
      waitingOnLock=(await client.query(`SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1`,[waitingRetirer.processID])).rows[0]?.waiting;
      if(waitingOnLock) break;
      await new Promise(resolve=>setTimeout(resolve,1));
    }
    assert.equal(waitingOnLock,true,'retirement really races the content transaction while it holds the session row lock');
    await saving.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content,content_ciphertext,content_nonce,content_auth_tag)
      SELECT id,3,'assistant',NULL,$1,$2,$3 FROM conversations WHERE session_id='live'`,
      [laterEnvelope.ciphertext,laterEnvelope.nonce,laterEnvelope.authTag]);
    await saving.query('COMMIT'); saving.release();
    assert.equal(await racingRetirement,false,'content committed before the tombstone moves the clock; locked retirement backs off');
    assert.equal(await sessionKeyVault.has('live'),true);
    await client.query(`INSERT INTO conversations(session_id,retention_mode) VALUES('committed-tombstone-fixture','ephemeral')`);
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp(),retired_at=clock_timestamp()
      WHERE session_id='committed-tombstone-fixture'`);
    await assert.rejects(extractAndStoreSessionMeasures('committed-tombstone-fixture'),MeasurePersistenceError,
      'a completed result cannot be stored after a committed tombstone');
    await assert.rejects(withSessionContentWrite('expired',async()=>{}),SessionRetentionStateError);
    await assert.rejects(client.query(`INSERT INTO conversations(session_id,retention_mode) VALUES('expired','ephemeral')`),error=>error.constraint==='session_retention_rule_matches');
    let recorded=false;
    await prepareDeletion({ extract:()=>new Promise(()=>{}), recordFailure:async()=>{ recorded=true; } },10);
    assert.equal(recorded,true,'a never-settling extractor is bounded');
    assert.equal(await deleteSessionParticipantData('retained'),true,'explicit participant request also removes study content');
    assert.deepEqual(await counts('retained'),{logs:0,conversations:0,messages:0});
    assert.deepEqual(await counts('live'),{logs:1,conversations:1,messages:3});
    assert.equal(await deleteSessionParticipantData('expired',true),true,'restart cleanup is idempotent');
    const scheduled=await client.query(`INSERT INTO conversations(session_id,retention_mode) VALUES('scheduled','ephemeral') RETURNING id`);
    await client.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content,pinned)
      VALUES($1,1,'user','Synthetic timer fixture',true)`,[scheduled.rows[0].id]);
    await sessionKeyVault.create('scheduled');
    await client.query(`UPDATE session_retention_rules SET last_activity_at=clock_timestamp()-${IDLE_WINDOW_SQL}
      + $1 * INTERVAL '1 millisecond' WHERE session_id='scheduled'`,[RETIREMENT_LEAD+2000]);
    const scheduledRevision=(await client.query(`SELECT last_activity_at::text AS revision FROM session_retention_rules WHERE session_id='scheduled'`)).rows[0].revision;
    await assert.rejects(extractAndStoreSessionMeasures('scheduled',scheduledRevision),MeasurePersistenceError,
      'a result inside the storage cutoff is refused');
    const stop=await startRetentionWorker(()=>new Promise(()=>{}));
    try {
      const limit=Date.now()+3000;
      while(await sessionKeyVault.has('scheduled') && Date.now()<limit) await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(await sessionKeyVault.has('scheduled'),false,'real deadline callback destroys the key while extraction never settles');
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
    const finalDeadlines=new Map((await client.query(`SELECT session_id,
      EXTRACT(EPOCH FROM ${idleDeadlineSQL()})*1000 AS deadline FROM session_retention_rules
      WHERE session_id=ANY($1::varchar[])`,[finalIds])).rows.map(row=>[row.session_id,Number(row.deadline)]));
    const finalDestruction=new Map();
    const finalDestroy=sessionKeyVault.destroy.bind(sessionKeyVault);
    sessionKeyVault.destroy=async id=>{ await finalDestroy(id); if(finalDeadlines.has(id)) finalDestruction.set(id,Date.now()); };
    const finalBlocker=new pg.Client({connectionString:process.env.DATABASE_URL});
    await finalBlocker.connect(); await finalBlocker.query(`SET search_path TO "${schema}",public`);
    await finalBlocker.query('BEGIN'); await finalBlocker.query('LOCK TABLE session_measures IN ACCESS EXCLUSIVE MODE');
    let keysGoneWhileBlocked=false;
    const finalRelease=setTimeout(async()=>{
      keysGoneWhileBlocked=(await Promise.all(finalIds.map(id=>sessionKeyVault.has(id)))).every(value=>!value);
      await finalBlocker.query('COMMIT');
    },3000);
    let finalStop;
    try {
      finalStop=await startRetentionWorker(()=>new Promise(()=>{}));
      assert.equal(keysGoneWhileBlocked,true,'all keys are destroyed while the failure store is still locked');
      await finalStop(); finalStop=undefined; // Drain queued writers, never delay retirement.
      const outcomes=await client.query('SELECT session_id,result FROM session_measures WHERE session_id=ANY($1::varchar[])',[finalIds]);
      assert.equal(outcomes.rowCount,finalIds.length,'every final-window failure write survives contention past retirement and pool queuing');
      for(const row of outcomes.rows) {
        assert.equal(row.result.status,'unextracted'); assert.equal(row.result.error_class,'extraction_deadline');
        assert.equal(JSON.stringify(row.result).includes(row.session_id),false);
      }
      const tombstones=await client.query(`SELECT session_id,EXTRACT(EPOCH FROM retired_at)*1000 AS retired
        FROM session_retention_rules WHERE session_id=ANY($1::varchar[])`,[finalIds]);
      for(const row of tombstones.rows) {
        assert.ok(Number(row.retired)>=finalDeadlines.get(row.session_id)-RETIREMENT_LEAD);
        assert.ok(finalDestruction.get(row.session_id)<=Math.ceil(finalDeadlines.get(row.session_id)));
      }
      context.diagnostic(JSON.stringify({fixture_group:'contended_final_window',
        min_key_lateness_ms:Math.min(...finalIds.map(id=>finalDestruction.get(id)-Math.ceil(finalDeadlines.get(id)))),
        max_key_lateness_ms:Math.max(...finalIds.map(id=>finalDestruction.get(id)-Math.ceil(finalDeadlines.get(id))))}));
    } finally {
      clearTimeout(finalRelease); await finalBlocker.query('ROLLBACK'); await finalStop?.(); await finalBlocker.end();
      sessionKeyVault.destroy=finalDestroy;
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
    const destructionTimes=new Map();
    const originalDestroy=sessionKeyVault.destroy.bind(sessionKeyVault);
    sessionKeyVault.destroy=async id=>{
      const result=await originalDestroy(id);
      if(deadlines.has(id)) destructionTimes.set(id,Date.now());
      return result;
    };
    const held=await Promise.all(Array.from({length:5},()=>pool.connect()));
    const logs=[];
    const originals={warn:console.warn,error:console.error};
    console.warn=(...args)=>logs.push(args.join(' '));
    console.error=(...args)=>logs.push(args.join(' '));
    let retryAttempts=0;
    let lateAttemptCount=0;
    const concurrentStop=await startRetentionWorker(id=>{
      if(Date.now()>=deadlines.get(id)) lateAttemptCount++;
      if(id===ids[0]) return new Promise(()=>{});
      if(id===ids[2] && retryAttempts++===0) return Promise.reject(new Error('Synthetic retry failure'));
      return undefined; // Real extraction in a killable process/private pool.
    });
    try {
      const limit=Date.now()+STORAGE_CUTOFF+4000;
      while((await Promise.all(ids.map(id=>sessionKeyVault.has(id)))).some(Boolean) && Date.now()<limit)
        await new Promise(resolve=>setTimeout(resolve,10));
      assert.deepEqual(await Promise.all(ids.map(id=>sessionKeyVault.has(id))),[false,false,false,false],
        'stalled extraction and an exhausted ordinary pool do not prevent any deadline deletion');
      assert.ok(retryAttempts>=2,'a failed attempt is retried while the session window remains open');
      assert.equal(lateAttemptCount,0,'no extraction attempt starts after its session deadline');
      for(const id of ids.slice(1)) {
        const outcome=(await client.query('SELECT result FROM session_measures WHERE session_id=$1',[id])).rows[0]?.result;
        assert.ok(outcome,'every non-stalled session stores a result');
        assert.notEqual(outcome.status,'unextracted','another session cannot cause extraction failure');
      }
      assert.equal((await client.query('SELECT result FROM session_measures WHERE session_id=$1',[ids[0]])).rows[0].result.status,
        'unextracted','a stalled session retains its pre-recorded failure under real recording contention');
      for(const line of logs) for(const id of ids) assert.equal(line.includes(id),false,'aggregate logs contain no fixture session ID');
      const startupLines=logs.map(line=>JSON.parse(line)).filter(line=>line.event==='retention_worker_start');
      assert.equal(startupLines.length,1,'effective window is logged once at startup');
      assert.equal(startupLines[0].idle_window_ms,IDLE_WINDOW_MS);
      const lateKeyCount=ids.filter(id=>destructionTimes.get(id)>Math.ceil(deadlines.get(id))).length;
      const retirementRows=await client.query(`SELECT session_id,EXTRACT(EPOCH FROM retired_at)*1000 AS retired
        FROM session_retention_rules WHERE session_id=ANY($1::varchar[])`,[ids]);
      for(const row of retirementRows.rows) assert.ok(Number(row.retired)>=deadlines.get(row.session_id)-RETIREMENT_LEAD,
        'retirement must not begin before the named lead cutoff');
      context.diagnostic(JSON.stringify({late_key_count:lateKeyCount,
        min_key_lateness_ms:Math.min(...ids.map(id=>destructionTimes.get(id)-Math.ceil(deadlines.get(id)))),
        max_key_lateness_ms:Math.max(...ids.map(id=>destructionTimes.get(id)-Math.ceil(deadlines.get(id))))}));
      assert.equal(lateKeyCount,0,'every fixture key must be destroyed by its own deadline, not a later polling limit');
    } finally {
      concurrentStop();
      sessionKeyVault.destroy=originalDestroy;
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

test('configured retention has one home and absolute margins cannot invert',async()=>{
  const {retentionWindowMilliseconds,STORAGE_CUTOFF,RETIREMENT_LEAD,IDLE_WINDOW_MS}=await import('./retentionStatus.ts');
  assert.ok(STORAGE_CUTOFF>RETIREMENT_LEAD);
  assert.ok(IDLE_WINDOW_MS>STORAGE_CUTOFF);
  assert.throws(()=>retentionWindowMilliseconds(STORAGE_CUTOFF/(60*60*1000)),RangeError);
  for(const file of ['retentionWorker.ts','retentionStatus.ts','sessionContentWrite.ts','sessionMeasures.ts','../../db/schema.sql']) {
    const source=await readFile(new URL(file,import.meta.url),'utf8');
    assert.doesNotMatch(source,/INTERVAL\s*'24\s*hours?'|\b24\s*\*\s*60/iu,file);
  }
  const homes=await Promise.all(['retentionWorker.ts','retentionStatus.ts','sessionContentWrite.ts','sessionMeasures.ts'].map(async file=>
    (await readFile(new URL(file,import.meta.url),'utf8')).match(/config\.RETENTION_IDLE_HOURS/gu)?.length??0));
  assert.equal(homes.reduce((a,b)=>a+b,0),1,'one configured window derivation');
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
