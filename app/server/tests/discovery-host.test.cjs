'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/modules/discovery.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const reply = (body = {status:'ok'}) => ({ok:true, json:async()=>body});
function harness(kind = 'browser') {
  const timers = new Map(), requests = [], sockets = [], notices = [], snapshots = [], elements = new Map();
  let sequence = 0, monotonic = 100;
  const runtime = {
    setTimeout(fn, ms) {const id=++sequence;timers.set(id,{fn,ms,interval:false});return id;},
    clearTimeout(id) {timers.delete(id);},
    setInterval(fn, ms) {const id=++sequence;timers.set(id,{fn,ms,interval:true});return id;},
    clearInterval(id) {timers.delete(id);},
    nowMonotonicMs() {return monotonic;}, nowEpochMs() {return 123456789;}
  };
  const c = vm.createContext({AbortController, console:{log(){},warn(){},error(){}},
    DEVICES:[], _fasheConnected:false, location:{hostname:'127.0.0.1'},
    document:{getElementById(id) {if (!elements.has(id)) elements.set(id,{style:{}});return elements.get(id);},querySelector(){return null;}},
    notify:(...args)=>notices.push(args),
    fetch(){throw Error('Browser network bypass');},
    DatyPlatformFactory:{serviceOrigin(service, host) {return `https://${host || '127.0.0.1'}:${service==='native'?8801:8802}`;}},
    DatyHostFactory:{invokeRuntime(_root, method, ...args){return runtime[method](...args);}},
    WebSocket:class {static OPEN=1; constructor(url){this.url=url;this.readyState=0;sockets.push(this);} close(){this.readyState=3;this.onclose?.();} send(value){this.sent=value;}},
  });
  c.DatyPlatform = {kind, request(url, options) {assert.equal(this,c.DatyPlatform);requests.push({url,options});return Promise.resolve(reply());}};
  vm.runInContext(source,c);
  c._onServerData = data=>snapshots.push(data);
  const fire = async ms => {
    for (const [id,timer] of [...timers]) if (timer.ms===ms) {
      if (!timer.interval) timers.delete(id);
      await timer.fn();
    }
    await flush();
  };
  return {c,timers,requests,sockets,notices,snapshots,elements,fire,advance:ms=>monotonic+=ms,
    connected:()=>vm.runInContext('_serverTransportConfirmed',c)};
}
test('bound injected request preserves signal and never falls through on missing/synchronous failure',async()=>{
  const h=harness('native'), signal=new AbortController().signal;
  await h.c._discoveryRequest('https://127.0.0.1:8802/health',{signal,redirect:'error'});
  assert.equal(h.requests[0].options.signal,signal);
  h.c.DatyPlatform.request=()=>{throw Error('native failure');};
  await assert.rejects(h.c._discoveryRequest('/health',{}),/native failure/);
  delete h.c.DatyPlatform.request;
  await assert.rejects(h.c._discoveryRequest('/health',{}),/unavailable/);
});
test('legacy WSS timeout/onclose/onerror trigger exactly one HTTPS handshake, not MQTT',async()=>{
  const h=harness();h.c.connectToServer({ip:'127.0.0.1'});
  assert.equal(h.sockets[0].url,'wss://127.0.0.1:8801/ws');
  await h.fire(1500);h.sockets[0].onerror();h.sockets[0].onclose();await flush();
  assert.equal(h.requests.length,1);assert.match(h.requests[0].url,/:8802\/health$/);
  assert.equal(h.connected(),true);assert.equal([...h.timers.values()].filter(t=>t.ms===1000).length,1);
});
test('disconnect while WSS connecting blocks late open/message and cancels timer',async()=>{
  const h=harness();h.c.connectToServer({ip:'127.0.0.1'});const ws=h.sockets[0];
  h.c.disconnectFromServer();ws.readyState=1;ws.onopen();ws.onmessage({data:'{"devices":[]}'});
  await h.fire(1500);assert.equal(h.connected(),false);assert.equal(h.requests.length,0);
  assert.equal(h.snapshots.length,0);assert.equal(h.timers.size,0);
});
test('native path uses HTTPS only, one handshake, 1s snapshots and 3s monotonic health',async()=>{
  const h=harness('native');h.c.connectToServer({ip:'127.0.0.1'});await flush();
  assert.equal(h.sockets.length,0);assert.equal(h.requests.length,1);
  await h.fire(1000);assert.equal(h.snapshots.length,1);assert.match(h.requests[1].url,/api\/devices$/);
  const original=h.c.DatyPlatform.request;
  h.c.DatyPlatform.request=function(...args){h.advance(7.4);return original.apply(this,args);};
  await h.fire(3000);assert.equal(h.elements.get('csLatency').textContent,7);
  assert.equal(h.requests.length,3);assert.ok(h.requests.every(r=>!r.options.method || r.options.method==='GET'));
  assert.equal([...h.timers.values()].some(t=>t.ms===2000),false);
});
test('old handshake success/failure cannot override a new target or schedule retry',async()=>{
  for (const fail of [false,true]) {
    const h=harness('native'), pending=deferred();const original=h.c.DatyPlatform.request;
    h.c.DatyPlatform.request=function(url,options){return url.includes('192.0.2.1:')?pending.promise:original.call(this,url,options);};
    h.c.connectToServer({ip:'192.0.2.1'});h.c.connectToServer({ip:'192.0.2.2'});await flush();
    fail?pending.reject(Error('late failure')):pending.resolve(reply());await flush();
    assert.equal(vm.runInContext('_connectedServer.ip',h.c),'192.0.2.2');assert.equal(h.connected(),true);
    assert.equal([...h.timers.values()].filter(t=>!t.interval).length,0);
  }
});
test('late snapshot is ignored after disconnect, and old failures cannot stop a new connection',async()=>{
  for (const fail of [false,true]) {
    const h=harness('native'), pending=deferred();h.c.connectToServer({ip:'192.0.2.1'});await flush();
    const original=h.c.DatyPlatform.request;
    h.c.DatyPlatform.request=function(url,options){return url.endsWith('/api/devices')?pending.promise:original.call(this,url,options);};
    await h.fire(1000);h.c.disconnectFromServer();h.c.connectToServer({ip:'192.0.2.2'});await flush();
    fail?pending.reject(Error('late')):pending.resolve(reply({devices:[{id:'old'}]}));await flush();
    assert.equal(h.snapshots.length,0);assert.equal(h.connected(),true);
    assert.equal([...h.timers.values()].filter(t=>t.ms===1000).length,1);
  }
});
test('failed handshake keeps original GET retry schedule, explicit disconnect cancels retry',async()=>{
  const h=harness('native');h.c.DatyPlatform.request=()=>{throw Error('unavailable');};
  h.c.connectToServer({ip:'127.0.0.1'});await flush();
  assert.equal(h.connected(),false);assert.equal([...h.timers.values()].filter(t=>t.ms===1000&&!t.interval).length,1);
  h.c.disconnectFromServer();assert.equal(h.timers.size,0);await h.fire(1000);assert.equal(h.connected(),false);
});
test('successful WSS open cancels its deadline; deliberate close never falls back',async()=>{
  const h=harness();h.c.connectToServer({ip:'127.0.0.1'});const ws=h.sockets[0];
  ws.readyState=1;ws.onopen();assert.equal(h.connected(),true);assert.deepEqual(JSON.parse(ws.sent),{cmd:'subscribe',channels:'all'});
  assert.equal([...h.timers.values()].some(t=>t.ms===1500),false);
  h.c.disconnectFromServer();assert.equal(h.timers.size,0);assert.equal(h.requests.length,0);
});

