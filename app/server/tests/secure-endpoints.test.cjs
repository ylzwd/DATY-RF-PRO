'use strict';
// Read-only source inspection and isolated transports only: no sockets, accounts,
// certificate stores, receiver commands or production storage are accessed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const platform = require('../src/platform/browser-platform.js');
const root = path.join(__dirname, '..');
const load = name => fs.readFileSync(path.join(root, name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('known legacy Bridge preferences upgrade TLS without changing a remote host or port', () => {
  assert.equal(platform.normalizeBridgeUrl('http://192.0.2.16:8802/'), 'https://192.0.2.16:8802');
  assert.equal(platform.normalizeBridgeUrl('http://localhost:8802/'), 'https://127.0.0.1:8802');
  assert.equal(platform.normalizeBridgeUrl('https://localhost:8802/'), 'https://127.0.0.1:8802');
  assert.equal(platform.normalizeBridgeUrl('https://bridge.example:9443/'), 'https://bridge.example:9443');
  for (const url of ['http://bridge.example:9443', 'http://bridge.example', 'ws://localhost:8802',
    'http://user:pass@localhost:8802', 'https://localhost:8802/?key=x', 'https://localhost:8802/#secret']) {
    assert.throws(() => platform.normalizeBridgeUrl(url));
  }
});

test('service URL contract emits only HTTPS/WSS with validated host and exact service port', () => {
  for (const [name, port] of [['web',8080], ['bridge',8802], ['ip',8765], ['native',8801]]) {
    assert.equal(platform.serviceOrigin(name, '192.0.2.16'), `https://192.0.2.16:${port}`);
  }
  assert.equal(platform.serviceOrigin('mqtt', '192.0.2.16'), 'wss://192.0.2.16:8083');
  assert.equal(platform.serviceOrigin('bridge', 'localhost'), 'https://127.0.0.1:8802');
  for (const host of ['user@host', 'host/path', 'host?x', 'host#x', 'https://host', 'host:8080']) {
    assert.throws(() => platform.serviceOrigin('bridge', host));
  }
});

test('platform rejects known plaintext services before browser or injected native I/O, but does not rewrite unrelated URLs', () => {
  const calls = [], ports = {kind:'native-test', request(url) { calls.push(url); }, openEventStream(url) { calls.push(url); },
    storage:{getItem(){},setItem(){},removeItem(){}}, downloadText(){}};
  const native = platform.create(ports);
  for (const port of [8080,8802,8765,8083,8801]) {
    assert.throws(() => native.request(`http://localhost:${port}/api/command`), /HTTPS/);
    assert.throws(() => native.openEventStream(`http://localhost:${port}/api/updates`), /HTTPS/);
  }
  const browser = platform.createBrowser({location:{href:'http://localhost:8080/unirf-app.html'}, fetch(){throw Error('browser I/O forbidden');}});
  assert.throws(() => browser.request('/local-ip.json'), /HTTPS/);
  assert.deepEqual(calls, []);
  native.request('http://unrelated.example/reference');
  assert.deepEqual(calls, ['http://unrelated.example/reference']);
});

test('direct HTTPS failure propagates once without fallback, credentials or retry',async()=>{
 const calls=[],failure=new TypeError('certificate authority invalid');
 const client=platform.createBrowser({fetch(url,init){calls.push({url,init});return Promise.reject(failure);}});
 await assert.rejects(client.request('https://127.0.0.1:8802/api/command',{method:'POST',body:'{}',credentials:'include',redirect:'follow'}),error=>error===failure);
 assert.equal(calls.length,1);assert.equal(calls[0].init.credentials,'omit');assert.equal(calls[0].init.redirect,'error');
});

function fasheFixture({hostname='localhost', protocol='https:', saved} = {}) {
  const events={}, calls=[], scheduled=[], notices=[], storage=new Map(saved===undefined?[]:[['daty_fashe_api_url',saved]]);
  const input={value:'https://127.0.0.1:8802',addEventListener(name,fn){events[name]=fn;}};
  const c=vm.createContext({URL,performance,AbortSignal,DatyPlatformFactory:platform,
    location:{hostname,protocol,href:`${protocol}//${hostname}:8080/unirf-app.html`},
    console:{log(){},warn(){},error(){}},DEVICES:[],notify(...args){notices.push(args);},
    setTimeout(fn,delay){scheduled.push({fn,delay});return scheduled.length;},clearTimeout(){},
    localStorage:{getItem(key){return storage.get(key)||null;},setItem(key,value){storage.set(key,value);}},
    document:{addEventListener(name,fn){events[name]=fn;},getElementById(id){return id==='fasheApiUrl'?input:null;}},
    fetch(url){calls.push(url);return Promise.reject(new TypeError('TLS certificate not trusted'));}});
  vm.runInContext(load('src/modules/fashe.js'),c);
  vm.runInContext('_fasheMarkDevicesOffline = () => {};',c);
  return {c,events,calls,scheduled,notices,input,storage};
}

test('remote page and old HTTP page choose HTTPS on the actual server, never receiver-local localhost', () => {
  for (const protocol of ['https:','http:']) {
    const f=fasheFixture({hostname:'192.0.2.16',protocol});f.events.DOMContentLoaded();
    assert.equal(f.input.value,'https://192.0.2.16:8802');
    assert.equal(f.storage.has('daty_fashe_api_url'),false); // Do not invent cross-origin localStorage migration.
  }
});

test('legacy saved preferences migrate narrowly, invalid saved targets disable autoconnect without choosing another server', () => {
  const legacy=fasheFixture({saved:'http://localhost:8802/'});legacy.events.DOMContentLoaded();
  assert.equal(legacy.input.value,'https://127.0.0.1:8802');
  assert.equal(legacy.storage.get('daty_fashe_api_url'),legacy.input.value);
  const invalid=fasheFixture({saved:'http://custom.example:9900'});invalid.events.DOMContentLoaded();
  assert.equal(vm.runInContext('_fasheReconnectEnabled',invalid.c),false);
  assert.equal(vm.runInContext('_fasheApiUrl',invalid.c),'http://custom.example:9900');
  assert.equal(invalid.storage.get('daty_fashe_api_url'),'http://custom.example:9900');
  invalid.c._fasheConnect();assert.deepEqual(invalid.calls,[]);
});

test('FAshe bridge certificate failure stays offline and retries HTTPS only', async () => {
  const f=fasheFixture();f.c._fasheConnect();await tick();
  assert.deepEqual(f.calls,['https://127.0.0.1:8802/health']);
  assert.equal(vm.runInContext('_fasheConnected',f.c),false);
  assert.ok(f.notices.some(n=>n.join(' ').includes('CA')));
  const retry=f.scheduled.find(item=>item.delay>0);assert.ok(retry);retry.fn();await tick();
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(url=>url.startsWith('https://')));
});

test('IP API and JSON probes remain HTTPS when an old HTTP page is still open', async () => {
  const calls=[], c=vm.createContext({URL,Date,AbortSignal,AbortController,setTimeout,clearTimeout,DatyPlatformFactory:platform,
    location:{hostname:'192.0.2.16',protocol:'http:'}, fetch(url,init){calls.push({url,init});return Promise.reject(new TypeError('certificate invalid'));}});
  vm.runInContext(load('src/modules/ip-detection.js'),c);
  assert.equal(await c.fetchIPFromAPIService(),false);assert.equal(await c.fetchIPFromFile(),false);
  assert.equal(calls[0].url,'https://192.0.2.16:8765/api/ip');
  assert.match(calls[1].url,/^https:\/\/192\.0\.2\.16:8080\/local-ip\.json\?t=/);
  assert.ok(calls.every(call=>call.init.redirect==='error'));
});

test('production module endpoints contain no hard-coded plaintext service destinations or remote script assets', () => {
  for (const file of ['src/modules/fashe.js','src/modules/init.js','src/modules/discovery.js','src/modules/storage.js','src/modules/timeline.js','src/modules/ip-detection.js','unirf-app.html']) {
    assert.doesNotMatch(load(file),/['"`]http:\/\//,file);
    assert.doesNotMatch(load(file),/['"`]ws:\/\//,file);
  }
  assert.doesNotMatch(load('unirf-app.html'),/<script[^>]+src=["'](?:https?:)?\/\//i);
  for (const file of ['unirf-app.html','ws-probe.html']) assert.match(load(file),/connect-src https: wss:;/);
});
test('diagnostic probe rejects plaintext and embedded credentials before creating connections',()=>{
  const html=load('ws-probe.html');
  const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  const c=vm.createContext({URL,URLSearchParams,location:{search:''},window:{addEventListener(){}},document:{addEventListener(){}}});
  vm.runInContext(scripts.at(-1),c);
  for(const [url,protocol] of [['http://localhost:8802','https:'],['ws://localhost:8801','wss:'],
    ['https://user:pass@localhost:8802','https:'],['wss://localhost:8083?key=secret','wss:']]){
    assert.throws(()=>c.secureProbeUrl(url,protocol));
  }
  assert.equal(c.secureProbeUrl('https://localhost:8802','https:'),'https://127.0.0.1:8802');
});
