'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const access = require('../src/platform/access-client.js');
const platform = require('../src/platform/browser-platform.js');
const source = fs.readFileSync(path.join(__dirname, '../src/platform/access-client.js'), 'utf8');
const KEY = 'daty_fixture_opaque_memory_only_key';
const ORIGIN = 'https://127.0.0.1:8802';
const scopes = ['device.control', 'project.write', 'timeline.write', 'discovery.scan'];
function status({authenticated = true, role = 'operator', configured = true} = {}) {
  return new Response(JSON.stringify({success: true, auth: {protocol: access.PROTOCOL, configured,
    authenticated, principal: authenticated ? {id: 'test-id', name: 'Operator', role} : null,
    permissions: authenticated && role === 'operator' ? scopes : [], mode: authenticated ? 'authorized' : 'read-only'}}), {status: 200});
}
function fixture() {
  const calls = [];
  let origin = ORIGIN;
  let respond = () => status();
  const client = access.create({getBridgeUrl: () => origin, transport(url, init) { calls.push({url, init}); return Promise.resolve(respond(url, init)); }});
  return {client, calls, setOrigin(value) { origin = value; }, setResponse(fn) { respond = fn; }};
}

test('module loading and factory construction perform no browser or storage I/O', () => {
  const context = {URL};
  for (const key of ['fetch', 'document', 'localStorage', 'sessionStorage', 'EventSource']) {
    Object.defineProperty(context, key, {get() { throw Error('Unexpected I/O ' + key); }});
  }
  vm.runInNewContext(source, context);
  assert.equal(context.DatyAccessFactory.PROTOCOL, 'daty-access-v1');
  assert.doesNotThrow(() => context.DatyAccessFactory.create({transport() { throw Error('I/O'); }}));
});

test('Bridge validation preserves localhost IPv4 migration and rejects credential-bearing URLs', () => {
  assert.equal(access.bridgeOrigin('http://localhost:8802/'), ORIGIN);
  assert.equal(access.bridgeOrigin('https://localhost:8802/'), ORIGIN);
  for (const url of ['http://user:pass@127.0.0.1:8802/', ORIGIN + '/api', ORIGIN + '/?key=x', ORIGIN + '/#x', 'file:///x']) {
    assert.throws(() => access.bridgeOrigin(url));
  }
});

test('successful authentication validates server identity before exposing permissions; key stays private', async () => {
  const f = fixture();
  const state = await f.client.authenticate(KEY);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, ORIGIN + '/api/auth/status');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer ' + KEY);
  assert.equal(f.calls[0].init.redirect, 'error');
  assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(state.authenticated, true);
  assert.deepEqual(state.permissions, scopes);
  assert.ok(!JSON.stringify(state).includes(KEY));
  assert.ok(!JSON.stringify(f.client).includes(KEY));
  assert.equal(Object.isFrozen(state.principal), true);
});

test('request decorates only exact Bridge API and same-host discovery paths, never other origins', async () => {
  const f = fixture(); await f.client.authenticate(KEY); f.calls.length = 0;
  for (const url of [ORIGIN + '/api/command', ORIGIN + '/api/projects', 'https://127.0.0.1:8765/api/discover?force=1', 'https://127.0.0.1:8765/api/ip/refresh']) {
    await f.client.request(url, {method: 'POST'});
    assert.equal(f.calls.at(-1).init.headers.authorization, 'Bearer ' + KEY);
  }
  for (const url of ['https://127.0.0.1:8080/api/command', 'https://127.0.0.1:8765/api/ip', 'https://127.0.0.1.evil.test:8802/api/command', 'https://different.test:8802/api/command', ORIGIN + '/health', 'https://user@127.0.0.1:8802/api/command']) {
    const init = {method: 'GET'}; await f.client.request(url, init);
    assert.equal(f.calls.at(-1).init, init);
    assert.equal(f.calls.at(-1).init.headers, undefined);
  }
});

