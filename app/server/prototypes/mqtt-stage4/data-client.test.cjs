'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {DataClient,SCHEMA,SERVER,REQUEST,REPLY}=require('./data-client.cjs');
const {createRequestPort}=require('./database-port.cjs');
const BOOT='b'.repeat(32),SID='dat-'+'a'.repeat(32),OID='op-'+'c'.repeat(32);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(){
 const sent=[],timers=new Map();let n=0,h=0,network,options;
 const c=new DataClient({url:'wss://127.0.0.1:19999/mqtt-data',wall:()=>1900000000000,
  uuid:()=>('request-'+String(++n).padStart(24,'0')),
  timers:{setTimeout(fn,ms){const id=++h;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}},
  connect(url,opts){options=opts;network=new EventEmitter();network.connected=true;network.end=()=>{network.connected=false;network.emit('close');};
   network.subscribe=(topic,opts,cb)=>cb(null,[{topic,qos:1}]);network.publish=(topic,payload,opts,cb)=>sent.push({topic,request:JSON.parse(payload),opts,cb});return network;}});
 const starting=c.start();network.emit('connect',{sessionPresent:false,properties:{assignedClientIdentifier:SID}});
 const emit=(body,extra={})=>network.emit('message',REPLY,Buffer.from(JSON.stringify({schema:SCHEMA,server_id:SERVER,boot_id:BOOT,client_session_id:SID,...body,...extra})),{retain:false});
 emit({kind:'hello',active_entry:'mqtt',server_time_ms:1900000000000});await starting;
 const reply=(entry,result,extra={})=>emit({kind:'reply',request_id:entry.request.request_id,method:entry.request.method,ok:true,result,...extra});
 return {c,sent,timers,network,options,emit,reply};
}
const body=()=>({operation_id:OID,epoch:'epoch-fixture',kind:'settings',id:'alert_sound',expected_revision:0,value:{enabled:true}});
const saved=()=>({status:200,operation_id:OID,body:{success:true,operation_id:OID}});
test('Broker PUBACK alone cannot mark database saved',async()=>{
 const f=await fixture(),p=f.c.write('database.write',body());let done=false;p.then(()=>done=true);
 f.sent[0].cb(null);await flush();assert.equal(done,false);f.reply(f.sent[0],saved());assert.equal((await p).body.success,true);f.c.stop();
});
test('duplicates share one promise and immutable intent',async()=>{
 const f=await fixture(),p=f.c.write('database.write',body());assert.equal(p,f.c.write('database.write',body()));
 await assert.rejects(f.c.write('database.write',{...body(),value:{enabled:false}}),/CONFLICT/);
 assert.equal(f.sent.length,1);f.reply(f.sent[0],saved());await p;f.c.stop();
});
test('disconnect retains query-only outcome and no offline queue',async()=>{
 const f=await fixture(),p=f.c.write('database.write',body());f.network.emit('close');await assert.rejects(p,/TRANSPORT_LOST/);
 await assert.rejects(f.c.write('database.write',body()),/TRANSPORT_LOST/);assert.equal(f.sent.length,1);
 assert.equal(f.options.reconnectPeriod,0);assert.equal(f.options.queueQoSZero,false);assert.equal(f.options.resubscribe,false);
});
test('timeout and late reply do not replay or report saved',async()=>{
 const f=await fixture(),p=f.c.write('database.write',body());[...f.timers.values()].find(t=>t.ms===8000).fn();
 await assert.rejects(p,/TIMEOUT_QUERY_ONLY/);f.reply(f.sent[0],saved());assert.equal(f.sent.length,1);f.c.stop();
});
test('wrong operation receipt is rejected',async()=>{
 const f=await fixture(),p=f.c.write('database.write',body());f.reply(f.sent[0],{...saved(),operation_id:'other'});
 await assert.rejects(p,/WRONG_OPERATION_REPLY/);f.c.stop();
});
for(const [name,change] of [['method',{method:'projects.save'}],['boot',{boot_id:'d'.repeat(32)}],['session',{client_session_id:'dat-'+'d'.repeat(32)}]]){
 test('wrong '+name+' cannot complete pending write',async()=>{
  const f=await fixture(),p=f.c.write('database.write',body());
  if(name==='method')f.reply(f.sent[0],saved(),change);else f.emit({kind:'reply',request_id:f.sent[0].request.request_id,method:'database.write',ok:true,result:saved()},change);
  await assert.rejects(p);assert.equal(f.sent.length,1);f.c.stop();
 });
}
test('read-only recovery validates operation id',async()=>{
 const f=await fixture(),p=f.c.query(OID);assert.equal(f.sent[0].request.method,'operations.get');
 f.reply(f.sent[0],{status:200,body:{operation:{operation_id:'other',state:'committed'}}});await assert.rejects(p,/WRONG_OPERATION_REPLY/);f.c.stop();
});
test('oversize rejected before publication',async()=>{
 const f=await fixture();await assert.rejects(f.c.call('database.import.preview',{backup:'x'.repeat(800*1024)}),/MESSAGE_TOO_LARGE/);
 assert.equal(f.sent.length,0);f.c.stop();
});
test('repository port preserves HTTP-shaped conflicts without HTTP transport',async()=>{
 const calls=[],client={write:async(method,value)=>{calls.push({method,value});return {status:409,body:{success:false,code:'RESOURCE_REVISION_CONFLICT',epoch:'e',protocol:'daty-business-db-v1'}};}};
 const request=createRequestPort({client,baseUrl:'https://127.0.0.1:8802'});
 const response=await request('https://127.0.0.1:8802/api/database/write',{method:'POST',body:JSON.stringify(body())});
 assert.equal(response.status,409);assert.equal(response.ok,false);assert.equal((await response.json()).code,'RESOURCE_REVISION_CONFLICT');assert.equal(calls.length,1);
});
test('repository port abort discards late result without retrying or cancelling commit',async()=>{
 let finish,writes=0;const request=createRequestPort({baseUrl:'https://127.0.0.1:8802',client:{write:()=>{writes++;return new Promise(r=>finish=r);}}});
 const abort=new AbortController(),p=request('https://127.0.0.1:8802/api/database/write',{method:'POST',body:JSON.stringify(body()),signal:abort.signal});
 abort.abort();await assert.rejects(p,/ABORTED_QUERY_ONLY/);finish(saved());await flush();assert.equal(writes,1);
});
test('port refuses commands, file operations, foreign server and duplicate query',()=>{
 const request=createRequestPort({baseUrl:'https://127.0.0.1:8802',client:{}});
 for(const suffix of ['/api/command','/api/database/exports','/api/database/resources?kind=alerts&kind=settings'])assert.throws(()=>request('https://127.0.0.1:8802'+suffix,{method:suffix.includes('?')?'GET':'POST',body:'{}'}));
 assert.throws(()=>request('https://127.0.0.2:8802/api/database/status'),/SERVER_CHANGED/);
 assert.throws(()=>request('https://127.0.0.1:8802/api/projects',{method:'POST',body:'{}'}),/OPERATION_AND_EPOCH_REQUIRED/);
});
