const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/modules/spectrum.js'),'utf8');
function harness(extra={}){
  const c=vm.createContext(extra);
  vm.runInContext(source,c);
  vm.runInContext('Math.random=()=>{throw new Error("Random spectrum data forbidden");};',c);
  return c;
}
const plain=value=>JSON.parse(JSON.stringify(value));
const device=(id,freq,rf,extra={})=>({_fasheId:id,freq,rf,...extra});
const fixed=[device('rx_ch1',640500,-50),device('rx_ch2',641000,-70),device('rx_ch3',641500,-40)];
function pointAt(result,frequencyKHz){
  const point=result.points.find(p=>Math.abs(p.frequencyKHz-frequencyKHz)<1e-7);
  assert.ok(point,`Missing required frequency anchor ${frequencyKHz} kHz`);
  return point.levelDbm;
}
function near(actual,expected){assert.ok(Math.abs(actual-expected)<1e-8,`${actual} differs from ${expected}`);}
function checkMetadata(result,channels,frequencies,missing=0){
  assert.equal(result.kind,'device-rf-illustration');
  assert.equal(result.baselineDbm,-90);
  assert.equal(result.channelCount,channels);
  assert.equal(result.frequencyCount,frequencies);
  assert.equal(result.missingRfCount,missing);
}

test('RF illustration fixed reference passes through each actual peak and midpoint baseline',()=>{
  const c=harness(),result=c.buildDeviceRfEnvelope(fixed,640,642);
  checkMetadata(result,3,3);
  for(const [frequency,level] of [[640000,-90],[640250,-70],[640500,-50],[640750,-90],
    [641000,-70],[641250,-90],[641500,-40],[642000,-90]])near(pointAt(result,frequency),level);
  assert.equal(result.points.length,6*12+1);
  for(let i=1;i<result.points.length;i++)assert.ok(result.points[i].frequencyKHz>result.points[i-1].frequencyKHz);
});

test('each anchor segment uses deterministic half-cosine interpolation without overshoot',()=>{
  const result=harness().buildDeviceRfEnvelope([device('one',641000,-50)],640,642);
  assert.equal(result.points.length,25);
  for(let i=0;i<=12;i++){
    near(result.points[i].frequencyKHz,640000+1000*i/12);
    near(result.points[i].levelDbm,-90+40*(1-Math.cos(Math.PI*i/12))/2);
    near(result.points[12+i].frequencyKHz,641000+1000*i/12);
    near(result.points[12+i].levelDbm,-50-40*(1-Math.cos(Math.PI*i/12))/2);
  }
  assert.ok(result.points.every(p=>p.levelDbm>=-90&&p.levelDbm<=-50));
});

test('coincident channels use the strongest RF for illustration, never add receiver powers',()=>{
  const c=harness(),input=[...fixed,device('other_rx_ch1',641000,-45),device('third_rx_ch2','641000','-60')];
  const result=c.buildDeviceRfEnvelope(input,640,642);
  checkMetadata(result,5,3);
  assert.equal(pointAt(result,641000),-45);
  assert.equal(result.points.length,73);
  assert.deepEqual(plain(result),plain(c.buildDeviceRfEnvelope([...input].reverse(),640,642)));
});

test('range boundary peaks override baseline and retain a valley between the two boundary channels',()=>{
  const c=harness(),both=c.buildDeviceRfEnvelope([device('left',640000,-60),device('right',642000,-35)],640,642);
  checkMetadata(both,2,2);
  assert.equal(pointAt(both,640000),-60);assert.equal(pointAt(both,641000),-90);assert.equal(pointAt(both,642000),-35);
  assert.equal(both.points.length,25);
  const left=c.buildDeviceRfEnvelope([device('left',640000,-60)],640,642);
  assert.equal(left.points.length,13);assert.equal(left.points[0].levelDbm,-60);assert.equal(left.points.at(-1).levelDbm,-90);
  const right=c.buildDeviceRfEnvelope([device('right',642000,-35)],640,642);
  assert.equal(right.points.length,13);assert.equal(right.points[0].levelDbm,-90);assert.equal(right.points.at(-1).levelDbm,-35);
});

test('only online current FAshe channels with valid in-range positive integer kHz contribute',()=>{
  const invalidFrequency=[null,undefined,'',true,false,NaN,Infinity,640500.5,0,-1,'bad'];
  const input=[device('valid',641000,-50),device('valid-string','641250',' -60 '),
    device('offline',641500,-40,{status:'offline'}),device('offline-flag',641500,-40,{_online:false}),
    device('',641500,-40),{freq:641500,rf:-40},device('low',639999,-40),device('high',642001,-40),
    ...invalidFrequency.map((freq,i)=>device('bad'+i,freq,-40)),null,undefined];
  const result=harness().buildDeviceRfEnvelope(input,640,642);
  checkMetadata(result,2,2);assert.equal(pointAt(result,641000),-50);assert.equal(pointAt(result,641250),-60);
});

test('RF validation rejects missing, empty, Boolean and non-finite values instead of manufacturing 0 dBm',()=>{
  const badRf=[null,undefined,'','  ',true,false,NaN,Infinity,-Infinity,'bad',{},[],-150.01,20.01];
  const input=badRf.map((rf,i)=>device('bad_rf_'+i,640000+i*10,rf));
  const c=harness(),empty=c.buildDeviceRfEnvelope(input,640,642);
  checkMetadata(empty,0,0,badRf.length);assert.deepEqual(plain(empty.points),[]);
  const withPeak=c.buildDeviceRfEnvelope([...input,device('good',641000,'-55')],640,642);
  checkMetadata(withPeak,1,1,badRf.length);assert.equal(pointAt(withPeak,641000),-55);
});