test('explicit null platform is not a legacy browser fallback for requests, sockets or timers',async()=>{
  const h=harness('native');h.c.DatyPlatform=null;
  await assert.rejects(h.c._discoveryRequest('/health',{}),/unavailable/);
  assert.equal(h.c._tryWebSocketConnect({ip:'127.0.0.1'}),false);
  assert.equal(h.sockets.length,0);
  delete h.c.DatyHostFactory;
  h.c.setTimeout=()=>{throw Error('Browser timer bypass');};
  assert.throws(()=>h.c._discoveryRuntime('setTimeout',()=>{},10),/unavailable/);
  assert.equal(h.requests.length,0);
});

test('asynchronous native transport rejection is returned once without browser retry',async()=>{
  const h=harness('native');let calls=0;
  h.c.DatyPlatform.request=()=>{calls++;return Promise.reject(Error('native async failure'));};
  await assert.rejects(h.c._discoveryRequest('https://127.0.0.1:8802/health',{}),/native async failure/);
  assert.equal(calls,1);assert.equal(h.sockets.length,0);
});

test('opened WSS interruption falls back once with one active heartbeat and snapshot interval',async()=>{
  const h=harness();h.c.connectToServer({ip:'127.0.0.1'});const ws=h.sockets[0];
  ws.readyState=1;ws.onopen();ws.onmessage({data:'{"devices":[]}'});assert.equal(h.snapshots.length,1);
  ws.onclose();ws.onerror();ws.onclose();await flush();
  assert.equal(h.requests.length,1);assert.equal(h.connected(),true);
  assert.equal([...h.timers.values()].filter(t=>t.ms===1000&&t.interval).length,1);
  assert.equal([...h.timers.values()].filter(t=>t.ms===3000&&t.interval).length,1);
  ws.onmessage({data:'{"devices":[{"id":"stale"}]}'});assert.equal(h.snapshots.length,1);
});

