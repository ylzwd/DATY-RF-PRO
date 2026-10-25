const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname,'..');
const data = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/p0-reference.json'),'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));
function engine() {
  const values=new Map();
  const context=vm.createContext({console,localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value))}});
  context.window=context;
  vm.runInContext('Math.random = () => { throw new Error("Randomness forbidden in P0 results"); };',context);
  for(const file of ['frequency','equipment-profiles','coordination','scan-csv']) vm.runInContext(fs.readFileSync(path.join(root,'src/modules',file+'.js'),'utf8'),context,{filename:file+'.js'});
  return {f:context.DatyFrequency,p:context.DatyEquipmentProfiles,c:context.DatyCoordination,csv:context.DatyScanCsv,context,values};
}
const devices = freqs => freqs.map((freq,index)=>({id:index+1,ch:`CH${index+1}`,name:`Test ${index+1}`,brand:'DATYaudio',model:'RF PRO',freq}));
const options={rangeStartKHz:600000,rangeEndKHz:610000,backupCount:0};
for(const item of data.frequencyCases)test(`fixed units: ${JSON.stringify(item.value)} ${item.unit}`,()=>{
  const {f}=engine();
  if(item.expectedKHz===null)assert.throws(()=>f.toFrequencyKHz(item.value,item.unit));
  else assert.equal(f.toFrequencyKHz(item.value,item.unit),item.expectedKHz);
});
for(const item of data.imdCases)test(`fixed arithmetic: ${item.id}`,()=>{
  assert.deepEqual(copy(engine().c[item.method](...item.sourcesKHz)),item.productsKHz);
});
for(const item of data.analysisCases)test(`fixed plan analysis: ${item.id}`,()=>{
  const {c}=engine(),d=devices(item.frequenciesKHz);
  const result=c.analyzeFrequencyPlan(d,new Map(d.map(x=>[x.id,x.freq])),options);
  if(item.conflictType)assert.ok(result.conflicts.some(x=>x.type===item.conflictType));
  else assert.equal(result.conflicts.length,0);
  assert.equal(result.minImdMarginKHz,item.minImdMarginKHz);
});
// Independent small-grid exhaustive oracle, not a call back into the production validator.
function oracleMaximum(candidates,limit,minimumSpacingKHz=data.datyReferenceRules.minimumChannelSpacingKHz,requiredFrequencyKHz=null) {
  let maximum=0;
  function valid(freqs) {
    for(let i=0;i<freqs.length;i++)for(let j=i+1;j<freqs.length;j++) {
      if(Math.abs(freqs[i]-freqs[j])<minimumSpacingKHz)return false;
      for(let k=0;k<freqs.length;k++)if(k!==i&&k!==j) {
        if(Math.abs(2*freqs[i]-freqs[j]-freqs[k])<250 || Math.abs(2*freqs[j]-freqs[i]-freqs[k])<250)return false;
      }
    }
    for(let i=0;i<freqs.length;i++)for(let j=i+1;j<freqs.length;j++)for(let k=j+1;k<freqs.length;k++) {
      for(let v=0;v<freqs.length;v++)if(![i,j,k].includes(v)) {
        for(const product of [freqs[i]+freqs[j]-freqs[k],freqs[i]+freqs[k]-freqs[j],freqs[j]+freqs[k]-freqs[i]])if(Math.abs(product-freqs[v])<250)return false;
      }
    }
    return true;
  }
  function walk(index,chosen) {
    if(requiredFrequencyKHz===null || chosen.includes(requiredFrequencyKHz))maximum=Math.max(maximum,chosen.length);
    if(chosen.length===limit)return;
    for(let i=index;i<candidates.length;i++)if(valid([...chosen,candidates[i]]))walk(i+1,[...chosen,candidates[i]]);
  }
  walk(0,[]);return maximum;
}
for(const item of data.solverCases)test(`fixed global solve + independent exhaustive oracle: ${item.id}`,()=>{
  const {c}=engine(),d=devices(Array(item.channels).fill(600000));
  const result=c.coordinateFrequencies(d,{...item,backupCount:0});
  const candidates=[];for(let f=item.rangeStartKHz;f<=item.rangeEndKHz;f+=item.stepKHz) {
    if((f-data.datyReferenceRules.coordinationOriginKHz)%data.datyReferenceRules.coordinationStepKHz===0)candidates.push(f);
  }
  assert.equal(oracleMaximum(candidates,item.channels,item.minChannelSpacingKHz),item.maximumAssigned);
  assert.equal(result.assignments.length,item.maximumAssigned);
  assert.deepEqual(copy(result.assignments.map(x=>x.frequencyKHz)),item.expectedFrequenciesKHz);
  assert.ok(result.assignments.every(x=>x.frequencyKHz%250===0));
  assert.equal(result.analysis.conflicts.length,0);
  assert.deepEqual(copy(c.coordinateFrequencies(d,{...item,backupCount:0})),copy(result));
});

