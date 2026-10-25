'use strict';
// B3 optional host facilities; fake clocks/ports only, no network or disk writes.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const factory=require('../src/platform/browser-platform.js'),host=factory.host;
const read=name=>fs.readFileSync(path.join(__dirname,'../src/modules',name+'.js'),'utf8');
function fixture(kind='native-test'){
  let next=0;const tasks=new Map(),cancelled=[],bypasses=[];
  const port={VERSION:'daty-host-runtime-v1',
    setTimeout(fn,ms){assert.equal(this,port);tasks.set(++next,{fn,ms,repeat:false});return next;},
    clearTimeout(id){assert.equal(this,port);cancelled.push(['timeout',id]);tasks.delete(id);},
    setInterval(fn,ms){assert.equal(this,port);tasks.set(++next,{fn,ms,repeat:true});return next;},
    clearInterval(id){assert.equal(this,port);cancelled.push(['interval',id]);tasks.delete(id);},
    nowEpochMs(){assert.equal(this,port);return 1789270000123;},
    nowMonotonicMs(){assert.equal(this,port);return 123.5;}};
  const runtime={DatyPlatform:{kind},DatyHostRuntime:port,DatyHostFactory:host};
  for(const name of ['setTimeout','clearTimeout','setInterval','clearInterval','performance','document','confirm','alert']){
    Object.defineProperty(runtime,name,{configurable:true,get(){bypasses.push(name);throw Error('browser bypass '+name);}});
  }
  return {runtime,port,tasks,cancelled,bypasses};
}
test('optional facilities leave the original four-port platform contract/version intact',()=>{
  assert.equal(factory.VERSION,'1.0.0');assert.equal(host.VERSION,'daty-host-runtime-v1');
  const ports={kind:'native',request(){},openEventStream(){},downloadText(){},storage:{getItem(){},setItem(){},removeItem(){}}};
  assert.deepEqual(Object.keys(factory.create(ports)),['VERSION','kind','request','openEventStream','storage','downloadText']);
});
test('native runtime clocks and timers retain receiver binding and exact delays',()=>{
  const h=fixture();let called=0;
  host.invokeRuntime(h.runtime,'setTimeout',()=>called++,1500);
  host.invokeRuntime(h.runtime,'setInterval',()=>called++,60000);
  assert.deepEqual([...h.tasks.values()].map(t=>t.ms),[1500,60000]);
  assert.equal(host.invokeRuntime(h.runtime,'nowEpochMs'),1789270000123);
  assert.equal(host.invokeRuntime(h.runtime,'nowMonotonicMs'),123.5);
  [...h.tasks.values()].forEach(t=>t.fn());assert.equal(called,2);assert.deepEqual(h.bypasses,[]);
});
test('timer cancellation retains its creating port after replacement and suppresses late callbacks',()=>{
  const h=fixture();let fired=0;
  const one=host.invokeRuntime(h.runtime,'setTimeout',()=>fired++,5000);
  const repeating=host.invokeRuntime(h.runtime,'setInterval',()=>fired++,3000);
  const late=[...h.tasks.values()].map(t=>t.fn);
  h.runtime.DatyHostRuntime=fixture().port;
  host.invokeRuntime(h.runtime,'clearTimeout',one);host.invokeRuntime(h.runtime,'clearInterval',repeating);
  late.forEach(fn=>fn());assert.equal(fired,0);assert.equal(h.tasks.size,0);
  assert.deepEqual(h.cancelled,[['timeout',1],['interval',2]]);
  host.invokeRuntime(h.runtime,'clearTimeout',one);assert.equal(h.cancelled.length,2);
});
test('missing invalid native runtime cannot fall back; timer handles cannot cross runtime owners',()=>{
  const h=fixture();const token=host.invokeRuntime(h.runtime,'setTimeout',()=>{},10);
  assert.throws(()=>host.invokeRuntime(fixture().runtime,'clearTimeout',token),/belong/);
  for(const invalid of [undefined,null,{VERSION:'wrong'},{}]){
    h.runtime.DatyHostRuntime=invalid;
    assert.throws(()=>host.invokeRuntime(h.runtime,'setTimeout',()=>{},10),/capability/);
  }
  assert.deepEqual(h.bypasses,[]);
});
test('runtime rejects non-finite clocks, async timer handles and invalid delays',()=>{
  const h=fixture();h.port.nowEpochMs=()=>NaN;
  assert.throws(()=>host.invokeRuntime(h.runtime,'nowEpochMs'),/finite/);
  h.port.nowMonotonicMs=()=>Promise.resolve(1);
  assert.throws(()=>host.invokeRuntime(h.runtime,'nowMonotonicMs'),/synchronous/);
  h.port.setTimeout=()=>Promise.resolve(1);
  assert.throws(()=>host.invokeRuntime(h.runtime,'setTimeout',()=>{},10),/synchronous/);
  assert.throws(()=>host.invokeRuntime(h.runtime,'setInterval',()=>{},-1),/nonnegative/);
});
test('browser default runtime is lazy and cancellation uses its original timer owner',()=>{
  const calls=[];const browser={DatyPlatform:{kind:'browser'},Date:{now:()=>9},performance:{now:()=>7},
    setTimeout(fn,ms){calls.push(['set',ms]);return 0;},clearTimeout(id){calls.push(['clear',id]);},
    setInterval(){return 2;},clearInterval(){}};
  const token=host.invokeRuntime(browser,'setTimeout',()=>{},3000);
  browser.clearTimeout=()=>{throw Error('replacement browser cancel must not receive old timer');};
  browser.DatyHostRuntime=fixture().port;host.invokeRuntime(browser,'clearTimeout',token);
  assert.deepEqual(calls,[['set',3000],['clear',0]]);
});
test('messages preserve this and exact text with strict synchronous confirmation',async()=>{
  const h=fixture(),calls=[];
  const messages=h.runtime.DatyHostMessages={VERSION:'daty-host-messages-v1',
    confirm(text){assert.equal(this,messages);calls.push(text);return true;},
    notify(...args){assert.equal(this,messages);calls.push(args);},alert(text){calls.push(text);}};
  assert.equal(host.invokeMessage(h.runtime,'confirm','delete?'),true);
  host.invokeMessage(h.runtime,'notify','!','title','message');host.invokeMessage(h.runtime,'alert','error');
  for(const value of [Promise.resolve(true),Promise.reject(Error('port rejection')),'true',1,null]){
    messages.confirm=()=>value;assert.throws(()=>host.invokeMessage(h.runtime,'confirm','delete?'),/synchronous|boolean/);
  }
  messages.alert=()=>Promise.resolve();assert.throws(()=>host.invokeMessage(h.runtime,'alert','x'),/synchronous/);
  await Promise.resolve();assert.deepEqual(h.bypasses,[]);assert.equal(calls[0],'delete?');
});
test('missing native message capabilities fail closed, browser defaults retain system dialogs',()=>{
  const h=fixture();assert.equal(host.usesMessagePort(h.runtime),true);
  for(const method of ['confirm','notify','alert'])assert.throws(()=>host.invokeMessage(h.runtime,method,'x'),/unavailable/);
  assert.deepEqual(h.bypasses,[]);
  const browser={confirm:()=>false,alert(){}};
  assert.equal(host.usesMessagePort(browser),false);assert.equal(host.invokeMessage(browser,'confirm','x'),false);
  host.invokeMessage(browser,'alert','x');
});
function dialogs(port){
  const listeners=new Map(),access=[];
  const c=vm.createContext({Promise,DatyPlatform:{kind:'native'},DatyDialogs:port,
    addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)});
  Object.defineProperty(c,'document',{get(){access.push('document');throw Error('DOM bypass');}});
  c.window=c;vm.runInContext(read('dialogs'),c);return {c,adapter:c.DatyDialogs,listeners,access};
}
test('native dialog preserves injected implementation, single modal, cancel and late-result protection',async()=>{
  let resolve,cancelled=0;const options={title:'unchanged',rows:[{channel:'CH1'}]};
  const port={confirm(value){assert.equal(this,port);assert.equal(value,options);return new Promise(r=>resolve=r);},
    cancelActive(){assert.equal(this,port);cancelled++;}};
  const h=dialogs(port),pending=h.adapter.confirm(options);
  assert.equal(h.adapter.isOpen(),true);assert.equal(await h.adapter.confirm({}),false);
  h.adapter.cancelActive();resolve(true);
  assert.equal(await pending,false);assert.equal(h.adapter.isOpen(),false);assert.equal(cancelled,1);assert.deepEqual(h.access,[]);
});
test('native dialog pagehide cancels while invalid/missing capability never opens DOM',async()=>{
  let resolve;const h=dialogs({confirm:()=>new Promise(r=>resolve=r),cancelActive(){}});
  const pending=h.adapter.confirm();h.listeners.get('pagehide')();resolve(true);assert.equal(await pending,false);
  for(const port of [undefined,null,{confirm:()=>Promise.resolve(true)}, {confirm:()=>true,cancelActive(){}},
    {confirm:()=>Promise.resolve('yes'),cancelActive(){}}]){
    const item=dialogs(port);await assert.rejects(item.adapter.confirm(),/capability|Promise<boolean>|boolean/);assert.deepEqual(item.access,[]);
  }
});
test('native dialog rejection permits a new confirmation with a real boolean result',async()=>{
  const port={confirm:()=>Promise.reject(Error('cancelled host')),cancelActive(){}};
  const h=dialogs(port);await assert.rejects(h.adapter.confirm(),/cancelled host/);
  port.confirm=()=>Promise.resolve(true);assert.equal(await h.adapter.confirm(),true);
});
test('native notification bypasses DOM and keeps the original icon/title/message',()=>{
  const h=fixture(),calls=[];h.runtime.DatyHostMessages={VERSION:'daty-host-messages-v1',notify(...args){calls.push(args);}};
  // Prevent the optional audio view mount; the notification itself must not touch DOM.
  const soundSource=read('notification').split('// daty-alert-sound-v1:')[0];
  const c=vm.createContext(h.runtime);vm.runInContext(soundSource,c);c.notify('✓','title','body');
  assert.deepEqual(calls,[['✓','title','body']]);assert.deepEqual(h.bypasses,[]);
});
test('browser notification retains text, visible class and one three-second timer',()=>{
  const tasks=new Map(),elements=new Map();let next=0;
  for(const id of ['notif','notifIcon','notifTitle','notifMsg'])elements.set(id,{textContent:'',shown:false,
    classList:{add(){elements.get(id).shown=true;},remove(){elements.get(id).shown=false;}}});
  const c=vm.createContext({DatyHostFactory:host,document:{getElementById:id=>elements.get(id)},
    setTimeout(fn,ms){tasks.set(++next,{fn,ms});return next;},clearTimeout:id=>tasks.delete(id)});
  vm.runInContext(read('notification').split('// daty-alert-sound-v1:')[0],c);
  c.notify('1','first','a');c.notify('2','second','b');assert.equal(tasks.size,1);
  assert.equal(elements.get('notifTitle').textContent,'second');assert.equal(elements.get('notif').shown,true);
  const task=[...tasks.values()][0];assert.equal(task.ms,3000);task.fn();assert.equal(elements.get('notif').shown,false);
});
test('native IP uses host timeout and epoch, preserving API then JSON and refresh period',async()=>{
  const h=fixture(),calls=[],values=new Map();
  h.runtime.DatyPlatform.storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  h.runtime.DatyPlatform.request=async url=>{calls.push(url);return {json:async()=>url.includes('local-ip.json')?{success:true,ip:'192.0.2.16'}:{success:false}};};
  Object.defineProperty(h.runtime,'document',{value:{getElementById:()=>null},configurable:true});
  const c=vm.createContext({...h.runtime,URL,Date,AbortController,AbortSignal,Promise,DatyPlatformFactory:factory,
    document:h.runtime.document,console:{log(){}},location:{hostname:'localhost'},notify(){}});c.window=c;
  vm.runInContext(read('ip-detection'),c);await c.getLocalIP();
  assert.equal(calls.length,2);assert.ok(calls[0].endsWith(':8765/api/ip'));
  assert.ok(calls[1].endsWith('local-ip.json?t=1789270000123'));
  assert.equal([...h.tasks.values()].filter(t=>t.repeat&&t.ms===60000).length,1);
  assert.equal(h.cancelled[0][0],'timeout');assert.equal(values.get('daty_local_ip'),'192.0.2.16');
});
test('dashboard clear refuses missing application dialogs without using legacy native confirmation',async()=>{
  const source=read('render');
  const c=vm.createContext({Promise,DatyHostFactory:host,DatyPlatform:{kind:'native'},
    DatyHostMessages:{VERSION:'daty-host-messages-v1',confirm:()=>{throw Error('Legacy confirmation must not run');}},
    _realtimeAlertClearPending:false,document:{getElementById:()=>null},
    ALERTS:[{id:'alert'}],notify(){},
    flushAlertArchive:()=>{throw Error('unexpected archival');}});
  vm.runInContext(source.slice(source.indexOf('async function clearAlerts()'),source.indexOf('function renderMonitorGrid()')),c);
  assert.equal(await c.clearAlerts(),false);assert.equal(c.ALERTS.length,1);
});
