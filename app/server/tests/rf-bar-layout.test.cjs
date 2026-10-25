const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/modules/spectrum.js'),'utf8');
test('RF frequency axis keeps real MHz proportions, sorts by frequency, excludes out-of-range/invalid points without mutation',()=>{
 const c=vm.createContext({});vm.runInContext(source,c);
 const devices=[{freq:649000},{freq:641000},{freq:641250},{freq:642000},{freq:641250},{freq:650001},{freq:639999},{freq:null},{},{freq:NaN}];
 const before=JSON.stringify(devices);
 for(const width of [320,800,1600]){
  const p=c.getRFBarLayout(width,devices,640,650);
  assert.ok(p.barWidth<=4);assert.equal(p.markers.length,5);
  assert.deepEqual(Array.from(p.markers,m=>m.freqKHz),[641000,641250,641250,642000,649000]);
  p.markers.forEach(m=>assert.equal(m.x,(m.freqKHz-640000)/10000*p.plotWidth));
  assert.equal(p.markers[1].x,p.markers[2].x);
  assert.ok(Math.abs((p.markers[3].x-p.markers[2].x)/(p.markers[1].x-p.markers[0].x)-3)<1e-8);
  assert.equal(c.getRFBarLayout(width,devices,650,640).markers.length,0);
  assert.equal(c.getRFBarLayout(width,devices,640,640).markers.length,0);
  assert.equal(c.getRFBarLayout(width,[],640,650).markers.length,0);
 }
 assert.equal(JSON.stringify(devices),before);
});

test('RF fit shares spectrum linear positions for 1/2/4/8/50CH and includes exact range endpoints',()=>{
 const c=vm.createContext({});vm.runInContext(source,c);
 for(const count of [1,2,4,8,50]){
  const devices=Array.from({length:count},(_,i)=>({freq:641000+i*250}));
  const range=c.calculateSpectrumFitRange(devices),p=c.getRFBarLayout(1000,devices,...range);
  p.markers.forEach((m,i)=>assert.ok(Math.abs(m.x/p.plotWidth-(i+.5)/count)<1e-8));
 }
 const p=c.getRFBarLayout(1000,[{freq:640000},{freq:650000}],640,650);
 assert.equal(p.markers[0].x,0);assert.equal(p.markers[1].x,p.plotWidth);
});

test('RF renderer preserves RF heights/colors, positions bars/DOM CH annotations by frequency and redraws on resize',()=>{
 const rects=[],texts=[],listeners={},timeouts=[],colors=[],transforms=[];
 const ctx={clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},fillRect(...args){rects.push(args);},
  setTransform(...args){transforms.push(args);},fillText(...args){texts.push(args);},createLinearGradient(){return {addColorStop(){}};}};
 const canvas={parentElement:{clientWidth:800,clientHeight:200,getBoundingClientRect(){return {width:this.clientWidth,height:this.clientHeight};}},getContext:()=>ctx};
 const devices=[-90,-75,-60,-30].map((rf,i)=>({id:i+1,rf,freq:[641000,641250,642000,649000][i]}));
 const elements={rfBarChart:canvas,rfFrequencyAxis:{innerHTML:''},specStart:{value:'640'},specEnd:{value:'650'},
  'panel-dashboard':{classList:{contains:()=>true}}};
 const c=vm.createContext({DEVICES:devices,document:{getElementById:id=>elements[id]||null},
  window:{devicePixelRatio:2,addEventListener:(name,fn)=>listeners[name]=fn},setTimeout:fn=>{timeouts.push(fn);return 1;},clearTimeout(){},
  formatChannelDisplay:d=>'CH'+d.id,_rfMeterColor:rf=>{colors.push(rf);return '#10b981';}});
 vm.runInContext(source,c);let annotations;c._patchSpectrumChannelLabels=(...args)=>annotations=args;c.drawRFBarChart();
 const fills=rects.filter((_,i)=>i%3===1);
 assert.equal(fills.length,4);assert.deepEqual(fills.map(r=>r[3]),[0,41.5,83,166]);assert.deepEqual(colors,[-90,-75,-60,-30]);
 fills.forEach((r,i)=>assert.equal(r[0]+r[2]/2,56+(devices[i].freq-640000)/10000*696));
 assert.equal(annotations[2],'rfChannelLabels');annotations[0].forEach(m=>assert.equal(m.x,(m.freqKHz-640000)/10000*696));
 assert.ok(texts.every(t=>!/^CH|^通道$/.test(t[0])));assert.match(elements.rfFrequencyAxis.innerHTML,/640 MHz.*650 MHz/);
 assert.equal(canvas.width,1600);assert.equal(canvas.height,400);assert.deepEqual(transforms[0],[2,0,0,2,0,0]);
 assert.deepEqual(devices.map(d=>d.rf),[-90,-75,-60,-30]);
 canvas.parentElement.clientWidth=1200;listeners.resize();timeouts.at(-1)();assert.equal(canvas.width,2400);
 canvas.parentElement.clientWidth=0;c.drawRFBarChart();assert.equal(canvas.width,2400); // Hidden charts never grow their backing store.
});

test('both charts share exact axis markup, three-decimal MHz formatting, edge anchors and unchanged DOM reuse',()=>{
 const c=vm.createContext({});vm.runInContext(source,c);
 let writes=0,markup='';const axis={get innerHTML(){return markup;},set innerHTML(value){writes++;markup=value;}};
 c.renderFrequencyAxisLabels(axis,640.875,641.875,1000);assert.equal(writes,1);
 assert.match(markup,/640\.875 MHz/);assert.match(markup,/641\.875 MHz/);assert.equal((markup.match(/ MHz/g)||[]).length,11);
 assert.match(markup,/left:0%;/);assert.match(markup,/left:100%;/);
 c.renderFrequencyAxisLabels(axis,640.875,641.875,1000);assert.equal(writes,1);
 c.renderFrequencyAxisLabels(axis,640,690,1000);assert.match(markup,/640 MHz.*690 MHz/);assert.equal(writes,2);
 c.renderFrequencyAxisLabels(axis,690,640,1000);assert.doesNotMatch(markup,/MHz/);
});

test('shared manual range persists once, redraws only the visible chart, fit/restore preserve saved manual range',()=>{
 const values=new Map(),elements={specStart:{value:'640.000'},specEnd:{value:'690.000'},rangeDisplay:{},
  'panel-dashboard':{classList:{contains:()=>true}},'panel-spectrum':{classList:{contains:()=>false}}};
 const c=vm.createContext({document:{getElementById:id=>elements[id]||null},localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},
  DEVICES:[{_fasheId:'rx_ch1',freq:641000},{_fasheId:'rx_ch2',freq:641250}],notify(){}});vm.runInContext(source,c);
 let rf=0,spectrum=0;c.drawRFBarChart=()=>rf++;c.drawSpectrum=()=>spectrum++;c.renderFreqAxis=()=>{};c.updateSpectrumDataSummary=()=>{};
 c.updateRangeDisplay();assert.equal(rf,1);assert.equal(spectrum,0);assert.equal(values.get('specStartFreq'),'640.000');
 c.fitSpectrumToDevices();assert.equal(rf,2);assert.equal(elements.specStart.value,'640.875');assert.equal(values.get('specStartFreq'),'640.000');
 c.restoreSpectrumRange();assert.equal(rf,3);assert.equal(elements.specStart.value,'640.000');assert.equal(elements.specEnd.value,'690.000');
});
