'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {webcrypto}=require('node:crypto');
const {applicationPort}=require('./application-port.cjs');
const copy=v=>JSON.parse(JSON.stringify(v));
const fault=(code,status=409)=>Object.assign(Error(code),{code,status});
function harness(options={}){
 const target={device_id:'Shure-fixture_ch1',receiver_id:'Shure-fixture',receiver_ip:'192.0.2.107',receiver_mac:'00:11:22:33:44:55',
  receiver_session_id:'fixture-session',channel_number:1,expected_brand:'Shure'};
 const previous={operation_id:'old-operation-0001',command:'unmute',expected_value:false,state:'unknown',revision:3,actual_value:null,
  execution_evidence:null,error:'SEND_OUTCOME_UNKNOWN',review:null,target:copy(target),
  current_observation:{target:copy(target),frequency_khz:640000,muted:false}};
 const calls=[],dispatches=[],dialogs=[],acks=[];let locked=options.locked!==false;
 const client={generation:1,ready:true,timeoutMs:10000,start:async()=>{},stop(){},rpc:async(method,body)=>{
  calls.push({method,body:copy(body)});
  if(method==='commands.targets')return {targets:[{target:copy(target)}]};
  if(method==='commands.uncertain'){
   if(options.onUncertain)options.onUncertain({previous,target,client});
   return {operations:options.noObservation?[]:[copy(previous)]};
  }
  if(method==='commands.review'){
   if(options.reviewError)throw fault('REVIEW_OBSERVATION_CHANGED');
   assert.equal(body.operation_id,previous.operation_id);assert.equal(body.expected_revision,previous.revision);
   assert.deepEqual(body.observation,copy(previous.current_observation));assert.equal(body.confirmed,true);
   locked=false;previous.review={meaning:'release-target-no-execution-claim',note:body.note};previous.revision++;
   if(options.afterReview)options.afterReview({previous,target,client});
   return copy(previous);
  }
  if(method==='commands.request'){
   if(options.requestError)throw fault('LOST_REPLY',500);
   if(locked||options.relock&&calls.some(c=>c.method==='commands.review'))throw fault('TARGET_PENDING_OR_UNCERTAIN');
   dispatches.push(copy(body));
   return {operation_id:body.operation_id,command_id:'new-command-00001',target:copy(body.target),command:body.command,
    expected_value:body.expected_value,actual_value:options.newUnknown?null:body.expected_value,attempts:1,
    state:options.newUnknown?'unknown':'readback_confirmed',error:options.newUnknown?'SEND_OUTCOME_UNKNOWN':null,
    execution_evidence:options.newUnknown?null:{source:'shure-post-write-readback',execution_ack_supported:false,target:copy(body.target)}};
  }
  throw Error('Unexpected method: '+method);
 }};
 const g={URL,performance,TextEncoder,TextDecoder,crypto:webcrypto,location:{href:'https://192.0.2.16:8080/unirf-app.html'},navigator:{},
  DatyPlatform:{},DatyPlatformFactory:{create:v=>v},DatyMQTT6:{applicationPort,M6Client:function(){return client;}},
  DatyEquipmentProfiles:{normalizeBrand:b=>String(b).toLowerCase()},DatyFrequency:{toFrequencyKHz:(v)=>Math.round(v*1000)},
  mqtt:{connect(){throw Error('No network in fixture');}},receiveCommandAcknowledgement:r=>acks.push(r),
  DatyDialogs:{confirm:async d=>{dialogs.push(d);return options.confirm===true;}},addEventListener(){},setTimeout,clearTimeout};
 vm.createContext(g);
 if(process.env.DATY_MUTE_TEST_BUNDLE){
  vm.runInContext(fs.readFileSync(path.join(process.env.DATY_MUTE_TEST_BUNDLE,'bundle.js'),'utf8'),g);
  g.DatyMQTT6.M6Client=function(){return client;};
 }
 vm.runInContext(fs.readFileSync(path.join(process.env.DATY_MUTE_TEST_BUNDLE||__dirname,'browser-boot.js'),'utf8'),g);
 const command=(name='mute',id='new-operation-0001')=>({...target,expected_brand:'shure',client_request_id:id,command:name,value:name==='set_freq'?641:name==='mute'});
 const send=(name='mute',extra={})=>g.DatyPlatform.request('https://192.0.2.16:8802/api/command',{
  method:'POST',body:JSON.stringify(command(name,extra.id)),signal:extra.signal});
 return {g,target,previous,client,calls,dispatches,dialogs,acks,send};
}
test('old unknown mute: one new click reviews current state and sends its new intent with no dialog',async()=>{
 for(const name of ['mute','unmute']){
  const h=harness();const result=await (await h.send(name)).json();
  assert.equal(result.command_record.status,'readback_confirmed');assert.equal(h.dialogs.length,0);
  assert.equal(h.dispatches.length,1);assert.equal(h.dispatches[0].operation_id,'new-operation-0001');
  assert.equal(h.dispatches[0].command,name);assert.equal(h.dispatches[0].expected_value,name==='mute');
  assert.equal(h.previous.state,'unknown');assert.equal(h.previous.actual_value,null);assert.equal(h.previous.execution_evidence,null);
  assert.match(h.previous.review.note,/新点击/);assert.match(h.previous.review.note,/不声称人工现场复核/);
  assert.deepEqual(h.calls.map(c=>c.method),['commands.targets','commands.request','commands.uncertain','commands.review','commands.targets','commands.request']);
 }
});
test('normal mute has one request and no review or dialog',async()=>{
 const h=harness({locked:false});await h.send();assert.equal(h.dispatches.length,1);
 assert.deepEqual(h.calls.map(c=>c.method),['commands.targets','commands.request']);assert.equal(h.dialogs.length,0);
});
test('frequency retains manual review, cancellation and a separate new action',async()=>{
 for(const confirm of [false,true]){
  const h=harness({confirm}),response=await h.send('set_freq');assert.equal(response.status,409);
  assert.equal(h.dialogs.length,1);assert.equal(h.dispatches.length,0);
  assert.equal(h.calls.filter(c=>c.method==='commands.review').length,confirm?1:0);
 }
});
test('mute never silently releases a previous uncertain frequency command',async()=>{
 const h=harness();h.previous.command='set_freq';
 await assert.rejects(h.send(),/上次调频结果未确认/);assert.equal(h.dialogs.length,0);assert.equal(h.dispatches.length,0);
 assert.equal(h.calls.filter(c=>c.method==='commands.review').length,0);
});
test('missing or unknown observation cannot release or send',async()=>{
 for(const options of [{noObservation:true},{onUncertain:({previous})=>{previous.current_observation.muted=null;}}]){
  const h=harness(options);await assert.rejects(h.send());assert.equal(h.dispatches.length,0);assert.equal(h.dialogs.length,0);
  assert.equal(h.calls.filter(c=>c.method==='commands.review').length,0);
 }
});
test('identity/session changes before review or before new dispatch stop the new command',async()=>{
 for(const field of ['receiver_id','receiver_ip','receiver_mac','receiver_session_id','channel_number','expected_brand']){
  for(const stage of ['before','after']){
   const h=harness(stage==='before'?{onUncertain:({previous})=>{previous.current_observation.target[field]='changed';}}:
    {afterReview:({target})=>{target[field]='changed';}});
   await assert.rejects(h.send());assert.equal(h.dispatches.length,0);assert.equal(h.dialogs.length,0);
  }
 }
});
test('lost review receipt, server change and cancelled click never dispatch',async()=>{
 const controller=new AbortController();
 for(const options of [{reviewError:true},{afterReview:({client})=>{client.generation++;}},
  {onUncertain:()=>controller.abort()}]){
  const h=harness(options);try{await h.send('mute',{signal:options.onUncertain?controller.signal:undefined});}catch{}
  assert.equal(h.dispatches.length,0);assert.equal(h.dialogs.length,0);
 }
});
test('same unknown operation is never replayed',async()=>{
 const h=harness();await assert.rejects(h.send('mute',{id:h.previous.operation_id}),/原指令不能重发/);
 assert.equal(h.dispatches.length,0);assert.equal(h.calls.filter(c=>c.method==='commands.review').length,0);
});
test('a racing second target lock never starts another review or retry loop',async()=>{
 const h=harness({relock:true});const r=await h.send();assert.equal(r.status,409);assert.equal(h.dispatches.length,0);
 assert.equal(h.calls.filter(c=>c.method==='commands.review').length,1);assert.equal(h.calls.filter(c=>c.method==='commands.request').length,2);
});
test('an accepted new unknown result and a lost request reply never trigger automatic replay',async()=>{
 const h=harness({locked:false,newUnknown:true});const r=await (await h.send()).json();
 assert.equal(r.command_record.outcome,'unknown');assert.equal(h.dispatches.length,1);
 assert.equal(h.calls.filter(c=>c.method==='commands.request').length,1);assert.equal(h.calls.filter(c=>c.method==='commands.review').length,0);
 const lost=harness({requestError:true});await assert.rejects(lost.send(),/LOST_REPLY/);
 assert.equal(lost.calls.filter(c=>c.method==='commands.request').length,1);assert.equal(lost.calls.filter(c=>c.method==='commands.review').length,0);
});
