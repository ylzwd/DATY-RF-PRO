'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const sound=require('../src/modules/notification.js'),business=require('../src/app/business-database.js');
const issue={key:'rx:rf',metric:'rf',level:'warn'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function harness({local=true,remote=false,ready=true}={}){
  let now=0,next=0,reads=0,plays=0,stops=0,connected=true;
  const tasks=new Map(),values=new Map([[sound.STORAGE_KEY,JSON.stringify({enabled:local})]]),events=new Map(),elements=new Map();
  for(const id of ['soundAlertEnabled','soundAlertStatus','soundAlertTest'])elements.set(id,{checked:false,textContent:'',addEventListener(name,fn){this[name]=fn;},removeEventListener(){}});
  const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  const state={status:'ready',pending:null,loaded:true,resource:null,epoch:'epoch'};
  const h={writes:[],readHook:null,saveHook:null,remote,confirm:null};
  const client={snapshot:()=>({...state})};
  const repository={invalidate(){},cached:()=>null,
    async load(kind,id){reads++;if(h.readHook)return h.readHook(kind,id);return {status:'ready',epoch:'epoch',resource:id==='alert_sound'?{kind,id,revision:1,deleted:false,value:{enabled:h.remote}}:null};},
    async saveBoolean(id,value){h.writes.push({id,value});if(h.saveHook)return h.saveHook(id,value);h.remote=value;return {status:'saved',resource:{value:{enabled:value}}};},
    async loadCurrentScan(){return {status:'ready',resource:null};},async listAll(){return {status:'ready',resources:[],epoch:'epoch'};}};
  const global={DatyPlatform:{kind:'browser',storage},DatyFreshStart:ready?undefined:{epoch:'epoch'},
    document:{getElementById:id=>elements.get(id)||null,addEventListener(){},removeEventListener(){}},
    addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name),
    setTimeout(fn,ms){tasks.set(++next,{fn,at:now+ms});return next;},clearTimeout:id=>tasks.delete(id),performance:{now:()=>now},
    DatyAlertSoundOutput:{state:()=> 'ready',unlock:async()=>true,play:()=>{plays++;return true;},stop:()=>stops++},
    DatyDatabaseConnection:{snapshot(){return {origin:'https://example.test',revision:1,source:connected?{id:'peer'}:null};},subscribe:()=>()=>{}},
    DatyDialogs:{confirm:()=>h.confirm?.promise??Promise.resolve(false)},getCurrentPlanningProject:()=>({id:'default'}),
    DatyEquipmentProfiles:{validateEquipmentProfile:()=>[],BUILT_IN_EQUIPMENT_PROFILES:[]},DEVICES:[],notify(){}};
  global.DatyAlertSound=sound.mount(global);
  const api=business.mount(global,{autoHydrate:false,client,repository,batchClient:{},scanBatchClient:{}});
  return Object.assign(h,{api,global,state,values,elements,tasks,events,controller:global.DatyAlertSound,plays:()=>plays,stops:()=>stops,reads:()=>reads,
    disconnect:()=>connected=false,
    toggle(value){return api.setBooleanPreference('alert_sound',value,v=>global.DatyAlertSound.setEnabled(v),()=>global.DatyAlertSound.unlock());},
    async advance(ms){now+=ms;for(const [id,task]of [...tasks])if(task.at<=now){tasks.delete(id);await task.fn();}},
    close(){api.dispose();global.DatyAlertSound.dispose();}});
}

