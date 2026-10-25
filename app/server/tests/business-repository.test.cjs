'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const scalar=require('../src/platform/database-client.js'),batch=require('../src/platform/database-batch-client.js'),repository=require('../src/platform/business-repository.js');
const {fixture}=require('./business-db-fixture.cjs');
function setup(){
  const h=fixture();h.client=scalar.create(h.ports);h.batch=batch.create({...h.ports,resourceClient:h.client});
  h.scanBatch=batch.create({...h.ports,resourceClient:h.client,journalId:'scan'});let scanSequence=0;
  const global={};global.globalThis=global;global.window=global;
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/frequency.js'),'utf8'),global);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/scan-csv.js'),'utf8'),global);
  h.context={projectId:'fixture-project',preferenceId:'fixture-view'};
  h.repo=repository.create({client:h.client,batchClient:h.batch,scanBatchClient:h.scanBatch,newScanId:()=>'fixture-scan-unique-'+(++scanSequence),readContext:()=>h.context,
    validateProfile:value=>typeof value?.id==='string'?[]:['id required'],parseScanCsv:text=>JSON.parse(JSON.stringify(global.DatyScanCsv.parseScanCsv(text))),
    validateSimulation:value=>{if(value.peakWidthKHz<5||value.peakWidthKHz>1000)throw Error('invalid width');}});
  return h;
}
test('thresholds require real load and only confirm acknowledged database values',async()=>{
  const h=setup(),values={rfWeakDbm:-70,batteryLowPercent:10,afOverloadDbfs:-2};
  assert.equal((await h.repo.saveThresholds(values)).status,'unloaded');await h.repo.load('settings','alert_thresholds');
  assert.equal((await h.repo.saveThresholds(values)).status,'saved');assert.deepEqual(h.repo.cached('settings','alert_thresholds').value,values);
  assert.equal((await h.repo.saveThresholds({...values,rfWeakDbm:-99})).status,'error');assert.equal(h.requests.filter(r=>r.options.method==='POST').length,1);
});
test('battery bars retain their own saved unit and range without fabricating a percentage',async()=>{
  const h=setup();await h.repo.load('settings','alert_thresholds');
  const values={rfWeakDbm:-70,batteryLowPercent:20,afOverloadDbfs:-2,batteryLowBars:1};
  const result=await h.repo.saveThresholds(values);assert.equal(result.status,'saved');assert.deepEqual(result.resource.value,values);
  assert.equal((await h.repo.saveThresholds({...values,batteryLowBars:6})).status,'error');
  assert.equal((await h.repo.saveThresholds({...values,batteryLowBars:1.5})).status,'error');
});

