'use strict';
// Replay the original alert harness against both source and generated candidate.
// Fixed time/UUIDs and no networking; compare every edge, not only final values.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const [source,candidate]=process.argv.slice(2);
const harnessSource=fs.readFileSync(path.join(source,'tests/alert-history.test.cjs'),'utf8').split("test('one 30-second timer")[0];
function make(root){
  let uuid=0;
  const mod={exports:{}};
  vm.runInNewContext(harnessSource+'\nmodule.exports={harness};',{module:mod,AbortController,__dirname:path.join(root,'tests'),
    require:name=>name==='node:crypto'?{randomUUID:()=>('00000000-0000-4000-8000-'+String(++uuid).padStart(12,'0'))}:require(name)});
  const h=mod.exports.harness();h.context.performance={now:h.now};
  h.context.DatyMqttScheduleArchiveStatus=()=>{};
  h.refreshes=0;h.context.DatyAutoFrequency={requestRefresh:()=>h.refreshes++,getSummary:()=>null};
  vm.runInContext(fs.readFileSync(path.join(root,'src/modules/fashe.js'),'utf8'),h.context);
  h.evaluate([{...h.device,group:4,group_number:4,group_source:'server-fifo-v1',rf:-35,batt:100,afDbfs:-20,
    _source:'fixture:mqtt:session',receiver_mac:'02:00:00:00:00:01',model:'RF PRO',freq:641000,channel_number:1}]);
  h.snapshot=()=>h.read('JSON.stringify({devices:DEVICES,alerts:ALERTS,pending:[..._pendingAlertArchive.values()]})');
  return h;
}
const before=make(source),after=make(candidate);
const patches=[{af_dbfs:0},{af_dbfs:null},{af_dbfs:-20},{rf:-95},{rf:-35},{battery:2},{battery:100},
  {muted:true},{freq:642000},{brand:'DATYaudio',model:'DATY-X2'},{_online:false,status:'offline'},
  {_online:true,status:'online'}, {group:11,group_number:11}, {af_dbfs:0}, {af_dbfs:-20}];
let previousRefreshes=after.refreshes;
for(const [index,fields] of patches.entries()){
  for(const h of [before,after]){
    h.advance(10);h.context._fasheHandleDeviceUpdate([{id:h.device._fasheId,receiver_id:'rx',
      receiver_ip:h.device.receiver_ip,receiver_mac:'02:00:00:00:00:01',channel_number:1,channel:1,...fields}]);
  }
  assert.equal(after.snapshot(),before.snapshot(),'Original/candidate differ after event '+index);
  // First packet completes the original fixture's sparse identity fields.
  if(index>0&&index<8)assert.equal(after.refreshes,previousRefreshes,'Amplitude/mute must not rebuild recommendation input');
  if(index===8)assert(after.refreshes>previousRefreshes,'Frequency change must invalidate immediately');
  previousRefreshes=after.refreshes;
}
assert(after.refreshes<before.refreshes);
// Healthy 100-channel traffic plus RF/AF/battery and identity edges: compare
// the complete state after EACH event, including unrelated active lifecycles.
for(const h of [before,after])h.evaluate(Array.from({length:100},(_,n)=>({...h.device,
  id:'rx_ch'+(n+1),_fasheId:'FAshe-MAC-020000000001_ch'+(n+1),channel_number:n+1,ch:'CH'+(n+1),
  rf:-35,afDbfs:-20,batt:100,group:4,group_number:4,group_source:'server-fifo-v1',_source:'fixture:mqtt:session'})));
for(let n=0;n<200;n++){
  const ch=n%100+1,fields=n<100?{af_dbfs:n%4===0?0:-20,rf:n%4===1?-95:-35,battery:n%4===2?2:100}:
    {af_dbfs:-20,rf:-35,battery:100,model:n%3===0?'DATY-X2':'RF PRO',name:'Channel '+ch};
  for(const h of [before,after]){
    h.advance(10);h.context._fasheHandleDeviceUpdate([{id:'FAshe-MAC-020000000001_ch'+ch,receiver_id:'rx',
      receiver_ip:h.device.receiver_ip,receiver_mac:'02:00:00:00:00:01',channel_number:ch,channel:ch,...fields}]);
  }
  assert.equal(after.snapshot(),before.snapshot(),'100-channel replay differs after event '+n);
}
console.log(JSON.stringify({ok:true,events:patches.length,all_device_alert_and_pending_snapshots_equal:true,
  multichannel_events:200,channels:100,original_recommendation_checks:before.refreshes,candidate_recommendation_checks:after.refreshes}));