test('saved OFF overrides stale enabled cache on hydration without a migration prompt or write',async()=>{
  const h=harness({ready:false});
  try{
    h.controller.observe([issue]);assert.equal(h.plays(),0,'no startup sound before authority');
    await h.api.hydrate();assert.equal(h.controller.getState().enabled,false);
    assert.match(h.elements.get('soundAlertStatus').textContent,/已关闭/);
    assert.equal(h.elements.get('soundAlertTest').disabled,true);
    h.controller.observe([issue]);await h.advance(5000);assert.equal(h.plays(),0);assert.equal(h.writes.length,0);
  }finally{h.close();}
});
test('another browser saving OFF silences an already playing page on the periodic read',async()=>{
  const h=harness({remote:true});
  try{
    h.controller.observe([issue]);assert.equal(h.plays(),1);
    h.remote=false;await h.advance(1000);
    assert.equal(h.controller.getState().enabled,false);assert.ok(h.stops()>0);
    await h.advance(5000);assert.equal(h.plays(),1);assert.equal(h.writes.length,0);
    h.remote=true;await h.advance(1000);assert.equal(h.controller.getState().enabled,true);assert.equal(h.plays(),2);
  }finally{h.close();}
});
test('OFF is synchronous during receipt review; delayed ON review cannot undo the later OFF',async()=>{
  const h=harness({remote:true});
  try{
    h.controller.observe([issue]);h.state.status='unknown';h.confirm=deferred();
    const first=h.toggle(true),last=h.toggle(false);
    assert.equal(h.controller.getState().enabled,false);assert.ok(h.stops()>0);
    h.confirm.resolve(false);await Promise.all([first,last]);await h.advance(3000);
    assert.equal(h.controller.getState().enabled,false);assert.equal(h.plays(),1);assert.equal(h.writes.length,0);
  }finally{h.close();}
});
test('OFF works offline, remains local with visible save failure, and cannot be overwritten by polling',async()=>{
  const h=harness({remote:true});
  try{
    h.controller.observe([issue]);h.disconnect();const result=h.toggle(false);
    assert.equal(h.controller.getState().enabled,false);assert.equal(await result,false);
    assert.match(h.elements.get('soundAlertStatus').textContent,/未保存/);
    await h.advance(3000);assert.equal(h.plays(),1);assert.equal(h.writes.length,0);
  }finally{h.close();}
});
test('late server read cannot reenable after OFF; explicit write waits for its baseline and saves OFF',async()=>{
  const h=harness({remote:true}),gate=deferred();
  try{
    h.readHook=()=>gate.promise;
    const reading=h.api.refreshSoundPreference(),saving=h.toggle(false);
    assert.equal(h.controller.getState().enabled,false);
    gate.resolve({status:'ready',epoch:'epoch',resource:{value:{enabled:true},deleted:false}});
    await reading;assert.equal(await saving,true);
    assert.equal(h.controller.getState().enabled,false);assert.deepEqual(h.writes,[{id:'alert_sound',value:false}]);
    assert.match(h.elements.get('soundAlertStatus').textContent,/已关闭/);
  }finally{h.close();}
});
test('failed reads retry, overlapping reads coalesce, and unknown writes are not reconciled or replayed',async()=>{
  const h=harness(),gate=deferred();
  try{
    h.state.status='error';h.readHook=()=>gate.promise;
    const a=h.api.refreshSoundPreference(),b=h.api.refreshSoundPreference();assert.equal(h.reads(),1);
    gate.resolve({status:'error'});await Promise.all([a,b]);h.readHook=null;
    await h.advance(1000);assert.equal(h.controller.getState().enabled,false);
    h.state.status='unknown';const before=h.reads();await h.advance(1000);assert.equal(h.reads(),before);assert.equal(h.writes.length,0);
  }finally{h.close();}
});
test('connection change during a read keeps local OFF but does not save to a different scope',async()=>{
  const h=harness({remote:true}),gate=deferred();
  try{
    h.readHook=()=>gate.promise;const reading=h.api.refreshSoundPreference(),saving=h.toggle(false);
    h.disconnect();gate.resolve({status:'ready',epoch:'epoch',resource:{value:{enabled:true},deleted:false}});
    await reading;assert.equal(await saving,false);assert.equal(h.controller.getState().enabled,false);assert.equal(h.writes.length,0);
  }finally{h.close();}
});
test('same-origin OFF event stops repeat audio without echo writes and disposal removes synchronization',()=>{
  const h=harness({remote:true});
  h.controller.observe([issue]);h.values.set(sound.STORAGE_KEY,'{"enabled":false}');
  h.events.get('storage')({key:sound.STORAGE_KEY,newValue:'{"enabled":false}'});
  assert.equal(h.controller.getState().enabled,false);assert.equal(h.plays(),1);
  h.close();assert.equal(h.tasks.size,0);assert.equal(h.events.has('storage'),false);assert.equal(h.events.has('focus'),false);
});
test('remount disposes the previous audible controller',()=>{
  const h=harness({remote:true});
  h.controller.observe([issue]);const replacement=sound.mount(h.global);h.global.DatyAlertSound=replacement;
  assert.ok(h.stops()>0);h.controller.observe([issue]);assert.equal(h.plays(),1);h.close();
});