test('caller headers/body/signal are preserved without mutation while authorization and redirects are owned', async () => {
  const f = fixture(); await f.client.authenticate(KEY);
  const signal = new AbortController().signal;
  const headers = {'Content-Type': 'application/json', 'X-Client': 'native-ready', Authorization: 'old'};
  const init = {method: 'POST', body: '{"muted":false}', signal, headers, redirect: 'follow', credentials: 'include'};
  await f.client.request(ORIGIN + '/api/command', init);
  const sent = f.calls.at(-1).init;
  assert.equal(sent.body, init.body); assert.equal(sent.signal, signal);
  assert.equal(sent.headers['content-type'], 'application/json'); assert.equal(sent.headers['x-client'], 'native-ready');
  assert.equal(sent.headers.authorization, 'Bearer ' + KEY); assert.equal(headers.Authorization, 'old');
  assert.equal(init.redirect, 'follow'); assert.equal(sent.redirect, 'error');
});

test('Headers and tuple-array inputs retain non-authentication headers', async () => {
  const f = fixture(); await f.client.authenticate(KEY);
  for (const headers of [new Headers({'Content-Type': 'application/json'}), [['Content-Type', 'application/json']]]) {
    await f.client.request(ORIGIN + '/api/command', {headers});
    assert.equal(f.calls.at(-1).init.headers['content-type'], 'application/json');
  }
});

test('public readonly requests require no key and a new client never restores old credentials', async () => {
  const f = fixture(); f.setResponse(() => status({authenticated: false}));
  assert.equal((await f.client.refresh()).authenticated, false);
  assert.equal(f.calls.at(-1).init.headers.authorization, undefined);
  assert.equal(f.client.snapshot().mode, 'read-only');
  assert.equal(access.create({transport() {}}).snapshot().authenticated, false);
});

test('viewer authorization remains read-only without inventing device permissions', async () => {
  const f = fixture(); f.setResponse(() => status({role: 'viewer'}));
  const state = await f.client.authenticate(KEY);
  assert.equal(state.authenticated, true); assert.equal(state.mode, 'read-only'); assert.deepEqual(state.permissions, []);
});

test('origin changes clear credentials before any network call and returning to old origin does not restore key', async () => {
  const f = fixture(); await f.client.authenticate(KEY);
  f.setOrigin('https://192.0.2.103:8802');
  const count = f.calls.length;
  const response = await f.client.request('https://192.0.2.103:8802/api/command', {method: 'POST'});
  assert.equal(response.status, 401); assert.equal((await response.json()).local, true);
  assert.equal(f.calls.length, count);
  assert.equal(f.client.snapshot().authenticated, false);
  f.setOrigin(ORIGIN); assert.equal((await f.client.request(ORIGIN + '/api/command', {method: 'POST'})).status, 401);
  assert.equal(f.calls.length, count);
});

test('unauthorized protected writes return immediate known-unsent denial without any transport or ACK wait', async () => {
  const f = fixture();
  for (const [url, method] of [[ORIGIN + '/api/command', 'POST'], [ORIGIN + '/api/projects', 'POST'],
    [ORIGIN + '/api/coordination-runs', 'POST'], [ORIGIN + '/api/timeline/events', 'POST'],
    ['https://127.0.0.1:8765/api/discover?force=1', 'GET'], ['https://127.0.0.1:8765/api/ip/refresh', 'GET']]) {
    const response = await f.client.request(url, {method});
    assert.equal(response.ok, false); assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), JSON.parse(await response.text()));
    const body = await response.json();
    assert.equal(body.success, false); assert.equal(body.accepted, false); assert.equal(body.local, true);
    assert.equal(body.code, 'AUTH_REQUIRED'); assert.match(body.error, /请求未发送，请先授权控制/);
  }
  assert.equal(f.calls.length, 0);
});