for(const item of data.retentionCases)test(`fixed current-frequency retention: ${item.id}`,()=>{
  const {c}=engine(),d=devices(item.frequenciesKHz),before=copy(d);
  const result=c.coordinateFrequencies(d,options);
  assert.deepEqual(copy(result.assignments.map(a=>a.frequencyKHz)),item.expectedFrequenciesKHz);
  assert.deepEqual(copy(result.retention.protectedDeviceIds),item.protectedDeviceIds);
  assert.equal(result.analysis.conflicts.length,0);assert.deepEqual(d,before);
  assert.deepEqual(copy(c.coordinateFrequencies(d,options)),copy(result));
});

test('measured scan peak changes only affected current frequency and retains the clean channel',()=>{
  const {c}=engine(),d=devices([601000,600000]);
  const scanPoints=Array.from({length:36},(_,i)=>({frequencyKHz:599500+i*100,levelDbm:i===15?-40:-100}));
  const result=c.coordinateFrequencies(d,{...options,scanPoints});
  assert.equal(result.assignments.length,2);assert.equal(result.analysis.conflicts.length,0);
  const changed=result.assignments.find(a=>a.deviceId===1),kept=result.assignments.find(a=>a.deviceId===2);
  assert.notEqual(changed.frequencyKHz,601000);assert.match(changed.changeReason,/实测峰值/);
  assert.equal(kept.frequencyKHz,600000);assert.equal(kept.protectedOriginal,true);
  assert.equal(result.retention.retainedCount,1);assert.equal(result.retention.changedCount,1);
});

test('preservation never overrides range, device grid, exclusions, known occupancy or scan coverage',()=>{
  const {c}=engine();
  for(const [freq,extra,type] of [[599000,{},'tuning-range'],[600013,{},'frequency-grid'],
    [600000,{excludedRanges:[{startKHz:600000,endKHz:600000}]},'excluded-range'],
    [600000,{knownCarriers:[{frequencyKHz:600000,guardKHz:100}]},'known-carrier'],
    [600000,{scanPoints:[{frequencyKHz:602000,levelDbm:-100},{frequencyKHz:602100,levelDbm:-100}]},'scan-uncovered']]) {
    const result=c.coordinateFrequencies(devices([freq]),{...options,...extra});
    assert.equal(result.retention.protectedDeviceIds.length,0);
    assert.ok(result.retention.originalChecks[0].issues.some(issue=>issue.type===type));
    assert.ok(result.assignments.every(a=>a.frequencyKHz!==freq));
  }
});

