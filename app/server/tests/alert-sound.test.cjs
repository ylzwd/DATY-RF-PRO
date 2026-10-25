// In-memory clocks, audio, storage and telemetry only; never controls receivers.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const sound = require('../src/modules/notification.js');
const migration = require('../src/platform/browser-data-migration.js');
const KEY = 'daty_alert_sound_v1';
const rf = {key:'threshold:rx_ch1:CH01:rf',level:'warn'};
const af = {key:'threshold:rx_ch1:CH01:af',level:'crit'};
function harness(raw = null) {
  let time=0, ready=true, stops=0, fail=false;
  const values=new Map(raw===null?[]:[[KEY,raw]]), played=[], tasks=new Map(); let next=0;
  const storage={getItem:k=>values.get(k)??null,setItem(k,v){if(fail)throw Error('quota');values.set(k,v);}};
  const output={state:()=>ready?'ready':'blocked',unlock:async()=>ready=true,
    play:event=>{if(!ready)return false;played.push(event);return true;},stop:()=>stops++};
  const controller=sound.create({storage,output,now:()=>time,
    schedule:(fn,ms)=>{tasks.set(++next,{fn,due:time+ms});return next;},cancel:id=>tasks.delete(id)});
  return {controller,values,played,tasks,output,storage,stops:()=>stops,block:()=>ready=false,fail:()=>fail=true,
    advance(ms){time+=ms;for(const [id,task] of [...tasks])if(task.due<=time){tasks.delete(id);task.fn();}}};
}
test('legacy input without metric remains edge-only; values and UI clearing do not replay',()=>{
  const h=harness();h.controller.observe([rf]);assert.equal(h.played.length,1);
  for(let i=0;i<100;i++)h.controller.observe([{...rf,value:-95-i}]);
  h.advance(5000);h.controller.observe([rf]);assert.equal(h.played.length,1);
  h.controller.observe([]);h.controller.observe([rf]);assert.equal(h.played.length,2);
});
test('one batch uses critical tone; bursts merge and recovered pending alarms never play',()=>{
  const h=harness();h.controller.observe([rf,af]);assert.equal(h.played.length,1);assert.equal(h.played[0].level,'crit');
  const other={...rf,key:'other:CH1:rf'};
  h.controller.observe([rf,af,other]);assert.equal(h.tasks.size,1);
  h.controller.observe([rf,af]);h.advance(2000);assert.equal(h.played.length,1);
  h.controller.observe([rf,af,other]);assert.equal(h.played.length,2);
});
test('rapid new CH alarms coalesce into one delayed tone without unbounded timers',()=>{
  const h=harness();h.controller.observe([rf]);const list=[rf];
  for(let i=0;i<50;i++){list.push({...af,key:'rx'+i});h.controller.observe(list);}
  assert.equal(h.tasks.size,1);assert.equal(h.played.length,1);
  h.advance(1999);assert.equal(h.played.length,1);h.advance(1);assert.equal(h.played.length,2);
  assert.equal(h.played[1].level,'crit');assert.equal(h.tasks.size,0);
});
test('turning off stops audio and cancels pending/unlock, persists across reload',async()=>{
  const h=harness();h.controller.observe([rf]);h.controller.observe([rf,af]);
  h.controller.setEnabled(false);h.advance(5000);assert.equal(h.played.length,1);
  assert.ok(h.stops()>0);assert.equal(h.tasks.size,0);assert.equal(JSON.parse(h.values.get(KEY)).enabled,false);
  const restored=harness(h.values.get(KEY));restored.controller.observe([rf]);assert.equal(restored.played.length,0);
  h.controller.setEnabled(true);assert.equal(h.played.length,2);
  h.block();let resolve;h.output.unlock=()=>new Promise(r=>resolve=r);
  const waiting=h.controller.unlock();h.controller.setEnabled(false);resolve(true);await waiting;
  assert.equal(h.played.length,2);
});
test('blocked autoplay waits for gesture and discards alarms recovered before gesture',async()=>{
  const h=harness();h.block();h.controller.observe([rf]);assert.equal(h.played.length,0);
  h.controller.observe([]);await h.controller.unlock();assert.equal(h.played.length,0);
  h.block();h.controller.observe([af]);await h.controller.unlock();assert.equal(h.played.length,1);
});
test('audio failures do not escape the alert engine and do not create busy retry timers',async()=>{
  const h=harness();h.output.play=()=>{throw Error('device missing');};
  assert.doesNotThrow(()=>h.controller.observe([rf]));assert.equal(h.controller.getState().audio,'error');
  assert.equal(h.tasks.size,0);
  h.output.unlock=async()=>{throw Error('denied');};assert.equal(await h.controller.unlock(),false);
  h.controller.setEnabled(false);assert.equal(await h.controller.preview(),false);
});
test('storage failures are visible; strict boolean parsing preserves original corrupted data',()=>{
  for(const raw of ['oops','null','[]','{"enabled":"false"}','{"enabled":0}']){
    const h=harness(raw);assert.equal(h.controller.getState().storageError,true);assert.equal(h.values.get(KEY),raw);
  }
  const h=harness();h.fail();h.controller.setEnabled(false);
  assert.equal(h.controller.getState().enabled,false);assert.equal(h.controller.getState().storageError,true);
  assert.equal(h.values.has(KEY),false);
});
test('preview is explicit, produces no alert entries, disabled mode is silent',async()=>{
  const h=harness();assert.equal(await h.controller.preview(),true);assert.equal(h.played.length,1);
  h.controller.observe([]);h.advance(2000);assert.equal(h.played.length,1);
  h.controller.setEnabled(false);assert.equal(await h.controller.preview(),false);assert.equal(h.played.length,1);
});
test('module contract can load without DOM/audio/storage access',()=>{
  const context={module:{exports:{}}};
  for(const key of ['document','AudioContext','localStorage','fetch'])Object.defineProperty(context,key,{get(){throw Error(key);}});
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/modules/notification.js'),'utf8'),context);
  assert.equal(typeof context.module.exports.create,'function');
});
test('engine uses live threshold keys, all metrics, recovery and unknown/offline semantics unchanged',()=>{
  const h=harness(), values=new Map(), context=vm.createContext({console:{warn(){},log(){}},Date,
    document:{readyState:'complete',getElementById:()=>null},requestAnimationFrame:()=>1,setTimeout:()=>1,
    DatyPlatform:{storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)}},
    DatyAlertSound:h.controller,DEVICES:[],ALERTS:[]});
  context.window=context;
  for(const file of ['frequency','render'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules/'+file+'.js'),'utf8'),context);
  const device={id:'rx_ch1',_fasheId:'rx_ch1',channel_number:1,_online:true,status:'online',rf:-90,batt:20,afDbfs:-3};
  context.evaluateRealtimeAlerts([device]);assert.equal(context.ALERTS.length,3);assert.equal(h.played.length,1);
  context.ALERTS.length=0;context.evaluateRealtimeAlerts([device]);assert.equal(h.played.length,1);
  h.advance(2000);assert.equal(h.played.length,2);assert.equal(h.played.at(-1).level,'warn');
  context.evaluateRealtimeAlerts([{...device,rf:null,batt:null,afDbfs:null}]);assert.equal(context.ALERTS.length,0);
  context.evaluateRealtimeAlerts([{...device,_online:false}]);h.advance(4000);assert.equal(h.played.length,2);
  context.evaluateRealtimeAlerts([device]);assert.equal(h.played.length,3);
});
test('sound preference participates in business backup/restore without secrets or automatic playback',()=>{
  const h=harness('{"enabled":false}');const body=migration.snapshot(h.storage,'https://localhost:8080');
  assert.equal(body.values[KEY],'{"enabled":false}');
  const target=harness();migration.apply(target.storage,migration.prepare(target.storage,body),{confirmed:true});
  assert.equal(target.values.get(KEY),'{"enabled":false}');assert.equal(target.played.length,0);
});
test('severity escalation retriggers once, pending severity always reflects current state',()=>{
  const h=harness();h.controller.observe([rf]);h.controller.observe([{...rf,level:'crit'}]);
  h.advance(2000);assert.equal(h.played.at(-1).level,'crit');assert.equal(h.played.length,2);
  h.controller.observe([]);h.controller.observe([af]);h.controller.observe([{...af,level:'warn'}]);
  h.advance(2000);assert.equal(h.played.at(-1).level,'warn');assert.equal(h.played.length,3);
});
test('leaving page/disposal cancels queued and asynchronous previews even if enabled again',async()=>{
  const h=harness();let resume;h.block();h.output.unlock=()=>new Promise(r=>resume=r);
  const preview=h.controller.preview();h.controller.setEnabled(false);h.controller.setEnabled(true);
  resume(true);assert.equal(await preview,false);assert.equal(h.played.length,0);
  h.controller.observe([rf]);h.controller.dispose();h.advance(5000);
  h.controller.observe([af]);assert.equal(h.played.length,0);assert.equal(h.tasks.size,0);
});
test('native view uses injected output/storage only; missing audio capability stays unavailable',async()=>{
  function host(output){
    const elements=new Map(['soundAlertEnabled','soundAlertStatus','soundAlertTest'].map(id=>[id,{
      checked:false,textContent:'',addEventListener(){},removeEventListener(){}}]));
    const data=new Map();
    const browser={DatyPlatform:{kind:'native',storage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)}},
      document:{getElementById:k=>elements.get(k),addEventListener(){},removeEventListener(){}},
      addEventListener(){},removeEventListener(){},performance:{now:()=>0},setTimeout:()=>1,clearTimeout(){}};
    browser.DatyHostFactory=require('../src/platform/browser-platform.js').host;
    browser.DatyHostRuntime={VERSION:'daty-host-runtime-v1',setTimeout:browser.setTimeout,clearTimeout:browser.clearTimeout,
      setInterval:()=>1,clearInterval(){},nowEpochMs:()=>0,nowMonotonicMs:()=>0};
    if(output)browser.DatyAlertSoundOutput=output;
    for(const key of ['AudioContext','webkitAudioContext','localStorage','fetch'])Object.defineProperty(browser,key,{get(){throw Error('host bypass '+key);}});
    return {controller:sound.mount(browser),data,elements};
  }
  let played=0;const h=host({state:()=> 'ready',unlock:async()=>true,play:()=>{played++;return true;},stop(){}});
  h.controller.observe([rf]);assert.equal(played,0); // Database preference has not arrived.
  h.controller.setEnabled(true);assert.equal(played,1);h.controller.setEnabled(false);
  assert.equal(h.data.size,0);h.controller.dispose(); // Production mount never persists page settings locally.
  const unavailable=host();assert.equal(unavailable.controller.getState().audio,'unsupported');
  assert.equal(await unavailable.controller.preview(),false);
  assert.equal(unavailable.elements.get('soundAlertTest').disabled,true);
});
test('browser output creates one reusable context, bounds pulse duration/gain and disconnects on stop',async()=>{
  let constructions=0,resumes=0,disconnected=0;
  const oscillators=[],ramps=[];
  class Audio {
    constructor(){constructions++;this.state='suspended';this.currentTime=10;this.destination={};}
    async resume(){resumes++;this.state='running';}
    createOscillator(){const o={frequency:{setValueAtTime(){}},connect(){},disconnect(){disconnected++;},
      start(t){this.started=t;},stop(t){this.stopped=t;}};oscillators.push(o);return o;}
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime:(v,t)=>ramps.push([v,t])},connect(){},disconnect(){disconnected++;}};}
  }
  const output=sound.createBrowserOutput({AudioContext:Audio});assert.equal(constructions,0);
  assert.equal(output.play({level:'warn'}),false);await output.unlock();await output.unlock();
  assert.equal(constructions,1);assert.equal(resumes,1);assert.equal(output.play({level:'crit'}),true);
  assert.equal(oscillators[0].started,10);assert.equal(oscillators[0].stopped,10.42);
  assert.deepEqual(ramps.map(r=>r[0]),[0.08,0,0.08,0]);output.stop();assert.equal(disconnected,2);
  assert.equal(sound.createBrowserOutput({}).state(),'unsupported');
});
for(const metric of ['rf','battery'])test(metric+' persists with one repeat every 2 seconds until recovery',()=>{
  const h=harness(),issue={...rf,metric};h.controller.observe([issue]);
  assert.equal(h.played.length,1);assert.equal(h.tasks.size,1);
  for(let i=0;i<100;i++)h.controller.observe([issue]);
  assert.equal(h.played.length,1);assert.equal(h.tasks.size,1);
  h.advance(1999);assert.equal(h.played.length,1);h.advance(1);assert.equal(h.played.length,2);
  h.advance(2000);assert.equal(h.played.length,3);
  h.controller.observe([]);assert.equal(h.tasks.size,0);h.advance(10000);assert.equal(h.played.length,3);
});
test('AF overload never repeats while active, but recovery then reoccurrence sounds again',()=>{
  const h=harness(),issue={...af,metric:'af'};h.controller.observe([issue]);
  for(let i=0;i<5;i++){h.advance(2000);h.controller.observe([issue]);}
  assert.equal(h.played.length,1);assert.equal(h.tasks.size,0);
  h.controller.observe([]);h.controller.observe([issue]);assert.equal(h.played.length,2);
});
test('RF plus battery repeat together as warn without replaying sustained AF critical tone',()=>{
  const h=harness(),list=[{...rf,metric:'rf'},{key:'rx:CH1:battery',metric:'battery',level:'warn'},{...af,metric:'af'}];
  h.controller.observe(list);h.advance(2000);h.advance(2000);
  assert.deepEqual(h.played.map(e=>e.level),['crit','warn','warn']);assert.equal(h.tasks.size,1);
  h.controller.observe([list[2]]);h.advance(2000);assert.equal(h.played.length,3);assert.equal(h.tasks.size,0);
});
test('repeat stops on disable, silence and disposal; reenable resumes only current metrics',()=>{
  const h=harness(),issue={...rf,metric:'rf'};h.controller.observe([issue]);h.controller.setEnabled(false);
  h.advance(5000);assert.equal(h.played.length,1);assert.equal(h.tasks.size,0);
  h.controller.setEnabled(true);assert.equal(h.played.length,2);h.advance(2000);assert.equal(h.played.length,3);
  h.controller.silence();h.advance(10000);assert.equal(h.played.length,3);assert.equal(h.tasks.size,0);
  h.controller.observe([issue]);assert.equal(h.played.length,4);h.controller.dispose();h.advance(10000);
  assert.equal(h.played.length,4);assert.equal(h.tasks.size,0);
});
test('a delayed/background timer never catches up with a burst of stale repeats',async()=>{
  const h=harness();h.controller.observe([{...rf,metric:'rf'}]);h.advance(60000);
  assert.equal(h.played.length,2);assert.equal(h.tasks.size,1);
  h.block();h.advance(2000);assert.equal(h.played.length,2);assert.equal(h.tasks.size,0);
  await h.controller.unlock();assert.equal(h.played.length,3);assert.equal(h.tasks.size,1);
});
