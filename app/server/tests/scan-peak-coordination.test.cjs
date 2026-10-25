// Pure mathematical fixtures. No network, physical scan, receiver writes or database.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const clone=value=>JSON.parse(JSON.stringify(value));
function engine(range=[500000,800000]){
  const store=new Map(),ctx=vm.createContext({console,localStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value)}});ctx.window=ctx;
  for(const name of ['frequency','equipment-profiles','coordination'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules',name+'.js'),'utf8'),ctx);
  const p=clone(ctx.DatyEquipmentProfiles.resolveEquipmentProfile({brand:'Unlisted'}));
  p.id='peak-fixture';p.manufacturer='Fixture';p.models=['Synthetic'];p.tuningRangeKHz=range;
  p.bands=[{id:'test-band',label:'Synthetic fixture',tuningRangeKHz:range,region:'TEST',verified:false}];p.defaultBandId='test-band';
  p.minimumChannelSpacingKHz=25;p.coordinationGrid={stepKHz:25,originKHz:0};
  for(const settings of [...Object.values(p.compatibility),...p.modes.map(m=>m.settings)]){
    settings.channelSpacingKHz=25;settings.intermodSpacingKHz=25;settings.scanGuardKHz=25;
  }
  ctx.DatyEquipmentProfiles.saveCustomEquipmentProfile(p);
  return {c:ctx.DatyCoordination,p:ctx.DatyEquipmentProfiles};
}
const device=(freq=632700,id='shure-fixture')=>({id,brand:'Fixture',equipmentProfileId:'peak-fixture',freq,_online:true});
const peaks=[673790,633790,632450].map(frequencyKHz=>({frequencyKHz,levelDbm:-45,startKHz:frequencyKHz-25,endKHz:frequencyKHz+25}));
const options={rangeStartKHz:640000,rangeEndKHz:690000,stepKHz:25,backupCount:0,preserveCurrent:false,
  protectCurrentFrequencies:true,autoExpandRange:true,imdProducts:['3T3O'],scanPeakCarriers:peaks};
const carrierIds=hit=>hit.sourceCarrierIds.map(id=>id.substring(id.indexOf(':',6)+1)).sort();

test('all three measured peaks and live 632.700 MHz form four distinct 3T3O tones with the requested minimum/maximum envelope',()=>{
  const {c}=engine(),ds=[device()],input=clone(options),before=clone(input);
  const report=c.analyzeFrequencyPlan(ds,new Map([[ds[0].id,632700]]),input);
  assert.equal(report.totalImdProducts,12); // 4 choose 3 triples, three products each.
  assert.equal(report.requestedRangeStartKHz,640000);assert.equal(report.requestedRangeEndKHz,690000);
  assert.equal(report.rangeStartKHz,632450);assert.equal(report.rangeEndKHz,690000);
  assert.equal(report.planningGridOriginKHz,640000);
  assert.equal(report.rangeExpansion.participatingFrequencyCount,4);assert.equal(report.rangeExpansion.scanPeakCount,3);
  assert.equal(report.rangeExpansion.outsideFrequencyCount,3);assert.equal(report.rangeExpansion.expanded,true);
  assert.deepEqual(input,before);
  const plan=c.coordinateFrequencies(ds,input);
  assert.deepEqual(clone(plan.options.knownCarriers.filter(c=>c.sourceKind==='scan-peak').map(c=>c.frequencyKHz)),[673790,633790,632450]);
  assert.ok(plan.options.knownCarriers.filter(c=>c.sourceKind==='scan-peak').every(c=>c.intermodSource===true&&!('brand' in c)&&!('profileId' in c)));
  assert.equal(plan.search.complete,true,JSON.stringify(plan.errors));assert.equal(plan.analysis.conflicts.length,0);
  const recheck=c.analyzeFrequencyPlan(ds,new Map(plan.assignments.map(row=>[row.deviceId,row.frequencyKHz])),plan.options);
  assert.equal(recheck.requestedRangeStartKHz,640000);assert.equal(recheck.rangeStartKHz,632450);
  assert.equal(recheck.planningGridOriginKHz,640000);assert.equal(recheck.conflicts.length,0);
});

test('every one of the 12 independently calculated 3T3O products is rejected as a new victim frequency',()=>{
  const {c}=engine(),f=[673790,633790,632450,632700],expected=[];
  for(let a=0;a<4;a++)for(let b=a+1;b<4;b++)for(let d=b+1;d<4;d++){
    const sources=[f[a],f[b],f[d]];
    for(const product of [f[a]+f[b]-f[d],f[a]+f[d]-f[b],f[b]+f[d]-f[a]])expected.push({sources,product});
  }
  assert.equal(expected.length,12);
  const input={...options,rangeStartKHz:500000,rangeEndKHz:800000,protectCurrentFrequencies:false,
    knownCarriers:[{id:'live-shure-632700',frequencyKHz:632700,guardKHz:25}]};
  for(const {sources,product} of expected){
    const receiver=device(product,'new-victim'),report=c.analyzeFrequencyPlan([receiver],new Map([[receiver.id,product]]),input);
    const sourceNames=sources.map(f=>f===632700?'live-shure-632700':`scan-peak:${f}`).sort();
    const hit=report.conflicts.find(hit=>hit.productType==='3T3O'&&hit.productKHz===product&&hit.victimDeviceId==='new-victim'&&
      JSON.stringify(carrierIds(hit))===JSON.stringify(sourceNames));
    assert.ok(hit,JSON.stringify({sources,product,conflicts:clone(report.conflicts)}));
    assert.equal(hit.actualSpacingKHz,0);assert.equal(hit.sourceDeviceIds.length,0);
  }
});

test('measured peaks are protected victims as well as sources and use the strictest participating protection',()=>{
  const {c}=engine(),ds=[device(600000,'a'),device(601000,'b'),device(604000,'c')];
  const report=c.analyzeFrequencyPlan(ds,new Map(ds.map(d=>[d.id,d.freq])),{...options,rangeStartKHz:580000,rangeEndKHz:630000,
    minImdSpacingKHz:150,minChannelSpacingKHz:75,scanPeakCarriers:[{frequencyKHz:605100,levelDbm:-42,guardKHz:200}]});
  // 601000 + 604000 - 600000 = 605000, only 100 kHz from this measured occupied tone.
  const hit=report.conflicts.find(h=>h.productType==='3T3O'&&h.productKHz===605000&&h.victimCarrierId?.includes('scan-peak:605100'));
  assert.ok(hit);assert.equal(hit.requiredSpacingKHz,200);assert.equal(hit.actualSpacingKHz,100);
  const plan=c.coordinateFrequencies([device(650000)],{...options,minChannelSpacingKHz:300,minImdSpacingKHz:150,
    knownCarriers:[{frequencyKHz:699000,guardKHz:450}]});
  assert.ok(plan.options.knownCarriers.filter(c=>c.sourceKind==='scan-peak').every(c=>c.guardKHz===450));
});

test('range expansion takes online, locked, fixed and measured-peak extrema, never scan noise or sample endpoints',()=>{
  const {c}=engine(),ds=[device(632700)],input={...options,scanPeakCarriers:[],
    lockedAssignments:[{deviceId:ds[0].id,frequencyKHz:700000}],knownCarriers:[{frequencyKHz:710000,guardKHz:25}],
    scanPoints:[{frequencyKHz:500000,levelDbm:-120},{frequencyKHz:800000,levelDbm:-120}]};
  const report=c.analyzeFrequencyPlan(ds,new Map([[ds[0].id,700000]]),input);
  assert.equal(report.rangeStartKHz,632700);assert.equal(report.rangeEndKHz,710000);
  assert.ok(!report.conflicts.some(c=>c.type==='tuning-range'));assert.ok(report.conflicts.some(c=>c.type==='scan-uncovered'));
  const noiseOnly=c.coordinateFrequencies([],{...options,scanPeakCarriers:[],scanPoints:input.scanPoints});
  assert.equal(noiseOnly.rangeStartKHz,640000);assert.equal(noiseOnly.rangeEndKHz,690000);assert.equal(noiseOnly.rangeExpansion.expanded,false);
  const monitorOnly=c.coordinateFrequencies([],{...options,scanPeakCarriers:[],knownCarriers:[{frequencyKHz:632700,guardKHz:250}]});
  assert.equal(monitorOnly.rangeStartKHz,632700);assert.equal(monitorOnly.rangeEndKHz,690000);assert.equal(monitorOnly.assignments.length,0);
});

test('range widening never extends hardware bands or accepts an invalid lock',()=>{
  const {c}=engine([640000,690000]),ds=[device(632700)],input={...options,scanPeakCarriers:[]};
  const plan=c.coordinateFrequencies(ds,input);
  assert.equal(plan.rangeStartKHz,632700);assert.equal(plan.search.complete,true);
  assert.ok(plan.assignments.every(row=>row.frequencyKHz>=640000&&row.frequencyKHz<=690000));
  const locked=c.coordinateFrequencies(ds,{...input,lockedAssignments:[{deviceId:ds[0].id,frequencyKHz:632700}]});
  assert.equal(locked.search.complete,false);assert.ok(locked.errors.some(e=>e.includes('精确频段')));
});

test('off-grid 633.790 MHz expands the range without shifting candidate, backup or reserve grids',()=>{
  const {c}=engine(),ds=[device(650000)],input={...options,scanPeakCarriers:[peaks[1]],backupCount:1,minimumFrequencyCount:4};
  const plan=c.coordinateFrequencies(ds,input);
  assert.equal(plan.rangeStartKHz,633790);assert.equal(plan.planningGridOriginKHz,640000);
  assert.equal(plan.search.complete,true,JSON.stringify(plan.errors));
  const all=plan.assignments.flatMap(row=>[row.frequencyKHz,...row.backupFrequenciesKHz]).concat(plan.frequencyPool.reservedFrequenciesKHz);
  assert.ok(all.length>=5);assert.ok(all.every(f=>(f-640000)%25===0));
  const manual=c.analyzeFrequencyPlan(ds,new Map([[ds[0].id,634015]]),input);assert.ok(manual.conflicts.some(c=>c.type==='frequency-grid'));
  const valid=c.analyzeFrequencyPlan(ds,new Map([[ds[0].id,634025]]),input);assert.ok(!valid.conflicts.some(c=>c.type==='frequency-grid'));
  const explicit=c.coordinateFrequencies(ds,{...input,planningGridOriginKHz:600000});assert.equal(explicit.planningGridOriginKHz,600000);
});

test('global and greedy search, manual checks and automatic backups share measured-source protection and range expansion',()=>{
  const {c}=engine(),ds=[device(673550)],input={...options,rangeStartKHz:640000,rangeEndKHz:690000,scanPeakCarriers:peaks,
    knownCarriers:[{frequencyKHz:632700,guardKHz:25}],backupCount:1};
  for(const solver of ['global','greedy']){
    const plan=c.coordinateFrequencies(ds,{...input,solver});assert.equal(plan.search.complete,true,JSON.stringify(plan.errors));
    for(const row of plan.assignments)for(const f of [row.frequencyKHz,...row.backupFrequenciesKHz]){
      const check=c.analyzeFrequencyPlan(ds,new Map([[ds[0].id,f]]),input);assert.equal(check.conflicts.length,0,JSON.stringify(check.conflicts));
    }
  }
  const backup=c.recommendBackupFrequencies(ds,input);
  assert.equal(backup.rangeStartKHz,632450);assert.equal(backup.rangeEndKHz,690000);
  // 673790 + 632450 - 632700 = 673540, within 25 kHz of this receiver.
  const row=backup.entries.find(row=>row.deviceId===ds[0].id);assert.ok(row);assert.ok(row.reasonTypes.includes('intermod-3'));
  for(const f of row.backupFrequenciesKHz){
    const check=c.analyzeFrequencyPlan(ds,new Map([[ds[0].id,f]]),input);assert.equal(check.conflicts.length,0);
  }
});

test('duplicate peaks remain one exact tone and preserve stronger protection without mutating caller data',()=>{
  const {c}=engine(),ds=[device()],single={...options},duplicate={...options,scanPeakCarriers:[...peaks,{...peaks[0],levelDbm:-40,guardKHz:100}]};
  const a=c.analyzeFrequencyPlan(ds,new Map([[ds[0].id,632700]]),single),b=c.analyzeFrequencyPlan(ds,new Map([[ds[0].id,632700]]),duplicate);
  assert.equal(a.totalImdProducts,12);assert.equal(b.totalImdProducts,12);assert.equal(b.rangeExpansion.scanPeakCount,3);
  const plan=c.coordinateFrequencies(ds,duplicate),carrier=plan.options.knownCarriers.find(c=>c.frequencyKHz===673790);
  assert.equal(carrier.levelDbm,-40);assert.equal(carrier.guardKHz,100);assert.equal(peaks[0].guardKHz,undefined);
  const doubled=c.analyzeFrequencyPlan(ds,new Map([[ds[0].id,632700]]),{...options,scanPeakCarriers:[...peaks,{frequencyKHz:632700,levelDbm:-42}]});
  assert.equal(doubled.totalImdProducts,12);
});

test('round-trip result options replace generated peaks without accumulating copies, guards or range metadata',()=>{
  const {c}=engine(),ds=[device()];let plan=c.coordinateFrequencies(ds,options);
  const expected=clone(plan.options.knownCarriers),metadata=clone(plan.rangeExpansion);
  for(let repeat=0;repeat<5;repeat++){
    plan=c.coordinateFrequencies(ds,plan.options);
    assert.deepEqual(clone(plan.options.knownCarriers),expected);assert.deepEqual(clone(plan.rangeExpansion),metadata);
    assert.equal(plan.requestedRangeStartKHz,640000);assert.equal(plan.rangeStartKHz,632450);
  }
  const cleared=c.coordinateFrequencies(ds,{...plan.options,scanPeakCarriers:[]});
  assert.ok(cleared.options.knownCarriers.every(carrier=>carrier.sourceKind!=='scan-peak'));
  assert.equal(cleared.rangeStartKHz,632700);assert.equal(cleared.rangeExpansion.scanPeakCount,0);
});

test('empty, offline and unknown inputs do not invent occupied frequencies; opt-out retains explicit range',()=>{
  const {c}=engine();
  for(const ds of [[],[{...device(),_online:false}],[{...device(),freq:null}],[{...device(),freq:NaN}]]){
    const report=c.coordinateFrequencies(ds,{...options,scanPeakCarriers:[]});assert.equal(report.rangeStartKHz,640000);assert.equal(report.rangeEndKHz,690000);
  }
  const report=c.analyzeFrequencyPlan([device()],new Map([['shure-fixture',632700]]),{...options,autoExpandRange:false});
  assert.equal(report.rangeStartKHz,640000);assert.ok(report.conflicts.some(c=>c.type==='tuning-range'));assert.equal(report.totalImdProducts,12);
});

test('peak input rejects invalid or synthetic placeholders and sparse coverage stays unavailable',()=>{
  const {c}=engine(),ds=[device(650000)];
  for(const invalid of [null,'peak',[{frequencyKHz:632450.5,levelDbm:-40}],[{frequencyKHz:632450,levelDbm:null}],
    [{frequencyKHz:632450,levelDbm:NaN}],[{frequencyKHz:632450,levelDbm:-201}],[{frequencyKHz:632450,levelDbm:-40,guardKHz:0}],
    [{frequencyKHz:632450,levelDbm:-40,startKHz:632475,endKHz:632500}]])
    assert.throws(()=>c.coordinateFrequencies(ds,{...options,scanPeakCarriers:invalid}));
  const partial=c.analyzeFrequencyPlan(ds,new Map([[ds[0].id,650000]]),{...options,scanPoints:[
    {frequencyKHz:632450,levelDbm:-40},{frequencyKHz:640000,levelDbm:-100},{frequencyKHz:690000,levelDbm:-100}]});
  assert.ok(partial.conflicts.some(c=>c.type==='scan-uncovered'));assert.equal(partial.rangeStartKHz,632450);
  assert.throws(()=>c.coordinateFrequencies(ds,{...options,autoExpandRange:'true'}));
  assert.throws(()=>c.coordinateFrequencies(ds,{...options,planningGridOriginKHz:632450.5}));
});