test('IMD victims are replanned, clean currents stay fixed, and hard user locks still win',()=>{
  const {c}=engine();
  const fixed=[{frequencyKHz:600000,guardKHz:100},{frequencyKHz:601000,guardKHz:100}];
  const result=c.coordinateFrequencies(devices([602000,610000]),{...options,rangeEndKHz:612000,knownCarriers:fixed});
  assert.equal(result.assignments.find(a=>a.deviceId===2).frequencyKHz,610000);
  assert.notEqual(result.assignments.find(a=>a.deviceId===1).frequencyKHz,602000);
  assert.ok(result.retention.originalChecks[0].issues.some(issue=>issue.type==='intermod-3'));
  assert.equal(result.analysis.conflicts.length,0);
  // A new locked victim at 602 MHz requires moving sources rather than preserving a conflicting seed.
  const locked=c.coordinateFrequencies(devices([600000,601000,609000]),{...options,lockedAssignments:[{deviceId:3,frequencyKHz:602000}]});
  assert.equal(locked.assignments.length,3);assert.equal(locked.analysis.conflicts.length,0);
  assert.equal(locked.assignments.find(a=>a.deviceId===3).frequencyKHz,602000);
  const direct=c.coordinateFrequencies(devices([0,600000]),{...options,lockedAssignments:[{deviceId:1,frequencyKHz:600000}]});
  assert.equal(direct.assignments.find(a=>a.deviceId===1).frequencyKHz,600000);
  assert.notEqual(direct.assignments.find(a=>a.deviceId===2).frequencyKHz,600000);
});

test('preserved currents cannot be released silently to fit more channels on the 250 kHz lattice',()=>{
  // Independent lattice fact: in {0,...,6}, an IMD-safe four-carrier set is
  // {0,1,4,6}; every four-carrier set containing 3 creates a pair/three-tone hit.
  const {c}=engine(),d=devices([600750,0,0,0]),input={...options,rangeEndKHz:601500};
  const candidates=Array.from({length:7},(_,index)=>600000+index*250);
  assert.equal(oracleMaximum(candidates,4),4);
  assert.equal(oracleMaximum(candidates,4,250,600750),3);
  const kept=c.coordinateFrequencies(d,input);
  assert.equal(kept.assignments.find(a=>a.deviceId===1).frequencyKHz,600750);
  assert.equal(kept.assignments.length,3);assert.equal(kept.unassignedDeviceIds.length,1);
  assert.ok(kept.warnings.some(message=>message.includes('不会为增加分配数量而自动挪动')));
  assert.equal(kept.search.objective,'max-assigned-count-with-clean-current-held');
  const unrestricted=c.coordinateFrequencies(d,{...input,preserveCurrent:false});
  assert.equal(unrestricted.assignments.length,4);assert.equal(unrestricted.analysis.conflicts.length,0);
  assert.throws(()=>c.coordinateFrequencies(d,{...input,preserveCurrent:'false'}));
});

test('retaining a frequency without a scan never claims measured interference clearance',()=>{
  const result=engine().c.coordinateFrequencies(devices([600000,601000,603000]),options);
  assert.equal(result.retention.retainedCount,3);assert.equal(result.retention.scanAvailable,false);
  assert.ok(result.assignments.every(a=>a.scanLevelDbm===null && /现场干扰未验证/.test(a.changeReason)));
});

test('bounded current-plan combinations always revalidate; protected frequencies remain unchanged',()=>{
  const {c}=engine();
  for(const a of [600000,600500,601000])for(const b of [600000,600500,601000])for(const third of [600000,600500,601000]) {
    const d=devices([a,b,third]),result=c.coordinateFrequencies(d,options);
    assert.equal(c.analyzeFrequencyPlan(d,new Map(result.assignments.map(x=>[x.deviceId,x.frequencyKHz])),options).conflicts.length,0);
    for(const id of result.retention.protectedDeviceIds)assert.equal(result.assignments.find(x=>x.deviceId===id).frequencyKHz,d[id-1].freq);
  }
});

