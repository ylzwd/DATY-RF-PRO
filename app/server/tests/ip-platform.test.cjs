'use strict';
// IP detection boundary: virtual host/network/clock only, no local or LAN probes.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const factory = require('../src/platform/browser-platform.js');
const source = fs.readFileSync(path.join(__dirname, '../src/modules/ip-detection.js'), 'utf8');
const reply = body => Promise.resolve({json: async () => body});

function harness({kind = 'native-test', saved = '192.168.50.16'} = {}) {
  const values = new Map(saved ? [['daty_local_ip', saved]] : []);
  const elements = new Map(['localIP', 'settingsLocalIP', 'manualIP', 'ipDetectDetail'].map(id => [id, {textContent: '', value: '', innerHTML: ''}]));
  const requests = [], bypasses = [], intervals = new Map(), timeouts = new Map(), notices = [];
  let timerId = 0;
  const platform = {kind, storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)
  }, request(url, init) {
    assert.equal(this, platform, 'IP host request must preserve its method receiver');
    requests.push({url, init}); return platform.handle(url, init);
  }, handle: () => reply({success: false})};
  const c = vm.createContext({URL, Date, Promise, AbortSignal, AbortController, DatyPlatformFactory: factory, DatyPlatform: platform,
    location: {hostname: '192.168.50.16'}, console: {log() {}},
    document: {getElementById: id => elements.get(id) || null},
    notify: (...args) => notices.push(args),
    setInterval: (fn, delay) => {const id = ++timerId; intervals.set(id, {fn, delay}); return id;},
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, delay) => {const id = ++timerId; timeouts.set(id, {fn, delay}); return id;},
    clearTimeout: id => timeouts.delete(id)
  });
  c.DatyHostFactory = factory.host;
  c.DatyHostRuntime = {VERSION:'daty-host-runtime-v1', setTimeout:c.setTimeout, clearTimeout:c.clearTimeout,
    setInterval:c.setInterval, clearInterval:c.clearInterval, nowEpochMs:() => Date.now(), nowMonotonicMs:() => 0};
  c.window = c;
  for (const key of ['fetch', 'localStorage', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
    Object.defineProperty(c, key, {configurable: true, get() {bypasses.push(key); throw new Error('Browser bypass: ' + key);}});
  }
  vm.runInContext(source, c, {filename: 'ip-detection.js'});
  return {c, platform, values, elements, requests, bypasses, intervals, timeouts, notices};
}

test('IP API preserves the injected method receiver, HTTPS, redirect rule and abort signal', async () => {
  const h = harness();
  h.platform.handle = () => reply({success: true, ip: '192.168.50.17', all_ips: ['192.168.50.17', '10.0.0.2']});
  assert.equal(await h.c.fetchIPFromAPIService(), true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, 'https://192.168.50.16:8765/api/ip');
  assert.equal(h.requests[0].init.redirect, 'error');
  assert.ok(h.requests[0].init.signal instanceof AbortSignal);
  assert.equal(h.values.get('daty_local_ip'), '192.168.50.17');
  assert.equal(h.elements.get('settingsLocalIP').value, '192.168.50.17');
  assert.equal(vm.runInContext('_currentDetectedIPs.length', h.c), 2);
  assert.deepEqual(h.bypasses, []);
});

test('IP JSON remains the second readonly source through the same host', async () => {
  const h = harness();
  h.platform.handle = url => reply(url.includes('local-ip.json') ? {success: true, ip: '192.168.50.18'} : {success: false});
  await h.c.getLocalIP();
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1].url, /^https:\/\/192\.168\.50\.16:8080\/local-ip\.json\?t=\d+$/);
  assert.equal(h.requests[1].init.redirect, 'error');
  assert.ok(h.requests.every(r => !r.init.method || r.init.method === 'GET'));
  assert.equal(h.values.get('daty_local_ip'), '192.168.50.18');
  assert.deepEqual(h.bypasses, []);
});

test('an incomplete or null native platform never reaches browser fetch or WebRTC', async () => {
  for (const invalid of [null, {kind: 'native-test'}, {kind: 'native-test', request: true}]) {
    const h = harness(); h.c.DatyPlatform = invalid;
    assert.equal(await h.c.fetchIPFromAPIService(), false);
    assert.equal(await h.c.fetchIPFromFile(), false);
    assert.equal(await h.c.fetchIPViaWebRTC(), false);
    assert.deepEqual(h.bypasses, []); assert.equal(h.requests.length, 0);
  }
});

test('sync host errors and async rejections keep native fallback readonly, bounded and on host cache', async () => {
  for (const sync of [true, false]) {
    const h = harness();
    h.platform.handle = () => {if (sync) throw new Error('Host offline'); return Promise.reject(new Error('Host offline'));};
    await h.c.getLocalIP();
    assert.equal(h.requests.length, 2, 'one API probe and one JSON probe, no duplicate transport retry');
    assert.equal(h.elements.get('localIP').textContent, '局域网 192.168.50.16');
    assert.equal(h.intervals.size, 1); assert.equal([...h.intervals.values()][0].delay, 60000);
    assert.deepEqual(h.bypasses, []);
  }
});

test('native discovery never probes browser RTC, even when available, and preserves unknown IP', async () => {
  const h = harness({saved: null});
  await h.c.getLocalIP();
  assert.equal(h.elements.get('localIP').textContent, '局域网 (点击设置)');
  assert.equal(h.elements.get('settingsLocalIP').value, '未获取');
  assert.equal(h.values.has('daty_local_ip'), false);
  assert.deepEqual(h.bypasses, []);
});

test('browser and legacy WebRTC fallback retain local-only candidates and close the peer', async () => {
  for (const legacy of [false, true]) {
    const h = harness({kind: 'browser'}); let peer, config, closed = 0;
    if (legacy) h.c.DatyPlatform = undefined;
    Object.defineProperty(h.c, 'localStorage', {value: h.platform.storage});
    Object.defineProperty(h.c, 'fetch', {value: () => reply({success: false})});
    Object.defineProperty(h.c, 'RTCPeerConnection', {value: class {
      constructor(options) {config = options; peer = this;}
      createDataChannel() {}
      createOffer() {return Promise.resolve({type: 'offer'});}
      setLocalDescription() {return Promise.resolve();}
      close() {closed++;}
    }});
    const pending = h.c.getLocalIP();
    for (let i = 0; i < 40 && !peer; i++) await Promise.resolve();
    assert.ok(peer); assert.equal(config.iceServers.length, 0);
    peer.onicecandidate({candidate: {candidate: 'candidate:1 1 udp 123 192.168.50.19 50000 typ host'}});
    await pending;
    assert.equal(closed, 1); assert.equal(h.values.get('daty_local_ip'), '192.168.50.19');
    assert.deepEqual(h.bypasses, []);
  }
});

test('native manual redetection and the existing refresh interval keep host-owned values and notices', async () => {
  const h = harness();
  await h.c.getLocalIP();
  const refresh = [...h.intervals.values()][0];
  h.platform.handle = () => reply({success: true, ip: '192.168.50.20'});
  await refresh.fn();
  assert.equal(h.notices.length, 1); assert.equal(h.notices[0][1], 'IP 已更新');
  await h.c._redetectIP();
  assert.equal(h.elements.get('manualIP').value, '192.168.50.20');
  assert.match(h.elements.get('ipDetectDetail').innerHTML, /本地API服务 ✓/);
  await h.c.getLocalIP(); assert.equal(h.intervals.size, 1);
  assert.deepEqual(h.bypasses, []);
});
