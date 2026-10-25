// Pure fixed fixtures; no network, database or receiver control.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const copy=v=>JSON.parse(JSON.stringify(v));
function engine(){
  const store=new Map(),c=vm.createContext({console,localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)}});c.window=c;
  for(const name of ['frequency','equipment-profiles','coordination'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules',name+'.js'),'utf8'),c);
  return {c:c.DatyCoordination,p:c.DatyEquipmentProfiles};
}
const options={rangeStartKHz:640000,rangeEndKHz:690000,stepKHz:25,backupCount:0,allocationOrder:'receiver-group-ascending'};
const device=(id,group,ch,freq=680000)=>({id,group_source:'server-fifo-v1',group_number:group,ch:`CH${ch}`,channel_number:ch,brand:'DATYaudio',model:'RF PRO',equipmentProfileId:'datyaudio-generic',freq});
const frequencies=(result,ids)=>ids.map(id=>result.assignments.find(a=>a.deviceId===id)?.frequencyKHz);
function complete(result){assert.equal(result.search.complete,true,JSON.stringify(result.errors));assert.equal(result.analysis.conflicts.length,0);}
function ascending(values){for(let i=1;i<values.length;i++)assert.ok(values[i]>values[i-1],JSON.stringify(values));}
// Independent DATY arithmetic oracle. Does not call production analyzers.
function valid(values,orders=[3],threeTone=true){
  if(values.some(f=>f%250!==0))return false;
  for(let i=0;i<values.length;i++)for(let j=i+1;j<values.length;j++){
    const a=values[i],b=values[j];if(Math.abs(a-b)<250)return false;
    for(const order of orders)for(const product of [((order+1)*a-(order-1)*b)/2,((order+1)*b-(order-1)*a)/2])
      for(let k=0;k<values.length;k++)if(k!==i&&k!==j&&Math.abs(product-values[k])<250)return false;
    if(threeTone)for(let k=j+1;k<values.length;k++)for(const product of [a+b-values[k],a+values[k]-b,b+values[k]-a])
      for(let v=0;v<values.length;v++)if(v!==i&&v!==j&&v!==k&&Math.abs(product-values[v])<250)return false;
  }return true;
}
for(const solver of ['global','greedy'])test(`${solver}: actual frequencies follow numeric GROUP/CH despite reverse original frequencies`,()=>{
  const {c}=engine(),d=[device('g10c1',10,1,640000),device('g2c10','2',10,645000),device('g1c1',1,1,685000),device('g2c2',2,2,670000)];
  const before=copy(d),ids=['g1c1','g2c2','g2c10','g10c1'];
  const result=c.coordinateFrequencies(d,{...options,solver});complete(result);
  assert.deepEqual(frequencies(result,ids),[640000,640250,640750,641750]);
  assert.ok(valid(frequencies(result,ids)));assert.deepEqual(d,before);
  assert.deepEqual(copy(result.allocationOrder.deviceIds),ids);
  assert.equal(result.retention.enabled,false);assert.equal(result.retention.protectedDeviceIds.length,0);
  assert.ok(result.assignments.every(a=>a.groupNumber>0&&/GROUP/.test(a.changeReason)));
  assert.deepEqual(copy(c.coordinateFrequencies(d.slice().reverse(),{...options,solver})).assignments.map(a=>[a.deviceId,a.frequencyKHz]).sort(),copy(result.assignments).map(a=>[a.deviceId,a.frequencyKHz]).sort());
});
test('trusted GROUP and CH parsing rejects guesses, booleans and unsafe numbers',()=>{
  const {c}=engine();
  for(const group of [true,0,-1,1.5,'GROUP2','2.0','',null,Number.MAX_SAFE_INTEGER+1])assert.equal(c.getDevicePlanningPosition(device('id',group,1)).groupNumber,null);
  assert.equal(c.getDevicePlanningPosition({...device('id',1,1),group_source:undefined,group:1}).groupNumber,null);
  assert.deepEqual(copy(c.getDevicePlanningPosition({group_source:'server-fifo-v1',group_number:'10',ch:'Group2/CH12'})),{groupNumber:10,channelNumber:12});
  assert.equal(c.getDevicePlanningPosition({ch:'Group20'}).channelNumber,null);
  assert.equal(c.getDevicePlanningPosition({_fasheId:'rx_ch10',ch:'Group20'}).channelNumber,10);
});
test('unknown groups plan after known groups; equal GROUP/CH retains stable identities',()=>{
  const {c}=engine(),d=[{...device('unknown',99,1),group_source:undefined},device('same-b',2,2),device('same-a',2,2),device('known',1,1)];
  const result=c.coordinateFrequencies(d,options);complete(result);
  ascending(frequencies(result,['known','same-b','same-a','unknown']));
  assert.deepEqual(copy(result.allocationOrder.unknownGroupDeviceIds),['unknown']);
  assert.equal(result.assignments.find(a=>a.deviceId==='unknown').groupNumber,null);
  assert.match(result.warnings.join(' '),/未知编组/);
});
test('no authoritative groups retains legacy current-frequency protection, without fabricating groups',()=>{
  const {c}=engine(),d=[{...device(1,1,1,641000),group_source:undefined},{...device(2,2,2,645000),group_source:undefined}];
  const result=c.coordinateFrequencies(d,options);complete(result);
  assert.deepEqual(frequencies(result,[1,2]),[641000,645000]);assert.equal(result.allocationOrder.enabled,false);assert.equal(result.retention.enabled,true);
  assert.match(result.warnings.join(' '),/没有服务器确认的 GROUP/);
  assert.throws(()=>c.coordinateFrequencies(d,{...options,allocationOrder:'alphabetical'}));
});
test('explicit locks are fixed anchors on both sides of the ascending plan',()=>{
  const {c}=engine(),d=[device('high',10,1),device('low',1,1),device('middle',2,1)];
  const result=c.coordinateFrequencies(d,{...options,lockedAssignments:[{deviceId:'middle',frequencyKHz:642000}]});complete(result);
  const f=frequencies(result,['low','middle','high']);ascending(f);assert.equal(f[1],642000);assert.ok(valid(f));
  assert.equal(result.assignments.find(a=>a.deviceId==='middle').locked,true);
});
test('inverted locks fail explicitly; a locked low-group upper edge cannot silently force inversion',()=>{
  const {c}=engine(),d=[device('low',1,1),device('high',10,1)];
  const inverted=c.coordinateFrequencies(d,{...options,lockedAssignments:[{deviceId:'low',frequencyKHz:645000},{deviceId:'high',frequencyKHz:641000}]});
  assert.equal(inverted.search.complete,false);assert.match(inverted.errors.join(' '),/锁定频率与 GROUP/);
  const edge=c.coordinateFrequencies(d,{...options,lockedAssignments:[{deviceId:'low',frequencyKHz:690000}]});
  assert.equal(edge.search.complete,false);assert.deepEqual(frequencies(edge,['low','high']),[690000,undefined]);assert.ok(edge.errors.length);
});
function band(h,id,range,grid={stepKHz:250,originKHz:0}){
  const p=copy(h.p.resolveEquipmentProfile(device('id',1,1)));p.id=id;p.tuningRangeKHz=range;p.bands=[{id:'fixture',label:'Synthetic test only',tuningRangeKHz:range,verified:false,region:'TEST'}];p.defaultBandId='fixture';p.coordinationGrid=grid;h.p.saveCustomEquipmentProfile(p);return id;
}
test('heterogeneous bands and offset grids remain binding; inverse bands return a safe partial plan',()=>{
  const h=engine(),lo=band(h,'lo',[640000,642000],{stepKHz:500,originKHz:250}),hi=band(h,'hi',[650000,652000]);
  const d=[{...device('low',1,1),equipmentProfileId:lo},{...device('high',10,1),equipmentProfileId:hi}];
  const result=h.c.coordinateFrequencies(d,options);complete(result);assert.deepEqual(frequencies(result,['low','high']),[640250,650000]);
  d[0].group_number=10;d[1].group_number=1;
  const inverse=h.c.coordinateFrequencies(d,options);assert.equal(inverse.search.complete,false);assert.equal(inverse.assignments.length,1);assert.equal(inverse.analysis.conflicts.length,0);assert.match(inverse.warnings.join(' '),/不会倒序/);
});
test('real scan, exclusions, fixed carriers and third/fifth-order IMD all constrain ascending candidates and backups',()=>{
  const {c}=engine(),d=[device(4,10,1),device(2,2,1),device(1,1,1),device(3,2,2)];
  const scanPoints=Array.from({length:511},(_,i)=>({frequencyKHz:639500+i*100,levelDbm:i>=25&&i<=35?-40:-110}));
  const input={...options,backupCount:1,imdOrders:[3,5],scanPoints,excludedRanges:[{startKHz:640000,endKHz:640500}],knownCarriers:[{frequencyKHz:650000,guardKHz:500,intermodSource:false}]};
  const result=c.coordinateFrequencies(d,input);complete(result);ascending(frequencies(result,[1,2,3,4]));
  const all=copy(result.assignments).flatMap(a=>[a.frequencyKHz,...a.backupFrequenciesKHz]);assert.ok(valid(all,[3,5]));
  for(const f of all){assert.ok(f>640500&&f>=640000&&f<=690000);assert.ok(Math.abs(f-650000)>=500);
    assert.ok(scanPoints.filter((p,i)=>p.frequencyKHz<=f+125&&(scanPoints[i+1]?.frequencyKHz??Infinity)>=f-125).every(p=>p.levelDbm<-78));}
});
test('small-grid exhaustive independent oracle matches the maximum ordered safe subset',()=>{
  const {c}=engine(),d=[device(3,10,1),device(1,1,1),device(2,2,1),device(4,11,1)];
  const candidates=[640000,640250,640500,640750,641000];let best=0;
  for(let bits=0;bits<1<<candidates.length;bits++){
    const values=candidates.filter((_,i)=>bits&(1<<i));if(values.length<=d.length&&valid(values))best=Math.max(best,values.length);
  }
  const r=c.coordinateFrequencies(d,{...options,rangeEndKHz:641000});assert.equal(r.assignments.length,best);
  const chosen=[1,2,3,4].filter(id=>r.assignments.some(a=>a.deviceId===id));ascending(frequencies(r,chosen));assert.ok(valid(frequencies(r,chosen)));
  const limited=c.coordinateFrequencies(d,{...options,maxSearchNodes:1});assert.equal(limited.search.truncated,true);assert.equal(limited.search.complete,false);assert.ok(limited.errors.length);
});
test('automatic per-channel recommendations keep their original risk-based behavior',()=>{
  const {c}=engine(),d=[device(1,10,1,641000),device(2,1,1,641250),device(3,2,1,641500)];
  const legacy=c.recommendBackupFrequencies(d,{...options,allocationOrder:'preserve-current',backupCount:1});
  assert.deepEqual(copy(c.recommendBackupFrequencies(d,{...options,backupCount:1})),copy(legacy));
});

const spreadOptions={...options,compatibilityLevel:'more-frequencies',frequencyDistribution:'spread-range'};
test('range spreading uses exactly 16 actual GROUP/CH channels across 640-690 MHz without a 25-slot pool',()=>{
 const {c}=engine(),ds=Array.from({length:16},(_,i)=>device(i+1,i<8?2:10,i%8+1,640000+i*250)),before=copy(ds);
 const result=c.coordinateFrequencies(ds.slice().reverse(),spreadOptions);complete(result);
 const ids=ds.map(d=>d.id),f=frequencies(result,ids);assert.equal(result.assignments.length,16);assert.equal(result.frequencyPool,undefined);assert.equal(result.distribution.targetCount,16);
 assert.equal(f[0],640000);assert.equal(f.at(-1),690000);ascending(f);for(let i=1;i<f.length;i++)assert.ok([3250,3500].includes(f[i]-f[i-1]));
 assert.deepEqual(ds,before);assert.deepEqual(frequencies(c.coordinateFrequencies(ds,spreadOptions),ids),f);
});
test('spread targets recalculate from actual channel count, selected range and explicit lock anchors',()=>{
 const {c}=engine();const ds=Array.from({length:5},(_,i)=>device(i+1,1,i+1));
 const single=c.coordinateFrequencies(ds.slice(0,1),spreadOptions);complete(single);assert.equal(single.assignments[0].frequencyKHz,665000);
 const pair=c.coordinateFrequencies(ds.slice(0,2),{...spreadOptions,rangeStartKHz:650000,rangeEndKHz:660000});complete(pair);assert.deepEqual(frequencies(pair,[1,2]),[650000,660000]);
 const locks=c.coordinateFrequencies(ds,{...spreadOptions,lockedAssignments:[{deviceId:3,frequencyKHz:660000}]});complete(locks);assert.deepEqual(frequencies(locks,[1,2,3,4,5]),[640000,650000,660000,675000,690000]);
 assert.equal(locks.assignments.find(a=>a.deviceId===3).locked,true);
});
test('spread preference never relaxes IMD, exclusion, scan, hardware bands or conflicting locks',()=>{
 const h=engine(),ds=[device(1,1,1),device(2,2,1),device(3,10,1)];
 const standard=h.c.coordinateFrequencies(ds,{...spreadOptions,compatibilityLevel:'standard'});complete(standard);assert.ok(valid(frequencies(standard,[1,2,3])));assert.notDeepEqual(frequencies(standard,[1,2,3]),[640000,665000,690000]);
 const scanPoints=Array.from({length:511},(_,i)=>({frequencyKHz:639500+i*100,levelDbm:Math.abs(639500+i*100-665000)<500?-40:-110}));
 const guarded=h.c.coordinateFrequencies(ds,{...spreadOptions,scanPoints,excludedRanges:[{startKHz:640000,endKHz:641000},{startKHz:689000,endKHz:690000}]});complete(guarded);
 for(const f of frequencies(guarded,[1,2,3])){assert.ok(f>641000&&f<689000);assert.ok(Math.abs(f-665000)>=500);}
 const low=band(h,'spread-low',[640500,645000]),high=band(h,'spread-high',[682000,685000]);
 const bands=h.c.coordinateFrequencies([{...ds[0],equipmentProfileId:low},{...ds[1],equipmentProfileId:high}],spreadOptions);complete(bands);assert.deepEqual(frequencies(bands,[1,2]),[640500,685000]);
 const bad=h.c.coordinateFrequencies(ds,{...spreadOptions,lockedAssignments:[{deviceId:1,frequencyKHz:690000}]});assert.equal(bad.search.complete,false);assert.ok(bad.errors.length);
});
test('spreading remains explicit; unknown GROUP fallback and limited-search honesty are preserved',()=>{
 const {c}=engine(),ds=[{...device(1,1,1,641000),group_source:undefined},{...device(2,2,1,645000),group_source:undefined}];
 const fallback=c.coordinateFrequencies(ds,spreadOptions);complete(fallback);assert.equal(fallback.distribution.enabled,false);assert.deepEqual(frequencies(fallback,[1,2]),[641000,645000]);
 assert.throws(()=>c.coordinateFrequencies(ds,{...spreadOptions,frequencyDistribution:'guess'}));
 const limited=c.coordinateFrequencies([device(1,1,1),device(2,2,1)],{...spreadOptions,maxSearchNodes:1});assert.equal(limited.search.complete,false);assert.equal(limited.search.truncated,true);
});
