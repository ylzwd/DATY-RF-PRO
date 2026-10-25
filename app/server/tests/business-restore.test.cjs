// C1 memory-only backup rehearsal: no production origin, network, device or disk writes.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const migration=require('../src/platform/browser-data-migration.js');
const clone=value=>JSON.parse(JSON.stringify(value));
function memory(initial={}) {
  const values=new Map(Object.entries(initial));
  return {values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
}
function runtime(storage) {
  const requests=[],elements=new Map();
  const element=()=>({value:'',innerHTML:'',textContent:'',style:{},classList:{contains:()=>false},addEventListener(){}});
  const c=vm.createContext({DatyPlatform:{kind:'native-fixture',storage,request(url){requests.push(url);throw new Error('No network allowed');}},
    document:{readyState:'loading',getElementById:id=>elements.get(id)||null,addEventListener(){},createElement:element,body:{appendChild(){}}},
    console:{warn(){},error(){},log(){}},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},requestAnimationFrame:()=>1,
    addEventListener(){},notify(){},AbortSignal,URL,Date});
  c.window=c;
  for(const name of ['frequency','equipment-profiles','storage','render','alert-history']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules',name+'.js'),'utf8'),c,{filename:name+'.js'});
  }
  return {c,requests,read:expression=>clone(vm.runInContext(expression,c))};
}
function fixture() {
  const profile=clone(runtime(memory()).c.DatyEquipmentProfiles.getAllEquipmentProfiles({persistMigration:false}).find(p=>p.id==='datyaudio-fashe-protocol'));
  profile.id='c1-fixture-profile';profile.models=['C1 fixture'];
  const legacy={...profile,id:'legacy-fixture'};
  for(const key of ['bands','modes','provenance','defaultBandId','defaultModeId'])delete legacy[key];
  const device={id:'rx_ch1',_fasheId:'FAshe-MAC-020000000001_ch1',receiver_id:'rx',receiver_ip:'192.0.2.10',
    channel_number:1,ch:'CH1',brand:'DATYaudio',model:'C1 fixture',freq:641250,planned:641500,rf:-65,afDbfs:-6,batt:25,_online:true,status:'online',_source:'fashe'};
  const record={id:'keep',projectId:'fixture-project',type:'daty_rf_planning',devices:[device],
    constraints:{lockedAssignments:[{deviceId:'rx_ch1',frequencyKHz:641250,note:'主持人'}],excludedRanges:[{startKHz:650000,endKHz:651000}],
      knownCarriers:[{frequencyKHz:660000,guardKHz:250}],backupCount:0},
    constraintFields:{plannerBackupCount:'0',plannerLockedAssignments:'rx_ch1=641.250 主持人'},extraField:{keep:true}};
  const ended={id:'a',archiveId:'ended-a',deviceId:'rx_ch1',ts:100,firstSeen:100,lastSeen:200,archiveState:'ended',endedAt:200,msg:'RF 弱信号',metric:'rf'};
  return {device,profile,legacy,record,ended,values:{
    daty_devices:JSON.stringify([device]),daty_alerts:JSON.stringify([{...ended,archiveState:'active',endedAt:undefined,lastSeen:150}]),
    daty_db_alerts:JSON.stringify([ended]),
    daty_pending_alerts_v1:JSON.stringify([{...ended,archiveState:'active',endedAt:undefined,lastSeen:150},{...ended,id:'b',archiveId:'ended-b',endedAt:250}]),
    daty_alert_archive_meta_v1:'{"savedAt":250}',daty_alert_thresholds_v1:'{"rfWeakDbm":-65,"batteryLowPercent":25,"afOverloadDbfs":-6}',
    daty_equipment_profiles_v2:JSON.stringify([profile]),daty_equipment_profiles_v1:JSON.stringify([legacy]),
    daty_planning_history_v1:JSON.stringify({project:{id:'fixture-project',name:'测试项目'},currentRecordId:'keep',records:[record],deletedRecordIds:['removed']}),
    daty_planner_constraints_v1:JSON.stringify({plannerBackupCount:'4'}),daty_receiver_group_numbers_v1:'{"ip:192.0.2.10":7}',
    daty_alert_sound_v1:'{"enabled":false}',daty_auto_frequency_v1:'{"enabled":true}',specStartFreq:'640.000',specEndFreq:'690.000',
    daty_fashe_api_url:'https://fixture.invalid:8802',daty_operator_token:'fixture-secret-not-exported',unrelated:'preserve-source'
  }};
}
function restore(values) {
  const source=memory(values),before=Object.fromEntries(source.values);
  const body=migration.parse(JSON.stringify(migration.snapshot(source,'https://old-fixture.invalid:8080')));
  const target=memory();
  const result=migration.apply(target,migration.prepare(target,body),{confirmed:true});
  assert.deepEqual(Object.fromEntries(source.values),before);
  return {source,target,body,result};
}

