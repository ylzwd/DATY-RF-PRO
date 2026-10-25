// Fixed fixtures only: no network, device writes, project writes or physical audio.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),copy=v=>JSON.parse(JSON.stringify(v));
function engine(){
 const values=new Map(),context=vm.createContext({console,performance,setTimeout,clearTimeout,
  localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},
  document:{readyState:'loading',addEventListener(){},getElementById:()=>null}});context.window=context;
 for(const name of ['frequency','equipment-profiles','coordination','planning-ui'])
  vm.runInContext(fs.readFileSync(path.join(root,'src/modules/'+name+'.js'),'utf8'),context);
 return {context,values,c:context.DatyCoordination};
}
const options={rangeStartKHz:640000,rangeEndKHz:650000,stepKHz:25,backupCount:1,imdOrders:[3,5],includeThreeTone:true};
const device=(id,freq,extra={})=>({id,_fasheId:id,receiver_id:'rx-'+id,receiver_ip:'192.0.2.'+id,channel_number:1,
 brand:'DATYaudio',model:'RF PRO',freq,_online:true,status:'online',...extra});
test('recommendations use DATY 250 kHz and validate each single replacement with existing full IMD engine',()=>{
 const h=engine(),devices=[device(1,641000),device(2,641000)],before=copy(devices);
 const result=h.c.recommendBackupFrequencies(devices,options);
 assert.equal(result.entries.length,2);
 for(const row of result.entries){
  assert.equal(row.brand,'DATYaudio');assert.equal(row.backupFrequenciesKHz.length,1);
  for(const frequencyKHz of row.backupFrequenciesKHz){
   assert.equal(frequencyKHz%250,0);assert.notEqual(frequencyKHz,641000);
   const freq=new Map(devices.map(d=>[d.id,d.id===row.deviceId?frequencyKHz:d.freq]));
   assert.equal(h.c.analyzeFrequencyPlan(devices,freq,options).conflicts.length,0);
  }
 }
 assert.deepEqual(devices,before);assert.equal(h.values.size,0);
 assert.deepEqual(copy(h.c.recommendBackupFrequencies(devices,options)),copy(result));
});
test('weak RF, overload and battery telemetry alone are not evidence of frequency interference',()=>{
 const h=engine();const result=h.c.recommendBackupFrequencies([device(1,641000,{rf:-110,afDbfs:0,batt:0})],options);
 assert.equal(result.entries.length,0);assert.equal(result.scanAvailable,false);
});
test('lock, exclusion, fixed occupancy and backupCount=0 are never bypassed',()=>{
 const h=engine(),devices=[device(1,641000),device(2,641000)];
 const constrained={...options,excludedRanges:[{startKHz:640000,endKHz:640750}],knownCarriers:[{frequencyKHz:641500,guardKHz:250}],
  lockedAssignments:[{deviceId:1,frequencyKHz:641000}]};
 const result=h.c.recommendBackupFrequencies(devices,constrained);
 assert.equal(result.entries[0].status,'locked');assert.equal(result.entries[0].backupFrequenciesKHz.length,0);
 for(const f of result.entries[1].backupFrequenciesKHz){assert.ok(f>640750);assert.ok(Math.abs(f-641500)>=250);}
 const off=h.c.recommendBackupFrequencies(devices,{...options,backupCount:0});
 assert.ok(off.entries.every(r=>r.status==='backups-disabled'&&!r.backupFrequenciesKHz.length));
});
test('real scan occupancy recommends only covered below-threshold windows; no gap becomes a safe frequency',()=>{
 const h=engine(),scan=Array.from({length:101},(_,i)=>({frequencyKHz:640000+i*100,levelDbm:i===10?-40:-100}));
 const result=h.c.recommendBackupFrequencies([device(1,641000)],{...options,scanPoints:scan});
 assert.equal(result.scanAvailable,true);assert.equal(result.entries[0].evidence,'scan');
 assert.ok(result.entries[0].backupFrequenciesKHz.length);
 for(const f of result.entries[0].backupFrequenciesKHz)assert.equal(h.c.analyzeFrequencyPlan([device(1,641000)],new Map([[1,f]]),{...options,scanPoints:scan}).conflicts.length,0);
 const dense=h.c.recommendBackupFrequencies([device(1,641000)],{...options,scanPoints:scan.map(p=>({...p,levelDbm:-40}))});
 assert.equal(dense.entries[0].backupFrequenciesKHz.length,0);
});
test('multi-brand identity/profile mismatch and unknown online frequency fail closed',()=>{
 const h=engine();
 assert.throws(()=>h.c.recommendBackupFrequencies([device(1,641000),device(1,642000)],options),/重复/);
 assert.throws(()=>h.c.recommendBackupFrequencies([device(1,641000),device(2,null)],options));
 assert.throws(()=>h.c.recommendBackupFrequencies([device(1,641000,{brand:'Shure',equipmentProfileId:'datyaudio-generic'})],options),/品牌/);
 const rows=h.c.recommendBackupFrequencies([device(1,641000),device(2,641000,{brand:'Shure',model:'ULX-D'})],options).entries;
 assert.deepEqual(copy(rows.map(r=>[r.deviceId,r.brand])),[[1,'DATYaudio'],[2,'Shure']]);
});
test('unrelated channel conflicts do not invalidate a candidate, but candidate-created cross-channel IMD is rejected',()=>{
 const h=engine(),devices=[device(1,641000),device(2,641250),device(3,641500)];
 const result=h.c.recommendBackupFrequencies(devices,options);
 assert.ok(result.entries.some(r=>r.reasonTypes.some(t=>t.startsWith('intermod-'))));
 for(const row of result.entries)for(const f of row.backupFrequenciesKHz){
  const frequencies=new Map(devices.map(d=>[d.id,d.id===row.deviceId?f:d.freq]));
  const conflicts=h.c.analyzeFrequencyPlan(devices,frequencies,options).conflicts;
  assert.ok(conflicts.every(c=>String(c.victimDeviceId)!==String(row.deviceId)&&!(c.sourceDeviceIds||[]).some(id=>String(id)===String(row.deviceId))));
 }
});
function controllerHarness(raw=null){
 const h=engine(),tasks=new Map(),storage=new Map(raw===null?[]:[['daty_auto_frequency_v1',raw]]);
 let key='a',calls=0,id=0,fail=false,paused=false,devices=[device(1,641000),device(2,641000)];
 const controller=h.context.DatyAutoFrequencyFactory.create({
  storage:{getItem:k=>storage.get(k)??null,setItem(k,v){if(fail)throw Error('quota');storage.set(k,v);}},
  readKey:()=>key,readInput:()=>({devices,options,paused}),
  compute:(ds,o)=>{calls++;return h.c.recommendBackupFrequencies(ds,o);},now:()=>1234,
  schedule:fn=>{tasks.set(++id,fn);return id;},cancel:key=>tasks.delete(key)});
 return {controller,storage,tasks,calls:()=>calls,setKey:value=>key=value,fail:()=>fail=true,
  setDevices:value=>devices=value,setPaused:value=>paused=value,
  flush(){for(const [k,fn]of [...tasks]){tasks.delete(k);fn();}}};
}
test('controller coalesces telemetry and preserves cached results unless identity/constraints change',()=>{
 const h=controllerHarness();for(let i=0;i<100;i++)h.controller.requestRefresh();assert.equal(h.tasks.size,1);
 h.flush();assert.equal(h.calls(),1);for(let i=0;i<100;i++)h.controller.requestRefresh();assert.equal(h.tasks.size,0);
 h.setKey('b');h.controller.requestRefresh();assert.equal(h.controller.getState().result,null);
 h.setKey('c');h.controller.requestRefresh();assert.equal(h.tasks.size,1);h.flush();assert.equal(h.calls(),2);
 h.controller.invalidate();h.flush();assert.equal(h.calls(),3);
});
test('fast edit and revert does not leave stale candidates or a permanently checking view',()=>{
 const h=controllerHarness();h.controller.refresh();h.setKey('b');h.controller.requestRefresh();
 h.setKey('a');h.controller.requestRefresh();h.flush();assert.equal(h.controller.getState().phase,'ready');
 assert.ok(h.controller.getState().result.entries.length);assert.equal(h.tasks.size,0);
});
test('disable cancels pending work, clears recommendations, saves and restores; corrupt/write failures remain visible',()=>{
 const h=controllerHarness();h.controller.requestRefresh();h.controller.setEnabled(false);h.flush();assert.equal(h.calls(),0);
 assert.equal(h.controller.getState().result,null);assert.equal(h.storage.get('daty_auto_frequency_v1'),'{"enabled":false}');
 const restored=controllerHarness(h.storage.get('daty_auto_frequency_v1'));restored.controller.requestRefresh();assert.equal(restored.tasks.size,0);
 h.controller.setEnabled(true);h.flush();assert.equal(h.calls(),1);h.fail();h.controller.setEnabled(false);
 assert.equal(h.controller.getState().storageError,true);
 const corrupt=controllerHarness('not-json');assert.equal(corrupt.controller.getState().storageError,true);
 assert.equal(corrupt.storage.get('daty_auto_frequency_v1'),'not-json');
});
test('invalid input, no online devices and deployment-in-progress discard prior candidates',()=>{
 const h=controllerHarness();h.controller.refresh();h.setDevices([device(1,null)]);h.controller.invalidate();h.flush();
 assert.equal(h.controller.getState().phase,'error');assert.equal(h.controller.getState().result,null);
 h.setDevices([]);h.controller.invalidate();h.flush();assert.equal(h.controller.getState().phase,'waiting');
 h.setDevices([device(1,641000)]);h.setPaused(true);h.controller.invalidate();h.flush();assert.equal(h.controller.getState().phase,'paused');
 assert.equal(h.controller.getState().result,null);
});
test('unknown locks and bounded automatic size fail explicitly instead of silently omitting constraints',()=>{
 const h=engine();assert.throws(()=>h.c.recommendBackupFrequencies([device(1,641000)],{...options,lockedAssignments:[{deviceId:2,frequencyKHz:641000}]}),/锁定/);
 assert.throws(()=>h.c.recommendBackupFrequencies(Array.from({length:65},(_,i)=>device(i,641000+i*250)),options),/64/);
});
test('automatic check does not migrate legacy Profile data or overwrite plans/history',()=>{
 const h=engine(),profile=copy(h.context.DatyEquipmentProfiles.resolveEquipmentProfile({brand:'DATYaudio'}));
 h.values.set('daty_equipment_profiles_v1',JSON.stringify([{...profile,id:'legacy-fixture'}]));
 h.values.set('daty_planning_history_v1','{"records":[{"id":"keep"}]}');const before=[...h.values];
 h.c.recommendBackupFrequencies([device(1,641000,{planned:642000}),device(2,641000)],options);
 assert.deepEqual([...h.values],before);
});
test('business backup includes automatic recommendation setting, not recommendation snapshots',()=>{
 const migration=require('../src/platform/browser-data-migration.js');
 const values={'daty_auto_frequency_v1':'{"enabled":false}','daty_recommendations':'secret-stale'};
 const backup=migration.snapshot({getItem:k=>values[k]??null},'https://localhost:8080');
 assert.equal(backup.values.daty_auto_frequency_v1,'{"enabled":false}');assert.equal(backup.values.daty_recommendations,undefined);
});
test('50-channel automatic checking is bounded and never claims an exhaustive search',()=>{
 const h=engine(),devices=Array.from({length:50},(_,i)=>device(i+1,641000+i*250));
 const result=h.c.recommendBackupFrequencies(devices,{...options,rangeEndKHz:690000,stepKHz:250});
 assert.ok(result.entries.length>0);assert.ok(result.checkedCandidates<=8);assert.equal(result.truncated,true);
 assert.ok(result.warnings.some(w=>w.includes('限额')));
});
test('asynchronous host results cannot survive a changed identity, disable or a later request',async()=>{
 const h=engine(),factory=h.context.DatyAutoFrequencyFactory,tasks=[],jobs=[];let key='a';
 const c=factory.create({storage:{getItem:()=>null,setItem(){}},readKey:()=>key,
  readInput:()=>({devices:[device(1,641000)],options}),compute:()=>new Promise((resolve,reject)=>jobs.push({resolve,reject})),
  schedule:fn=>{tasks.push(fn);return tasks.length;},cancel(){},now:()=>5});
 const first=c.refresh();assert.equal(c.getState().phase,'checking');
 c.requestRefresh();assert.equal(tasks.length,0,'Unchanged inputs must not cancel the running worker');
 key='b';c.requestRefresh();const second=c.refresh();
 jobs[0].resolve({entries:[{deviceId:'stale'}],warnings:[]});await first;
 assert.equal(c.getState().result,null);
 jobs[1].resolve({entries:[{deviceId:'current'}],warnings:[]});await second;
 assert.equal(c.getState().result.entries[0].deviceId,'current');
 const third=c.refresh(true);c.setEnabled(false);jobs[2].resolve({entries:[{deviceId:'disabled'}],warnings:[]});await third;
 assert.equal(c.getState().result,null);assert.equal(c.getState().enabled,false);
});
