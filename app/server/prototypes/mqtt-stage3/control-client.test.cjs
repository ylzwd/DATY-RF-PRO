'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {ControlClient,SCHEMA,SERVER,REQUEST,REPLY}=require('./control-client.cjs');
const BOOT='b'.repeat(32),SID='ctl-'+'a'.repeat(32),CID='c'.repeat(32);
const target={device_id:'FAshe-MAC-020000000098_ch1',receiver_id:'FAshe-MAC-020000000098',
  receiver_mac:'02:00:00:00:00:98',receiver_ip:'127.0.0.2',receiver_session_id:'paired-session-00001',
  channel_number:1,expected_brand:'DATYaudio'};
const intent=()=>({operation_id:'operation-0000000001',target:{...target},command:'mute',expected_value:true});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function record(state='published',revision=3,changes={}) {
  return {operation_id:'operation-0000000001',command_id:CID,entry:'mqtt',state,revision,
    target:{...target},command:'mute',expected_value:true,actual_value:state==='acknowledged'?true:null,
    server_id:SERVER,boot_id:BOOT,execution_evidence:state==='acknowledged'?{source:'paired-receiver-status',
      command_id:CID,receiver_session_id:target.receiver_session_id,receiver_id:target.receiver_id,
      device_id:target.device_id,channel_number:1,brand:'DATYaudio'}:null,...changes};
}
async function fixture({confirm=async()=>true}={}) {
  const sent=[],records=[],timers=new Map();let seq=0,handle=0,client,options;
  const c=new ControlClient({url:'wss://127.0.0.1:19999/mqtt-control',confirm,wall:()=>1900000000000,
    uuid:()=>('request-'+String(++seq).padStart(24,'0')),onRecord:r=>records.push(r),
    timers:{setTimeout(fn,ms){const id=++handle;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}},
    connect(url,opts){options=opts;client=new EventEmitter();client.connected=true;client.end=()=>{client.connected=false;client.emit('close');};
      client.subscribe=(topic,opts,cb)=>cb(null,[{topic,qos:1}]);client.publish=(topic,payload,opts,cb)=>{sent.push({topic,request:JSON.parse(payload),opts,cb});};return client;}});
  const started=c.start();
  client.emit('connect',{sessionPresent:false,properties:{assignedClientIdentifier:SID}});
  const emit=(body,extra={})=>client.emit('message',REPLY,Buffer.from(JSON.stringify({schema:SCHEMA,server_id:SERVER,
    boot_id:BOOT,client_session_id:SID,...body,...extra})),{retain:false});
  emit({kind:'hello',active_entry:'mqtt',server_time_ms:1900000000000});await started;
  function reply(entry,result,changes={}){emit({kind:'reply',request_id:entry.request.request_id,
    method:entry.request.method,ok:true,result,...changes});}
  async function submit(value=intent()) {
    const promise=c.execute(value);await flush();
    const query=sent.findLast(s=>s.request.method==='commands.targets');assert.ok(query);
    reply(query,{active_entry:'mqtt',targets:[{target}]});await flush();
    const command=sent.findLast(s=>s.request.method==='commands.request');assert.ok(command);return {promise,command};
  }
  return {c,sent,records,timers,get client(){return client;},options,emit,reply,submit};
}