test('old in-flight health success and failure cannot overwrite new target latency',async()=>{
  for(const fail of [false,true]){
    const h=harness('native');h.c.connectToServer({ip:'192.0.2.1'});await flush();
    const pending=deferred(),original=h.c.DatyPlatform.request;
    h.c.DatyPlatform.request=function(url,options){return url.includes('192.0.2.1:')?pending.promise:original.call(this,url,options);};
    const heartbeat=[...h.timers.values()].find(t=>t.ms===3000).fn();
    h.c.connectToServer({ip:'192.0.2.2'});await flush();h.elements.set('csLatency',{textContent:'new-target'});
    fail?pending.reject(Error('late old health')):pending.resolve(reply());await heartbeat;await flush();
    assert.equal(h.elements.get('csLatency').textContent,'new-target');assert.equal(h.connected(),true);
    assert.equal([...h.timers.values()].some(t=>t.ms===2000),false);
  }
});

test('legacy receiver scan checks discovery support then parallel stats/devices GETs with cleanup',async()=>{
  for(const failure of [false,true]){
    const h=harness('native');h.c._fasheApiUrl='';
    h.c.DatyPlatform.request=function(url,options){
      assert.equal(this,h.c.DatyPlatform);h.requests.push({url,options});
      if(url.endsWith('/discovery/shure/status'))return Promise.resolve({status:404,ok:false});
      return failure?Promise.reject(Error('scan failed')):Promise.resolve(reply({success:true,clients:[],devices:[]}));
    };
    await h.c.scanForReceivers();
    assert.deepEqual(h.requests.map(r=>r.url),['https://127.0.0.1:8802/api/discovery/shure/status','https://127.0.0.1:8802/api/stats','https://127.0.0.1:8802/api/devices']);
    assert.equal(h.requests[1].options.signal,h.requests[2].options.signal);
    assert.ok(h.requests.every(r=>r.options.redirect==='error' && (!r.options.method || r.options.method==='GET')));
    assert.equal(h.timers.size,0);assert.equal(h.elements.get('btnRecvScan').disabled,false);
    assert.equal(h.sockets.length,0);
  }
});