test('viewer cannot issue protected writes or active scans even against a legacy server accepting everything', async () => {
  const f = fixture(); f.setResponse(() => status({role: 'viewer'})); await f.client.authenticate(KEY);
  const count = f.calls.length; f.setResponse(() => status());
  for (const [url, method] of [[ORIGIN + '/api/command', 'POST'], [ORIGIN + '/api/projects', 'POST'],
    [ORIGIN + '/api/timeline/events', 'POST'], ['https://127.0.0.1:8765/api/discover', 'GET']]) {
    const response = await f.client.request(url, {method});
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'FORBIDDEN');
  }
  assert.equal(f.calls.length, count);
});

test('local permission decisions use explicit scope per operation and unknown mutation paths fail closed', async () => {
  const f = fixture();
  f.setResponse(async () => {
    const body = await status().json(); body.auth.permissions = ['device.control'];
    return new Response(JSON.stringify(body), {status: 200});
  });
  await f.client.authenticate(KEY); f.setResponse(() => new Response('{}', {status: 200}));
  assert.equal((await f.client.request(ORIGIN + '/api/command', {method: 'POST'})).status, 200);
  const count = f.calls.length;
  for (const url of [ORIGIN + '/api/projects', ORIGIN + '/api/coordination-runs', ORIGIN + '/api/timeline/events', ORIGIN + '/api/future-write']) {
    assert.equal((await f.client.request(url, {method: 'POST'})).status, 403);
  }
  assert.equal(f.calls.length, count);
});

test('logout blocks next mutation before transport and readonly public reads continue', async () => {
  const f = fixture(); await f.client.authenticate(KEY); f.client.logout(); const count = f.calls.length;
  assert.equal((await f.client.request(ORIGIN + '/api/command', {method: 'POST'})).status, 401);
  assert.equal(f.calls.length, count);
  await f.client.request(ORIGIN + '/api/devices', {method: 'GET'});
  assert.equal(f.calls.length, count + 1); assert.equal(f.calls.at(-1).init.headers.authorization, undefined);
});

test('invalid selected origin clears key and prevents protected request dispatch', async () => {
  const f = fixture(); await f.client.authenticate(KEY); f.setOrigin('file:///secret');
  const count = f.calls.length;
  assert.throws(() => f.client.request(ORIGIN + '/api/command', {method: 'POST'}));
  assert.equal(f.calls.length, count);
  f.setOrigin(ORIGIN); assert.equal(f.client.snapshot().authenticated, false);
});

test('401 clears only current credential; mutation is sent exactly once and response survives', async () => {
  const f = fixture(); await f.client.authenticate(KEY);
  const rejected = new Response('{"code":"AUTH_REQUIRED"}', {status: 401}); f.setResponse(() => rejected);
  const count = f.calls.length;
  const response = await f.client.request(ORIGIN + '/api/command', {method: 'POST'});
  assert.equal(response, rejected); assert.equal(f.calls.length, count + 1); assert.equal(f.client.snapshot().authenticated, false);
});

test('403 preserves authenticated identity and does not retry the forbidden mutation', async () => {
  const f = fixture(); await f.client.authenticate(KEY); f.setResponse(() => new Response('', {status: 403}));
  const count = f.calls.length;
  assert.equal((await f.client.request(ORIGIN + '/api/command', {method: 'POST'})).status, 403);
  assert.equal(f.calls.length, count + 1); assert.equal(f.client.snapshot().authenticated, true);
});

test('network failures never automatically retry a mutation', async () => {
  const f = fixture(); await f.client.authenticate(KEY); const failure = new Error('disconnect');
  f.setResponse(() => Promise.reject(failure)); const count = f.calls.length;
  await assert.rejects(f.client.request(ORIGIN + '/api/command', {method: 'POST'}), error => error === failure);
  assert.equal(f.calls.length, count + 1);
});

test('redirect:error is requested before login dispatch; redirects cannot authenticate or retry', async () => {
  const f = fixture(); f.setResponse(() => new Response('', {status: 302, headers: {Location: 'http://evil.test'}}));
  await assert.rejects(f.client.authenticate(KEY), {code: 'AUTH_REDIRECT_BLOCKED'});
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.redirect, 'error'); assert.equal(f.client.snapshot().authenticated, false);
});

