const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const copy=v=>JSON.parse(JSON.stringify(v));
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
const cap=()=>({adapter:'fashe-mqtt',write_frequency:true,read_only:false,mute:true,
 frequency_control:{scope:'fashe-protocol',min_khz:400000,max_khz:900000,step_khz:1,origin_khz:0,ack_mode:'command-id',brand_binding:'expected-brand-v1'}});
async function harness(){
 const e={},events={},boot=[],notices=[],sent=[],saved=[],audits=[],confirmations=[],progress=[],authPrompts=[],authChecks=[],profileStore=new Map();
 function element(value=''){const handlers={},attrs={};return {value,innerHTML:'',textContent:'',style:{},options:[],
  addEventListener:(k,v)=>handlers[k]=v,dispatch:k=>handlers[k]?.(),setAttribute:(k,v)=>attrs[k]=v,getAttribute:k=>attrs[k],
  classList:{toggle(){},contains(){return false;}},appendChild(v){this.options.push(v);},focus(){},showModal(){this.open=true;}};}
 for(const [id,value]of Object.entries({plannerRange:'640000:690000',plannerCompatibility:'standard',plannerBackupCount:'0',plannerExcludedRanges:'',plannerLockedAssignments:'',plannerKnownCarriers:'',
  plannerRangeStart:'640.000',plannerRangeEnd:'690.000',plannerStepKHz:'25',plannerMinSpacingKHz:'',plannerImdSpacingKHz:'',plannerScanThresholdDbm:'',
  freqTableBody:'',planResultContent:'',plannerDetailContent:'',plannerConstraintSummary:'',plannerConstraintSaveStatus:'',plannerDeployStatus:'',targetChannelSelect:'',targetChannelHint:'',currentRule:'',plannerPushAll:'',plannerStopDeployment:'',plannerSafetyDialog:''}))e[id]=element(value);
 const c=vm.createContext({console:{log(){},warn(){},error(){}},performance,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,AbortController,
  document:{readyState:'loading',body:element(),getElementById:id=>e[id]||null,createElement:()=>element(),addEventListener:(_,fn)=>boot.push(fn),querySelectorAll:()=>[]},
  localStorage:{getItem:key=>profileStore.get(key)||null,setItem:(key,value)=>profileStore.set(key,value)},notify:(...v)=>notices.push(v),
  confirm:()=>{throw Error('Browser confirm forbidden for deployment');},DatyDialogs:{confirm:async options=>{confirmations.push(copy(options));return true;}},
  DatyDeployProgress:{open:options=>{const view={options,updates:[],closed:false};progress.push(view);return {update:s=>view.updates.push(copy(s)),close:()=>{view.closed=true;}}}}});c.window=c;
 for(const name of ['frequency','equipment-profiles','coordination','storage','dashboard','render','navigation','planning-ui','planning-deploy'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules',name+'.js'),'utf8'),c);
 c.DATY_STATE.devices.splice(0,c.DATY_STATE.devices.length,...[1,2,3].map((n,i)=>({id:n,_fasheId:`rx-${n}_ch1`,receiver_id:`rx-${n}`,receiver_ip:`192.0.2.${n}`,ip:`192.0.2.${n}`,
  receiver_mac:`02:00:00:00:00:0${n}`,channel_number:1,ch:'CH1',brand:'DATYaudio',model:'DATY-X1',name:`Receiver ${n}`,freq:[641000,645000,655000][i],_online:true,status:'online',_source:`rx-${n}:mqtt:session`,capabilities:cap()})));
 c._fasheApiUrl='http://127.0.0.1:1';c.forceRefreshAllPanels=()=>{};c.restorePlanningProjectFromServer=undefined;c.persistPlanningProject=async r=>saved.push(copy(r));
 let respond;
 c.fetch=async(_url,opts)=>{if(_url.endsWith('/api/timeline/events')){audits.push(JSON.parse(opts.body));return {json:async()=>({success:true})};}const command=JSON.parse(opts.body);sent.push(command);const record={command_id:`test-${sent.length}`,client_request_id:command.client_request_id,device_id:command.device_id,command:command.command,actual_value:command.value,status:'acknowledged',brand:c.DATY_STATE.devices.find(d=>d._fasheId===command.device_id)?.brand,expected_brand:command.expected_brand};
  if(respond)return respond(command,record);
  return {json:async()=>({success:true,command_id:record.command_id,command_record:record})};};
 for(const fn of boot)await fn();
 const h={c,e,notices,sent,saved,audits,confirmations,progress,
  devices:c.DATY_STATE.devices,setRespond:fn=>respond=fn,
  edit(id,value){e[id].value=String(value);e[id].dispatch('input');},plan(){c.runPlanning();assert.ok(c.DATY_LAST_COORDINATION,JSON.stringify(notices));return c.DATY_LAST_COORDINATION;},
  locks(value='rx-1_ch1=642.000 主持人\nrx-2_ch1=647.000 嘉宾\nrx-3_ch1=658.000 主讲'){this.edit('plannerLockedAssignments',value);this.plan();}};
 return h;
}
test('batch reuses only immutable math, refreshes once at completion and archives measured ACK stages',async()=>{
 const h=await harness();h.locks();let analyses=0,panels=0;
 const engine=h.c.DatyCoordination;
 h.c.DatyCoordination={...engine,analyzeFrequencyPlan(...args){analyses++;return engine.analyzeFrequencyPlan(...args);}};
 h.c.forceRefreshAllPanels=options=>{assert.equal(options.realtime,true);panels++;};
 const result=await h.c.pushAllFreq();await nextTurn();
 assert.equal(result.acknowledged,3);assert.equal(analyses,2);assert.equal(panels,1);
 assert.equal(h.audits.length,1);const audit=h.audits[0];assert.equal(audit.event_type,'planning.deployment');
 assert.equal(audit.details.acknowledged,3);assert.equal(audit.details.steps.length,3);
 assert.ok(audit.details.steps.every(s=>s.command_id&&s.client_request_id&&s.verified_ms>=s.started_ms&&s.state==='acknowledged'));
 const snapshot=h.c.DatyPlanningDeployment.getDiagnostics();assert.equal(snapshot[0].audit,'saved');snapshot[0].steps[0].state='changed';
 assert.equal(h.c.DatyPlanningDeployment.getDiagnostics()[0].steps[0].state,'acknowledged');
 await h.c.pushAllFreq();assert.equal(analyses,4);assert.equal(h.sent.length,3);
});
test('cached math never skips current Profile, session, GROUP or planning-option guards between ACKs',async()=>{
 for(const mutate of [h=>h.devices[1]._source='new-session',h=>h.devices[1].equipmentModeId='robust',h=>h.devices[1].group_number=22,
  h=>{h.e.plannerRangeEnd.value='680';h.e.plannerRange.value='custom';}]){
  const h=await harness();h.devices.forEach((d,i)=>{d.group_number=i+1;d.group_source='server-fifo-v1';});h.locks();
  h.setRespond((_cmd,record)=>{mutate(h);return {json:async()=>({success:true,command_id:record.command_id,command_record:record})};});
  const result=await h.c.pushAllFreq();assert.equal(result.acknowledged,1);assert.equal(h.sent.length,1);assert.equal(result.ok,false);
 }
});
test('view metadata exception after ACK cannot strand running progress or the busy guard',async()=>{
 const h=await harness();h.locks();
 h.setRespond((_cmd,record)=>{h.c.DatyPlanningConstraints={...h.c.DatyPlanningConstraints,getPlanningDevices(){throw Error('fixture view metadata unavailable');}};
  return {json:async()=>({success:true,command_id:record.command_id,command_record:record})};});
 const result=await h.c.pushAllFreq();assert.equal(result.acknowledged,1);assert.equal(h.c.DatyPlanningDeployment.isBusy(),false);
 assert.equal(h.progress[0].updates.at(-1).phase,'failed');assert.equal(h.sent.length,1);
});
test('stalled audit is cancelled without delaying ACK completion, changing device result or replaying controls',async()=>{
 const h=await harness();h.locks();const fetch=h.c.fetch,setTimeout=h.c.setTimeout;let expire,aborted=false;
 h.c.setTimeout=(fn,ms)=>ms===3000?(expire=fn,'audit-timer'):setTimeout(fn,ms);
 h.c.fetch=(url,options)=>url.endsWith('/api/timeline/events')?new Promise((resolve,reject)=>{
  options.signal.addEventListener('abort',()=>{aborted=true;reject(Error('fixture audit timed out'));});
 }):fetch(url,options);
 const result=await h.c.pushAllFreq();assert.equal(result.ok,true);assert.equal(h.sent.length,3);assert.equal(h.c.DatyPlanningDeployment.isBusy(),false);
 expire();await nextTurn();assert.equal(aborted,true);assert.equal(h.c.DatyPlanningDeployment.getDiagnostics()[0].audit,'unconfirmed');assert.equal(h.sent.length,3);
});
test('full planning to batch sends exact receiver + CH/MHz; ACK updates only matching current card',async()=>{
 const h=await harness();h.locks();const result=await h.c.pushAllFreq();assert.equal(result.ok,true);assert.equal(result.acknowledged,3);
 assert.deepEqual(h.sent.map(s=>[s.receiver_ip,s.channel_number,s.value]),[['192.0.2.1',1,642],['192.0.2.2',1,647],['192.0.2.3',1,658]]);
 assert.deepEqual(copy(h.devices.map(d=>d.freq)),[642000,647000,658000]);assert.match(h.e.freqTableBody.innerHTML,/已确认 642.000/);
 assert.ok(h.sent.every(s=>s.client_request_id));assert.equal(new Set(h.sent.map(s=>s.client_request_id)).size,3);
});
test('compact plans and sends only actual channels, with no former 25-frequency minimum',async()=>{
 const h=await harness();h.edit('plannerCompatibility','more-frequencies');h.locks();
 assert.equal(h.c.DATY_LAST_COORDINATION.assignments.length,3);assert.equal(h.c.DATY_LAST_COORDINATION.frequencyPool,undefined);
 const result=await h.c.pushAllFreq();assert.equal(result.ok,true);assert.equal(h.sent.length,3);assert.deepEqual(h.sent.map(s=>s.device_id),['rx-1_ch1','rx-2_ch1','rx-3_ch1']);
 const small=await harness();small.edit('plannerCompatibility','more-frequencies');small.edit('plannerRange','640000:641000');const plan=small.plan();
 assert.equal(plan.frequencyPool,undefined);assert.equal(plan.search.complete,true);assert.equal(plan.assignments.length,3);
 const sent=await small.c.pushAllFreq();assert.equal(sent.ok,true);assert.equal(sent.acknowledged,2);assert.equal(sent.skipped,1);assert.equal(small.sent.length,2);
});
test('per-channel deployment does not use CH/group to address the other CH1',async()=>{
 const h=await harness();h.locks();const r=await h.c.pushFreq(2);assert.equal(r.ok,true);assert.equal(h.sent.length,1);assert.equal(h.sent[0].device_id,'rx-2_ch1');
 assert.deepEqual(copy(h.devices.map(d=>d.freq)),[641000,647000,655000]);
});

test('group-ordered plan keeps routing, and live GROUP changes invalidate before any confirmation or command',async()=>{
 for(const mutate of [d=>d.group_number=20,d=>delete d.group_source]){
  const h=await harness();h.devices.forEach((d,i)=>{d.group_source='server-fifo-v1';d.group_number=[1,2,10][i];});
  const plan=h.plan();assert.equal(plan.search.complete,true);assert.equal(plan.allocationOrder.enabled,true);
  mutate(h.devices[0]);const result=await h.c.pushAllFreq();
  assert.equal(result.ok,false);assert.equal(h.sent.length,0);assert.equal(h.confirmations.length,0);assert.match(JSON.stringify(h.notices),/GROUP/);
 }
 const h=await harness();h.devices.forEach((d,i)=>{d.group_source='server-fifo-v1';d.group_number=[1,2,10][i];});
 const plan=h.plan(),expected=copy(plan.assignments).map(a=>({id:a.deviceId,f:a.frequencyKHz}));
 assert.equal((await h.c.pushAllFreq()).ok,true);
 assert.deepEqual(h.sent.map(cmd=>[cmd.device_id,cmd.channel_number,cmd.value]),expected.map(a=>[`rx-${a.id}_ch1`,1,a.f/1000]));
});

test('newly confirmed GROUP invalidates a plan that was made with all groups unknown',async()=>{
 const h=await harness();h.plan();h.devices[0].group_source='server-fifo-v1';h.devices[0].group_number=1;
 assert.equal((await h.c.pushAllFreq()).ok,false);assert.equal(h.sent.length,0);assert.match(JSON.stringify(h.notices),/GROUP/);
});
test('original frequency matches skip sending, never claim an ACK that did not happen',async()=>{
 const h=await harness();h.plan();const r=await h.c.pushAllFreq();assert.equal(r.skipped,3);assert.equal(r.acknowledged,0);assert.equal(h.sent.length,0);assert.match(h.e.plannerDeployStatus.textContent,/原频一致 3/);
});
test('no plan, partial/conflicting plans and history-only planned values cannot be deployed',async()=>{
 const h=await harness();h.devices.forEach(d=>d.planned=641000);assert.equal((await h.c.pushAllFreq()).ok,false);
 h.edit('plannerExcludedRanges','640.000-690.000 禁止');h.plan();assert.equal((await h.c.pushAllFreq()).ok,false);assert.equal(h.sent.length,0);
});
test('constraint changes, device-side frequency, topology, sessions and Profile changes reject stale plans',async()=>{
 for(const mutate of [h=>h.edit('plannerBackupCount','1'),h=>h.devices[1].freq=646000,h=>h.devices.pop(),h=>h.devices[0]._source+='changed',h=>h.devices[0].equipmentModeId='robust',h=>h.devices[0]._online=false]){
  const h=await harness();h.locks();mutate(h);assert.equal((await h.c.pushAllFreq()).ok,false);assert.equal(h.sent.length,0);
 }
});
test('read-only/unknown capabilities and legacy telemetry confirmation do not unlock FAshe deployment',async()=>{
 for(const change of [c=>c.write_frequency=false,c=>c.adapter='shure-scp-readonly',c=>c.frequency_control.ack_mode='telemetry',c=>c.frequency_control.scope='hardware-unknown']){
  const h=await harness();h.locks();change(h.devices[0].capabilities);assert.equal((await h.c.pushAllFreq()).ok,false);assert.equal(h.sent.length,0);
 }
});
test('partial failure stops remaining queue and never overwrites unacknowledged device frequency',async()=>{
 const h=await harness();h.locks();h.setRespond((_cmd,record)=>({json:async()=>({success:true,command_id:record.command_id,command_record:{...record,status:h.sent.length===2?'failed':'acknowledged',error:'receiver refusal'}})}));
 const r=await h.c.pushAllFreq();assert.equal(r.acknowledged,1);assert.equal(r.failed,1);assert.equal(h.sent.length,2);assert.deepEqual(copy(h.devices.map(d=>d.freq)),[642000,645000,655000]);assert.match(h.e.plannerDeployStatus.textContent,/未发送 1/);
});
test('wrong ACK receiver, command, MHz units and exact frequency are rejected',async()=>{
 for(const fields of [{device_id:'rx-other_ch1'},{command:'mute'},{actual_value:642000},{actual_value:642.001},{actual_value:true}]){
  const h=await harness();h.locks();h.setRespond((_cmd,r)=>({json:async()=>({success:true,command_id:r.command_id,command_record:{...r,...fields}})}));
  assert.equal((await h.c.pushFreq(1)).ok,false);assert.equal(h.devices[0].freq,641000);
 }
});
test('SSE ACK before stalled POST completes frequency transaction; duplicates blocked and stop waits current ACK',async()=>{
 const h=await harness();h.locks();let ack;
 h.setRespond((_cmd,r)=>{ack=r;return new Promise(()=>{});});const waiting=h.c.pushAllFreq();
 assert.equal(h.devices[0].freq,641000);assert.equal((await h.c.pushFreq(2)).error,'busy');await nextTurn();h.c.DatyPlanningDeployment.stop();
 h.c.receiveCommandAcknowledgement(ack);const r=await waiting;assert.equal(r.acknowledged,1);assert.equal(h.sent.length,1);assert.equal(h.devices[1].freq,645000);
});
test('late external state change between ACKs stops batch; input edit during in-flight ACK never resumes old queue',async()=>{
 for(const change of [h=>h.devices[1].freq=649000,h=>h.edit('plannerExcludedRanges','660.000-661.000 新排除')]){
  const h=await harness();h.locks();h.setRespond((_cmd,r)=>{change(h);return {json:async()=>({success:true,command_id:r.command_id,command_record:r})};});
  const r=await h.c.pushAllFreq();assert.equal(r.acknowledged,1);assert.equal(h.sent.length,1);assert.equal(h.c.DatyPlanningDeployment.isBusy(),false);
 }
});
test('manual allocation edit becomes a persisted hard lock and requires a new global plan',async()=>{
 const h=await harness();h.plan();h.c.DatyPlanningConstraints.setManualLock(2,'649.250');assert.equal(h.c.DATY_LAST_COORDINATION,null);
 assert.equal((await h.c.pushFreq(2)).ok,false);assert.equal(h.sent.length,0);h.plan();assert.equal(h.devices[1].planned,649250);
 assert.equal((await h.c.pushFreq(2)).ok,true);assert.equal(h.sent[0].value,649.250);assert.equal(h.saved.at(-1).constraints.lockedAssignments[0].frequencyKHz,649250);
});
test('custom MHz range/step and additive safety settings actually reach solver and project history',async()=>{
 const h=await harness();h.edit('plannerRange','custom');h.edit('plannerRangeStart','640.000');h.edit('plannerRangeEnd','680.000');h.edit('plannerStepKHz','125');
 h.edit('plannerMinSpacingKHz','750');h.edit('plannerImdSpacingKHz','500');h.edit('plannerScanThresholdDbm','-90');const r=h.plan();
 assert.equal(r.options.rangeEndKHz,680000);assert.equal(r.options.stepKHz,125);assert.equal(r.options.minChannelSpacingKHz,750);assert.equal(r.options.minImdSpacingKHz,500);assert.equal(r.options.scanThresholdDbm,-90);
 assert.equal(h.saved.at(-1).constraintFields.plannerStepKHz,'125');
 const c=h.c.DatyCoordination.analyzeFrequencyPlan(h.devices,new Map([[1,641000],[2,641500],[3,655000]]),r.options);assert.ok(c.conflicts.some(i=>i.type==='channel-spacing'));
 h.edit('plannerRangeStart','bad');h.c.runPlanning();assert.equal(h.c.DATY_LAST_COORDINATION,null);
});
test('invalid custom safety values and range precision cannot be saved or silently rounded',async()=>{
 for(const [id,value]of [['plannerStepKHz','0'],['plannerStepKHz','1.5'],['plannerMinSpacingKHz','-1'],['plannerImdSpacingKHz','bad'],['plannerScanThresholdDbm','1']]){
  const h=await harness();h.edit(id,value);h.c.runPlanning();assert.equal(h.c.DATY_LAST_COORDINATION,null);await h.c.saveCurrentPlanningConstraints();assert.equal(h.saved.length,0);
 }
});
test('single send validates other current frequencies, not their future planned values',async()=>{
 const h=await harness();h.locks('rx-1_ch1=645.000\nrx-2_ch1=647.000\nrx-3_ch1=658.000');
 const r=await h.c.pushFreq(1);assert.equal(r.ok,false);assert.match(r.error,/当前实频/);assert.equal(h.sent.length,0);
});
test('a read-only non-target may be included in planning but never accidentally receives a batch command',async()=>{
 const h=await harness();h.devices[2].brand='Shure';h.devices[2].model='ULXD4';h.devices[2].capabilities={adapter:'shure-scp-readonly',write_frequency:false};
 h.locks('rx-1_ch1=642.000\nrx-2_ch1=647.000');
 assert.equal((await h.c.pushFreq(1)).ok,true);assert.equal(h.sent.length,1);
 assert.equal((await h.c.pushAllFreq()).ok,false);assert.equal(h.sent.length,1);
});
test('frequency request has an absolute deadline; late ACK cannot overwrite an ended operation',async()=>{
 const h=await harness();h.setRespond(()=>new Promise(()=>{}));
 await assert.rejects(h.c.sendTrackedDeviceCommand(h.c.buildTargetedDeviceCommand(h.devices[0],'set_freq',642),25),/请求超时/);
 h.c.receiveCommandAcknowledgement({command_id:'late',client_request_id:h.sent[0].client_request_id,device_id:'rx-1_ch1',command:'set_freq',actual_value:642,status:'acknowledged'});
 assert.equal(h.devices[0].freq,641000);
});
test('cancel confirmation sends nothing and releases no optimistic frequency changes',async()=>{
 const h=await harness();h.locks();h.c.DatyDialogs.confirm=async()=>false;assert.equal((await h.c.pushAllFreq()).cancelled,true);assert.equal(h.sent.length,0);assert.equal(h.devices[0].freq,641000);
});
test('custom controls cannot weaken Profile floor; options-only history restores custom safety fields',async()=>{
 const h=await harness();h.edit('plannerMinSpacingKHz','100');h.edit('plannerImdSpacingKHz','50');h.plan();
 const analysis=h.c.DatyCoordination.analyzeFrequencyPlan(h.devices,new Map([[1,641000],[2,641125],[3,655000]]),h.c.DATY_LAST_COORDINATION.options);
 assert.ok(analysis.conflicts.some(c=>c.type==='channel-spacing'&&c.requiredSpacingKHz===250));
 assert.ok(analysis.conflicts.some(c=>c.type==='coordination-grid'));
 h.c.DatyPlanningConstraints.restoreSnapshot({options:{rangeStartKHz:640000,rangeEndKHz:680000,stepKHz:125,minChannelSpacingKHz:750,minImdSpacingKHz:500,scanThresholdDbm:-90}});
 assert.equal(h.e.plannerStepKHz.value,'125');assert.equal(h.e.plannerMinSpacingKHz.value,'750');assert.equal(h.e.plannerScanThresholdDbm.value,'-90');
});

test('brand/profile, identity changes and old Bridge reject a stale frequency plan before any send',async()=>{
 for(const change of [h=>h.devices[0].brand='AMSaudio',h=>h.devices[0].receiver_ip='192.0.2.99',h=>h.devices[0].receiver_mac='02:00:00:00:00:99',h=>h.devices[0].channel_number=2,h=>delete h.devices[0].capabilities.frequency_control.brand_binding]){
  const h=await harness();h.locks();change(h);const result=await h.c.pushAllFreq();assert.equal(result.ok,false);assert.equal(h.sent.length,0);
 }
 const h=await harness();h.devices[0].equipmentProfileId='shure-ulx-d';h.c.runPlanning();assert.equal(h.c.DATY_LAST_COORDINATION,null);assert.equal(h.sent.length,0);
});

test('ACK wrong/missing source brand or brand changes while waiting cannot update current cards',async()=>{
 for(const fields of [{brand:'AMSaudio'},{expected_brand:'AMSaudio'},{brand:undefined},{expected_brand:undefined}]){
  const h=await harness();h.locks();h.setRespond((_cmd,r)=>({json:async()=>({success:true,command_id:r.command_id,command_record:{...r,...fields}})}));
  assert.equal((await h.c.pushFreq(1)).ok,false);assert.equal(h.devices[0].freq,641000);
 }
 const h=await harness();h.locks();h.setRespond((_cmd,r)=>{h.devices[0].brand='AMSaudio';return {json:async()=>({success:true,command_id:r.command_id,command_record:r})};});
 assert.equal((await h.c.pushFreq(1)).ok,false);assert.equal(h.devices[0].freq,641000);
});

test('DATY off-250 lock never becomes deployable even when the protocol accepts 1 kHz',async()=>{
 const h=await harness();h.locks('rx-1_ch1=642.125');assert.ok(h.c.DATY_LAST_COORDINATION.errors.length);
 assert.equal((await h.c.pushFreq(1)).ok,false);assert.equal(h.sent.length,0);
});

test('mixed-brand joint result stays bound to matching brand + receiver + CH on every send',async()=>{
 const h=await harness(),p=copy(h.c.DatyEquipmentProfiles.resolveEquipmentProfile(h.devices[0]));
 p.id='fixture-ams-400';p.manufacturer='AMSaudio';p.models=['Test only'];p.minimumChannelSpacingKHz=400;
 p.coordinationGrid={stepKHz:100,originKHz:0};p.spacingProvenance={kind:'synthetic-test-only',title:'Not manufacturer data',revision:'fixture1',verified:true};
 for(const settings of [...Object.values(p.compatibility),...p.modes.map(m=>m.settings)]){
   settings.channelSpacingKHz=Math.max(400,settings.channelSpacingKHz);
   settings.intermodSpacingKHz=Math.max(150,settings.intermodSpacingKHz); // Synthetic AMS Profile does not inherit DATY-only IMD opt-out.
 }
 h.c.DatyEquipmentProfiles.saveCustomEquipmentProfile(p);
 h.devices[1].brand='AMSaudio';h.devices[1].equipmentProfileId=p.id;h.locks();
 const result=await h.c.pushAllFreq();assert.equal(result.ok,true);
 assert.deepEqual(h.sent.map(s=>[s.expected_brand,s.device_id,s.receiver_ip,s.channel_number]),[
  ['datyaudio','rx-1_ch1','192.0.2.1',1],['amsaudio','rx-2_ch1','192.0.2.2',1],['datyaudio','rx-3_ch1','192.0.2.3',1]]);
});

test('unverified other-brand minimum never opens frequency write capabilities',async()=>{
 const h=await harness();h.devices[1].brand='AMSaudio';h.locks();assert.equal((await h.c.pushAllFreq()).ok,false);assert.equal(h.sent.length,0);
});

test('application dialog previews exact targets/MHz and retains all safety warnings',async()=>{
 const h=await harness();h.locks();await h.c.pushFreq(2);const single=h.confirmations[0];
 assert.match(single.title,/单通道/);assert.equal(single.rows.length,1);
 assert.deepEqual(single.rows[0],{brand:'DATYaudio',receiver:'192.0.2.2',channel:'CH1',currentFrequency:'645.000 MHz',plannedFrequency:'647.000 MHz',note:''});
 assert.match(single.warnings.join(' '),/未导入真实扫描/);assert.match(single.warnings.join(' '),/设备 ACK/);assert.match(single.warnings.join(' '),/不自动回退/);
 await h.c.pushAllFreq();const batch=h.confirmations[1];assert.match(batch.title,/全部/);assert.equal(batch.rows.length,3);
 assert.match(batch.message,/2 个待调整.*1 个原频一致/);assert.match(batch.rows[1].note,/无需发送/);
});

test('asynchronous confirmation is single-flight; cancel releases the lock with zero commands',async()=>{
 const h=await harness();h.locks();let decide;h.c.DatyDialogs.confirm=()=>new Promise(resolve=>decide=resolve);
 const pending=h.c.pushAllFreq();assert.equal(h.c.DatyPlanningDeployment.isBusy(),true);assert.equal(h.e.plannerPushAll.disabled,true);
 assert.equal(h.sent.length,0);assert.equal((await h.c.pushFreq(1)).error,'busy');
 await nextTurn();decide(false);assert.equal((await pending).cancelled,true);assert.equal(h.sent.length,0);
 assert.equal(h.c.DatyPlanningDeployment.isBusy(),false);assert.equal(h.e.plannerPushAll.disabled,false);
});

test('state changing while dialog is open fails fresh preflight before any actual send',async()=>{
 for(const mutate of [h=>h.devices[0].freq=650000,h=>h.devices[0]._online=false,h=>h.devices[0].brand='AMSaudio',
   h=>h.devices[0]._source+='new-session',h=>h.c.invalidateCoordination('new settings')]){
  const h=await harness();h.locks();let decide;h.c.DatyDialogs.confirm=()=>new Promise(resolve=>decide=resolve);
  const pending=h.c.pushAllFreq();await nextTurn();mutate(h);decide(true);const result=await pending;
  assert.equal(result.ok,false);assert.equal(h.sent.length,0);assert.equal(h.c.DatyPlanningDeployment.isBusy(),false);
 }
});

test('missing or rejected dialog never falls back to browser confirm and never sends',async()=>{
 for(const value of [undefined,{confirm:async()=>{throw Error('Dialog view unavailable');}}]){
  const h=await harness();h.locks();h.c.DatyDialogs=value;assert.equal((await h.c.pushAllFreq()).ok,false);
  assert.equal(h.sent.length,0);assert.equal(h.c.DatyPlanningDeployment.isBusy(),false);
 }
});

test('single unchanged frequency retains deliberate re-send and accurate confirmation wording',async()=>{
 const h=await harness();h.plan();const result=await h.c.pushFreq(1);assert.equal(result.acknowledged,1);assert.equal(h.sent.length,1);
 assert.match(h.confirmations[0].message,/重新发送/);assert.match(h.confirmations[0].rows[0].note,/重新确认/);
});

test('single progress starts at zero and remains pending until exact FAshe ACK',async()=>{
 const h=await harness();h.locks();let ack;h.setRespond((_cmd,r)=>{ack=r;return new Promise(()=>{});});
 const pending=h.c.pushFreq(1);await nextTurn();
 assert.ok(ack);assert.equal(h.progress.length,1);assert.equal(h.sent.length,1);
 assert.ok(h.progress[0].updates.every(s=>s.phase==='running'&&s.acknowledged===0));
 assert.match(h.progress[0].updates.at(-1).message,/等待 DATYaudio DATY-X1/);assert.equal(h.devices[0].freq,641000);
 h.c.receiveCommandAcknowledgement(ack);assert.equal((await pending).ok,true);
 const result=h.progress[0].updates.at(-1);assert.equal(result.phase,'success');assert.equal(result.acknowledged,1);assert.equal(result.remaining,0);
 assert.match(h.notices.at(-1)[1],/下发成功/);assert.match(result.message,/正确确认 1/);
});

test('batch progress advances from matched ACKs, not number of command POSTs',async()=>{
 const h=await harness();h.locks();const acks=[];h.setRespond((_cmd,r)=>{acks.push(r);return new Promise(()=>{});});
 const pending=h.c.pushAllFreq();await nextTurn();
 for(let i=0;i<3;i++){
  const snapshot=h.progress[0].updates.at(-1);assert.equal(h.sent.length,i+1);assert.equal(snapshot.acknowledged,i);assert.equal(snapshot.phase,'running');
  h.c.receiveCommandAcknowledgement(acks[i]);await nextTurn();
 }
 assert.equal((await pending).acknowledged,3);assert.equal(h.progress[0].updates.at(-1).phase,'success');
});

test('all unchanged batch shows no new ACK and never claims a successful transmission',async()=>{
 const h=await harness();h.plan();await h.c.pushAllFreq();const end=h.progress[0].updates.at(-1);
 assert.equal(end.phase,'unchanged');assert.equal(end.acknowledged,0);assert.equal(end.skipped,3);assert.equal(h.sent.length,0);
 assert.equal(h.notices.at(-1)[1],'无需下发');assert.match(end.message,/没有发送指令/);
});

test('failed/wrong-brand/wrong-frequency/non-ACK reply never advances success progress',async()=>{
 for(const mutate of [r=>({...r,status:'failed',error:'receiver rejected'}),r=>({...r,brand:'AMSaudio'}),r=>({...r,actual_value:642.250})]){
  const h=await harness();h.locks();h.setRespond((_cmd,r)=>({json:async()=>({success:true,command_id:r.command_id,command_record:mutate(r)})}));
  assert.equal((await h.c.pushAllFreq()).ok,false);const end=h.progress[0].updates.at(-1);
  assert.equal(end.phase,'failed');assert.equal(end.acknowledged,0);assert.equal(end.failed,1);assert.equal(end.remaining,2);
  assert.equal(h.sent.length,1);assert.equal(h.devices[0].freq,641000);assert.notEqual(h.notices.at(-1)[1],'下发成功');
 }
 const h=await harness();h.locks();h.c.sendTrackedDeviceCommand=async()=>({status:'published'});
 assert.equal((await h.c.pushFreq(1)).ok,false);assert.equal(h.progress[0].updates.at(-1).phase,'failed');assert.equal(h.devices[0].freq,641000);
});

test('timeout reports failure with zero ACK and no fictitious 100 percent',async()=>{
 const h=await harness();h.locks();h.c.sendTrackedDeviceCommand=async()=>{throw Error('设备确认超时');};
 await h.c.pushFreq(1);const end=h.progress[0].updates.at(-1);assert.equal(end.phase,'failed');assert.equal(end.acknowledged+end.skipped,0);assert.match(end.message,/超时/);
});

test('progress stop keeps the in-flight ACK, marks unsent rows and does not claim whole-batch success',async()=>{
 const h=await harness();h.locks();let ack;h.setRespond((_cmd,r)=>{ack=r;return new Promise(()=>{});});
 const pending=h.c.pushAllFreq();await nextTurn();h.progress[0].options.onStop();
 assert.equal(h.c.DatyPlanningDeployment.isBusy(),true);assert.equal(h.progress[0].updates.at(-1).phase,'running');
 assert.match(h.progress[0].updates.at(-1).message,/停止后续/);h.c.receiveCommandAcknowledgement(ack);
 assert.equal((await pending).acknowledged,1);const end=h.progress[0].updates.at(-1);
 assert.equal(end.phase,'stopped');assert.equal(end.remaining,2);assert.equal(end.rows.filter(r=>r.state==='not-sent').length,2);assert.equal(h.sent.length,1);
});

test('cancelled confirmation never opens progress, and absent progress UI fails before sending',async()=>{
 const h=await harness();h.locks();h.c.DatyDialogs.confirm=async()=>false;await h.c.pushFreq(1);assert.equal(h.progress.length,0);
 h.c.DatyDialogs.confirm=async()=>true;h.c.DatyDeployProgress=undefined;assert.equal((await h.c.pushFreq(1)).ok,false);assert.equal(h.sent.length,0);assert.equal(h.c.DatyPlanningDeployment.isBusy(),false);
});

test('progress setup error is reported as not sent, releases busy and allows a failed view to close',async()=>{
 const h=await harness();h.locks();let failure;
 h.c.DatyDeployProgress.open=()=>({update:()=>{throw Error('progress unavailable');},failBeforeSend:message=>{failure=message;}});
 assert.equal((await h.c.pushFreq(1)).ok,false);assert.equal(failure,'progress unavailable');assert.equal(h.sent.length,0);
 assert.equal(h.c.DatyPlanningDeployment.isBusy(),false);
});

test('a rendering failure after correct ACK cannot turn a confirmed receiver into a failed delivery',async()=>{
 const h=await harness();h.locks();h.c.renderFreqTable=()=>{throw Error('table unavailable');};h.c.forceRefreshAllPanels=()=>{throw Error('panel unavailable');};
 const result=await h.c.pushAllFreq();assert.equal(result.acknowledged,3);assert.equal(result.failed,0);
 const end=h.progress[0].updates.at(-1);assert.equal(end.phase,'success');assert.equal(end.acknowledged,3);assert.equal(end.failed,0);
});

test('single and all enter review without an authorization module or auth request',async()=>{
 for(const single of [false,true]){
  const h=await harness();h.locks();assert.equal(h.c.DatyAccess,undefined);
  h.c.DatyDialogs.confirm=async options=>{h.confirmations.push(options);return false;};
  const result=await(single?h.c.pushFreq(1):h.c.pushAllFreq());
  assert.equal(result.cancelled,true);assert.equal(h.confirmations.length,1);
  assert.equal(h.sent.length,0);assert.equal(h.progress.length,0);
 }
});
test('server change during review requires fresh confirmation and sends nothing',async()=>{
 const h=await harness();h.locks();h.c.DatyDialogs.confirm=async()=>{h.c._fasheApiUrl='https://other.invalid:8802';return true;};
 const result=await h.c.pushAllFreq();assert.equal(result.ok,false);assert.match(result.error,/服务器地址已变化/);
 assert.equal(h.sent.length,0);assert.equal(h.progress.length,0);assert.equal(h.c.DatyPlanningDeployment.isBusy(),false);
});
test('server change after a matching ACK stops remaining channels without losing that ACK',async()=>{
 const h=await harness();h.locks();h.setRespond((_cmd,record)=>{
  h.c._fasheApiUrl='https://other.invalid:8802';return {json:async()=>({success:true,command_id:record.command_id,command_record:record})};
 });
 const result=await h.c.pushAllFreq(),end=h.progress[0].updates.at(-1);
 assert.equal(result.acknowledged,1);assert.equal(result.failed,0);assert.equal(result.sent,1);
 assert.equal(end.phase,'stopped');assert.equal(end.remaining,2);
 assert.deepEqual(copy(h.devices.map(d=>d.freq)),[642000,645000,655000]);
});
test('explicit HTTP rejection stops with zero sent and no automatic replay',async()=>{
 for(const status of [400,403,413,415,422]){
  const h=await harness();h.locks();h.setRespond(()=>({status,json:async()=>({success:false,accepted:false,code:'INVALID_REQUEST',error:'Rejected'})}));
  const result=await h.c.pushAllFreq();assert.equal(result.sent,0);assert.equal(result.failed,0);assert.equal(result.acknowledged,0);
  assert.equal(h.sent.length,1);assert.equal(h.progress[0].updates.at(-1).phase,'stopped');
 }
});
test('ambiguous HTTP error is unconfirmed failure and cannot change current frequency',async()=>{
 const h=await harness();h.locks();h.setRespond(()=>({status:500,json:async()=>({success:false,error:'Uncertain proxy failure'})}));
 const result=await h.c.pushFreq(1);assert.equal(result.failed,1);assert.equal(result.sent,1);assert.equal(h.devices[0].freq,641000);
});


function shure(h){
 const d=h.devices[0];Object.assign(d,{brand:'Shure',model:'ULXD4',_source:'shure-scp',shure:{meter_stream_id:'meter-session'},
  capabilities:{adapter:'shure-scp',write_frequency:true,mute:true,read_only:false,hardware_band:{band:'L51',source:'chassis-label-confirmed',verified:true},
   frequency_control:{scope:'shure-scp',ack_mode:'readback',brand_binding:'expected-brand-v1',min_khz:632000,max_khz:696000,step_khz:25,origin_khz:0}}});
 return d;
}
test('mixed Shure readback and DATY ACK remain distinct in planning results and saved evidence',async()=>{
 const h=await harness(),d=shure(h);h.locks();
 h.setRespond((cmd,record)=>{if(cmd.expected_brand==='shure'){
  record.status='readback_confirmed';record.execution_evidence={source:'shure-post-write-readback',execution_ack_supported:false,target:copy(cmd)};
 }return {json:async()=>({success:true,command_id:record.command_id,command_record:record})};});
 const result=await h.c.pushAllFreq();assert.equal(result.ok,true,JSON.stringify({result,notices:h.notices}));assert.equal(result.readbackConfirmed,1);assert.equal(result.acknowledged,3);
 const view=h.progress[0].updates.at(-1);assert.equal(view.readbackConfirmed,1);assert.equal(view.rows.filter(r=>r.state==='readback_confirmed').length,1);
 assert.equal(h.audits[0].details.steps[0].execution_evidence.source,'shure-post-write-readback');
 assert.equal(h.sent[0].receiver_session_id,'meter-session');assert.equal(h.sent[0].expected_brand,'shure');
 const profile=h.c.DatyEquipmentProfiles.resolveEquipmentProfile(d);assert.deepEqual(copy(profile.tuningRangeKHz),[632000,696000]);assert.equal(profile.minimumChannelSpacingKHz,350);
});
test('readback with the wrong receiver proof cannot update a Shure frequency',async()=>{
 const h=await harness(),d=shure(h);h.locks();
 h.setRespond((cmd,record)=>{record.status='readback_confirmed';record.execution_evidence={source:'shure-post-write-readback',execution_ack_supported:false,target:{...cmd,receiver_mac:'wrong'}};
 return {json:async()=>({success:true,command_id:record.command_id,command_record:record})};});
 const result=await h.c.pushFreq(1);assert.equal(result.ok,false);assert.equal(d.freq,641000);assert.equal(result.readbackConfirmed,0);
});
test('Shure output mute and unmute send directly without a confirmation dialog',async()=>{
 const h=await harness(),d=shure(h);
 h.c.DatyDialogs.confirm=async()=>{throw Error('Mute must not open a confirmation dialog');};
 h.setRespond((cmd,record)=>{
  record.status='readback_confirmed';record.execution_evidence={source:'shure-post-write-readback',execution_ack_supported:false,target:copy(cmd)};
  return {json:async()=>({success:true,command_id:record.command_id,command_record:record})};
 });
 await h.c.muteDevice(d.id);assert.equal(h.sent.length,1);assert.equal(d.muted,true);
 await h.c.unmuteDevice(d.id);assert.equal(h.sent.length,2);assert.equal(d.muted,false);
 assert.deepEqual(h.sent.map(s=>[s.device_id,s.command,s.value,s.expected_brand,s.receiver_session_id]),
  [['rx-1_ch1','mute',true,'shure','meter-session'],['rx-1_ch1','unmute',false,'shure','meter-session']]);
 assert.equal(h.confirmations.length,0);assert.match(h.notices.at(-1)[2],/输出状态回读确认/);
});