test('real scan retains original text, explicit units, sorted verified points and project',async()=>{
  const h=setup();await h.repo.loadCurrentScan();const text='Frequency (MHz),Level (dBm)\n641.250,-80\n641.000,-90\n641.250,-75';
  const result=await h.repo.saveScan({name:'真实扫描.csv',text});assert.equal(result.status,'saved');
  assert.deepEqual(result.resource.value.points,[{frequencyKHz:641000,levelDbm:-90},{frequencyKHz:641250,levelDbm:-75}]);
  assert.equal(result.resource.value.original.text,text);assert.equal(result.resource.value.sourceKind,'imported_csv');assert.equal(result.resource.value.projectId,h.context.projectId);
  assert.equal(h.repo.cached('scan_current','fixture-project').value.scanId,result.resource.id);assert.equal(posts(h).length,1);assert(posts(h)[0].url.endsWith('/batch'));
  const second=await h.repo.saveScan({name:'第二次扫描.csv',text:text.replace('-90','-92')});assert.equal(second.status,'saved');assert.notEqual(second.resource.id,result.resource.id);
  assert.equal(h.repo.cached('scans',result.resource.id).value.original.text,text,'Previous raw scan remains unchanged');
  assert.equal((await h.repo.saveScan({name:'simulated.csv',text:'frequency,amplitude\n641,0\n642,0'})).status,'error');
});
test('unknown scan batch prevents a new import ID and never replays while only reconciling',async()=>{
  const h=setup();await h.repo.loadCurrentScan();const file={name:'真实.csv',text:'Frequency (MHz),Level (dBm)\n641.000,-90\n641.250,-80'};h.state.dropReply=true;
  assert.equal((await h.repo.saveScan(file)).status,'unknown');assert.equal((await h.repo.saveScan(file)).status,'unknown');assert.equal(posts(h).length,1);
  const receipt=await h.repo.reconcileScan();assert.equal(receipt.status,'reconciled');assert.equal(receipt.resources[0].kind,'scans');assert.equal(posts(h).length,1);
  await h.repo.loadCurrentScan();assert.equal(h.repo.scanId(),receipt.resources[0].id);
});
test('clearing only tombstones the pointer, preserves raw scan versions and cannot resurrect legacy current',async()=>{
  const h=setup(),file={name:'真实.csv',text:'Frequency (MHz),Level (dBm)\n641.000,-90\n641.250,-80'};
  const result=await h.repo.saveScan(file);assert.equal(result.status,'saved');h.put('scans','current:fixture-project',result.resource.value);
  assert.equal((await h.repo.clearCurrentScan()).status,'saved');assert.equal(h.repo.scanId(),null);
  const loaded=await h.repo.loadCurrentScan();assert.equal(loaded.status,'ready');assert.equal(loaded.resource,null);assert.equal(loaded.cleared,true);
  assert.equal(h.repo.cached('scans',result.resource.id).value.original.text,file.text);assert.equal(h.resources.get(JSON.stringify(['scans','current:fixture-project'])).deleted,false);
});
test('planning profile snapshots cannot enter selectable custom profiles or overwrite through import',async()=>{
  const h=setup();h.put('profiles','run-profile:test:0',{id:'run-profile:test:0',source:'planning-snapshot'});h.put('profiles','custom',{id:'custom',source:'custom'});
  await h.repo.listAll('profiles');assert.deepEqual(h.repo.values('profiles'),[{id:'custom',source:'custom'}]);
  assert.equal((await h.repo.saveProfiles([{id:'run-profile:test:0'}])).status,'error');assert.equal((await h.repo.saveProfiles([{id:'something',source:'planning-snapshot'}])).status,'error');assert.equal(posts(h).length,0);
});
test('aliases never carry reported telemetry, controls, group or connection fields',async()=>{
  const h=setup();const result=await h.repo.saveAlias('receiver-A',3,' 主唱 ');assert.equal(result.status,'saved');
  assert.deepEqual(result.resource.value,{receiverId:'receiver-A',channelNumber:3,alias:'主唱'});
  assert.equal((await h.repo.saveAlias('',3,'x')).status,'error');assert.equal((await h.repo.saveAlias('receiver-A','3','x')).status,'error');
});
test('profile imports are one atomic batch, retain metadata and detect view revision changes',async()=>{
  const h=setup();h.put('profiles','existing',{id:'existing',metadata:'old'});await h.repo.listAll('profiles');
  const result=await h.repo.saveProfiles([{id:'existing',metadata:'new'},{id:'new',metadata:'additional'}]);assert.equal(result.status,'saved');assert.equal(result.resources.length,2);
  assert.equal(h.requests.filter(r=>r.options.method==='POST').length,1);assert(h.requests.some(r=>r.url.endsWith('/batch')));
  h.put('profiles','existing',{id:'existing',metadata:'external'},3);
  assert.equal((await h.repo.saveProfiles([{id:'existing',metadata:'stale'}])).status,'conflict');assert.equal(h.requests.filter(r=>r.options.method==='POST').length,1);
});
test('view ranges preserve explicit MHz strings and other same-scope preferences',async()=>{
  const h=setup();h.put('preferences','fixture-view',{activePanel:'spectrum'});await h.repo.load('preferences','fixture-view');
  const result=await h.repo.saveSpectrumRange('640.000','690.000');assert.equal(result.status,'saved');assert.deepEqual(result.resource.value,{activePanel:'spectrum',specStartFreq:'640.000',specEndFreq:'690.000'});
  assert.equal((await h.repo.saveSpectrumRange('690','640')).status,'error');
});
test('mapping explicitly separates live receivers and offline manual registration',()=>{
  assert.equal(Object.keys(repository.MAPPING).length,6);assert.match(repository.MAPPING.devices.manual,/offline/);assert.match(repository.MAPPING.planner.current,/atomic project selection/);assert.match(repository.MAPPING.dashboard.live,/never hydrate online/);
});
test('manual create/update/delete retain configured values, explicit type ID and CAS tombstones',async()=>{
  const h=setup(),id=h.repo.manualId(1),value={id,source:'manual',brand:'DATYaudio',model:'Manual',name:'手工',configuredChannelNumber:2,configuredIp:'192.0.2.111',configuredFrequencyKHz:641250};
  assert.notEqual(id,h.repo.manualId('1'));
  let result=await h.repo.saveManual(value);assert.equal(result.status,'saved');assert.deepEqual(result.resource.value,value);
  assert.equal((await h.repo.saveManual({...value,online:true})).status,'error');
  assert.equal((await h.repo.saveManual({...value,configuredFrequencyKHz:641.25})).status,'error');
  result=await h.repo.saveManual({id},{deleted:true});assert.equal(result.status,'saved');assert.equal(result.resource.deleted,true);assert.equal(result.resource.value,null);
  assert.equal(posts(h).length,2);
});
test('a changed manual record keeps conflicting until explicitly read, never adopts through repeated Save',async()=>{
  const h=setup(),id=h.repo.manualId(2),value={id,source:'manual',brand:'DATYaudio',name:'old',configuredChannelNumber:2,configuredFrequencyKHz:641250};
  h.put('manual_devices',id,value);await h.repo.listAll('manual_devices');h.put('manual_devices',id,{...value,name:'external'},2);
  assert.equal((await h.repo.saveManual({...value,name:'draft'})).status,'conflict');assert.equal((await h.repo.saveManual({...value,name:'draft'})).status,'conflict');assert.equal(posts(h).length,0);
  await h.repo.load('manual_devices',id);assert.equal((await h.repo.saveManual({...value,name:'confirmed draft'})).status,'saved');
});
test('a record created after a complete empty list is a conflict, not an unseen overwrite',async()=>{
  const h=setup();await h.repo.listAll('device_overrides');const id=JSON.stringify(['receiver-A',1]);h.put('device_overrides',id,{receiverId:'receiver-A',channelNumber:1,alias:'other user'});
  assert.equal((await h.repo.saveAlias('receiver-A',1,'stale display draft')).status,'conflict');assert.equal((await h.repo.saveAlias('receiver-A',1,'stale display draft')).status,'conflict');assert.equal(posts(h).length,0);
});
test('simulation options are separate project-scoped documents and page updates retain frequency range',async()=>{
  const h=setup();await h.repo.load('simulation_settings','fixture-project');
  const result=await h.repo.saveSimulation({peakWidthKHz:250});assert.equal(result.status,'saved');assert.equal(result.resource.kind,'simulation_settings');assert.equal(result.resource.value.sourceKind,'simulation');
  assert.equal((await h.repo.saveSimulation({peakWidthKHz:1})).status,'error');
  h.put('preferences','fixture-view',{specStartFreq:'640.000',specEndFreq:'690.000'});await h.repo.load('preferences','fixture-view');
  assert.equal((await h.repo.savePage('channelPage',2)).status,'saved');assert.equal(h.repo.cached('preferences','fixture-view').value.specStartFreq,'640.000');
  assert.equal((await h.repo.savePage('channelPage',0)).status,'error');assert.equal((await h.repo.savePage('unknown',1)).status,'error');
});
const posts=h=>h.requests.filter(item=>item.options.method==='POST');
test('paginated resource hydration rejects high-water changes and keeps earlier complete cache',async()=>{
  const h=setup();let page=0;
  const read=[{id:'before',asOf:1,cursor:null},{id:'new-a',asOf:2,cursor:'next'},{id:'new-b',asOf:3,cursor:null}];
  const client={...h.client,list:async()=>{const item=read[page++];return {status:'ready',epoch:'same-epoch',asOf:item.asOf,cursor:item.cursor,
    resources:[{kind:'profiles',id:item.id,revision:1,deleted:false,value:{id:item.id}}]};}};
  const repo=repository.create({client,readContext:()=>h.context});assert.equal((await repo.listAll('profiles')).status,'ready');
  assert.equal((await repo.listAll('profiles')).code,'SNAPSHOT_CHANGED');assert.equal(repo.cached('profiles','before').value.id,'before');assert.equal(repo.cached('profiles','new-a'),undefined);
});
