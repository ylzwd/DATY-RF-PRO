'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {search,paginate}=require('../src/modules/data-management.js');
const {create}=require('../src/platform/alert-database.js');
test('filter before paging; preserve stable IDs, source order and inputs',()=>{
  const rows=Array.from({length:53},(_,i)=>({id:'stable-'+i,name:'接收机 '+i,level:i%2?'warn':'crit'}));
  const selected=search(rows,'接收机',['name'],r=>r.level==='warn');
  const page=paginate(selected,2);assert.equal(page.total,26);assert.equal(page.items[0].id,'stable-41');
  assert.equal(rows.length,53);assert.equal(paginate([],999).page,1);
  assert.equal(search(rows,'接收机 52',['name'])[0].id,'stable-52');
});
const alert=(id,lastSeen=10)=>({archiveId:id,firstSeen:1,lastSeen,archiveState:'active',deviceId:'GROUP1 CH1',metric:'rf'});
test('incremental alert refresh merges touches, endings, re-triggers and tombstones',async()=>{
  const calls=[],queue=[
    {epoch:'e',asOf:10,resources:[{id:'a',revision:1,value:alert('a')},{id:'b',revision:1,value:alert('b')}]},
    {epoch:'e',asOf:20,resources:[{id:'a',revision:2,value:{...alert('a',12),archiveState:'ended',endedAt:12}},{id:'c',revision:1,value:alert('c')}]},
    {epoch:'e',asOf:25,resources:[{id:'b',revision:2,deleted:true}]},
    {epoch:'e',asOf:30,resources:[]}
  ];
  const store=create({client:{list:async(k,o)=>{calls.push(o);return {status:'ready',cursor:null,...queue.shift()};}},batchClient:{}});
  await store.list();let r=await store.list();assert.equal(r.records.length,3);assert.equal(r.records.find(x=>x.archiveId==='a').archiveState,'ended');
  r=await store.list();assert.deepEqual(r.records.map(x=>x.archiveId),['a','c']);await store.list();
  assert.deepEqual(calls.map(x=>x.since),[undefined,10,20,25]);assert.equal(calls[1].sinceEpoch,'e');
  assert.equal(store.captureClear().targets.find(x=>x.id==='a').revision,2);
});
test('failed and late pages never advance incremental watermark; epoch needs full reload',async()=>{
  let call=0,resolve;
  const client={list:async()=>{call++;if(call===1)return {status:'ready',cursor:null,epoch:'e',asOf:10,resources:[{id:'a',revision:1,value:alert('a')}]};
    if(call===2)return new Promise(r=>resolve=r);
    if(call===3)return {status:'ready',cursor:null,epoch:'e',asOf:20,resources:[{id:'b',revision:1,value:alert('b')}]};
    if(call===4)return {status:'error',code:'EPOCH_CHANGED'};
    return {status:'ready',cursor:null,epoch:'e2',asOf:0,resources:[]};}};
  const store=create({client,batchClient:{}});await store.list();const stale=store.list();await store.list();
  resolve({status:'ready',cursor:null,epoch:'e',asOf:15,resources:[{id:'a',revision:2,deleted:true}]});assert.equal((await stale).success,false);
  assert.equal(store.records().length,2);assert.equal((await store.list()).success,false);assert.deepEqual(store.records(),[]);
  assert.equal((await store.list()).epoch,'e2');
});
