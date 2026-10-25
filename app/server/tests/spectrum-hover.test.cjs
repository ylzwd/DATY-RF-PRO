const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/modules/spectrum.js'),'utf8');
function harness(extra={}){const c=vm.createContext(extra);vm.runInContext(source,c);return c;}

test('spectrum grid is more than twice as dense in both directions, with real 5 dBm RF steps',()=>{
 const c=harness();
 for(const [width,height]of[[1000,380],[620,225]]){
  const g=c.getSpectrumGrid(width,height);
  assert.equal(g.vertical.length,41);assert.equal(g.horizontal.length,13);
  assert.ok(g.vertical.length>12*2);assert.ok(g.horizontal.length>4*2);
  g.vertical.forEach((line,i)=>assert.equal(line.x,width*i/40));
  g.horizontal.forEach((line,i)=>assert.ok(Math.abs(line.y-(height-(60-i*5)/60*height*.9))<1e-9));
  assert.equal(g.vertical.filter(l=>l.major).length,11);assert.equal(g.horizontal.filter(l=>l.major).length,4);
 }
});

test('point hit testing uses nearest actual circle, not stems or pointer-estimated frequency',()=>{
 const c=harness(),markers=[{x:100,y:20,freqKHz:641000},{x:115,y:20,freqKHz:641250},{x:100,y:90,freqKHz:641000}];
 assert.equal(c.findSpectrumPoint(markers,104,23),markers[0]);
 assert.equal(c.findSpectrumPoint(markers,113,20),markers[1]);
 assert.equal(c.findSpectrumPoint(markers,100,90),markers[2]);
 assert.equal(c.findSpectrumPoint(markers,100,60),null);
 assert.equal(c.findSpectrumPoint(markers,110,30),null);
 assert.equal(c.findSpectrumPoint([],0,0),null);
});

test('combined hover covers full real stems with a narrow tolerance, excluding empty space above/below',()=>{
 const c=harness(),markers=[{x:100,y:20,freqKHz:641000},{x:115,y:90,freqKHz:641250}];
 for(const y of [20,40,90,150,200])assert.equal(c.findSpectrumMarker(markers,100,y,200),markers[0]);
 assert.equal(c.findSpectrumMarker(markers,104,160,200),markers[0]);
 assert.equal(c.findSpectrumMarker(markers,106,160,200),null);
 assert.equal(c.findSpectrumMarker(markers,115,160,200),markers[1]);
 assert.equal(c.findSpectrumMarker(markers,115,60,200),null);
 assert.equal(c.findSpectrumMarker(markers,100,5,200),null);
 assert.equal(c.findSpectrumMarker(markers,100,201,200),null);
 assert.equal(c.findSpectrumMarker([],100,100,200),null);
});

test('dense adjacent stems choose nearest actual frequency; coincident stem does not steal a circle',()=>{
 const c=harness(),markers=[{x:100,y:20},{x:106,y:70},{x:100,y:90}];
 assert.equal(c.findSpectrumMarker(markers,104,150,200),markers[1]);
 assert.equal(c.findSpectrumMarker(markers,100,70,200),markers[0]);
 assert.equal(c.findSpectrumMarker(markers,100,90,200),markers[2]);
 assert.equal(c.findSpectrumMarker(markers,106,70,200),markers[1]);
});

test('spectrum removes occupied red bands and keeps every real stem/circle green without changing data',()=>{
 const strokes=[],fills=[],arcs=[],devices=[{_fasheId:'rx_ch1',freq:641000,rf:-85}];
 const ctx={clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){strokes.push(this.strokeStyle);},
  arc(...args){arcs.push(args);},fill(){fills.push(this.fillStyle);},fillRect(){throw Error('No occupied bands');},strokeRect(){throw Error('No band outline');}};
 const c=harness({DEVICES:devices,document:{getElementById:id=>id==='specStart'?{value:'640'}:id==='specEnd'?{value:'642'}:{}},_rfMeterColor:()=> '#f43f5e'});
 c._prepareSpectrumCanvas=()=>({ctx,W:1000,H:200});c._patchSpectrumChannelLabels=()=>{};c.updateSpectrumDataSummary=()=>{};
 c.calculateOccupiedZones=()=>{throw Error('Hidden occupancy must not be calculated during paint');};
 const before=JSON.stringify(devices);c.drawSpectrum();
 assert.equal(strokes.length,56);assert.equal(strokes.filter(color=>color==='#fbbf24').length,1);assert.equal(strokes.at(-1),'#10b98199');assert.deepEqual(fills,['#10b981']);
 assert.equal(arcs[0][0],500);assert.equal(arcs[0][1],185);assert.equal(JSON.stringify(devices),before);
});