test('a transport violating redirect contract is detected even if response is 200', async () => {
  const f = fixture(); f.setResponse(() => ({ok: true, status: 200, redirected: true}));
  await assert.rejects(f.client.authenticate(KEY), {code: 'AUTH_REDIRECT_BLOCKED'});
  assert.equal(f.client.snapshot().authenticated, false);
});

test('bad key/status protocols/configuration do not grant permissions', async () => {
  const f = fixture();
  await assert.rejects(f.client.authenticate('bad\nkey'), {code: 'AUTH_INVALID_KEY'});
  assert.equal(f.calls.length, 0);
  f.setResponse(() => new Response('{}', {status: 200}));
  await assert.rejects(f.client.authenticate(KEY), {code: 'AUTH_PROTOCOL_MISMATCH'});
  f.setResponse(() => status({authenticated: false, configured: false}));
  await assert.rejects(f.client.authenticate(KEY), {code: 'AUTH_NOT_CONFIGURED'});
  f.setResponse(() => new Response('', {status: 401}));
  await assert.rejects(f.client.authenticate(KEY), {code: 'AUTH_REQUIRED'});
  assert.equal(f.client.snapshot().authenticated, false);
});

test('logout during an in-flight authentication prevents delayed credential installation', async () => {
  const f = fixture(); let finish;
  f.setResponse(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.client.authenticate(KEY); f.client.logout(); finish(status());
  await assert.rejects(pending, {code: 'AUTH_SESSION_CHANGED'});
  assert.equal(f.client.snapshot().authenticated, false);
});

test('origin change during authentication rejects identity from previous server', async () => {
  const f = fixture(); let finish;
  f.setResponse(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.client.authenticate(KEY); f.setOrigin('https://192.0.2.105:8802'); finish(status());
  await assert.rejects(pending, {code: 'AUTH_SESSION_CHANGED'});
  assert.equal(f.client.snapshot().authenticated, false);
});

test('late 401 from previous session does not revoke newly authenticated identity', async () => {
  const f = fixture(); await f.client.authenticate(KEY); let finish;
  f.setResponse(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.client.request(ORIGIN + '/api/command', {method: 'POST'});
  f.setResponse(() => status()); await f.client.authenticate(KEY + '_new');
  finish(new Response('', {status: 401})); await pending;
  assert.equal(f.client.snapshot().authenticated, true);
});

test('cancelled authorization is not installed even if custom transport completes after cancellation', async () => {
  const f = fixture(); const controller = new AbortController();
  f.setResponse(() => { controller.abort(); return status(); });
  await assert.rejects(f.client.authenticate(KEY, {signal: controller.signal}), {code: 'AUTH_CANCELLED'});
  assert.equal(f.client.snapshot().authenticated, false);
});

test('native reusable transport has no browser fallback and preserves status/ACK responses', async () => {
  let calls = 0;
  const client = access.create({bridgeUrl: ORIGIN, transport(url, init) { calls++; return Promise.resolve(url.endsWith('/status') ? status() : new Response('ACK', {status: 202})); }});
  await client.authenticate(KEY);
  assert.equal(await (await client.request(ORIGIN + '/api/command', {method: 'POST'})).text(), 'ACK');
  assert.equal(calls, 2);
});

test('browser platform decorates requests only when client explicitly mounted; injected native request is untouched', () => {
  const response = Promise.resolve('host'); let routed = 0;
  const browser = platform.createBrowser({DatyAccess: {request() { routed++; return response; }}, fetch() { throw Error('raw browser transport'); }});
  assert.equal(browser.request(ORIGIN + '/api/command'), response); assert.equal(routed, 1);
  const native = platform.create({kind: 'native-test', request() { return response; }, openEventStream() {},
    storage: {getItem() {}, setItem() {}, removeItem() {}}, downloadText() {}});
  assert.equal(native.request(ORIGIN + '/api/command'), response); assert.equal(routed, 1);
});

test('subscribers receive no key and exceptions cannot turn command success into failure', async () => {
  const f = fixture(); let seen = [];
  const unsubscribe = f.client.subscribe(state => { seen.push(state); throw Error('view failed'); });
  await f.client.authenticate(KEY); unsubscribe(); f.client.logout();
  assert.ok(seen.length); assert.ok(!JSON.stringify(seen).includes(KEY));
});

test('authorization UI uses password dialog and explicitly boots after application scripts', () => {
  const html = fs.readFileSync(path.join(__dirname, '../unirf-app.html'), 'utf8');
  assert.match(html, /<dialog id="datyAccessDialog"/);
  assert.match(html, /id="datyAccessKey" type="password"/);
  assert.ok(html.indexOf('access-client.js') < html.indexOf('browser-platform.js'));
  assert.match(html, /DOMContentLoaded[\s\S]+mountBrowserUI/);
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage)\s*\./);
  assert.doesNotMatch(source, /\b(?:prompt|alert|confirm)\s*\(/);
});

test('permission preflight rejects readonly and viewers without transport, and verifies operator by readonly status', async () => {
  const f=fixture();
  assert.throws(()=>f.client.assertPermission('device.control'),{code:'AUTH_REQUIRED'});
  await assert.rejects(f.client.verifyPermission('device.control'),{code:'AUTH_REQUIRED'});
  assert.equal(f.calls.length,0);
  f.setResponse(()=>status({role:'viewer'}));await f.client.authenticate(KEY);
  const viewerCalls=f.calls.length;
  await assert.rejects(f.client.verifyPermission('device.control'),{code:'FORBIDDEN'});
  assert.equal(f.calls.length,viewerCalls);
  f.setResponse(()=>status());await f.client.authenticate(KEY);f.calls.length=0;
  const state=await f.client.verifyPermission('device.control');
  assert.equal(state.authenticated,true);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].url,ORIGIN+'/api/auth/status');assert.equal(f.calls[0].init.method,'GET');
  assert.equal(f.calls[0].init.body,undefined);assert.ok(!JSON.stringify(state).includes(KEY));
  assert.throws(()=>f.client.assertPermission('unknown.control'),{code:'FORBIDDEN'});
});

