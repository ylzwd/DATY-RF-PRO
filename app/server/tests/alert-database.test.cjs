'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../src/platform/alert-database.js');
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const rows=new Map(),baselines=new Map();let posts=0,outcome='saved';
  const client={async load(kind,id){const resource=rows.get(id)||null;baselines.set(id,resource?.revision||0);return {status:'ready',resource:copy(resource)};},
    async list(){return {status:'ready',resources:[...rows.values()].map(copy),cursor:null,epoch:'fixture',asOf:1};},invalidate(){baselines.clear();}};
  const batchClient={async save(writes){
    if(outcome!=='saved')return {status:outcome,code:'fixture-'+outcome};
    posts++;for(const write of writes)if((rows.get(write.id)?.revision||0)!==baselines.get(write.id))return {status:'conflict'};
    const resources=writes.map(write=>({...copy(write),revision:(rows.get(write.id)?.revision||0)+1,deleted:!!write.deleted}));
    resources.forEach(row=>rows.set(row.id,row));return {status:'saved',resources};
  },async reconcile(){return {status:outcome==='unknown'?'unknown':'reconciled'};},invalidate(){}};
  return {store:create({client,batchClient}),rows,client,batchClient,get posts(){return posts;},set outcome(value){outcome=value;}};
}
const alert=(extra={})=>({archiveId:'a1',firstSeen:100,lastSeen:110,archiveState:'active',deviceId:'rx1_ch1',metric:'rf',value:-90,threshold:-80,...extra});
test('only a matching committed batch confirms alert archive',async()=>{
  const f=fixture(),record=alert();const result=await f.store.flush([record]);
  assert.equal(result.success,true);assert.equal(f.posts,1);assert.equal(f.rows.get('a1').value.value,-90);
  assert.deepEqual(result.confirmed[0].snapshot,record);
  const again=await f.store.flush([record]);assert.equal(again.changed,0);assert.equal(f.posts,1);
});
test('ended server lifecycle cannot be reopened by stale browser',async()=>{
  const f=fixture();await f.store.flush([alert({archiveState:'ended',endedAt:120,lastSeen:120})]);
  const result=await f.store.flush([alert()]);assert.equal(result.success,true);assert.equal(result.confirmed[0].superseded,true);
  assert.equal(f.posts,1);assert.equal(f.rows.get('a1').value.archiveState,'ended');
});
test('unknown batch keeps pending intent and never repeats a POST',async()=>{
  const f=fixture();f.outcome='unknown';
  for(let index=0;index<3;index++){const result=await f.store.flush([alert()]);assert.equal(result.success,false);assert.equal(result.status,'unknown');}
  assert.equal(f.posts,0);assert.equal((await f.store.reconcile()).status,'unknown');
});
test('identity and malformed timestamps are rejected without writes',async()=>{
  const f=fixture();await f.store.flush([alert()]);
  for(const record of [alert({deviceId:'rx2_ch1'}),alert({metric:'battery'}),alert({firstSeen:99}),alert({lastSeen:0}),alert({archiveState:'ended'})]){
    assert.equal((await f.store.flush([record])).success,false);
  }assert.equal(f.posts,1);
});
test('delete is a database tombstone and stale same lifecycle cannot revive',async()=>{
  const f=fixture();await f.store.flush([alert()]);assert.equal((await f.store.clear(['a1'])).success,true);
  assert.equal(f.rows.get('a1').deleted,true);const stale=await f.store.flush([alert({lastSeen:200})]);
  assert.equal(stale.success,true);assert.equal(f.posts,2);assert.deepEqual((await f.store.list()).records,[]);
});
test('busy save refuses overlap rather than queueing writes',async()=>{
  const f=fixture();let release;const wait=new Promise(resolve=>release=resolve);const load=f.client.load;
  f.client.load=async(...args)=>{await wait;return load(...args);};
  const first=f.store.flush([alert()]);assert.equal((await f.store.flush([alert()])).status,'busy');
  release();assert.equal((await first).success,true);assert.equal(f.posts,1);
});
test('archive list does not adopt a partial moving snapshot',async()=>{
  const f=fixture();let page=0;f.client.list=async()=>({status:'ready',epoch:'fixture',asOf:++page,
    resources:[{id:'a'+page,deleted:false,value:alert({archiveId:'a'+page})}],cursor:page===1?'next':null});
  const result=await f.store.list();assert.equal(result.success,false);assert.equal(result.code,'SNAPSHOT_CHANGED');assert.deepEqual(f.store.records(),[]);
});
test('load historical alerts does not change a device or produce a new event',async()=>{
  const f=fixture();await f.store.flush([alert()]);const result=await f.store.list();assert.equal(result.records[0].deviceId,'rx1_ch1');assert.equal(f.posts,1);
  result.records[0].value=0;assert.equal(f.store.records()[0].value,-90);
});
