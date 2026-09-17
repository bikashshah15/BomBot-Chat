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
  return ['ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','ENOTFOUND','EPERM','ETIMEDOUT'].includes(error?.code);
}

test('session clock is atomic with conversation and log-only content saves, not best-effort logs', async context => {
  if (!process.env.DATABASE_URL) { context.skip('DATABASE_URL not configured'); return; }
  const schema = `session_clock_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  let connected = false, created = false, pool, directory;
  const oldDirectory = process.env.SESSION_KEY_DIRECTORY;
  try {
    try { await client.connect(); connected = true; }
    catch (error) { if (unreachable(error)) { context.skip('Postgres unreachable'); return; } throw error; }
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}",public`);
    await client.query(execFileSync('git', ['show','4c89844:db/schema.sql'], { encoding: 'utf8' }));
    await client.query(`INSERT INTO conversations(session_id,retention_mode) VALUES('old-known','study');
      INSERT INTO chat_logs(id,session_id,message_index,message_type,user_message)
      VALUES(uuid_generate_v4(),'old-unknown-log',1,'user','Synthetic legacy log')`);
    await client.query(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'));
    assert.equal((await client.query('SELECT count(*)::int AS count FROM session_retention_rules')).rows[0].count,0);
    directory = await mkdtemp(path.join(os.tmpdir(),'bombot-session-clock-keys-'));
    process.env.SESSION_KEY_DIRECTORY = directory;
    const { dbPool } = await import('./client.ts'); pool = dbPool;
    pool.options.options = `-c search_path=${schema},public`;
    const { createConversation, appendConversationMessage } = await import('./conversations.ts');
    const { insertLog, updateAiResponse } = await import('./chatLogs.ts');
    const { SessionRetentionStateError } = await import('./sessionContentWrite.ts');
    const clock = async session => (await client.query('SELECT last_activity_at FROM session_retention_rules WHERE session_id=$1',[session])).rows[0]?.last_activity_at?.toISOString() ?? null;
    const conv = await createConversation('clock-conversation');
    assert.equal(await clock(conv.session_id),null,'conversation creation alone is not content activity');
    await appendConversationMessage({conversation_id:conv.id,seq:1,role:'user',content:'Synthetic question',tool_call_id:null,tool_calls:null});
    const first = await clock(conv.session_id); assert.ok(first);
    await appendConversationMessage({conversation_id:conv.id,seq:2,role:'assistant',content:'Synthetic response',tool_call_id:null,tool_calls:null});
    assert.ok(await clock(conv.session_id)>first,'saved response advances the clock too');
    const noDuplicate = await clock(conv.session_id);
    assert.equal(await appendConversationMessage({conversation_id:conv.id,seq:2,role:'assistant',content:'Ignored duplicate',tool_call_id:null,tool_calls:null}),null);
    assert.equal(await clock(conv.session_id),noDuplicate,'no saved content means no activity update');

    const row = {id:randomUUID(),session_id:'clock-log-only',conversation_id:null,message_index:1,message_type:'user',
      user_message:'Synthetic log-only input',ai_response:null,file_name:null,file_size:null,vulnerability_count:null,user_email:null,
      created_at:'2000-01-01T00:00:00.000Z',updated_at:'2000-01-01T00:00:00.000Z'};
    await insertLog(row);
    const logClock = await clock(row.session_id); assert.ok(logClock);
    assert.ok(logClock.startsWith(new Date().toISOString().slice(0,10)),'clock is server save time, not supplied log time');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM conversations WHERE session_id=$1',[row.session_id])).rows[0].count,0);
    await updateAiResponse(row.session_id,1,'Synthetic saved answer');
    assert.ok(await clock(row.session_id)>logClock);

    // Fail after the activity trigger ran: content and clock must both roll back.
    await client.query(`CREATE FUNCTION reject_fixture_save() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Synthetic forced rollback'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER z_reject_fixture_save AFTER INSERT OR UPDATE ON chat_logs FOR EACH ROW EXECUTE FUNCTION reject_fixture_save()`);
    const beforeFailure = await clock(row.session_id);
    await assert.rejects(updateAiResponse(row.session_id,1,'Must not persist'),/Synthetic forced rollback/);
    assert.equal(await clock(row.session_id),beforeFailure);
    await assert.rejects(insertLog({...row,id:randomUUID(),session_id:'failed-new-session'}),/Synthetic forced rollback/);
    assert.equal(await clock('failed-new-session'),null);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM chat_logs WHERE session_id='failed-new-session'`)).rows[0].count,0);
    await client.query('DROP TRIGGER z_reject_fixture_save ON chat_logs');
    await assert.rejects(insertLog({...row,id:randomUUID(),session_id:'old-unknown-log'}),SessionRetentionStateError);
    assert.equal(await clock('old-unknown-log'),null,'unknown historical policy is never replaced with current config');
    const { getSessionHistory } = await import('./chatLogs.ts');
    assert.equal((await getSessionHistory(row.session_id))[0].ai_response,'Synthetic saved answer');
  } finally {
    if(pool) await pool.end();
    if(created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    if(connected) await client.end();
    if(directory) await rm(directory,{recursive:true,force:true});
    if(oldDirectory===undefined) delete process.env.SESSION_KEY_DIRECTORY; else process.env.SESSION_KEY_DIRECTORY=oldDirectory;
  }
});