test('three-tone IMD catches a collision missed by two-tone-only analysis',()=>{
  const {c}=engine(),d=devices([600000,601000,604000,605000]),map=new Map(d.map(x=>[x.id,x.freq]));
  assert.equal(c.analyzeFrequencyPlan(d,map,{...options,includeThreeTone:false}).conflicts.length,0);
  assert.ok(c.analyzeFrequencyPlan(d,map,options).conflicts.some(x=>x.imdKind==='three-tone'&&x.actualSpacingKHz===0));
});
test('unknown/not-applicable IMD margin is null, disabled sources have zero products',()=>{
  const {c,p}=engine();
  const single=c.analyzeFrequencyPlan(devices([600000]),{1:600000},options);
  assert.equal(single.minImdMarginKHz,null);assert.equal(single.minChannelSpacingKHz,null);
  const profile=copy(p.resolveEquipmentProfile({brand:'DATYaudio'}));profile.id='no-source';profile.intermodSource=false;
  p.saveCustomEquipmentProfile(profile);
  const d=devices([600000,601000,602000]).map(x=>({...x,equipmentProfileId:'no-source'}));
  assert.equal(c.analyzeFrequencyPlan(d,{1:600000,2:601000,3:602000},options).totalImdProducts,0);
});
test('fixed occupied carriers contribute IMD sources as well as direct guards',()=>{
  const {c}=engine(),d=devices([602000]);
  const result=c.analyzeFrequencyPlan(d,{1:602000},{...options,knownCarriers:[{id:'A',frequencyKHz:600000,guardKHz:100},{id:'B',frequencyKHz:601000,guardKHz:100}]});
  assert.ok(result.conflicts.some(x=>x.type==='intermod-3'&&x.sourceCarrierIds.length===2&&x.actualSpacingKHz===0));
});
test('locks are hard constraints, invalid or conflicting locks cannot be silently discarded',()=>{
  const {c}=engine(),d=devices([600000,600000]);
  for(const locks of [[{deviceId:99,frequencyKHz:600000}],[{deviceId:1,frequencyKHz:600013}],
    [{deviceId:1,frequencyKHz:600000},{deviceId:1,frequencyKHz:601000}],
    [{deviceId:1,frequencyKHz:600000},{deviceId:2,frequencyKHz:600000}]]) {
    const result=c.coordinateFrequencies(d,{...options,lockedAssignments:locks});
    assert.equal(result.assignments.length,0);assert.ok(result.errors.length);
  }
  const result=c.coordinateFrequencies(d,{...options,lockedAssignments:[{deviceId:1,frequencyKHz:601000}]});
  assert.equal(result.assignments[0].frequencyKHz,601000);assert.equal(result.assignments[0].locked,true);
});
test('one shared validator covers exclusions, range, grid and fixed occupancy',()=>{
  const {c}=engine(),d=devices([600000]);
  for(const [freq,extra,type] of [[600000,{excludedRanges:[{startKHz:600000,endKHz:600000}]},'excluded-range'],
    [600000,{knownCarriers:[{frequencyKHz:600000,guardKHz:100}]},'known-carrier'],
    [599000,{},'tuning-range'],[600013,{},'frequency-grid']]) {
    assert.ok(c.analyzeFrequencyPlan(d,{1:freq},{...options,...extra}).conflicts.some(x=>x.type===type));
  }
});
test('search cap reports truncation and only returns verified partial assignments',()=>{
  const {c}=engine(),d=devices(Array(4).fill(600000));
  const result=c.coordinateFrequencies(d,{...options,maxSearchNodes:1});
  assert.equal(result.search.truncated,true);assert.equal(result.search.nodes,1);
  assert.equal(result.analysis.conflicts.length,0);assert.ok(result.unassignedDeviceIds.length);
});
test('backup frequencies pass conservative all-primary/all-backup validation',()=>{
  const {c}=engine(),d=devices([600000,600000,600000]);
  const result=c.coordinateFrequencies(d,{...options,backupCount:1});
  const all=[];for(const item of result.assignments)for(const f of [item.frequencyKHz,...item.backupFrequenciesKHz])all.push(f);
  assert.equal(all.length,6);
  const combined=devices(all);
  assert.equal(c.analyzeFrequencyPlan(combined,new Map(combined.map(x=>[x.id,x.freq])),options).conflicts.length,0);
});
test('all invalid core inputs fail explicitly instead of coercing or crashing',()=>{
  const {c}=engine();
  for(const change of [{stepKHz:0},{stepKHz:NaN},{backupCount:'1'},{maxSearchNodes:Infinity},{imdOrders:[11]},
    {knownCarriers:[{frequencyKHz:600000,guardKHz:0}]},{compatibilityLevel:'missing'}]) assert.throws(()=>c.coordinateFrequencies(devices([600000]),{...options,...change}));
  assert.throws(()=>c.coordinateFrequencies([{id:1},{id:'1'}],options));
  assert.throws(()=>c.analyzeFrequencyPlan(devices([600000]),{99:600000},options));
});