test('permission verification catches server revocation, downgrade, network failure and cancellation before commands', async () => {
  for(const reply of [()=>new Response('',{status:401}),()=>status({role:'viewer'}),()=>Promise.reject(Error('offline'))]){
    const f=fixture();await f.client.authenticate(KEY);f.calls.length=0;f.setResponse(reply);
    await assert.rejects(f.client.verifyPermission('device.control'));
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.method,'GET');
  }
  const f=fixture();await f.client.authenticate(KEY);const controller=new AbortController();
  f.setResponse(()=>{controller.abort();return status();});
  await assert.rejects(f.client.verifyPermission('device.control',{signal:controller.signal}),{code:'AUTH_CANCELLED'});
});

test('authorization revision changes on logout/relogin, but not routine readonly verification',async()=>{
  const f=fixture();const first=await f.client.authenticate(KEY);
  assert.equal((await f.client.verifyPermission('device.control')).revision,first.revision);
  f.client.logout();assert.notEqual(f.client.snapshot().revision,first.revision);
  assert.notEqual((await f.client.authenticate(KEY)).revision,first.revision);
});

function localStatus(overrides = {}) {
  return new Response(JSON.stringify({success: true, auth: {protocol: access.PROTOCOL, configured: true,
    authenticated: true, principal: {id: 'local-development', name: '本机开发', role: 'operator'},
    permissions: scopes, mode: 'local-development', ...overrides}}), {status: 200});
}

