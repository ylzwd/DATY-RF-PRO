const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/brand-coordination.json'),'utf8'));
const copy=value=>JSON.parse(JSON.stringify(value));

function engine(){
  const values=new Map(),context=vm.createContext({console,localStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value))}});
  context.window=context;
  vm.runInContext('Math.random=()=>{throw new Error("Randomness forbidden in fixed brand coordination tests");};',context);
  for(const name of ['frequency','equipment-profiles','coordination'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules',name+'.js'),'utf8'),context,{filename:name+'.js'});
  return {p:context.DatyEquipmentProfiles,c:context.DatyCoordination,context};
}
const baseOptions={rangeStartKHz:600000,rangeEndKHz:630000,stepKHz:25,backupCount:0,preserveCurrent:false,imdOrders:[3,5],includeThreeTone:true};

test('planner level selects coordination presets even when device reports standard preset',()=>{
  const {p,c}=engine(),ds=[1,2].map(id=>({id,brand:'Shure',model:'QLXD4',equipmentModeId:'standard',ch:`CH${id}`,channel_number:id,group_number:1,group_source:'server-fifo-v1'}));
  for(const [level,spacing,imd,threshold] of [['standard',350,250,-78],['robust',500,350,-85],['more-frequencies',250,150,-72]]){
    const result=c.coordinateFrequencies(ds,{...baseOptions,compatibilityLevel:level,allocationOrder:'receiver-group-ascending'});
    assert.equal(result.search.complete,true);assert.equal(result.assignments[1].frequencyKHz-result.assignments[0].frequencyKHz,spacing);
    assert.equal(result.compatibility.level,level);assert.equal(result.compatibility.label,p.getCompatibilityLabel(level));
    for(const row of result.compatibility.devices)assert.deepEqual([row.channelSpacingKHz,row.intermodSpacingKHz,row.scanThresholdDbm],[spacing,imd,threshold]);
  }
});
test('actual hardware mode and manual limits can only strengthen selected compatibility',()=>{
  const {p,c}=engine(),profile=copy(p.resolveEquipmentProfile({brand:'Shure',model:'QLXD4'}));
  profile.id='test-hardware-mode';profile.modes.push({id:'hardware-narrow',modeType:'transmission',settings:{channelSpacingKHz:700,intermodSpacingKHz:450,scanThresholdDbm:-90,scanGuardKHz:400}});
  p.saveCustomEquipmentProfile(profile);
  const ds=[{id:1,brand:'Shure',equipmentProfileId:profile.id,equipmentModeId:'hardware-narrow'}];
  for(const level of ['standard','robust','more-frequencies']){
    const snapshot=c.describeCompatibility(ds,{compatibilityLevel:level,minChannelSpacingKHz:800,minImdSpacingKHz:500,scanThresholdDbm:-95});
    assert.deepEqual(copy(snapshot.devices[0]),{deviceId:1,profileId:profile.id,deviceModeId:'hardware-narrow',channelSpacingKHz:800,intermodSpacingKHz:500,scanThresholdDbm:-95,scanGuardKHz:400,candidateStepKHz:25});
  }
});
test('all three scan thresholds reject a measured plateau at their exact boundary',()=>{
  const {c}=engine(),ds=[{id:1,brand:'DATYaudio',ch:'CH1'}];
  const plan=(level,dbm)=>c.coordinateFrequencies(ds,{...baseOptions,rangeStartKHz:600000,rangeEndKHz:601000,compatibilityLevel:level,
    scanPoints:Array.from({length:21},(_,i)=>({frequencyKHz:599500+i*100,levelDbm:dbm}))});
  for(const [level,threshold] of [['robust',-75],['standard',-78],['more-frequencies',-72]]){
    assert.equal(plan(level,threshold).assignments.length,0);
    assert.equal(plan(level,threshold-1).assignments.length,1);
  }
  assert.equal(plan('standard',-75).assignments.length,0);assert.equal(plan('more-frequencies',-75).assignments.length,1);
});
test('standard and compact enforce distinct IMD distances without weakening DATY minimum',()=>{
  const {c}=engine(),ds=[600000,601000,602200].map((freq,i)=>({id:i+1,brand:'Shure',model:'QLXD4',freq}));
  const standard=c.analyzeFrequencyPlan(ds,mapOf(ds),{...baseOptions,compatibilityLevel:'standard'});
  const compact=c.analyzeFrequencyPlan(ds,mapOf(ds),{...baseOptions,compatibilityLevel:'more-frequencies'});
  assert.ok(standard.conflicts.some(item=>item.type.startsWith('intermod-')));assert.equal(compact.conflicts.length,0);
  for(const level of ['standard','robust','more-frequencies']){
    const snapshot=c.describeCompatibility([{id:1,brand:'DATYaudio',equipmentModeId:'standard'}],{compatibilityLevel:level,minChannelSpacingKHz:1});
    assert.ok(snapshot.devices[0].channelSpacingKHz>=250);assert.equal(snapshot.devices[0].candidateStepKHz,250);
  }
});
test('unknown levels fail even for an empty plan, and compatibility evidence is a detached snapshot',()=>{
  const {c,p}=engine();for(const level of ['', 'missing','toString'])assert.throws(()=>c.coordinateFrequencies([],{...baseOptions,compatibilityLevel:level}));
  const profile=p.resolveEquipmentProfile({brand:'DATYaudio'}),settings=p.getPlanningCompatibilitySettings(profile,'standard');settings.channelSpacingKHz=1;
  assert.equal(p.getPlanningCompatibilitySettings(profile,'standard').channelSpacingKHz,250);
  const ds=[{id:1,brand:'DATYaudio'}],options={...baseOptions,compatibilityLevel:'robust'},result=c.coordinateFrequencies(ds,options);
  options.compatibilityLevel='standard';assert.equal(result.compatibility.level,'robust');assert.equal(result.compatibility.devices[0].channelSpacingKHz,250);
});
test('final DATY table applies to both built-ins only; other brands keep their original levels',()=>{
  const {p}=engine();
  for(const profile of p.getAllEquipmentProfiles().filter(p=>p.manufacturer==='DATYaudio'))for(const [level,imd,threshold]of [['standard',250,-78],['robust',150,-75],['more-frequencies',0,-72]]){
    assert.deepEqual(copy(p.getPlanningCompatibilitySettings(profile,level)),{channelSpacingKHz:250,intermodSpacingKHz:imd,scanThresholdDbm:threshold});
    assert.equal(p.validateEquipmentProfile(profile).length,0);
  }
  const shure=p.resolveEquipmentProfile({brand:'Shure',model:'QLXD4'});
  assert.deepEqual(copy(p.getPlanningCompatibilitySettings(shure,'robust')),{channelSpacingKHz:500,intermodSpacingKHz:350,scanThresholdDbm:-85});
  assert.equal(p.getPlanningCompatibilitySettings(shure,'more-frequencies').intermodSpacingKHz,150);
});
test('DATY compact has no default IMD guard; explicit 50 kHz and stronger guards remain enforced',()=>{
  const {c,p}=engine(),ds=[640000,640250,640500].map((freq,i)=>({id:i+1,brand:'DATYaudio',ch:`CH${i+1}`,freq,channel_number:i+1,group_number:1,group_source:'server-fifo-v1'}));
  const options={...baseOptions,rangeStartKHz:640000,rangeEndKHz:640500,compatibilityLevel:'more-frequencies',allocationOrder:'receiver-group-ascending'};
  const result=c.coordinateFrequencies(ds,options);
  assert.equal(result.search.complete,true);
  assert.ok(result.compatibility.devices.every(d=>d.intermodSpacingKHz===0));
  const collision=c.analyzeFrequencyPlan(ds,mapOf(ds),options);
  assert.equal(collision.conflicts.length,0);assert.equal(collision.minImdMarginKHz,null);
  // A fixed carrier puts an IMD product 49/50 kHz from a DATY grid point.
  const pair=[ds[0],{...ds[1],freq:640750}],analyze=(carrier,extra={})=>c.analyzeFrequencyPlan(pair,mapOf(pair),{...options,rangeEndKHz:641000,minImdSpacingKHz:50,knownCarriers:[{id:'external',frequencyKHz:carrier,guardKHz:250,intermodSource:true}],...extra});
  assert.equal(analyze(639300).conflicts.filter(issue=>issue.victimDeviceId!==undefined).length,0);
  // The new channels also have to protect the fixed carrier as a receiver:
  // 2*640000-640750=639250, only 50 kHz from its 250 kHz protection window.
  assert.ok(analyze(639300).conflicts.some(issue=>issue.victimCarrierId&&issue.productKHz===639250&&issue.actualSpacingKHz===50&&issue.requiredSpacingKHz===250));
  assert.ok(analyze(639299).conflicts.some(issue=>issue.type.startsWith('intermod-')&&issue.actualSpacingKHz===49));
  assert.ok(analyze(639300,{minImdSpacingKHz:150}).conflicts.some(issue=>issue.type.startsWith('intermod-')));
  const legacy=copy(p.resolveEquipmentProfile(ds[0]));legacy.id='legacy-zero-daty';
  legacy.compatibility['more-frequencies'].intermodSpacingKHz=0;
  legacy.modes.find(m=>m.id==='more-frequencies').settings.intermodSpacingKHz=0;p.saveCustomEquipmentProfile(legacy);
  const old=c.coordinateFrequencies(ds.map(d=>({...d,equipmentProfileId:legacy.id})),options);
  assert.equal(old.search.complete,true);assert.deepEqual(copy(old.assignments.map(a=>a.frequencyKHz)),[640000,640250,640500]);
  assert.equal(old.analysis.minImdMarginKHz,null);assert.equal(old.analysis.totalImdProducts,0);
  for(const level of ['standard','robust'])assert.equal(c.coordinateFrequencies(ds,{...options,compatibilityLevel:level}).search.complete,false);
  assert.equal(c.coordinateFrequencies(ds,{...options,minImdSpacingKHz:150}).search.complete,false);
  const mixed=ds.map(d=>d.id===3?{...d,brand:'Shure',model:'QLXD4'}:d);
  assert.ok(c.analyzeFrequencyPlan(mixed,mapOf(mixed),options).conflicts.some(c=>c.type.startsWith('intermod-')));
  assert.ok(c.analyzeFrequencyPlan(ds,new Map([[1,640000],[2,640000],[3,640500]]),options).conflicts.some(c=>c.type==='channel-spacing'));
  assert.equal(c.coordinateFrequencies(ds,{...options,lockedAssignments:[{deviceId:1,frequencyKHz:640500}]}).search.complete,false);
});
test('zero IMD is accepted only for DATY compact; real hardware and manual limits can re-enable it',()=>{
  const {p,c}=engine(),base=copy(p.resolveEquipmentProfile({brand:'DATYaudio'}));
  base.compatibility['more-frequencies'].intermodSpacingKHz=0;
  base.modes.find(m=>m.id==='more-frequencies').settings.intermodSpacingKHz=0;
  for(const level of ['standard','robust']){const bad=copy(base);bad.compatibility[level].intermodSpacingKHz=0;assert.ok(p.validateEquipmentProfile(bad).length);}
  const bad=copy(base);bad.manufacturer='Shure';assert.ok(p.validateEquipmentProfile(bad).length);
  const negative=copy(base);negative.compatibility['more-frequencies'].intermodSpacingKHz=-1;assert.ok(p.validateEquipmentProfile(negative).length);
  base.id='daty-hardware-floor';base.modes.push({id:'hardware',modeType:'transmission',settings:{channelSpacingKHz:250,intermodSpacingKHz:200,scanThresholdDbm:-80}});p.saveCustomEquipmentProfile(base);
  const d={id:1,brand:'DATYaudio',equipmentProfileId:base.id,equipmentModeId:'hardware'};
  assert.equal(c.describeCompatibility([d],{compatibilityLevel:'more-frequencies'}).devices[0].intermodSpacingKHz,200);
});
const poolDevices=count=>Array.from({length:count},(_,i)=>({id:i+1,brand:'DATYaudio',ch:`CH${i+1}`,channel_number:i+1,group_number:1,group_source:'server-fifo-v1',freq:640000+i*250}));
const poolOptions={...baseOptions,rangeStartKHz:640000,rangeEndKHz:690000,compatibilityLevel:'more-frequencies',allocationOrder:'receiver-group-ascending',minimumFrequencyCount:25};
test('compact supplements 16 real channels with nine jointly valid unbound frequencies without fake assignments',()=>{
  const {c}=engine(),ds=poolDevices(16),before=copy(ds),result=c.coordinateFrequencies(ds,poolOptions),pool=result.frequencyPool;
  assert.equal(result.search.complete,true);assert.equal(pool.targetCount,25);assert.equal(pool.plannedCount,25);assert.equal(pool.actualCount,16);
  assert.equal(pool.reservedFrequenciesKHz.length,9);assert.equal(pool.complete,true);assert.equal(result.assignments.length,16);assert.deepEqual(copy(ds),before);
  const all=result.assignments.map(a=>a.frequencyKHz).concat(pool.reservedFrequenciesKHz).sort((a,b)=>a-b);
  assert.equal(new Set(all).size,25);for(let i=1;i<all.length;i++)assert.ok(all[i]-all[i-1]>=250);
  const fixtures=[...ds,...pool.reservedFrequenciesKHz.map((freq,i)=>({id:'test-only-reserve-'+i,brand:'DATYaudio',freq}))];
  const frequencies=new Map([...result.assignments.map(a=>[a.deviceId,a.frequencyKHz]),...fixtures.slice(16).map(d=>[d.id,d.freq])]);
  assert.equal(c.analyzeFrequencyPlan(fixtures,frequencies,poolOptions).conflicts.length,0);
});
test('compact minimum is not a cap; more than 25 real channels are all planned and other calls keep actual counts',()=>{
  const {c}=engine(),result=c.coordinateFrequencies(poolDevices(32),poolOptions);
  assert.equal(result.assignments.length,32);assert.equal(result.frequencyPool.targetCount,32);assert.equal(result.frequencyPool.plannedCount,32);assert.equal(result.frequencyPool.reservedFrequenciesKHz.length,0);
  for(const level of ['standard','robust']){const r=c.coordinateFrequencies(poolDevices(2),{...poolOptions,minimumFrequencyCount:0,compatibilityLevel:level});assert.equal(r.assignments.length,2);assert.equal(r.frequencyPool,undefined);}
});
test('compact reports actual shortage without expanding range, weakening spacing or removing exclusions',()=>{
  const {c}=engine(),ds=poolDevices(2),options={...poolOptions,rangeEndKHz:641000},r=c.coordinateFrequencies(ds,options);
  assert.equal(r.frequencyPool.plannedCount,5);assert.equal(r.frequencyPool.shortfall,20);assert.equal(r.frequencyPool.complete,false);assert.equal(r.search.complete,false);assert.match(r.errors.join(' '),/缺少 20/);
  const excluded=c.coordinateFrequencies(ds,{...poolOptions,rangeEndKHz:646000,excludedRanges:[{startKHz:642000,endKHz:642250}]});
  assert.equal(excluded.frequencyPool.plannedCount,23);assert.ok(excluded.frequencyPool.reservedFrequenciesKHz.every(f=>f<642000||f>642250));
  const stronger=c.coordinateFrequencies(ds,{...poolOptions,minChannelSpacingKHz:500,lockedAssignments:[{deviceId:1,frequencyKHz:641000}]});
  assert.equal(stronger.assignments[0].frequencyKHz,641000);assert.equal(stronger.frequencyPool.channelSpacingKHz,500);assert.equal(stronger.frequencyPool.plannedCount,25);
  const f=stronger.assignments.map(a=>a.frequencyKHz).concat(stronger.frequencyPool.reservedFrequenciesKHz).sort((a,b)=>a-b);for(let i=1;i<f.length;i++)assert.ok(f[i]-f[i-1]>=500);
});
test('unbound reserves honor scan coverage, occupied measurements and positive IMD guards',()=>{
  const {c}=engine(),ds=poolDevices(2),scan=Array.from({length:65},(_,i)=>({frequencyKHz:639800+i*100,levelDbm:642000<=639800+i*100&&639800+i*100<=642500?-71:-100}));
  const options={...poolOptions,rangeEndKHz:646000,scanPoints:scan},r=c.coordinateFrequencies(ds,options);
  assert.equal(r.frequencyPool.complete,false);assert.ok(r.frequencyPool.reservedFrequenciesKHz.every(f=>f<641875||f>642625));
  const guardedOptions={...poolOptions,minimumFrequencyCount:5,minImdSpacingKHz:150},g=c.coordinateFrequencies(ds,guardedOptions);
  assert.equal(g.frequencyPool.intermodSpacingKHz,150);
  const fixtures=[...ds,...g.frequencyPool.reservedFrequenciesKHz.map((freq,i)=>({id:'reserve-fixture-'+i,brand:'DATYaudio',freq}))];
  assert.equal(c.analyzeFrequencyPlan(fixtures,new Map([...g.assignments.map(a=>[a.deviceId,a.frequencyKHz]),...fixtures.slice(2).map(d=>[d.id,d.freq])]),guardedOptions).conflicts.length,0);
  for(const value of [-1,1.5,257])assert.throws(()=>c.coordinateFrequencies(ds,{...poolOptions,minimumFrequencyCount:value}));
});
function installFixtures(h){
  for(const spec of fixture.profiles){
    const profile=copy(h.p.resolveEquipmentProfile({brand:'Unlisted test brand'}));
    profile.id=spec.id;profile.manufacturer=spec.brand;profile.models=['Fixture only'];
    profile.minimumChannelSpacingKHz=spec.minimumKHz;
    profile.spacingProvenance={kind:'test-fixture',title:'Synthetic regression fixture; not hardware certification',url:'test://brand-coordination',revision:'1',verified:false};
    profile.coordinationGrid={stepKHz:spec.gridKHz,originKHz:0};
    for(const setting of [...Object.values(profile.compatibility),...profile.modes.map(mode=>mode.settings)]){
      setting.channelSpacingKHz=spec.spacingKHz;setting.intermodSpacingKHz=spec.imdKHz;
    }
    h.p.saveCustomEquipmentProfile(profile);
  }
  return h;
}
function devices(frequenciesKHz,indices=frequenciesKHz.map((_,i)=>i)){
  return frequenciesKHz.map((freq,i)=>({id:i+1,ch:`CH${i+1}`,brand:fixture.profiles[indices[i]].brand,model:'Fixture only',equipmentProfileId:fixture.profiles[indices[i]].id,freq}));
}
const mapOf=items=>new Map(items.map(item=>[item.id,item.freq]));

// Independent arithmetic oracle: never invokes the production planner/validator/Profile helpers.
// Guards are fixture constants; all sources and victims participate regardless of brand.
function oracle(items,{orders=[3,5],threeTone=true,minSpacing=0,minImd=0}={}){
  const conflicts=[],products=[];
  for(let a=0;a<items.length;a++)for(let b=a+1;b<items.length;b++){
    const x=items[a],y=items[b],distance=Math.abs(x.freq-y.freq),required=Math.max(x.spacing,y.spacing,x.minimum,y.minimum,minSpacing);
    if(distance<required)conflicts.push({type:'channel-spacing',sources:[x.id,y.id],required,actual:distance});
    for(const order of orders){
      const positive=(order+1)/2,negative=(order-1)/2;
      products.push({order,kind:'two-tone',sources:[x,y],value:positive*x.freq-negative*y.freq});
      products.push({order,kind:'two-tone',sources:[x,y],value:positive*y.freq-negative*x.freq});
    }
  }
  if(threeTone&&orders.includes(3))for(let a=0;a<items.length;a++)for(let b=a+1;b<items.length;b++)for(let c=b+1;c<items.length;c++){
    const sources=[items[a],items[b],items[c]],sum=sources.reduce((total,item)=>total+item.freq,0);
    for(const subtracted of sources)products.push({order:3,kind:'three-tone',sources,value:sum-2*subtracted.freq});
  }
  for(const product of products)for(const victim of items){
    if(product.value<=0||product.sources.includes(victim))continue;
    const required=Math.max(minImd,victim.imd,...product.sources.map(source=>source.imd)),actual=Math.abs(victim.freq-product.value);
    if(actual<required)conflicts.push({type:`intermod-${product.order}`,kind:product.kind,sources:product.sources.map(source=>source.id),victim:victim.id,product:product.value,required,actual});
  }
  return conflicts;
}
function oracleItems(d){return d.map(device=>{const spec=fixture.profiles.find(item=>item.id===device.equipmentProfileId);return {id:device.id,freq:device.freq,minimum:spec.minimumKHz,spacing:spec.spacingKHz,imd:spec.imdKHz};});}
function normalizeConflicts(conflicts){
  return conflicts.map(conflict=>JSON.stringify(conflict)).sort();
}
function productionConflicts(conflicts){return copy(conflicts).map(c=>c.type==='channel-spacing'
  ?{type:c.type,sources:c.sourceDeviceIds,required:c.requiredSpacingKHz,actual:c.actualSpacingKHz}
  :{type:c.type,kind:c.imdKind,sources:c.sourceDeviceIds,victim:c.victimDeviceId,product:c.productKHz,required:c.requiredSpacingKHz,actual:c.actualSpacingKHz});}

test('DATY minimum is 250 kHz and standard/more-frequencies cannot weaken it',()=>{
  const {p}=engine();
  for(const profile of p.getAllEquipmentProfiles().filter(profile=>p.normalizeBrand(profile.manufacturer)==='datyaudio')){
    assert.equal(p.getMinimumChannelSpacingKHz(profile),250);
    assert.equal(p.getCompatibilitySettings(profile,'standard').channelSpacingKHz,250);
    assert.equal(p.getCompatibilitySettings(profile,'more-frequencies').channelSpacingKHz,250);
    assert.equal(p.getCompatibilitySettings(profile,'robust').channelSpacingKHz,250);
    assert.deepEqual(copy(p.getProfileCoordinationGrid(profile,{brand:'DATYaudio'})),{stepKHz:250,originKHz:0});
  }
});

test('DATY protocol 1 kHz resolution is not the 250 kHz coordination lattice',()=>{
  const {p,c}=engine(),profile=p.getAllEquipmentProfiles().find(profile=>profile.id==='datyaudio-fashe-protocol');
  assert.equal(p.getProfileFrequencyGrid(profile).stepKHz,1);
  assert.equal(p.getProfileCoordinationGrid(profile,{brand:'DATYaudio'}).stepKHz,250);
  const d=[{id:1,brand:'DATYaudio',equipmentProfileId:profile.id,freq:641350}];
  const result=c.coordinateFrequencies(d,{...baseOptions,rangeStartKHz:641000,rangeEndKHz:643000,stepKHz:1});
  assert.equal(result.assignments.length,1);assert.equal(result.assignments[0].frequencyKHz%250,0);
  assert.notEqual(result.assignments[0].frequencyKHz,641350);
  assert.ok(c.analyzeFrequencyPlan(d,{1:641350},{...baseOptions,rangeStartKHz:640000,rangeEndKHz:650000,stepKHz:1}).conflicts.length);
});

test('custom DATY hard minimum cannot be lowered by compatibility, mode or declared minimum',()=>{
  const {p}=engine(),base=p.resolveEquipmentProfile({brand:'DATYaudio'});
  for(const mutate of [x=>x.minimumChannelSpacingKHz=249,x=>x.minimumChannelSpacingKHz=0,x=>x.minimumChannelSpacingKHz='250',
    x=>x.compatibility.standard.channelSpacingKHz=249,x=>x.modes.find(mode=>mode.id==='standard').settings.channelSpacingKHz=249]){
    const profile=copy(base);profile.id='invalid-daty-floor';mutate(profile);
    assert.ok(p.validateEquipmentProfile(profile).length);assert.throws(()=>p.saveCustomEquipmentProfile(profile));
  }
});

test('DATY custom coordination grid accepts stricter lattice but rejects shifted/finer off-lattice candidates',()=>{
  const {p,c}=engine(),base=p.resolveEquipmentProfile({brand:'DATYaudio'});
  for(const coordinationGrid of [{stepKHz:200,originKHz:0},{stepKHz:250,originKHz:125},{stepKHz:500,originKHz:1}]){
    const profile={...copy(base),id:'invalid-coordination-grid',coordinationGrid};
    assert.ok(p.validateEquipmentProfile(profile).length);assert.throws(()=>p.saveCustomEquipmentProfile(profile));
  }
  const strict={...copy(base),id:'strict-daty-grid',coordinationGrid:{stepKHz:500,originKHz:250}};p.saveCustomEquipmentProfile(strict);
  const result=c.coordinateFrequencies([{id:1,brand:'DATYaudio',equipmentProfileId:strict.id,freq:600000}],baseOptions);
  assert.equal(result.assignments.length,1);assert.equal((result.assignments[0].frequencyKHz-250)%500,0);
});

test('wildcard Profile and alias brands cannot bypass DATY minimum or coordination lattice',()=>{
  const {p,c}=engine(),wildcard=copy(p.resolveEquipmentProfile({brand:'Unlisted test brand'}));
  wildcard.id='wildcard-weak-fixture';wildcard.coordinationGrid={stepKHz:1,originKHz:0};wildcard.minimumChannelSpacingKHz=1;
  for(const setting of [...Object.values(wildcard.compatibility),...wildcard.modes.map(mode=>mode.settings)])setting.channelSpacingKHz=1;
  p.saveCustomEquipmentProfile(wildcard);
  for(const brand of ['DATYaudio','DATY','daty-audio']){
    const d=[{id:1,brand,equipmentProfileId:wildcard.id,freq:600025},{id:2,brand,equipmentProfileId:wildcard.id,freq:600050}];
    assert.equal(p.getMinimumChannelSpacingKHz(wildcard,d[0]),250);
    assert.deepEqual(copy(p.getProfileCoordinationGrid(wildcard,d[0])),{stepKHz:250,originKHz:0});
    const result=c.coordinateFrequencies(d,{...baseOptions,stepKHz:1,minChannelSpacingKHz:1});
    assert.equal(result.assignments.length,2);assert.ok(result.assignments.every(item=>item.frequencyKHz%250===0));
    assert.ok(Math.abs(result.assignments[0].frequencyKHz-result.assignments[1].frequencyKHz)>=250);
  }
});

test('custom other-brand compatibility and mode cannot weaken declared minimum',()=>{
  const {p}=installFixtures(engine()),base=p.resolveEquipmentProfile({brand:'Shure',equipmentProfileId:'fixture-shure'});
  for(const mutate of [x=>x.compatibility.standard.channelSpacingKHz=575,x=>x.modes[0].settings.channelSpacingKHz=575]){
    const profile=copy(base);profile.id='invalid-shure-test-floor';mutate(profile);
    assert.ok(p.validateEquipmentProfile(profile).length);assert.throws(()=>p.saveCustomEquipmentProfile(profile));
  }
});

test('explicit manufacturer mismatch cannot assign another brand Profile',()=>{
  const {p,c}=installFixtures(engine());
  assert.throws(()=>p.resolveEquipmentProfile({brand:'DATYaudio',equipmentProfileId:'fixture-shure'}));
  assert.throws(()=>c.coordinateFrequencies([{id:1,brand:'DATYaudio',equipmentProfileId:'fixture-ams',freq:600000}],baseOptions));
  assert.equal(p.resolveEquipmentProfile({brand:'DATY',equipmentProfileId:'fixture-daty'}).manufacturer,'DATYaudio');
});

for(const item of fixture.pairCases)test(`fixed mixed-brand pair spacing: ${item.id}`,()=>{
  const {c}=installFixtures(engine()),d=devices(item.frequenciesKHz,item.profiles),analysis=c.analyzeFrequencyPlan(d,mapOf(d),baseOptions);
  const pair=analysis.conflicts.find(conflict=>conflict.type==='channel-spacing');
  assert.equal(!!pair,item.conflict);
  if(pair){assert.equal(pair.requiredSpacingKHz,item.requiredKHz);assert.equal(pair.actualSpacingKHz,Math.abs(d[0].freq-d[1].freq));}
  assert.deepEqual(normalizeConflicts(productionConflicts(analysis.conflicts)),normalizeConflicts(oracle(oracleItems(d))));
});

for(const item of fixture.imdCases)test(`fixed mixed-brand IMD arithmetic: ${item.id}`,()=>{
  const {c}=installFixtures(engine()),d=devices(item.frequenciesKHz),o={...baseOptions,imdOrders:item.orders,includeThreeTone:item.threeTone};
  const analysis=c.analyzeFrequencyPlan(d,mapOf(d),o),reference=oracle(oracleItems(d),{orders:item.orders,threeTone:item.threeTone});
  assert.deepEqual(normalizeConflicts(productionConflicts(analysis.conflicts)),normalizeConflicts(reference));
  if(item.expectedConflicts!==undefined)assert.equal(analysis.conflicts.length,item.expectedConflicts);
  else{
    const hit=analysis.conflicts.find(conflict=>conflict.productKHz===item.productKHz&&conflict.victimDeviceId===item.victimId&&conflict.imdKind===item.kind&&conflict.type===`intermod-${item.order}`);
    assert.ok(hit);assert.deepEqual(copy(hit.sourceDeviceIds),item.sourceIds);assert.equal(hit.actualSpacingKHz,item.expectedSpacingKHz);assert.equal(hit.requiredSpacingKHz,175);
    assert.ok(new Set([...hit.sourceDeviceIds,hit.victimDeviceId].map(id=>d.find(device=>device.id===id).brand)).size>1);
  }
});

test('a brand Profile IMD policy adds fifth-order and three-tone checks despite weaker global settings',()=>{
  const {p,c}=installFixtures(engine()),d=devices([600000,601000,603000]);
  const requested={...baseOptions,imdOrders:[3],includeThreeTone:false};
  assert.equal(c.analyzeFrequencyPlan(d,mapOf(d),requested).conflicts.length,0);
  const profile=copy(p.resolveEquipmentProfile(d[2]));profile.imdPolicy={orders:[3,5],includeThreeTone:true};p.saveCustomEquipmentProfile(profile);
  const analysis=c.analyzeFrequencyPlan(d,mapOf(d),requested);
  assert.deepEqual(normalizeConflicts(productionConflicts(analysis.conflicts)),normalizeConflicts(oracle(oracleItems(d))));
  assert.ok(analysis.conflicts.some(hit=>hit.type==='intermod-5'&&hit.victimDeviceId===3&&hit.productKHz===603000));
  const result=c.coordinateFrequencies(d,requested);
  assert.equal(result.assignments.length,3);assert.deepEqual(copy(result.options.imdOrders),[3,5]);assert.equal(result.options.includeThreeTone,true);
  const assigned=result.assignments.map(assignment=>({...d.find(device=>device.id===assignment.deviceId),freq:assignment.frequencyKHz}));
  assert.deepEqual(oracle(oracleItems(assigned)),[]);
  assert.deepEqual(requested.imdOrders,[3]);assert.equal(requested.includeThreeTone,false,'caller options must not be mutated');
});

test('required cross-brand three-tone policy is enforced when the global checkbox is off',()=>{
  const {p,c}=installFixtures(engine()),d=devices([600000,601000,604000,605000]);
  const options={...baseOptions,imdOrders:[3],includeThreeTone:false};
  assert.equal(c.analyzeFrequencyPlan(d,mapOf(d),options).conflicts.length,0);
  const profile=copy(p.resolveEquipmentProfile(d[2]));profile.imdPolicy={orders:[3,5],includeThreeTone:true};p.saveCustomEquipmentProfile(profile);
  const analysis=c.analyzeFrequencyPlan(d,mapOf(d),options);
  assert.deepEqual(normalizeConflicts(productionConflicts(analysis.conflicts)),normalizeConflicts(oracle(oracleItems(d))));
  assert.ok(analysis.conflicts.some(hit=>hit.imdKind==='three-tone'&&hit.productKHz===605000&&hit.victimDeviceId===4));
});

test('an optional weaker Profile IMD policy cannot remove requested global checks',()=>{
  const {p,c}=installFixtures(engine()),d=devices([600000,601000,604000,605000]);
  const profile=copy(p.resolveEquipmentProfile(d[2]));profile.imdPolicy={orders:[3],includeThreeTone:false};p.saveCustomEquipmentProfile(profile);
  const analysis=c.analyzeFrequencyPlan(d,mapOf(d),baseOptions);
  assert.deepEqual(normalizeConflicts(productionConflicts(analysis.conflicts)),normalizeConflicts(oracle(oracleItems(d))));
  const result=c.coordinateFrequencies(d,baseOptions);assert.deepEqual(copy(result.options.imdOrders),[3,5]);assert.equal(result.options.includeThreeTone,true);
});

test('fifth-only orders gain third order whenever a Profile requires three-tone IMD',()=>{
  const {p,c}=installFixtures(engine()),d=devices([600000,601000,604000,605000]);
  const profile=copy(p.resolveEquipmentProfile(d[2]));profile.imdPolicy={orders:[5],includeThreeTone:true};p.saveCustomEquipmentProfile(profile);
  const requested={...baseOptions,imdOrders:[5],includeThreeTone:false};
  const analysis=c.analyzeFrequencyPlan(d,mapOf(d),requested);
  assert.deepEqual(normalizeConflicts(productionConflicts(analysis.conflicts)),normalizeConflicts(oracle(oracleItems(d))));
  assert.ok(analysis.conflicts.some(hit=>hit.type==='intermod-3'&&hit.imdKind==='three-tone'&&hit.productKHz===605000&&hit.victimDeviceId===4));
  const result=c.coordinateFrequencies(d,requested);assert.deepEqual(copy(result.options.imdOrders),[3,5]);assert.equal(result.options.includeThreeTone,true);
  assert.deepEqual(requested.imdOrders,[5]);assert.equal(requested.includeThreeTone,false);
});

test('malformed optional Profile IMD policies fail validation and atomic import',()=>{
  const {p}=installFixtures(engine()),base=copy(p.resolveEquipmentProfile({brand:'Shure',equipmentProfileId:'fixture-shure'}));
  for(const imdPolicy of [null,[],{}, {orders:[],includeThreeTone:true},{orders:[3,7],includeThreeTone:true},
    {orders:['3'],includeThreeTone:true},{orders:[3,5],includeThreeTone:'true'},{orders:[3,5]}]){
    const profile={...copy(base),id:'invalid-policy',imdPolicy};assert.ok(p.validateEquipmentProfile(profile).length);assert.throws(()=>p.saveCustomEquipmentProfile(profile));
  }
});

test('fixed occupancy guard cannot weaken DATY spacing: off-lattice carrier isolates direct-distance check',()=>{
  const {c}=engine(),d=[{id:1,brand:'DATYaudio',freq:600000}];
  for(const {carrierKHz,guardKHz,minSpacing,required,conflict}of [
    {carrierKHz:600125,guardKHz:1,required:250,conflict:true},
    {carrierKHz:600250,guardKHz:1,required:250,conflict:false},
    {carrierKHz:600375,guardKHz:500,required:500,conflict:true},
    {carrierKHz:600375,guardKHz:1,minSpacing:400,required:400,conflict:true}
  ]){
    // The receiver is exactly on the 250 kHz lattice; a fixed external carrier need not be.
    const options={...baseOptions,...(minSpacing?{minChannelSpacingKHz:minSpacing}:{}),knownCarriers:[{frequencyKHz:carrierKHz,guardKHz,intermodSource:false}]};
    const analysis=c.analyzeFrequencyPlan(d,mapOf(d),options),hit=analysis.conflicts.find(issue=>issue.type==='known-carrier');
    const independentRequired=Math.max(250,guardKHz,minSpacing||0),distance=Math.abs(carrierKHz-d[0].freq);
    assert.equal(independentRequired,required);assert.equal(distance<independentRequired,conflict);assert.equal(!!hit,conflict);
    assert.equal(analysis.conflicts.some(issue=>issue.type==='coordination-grid'),false);
    if(hit){assert.equal(hit.requiredSpacingKHz,required);assert.equal(hit.actualSpacingKHz,distance);}
  }
});

test('fixed-carrier minimum applies equally to DATY locks, primary planning and backups',()=>{
  const {c}=engine(),d=[1,2].map(id=>({id,brand:'DATYaudio',freq:600000}));
  const options={...baseOptions,backupCount:1,knownCarriers:[{id:'external-off-lattice',frequencyKHz:600125,guardKHz:1,intermodSource:false}]};
  const locked=c.coordinateFrequencies(d,{...options,lockedAssignments:[{deviceId:1,frequencyKHz:600000}]});
  assert.equal(locked.assignments.length,0);assert.ok(locked.errors.length);
  const result=c.coordinateFrequencies(d,options);assert.equal(result.assignments.length,2);assert.equal(result.analysis.conflicts.length,0);
  for(const assignment of result.assignments){
    assert.equal(assignment.backupFrequenciesKHz.length,1);
    for(const value of [assignment.frequencyKHz,...assignment.backupFrequenciesKHz]){
      assert.equal(value%250,0);assert.ok(Math.abs(value-600125)>=250);
    }
  }
});

test('250 kHz DATY lattice does not make equal-spaced triples IMD-safe',()=>{
  const {c}=engine(),d=[641000,641250,641500].map((freq,i)=>({id:i+1,brand:'DATYaudio',freq}));
  const options={...baseOptions,rangeStartKHz:641000,rangeEndKHz:649000},analysis=c.analyzeFrequencyPlan(d,mapOf(d),options);
  assert.equal(analysis.conflicts.some(conflict=>conflict.type==='channel-spacing'),false);
  assert.ok(analysis.conflicts.some(conflict=>conflict.type==='intermod-3'&&conflict.actualSpacingKHz===0));
  const result=c.coordinateFrequencies(d,options);assert.equal(result.assignments.length,3);assert.equal(result.analysis.conflicts.length,0);
  assert.ok(result.assignments.every(assignment=>assignment.frequencyKHz%250===0));
  assert.notDeepEqual(copy(result.assignments.map(assignment=>assignment.frequencyKHz)),[641000,641250,641500]);
});

test('DATY grid remains hard under weak user overrides and finer planning steps',()=>{
  const {c}=engine(),d=[1,2,3].map(id=>({id,brand:'DATYaudio',freq:0}));
  for(const stepKHz of [1,25,100]){
    const result=c.coordinateFrequencies(d,{...baseOptions,stepKHz,minChannelSpacingKHz:1,minImdSpacingKHz:1});
    assert.equal(result.assignments.length,3);assert.ok(result.assignments.every(item=>item.frequencyKHz%250===0&&item.frequencyKHz%stepKHz===0));
    const freqs=result.assignments.map(item=>item.frequencyKHz);for(let i=0;i<freqs.length;i++)for(let j=i+1;j<freqs.length;j++)assert.ok(Math.abs(freqs[i]-freqs[j])>=250);
    assert.equal(result.analysis.conflicts.length,0);
  }
});

function exhaustiveMaximum(d,candidates){
  let maximum=0;
  function visit(index,chosen){
    maximum=Math.max(maximum,chosen.length);if(index===d.length)return;
    const spec=fixture.profiles.find(profile=>profile.id===d[index].equipmentProfileId);
    for(const freq of candidates){
      if(freq%spec.gridKHz)continue;
      const next=[...chosen,{id:d[index].id,freq,minimum:spec.minimumKHz,spacing:spec.spacingKHz,imd:spec.imdKHz}];
      if(!oracle(next).length)visit(index+1,next);
    }
    visit(index+1,chosen);
  }
  visit(0,[]);return maximum;
}
for(const item of fixture.solverCases)test(`mixed-brand solver matches independent exhaustive optimum: ${item.id}`,()=>{
  const {c}=installFixtures(engine()),d=devices([0,0,0]),options={...baseOptions,...item},candidates=[];
  for(let freq=item.rangeStartKHz;freq<=item.rangeEndKHz;freq+=item.stepKHz)candidates.push(freq);
  assert.equal(exhaustiveMaximum(d,candidates),item.expectedMaximum);
  const result=c.coordinateFrequencies(d,options);assert.equal(result.assignments.length,item.expectedMaximum);
  const assigned=result.assignments.map(assignment=>({...d.find(device=>device.id===assignment.deviceId),freq:assignment.frequencyKHz}));
  assert.deepEqual(oracle(oracleItems(assigned)),[]);assert.deepEqual(copy(c.coordinateFrequencies(d,options)),copy(result));
});

test('mixed-brand primary, locks and every backup satisfy max spacing, full IMD and per-brand grid',()=>{
  const {c}=installFixtures(engine()),d=devices([0,0,0,0]),options={...baseOptions,backupCount:1,minChannelSpacingKHz:450,minImdSpacingKHz:200,lockedAssignments:[{deviceId:1,frequencyKHz:601000}]};
  const result=c.coordinateFrequencies(d,options);assert.equal(result.assignments.length,4);assert.equal(result.analysis.conflicts.length,0);
  assert.equal(result.assignments.find(item=>item.deviceId===1).frequencyKHz,601000);
  const combined=[];
  for(const assignment of result.assignments){
    const device=d.find(item=>item.id===assignment.deviceId),spec=fixture.profiles.find(item=>item.id===device.equipmentProfileId);
    assert.equal(assignment.profileId,spec.id);
    assert.equal(assignment.brand,device.brand);assert.equal(assignment.brandKey,spec.brand.toLowerCase());
    assert.equal(assignment.minimumChannelSpacingKHz,spec.minimumKHz);
    assert.equal(assignment.channelSpacingKHz,Math.max(spec.spacingKHz,450));
    assert.equal(assignment.intermodSpacingKHz,200);
    assert.equal(assignment.backupFrequenciesKHz.length,assignment.deviceId===1?0:1);
    for(const [index,freq]of [assignment.frequencyKHz,...assignment.backupFrequenciesKHz].entries()){
      assert.equal(freq%spec.gridKHz,0);combined.push({...device,id:`${device.id}:${index}`,freq});
    }
  }
  assert.deepEqual(oracle(oracleItems(combined),{minSpacing:450,minImd:200}),[]);
});

test('hard locks fail closed for off-lattice DATY and cross-brand spacing or IMD conflicts',()=>{
  const {c}=installFixtures(engine());
  const cases=[
    {d:devices([0],[0]),locks:[641350]},
    {d:devices([0,0],[0,2]),locks:[641000,641575]},
    {d:devices([0,0,0]),locks:[641000,642000,643000]},
    {d:devices([0,0,0]),locks:[641000,642000,644000]},
    {d:devices([0,0,0,0]),locks:[640000,641000,644000,645000]}
  ];
  for(const {d,locks}of cases){
    const result=c.coordinateFrequencies(d,{...baseOptions,rangeStartKHz:640000,rangeEndKHz:650000,lockedAssignments:locks.map((frequencyKHz,i)=>({deviceId:i+1,frequencyKHz}))});
    assert.equal(result.assignments.length,0);assert.ok(result.errors.length);
  }
});