test('CSV actual numeric values, units, comments, duplicate peaks and decimal comma',()=>{
  const {csv}=engine();
  const mhz=csv.parseScanCsv(fs.readFileSync(path.join(__dirname,'fixtures/scan-reference-mhz.csv'),'utf8'));
  assert.equal(mhz.points.length,21);assert.equal(mhz.points[5].levelDbm,-40);assert.equal(mhz.points[5].frequencyKHz,600500);
  const khz=csv.parseScanCsv(fs.readFileSync(path.join(__dirname,'fixtures/scan-reference-khz.csv'),'utf8'));
  assert.equal(khz.duplicateRows,1);assert.equal(khz.points[1].levelDbm,-40);
  const comma=csv.parseScanCsv('Frequency (MHz);Level (dBm)\n"600,000";"-90,5"\n"600,100";"-91,5"');
  assert.deepEqual(copy(comma.points),[{frequencyKHz:600000,levelDbm:-90.5},{frequencyKHz:600100,levelDbm:-91.5}]);
  const hz=csv.parseScanCsv('Frequency (Hz)\tPower (dBm)\n600000000\t-90\n600100000\t-95');
  assert.equal(hz.points[1].frequencyKHz,600100);
});
test('CSV rejects empty power, uncalibrated units, missing units and malformed rows',()=>{
  const {csv}=engine();
  assert.throws(()=>csv.parseScanCsv('Frequency,Level (dBm)\n600,-90\n601,-91',{frequencyUnit:'AUTO'}),/单位缺失/);
  assert.throws(()=>csv.parseScanCsv(fs.readFileSync(path.join(__dirname,'fixtures/scan-invalid-empty.csv'),'utf8')),/第 3 行/);
  for(const bad of ['Frequency,Level\n600,-90\n601,-91','Frequency (MHz),Level (dBFS)\n600,-90\n601,-91',
    'Frequency (MHz),Level (dBm)\n600 kHz,-90\n601,-91','Frequency (MHz),Level (dBm)\n600,-90,extra\n601,-91',
    'Frequency (MHz),Level (dBm)\n"600,-90\n601,-91']) assert.throws(()=>csv.parseScanCsv(bad));
});
test('scan coverage/gaps and window peaks cannot masquerade as clean frequencies',()=>{
  const {c,csv}=engine();
  const points=csv.parseScanCsv(fs.readFileSync(path.join(__dirname,'fixtures/scan-reference-mhz.csv'),'utf8')).points;
  const result=c.coordinateFrequencies(devices([600000,600000]),{...options,rangeEndKHz:603000,scanPoints:points});
  assert.equal(result.assignments.length,2);
  assert.ok(result.assignments.every(x=>x.frequencyKHz>=600175&&x.frequencyKHz<=601825&&x.scanLevelDbm===-100));
  const outside=c.analyzeFrequencyPlan(devices([602500]),{1:602500},{...options,scanPoints:points});
  assert.ok(outside.conflicts.some(x=>x.type==='scan-uncovered'));
  const scan=c.prepareScan([{frequencyKHz:600000,levelDbm:-100},{frequencyKHz:602000,levelDbm:-100}]);
  assert.equal(scan.window(601000,175,200).reason,'scan-gap');
  const peak=c.prepareScan(points).window(600500,175,200);assert.equal(peak.levelDbm,-40);
});
test('no scan is explicitly unknown, not a made-up margin or fake measured level',()=>{
  const result=engine().c.coordinateFrequencies(devices([600000]),options);
  assert.equal(result.assignments[0].scanLevelDbm,null);
  assert.equal(result.assignments[0].score,null);
  assert.ok(result.warnings.some(x=>x.includes('没有真实扫描')));
});
test('Profile rejects NaN, string values, invalid bands, modes and grid settings',()=>{
  const {p}=engine(),base=copy(p.resolveEquipmentProfile({brand:'DATYaudio'}));
  assert.deepEqual(copy(p.validateEquipmentProfile(base)),[]);
  for(const change of [x=>x.compatibility.standard.channelSpacingKHz=NaN,x=>x.compatibility.standard.channelSpacingKHz='350',
    x=>x.bands[0].tuningRangeKHz=[600,650],x=>x.defaultBandId='missing',x=>x.defaultModeId='missing',
    x=>x.modes.push(copy(x.modes[0])),x=>x.intermodSource='false',x=>x.frequencyStepKHz=0,x=>x.models={}]) {
    const broken=copy(base);change(broken);assert.ok(p.validateEquipmentProfile(broken).length);
  }
  assert.throws(()=>p.resolveEquipmentProfile({equipmentProfileId:'missing'}));
  assert.throws(()=>p.getProfileTuningRange(base,'missing'));
  assert.throws(()=>p.getCompatibilitySettings(base,'standard','missing'));
  assert.equal(p.isProfileDeploymentEligible(base),false);
});
test('Profile batch import is atomic and exact band/grid constrains planning',()=>{
  const {p,c,values}=engine(),base=copy(p.resolveEquipmentProfile({brand:'DATYaudio'}));
  base.id='lab-band';base.bands[0].tuningRangeKHz=[600000,601000];base.frequencyStepKHz=100;base.frequencyOriginKHz=0;
  const broken=copy(base);broken.id='bad';broken.defaultBandId='missing';
  assert.throws(()=>p.saveCustomEquipmentProfiles([base,broken]));assert.equal(values.has(p.STORAGE_KEY),false);
  p.saveCustomEquipmentProfile(base);
  const result=c.coordinateFrequencies(devices([600000,600000]).map(x=>({...x,equipmentProfileId:base.id})),options);
  assert.ok(result.assignments.every(x=>x.frequencyKHz>=600000&&x.frequencyKHz<=601000&&x.frequencyKHz%100===0));
  assert.equal(result.profileSnapshots[0].profile.id,base.id);
});
test('payload unit boundaries are consistent and explicit invalid fields clear stale frequency',()=>{
  const {f}=engine();
  assert.equal(f.frequencyFromPayload({freq:641.25,frequency_unit:'MHz'}),641250);
  assert.equal(f.frequencyFromPayload({frequency_hz:641250000}),641250);
  assert.equal(f.frequencyFromPayload({frequencyKHz:null,freq:641250},620000),null);
  assert.equal(f.frequencyFromPayload({},620000),620000);
  assert.equal(f.frequencyFromPayload({freq:641.25,frequency_unit:null,freq_unit:'MHz'}),null);
});