test('local HTTPS selection never grants control before an explicit server-confirmed development status', async () => {
  const f = fixture(); f.setResponse(() => localStatus());
  assert.equal(f.client.snapshot().authenticated, false);
  assert.equal((await f.client.request(ORIGIN + '/api/command', {method: 'POST'})).status, 401);
  assert.equal(f.calls.length, 0);
  const current = await f.client.refresh();
  assert.equal(current.mode, 'local-development'); assert.equal(current.authenticated, true);
  assert.deepEqual(current.permissions, scopes); assert.equal(current.principal.id, 'local-development');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.headers['x-daty-local-development'], '1');
  assert.equal(f.calls[0].init.headers.authorization, undefined);
  assert.equal(f.calls[0].init.redirect, 'error'); assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(f.client.assertPermission('device.control').revision, current.revision);
});

test('development mutations and active discovery use the scoped marker without token, extra status checks or caller-header mutation', async () => {
  const f = fixture(); f.setResponse(() => localStatus()); await f.client.refresh(); f.calls.length = 0;
  const headers = {'X-DATY-Local-Development': 'forged', Authorization: 'caller-secret', 'Content-Type': 'application/json'};
  for (const [url, method] of [[ORIGIN + '/api/command', 'POST'], [ORIGIN + '/api/projects', 'POST'],
    [ORIGIN + '/api/coordination-runs', 'POST'], [ORIGIN + '/api/timeline/events', 'POST'],
    ['https://127.0.0.1:8765/api/discover?force=1', 'GET'], ['https://127.0.0.1:8765/api/ip/refresh', 'GET']]) {
    const count = f.calls.length, signal = new AbortController().signal;
    await f.client.request(url, {method, headers, body: method === 'POST' ? '{}' : undefined, signal});
    assert.equal(f.calls.length, count + 1); assert.equal(f.calls.at(-1).url, url);
    assert.equal(f.calls.at(-1).init.headers['x-daty-local-development'], '1');
    assert.equal(f.calls.at(-1).init.headers.authorization, undefined);
    assert.equal(f.calls.at(-1).init.signal, signal);
  }
  assert.equal(headers['X-DATY-Local-Development'], 'forged'); assert.equal(headers.Authorization, 'caller-secret');
  const count = f.calls.length;
  assert.equal((await f.client.request(ORIGIN + '/api/future-write', {method: 'POST'})).status, 403);
  assert.equal(f.calls.length, count);
});

test('local marker is stripped from unmanaged and remote calls while explicit Bearer takes precedence', async () => {
  const f = fixture(); f.setResponse(() => localStatus()); await f.client.refresh();
  for (const url of [ORIGIN + '/health', 'https://127.0.0.1:8765/api/ip', 'https://other.test:8802/api/command',
    'https://127.0.0.1:8080/api/auth/status', 'https://127.0.0.1.evil.test:8802/api/auth/status', '/relative-api']) {
    await f.client.request(url, {headers: {'X-DATY-Local-Development': '1', 'X-Other': 'kept'}});
    assert.equal(f.calls.at(-1).init.headers['x-daty-local-development'], undefined);
    assert.equal(f.calls.at(-1).init.headers['x-other'], 'kept');
  }
  f.setOrigin('https://remote.test:8802'); f.setResponse(() => status({authenticated: false}));
  await f.client.refresh(); assert.equal(f.calls.at(-1).init.headers['x-daty-local-development'], undefined);
  f.setResponse(() => status()); await f.client.authenticate(KEY);
  await f.client.request('https://remote.test:8802/api/command', {method: 'POST', headers: {'X-DATY-Local-Development': '1'}});
  assert.equal(f.calls.at(-1).init.headers['x-daty-local-development'], undefined);
  assert.equal(f.calls.at(-1).init.headers.authorization, 'Bearer ' + KEY);
  f.setOrigin(ORIGIN); await f.client.authenticate(KEY);
  assert.equal(f.calls.at(-1).init.headers['x-daty-local-development'], undefined);
  await f.client.request(ORIGIN + '/api/command', {method: 'POST'});
  assert.equal(f.calls.at(-1).init.headers['x-daty-local-development'], undefined);
  assert.equal(f.calls.at(-1).init.headers.authorization, 'Bearer ' + KEY);
});

