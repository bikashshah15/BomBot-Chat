import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import 'dotenv/config';
import pg from 'pg';

// INC-12e's parent predates metadata envelopes; pin it to keep the legacy replay proof historical.
const PRE_METADATA_SCHEMA_COMMIT = 'e8a5d3e93a0299428e122b975f5bac0b85dd11b9';

function unreachable(error) {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(unreachable);
  return ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPERM', 'ETIMEDOUT'].includes(error?.code);
}

test('metadata envelopes preserve legacy replay, reject mixed/partial rows, stamp activity and become unreadable after unlink', async context => {
  if (!process.env.DATABASE_URL) { context.skip('DATABASE_URL not configured'); return; }
  let preChangeSchema;
  try {
    preChangeSchema = execFileSync('git', ['show', `${PRE_METADATA_SCHEMA_COMMIT}:db/schema.sql`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    context.skip(`Pre-change schema unavailable: git show ${PRE_METADATA_SCHEMA_COMMIT}:db/schema.sql`);
    return;
  }
  assert.doesNotMatch(preChangeSchema, /\bhas_tool_calls\b/, 'Pinned schema must predate metadata envelopes');
  const schema = `metadata_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  let connected = false, created = false, pool, keys;
  const keyDirectory = await mkdtemp(path.join(os.tmpdir(), 'bombot-metadata-keys-'));
  const previousDirectory = process.env.SESSION_KEY_DIRECTORY;
  process.env.SESSION_KEY_DIRECTORY = keyDirectory;
  try {
    try { await client.connect(); connected = true; }
    catch (error) { if (unreachable(error)) { context.skip('Postgres unreachable'); return; } throw error; }
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}", public`);
    // A real row under the exact pre-change schema, not an inferred legacy shape.
    await client.query(preChangeSchema);
    const session = `metadata-${randomUUID()}`;
    const conversation = (await client.query('INSERT INTO conversations(session_id) VALUES($1) RETURNING id', [session])).rows[0].id;
    const calls = [{ id: 'synthetic-call', name: 'query_osv', arguments: '{"package":"synthetic-private"}' }];
    await client.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content,tool_calls,tool_call_id)
      VALUES ($1,1,'user','question',NULL,NULL),($1,2,'assistant','', $2,NULL),
      ($1,3,'tool','result',NULL,'synthetic-call'),($1,4,'assistant','answer',NULL,NULL)`, [conversation, JSON.stringify(calls)]);
    const logId = randomUUID();
    await client.query(`INSERT INTO chat_logs(id,session_id,message_index,message_type,file_name)
      VALUES($1,$2,1,'file_upload','synthetic-private.json')`, [logId, session]);
    const beforeLogs = (await client.query('SELECT * FROM chat_logs')).rows;
    const beforeMessages = (await client.query('SELECT * FROM conversation_messages ORDER BY seq')).rows;
    const beforeReplay = (await client.query(`SELECT seq FROM conversation_messages WHERE conversation_id=$1 AND seq >=
      (SELECT seq FROM conversation_messages WHERE conversation_id=$1 AND role='assistant'
      AND seq<3 AND jsonb_array_length(COALESCE(tool_calls,'[]'))>0 ORDER BY seq DESC LIMIT 1) ORDER BY seq`, [conversation])).rows;
    const sql = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8');
    for (let replay = 0; replay < 2; replay++) {
      await client.query(sql);
      const logs = (await client.query('SELECT * FROM chat_logs')).rows;
      const messages = (await client.query('SELECT * FROM conversation_messages ORDER BY seq')).rows;
      for (const [index,row] of logs.entries()) for (const column of Object.keys(beforeLogs[index])) assert.deepEqual(row[column], beforeLogs[index][column]);
      for (const [index,row] of messages.entries()) for (const column of Object.keys(beforeMessages[index])) assert.deepEqual(row[column], beforeMessages[index][column]);
      assert.equal(logs[0].file_name_ciphertext, null);
      assert.equal(messages[1].tool_calls_ciphertext, null);
      assert.equal(messages[1].has_tool_calls, null, 'no presence backfill');
    }
    const { dbPool } = await import('./client.ts'); pool = dbPool;
    pool.options.options = `-c search_path=${schema},public`;
    const { sessionKeyVault } = await import('../crypto/sessionKeyStore.ts'); keys = sessionKeyVault;
    const { getSessionHistory, insertLog } = await import('./chatLogs.ts');
    const { getConversationMessages, appendConversationMessage, createConversation } = await import('./conversations.ts');
    const { decryptStoredContent, encryptStoredContent, StoredContentShapeError } = await import('./encryptedContent.ts');
    assert.equal((await getSessionHistory(session))[0].file_name, 'synthetic-private.json');
    let legacyReplay;
    await context.test('legacy NULL presence with plaintext tool calls still replays through getConversationMessages', async () => {
      legacyReplay = await getConversationMessages(conversation, 2);
      assert.deepEqual(legacyReplay.map(({seq}) => ({seq})), beforeReplay);
      assert.deepEqual(legacyReplay[0].tool_calls, calls);
    });

    const newSession = `metadata-new-${randomUUID()}`;
    const fresh = await createConversation(newSession);
    for (const row of beforeMessages) await appendConversationMessage({ conversation_id: fresh.id, seq: row.seq,
      role: row.role, content: row.content, tool_calls: row.tool_calls, tool_call_id: row.tool_call_id });
    const newReplay = await getConversationMessages(fresh.id, 2);
    const comparable = rows => rows.map(({seq,role,content,tool_calls,tool_call_id,pinned}) => ({seq,role,content,tool_calls,tool_call_id,pinned}));
    assert.deepEqual(comparable(newReplay), comparable(legacyReplay), 'encrypted replay identical to legacy replay');
    const emptyCalls = await appendConversationMessage({ conversation_id:fresh.id,seq:5,role:'assistant',
      content:'empty calls',tool_calls:[],tool_call_id:null });
    assert.deepEqual(emptyCalls.tool_calls, [], 'empty array must not silently become NULL');
    assert.equal((await client.query('SELECT has_tool_calls FROM conversation_messages WHERE conversation_id=$1 AND seq=5',[fresh.id])).rows[0].has_tool_calls,false);
    for (const [flag, payload] of [[true, []], [false, calls]]) {
      await context.test(`getConversationMessages rejects presence ${flag} with encrypted ${payload.length === 0 ? 'empty' : 'non-empty'} tool calls`, async () => {
        const contradictory = await createConversation(newSession);
        const content = await encryptStoredContent(newSession, 'synthetic contradictory assistant');
        const encryptedCalls = await encryptStoredContent(newSession, JSON.stringify(payload));
        // Prove the CHECK accepts the contradiction; it cannot inspect the encrypted payload.
        const accepted = await client.query(`INSERT INTO conversation_messages (
          conversation_id, seq, role, content, content_ciphertext, content_nonce, content_auth_tag,
          tool_calls, tool_calls_ciphertext, tool_calls_nonce, tool_calls_auth_tag, has_tool_calls
        ) VALUES ($1, 1, 'assistant', NULL, $2, $3, $4, NULL, $5, $6, $7, $8)
        RETURNING has_tool_calls, tool_calls`, [contradictory.id,
          content.ciphertext, content.nonce, content.authTag,
          encryptedCalls.ciphertext, encryptedCalls.nonce, encryptedCalls.authTag, flag]);
        assert.equal(accepted.rowCount, 1, 'database must accept the contradictory presence flag');
        assert.deepEqual(accepted.rows, [{ has_tool_calls: flag, tool_calls: null }]);
        assert.deepEqual(JSON.parse(await decryptStoredContent(newSession, {
          plaintext: null, ciphertext: encryptedCalls.ciphertext,
          nonce: encryptedCalls.nonce, authTag: encryptedCalls.authTag,
        }, true)), payload, 'encrypted payload must actually contradict the stored flag');
        await assert.rejects(getConversationMessages(contradictory.id, 1), StoredContentShapeError);
      });
    }
    const now = new Date().toISOString();
    const inserted = await insertLog({ id: randomUUID(),session_id:newSession,conversation_id:fresh.id,message_index:1,
      message_type:'file_upload',user_message:null,ai_response:null,file_name:'synthetic-private.json',file_size:123,
      vulnerability_count:2,user_email:null,created_at:now,updated_at:now });
    assert.equal(inserted.file_name, 'synthetic-private.json');
    const storedLog = (await client.query('SELECT * FROM chat_logs WHERE id=$1', [inserted.id])).rows[0];
    const storedMessage = (await client.query('SELECT * FROM conversation_messages WHERE conversation_id=$1 AND seq=2', [fresh.id])).rows[0];
    assert.equal(storedLog.file_name, null);
    assert.equal(storedMessage.tool_calls, null);
    assert.equal(storedMessage.has_tool_calls, true);
    for (const [row,field,value] of [[storedLog,'file_name','synthetic-private.json'],[storedMessage,'tool_calls',JSON.stringify(calls)]]) {
      const envelope = { plaintext:null,ciphertext:row[`${field}_ciphertext`],nonce:row[`${field}_nonce`],authTag:row[`${field}_auth_tag`] };
      assert.equal(await decryptStoredContent(newSession,envelope,true),value);
      for (const component of ['ciphertext','nonce','authTag']) {
        await assert.rejects(decryptStoredContent(newSession,{...envelope,[component]:null},true),StoredContentShapeError);
        await assert.rejects(decryptStoredContent(newSession,{plaintext:value,ciphertext:null,nonce:null,authTag:null,[component]:envelope[component]},true),StoredContentShapeError);
      }
    }
    // SQL enforces the same shapes, independently of the adapter.
    const shapeFailure = error => error.code === '23514';
    await assert.rejects(client.query('UPDATE chat_logs SET file_name=$1 WHERE id=$2',['plaintext',inserted.id]),shapeFailure);
    await assert.rejects(client.query('UPDATE chat_logs SET file_name_nonce=NULL WHERE id=$1',[inserted.id]),shapeFailure);
    await assert.rejects(client.query('UPDATE conversation_messages SET tool_calls=$1 WHERE conversation_id=$2 AND seq=2',[JSON.stringify(calls),fresh.id]),shapeFailure);
    await assert.rejects(client.query('UPDATE conversation_messages SET tool_calls_auth_tag=NULL WHERE conversation_id=$1 AND seq=2',[fresh.id]),shapeFailure);
    // Each newly added filename envelope column alone still stamps the authoritative clock.
    for (const column of ['file_name_ciphertext','file_name_nonce','file_name_auth_tag']) {
      const before = (await client.query('SELECT last_activity_at FROM session_retention_rules WHERE session_id=$1',[newSession])).rows[0].last_activity_at;
      await client.query('SELECT pg_sleep(0.01)');
      await client.query(`UPDATE chat_logs SET ${column}=${column} WHERE id=$1`,[inserted.id]);
      const after = (await client.query('SELECT last_activity_at FROM session_retention_rules WHERE session_id=$1',[newSession])).rows[0].last_activity_at;
      assert.ok(after > before, `${column} must advance activity`);
    }
    const clockBeforeFilenameChange = (await client.query('SELECT last_activity_at FROM session_retention_rules WHERE session_id=$1',[newSession])).rows[0].last_activity_at;
    const renamed = await encryptStoredContent(newSession,'synthetic-renamed.json');
    await client.query('SELECT pg_sleep(0.01)');
    await client.query(`UPDATE chat_logs SET file_name_ciphertext=$1,file_name_nonce=$2,file_name_auth_tag=$3 WHERE id=$4`,
      [renamed.ciphertext,renamed.nonce,renamed.authTag,inserted.id]);
    assert.equal((await getSessionHistory(newSession))[0].file_name,'synthetic-renamed.json');
    assert.ok((await client.query('SELECT last_activity_at FROM session_retention_rules WHERE session_id=$1',[newSession])).rows[0].last_activity_at > clockBeforeFilenameChange,
      'a filename-only change must advance activity');
    assert.equal(await keys.destroy(newSession),true, 'the key file was unlinked');
    for (const [row,field] of [[storedLog,'file_name'],[storedMessage,'tool_calls']]) {
      await assert.rejects(decryptStoredContent(newSession,{plaintext:null,ciphertext:row[`${field}_ciphertext`],nonce:row[`${field}_nonce`],authTag:row[`${field}_auth_tag`]},true), {name:'SessionKeyError'});
    }
    await assert.rejects(getSessionHistory(newSession), {name:'SessionKeyError'});
    await assert.rejects(getConversationMessages(fresh.id,2), {name:'SessionKeyError'});
  } finally {
    if (pool) await pool.end();
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (connected) await client.end(); else await client.end().catch(() => {});
    if (previousDirectory === undefined) delete process.env.SESSION_KEY_DIRECTORY; else process.env.SESSION_KEY_DIRECTORY = previousDirectory;
    await rm(keyDirectory,{recursive:true,force:true});
  }
});
