import assert from 'node:assert/strict';
import test from 'node:test';
import { extractInThread } from './measureExtraction.ts';
import { extractSessionMeasures } from '../measures/extract.ts';

const resolution={ source:{osv_mode:'offline',snapshot_date:'unknown',status:'available'},
  primaryByIdentifier:new Map([['CVE-2099-12345','OSV-2099-12345']]) };

test('isolated scoring preserves alias maps and the complete non-empty measure',async()=>{
  const messages=[{role:'user',pinned:true,content:'**Minimized Software Context:**\n'+JSON.stringify({
    packages_depends_on:[{vulnerabilities:[{id:'OSV-2099-12345'}]}]})},
    {role:'assistant',pinned:false,content:'CVE-2099-12345 CVE-2099-12345'}];
  let stored;
  const deps={readMessages:async()=>messages,resolveLocally:async()=>resolution,
    store:async(_id,measure)=>{stored=measure;}};
  const expected=await extractSessionMeasures('synthetic',deps);
  const actual=await extractInThread('synthetic',deps,new AbortController().signal);
  assert.deepEqual(actual,expected);
  assert.deepEqual(stored,actual);
  assert.equal(actual.emitted_count,2);
  assert.equal(actual.alias_grounded_count,2);
});

test('a stalled scoring dependency cannot hold another session; cancellation prevents late storage',async()=>{
  const controller=new AbortController();
  let readStarted,releaseRead,stored=0;
  const started=new Promise(resolve=>{readStarted=resolve;});
  const stalled=extractInThread('stalled',{readMessages:()=>{readStarted();return new Promise(resolve=>{releaseRead=resolve;});},
    resolveLocally:async()=>resolution,store:async()=>{stored++;}},controller.signal);
  // Attach rejection handling before aborting, including on failed sibling assertions.
  const cancelled=assert.rejects(stalled,/Measurement cancelled/);
  try {
    await started;
    const healthy=await extractInThread('healthy',{readMessages:async()=>[],resolveLocally:async()=>resolution,
      store:async()=>{}},new AbortController().signal);
    assert.equal(healthy.emitted_count,0,'healthy extraction completes while the sibling remains stalled');
  } finally {
    controller.abort();releaseRead?.([]);
  }
  await cancelled;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stored,0,'a cancelled dependency reply cannot advance to storage');
});
