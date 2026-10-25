'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const scalarFactory=require('../src/platform/database-client.js'),batchFactory=require('../src/platform/database-batch-client.js');
const {fixture}=require('./business-db-fixture.cjs');
function setup(){const h=fixture();h.client=scalarFactory.create(h.ports);h.batch=batchFactory.create({...h.ports,resourceClient:h.client});return h;}
const inputs=()=>[{kind:'settings',id:'alert_sound',value:{enabled:true}},{kind:'settings',id:'auto_frequency',value:{enabled:false}}];
const prepare=async h=>{for(const item of inputs())assert.equal((await h.client.load(item.kind,item.id)).status,'ready');};
test('atomic batch requires every real baseline, then journals before its only batch POST',async()=>{
  const h=setup();assert.equal((await h.batch.save(inputs())).status,'unloaded');await prepare(h);
  const saved=await h.batch.save(inputs());assert.equal(saved.status,'saved');assert.equal(saved.resources.length,2);assert(h.requests.some(item=>item.url.endsWith('/api/database/batch')));
  assert.equal(h.requests.filter(item=>item.options.method==='POST').length,1);assert.equal(h.memory.size,0);
  assert(h.requests.every(item=>!item.url.includes('batch_journal')));
});
test('batch conflict writes none and duplicate target is refused before POST',async()=>{
  const h=setup();await prepare(h);h.put('settings','auto_frequency',{enabled:true},1);
  assert.equal((await h.batch.save(inputs())).status,'conflict');assert.equal(h.resources.has('["settings","alert_sound"]'),false);assert.equal(h.receipts.size,0);
  assert.equal((await h.batch.save([inputs()[0],inputs()[0]])).code,'DUPLICATE_BATCH_TARGET');
});
test('lost atomic reply survives new controller and verifies complete ordered receipt without replay',async()=>{
  const h=setup();await prepare(h);h.state.dropReply=true;const unknown=await h.batch.save(inputs());assert.equal(unknown.status,'unknown');assert.equal(h.memory.size,1);
  const next=batchFactory.create({...h.ports,resourceClient:h.client});assert.equal(next.snapshot().status,'unknown');assert.equal((await next.save(inputs())).status,'unknown');
  const confirmed=await next.reconcile();assert.equal(confirmed.status,'reconciled');assert.equal(confirmed.resources.length,2);assert.equal(h.memory.size,0);assert.equal(h.requests.filter(item=>item.options.method==='POST').length,1);
});
test('batch receipt with missing, reordered or altered resource remains unknown',async()=>{
  for(const mutate of [items=>items.pop(),items=>items.reverse(),items=>items[0].value.enabled=false]){
    const h=setup();await prepare(h);h.state.dropReply=true;const result=await h.batch.save(inputs());mutate(h.receipts.get(result.operationId).resources);
    assert.equal((await h.batch.reconcile()).status,'unknown');assert.equal(h.memory.size,1);
  }
});
test('batch never journals credentials or silently accepts asynchronous storage',async()=>{
  const h=setup();await prepare(h);const value=inputs();value[0].value={token:'fixture-not-business'};
  assert.equal((await h.batch.save(value)).status,'error');assert.equal(h.requests.filter(item=>item.options.method==='POST').length,0);assert.equal(h.memory.size,0);
});
test('stable business journal IDs isolate pending batches across controllers and reconstruction',async()=>{
  const h=setup();await prepare(h);const profiles=batchFactory.create({...h.ports,resourceClient:h.client,journalId:'profiles'});
  h.state.dropReply=true;assert.equal((await profiles.save(inputs())).status,'unknown');
  const planning=batchFactory.create({...h.ports,resourceClient:h.client,journalId:'planning'});
  assert.equal(planning.snapshot().status,'unloaded');assert.equal(profiles.snapshot().status,'unknown');
  const reconstructed=batchFactory.create({...h.ports,resourceClient:h.client,journalId:'profiles'});
  assert.equal(reconstructed.snapshot().status,'unknown');assert.equal((await reconstructed.reconcile()).status,'reconciled');
  assert.equal(h.requests.filter(item=>item.options.method==='POST').length,1);assert.equal(h.memory.size,0);
});
test('batch refuses a resource baseline from another server before write',async()=>{
  const h=setup();await prepare(h);const unrelated=batchFactory.create({...h.ports,readScope:()=>({...h.scope,baseUrl:'https://192.0.2.16:8802'}),resourceClient:h.client});
  assert.equal((await unrelated.save(inputs())).code,'BATCH_LOAD_REQUIRED');assert.equal(h.requests.filter(item=>item.options.method==='POST').length,0);
});
