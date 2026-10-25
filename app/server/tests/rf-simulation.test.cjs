const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/modules/rf-simulation.js'),'utf8');
const profileSource=fs.readFileSync(path.join(__dirname,'../src/modules/equipment-profiles.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const device=(id,freq,rf,extra={})=>({_fasheId:id,freq,rf,brand:'DATYaudio',...extra});
const range={startMHz:640,endMHz:642};
function harness(extra={},profiles=true){
  const context=vm.createContext({localStorage:{getItem:()=>null,setItem:()=>{throw Error('Storage write forbidden');}},...extra});
  context.window=context;
  if(profiles)vm.runInContext(profileSource,context);
  vm.runInContext(source,context);
  vm.runInContext('Math.random=()=>{throw Error("Random forbidden")};Date.now=()=>{throw Error("Time forbidden")}',context);
  return context.DatyRfSimulation;
}
function near(actual,expected,tolerance=1e-8){assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);}

test('fixed carrier has exact half-power full width, independent of DATY 250 kHz channel protection',()=>{
  const api=harness(),result=api.build([device('a',641000,-45)],range,{rippleDb:0,includeImd:false});
  assert.equal(result.kind,'rf-interference-simulation');
  assert.equal(result.carriers[0].channelSpacingKHz,250);
  assert.equal(result.options.peakWidthKHz,100);
  assert.equal(api.levelAt(result,641000),-45);
  near(api.levelAt(result,640950),-48.01029995663981);
  near(api.levelAt(result,641050),-48.01029995663981);
  near(api.levelAt(result,641100),-57.04119982655925);
  const halfWidth=100*Math.sqrt(30/(40*Math.log10(2)));
  assert.equal(result.ranges.length,1);
  near(result.ranges[0].startKHz,641000-halfWidth);
  near(result.ranges[0].endKHz,641000+halfWidth);
  assert.deepEqual(plain(result.guardRanges),[{startKHz:640750,endKHz:641250,openStart:true,openEnd:true}]);
  // A second center at 250 kHz is on the allowed boundary; 249 kHz is inside the exclusion range.
  assert.equal(641250-result.carriers[0].frequencyKHz,result.carriers[0].channelSpacingKHz);
  assert.ok(641249>result.guardRanges[0].startKHz&&641249<result.guardRanges[0].endKHz);
});

test('coincident receiver RSSI uses maximum rather than addition and does not produce fake IMD',()=>{
  const api=harness(),input=[device('a',641000,-45),device('b','641000','-60'),device('c',641000,-48)];
  const result=api.build(input,range);
  assert.equal(result.stats.channelCount,3);assert.equal(result.stats.frequencyCount,1);
  assert.equal(result.carriers[0].peakDbm,-45);assert.equal(api.levelAt(result,641000),-45);
  assert.deepEqual(plain(result.products),[]);
  assert.deepEqual(plain(result),plain(api.build([...input].reverse(),range)));
});

test('third and fifth order two-tone products have exact integer kHz centers and explicit assumed levels',()=>{
  const api=harness(),input=[device('a',641000,-35),device('b',641250,-40)];
  const result=api.build(input,range,{includeFifth:true,rippleDb:0});
  assert.deepEqual(plain(result.products.map(p=>[p.frequencyKHz,p.order,p.peakDbm])),[
    [640500,5,-80],[640750,3,-70],[641500,3,-70],[641750,5,-80]]);
  for(const product of result.products)assert.deepEqual(plain(product.sourceFrequenciesKHz),[641000,641250]);
  for(const f of [640750,641500]){
    assert.ok(result.ranges.some(r=>r.startKHz<=f&&r.endKHz>=f),'IMD3 above threshold must be marked');
    assert.equal(api.levelAt(result,f),-70);
  }
  for(const f of [640500,641750])assert.ok(!result.ranges.some(r=>r.startKHz<=f&&r.endKHz>=f),'IMD5 below threshold is not above-threshold interference');
  const noImd=api.build(input,range,{includeImd:false,includeFifth:true});
  assert.equal(noImd.products.length,0);assert.equal(noImd.stats.imdProductCount,0);
});

test('weak two-tone products retain theoretical guard zones without claiming above-threshold interference',()=>{
  const api=harness(),result=api.build([device('a',641000,-50),device('b',641250,-55)],range);
  assert.deepEqual(plain(result.products.map(p=>p.peakDbm)),[-85,-85]);
  for(const f of [640750,641500]){
    assert.ok(!result.ranges.some(r=>r.startKHz<=f&&r.endKHz>=f));
    assert.ok(result.guardRanges.some(r=>r.startKHz<=f&&r.endKHz>=f));
  }
});

test('threshold intervals merge, clip at view limits, and scale with model width without altering protection rules',()=>{
  const api=harness(),input=[device('a',641000,-45),device('b',641250,-45)];
  const result=api.build(input,range,{includeImd:false,rippleDb:0});
  const halfWidth=100*Math.sqrt(30/(40*Math.log10(2)));
  assert.equal(result.ranges.length,1);near(result.ranges[0].startKHz,641000-halfWidth);near(result.ranges[0].endKHz,641250+halfWidth);
  const wide=api.build(input,range,{includeImd:false,peakWidthKHz:200});
  near(wide.ranges[0].startKHz,641000-2*halfWidth);near(wide.ranges[0].endKHz,641250+2*halfWidth);
  assert.deepEqual(plain(wide.guardRanges),plain(result.guardRanges));
  const clipped=api.build(input,{startMHz:641,endMHz:641.25},{includeImd:false});
  assert.deepEqual(plain(clipped.ranges),[{startKHz:641000,endKHz:641250}]);
  const equal=api.build([device('threshold',641000,-75)],range);
  assert.deepEqual(plain(equal.ranges),[{startKHz:641000,endKHz:641000}]);
  const below=api.build([device('below',641000,-75.01)],range);assert.deepEqual(plain(below.ranges),[]);
});

test('view clipping does not discard outside source frequencies needed to produce an inside IMD product',()=>{
  const api=harness(),input=[device('a',639000,-35),device('b',640000,-40)];
  const broad=api.build(input,{startMHz:638,endMHz:643}),narrow=api.build(input,{startMHz:640.8,endMHz:641.2});
  assert.equal(narrow.carriers.length,2);
  assert.ok(narrow.products.some(p=>p.frequencyKHz===641000));
  assert.ok(narrow.ranges.some(r=>r.startKHz<=641000&&r.endKHz>=641000));
  for(const f of [640800,640900,641000,641023.375,641150,641200])assert.equal(api.levelAt(broad,f),api.levelAt(narrow,f));
  assert.ok(narrow.ranges.every(r=>r.startKHz>=640800&&r.endKHz<=641200));
});

test('stable sawtooth texture is nonflat and bounded; smooth interference range never depends on ripple',()=>{
  const api=harness(),input=[device('a',641000,-45)],flat=api.build(input,range,{rippleDb:0}),jagged=api.build(input,range,{rippleDb:2});
  const levels=[];
  for(let i=0;i<100;i++){
    const f=640000+i*.25, a=api.levelAt(flat,f), b=api.levelAt(jagged,f);
    assert.ok(Math.abs(a-b)<=2);levels.push(b);
  }
  assert.ok(new Set(levels).size>90);assert.equal(api.levelAt(jagged,641000),-45);
  assert.deepEqual(plain(jagged.ranges),plain(flat.ranges));
  assert.deepEqual(plain(jagged.guardRanges),plain(flat.guardRanges));
  assert.deepEqual(plain(jagged),plain(api.build(input,range,{rippleDb:2})));
  for(const point of jagged.points)near(point.levelDbm,api.levelAt(jagged,point.frequencyKHz));
});

test('missing or invalid telemetry and offline/demo devices produce no fabricated empty-field curve',()=>{
  const badRf=[null,undefined,'',' ',true,false,NaN,Infinity,-Infinity,{},[],-150.01,20.01];
  const invalid=badRf.map((rf,i)=>device('bad-rf'+i,641000+i,rf));
  const badFreq=[null,undefined,'',' ',true,false,NaN,Infinity,-1,0,641000.25,Number.MAX_SAFE_INTEGER+1];
  invalid.push(...badFreq.map((freq,i)=>device('bad-freq'+i,freq,-45)));
  invalid.push(device('',641000,-45),{freq:641000,rf:-45},device('offline',641000,-45,{status:'offline'}),
    device('disconnected',641000,-45,{online:'false'}),device('zero',641000,-45,{_online:0}),null);
  const api=harness(),result=api.build(invalid,range);
  assert.equal(result.stats.channelCount,badRf.length);assert.equal(result.stats.missingRfCount,badRf.length);
  assert.ok(result.carriers.every(p=>p.peakDbm===null));assert.ok(result.products.every(p=>p.peakDbm===null));
  assert.ok(result.guardRanges.length);assert.equal(result.ranges.length,0);
  assert.deepEqual(plain(result.points),[]);assert.equal(api.levelAt(result,641000),null);
  const boundary=api.build([device('lo',641000,-150),device('hi',641250,20)],range);
  assert.equal(boundary.stats.channelCount,2);assert.equal(boundary.carriers[1].peakDbm,20);
  assert.equal(api.levelAt(boundary,641250),20);
});

test('authoritative online predicate and real RF/frequency updates replace model data',()=>{
  const api=harness({_deviceConnectionIsOnline:d=>d.link===true});
  const input=[device('a',641000,-45,{link:true}),device('b',641250,-30,{link:false})];
  assert.equal(api.build(input,range).stats.channelCount,1);
  input[0].rf=-55;input[0].freq=641500;
  const changed=api.build(input,range);assert.equal(changed.carriers[0].frequencyKHz,641500);assert.equal(api.levelAt(changed,641500),-55);
  input[0].link=false;assert.deepEqual(plain(api.build(input,range).points),[]);
});

test('standalone connection fallback preserves legacy status 0/1 while rejecting explicit false flags',()=>{
  const api=harness(),valid=[0,'0',1,'1','online','warn',undefined].map((status,i)=>device('legacy'+i,641000+i*250,-45,{status}));
  const invalid=[false,'false','no','offline','disconnected','disconnect','connection_lost','connection-lost','timeout','unavailable','lost']
    .map((status,i)=>device('down'+i,641000+i*250,-45,{status}));
  invalid.push(device('flag0',641000,-45,{status:0,_online:0}),device('flagFalse',641000,-45,{status:0,online:false}));
  const result=api.build([...valid,...invalid],{startMHz:640,endMHz:650});
  assert.equal(result.stats.channelCount,valid.length);
});

test('mixed profiles and explicit robust mode change guard distances without changing modeled spectral width',()=>{
  const api=harness(),single=api.build([device('a',641000,-45)],range);
  const robust=api.build([device('a',641000,-45,{equipmentModeId:'robust'})],range);
  assert.equal(single.carriers[0].channelSpacingKHz,250);assert.equal(robust.carriers[0].channelSpacingKHz,250);
  assert.equal(robust.carriers[0].intermodSpacingKHz,150);
  assert.deepEqual(plain(single.points),plain(robust.points));assert.deepEqual(plain(single.ranges),plain(robust.ranges));
  const mixed=api.build([device('a',641000,-35),device('b',641250,-40,{brand:'Shure',equipmentModeId:'robust'})],range);
  assert.equal(mixed.carriers[1].channelSpacingKHz,500);assert.ok(mixed.products.every(p=>p.guardKHz===350));
});

test('unverified Profile presets identify brand and source instead of implying calibrated hardware parameters',()=>{
  const api=harness(),mixed=api.build([device('a',641000,-45),device('b',641500,-45,{brand:'Shure'})],range);
  assert.ok(mixed.warnings.some(text=>text.includes('Shure')&&text.includes('shure-generic')
    &&text.includes('WWB6.15.4-reference')&&text.includes('未核验')&&text.includes('不视为硬件校准')));
  assert.ok(!mixed.warnings.some(text=>text.includes('DATYaudio')&&text.includes('未核验')));
});

test('two-tone source selection matches coordination: skip only when both profiles disable intermod sources',()=>{
  const profileFor=device=>({id:device.sourceEnabled?'enabled':'disabled',manufacturer:'DATYaudio',defaultModeId:'standard',
    intermodSource:device.sourceEnabled===true,provenance:{verified:true,kind:'test',revision:'fixed'},spacingProvenance:{verified:true}});
  const profiles={resolveEquipmentProfile:profileFor,getCompatibilitySettings:()=>({channelSpacingKHz:250,intermodSpacingKHz:250}),getMinimumChannelSpacingKHz:()=>250};
  const api=harness({DatyEquipmentProfiles:profiles},false);
  const a=device('a',641000,-35,{sourceEnabled:false}),b=device('b',641250,-40,{sourceEnabled:false});
  const disabled=api.build([a,b],range,{includeFifth:true});
  assert.equal(disabled.products.length,0);assert.equal(disabled.carriers.length,2);
  b.sourceEnabled=true;
  const mixed=api.build([a,b],range,{includeFifth:true});assert.equal(mixed.products.length,4);
  b.sourceEnabled=false;
  const coincidentEnabled=device('c',641000,-50,{sourceEnabled:true});
  const coincident=api.build([a,b,coincidentEnabled],range);
  assert.equal(coincident.carriers[0].intermodSource,true);assert.equal(coincident.carriers[0].peakDbm,-35);
  assert.equal(coincident.products.length,2);
  assert.deepEqual(plain(coincident),plain(api.build([coincidentEnabled,b,a],range)));
});

test('invalid settings fail before creating plausible but ungrounded values',()=>{
  const api=harness(),input=[device('a',641000,-45)];
  for(const options of [null,[],{peakWidthKHz:0},{peakWidthKHz:Infinity},{peakWidthKHz:'100'},
    {rippleDb:-1},{floorDbm:-60},{thresholdDbm:-90},{includeImd:'true'},{includeFifth:1},{includeThreeTone:1},
    {textureStepKHz:0},{textureStepKHz:Infinity},{textureStepKHz:'5'},{imdSuppressionDb:-1},{unexpected:1}])
    assert.throws(()=>api.build(input,range,options));
  for(const value of [{startMHz:642,endMHz:640},{startMHz:640,endMHz:640},{startMHz:'640',endMHz:642},
    {startMHz:-1,endMHz:1},{startMHz:640,endMHz:Infinity},null])assert.throws(()=>api.build(input,value));
});

test('RF domain accepts the same 30 to 3000 MHz endpoints as frequency.js and rejects out-of-domain sources/views',()=>{
  const api=harness(),input=[device('minimum',30000,-45),device('maximum',3000000,-50),
    device('below',29999,-40),device('above',3000001,-40),device('fraction',641000.5,-40)];
  const result=api.build(input,{startMHz:30,endMHz:3000},{includeImd:false});
  assert.deepEqual(plain(result.carriers.map(p=>p.frequencyKHz)),[30000,3000000]);
  assert.equal(result.points[0].frequencyKHz,30000);assert.equal(result.points.at(-1).frequencyKHz,3000000);
  assert.equal(api.levelAt(result,30000),-45);assert.equal(api.levelAt(result,3000000),-50);
  for(const view of [{startMHz:29.999,endMHz:3000},{startMHz:30,endMHz:3000.001},
    {startMHz:0,endMHz:900},{startMHz:640,endMHz:Number.MAX_SAFE_INTEGER/1000}])assert.throws(()=>api.build(input,view),/30～3000/);
});

test('dense 64-channel scene retains every real carrier anchor and finite ordered samples across a broad view',()=>{
  const api=harness(),input=Array.from({length:64},(_,i)=>device('ch'+i,641000+i*250,-35-i%8));
  const result=api.build(input,{startMHz:400,endMHz:900});
  assert.equal(result.stats.channelCount,64);assert.equal(result.stats.frequencyCount,64);
  for(const item of input){const point=result.points.find(p=>p.frequencyKHz===item.freq);assert.ok(point);assert.equal(point.levelDbm,item.rf);}
  assert.equal(result.points[0].frequencyKHz,400000);assert.equal(result.points.at(-1).frequencyKHz,900000);
  for(let i=1;i<result.points.length;i++)assert.ok(result.points[i].frequencyKHz>result.points[i-1].frequencyKHz&&Number.isFinite(result.points[i].levelDbm));
});

test('IMD computation budget is explicit and never silently omits carriers',()=>{
  const api=harness(),input=Array.from({length:129},(_,i)=>device('ch'+i,641000+i*250,-45));
  const result=api.build(input,{startMHz:600,endMHz:700});
  assert.equal(result.carriers.length,129);assert.equal(result.products.length,0);
  assert.ok(result.warnings.some(text=>text.includes('128')&&text.includes('未计算双频互调')));
  assert.equal(result.coverage.complete,false);assert.equal(result.coverage.twoTone.complete,false);
  assert.equal(result.coverage.threeTone.complete,false);
  assert.equal(result.stats.ruleConflictCount,null);
});

test('large product sets disclose limited fine sampling while retaining full mathematical ranges',()=>{
  const api=harness(),input=Array.from({length:24},(_,i)=>device('ch'+i,641000+i*10007+i*i*37,-35));
  const result=api.build(input,{startMHz:300,endMHz:1500},{includeFifth:true});
  assert.ok(result.products.length>256);assert.equal(result.stats.imdProductCount,result.products.length);
  assert.equal(result.stats.refinedImdCount,256);assert.ok(result.stats.displayedImdCount>256);
  assert.ok(result.warnings.some(text=>text.includes('256')));
  for(const product of result.products.filter(p=>p.peakDbm>=result.options.thresholdDbm&&p.frequencyKHz>=300000&&p.frequencyKHz<=1500000))
    assert.ok(result.ranges.some(r=>product.frequencyKHz>=r.startKHz&&product.frequencyKHz<=r.endKHz));
  for(const point of result.points.filter((_,i)=>i%100===0))near(point.levelDbm,api.levelAt(result,point.frequencyKHz));
  const centers=new Set(result.points.map(p=>p.frequencyKHz));
  for(const product of result.products.filter(p=>p.frequencyKHz>=300000&&p.frequencyKHz<=1500000))
    assert.ok(centers.has(product.frequencyKHz),'Every quantified product center must remain sampled, not only the 256 strongest');
});

test('three distinct carriers produce all three IM3 centers with source kind and explicit scenario amplitude',()=>{
  const api=harness(),input=[device('a',640000,-35),device('b',641000,-40),device('c',644000,-45)];
  const result=api.build(input,{startMHz:635,endMHz:650},{rippleDb:0});
  const products=result.products.filter(p=>p.kind==='three-tone');
  assert.deepEqual(plain(products.map(p=>[p.frequencyKHz,p.order,p.peakDbm])),[[637000,3,-75],[643000,3,-75],[645000,3,-75]]);
  for(const p of products){assert.deepEqual(plain(p.sourceFrequenciesKHz),[640000,641000,644000]);assert.equal(p.sourceCount,1);}
  assert.equal(result.coverage.complete,true);assert.equal(result.coverage.threeTone.requested,true);
  assert.equal(api.build(input,{startMHz:635,endMHz:650},{includeThreeTone:false}).products.filter(p=>p.kind==='three-tone').length,0);
  assert.equal(api.build(input,{startMHz:635,endMHz:650},{includeImd:false,includeFifth:true}).products.length,0);
  assert.ok(result.warnings.some(text=>text.includes('情景假设')&&text.includes('不是同一输入测量点')));
});

test('coincident product centers keep two/three-tone kinds distinct and retain strongest quantified recipe count',()=>{
  const api=harness(),input=[device('a',640000,-35),device('b',641000,-40),device('c',642000,null),device('d',643000,-45)];
  const result=api.build(input,{startMHz:635,endMHz:650});
  const candidates=result.products.filter(p=>p.order===3&&p.frequencyKHz===642000);
  assert.deepEqual(plain(candidates.map(p=>p.kind).sort()),['three-tone','two-tone']);
  const triple=candidates.find(p=>p.kind==='three-tone');
  assert.equal(triple.sourceCount,2);assert.equal(triple.peakDbm,-75);
  assert.deepEqual(plain(triple.sourceFrequenciesKHz),[640000,641000,643000]);
  assert.deepEqual(plain(result),plain(api.build([...input].reverse(),{startMHz:635,endMHz:650})));
});

test('missing RF never removes known frequency sources or invents product powers and threshold regions',()=>{
  const api=harness(),input=[device('a',640000,-35),device('b',641000,null),device('c',644000,-45)];
  const result=api.build(input,{startMHz:635,endMHz:650});
  assert.equal(result.carriers.length,3);assert.equal(result.carriers[1].peakDbm,null);
  const unknown=result.products.filter(p=>p.sourceFrequenciesKHz.includes(641000));
  assert.ok(unknown.length>=5);assert.ok(unknown.every(p=>p.peakDbm===null));
  assert.ok(result.products.filter(p=>!p.sourceFrequenciesKHz.includes(641000)).every(p=>p.peakDbm===-75));
  assert.ok(result.guardRanges.some(r=>api.containsGuardRange(r,643000)));
  assert.ok(!result.possibleRanges.some(r=>r.startKHz<=643000&&r.endKHz>=643000));
  const allUnknown=api.build(input.map(d=>({...d,rf:null})),{startMHz:635,endMHz:650});
  assert.equal(allUnknown.points.length,0);assert.equal(api.levelAt(allUnknown,643000),null);
  assert.equal(allUnknown.ranges.length+allUnknown.possibleRanges.length+allUnknown.certainRanges.length,0);
  assert.ok(allUnknown.products.length>0);assert.ok(allUnknown.guardRanges.length>0);
  const cofrequency=api.build([device('unknown',641000,null),device('known',641000,-45)],range);
  assert.equal(cofrequency.carriers[0].peakDbm,-45);
});

test('scene conservative guards consistently use largest mixed-profile channel and IMD distances',()=>{
  const api=harness(),input=[device('a',641000,-45),device('b',650000,-45,{brand:'Shure',equipmentModeId:'robust'})];
  const result=api.build(input,{startMHz:630,endMHz:660});
  assert.deepEqual(plain(result.guardPolicy),{kind:'scene-conservative',channelSpacingKHz:500,intermodSpacingKHz:350,boundary:'open'});
  assert.ok(result.guardRanges.some(r=>api.containsGuardRange(r,641300)));
  assert.ok(result.products.every(p=>p.guardKHz===350));
});

test('open guard intervals preserve allowed touching frequencies and clipping closes only interior view edges',()=>{
  const api=harness(),input=[device('a',641000,-45),device('b',641500,-45)];
  const result=api.build(input,range,{includeImd:false});
  assert.equal(result.guardRanges.length,2);
  assert.ok(!result.guardRanges.some(r=>api.containsGuardRange(r,641250)));
  assert.ok(result.guardRanges.some(r=>api.containsGuardRange(r,641249)));
  assert.ok(result.guardRanges.some(r=>api.containsGuardRange(r,641251)));
  const left=api.build(input,{startMHz:641,endMHz:641.25},{includeImd:false});
  assert.deepEqual(plain(left.guardRanges),[{startKHz:641000,endKHz:641250,openStart:false,openEnd:true}]);
  assert.equal(api.containsGuardRange(left.guardRanges[0],641000),true);
  const right=api.build(input,{startMHz:641.25,endMHz:641.5},{includeImd:false});
  assert.deepEqual(plain(right.guardRanges),[{startKHz:641250,endKHz:641500,openStart:true,openEnd:false}]);
  assert.equal(api.containsGuardRange(right.guardRanges[0],641500),true);
  const overlapping=api.build([device('a',641000,-45),device('b',641499,-45)],range,{includeImd:false});
  assert.equal(overlapping.guardRanges.length,1);
});

test('possible and certain ranges analytically bound all bounded texture without claiming confidence intervals',()=>{
  const api=harness(),input=[device('a',641000,-45)],result=api.build(input,range);
  const radius=delta=>100*Math.sqrt(delta/(40*Math.log10(2)));
  near(result.ranges[0].endKHz,641000+radius(30));
  near(result.possibleRanges[0].endKHz,641000+radius(32));
  near(result.certainRanges[0].endKHz,641000+radius(28));
  const contains=(list,f)=>list.some(r=>f>=r.startKHz&&f<=r.endKHz);
  for(let i=-1100;i<=1100;i++){
    const f=641000+i*.2,level=api.levelAt(result,f);
    if(level>=-75)assert.ok(contains(result.possibleRanges,f));
    if(contains(result.certainRanges,f))assert.ok(level>=-75);
  }
  const smooth=api.build(input,range,{rippleDb:0});
  assert.deepEqual(plain(smooth.ranges),plain(smooth.possibleRanges));assert.deepEqual(plain(smooth.ranges),plain(smooth.certainRanges));
  const samples=new Set(result.points.map(p=>p.frequencyKHz));
  for(const ranges of [result.ranges,result.possibleRanges,result.certainRanges])for(const r of ranges){assert.ok(samples.has(r.startKHz));assert.ok(samples.has(r.endKHz));}
});

test('fixed multiscale texture is continuous on lattice boundaries and independent of view zoom',()=>{
  const api=harness(),input=[device('a',641000,-45)],broad=api.build(input,{startMHz:400,endMHz:900});
  const narrow=api.build(input,{startMHz:640,endMHz:640.05});
  for(const f of [640000,640000.25,640005,640010,640011.25,640049.9]){
    assert.equal(api.levelAt(broad,f),api.levelAt(narrow,f));
    assert.ok(Math.abs(api.levelAt(broad,f-.000001)-api.levelAt(broad,f+.000001))<.001);
  }
  const coarse=api.build(input,range,{textureStepKHz:10});
  assert.notEqual(api.levelAt(coarse,640013.375),api.levelAt(broad,640013.375));
  assert.equal(api.levelAt(coarse,641000),-45);
});

test('upper-envelope lookup agrees with brute-force max across diverse IMD peaks and large widths',()=>{
  const api=harness(),input=Array.from({length:12},(_,i)=>device('p'+i,641000+i*1729+i*i*23,-35-(i*13)%45));
  for(const peakWidthKHz of [5,100,1000]){
    const result=api.build(input,{startMHz:600,endMHz:700},{rippleDb:0,peakWidthKHz,includeFifth:true});
    const peaks=[...result.carriers,...result.products].filter(p=>Number.isFinite(p.peakDbm));
    for(let i=0;i<=256;i++){
      const f=600000+i*100000/256;
      let expected=result.options.floorDbm;
      for(const p of peaks)expected=Math.max(expected,p.peakDbm-40*Math.log10(2)*((f-p.frequencyKHz)/peakWidthKHz)**2);
      near(api.levelAt(result,f),expected);
    }
    for(const point of result.points.filter((_,i)=>i%77===0))near(point.levelDbm,api.levelAt(result,point.frequencyKHz));
  }
});

test('three-tone source eligibility matches coordination and budgets remain explicit at 50/65 channels',()=>{
  const profileFor=d=>({id:'fixed',manufacturer:'DATYaudio',defaultModeId:'standard',intermodSource:d.enabled===true,
    provenance:{verified:true},spacingProvenance:{verified:true}});
  const profiles={resolveEquipmentProfile:profileFor,getCompatibilitySettings:()=>({channelSpacingKHz:250,intermodSpacingKHz:250}),getMinimumChannelSpacingKHz:()=>250};
  const api=harness({DatyEquipmentProfiles:profiles},false),input=[device('a',640000,-45),device('b',641000,-45),device('c',644000,-45)];
  assert.equal(api.build(input,{startMHz:635,endMHz:650}).products.length,0);
  input[0].enabled=true;
  assert.equal(api.build(input,{startMHz:635,endMHz:650}).products.filter(p=>p.kind==='three-tone').length,3);
  const standard=harness(),fifty=Array.from({length:50},(_,i)=>device('ch'+i,641000+i*1009+i*i*37,-35-i%12));
  const result=standard.build(fifty,{startMHz:400,endMHz:900});
  assert.equal(result.coverage.complete,true);assert.ok(result.products.some(p=>p.kind==='three-tone'));
  const centers=new Set(result.points.map(p=>p.frequencyKHz));
  for(const p of result.products.filter(p=>p.frequencyKHz>=400000&&p.frequencyKHz<=900000))assert.ok(centers.has(p.frequencyKHz));
  const sixtyFive=Array.from({length:65},(_,i)=>device('ch'+i,641000+i*250,-45));
  const partial=standard.build(sixtyFive,{startMHz:400,endMHz:900});
  assert.equal(partial.coverage.twoTone.complete,true);assert.equal(partial.coverage.threeTone.complete,false);assert.equal(partial.coverage.complete,false);
  assert.ok(partial.products.length);assert.ok(partial.products.every(p=>p.kind==='two-tone'));
  assert.equal(standard.build(sixtyFive,{startMHz:400,endMHz:900},{includeThreeTone:false}).coverage.complete,true);
});

test('simulation is read-only and cannot modify real scans, source channels, or planner data',()=>{
  const scan=Object.freeze([{frequencyKHz:641000,levelDbm:-80}]),plan=Object.freeze({frequencies:Object.freeze([641000])});
  const protectedDevice=Object.defineProperty(device('a',641000,-45),'occupiedBandwidthKHz',
    {get(){throw Error('Unknown physical bandwidth is not an input');}});
  const input=Object.freeze([Object.freeze(protectedDevice)]);
  const api=harness({importedScanPoints:scan,scanData:scan,planningResult:plan,
    fetch:()=>{throw Error('Network forbidden')},showToast:()=>{throw Error('UI side effect forbidden')}});
  const before=JSON.stringify(input),first=api.build(input,range);
  assert.deepEqual(plain(first),plain(api.build(input,range)));assert.equal(JSON.stringify(input),before);
  assert.deepEqual(scan,[{frequencyKHz:641000,levelDbm:-80}]);assert.deepEqual(plan,{frequencies:[641000]});
});

function legacyProfileHarness(){
  const legacy={id:'legacy-rf-500',manufacturer:'DATYaudio',models:['legacy-fixture'],
    tuningRangeKHz:[400000,900000],intermodSource:true,priority:10,
    compatibility:{
      robust:{channelSpacingKHz:500,intermodSpacingKHz:350,scanThresholdDbm:-85},
      standard:{channelSpacingKHz:500,intermodSpacingKHz:350,scanThresholdDbm:-78},
      'more-frequencies':{channelSpacingKHz:500,intermodSpacingKHz:350,scanThresholdDbm:-72}
    }};
  const original=JSON.stringify([legacy]),values=new Map([['daty_equipment_profiles_v1',original]]),writes=[];
  const c=vm.createContext({localStorage:{getItem:key=>values.get(key)??null,
    setItem:(key,value)=>{writes.push([key,value]);values.set(key,value);}}});c.window=c;
  vm.runInContext(profileSource,c);vm.runInContext(source,c);
  return {c,values,writes,original,channel:device('legacy',641000,-45,{equipmentProfileId:legacy.id})};
}

test('RF simulation reads legacy custom Profile guards without persisting its schema migration',()=>{
  const h=legacyProfileHarness(),profiles=h.c.DatyEquipmentProfiles;
  assert.equal(profiles.loadCustomEquipmentProfiles({persistMigration:false})[0].id,'legacy-rf-500');
  assert.ok(profiles.getAllEquipmentProfiles({persistMigration:false}).some(p=>p.id==='legacy-rf-500'));
  const result=h.c.DatyRfSimulation.build([h.channel],range,{includeImd:false});
  assert.equal(result.carriers[0].channelSpacingKHz,500);
  assert.equal(result.carriers[0].intermodSpacingKHz,350);
  assert.deepEqual(plain(result.guardRanges),[{startKHz:640500,endKHz:641500,openStart:true,openEnd:true}]);
  assert.deepEqual(h.writes,[]);
  assert.equal(h.values.has(profiles.STORAGE_KEY),false);
  assert.equal(h.values.get('daty_equipment_profiles_v1'),h.original);
});

test('default Profile resolution still persists the existing legacy schema upgrade exactly once',()=>{
  const h=legacyProfileHarness(),profiles=h.c.DatyEquipmentProfiles;
  const resolved=profiles.resolveEquipmentProfile(h.channel);
  assert.equal(resolved.id,'legacy-rf-500');
  assert.equal(profiles.getCompatibilitySettings(resolved,'standard').channelSpacingKHz,500);
  assert.equal(h.writes.length,1);assert.equal(h.writes[0][0],profiles.STORAGE_KEY);
  const migrated=JSON.parse(h.values.get(profiles.STORAGE_KEY))[0];
  assert.equal(migrated.id,'legacy-rf-500');assert.ok(migrated.bands.length&&migrated.modes.length);
  assert.equal(migrated.provenance.revision,'v1-migrated');
  profiles.resolveEquipmentProfile(h.channel);assert.equal(h.writes.length,1);
  assert.equal(h.values.get('daty_equipment_profiles_v1'),h.original);
});
