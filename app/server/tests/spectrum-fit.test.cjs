const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/modules/spectrum.js'),'utf8');
function harness(extra={}){const c=vm.createContext(extra);vm.runInContext(source,c);return c;}
test('fit spreads regular 2/4/8/50-channel frequency sets into equal slots over full viewport',()=>{
 const c=harness();for(const count of [2,4,8,50]){
  const devices=Array.from({length:count},(_,i)=>({freq:641000+i*250})),before=JSON.stringify(devices);
  const [start,end]=c.calculateSpectrumFitRange(devices);
  devices.forEach((d,i)=>assert.ok(Math.abs(c.spectrumFrequencyX(d.freq,start,end,1000)-(i+.5)*1000/count)<1e-7));
  assert.equal(JSON.stringify(devices),before);
 }
 assert.deepEqual(Array.from(c.calculateSpectrumFitRange(Array.from({length:50},(_,i)=>({freq:641000+i*250})))),[640.875,653.375]);
});
test('fit rejects absent/invalid frequencies, deduplicates same-frequency channels and centers one point',()=>{
 const c=harness();assert.equal(c.calculateSpectrumFitRange([{},null,{freq:null},{freq:''},{freq:true},{freq:NaN},{freq:641000.5}]),null);
 assert.deepEqual(Array.from(c.calculateSpectrumFitRange([{freq:641000},{freq:'641000'}])),[640,642]);
 assert.deepEqual(Array.from(c.calculateSpectrumFitRange([{freq:641000},{freq:641025}])),[640.987,641.038]);
});
test('unequal frequency intervals keep actual MHz proportions; duplicate channels stay at same x',()=>{
 const c=harness(),devices=[{freq:641000},{freq:641250},{freq:642000},{freq:641250}];
 const [start,end]=c.calculateSpectrumFitRange(devices),xs=devices.map(d=>c.spectrumFrequencyX(d.freq,start,end,1000));
 assert.equal(xs[1],xs[3]);assert.ok(Math.abs((xs[2]-xs[1])/(xs[1]-xs[0])-3)<1e-9);
 const ticks=c.getSpectrumAxisTicks(start,end);assert.equal(ticks[0],start);assert.equal(ticks.at(-1),end);
 for(let i=1;i<ticks.length;i++)assert.ok(Math.abs(ticks[i]-ticks[i-1]-(end-start)/10)<1e-8);
});
test('fit button uses current online FAshe only and restore recovers manual range without overwriting storage',()=>{
 const elements={specStart:{value:'640.000'},specEnd:{value:'690.000'}},writes=[];
 const c=harness({DEVICES:[{_fasheId:'rx_ch1',freq:641000},{_fasheId:'rx_ch2',freq:641250},
  {_fasheId:'offline',freq:800000,status:'offline'},{freq:850000}],
  document:{getElementById:id=>elements[id]},localStorage:{getItem:()=>null,setItem:(...args)=>writes.push(args)},notify(){}});
 c.drawSpectrum=()=>{};c.updateRangeDisplay=()=>{};
 c.fitSpectrumToDevices();assert.equal(elements.specStart.value,'640.875');assert.equal(elements.specEnd.value,'641.375');
 c.DEVICES[1].freq=642000;c.fitSpectrumToDevices();assert.equal(elements.specEnd.value,'642.500');
 c.restoreSpectrumRange();assert.equal(elements.specStart.value,'640.000');assert.equal(elements.specEnd.value,'690.000');assert.deepEqual(writes,[]);
});
test('imported scan keeps real frequency coordinates when fitting/zooming instead of stretching to new limits',()=>{
 const points=[];
 const ctx={clearRect(){},beginPath(){},moveTo(){},lineTo:(x,y)=>points.push([x,y]),stroke(){},closePath(){},fill(){},
  createLinearGradient:()=>({addColorStop(){}})};
 const c=harness({DEVICES:[],document:{getElementById:id=>id==='specStart'?{value:'645'}:id==='specEnd'?{value:'655'}:{}}});
 c._prepareSpectrumCanvas=()=>({ctx,W:1000,H:200});c.calculateOccupiedZones=()=>[];c._patchSpectrumChannelLabels=()=>{};c.updateSpectrumDataSummary=()=>{};
 vm.runInContext("scanSource='imported';importedScanPoints=[{frequencyKHz:640000},{frequencyKHz:660000}];scanData=[0,1,0]",c);
 c.drawSpectrum();assert.equal(points.filter(([x,y])=>x===500&&y===20).length,2);
 assert.ok(points.some(([x])=>x===1500)); // Canvas clips the out-of-range portion; frequency is not rewritten.
});