test('greedy is deterministic, never backtracks, and does not claim cardinality optimality',()=>{
  const {c}=engine(),d=devices(Array(3).fill(600000));
  const input={...options,rangeEndKHz:601250,solver:'greedy',backupCount:0};
  const result=c.coordinateFrequencies(d,input);
  assert.equal(result.analysis.conflicts.length,0);
  assert.ok(result.warnings.some(x=>x.includes('不保证最大')));
  assert.deepEqual(copy(c.coordinateFrequencies(d,input)),copy(result));
});

test('malformed nested Profile JSON always produces validation errors',()=>{
  const {p}=engine(),base=copy(p.resolveEquipmentProfile({brand:'DATYaudio'}));
  for(const change of [x=>x.id={},x=>x.manufacturer=1,x=>x.compatibility={standard:null},
    x=>x.bands=[null,[]],x=>x.modes=[{id:'standard',settings:null}],x=>x.provenance={title:[]},
    x=>x.bands=null,x=>x.modes=null]) {
    const bad=copy(base);change(bad);assert.ok(p.validateEquipmentProfile(bad).length);
  }
});

test('Profile import never overwrites corrupt existing storage including JSON null',()=>{
  const {p,values}=engine(),base=copy(p.resolveEquipmentProfile({brand:'DATYaudio'}));base.id='new-custom';
  for(const raw of ['null','{}','[null]','not JSON']) {
    values.set(p.STORAGE_KEY,raw);
    assert.throws(()=>p.saveCustomEquipmentProfile(base));
    assert.equal(values.get(p.STORAGE_KEY),raw);
  }
});