test('RF input validation accepts -150 through 20 dBm but displayed peaks clamp to -90 through -30',()=>{
  const rfValues=[-150,-120,-90,-55,-30,0,20];
  const result=harness().buildDeviceRfEnvelope(rfValues.map((rf,i)=>device('bounded'+i,640000+i*250,rf)),640,642);
  checkMetadata(result,7,7);
  rfValues.forEach((rf,i)=>assert.equal(pointAt(result,640000+i*250),Math.max(-90,Math.min(-30,rf))));
  assert.ok(result.points.every(p=>p.levelDbm>=-90&&p.levelDbm<=-30));
});

test('missing RF counts only eligible visible channels and same-frequency valid telemetry still forms a peak',()=>{
  const result=harness().buildDeviceRfEnvelope([device('missing',641000,null),device('good',641000,-60),
    device('not-visible',650000,null),device('offline',641250,null,{status:'offline'}),{freq:641000,rf:null}],640,642);
  checkMetadata(result,1,1,1);assert.equal(pointAt(result,641000),-60);
});

test('empty inputs and invalid ranges produce no fabricated baseline trace',()=>{
  const c=harness();
  for(const input of [[],null,undefined,{}]){
    const result=c.buildDeviceRfEnvelope(input,640,642);checkMetadata(result,0,0);assert.deepEqual(plain(result.points),[]);
  }
  for(const [start,end] of [[642,640],[640,640],[NaN,642],[640,NaN],[640,Infinity],[-Infinity,642],[640,Number.MAX_VALUE],[Number.MAX_VALUE/2,Number.MAX_VALUE]]){
    const result=c.buildDeviceRfEnvelope(fixed,start,end);checkMetadata(result,0,0);assert.deepEqual(plain(result.points),[]);
  }
});

test('wide-range dense 250 kHz channels keep every peak and valley rather than disappearing in global resampling',()=>{
  const input=Array.from({length:50},(_,i)=>device('dense'+i,641000+i*250,-40-i%5));
  const result=harness().buildDeviceRfEnvelope(input,400,900);
  checkMetadata(result,50,50);assert.equal(result.points.length,100*12+1);
  assert.equal(result.points[0].frequencyKHz,400000);assert.equal(result.points.at(-1).frequencyKHz,900000);
  input.forEach((d,i)=>{assert.equal(pointAt(result,d.freq),d.rf);if(i)assert.equal(pointAt(result,d.freq-125),-90);});
});

test('live RF, frequency and offline changes replace the illustration without stale points',()=>{
  const c=harness(),input=[device('live',641000,-50)];
  assert.equal(pointAt(c.buildDeviceRfEnvelope(input,640,642),641000),-50);
  input[0].rf=-70;assert.equal(pointAt(c.buildDeviceRfEnvelope(input,640,642),641000),-70);
  input[0].freq=641500;
  const moved=c.buildDeviceRfEnvelope(input,640,642);assert.equal(pointAt(moved,641500),-70);
  input[0]._online=false;assert.deepEqual(plain(c.buildDeviceRfEnvelope(input,640,642).points),[]);
});

test('illustration follows the existing authoritative connection predicate when provided',()=>{
  const c=harness({_deviceConnectionIsOnline:d=>d.linkGood===true});
  const result=c.buildDeviceRfEnvelope([device('up',641000,-50,{linkGood:true}),device('down',641250,-35,{linkGood:false})],640,642);
  checkMetadata(result,1,1);assert.equal(pointAt(result,641000),-50);
});

test('drawing preparation is deterministic, does not mutate channels or depend on coordination/profile bandwidth',()=>{
  const input=fixed.map(d=>Object.freeze({...d,get equipmentProfileId(){throw Error('No profile used to invent bandwidth');},
    get minimumChannelSpacingKHz(){throw Error('Spacing is not occupied bandwidth');},
    get occupiedBandwidthKHz(){throw Error('Do not invent a physical spectral shape');}}));
  Object.freeze(input);
  const c=harness({DatyEquipmentProfiles:new Proxy({}, {get(){throw Error('No profile dependency for illustrative geometry');}})});
  const first=c.buildDeviceRfEnvelope(input,640,642),second=c.buildDeviceRfEnvelope(input,640,642);
  assert.deepEqual(plain(first),plain(second));assert.equal(input[0].freq,640500);assert.equal(input[0].rf,-50);
  assert.deepEqual(plain(first),plain(c.buildDeviceRfEnvelope([input[2],input[0],input[1]],640,642)));
});

test('device RF illustration never becomes real imported scan or algorithm data',()=>{
  const c=harness();
  assert.deepEqual(plain(c.getCurrentScanPoints()),[]);
  c.buildDeviceRfEnvelope(fixed,640,642);
  assert.deepEqual(plain(c.getCurrentScanPoints()),[]);assert.deepEqual(plain(c.generateSpectrumFromDevices()),[]);
  vm.runInContext("scanSource='imported';importedScanPoints=[{frequencyKHz:640000,levelDbm:-88},{frequencyKHz:642000,levelDbm:-86}];scanData=[.1,.2]",c);
  const before=plain(c.getCurrentScanPoints());
  c.buildDeviceRfEnvelope(fixed,640,642);
  assert.deepEqual(plain(c.getCurrentScanPoints()),before);
  assert.deepEqual(plain(vm.runInContext('scanData',c)),[.1,.2]);
  assert.deepEqual(plain(c.generateSpectrumFromDevices()),[]);
});