test('business restore fixture preserves every allowlisted key, integer units and unknown business fields without secrets or source writes',()=>{
  const f=fixture(),h=restore(f.values);
  assert.equal(h.result.written,migration.KEYS.length);
  for(const key of migration.KEYS){
    if(key.startsWith('spec'))assert.equal(h.target.getItem(key),f.values[key]);
    else assert.deepEqual(JSON.parse(h.target.getItem(key)),JSON.parse(f.values[key]));
  }
  assert.equal(h.target.getItem('daty_operator_token'),null);assert.equal(h.target.getItem('daty_fashe_api_url'),null);
  assert.equal(h.source.getItem('daty_operator_token'),'fixture-secret-not-exported');
  const r=runtime(h.target);
  assert.equal(r.c.getCurrentPlanningProject().id,'fixture-project');
  assert.deepEqual(clone(r.c.getCurrentPlanningRecord()),f.record);
  assert.deepEqual(r.read('[...planningHistoryDeletedIds]'),['removed']);
  assert.equal(r.c.getCurrentPlanningRecord().constraints.backupCount,0);
  assert.equal(r.c.DATY_STATE.devices[0].freq,641250);assert.equal(r.c.DATY_STATE.devices[0].planned,641500);
  assert.equal(r.c.DATY_STATE.devices[0]._online,false);assert.equal(r.c.DATY_STATE.devices[0].status,'offline');
  assert.deepEqual(r.requests,[]);
});

test('restored Profile, thresholds, group and preferences use production readers and preserve actual settings',()=>{
  const f=fixture(),h=restore(f.values),r=runtime(h.target);
  const profiles=r.c.DatyEquipmentProfiles.loadCustomEquipmentProfiles({persistMigration:false});
  assert.equal(profiles.length,1);assert.equal(profiles[0].id,f.profile.id);
  assert.equal(profiles[0].minimumChannelSpacingKHz,250);
  assert.deepEqual(clone(profiles[0].provenance),f.profile.provenance);
  assert.deepEqual(clone(r.c.getAlertThresholdSettings()),{rfWeakDbm:-65,batteryLowPercent:25,afOverloadDbfs:-6});
  assert.equal(r.c.getReceiverGroupNumber(f.device),7);
  assert.equal(h.target.getItem('daty_alert_sound_v1'),'{"enabled":false}');
  assert.equal(h.target.getItem('daty_auto_frequency_v1'),'{"enabled":true}');
  assert.deepEqual(r.requests,[]);
});

test('v1-only custom Profile backup is still migratable in isolated target and read-only preview does not create v2',()=>{
  const f=fixture();delete f.values.daty_equipment_profiles_v2;
  const h=restore(f.values),r=runtime(h.target),before=h.source.getItem('daty_equipment_profiles_v1');
  const profiles=r.c.DatyEquipmentProfiles.loadCustomEquipmentProfiles({persistMigration:false});
  assert.equal(profiles.length,1);assert.equal(profiles[0].id,'legacy-fixture');
  assert.equal(profiles[0].provenance.verified,false);assert.equal(h.target.getItem('daty_equipment_profiles_v2'),null);
  r.c.DatyEquipmentProfiles.loadCustomEquipmentProfiles();
  assert.equal(JSON.parse(h.target.getItem('daty_equipment_profiles_v2'))[0].id,'legacy-fixture');
  assert.equal(h.source.getItem('daty_equipment_profiles_v1'),before);assert.equal(h.source.getItem('daty_equipment_profiles_v2'),null);
});

test('restored ended alert cannot be reopened by older active cache or pending records; pending end is retained',async()=>{
  const f=fixture(),h=restore(f.values),r=runtime(h.target);
  r.c.DatyAlertDatabase={records:()=>JSON.parse(h.target.getItem('daty_db_alerts')||'[]'),async flush(captured){
    const records=new Map(JSON.parse(h.target.getItem('daty_db_alerts')||'[]').map(x=>[x.archiveId,x]));
    for(const item of captured)records.set(item.archiveId,r.c._mergeAlertRecord(records.get(item.archiveId),item));
    h.target.setItem('daty_db_alerts',JSON.stringify([...records.values()]));
    return {success:true,changed:captured.length,count:records.size,readBackConfirmed:true,confirmed:captured.map(x=>({id:x.archiveId,snapshot:x}))};
  }};
  r.c.initializeAlertArchiving();assert.equal((await r.c.flushAlertArchive()).success,true);
  const records=JSON.parse(h.target.getItem('daty_db_alerts'));
  assert.equal(records.length,2);assert.equal(records.find(x=>x.archiveId==='ended-a').archiveState,'ended');
  assert.equal(records.find(x=>x.archiveId==='ended-a').endedAt,200);
  assert.equal(records.find(x=>x.archiveId==='ended-b').endedAt,250);
  assert.deepEqual(JSON.parse(h.target.getItem('daty_pending_alerts_v1')),[]);
  assert.equal(h.source.getItem('daty_pending_alerts_v1'),f.values.daty_pending_alerts_v1);
  assert.deepEqual(r.requests,[]);
});