test('tooltip listeners bind once; current telemetry replaces old values and moving/offline points hide it',()=>{
 const listeners={},tooltip={hidden:true,textContent:'',style:{},offsetWidth:160,offsetHeight:30};
 const canvas={style:{},parentElement:{clientWidth:1000,clientHeight:200},
  getBoundingClientRect:()=>({left:20,top:40,width:1000,height:200}),
  addEventListener:(name,fn)=>{assert.ok(!listeners[name]);listeners[name]=fn;}};
 const c=harness({document:{getElementById:()=>tooltip}});
 const marker={x:980,y:20,freqKHz:641125,device:{channel_number:50},index:49};
 c._updateSpectrumPointHover(canvas,[marker],1000,200);
 listeners.pointermove({clientX:1000,clientY:60});
 assert.equal(tooltip.hidden,false);assert.equal(tooltip.textContent,'CH50 · 641.125 MHz');
 assert.ok(parseFloat(tooltip.style.left)+tooltip.offsetWidth<=1000);assert.ok(parseFloat(tooltip.style.top)>=0);
 listeners.pointermove({clientX:1000,clientY:190});
 assert.equal(tooltip.hidden,false);assert.equal(tooltip.textContent,'CH50 · 641.125 MHz');
 assert.ok(parseFloat(tooltip.style.top)>=100); // Near the hovered stem, not pinned to the circle.
 c._updateSpectrumPointHover(canvas,[{...marker,freqKHz:641126}],1000,200);
 assert.equal(tooltip.textContent,'CH50 · 641.126 MHz');
 c._updateSpectrumPointHover(canvas,[{...marker,x:700}],1000,200);assert.equal(tooltip.hidden,true);
 c._updateSpectrumPointHover(canvas,[marker],1000,200);assert.equal(tooltip.hidden,false);
 listeners.pointerleave();assert.equal(tooltip.hidden,true);
 listeners.pointermove({clientX:1000,clientY:60});assert.equal(tooltip.hidden,false);
 c._updateSpectrumPointHover(canvas,[],1000,200);assert.equal(tooltip.hidden,true);
 assert.deepEqual(Object.keys(listeners),['pointermove','pointerleave']);
});

test('RF-unknown guard hover remains available without a fabricated curve and respects open touching boundaries',()=>{
 const c=harness(),left={startKHz:640750,endKHz:641250,openStart:true,openEnd:true},right={startKHz:641250,endKHz:641750,openStart:true,openEnd:true};
 const sim={startMHz:640,endMHz:642,result:{points:[],ranges:[],possibleRanges:[],guardRanges:[left,right]}};
 assert.equal(c.findSpectrumSimulationPoint(sim,625,198,1000,200),null,'exactly 641250 kHz is a permitted endpoint');
 const hit=c.findSpectrumSimulationPoint(sim,600,198,1000,200);
 assert.equal(hit.frequencyKHz,641200);assert.equal(hit.levelDbm,null);assert.equal(hit.guardRange,left);
 assert.equal(c.findSpectrumSimulationPoint(sim,600,100,1000,200),null);
 const clipped={...sim,result:{...sim.result,guardRanges:[{startKHz:640000,endKHz:640250,openStart:false,openEnd:true}]}};
 assert.ok(c.findSpectrumSimulationPoint(clipped,0,198,1000,200),'clipped left edge lies inside the original guard');
});

test('curve hover distinguishes smooth exceedance from possible texture exceedance',()=>{
 const c=harness(),possible={startKHz:640750,endKHz:641250};
 const sim={startMHz:640,endMHz:642,result:{points:[{frequencyKHz:640000,levelDbm:-75},{frequencyKHz:642000,levelDbm:-75}],ranges:[],possibleRanges:[possible],guardRanges:[]}};
 const hit=c.findSpectrumSimulationPoint(sim,500,155,1000,200);
 assert.equal(hit.levelDbm,-75);assert.equal(hit.range,undefined);assert.equal(hit.possibleRange,possible);
});

test('pixel reduction preserves narrow maxima, minima, endpoints and order without mutating model samples',()=>{
 const c=harness();
 const points=Array.from({length:10001},(_,i)=>({frequencyKHz:640000+i*.2,levelDbm:i%2?-87:-88}));
 points[2345].levelDbm=-35;points[5678].levelDbm=-89.9;
 const before=JSON.stringify(points),reduced=c.reduceSpectrumTraceForPixels(points,640,642,100);
 assert.ok(reduced.length<=400);assert.equal(reduced[0],points[0]);assert.equal(reduced.at(-1),points.at(-1));
 assert.ok(reduced.includes(points[2345]));assert.ok(reduced.includes(points[5678]));
 for(let i=1;i<reduced.length;i++)assert.ok(reduced[i].frequencyKHz>reduced[i-1].frequencyKHz);
 assert.equal(JSON.stringify(points),before);
 assert.equal(c.reduceSpectrumTraceForPixels(points,640,642,10000),points);
});