test('unconfirmed, incomplete and remote development claims cannot create a local session', async () => {
  for (const overrides of [{configured: false}, {authenticated: false}, {principal: null}, {principal: {id: '', role: 'operator'}},
    {principal: {id: 'viewer', role: 'viewer'}}, {permissions: ['device.control']}, {permissions: null}]) {
    const f = fixture(); f.setResponse(() => localStatus(overrides));
    await assert.rejects(f.client.refresh(), {code: 'AUTH_PROTOCOL_MISMATCH'});
    assert.equal(f.client.snapshot().authenticated, false);
  }
  const f = fixture(); f.setResponse(() => localStatus({mode: 'authorized'}));
  assert.equal((await f.client.refresh()).authenticated, false, 'Bare authenticated claims are not local-development authorization.');
  f.setOrigin('https://remote.test:8802'); f.setResponse(() => localStatus());
  await assert.rejects(f.client.refresh(), {code: 'AUTH_PROTOCOL_MISMATCH'});
  assert.equal(f.client.snapshot().authenticated, false);
});

test('unconfirmed and paused readonly traffic stays compatible with old servers without the development header', async () => {
  const f = fixture(); f.setResponse(() => new Response('{}'));
  await f.client.request(ORIGIN + '/api/devices');
  assert.equal(f.calls.at(-1).init.headers['x-daty-local-development'], undefined);
  f.setResponse(() => localStatus()); await f.client.refresh(); f.client.logout();
  await f.client.request(ORIGIN + '/api/devices');
  assert.equal(f.calls.at(-1).init.headers['x-daty-local-development'], undefined);
});

test('invalid explicit Bearer cannot fall back to local development', async () => {
  const f = fixture(); f.setResponse(() => localStatus()); await f.client.refresh();
  f.setResponse(() => new Response('', {status: 401})); const count = f.calls.length;
  await assert.rejects(f.client.authenticate('invalid-explicit-key'), {code: 'AUTH_REQUIRED'});
  assert.equal(f.calls.length, count + 1); assert.equal(f.calls.at(-1).init.headers.authorization, 'Bearer invalid-explicit-key');
  assert.equal(f.calls.at(-1).init.headers['x-daty-local-development'], undefined);
  assert.equal(f.client.snapshot().authenticated, false);
  f.setResponse(() => localStatus()); await f.client.refresh();
  assert.equal(f.client.snapshot().authenticated, false); assert.equal(f.calls.length, count + 1);
});

test('development pause survives background refresh; explicit tokenless resume changes the session without replay', async () => {
  const f = fixture(); f.setResponse(() => localStatus()); const original = await f.client.refresh();
  const routine = await f.client.verifyPermission('device.control'); assert.equal(routine.revision, original.revision);
  f.client.logout(); const paused = f.client.snapshot(), count = f.calls.length;
  assert.equal(paused.paused, true); assert.equal(paused.localDevelopmentAvailable, true); assert.equal(paused.mode, 'read-only');
  assert.equal((await f.client.refresh()).authenticated, false); assert.equal(f.calls.length, count);
  assert.equal((await f.client.request(ORIGIN + '/api/command', {method: 'POST'})).status, 401); assert.equal(f.calls.length, count);
  const restored = await f.client.resume(); assert.equal(restored.mode, 'local-development');
  assert.notEqual(restored.revision, original.revision); assert.equal(f.calls.length, count + 1);
  assert.ok(f.calls.every(call => call.init.method === 'GET')); assert.equal(f.calls.at(-1).init.headers.authorization, undefined);
});

test('401 and unavailable development transport pause control without retry or implicit recovery', async () => {
  for (const reply of [() => new Response('', {status: 401}), () => Promise.reject(new Error('offline')),
    () => { throw new Error('native transport offline'); }]) {
    const f = fixture(); f.setResponse(() => localStatus()); await f.client.refresh(); f.calls.length = 0; f.setResponse(reply);
    try { await f.client.request(ORIGIN + '/api/command', {method: 'POST'}); } catch (_) { /* uncertain POST remains failed */ }
    assert.equal(f.calls.length, 1); assert.equal(f.client.snapshot().authenticated, false);
    f.setResponse(() => localStatus()); await f.client.refresh(); assert.equal(f.calls.length, 1);
    assert.equal((await f.client.request(ORIGIN + '/api/command', {method: 'POST'})).status, 401); assert.equal(f.calls.length, 1);
  }
});

