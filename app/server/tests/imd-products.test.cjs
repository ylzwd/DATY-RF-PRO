// Pure arithmetic / synthetic Profile checks. No network, device SET or database.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const clone=value=>JSON.parse(JSON.stringify(value));
const TYPES=['2T3O','2T5O','2T7O','2T9O','3T3O'];
function engine(){
  const storage=new Map(),ctx=vm.createContext({console,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}});ctx.window=ctx;
  for(const name of ['frequency','equipment-profiles','coordination'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules',name+'.js'),'utf8'),ctx);
  for(const brand of ['FixtureA','FixtureB']){
    const p=clone(ctx.DatyEquipmentProfiles.resolveEquipmentProfile({brand:'Unlisted'}));p.id=brand;p.manufacturer=brand;p.models=['Synthetic'];
    p.minimumChannelSpacingKHz=25;p.coordinationGrid={stepKHz:25,originKHz:0};
    for(const s of [...Object.values(p.compatibility),...p.modes.map(m=>m.settings)]){s.channelSpacingKHz=25;s.intermodSpacingKHz=25;}
    ctx.DatyEquipmentProfiles.saveCustomEquipmentProfile(p);
  }
  return {c:ctx.DatyCoordination,p:ctx.DatyEquipmentProfiles};
}
const devices=frequencies=>frequencies.map((freq,i)=>({id:`rx-${i}`,brand:i%2?'FixtureB':'FixtureA',equipmentProfileId:i%2?'FixtureB':'FixtureA',freq,_online:true}));
const map=ds=>new Map(ds.map(d=>[d.id,d.freq]));
const opts={rangeStartKHz:580000,rangeEndKHz:630000,stepKHz:25,backupCount:0,preserveCurrent:false};
const analyze=(c,frequencies,extra={})=>{const ds=devices(frequencies);return c.analyzeFrequencyPlan(ds,map(ds),{...opts,...extra});};

// Separate explicit formulas; these do not use the production helper/generator.
function oracle(frequencies,selected,guard=25){
  const hits=[];
  const formulas={
    '2T3O':(a,b)=>[2*a-b,2*b-a], '2T5O':(a,b)=>[3*a-2*b,3*b-2*a],
    '2T7O':(a,b)=>[4*a-3*b,4*b-3*a], '2T9O':(a,b)=>[5*a-4*b,5*b-4*a]
  };
  function check(type,indices,products){for(const f of products)for(let victim=0;victim<frequencies.length;victim++)
    if(f>0&&!indices.includes(victim)&&Math.abs(f-frequencies[victim])<guard)hits.push(`${type}:${indices.join(',')}:${victim}:${f}`);}
  for(let a=0;a<frequencies.length;a++)for(let b=a+1;b<frequencies.length;b++){
    for(const type of selected)if(formulas[type])check(type,[a,b],formulas[type](frequencies[a],frequencies[b]));
    if(selected.includes('3T3O'))for(let d=b+1;d<frequencies.length;d++)
      check('3T3O',[a,b,d],[frequencies[a]+frequencies[b]-frequencies[d],frequencies[a]+frequencies[d]-frequencies[b],frequencies[b]+frequencies[d]-frequencies[a]]);
  }return hits.sort();
}
function normalize(conflicts){return clone(conflicts).filter(c=>c.productType).map(c=>`${c.productType}:${c.sourceDeviceIds.map(id=>Number(id.slice(3))).join(',')}:${Number(c.victimDeviceId.slice(3))}:${c.productKHz}`).sort();}

test('all five explicit product definitions match independent numeric examples',()=>{
  const {c}=engine();
  assert.deepEqual(clone(c.calculateImd3KHz(600000,601000)),[599000,602000]);
  assert.deepEqual(clone(c.calculateImd5KHz(600000,601000)),[598000,603000]);
  assert.deepEqual(clone(c.calculateImd7KHz(600000,601000)),[597000,604000]);
  assert.deepEqual(clone(c.calculateImd9KHz(600000,601000)),[596000,605000]);
  assert.deepEqual(clone(c.calculateImd3ThreeToneKHz(600000,601000,604000)),[597000,603000,605000]);
  for(const helper of [c.calculateImd7KHz,c.calculateImd9KHz])for(const invalid of [NaN,600000.5,'600000',29999,3000001])assert.throws(()=>helper(invalid,601000));
});
test('each checkbox enables exactly its own family including third-order three-tone alone',()=>{
  const {c,p}=engine(),profile=clone(p.resolveEquipmentProfile({brand:'FixtureA',equipmentProfileId:'FixtureA'}));
  profile.imdPolicy={orders:[3,5],includeThreeTone:true};p.saveCustomEquipmentProfile(profile);
  const frequencies=[600000,601000,602000,603000,604000,605000,607000];
  for(let bits=0;bits<32;bits++){
    const selected=TYPES.filter((_,i)=>bits&(1<<i));
    const actual=analyze(c,frequencies,{imdProducts:selected,imdOrders:[3,5],includeThreeTone:true});
    assert.deepEqual(normalize(actual.conflicts),oracle(frequencies,selected),selected.join(','));
    assert.ok(actual.conflicts.every(hit=>!hit.productType||selected.includes(hit.productType)));
    const snapshot=c.describeCompatibility(devices(frequencies),{imdProducts:selected});
    assert.deepEqual(clone(snapshot.imdProducts),selected);
  }
});
test('explicit selections canonicalize, detach caller values and reject invalid product IDs',()=>{
  const {c}=engine(),selected=['3T3O','2T9O','2T3O'],input={...opts,imdProducts:selected};
  const plan=c.coordinateFrequencies(devices([600000]),input);
  assert.deepEqual(clone(plan.options.imdProducts),['2T3O','2T9O','3T3O']);assert.deepEqual(clone(plan.options.imdOrders),[3,9]);
  selected.length=0;assert.equal(plan.compatibility.imdProducts.length,3);
  for(const invalid of [null,'2T3O',['2T30'],['3T5O'],['2T3O','2T3O'],[3],['2t3o']])assert.throws(()=>analyze(c,[600000],{imdProducts:invalid}));
  assert.deepEqual(clone(analyze(c,[600000,601000,604000],{imdOrders:[7],includeThreeTone:false}).conflicts).filter(c=>c.productType).map(c=>c.productType),['2T7O']);
});
test('two-tone high orders respect the same exact protection boundary',()=>{
  const {c}=engine();
  for(const [type,victim]of [['2T7O',604000],['2T9O',605000]]){
    assert.ok(analyze(c,[600000,601000,victim],{imdProducts:[type]}).conflicts.some(c=>c.productType===type&&c.productKHz===victim));
    const edge=analyze(c,[600000,601000,victim+25],{imdProducts:[type]});
    assert.ok(!edge.conflicts.some(c=>c.sourceDeviceIds.join(',')==='rx-0,rx-1'&&c.victimDeviceId==='rx-2'));
    assert.equal(edge.minImdMarginKHz,0);
  }
});
test('fixed occupancy is protected from newly generated IMD even when disabled as a source',()=>{
  const {c}=engine(),carrier={id:'existing-other-brand',frequencyKHz:604000,guardKHz:100,intermodSource:false};
  const result=analyze(c,[600000,601000],{imdProducts:['2T7O'],knownCarriers:[carrier]});
  const hit=result.conflicts.find(h=>h.productKHz===604000&&h.victimCarrierId);
  assert.equal(hit.productType,'2T7O');assert.deepEqual(clone(hit.sourceDeviceIds),['rx-0','rx-1']);assert.equal(hit.requiredSpacingKHz,100);
  assert.equal(hit.victimDeviceId,undefined);assert.equal(hit.sourceCarrierIds.length,0);
  assert.equal(analyze(c,[600000,601000],{imdProducts:[],knownCarriers:[carrier]}).conflicts.length,0);
  assert.equal(analyze(c,[600000,601000],{imdProducts:['2T7O'],knownCarriers:[{...carrier,frequencyKHz:604100}]}).conflicts.length,0);
});
test('fixed-to-fixed pre-existing products do not block unrelated new assignments',()=>{
  const {c}=engine(),knownCarriers=[600000,601000,604000].map(frequencyKHz=>({frequencyKHz,guardKHz:25}));
  const result=analyze(c,[620000],{imdProducts:['2T7O'],knownCarriers});assert.equal(result.conflicts.length,0);
  const victim=analyze(c,[604000],{imdProducts:['2T7O'],knownCarriers:knownCarriers.slice(0,2)});
  assert.ok(victim.conflicts.some(h=>h.productType==='2T7O'&&h.sourceCarrierIds.length===2));
});
test('owner current occupancy allows self retention, protects others and never fabricates offline values',()=>{
  const {c}=engine(),ds=devices([600000,600100]),input={...opts,protectCurrentFrequencies:true,imdProducts:[]};
  const retained=c.coordinateFrequencies(ds,{...input,preserveCurrent:true});assert.equal(retained.search.complete,true);
  assert.deepEqual(clone(retained.assignments.map(a=>a.frequencyKHz)),[600000,600100]);
  assert.equal(c.analyzeFrequencyPlan(ds,new Map([['rx-0',600100],['rx-1',601000]]),input).conflicts.some(h=>h.type==='known-carrier'&&h.victimDeviceId==='rx-0'),true);
  const swapped=c.coordinateFrequencies(ds,{...input,lockedAssignments:[{deviceId:'rx-0',frequencyKHz:600100},{deviceId:'rx-1',frequencyKHz:601000}]});assert.equal(swapped.search.complete,false);
  const offline=c.coordinateFrequencies(ds.map(d=>({...d,_online:false})),input);assert.equal(offline.options.knownCarriers.length,0);
  const unknown=c.coordinateFrequencies(ds.map(d=>({...d,freq:null})),input);assert.equal(unknown.options.knownCarriers.length,0);
  assert.equal(input.knownCarriers,undefined);
});
test('same owner and current frequency never create duplicate source tones or false IMD',()=>{
  const {c}=engine(),ds=devices([600000,601000,604000,606000]);
  const legacy=c.analyzeFrequencyPlan(ds,map(ds),{...opts,imdProducts:TYPES});
  const protectedPlan=c.analyzeFrequencyPlan(ds,map(ds),{...opts,imdProducts:TYPES,protectCurrentFrequencies:true});
  assert.deepEqual(clone(protectedPlan),clone(legacy));
  const moved=c.analyzeFrequencyPlan(ds,new Map(ds.map((d,i)=>[d.id,i?d.freq:610000])),{...opts,imdProducts:TYPES,protectCurrentFrequencies:true});
  assert.ok(moved.totalImdProducts>legacy.totalImdProducts);
});
test('merging an owned current tone preserves its stronger carrier guard and channel routing',()=>{
  const {c}=engine(),ds=devices([600000,601000,604075]);
  const input={...opts,imdProducts:['2T7O'],knownCarriers:[
    {id:'weak-copy',ownerDeviceId:'rx-2',frequencyKHz:604075,guardKHz:25,intermodSource:false},
    {id:'strong-copy',ownerDeviceId:'rx-2',frequencyKHz:604075,guardKHz:100,intermodSource:false}]};
  // Independent arithmetic: 4 * 601000 - 3 * 600000 = 604000;
  // 604075 - 604000 = 75, inside the explicit 100 kHz guard.
  const report=c.analyzeFrequencyPlan(ds,map(ds),input);
  const hit=report.conflicts.find(item=>item.productKHz===604000&&item.victimDeviceId==='rx-2');
  assert.equal(hit.productType,'2T7O');assert.equal(hit.actualSpacingKHz,75);assert.equal(hit.requiredSpacingKHz,100);
  assert.equal(hit.marginKHz,-25);assert.deepEqual(clone(hit.sourceDeviceIds),['rx-0','rx-1']);
  assert.equal(hit.victimCarrierId,undefined);assert.equal(report.totalImdProducts,6);
  const allLocked=c.coordinateFrequencies(ds,{...input,lockedAssignments:ds.map(d=>({deviceId:d.id,frequencyKHz:d.freq}))});
  assert.equal(allLocked.search.complete,false);assert.ok(allLocked.errors.some(error=>error.includes('100 kHz')));
  const boundary=devices([600000,601000,604100]);
  const edge=c.analyzeFrequencyPlan(boundary,map(boundary),{...input,knownCarriers:[{...input.knownCarriers[1],frequencyKHz:604100}]});
  assert.ok(!edge.conflicts.some(item=>item.productKHz===604000&&item.victimDeviceId==='rx-2'));
  assert.equal(edge.minImdMarginKHz,0);
});
test('duplicate fixed entries are one RF tone, never an artificial third tone',()=>{
  const {c}=engine(),ds=devices([599000]);
  const a={id:'A',ownerDeviceId:'external-a',frequencyKHz:600000,guardKHz:25};
  const b={id:'B',ownerDeviceId:'external-b',frequencyKHz:601000,guardKHz:25};
  const original=c.analyzeFrequencyPlan(ds,map(ds),{...opts,imdProducts:['3T3O'],knownCarriers:[a,b]});
  const duplicated=c.analyzeFrequencyPlan(ds,map(ds),{...opts,imdProducts:['3T3O'],knownCarriers:[a,{...a,id:'same-A-again'},b]});
  assert.equal(original.conflicts.length,0);assert.deepEqual(clone(duplicated),clone(original));
  assert.equal(duplicated.totalImdProducts,3);
  // With 2T3O selected, the actual two-tone product must still be rejected.
  const actual=c.analyzeFrequencyPlan(ds,map(ds),{...opts,imdProducts:['2T3O'],knownCarriers:[a,{...a,id:'same-A-again'},b]});
  assert.ok(actual.conflicts.some(hit=>hit.productType==='2T3O'&&hit.productKHz===599000&&hit.victimDeviceId==='rx-0'));
});
test('duplicate fixed victims merge the strongest guard and keep any source participation',()=>{
  const {c}=engine(),fixed={id:'existing',frequencyKHz:604075,guardKHz:25,intermodSource:false};
  const report=analyze(c,[600000,601000],{imdProducts:['2T7O'],knownCarriers:[fixed,{...fixed,id:'stronger-copy',guardKHz:100}]});
  const hit=report.conflicts.find(item=>item.productKHz===604000&&item.victimCarrierId);
  assert.equal(hit.requiredSpacingKHz,100);assert.equal(hit.actualSpacingKHz,75);
  assert.equal(report.conflicts.filter(item=>item.productKHz===604000&&item.victimCarrierId).length,1);
  const mixed=[{frequencyKHz:600000,guardKHz:25,intermodSource:false},{frequencyKHz:600000,guardKHz:25,intermodSource:true},{frequencyKHz:601000,guardKHz:25}];
  const source=analyze(c,[599000],{imdProducts:['2T3O'],knownCarriers:mixed});
  assert.ok(source.conflicts.some(item=>item.productKHz===599000&&item.victimDeviceId==='rx-0'));
});
test('all selected families constrain global, greedy, conservative backups and manual revalidation',()=>{
  const {c}=engine(),ds=devices([600000,601000,605000]),knownCarriers=[{id:'occupied',frequencyKHz:607000,guardKHz:50}];
  for(const solver of ['global','greedy']){
    const input={...opts,rangeEndKHz:610000,imdProducts:TYPES,solver,backupCount:1,knownCarriers};
    const result=c.coordinateFrequencies(ds,input);assert.equal(result.search.complete,true,JSON.stringify(result.errors));
    const all=result.assignments.flatMap(row=>[row.frequencyKHz,...row.backupFrequenciesKHz]);
    assert.equal(oracle(all,TYPES).length,0);
    const synthesized=devices(all);assert.equal(c.analyzeFrequencyPlan(synthesized,map(synthesized),input).conflicts.length,0);
    const manual=c.analyzeFrequencyPlan(ds,new Map([['rx-0',600000],['rx-1',601000],['rx-2',605000]]),input);
    assert.ok(manual.conflicts.some(h=>h.productType==='2T9O'));
  }
});
test('automatic backups recognize seventh/ninth-order risk and reject all selected products',()=>{
  const {c}=engine();
  for(const [type,at]of [['2T7O',604000],['2T9O',605000]]){
    const ds=devices([600000,601000,at]),input={...opts,imdProducts:[type],backupCount:1};
    const result=c.recommendBackupFrequencies(ds,input),entry=result.entries.find(row=>row.deviceId==='rx-2');
    assert.ok(entry.reasonTypes.includes(type==='2T7O'?'intermod-7':'intermod-9'));assert.ok(entry.backupFrequenciesKHz.length);
    for(const replacement of entry.backupFrequenciesKHz){const adjusted=devices([600000,601000,replacement]);assert.equal(oracle(adjusted.map(d=>d.freq),[type]).length,0);}
  }
});
test('bounded planning remains deterministic with all five families and live occupation',()=>{
  const {c}=engine(),ds=devices(Array.from({length:12},(_,i)=>600000+i*1000)),input={...opts,rangeEndKHz:620000,imdProducts:TYPES,protectCurrentFrequencies:true,maxSearchNodes:30};
  const start=performance.now(),a=c.coordinateFrequencies(ds,input),b=c.coordinateFrequencies(ds,input);
  assert.ok(performance.now()-start<5000,'bounded small search should finish under five seconds');
  assert.equal(a.search.truncated,true);assert.equal(a.search.complete,false);assert.equal(a.analysis.conflicts.length,0);
  assert.deepEqual(clone(a),clone(b));assert.ok(a.search.nodes<=30);
});
test('50-channel all-products planning respects an explicit tiny work limit without unsafe assignments',()=>{
  const {c}=engine(),ds=devices(Array.from({length:50},(_,i)=>590000+i*625));
  const start=performance.now(),result=c.coordinateFrequencies(ds,{...opts,imdProducts:TYPES,protectCurrentFrequencies:true,maxSearchNodes:3});
  assert.ok(performance.now()-start<5000,'50-channel bounded search should finish under five seconds');
  assert.equal(result.search.truncated,true);assert.ok(result.search.nodes<=3);assert.equal(result.analysis.conflicts.length,0);
});