test('MQTT receipt and published phase cannot claim execution; real matching ACK can',async()=>{
  const f=await fixture(),{promise,command}=await f.submit();let done=false;promise.then(()=>done=true);
  command.cb(null);await flush();assert.equal(done,false);
  f.reply(command,record());await flush();assert.equal(done,false);
  f.emit({kind:'command_update',result:record('acknowledged',4)});
  assert.equal((await promise).state,'acknowledged');assert.equal(f.sent.filter(s=>s.request.method==='commands.request').length,1);
  assert.equal(f.options.reconnectPeriod,0);assert.equal(f.options.queueQoSZero,false);f.c.stop();
});
test('manual cancellation and target changed during review produce no control publish',async()=>{
  const f=await fixture({confirm:async()=>false});assert.equal((await f.c.execute(intent())).state,'cancelled');assert.equal(f.sent.length,0);f.c.stop();
  const g=await fixture(),p=g.c.execute(intent());await flush();
  g.reply(g.sent[0],{active_entry:'mqtt',targets:[{target:{...target,receiver_session_id:'replacement'}}]});
  assert.equal((await p).state,'not_sent');assert.equal(g.sent.length,1);g.c.stop();
});
test('duplicate clicks share confirmation and one operation; changed intent rejected',async()=>{
  let confirmations=0;const f=await fixture({confirm:async()=>{confirmations++;return true;}});
  const first=f.c.execute(intent()),second=f.c.execute(intent());assert.equal(first,second);await flush();
  f.reply(f.sent[0],{active_entry:'mqtt',targets:[{target}]});await flush();
  f.reply(f.sent[1],record('acknowledged',4));await first;
  assert.equal(confirmations,1);assert.equal(f.sent.filter(s=>s.request.method==='commands.request').length,1);
  await assert.rejects(f.c.execute({...intent(),command:'unmute',expected_value:false}),/CONFLICT/);f.c.stop();
});
for(const [name,change] of [
  ['receiver',r=>({...r,target:{...r.target,receiver_id:'another-receiver'}})],
  ['channel',r=>({...r,target:{...r.target,channel_number:2}})],
  ['brand',r=>({...r,target:{...r.target,expected_brand:'Shure'}})],
  ['session',r=>({...r,target:{...r.target,receiver_session_id:'reconnected'}})],
  ['boot',r=>({...r,boot_id:'d'.repeat(32)})],
  ['actual value',r=>({...r,actual_value:false})],
  ['missing evidence',r=>({...r,execution_evidence:null})],
  ['command evidence',r=>({...r,execution_evidence:{...r.execution_evidence,command_id:'d'.repeat(32)}})]]) {
  test('wrong '+name+' in receipt never becomes execution success',async()=>{
    const f=await fixture(),{promise}=await f.submit();
    f.emit({kind:'command_update',result:change(record('acknowledged',4))});
    assert.equal((await promise).state,'unknown');assert.equal(f.records.some(r=>r.state==='acknowledged'),false);f.c.stop();
  });
}
test('late initial reply cannot downgrade a faster receiver ACK',async()=>{
  const f=await fixture(),{promise,command}=await f.submit();f.emit({kind:'command_update',result:record('acknowledged',4)});
  assert.equal((await promise).state,'acknowledged');f.reply(command,record('published',3));await flush();
  assert.equal(f.records.length,1);assert.equal(f.records[0].state,'acknowledged');f.c.stop();
});
test('disconnect leaves query-only outcome; restarting never publishes queued control',async()=>{
  const f=await fixture(),{promise}=await f.submit();f.client.emit('close');
  const result=await promise;assert.equal(result.state,'unknown');assert.equal(result.query_only,true);
  assert.equal(f.sent.filter(s=>s.request.method==='commands.request').length,1);
  assert.equal(await f.c.execute(intent()),result);f.c.stop();
});
test('timeout, stop and PUBACK error do not invoke a second control entry',async()=>{
  for(const mode of ['timeout','stop','publish-error']) {
    const f=await fixture(),{promise,command}=await f.submit();
    if(mode==='timeout')for(const {fn,ms} of [...f.timers.values()])if(ms===8000)fn();
    if(mode==='stop')f.c.stop();if(mode==='publish-error')command.cb(Error('disconnect'));
    assert.equal((await promise).state,'unknown');assert.equal(f.sent.filter(s=>s.request.method==='commands.request').length,1);f.c.stop();
  }
});
test('query is read-only and verifies operation correlation',async()=>{
  const f=await fixture(),query=f.c.query('operation-0000000001');
  f.reply(f.sent[0],record('unknown',5));assert.equal((await query).state,'unknown');
  assert.equal(f.sent[0].request.method,'commands.get');assert.equal(f.sent.length,1);f.c.stop();
});
test('TLS endpoint and confirmation callback are mandatory',()=>{
  for(const url of ['ws://localhost/mqtt-control','wss://x:y@localhost/mqtt-control','wss://localhost/mqtt-control?key=x'])
    assert.throws(()=>new ControlClient({url,confirm:()=>true}));
  assert.throws(()=>new ControlClient({url:'wss://localhost/mqtt-control'}));
});
