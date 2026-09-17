import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import 'dotenv/config';
import pg from 'pg';

function unreachable(error) {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(unreachable);
  return ['ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','ENOTFOUND','EPERM','ETIMEDOUT'].includes(error?.code);
}

test('scan provenance stores submitted rather than cap-admitted count; fresh and pre-change rows extract correctly', async context => {
  try { execFileSync('git', ['cat-file', '-e', 'cfc87eb^{commit}'], {stdio:'ignore'}); }
  catch { context.skip('Pre-change commit cfc87eb is not readable from git'); return; }
  if (!process.env.DATABASE_URL) { context.skip('DATABASE_URL not configured'); return; }
  const client = new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:2000});
  const schema = `scan_source_${randomUUID().replaceAll('-','')}`;
  let connected = false, created = false, pool, directory;
  const oldDirectory = process.env.SESSION_KEY_DIRECTORY;
  try {
    try { await client.connect(); connected = true; }
    catch(error) { if(unreachable(error)){context.skip('Postgres unreachable');return;} throw error; }
    const localSnapshot = (await client.query(`SELECT snapshot_date::text, max_modified FROM osv_snapshots ORDER BY ingested_at DESC LIMIT 1`)).rows[0];
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}",public`);
    // A real stored row is written under the committed pre-change schema first.
    await client.query(execFileSync('git',['show','cfc87eb:db/schema.sql'],{encoding:'utf8'}));
    const legacyId = randomUUID();
    await client.query(`INSERT INTO conversations(id,session_id) VALUES($1,'synthetic-legacy-source')`,[legacyId]);
    const legacyContent = '**Minimized Software Context:**\n'+JSON.stringify({scanned_package_count:37,scan_truncated:false,packages_depends_on:[]})+'\n\nPlease summarize.';
    await client.query(`INSERT INTO conversation_messages(conversation_id,seq,role,content,pinned)
      VALUES($1,1,'user',$2,true)`,[legacyId,legacyContent]);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='conversation_messages' AND column_name='scan_source'`,[schema])).rows[0].count,0);
    await client.query(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'));
    directory = await mkdtemp(path.join(os.tmpdir(),'bombot-scan-source-test-'));
    process.env.SESSION_KEY_DIRECTORY = path.join(directory,'keys');
    const {dbPool} = await import('./client.ts'); pool = dbPool;
    pool.options.options = `-c search_path=${schema},public`;
    const {config} = await import('../config.ts');
    const {createUploadHandler} = await import('../../pages/api/upload.ts');
    const {extractAndStoreSessionMeasures} = await import('./sessionMeasures.ts');
    const {matchOsvPackages} = await import('../osv/match.ts');
    const date = localSnapshot?.snapshot_date ?? config.OSV_SNAPSHOT_DATE ?? '2026-09-07';
    await client.query(`INSERT INTO osv_snapshots(snapshot_date,source_url,ecosystem_record_counts,max_modified)
      VALUES($1,'synthetic source fixture','{}',$2)`,[date,localSnapshot?.max_modified??null]);
    const originalFetch=globalThis.fetch;
    globalThis.fetch=()=>{throw Error('No outbound extraction requests');};
    try {
      const fixture = process.env.STIMULUS_CHECK_PATH ?? new URL('../../tests/fixtures/mixed-ecosystems-spdx.json',import.meta.url);
      const fixtureBytes = await readFile(fixture);
      let submitted;
      const session = `synthetic-fresh-source-${randomUUID()}`;
      const handler = createUploadHandler({osvMode:'offline',
        async parseForm(req,uploadDirectory){const uploaded=path.join(uploadDirectory,'scan-fixture.spdx.json');await copyFile(fixture,uploaded);
          return {fields:{sessionId:session,messageIndex:'0'},files:{file:{filepath:uploaded,originalFilename:'scan-fixture.spdx.json',size:fixtureBytes.length}}};},
        async matchOsvPackages(scanClient,packages){submitted=packages.length;return process.env.STIMULUS_CHECK_PATH
          ? matchOsvPackages(scanClient,packages) : packages.map(pkg=>({package:pkg,vulnerabilities:[]}));},
        async insertLog(){},
      });
      let response;
      let status;
      await handler({method:'POST'},{status(code){status=code;return this;},json(value){response=value;return this;}});
      assert.equal(status,200);
      const stored = (await client.query(`SELECT m.content,m.content_ciphertext,m.scan_source,c.id
        FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.session_id=$1 AND m.pinned`,[session])).rows[0];
      assert.equal(stored.content,null); assert.ok(Buffer.isBuffer(stored.content_ciphertext));
      assert.ok(response.totalPackages>submitted,'fixture must have cap-admitted entries that are not scanned');
      assert.equal(stored.scan_source.scanned_package_count,submitted,'stored count must be submitted, not cap-admitted');
      assert.notEqual(stored.scan_source.scanned_package_count,response.totalPackages);
      assert.equal(stored.scan_source.scan_truncated,true);
      const {getConversationMessages} = await import('./conversations.ts');
      const replay = await getConversationMessages(stored.id,config.MAX_HISTORY_MESSAGES);
      assert.equal(Object.hasOwn(replay[0],'scan_source'),false,'sidecar never enters replay');
      const marker='**Minimized Software Context:**\n';
      const structured=JSON.parse(replay[0].content.split(marker)[1].split('\n')[0]);
      assert.equal(structured.scanned_package_count,submitted);
      assert.match(replay[0].content,new RegExp(`Total packages scanned: ${submitted}\\n`));
      assert.match(replay[0].content,/unsupported purl type/);
      assert.match(replay[0].content,/ecosystem could not be derived/);
      await extractAndStoreSessionMeasures(session);
      const fresh=(await client.query('SELECT result FROM session_measures WHERE session_id=$1',[session])).rows[0].result;
      assert.equal(fresh.reference_status,'available');
      assert.equal(fresh.scan_provenance[0].osv_mode,'offline');
      assert.equal(fresh.scan_provenance[0].snapshot_date,date);
      assert.equal(fresh.scan_provenance[0].scanned_package_count,submitted);
      await extractAndStoreSessionMeasures('synthetic-legacy-source');
      const legacy=(await client.query(`SELECT result FROM session_measures WHERE session_id='synthetic-legacy-source'`)).rows[0].result;
      assert.equal(legacy.reference_status,'available');
      assert.equal(legacy.scan_provenance[0].osv_mode,'unknown');
      assert.equal(legacy.scan_provenance[0].snapshot_date,'unknown');
      assert.equal(legacy.scan_provenance[0].scanned_package_count,37);
      const unchanged=(await client.query('SELECT content,scan_source FROM conversation_messages WHERE conversation_id=$1',[legacyId])).rows[0];
      assert.equal(unchanged.content,legacyContent); assert.equal(unchanged.scan_source,null);
      function values(value){return value&&typeof value==='object'?Object.values(value).flatMap(values):[value];}
      for(const row of [stored.scan_source,fresh,legacy]){
        for(const value of values(row))if(typeof value==='string'){
          assert.doesNotMatch(value,/(?:CVE-|GHSA-|PYSEC-|OSV-)/iu);
          assert.equal(value.includes('scan-fixture'),false);
          assert.equal(value.includes('packages_depends_on'),false);
        }
      }
      console.log('SCAN_SOURCE_EVIDENCE '+JSON.stringify({cap_admitted:response.totalPackages,matcher_admitted:submitted,
        scanned:response.packagesScanned,stored:stored.scan_source.scanned_package_count,model:structured.scanned_package_count,
        provenance:stored.scan_source,reference_status:fresh.reference_status,legacy_source:legacy.scan_provenance[0],
        emitted_skip_text:replay[0].content.split('\n').filter(line=>line.includes('coverage warning'))}));
    }finally{globalThis.fetch=originalFetch;}
  } finally {
    if(pool)await pool.end();
    if(created)await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    if(connected)await client.end();
    if(directory)await rm(directory,{recursive:true,force:true});
    if(oldDirectory===undefined)delete process.env.SESSION_KEY_DIRECTORY;else process.env.SESSION_KEY_DIRECTORY=oldDirectory;
  }
});