test('caller cancellation after matching SSE ACK does not revoke local permission for the next command', async () => {
  for (const nativeAbort of [false, true]) {
    const f = fixture(); f.setResponse(() => localStatus()); const before = await f.client.refresh();
    const controller = new AbortController(); let rejectPost;
    f.setResponse(() => new Promise((_, reject) => { rejectPost = reject; }));
    const pending = f.client.request(ORIGIN + '/api/command', {method: 'POST', signal: controller.signal});
    // navigation.js aborts this transport once its independent SSE channel has
    // validated the exact receiver/CH/command/executed-state ACK.
    const error = new Error('ACK already completed the command');
    if (nativeAbort) error.name = 'AbortError'; else controller.abort();
    rejectPost(error); await assert.rejects(pending);
    assert.equal(f.client.snapshot().mode, 'local-development'); assert.equal(f.client.snapshot().revision, before.revision);
    f.setResponse(() => new Response('{}')); const count = f.calls.length;
    assert.equal((await f.client.request(ORIGIN + '/api/command', {method: 'POST'})).status, 200);
    assert.equal(f.calls.length, count + 1);
  }
});

test('local status unavailability or revoked development mode prevents planning verification', async () => {
  for (const reply of [() => status({authenticated: false}), () => localStatus({permissions: ['device.control']}),
    () => Promise.reject(new Error('TLS certificate invalid')), () => new Response('', {status: 503})]) {
    const f = fixture(); f.setResponse(() => localStatus()); const before = await f.client.refresh();
    f.setResponse(reply); await assert.rejects(f.client.verifyPermission('device.control'));
    assert.equal(f.client.snapshot().authenticated, false); assert.notEqual(f.client.snapshot().revision, before.revision);
  }
});

test('changed local identity invalidates a previously reviewed planning session', async () => {
  const f = fixture(); f.setResponse(() => localStatus()); await f.client.refresh();
  f.setResponse(() => localStatus({principal: {id: 'changed-local-principal', role: 'operator'}}));
  await assert.rejects(f.client.verifyPermission('device.control'), {code: 'AUTH_SESSION_CHANGED'});
});

test('pause, cancellation and target changes prevent late development status installation', async () => {
  for (const action of ['pause', 'cancel', 'target']) {
    const f = fixture(), controller = new AbortController(); let finish;
    f.setResponse(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.client.refresh({signal: controller.signal});
    if (action === 'pause') f.client.logout();
    if (action === 'cancel') controller.abort();
    if (action === 'target') f.setOrigin('https://remote.test:8802');
    finish(localStatus()); await assert.rejects(pending);
    assert.equal(f.client.snapshot().authenticated, false);
  }
  const f = fixture(); let finishJson;
  f.setResponse(() => ({ok: true, status: 200, json: () => new Promise(resolve => { finishJson = resolve; })}));
  const pending = f.client.refresh(); await Promise.resolve(); f.client.logout();
  finishJson(await localStatus().json()); await assert.rejects(pending, {code: 'AUTH_SESSION_CHANGED'});
  assert.equal(f.client.snapshot().authenticated, false);
});

test('a late development 401 cannot revoke the explicitly resumed session', async () => {
  const f = fixture(); f.setResponse(() => localStatus()); await f.client.refresh(); let finish;
  f.setResponse(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.client.request(ORIGIN + '/api/command', {method: 'POST'});
  f.client.logout(); f.setResponse(() => localStatus()); const next = await f.client.resume();
  finish(new Response('', {status: 401})); await pending;
  assert.equal(f.client.snapshot().mode, 'local-development'); assert.equal(f.client.snapshot().revision, next.revision);
});