test('restored tombstones reject stale server history using production restore, without any write or command',async()=>{
  const f=fixture(),state=JSON.parse(f.values.daty_planning_history_v1);state.currentRecordId=null;state.records=[];
  f.values.daty_planning_history_v1=JSON.stringify(state);
  const h=restore(f.values),r=runtime(h.target),calls=[];
  r.c.DatyPlatform.request=async (url,init={})=>{
    calls.push({url,method:init.method||'GET'});assert.equal(init.method||'GET','GET');
    return {ok:true,status:200,json:async()=>({success:true,project:{id:'fixture-project',name:'测试项目',data:{
      planningHistory:[{...f.record,id:'removed'},f.record],currentPlanningRecordId:'removed'}}})};
  };
  await r.c.restorePlanningProjectFromServer();
  assert.deepEqual(r.read('HISTORY.map(item=>item.id)'),['keep']);
  assert.deepEqual(r.read('[...planningHistoryDeletedIds]'),['removed']);
  assert.equal(r.c.getCurrentPlanningRecord(),null);assert.equal(calls.length,1);
});

function view() {
  const nodes=new Map(),events=new Map(),storage=memory();
  const get=id=>{if(!nodes.has(id))nodes.set(id,{handlers:{},checked:false,disabled:false,textContent:'',open:false,
    addEventListener(name,fn){this.handlers[name]=fn;},showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();}});return nodes.get(id);};
  migration.mount({document:{getElementById:get},localStorage:storage,location:{protocol:'https:',origin:'https://c1-fixture.invalid'},
    addEventListener(name,fn){events.set(name,fn);},URL:{createObjectURL(){throw new Error('Download must not start for invalidated preview');}}});
  const text=origin=>JSON.stringify({format:migration.FORMAT,version:1,sourceOrigin:origin,values:{specStartFreq:'640'}});
  const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
  const select=read=>get('migrationFile').handlers.change({target:{files:read?[{size:100,text:()=>read.promise}]:[]}});
  return {get,events,storage,text,deferred,select};
}

test('migration page keeps newest file selection when older success or failure arrives late',async()=>{
  for(const failOld of [false,true]){
    const h=view(),old=h.deferred(),recent=h.deferred(),first=h.select(old),second=h.select(recent);
    recent.resolve(h.text('new-source'));await second;
    if(failOld)old.reject(new Error('old-failure'));else old.resolve(h.text('old-source'));
    await first;assert.match(h.get('migrationMessage').textContent,/new-source/);
    assert.equal(h.get('migrationPreview').disabled,false);assert.equal(h.storage.values.size,0);
  }
});

test('clearing file selection and leaving page invalidate pending reads and previews without downloads or writes',async()=>{
  for(const action of ['clear','leave']){
    const h=view(),read=h.deferred(),pending=h.select(read);
    if(action==='clear')await h.select(null);else h.events.get('pagehide')();
    read.resolve(h.text('late-source'));await pending;
    assert.equal(h.get('migrationPreview').disabled,true);assert.doesNotMatch(h.get('migrationMessage').textContent,/late-source/);
    h.get('migrationApply').handlers.click();assert.match(h.get('migrationMessage').textContent,/没有已预览/);
    assert.equal(h.storage.values.size,0);
  }
});

test('new file choice invalidates old confirmation; cancel preserves ability to preview the same file again',async()=>{
  const h=view(),first=h.deferred(),load=h.select(first);first.resolve(h.text('first'));await load;
  h.get('migrationPreview').handlers.click();assert.equal(h.get('migrationConfirm').open,true);
  h.get('migrationCancel').handlers.click();h.get('migrationPreview').handlers.click();assert.equal(h.get('migrationConfirm').open,true);
  const second=h.deferred(),next=h.select(second);
  h.get('migrationApply').handlers.click();assert.match(h.get('migrationMessage').textContent,/没有已预览/);
  assert.equal(h.storage.values.size,0);second.resolve(h.text('second'));await next;
  h.get('migrationPreview').handlers.click();assert.equal(h.get('migrationConfirm').open,true);
});
