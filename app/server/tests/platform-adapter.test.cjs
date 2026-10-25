'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const factory = require('../src/platform/browser-platform.js');
const source = fs.readFileSync(path.join(__dirname, '../src/platform/browser-platform.js'), 'utf8');

function forbiddenBrowser() {
  const context = {};
  for (const name of ['fetch', 'EventSource', 'localStorage', 'document', 'Blob', 'URL']) {
    Object.defineProperty(context, name, {get() { throw new Error('Unexpected browser access: ' + name); }});
  }
  return context;
}

function hostPorts(extra = {}) {
  return {
    kind: 'native-test',
    request() { throw new Error('Unused request'); },
    openEventStream() { throw new Error('Unused stream'); },
    storage: {getItem() { return null; }, setItem() {}, removeItem() {}},
    downloadText() { throw new Error('Unused download'); },
    ...extra
  };
}

function downloadRuntime(failAt, failure = new Error('download failed')) {
  const events = [];
  const link = {
    parentNode: null,
    click() { events.push('click'); if (failAt === 'click') throw failure; }
  };
  const body = {
    appendChild(node) {
      events.push('append');
      if (failAt === 'append') throw failure;
      node.parentNode = body;
    },
    removeChild(node) {
      events.push('remove');
      node.parentNode = null;
      if (failAt === 'remove') throw failure;
    }
  };
  const runtime = {
    Blob,
    document: {body, createElement(tag) {
      assert.equal(tag, 'a');
      events.push('create');
      if (failAt === 'create') throw failure;
      return link;
    }},
    URL: {
      createObjectURL(blob) {
        events.push('url');
        runtime.blob = blob;
        if (failAt === 'url') throw failure;
        return 'blob:test-download';
      },
      revokeObjectURL(url) {
        assert.equal(url, 'blob:test-download');
        events.push('revoke');
        if (failAt === 'revoke') throw failure;
      }
    }
  };
  return {runtime, events, link, failure};
}

test('browser script installation and repeated loading perform no network, storage, or DOM access', () => {
  const context = vm.createContext(forbiddenBrowser());
  vm.runInContext(source, context);
  const first = context.DatyPlatform;
  assert.equal(first.VERSION, '1.0.0');
  assert.equal(first.kind, 'browser');
  vm.runInContext(source, context);
  assert.equal(context.DatyPlatform.VERSION, first.VERSION);
  assert.equal(context.DatyPlatform.kind, first.kind);
});

test('CommonJS exports a pure factory without installing globals or touching browser facilities', () => {
  const context = vm.createContext(Object.assign(forbiddenBrowser(), {module: {exports: {}}}));
  vm.runInContext(source, context);
  assert.equal(context.module.exports.VERSION, '1.0.0');
  assert.equal(typeof context.module.exports.create, 'function');
  assert.equal(context.DatyPlatform, undefined);
  assert.equal(context.DatyPlatformFactory, undefined);
});

test('request preserves URL, signal, response and Promise while excluding credentials and redirects', async () => {
  const controller = new AbortController();
  const response = new Response('receiver acknowledgement', {status: 202});
  const promise = Promise.resolve(response);
  const requestUrl = new URL('https://127.0.0.1:8802/diagnostics?receiver=rx%201');
  const init = {method: 'POST', body: '{"seq":42}', signal: controller.signal, cache: 'no-store', credentials: 'omit'};
  let calls = 0;
  const runtime = {fetch(url, options) {
    assert.equal(this, runtime);
    assert.equal(url, requestUrl);
    assert.deepEqual(options, {...init,credentials:'omit',redirect:'error'});
    assert.equal(options.signal, controller.signal);
    calls++;
    return promise;
  }};
  const adapter = factory.createBrowser(runtime);
  const actual = adapter.request(requestUrl, init);
  assert.equal(actual, promise);
  assert.equal(await actual, response);
  assert.equal(calls, 1);
});

test('request looks up fetch at use time and preserves synchronous failures with no retries', () => {
  const runtime = {};
  const adapter = factory.createBrowser(runtime);
  const error = new TypeError('network unavailable');
  let calls = 0;
  runtime.fetch = () => { calls++; throw error; };
  assert.throws(() => adapter.request('/one'), value => value === error);
  assert.equal(calls, 1);
  const replacement = Promise.resolve('replacement');
  runtime.fetch = () => replacement;
  assert.equal(adapter.request('/two'), replacement);
});

test('aborted request rejection reaches its caller unchanged and is never retried', async () => {
  const error = new DOMException('cancelled', 'AbortError');
  let calls = 0;
  const promise = Promise.reject(error);
  const adapter = factory.createBrowser({fetch() { calls++; return promise; }});
  const actual = adapter.request('/cancelled', {signal: AbortSignal.abort()});
  assert.equal(actual, promise);
  await assert.rejects(actual, value => value === error);
  assert.equal(calls, 1);
});

test('HTTP error responses pass through instead of becoming synthetic transport failures', async () => {
  const response = new Response('busy', {status: 409});
  const adapter = factory.createBrowser({fetch: () => Promise.resolve(response)});
  assert.equal(await adapter.request('/command'), response);
  assert.equal(response.status, 409);
});

test('EventSource is constructed on demand and its events, options, status and close remain native', () => {
  let sourceInstance, constructions = 0;
  const init = {withCredentials: true};
  class EventSourceFixture extends EventTarget {
    constructor(url, options) {
      super(); constructions++;
      assert.equal(url, '/events'); assert.equal(options, init);
      this.readyState = 0; sourceInstance = this;
    }
    close() { this.readyState = 2; }
  }
  const adapter = factory.createBrowser({EventSource: EventSourceFixture});
  assert.equal(constructions, 0);
  const stream = adapter.openEventStream('/events', init);
  assert.equal(stream, sourceInstance);
  const received = [];
  stream.addEventListener('telemetry', event => received.push(event));
  const telemetry = new Event('telemetry');
  stream.dispatchEvent(telemetry);
  assert.deepEqual(received, [telemetry]);
  const onError = () => 'handled';
  stream.onerror = onError;
  assert.equal(sourceInstance.onerror, onError);
  stream.close();
  assert.equal(stream.readyState, 2);
  assert.equal(constructions, 1);
});

test('EventSource constructor failure is not replaced, swallowed or retried', () => {
  const error = new Error('SSE unsupported');
  let calls = 0;
  const adapter = factory.createBrowser({EventSource: function () { calls++; throw error; }});
  assert.throws(() => adapter.openEventStream('/events'), value => value === error);
  assert.equal(calls, 1);
});

test('storage lazily forwards only the requested key/value and preserves missing null', () => {
  const records = new Map();
  const operations = [];
  const storage = {
    getItem(key) { assert.equal(this, storage); operations.push(['get', key]); return records.has(key) ? records.get(key) : null; },
    setItem(key, value) { assert.equal(this, storage); operations.push(['set', key, value]); records.set(key, value); },
    removeItem(key) { assert.equal(this, storage); operations.push(['remove', key]); records.delete(key); }
  };
  let accesses = 0;
  const adapter = factory.createBrowser({get localStorage() { accesses++; return storage; }});
  assert.equal(accesses, 0);
  assert.equal(adapter.storage.getItem('project'), null);
  adapter.storage.setItem('project', '{"name":"舞台"}');
  assert.equal(adapter.storage.getItem('project'), '{"name":"舞台"}');
  adapter.storage.removeItem('project');
  assert.equal(adapter.storage.getItem('project'), null);
  assert.deepEqual(operations, [['get', 'project'], ['set', 'project', '{"name":"舞台"}'], ['get', 'project'], ['remove', 'project'], ['get', 'project']]);
  assert.equal(accesses, 5);
});

test('storage SecurityError and quota failures propagate without fallback writes', () => {
  const denied = new DOMException('disabled', 'SecurityError');
  const adapter = factory.createBrowser({get localStorage() { throw denied; }});
  assert.throws(() => adapter.storage.getItem('project'), value => value === denied);
  assert.throws(() => adapter.storage.setItem('project', 'x'), value => value === denied);
  assert.throws(() => adapter.storage.removeItem('project'), value => value === denied);
  const quota = new DOMException('full', 'QuotaExceededError');
  let writes = 0;
  const full = factory.createBrowser({localStorage: {setItem() { writes++; throw quota; }}});
  assert.throws(() => full.storage.setItem('project', 'data'), value => value === quota);
  assert.equal(writes, 1);
});

test('text download preserves unicode bytes, file name and MIME then removes its anchor and revokes URL', async () => {
  const {runtime, events, link} = downloadRuntime();
  const adapter = factory.createBrowser(runtime);
  assert.deepEqual(events, []);
  const content = 'CH1,641.000 MHz\r\n舞台🎤';
  adapter.downloadText(content, {fileName: '频率规划.csv', mimeType: 'text/csv;charset=utf-8'});
  assert.equal(await runtime.blob.text(), content);
  assert.equal(runtime.blob.type, 'text/csv;charset=utf-8');
  assert.equal(link.download, '频率规划.csv');
  assert.equal(link.href, 'blob:test-download');
  assert.equal(link.parentNode, null);
  assert.deepEqual(events, ['url', 'create', 'append', 'click', 'remove', 'revoke']);
});

test('download releases an allocated object URL at each failure point', () => {
  for (const point of ['url', 'create', 'append', 'click', 'remove', 'revoke']) {
    const {runtime, events, failure} = downloadRuntime(point);
    const adapter = factory.createBrowser(runtime);
    assert.throws(() => adapter.downloadText('content', {fileName: 'report.txt'}), value => value === failure);
    assert.equal(events.filter(event => event === 'revoke').length, point === 'url' ? 0 : 1, point);
  }
});

test('download preserves original click error even if cleanup also fails, and still revokes URL', () => {
  const original = new Error('blocked click');
  const {runtime, events} = downloadRuntime('click', original);
  runtime.document.body.removeChild = () => { throw new Error('cleanup failed'); };
  const adapter = factory.createBrowser(runtime);
  assert.throws(() => adapter.downloadText('text', {fileName: 'x.txt'}), value => value === original);
  assert.equal(events.at(-1), 'revoke');
});

test('download without a DOM fails explicitly and bad file options cause no download', () => {
  const adapter = factory.createBrowser({});
  assert.throws(() => adapter.downloadText('x', {fileName: 'x.txt'}), /requires a browser document/);
  const {runtime, events} = downloadRuntime();
  const browser = factory.createBrowser(runtime);
  assert.throws(() => browser.downloadText('x', {}), /fileName/);
  assert.throws(() => browser.downloadText('x', {fileName: 'x', mimeType: null}), /mimeType/);
  assert.deepEqual(events, []);
});

test('complete injected host handles every port without consulting browser facilities', async () => {
  const calls = [];
  const response = {status: 200};
  const stream = {readyState: 1, close() { calls.push('close'); }};
  const options = {method: 'POST'};
  const download = {fileName: 'native.txt'};
  const ports = hostPorts({
    request(url, init) { assert.equal(this, ports); calls.push(['request', url, init]); return Promise.resolve(response); },
    openEventStream(url, init) { assert.equal(this, ports); calls.push(['stream', url, init]); return stream; },
    storage: {
      getItem(key) { calls.push(['get', key]); return null; },
      setItem(key, value) { calls.push(['set', key, value]); },
      removeItem(key) { calls.push(['remove', key]); }
    },
    downloadText(text, init) { assert.equal(this, ports); calls.push(['download', text, init]); return 'host-file'; }
  });
  const context = vm.createContext(forbiddenBrowser());
  vm.runInContext(source, context);
  const adapter = context.DatyPlatformFactory.create(ports);
  assert.equal(adapter.kind, 'native-test');
  assert.equal(await adapter.request('/command', options), response);
  assert.equal(adapter.openEventStream('/events', options), stream);
  stream.close();
  assert.equal(adapter.storage.getItem('project'), null);
  adapter.storage.setItem('project', 'p1');
  adapter.storage.removeItem('project');
  assert.equal(adapter.downloadText('data', download), 'host-file');
  assert.deepEqual(calls, [['request', '/command', options], ['stream', '/events', options], 'close', ['get', 'project'], ['set', 'project', 'p1'], ['remove', 'project'], ['download', 'data', download]]);
});

test('incomplete host injection and incompatible versions are rejected instead of silently using browser ports', () => {
  for (const field of ['kind', 'request', 'openEventStream', 'storage', 'downloadText']) {
    const ports = hostPorts();
    delete ports[field];
    assert.throws(() => factory.create(ports), /DatyPlatform:/, field);
  }
  for (const method of ['getItem', 'setItem', 'removeItem']) {
    const ports = hostPorts();
    delete ports.storage[method];
    assert.throws(() => factory.create(ports), /storage\./, method);
  }
  assert.throws(() => factory.create(hostPorts({VERSION: '2.0.0'})), /VERSION/);
});

test('preinstalled valid native adapter is wrapped without mutation and incomplete installation fails closed', () => {
  const installed = factory.create(hostPorts());
  const context = vm.createContext(forbiddenBrowser());
  context.DatyPlatform = installed;
  vm.runInContext(source, context);
  assert.notEqual(context.DatyPlatform, installed);
  assert.equal(context.DatyPlatform.kind, installed.kind);
  assert.equal(installed.VERSION, '1.0.0');
  for (const invalid of [null, hostPorts(), {VERSION: '1.0.0', kind: 'native'}]) {
    const broken = vm.createContext(forbiddenBrowser());
    broken.DatyPlatform = invalid;
    assert.throws(() => vm.runInContext(source, broken), /DatyPlatform:/);
    assert.equal(broken.DatyPlatform, invalid);
    assert.equal(broken.DatyPlatformFactory, undefined);
  }
});

test('preinstalled class host preserves method receivers even when application call sites extract functions', async () => {
  const calls = [];
  class Host {
    constructor() {
      this.VERSION = '1.0.0'; this.kind = 'native-class'; this.token = 'host-token';
      this.storage = {
        token: 'storage-token',
        getItem(key) { calls.push([this.token, 'get', key]); return null; },
        setItem(key, value) { calls.push([this.token, 'set', key, value]); },
        removeItem(key) { calls.push([this.token, 'remove', key]); }
      };
    }
    request(url, init) { calls.push([this.token, 'request', url, init]); return Promise.resolve('response'); }
    openEventStream(url) { calls.push([this.token, 'stream', url]); return {readyState: 1}; }
    downloadText(text, options) { calls.push([this.token, 'download', text, options]); }
  }
  const installed = new Host();
  const originalRequest = installed.request;
  const context = vm.createContext(forbiddenBrowser());
  context.DatyPlatform = installed;
  vm.runInContext(source, context);
  const {request, openEventStream, downloadText, storage} = context.DatyPlatform;
  const init = {method: 'GET'}, options = {fileName: 'x.txt'};
  assert.equal(await request('/api', init), 'response');
  assert.equal(openEventStream('/events').readyState, 1);
  downloadText('x', options);
  const {getItem, setItem, removeItem} = storage;
  assert.equal(getItem('p'), null); setItem('p', 'v'); removeItem('p');
  assert.deepEqual(calls, [
    ['host-token', 'request', '/api', init], ['host-token', 'stream', '/events'], ['host-token', 'download', 'x', options],
    ['storage-token', 'get', 'p'], ['storage-token', 'set', 'p', 'v'], ['storage-token', 'remove', 'p']
  ]);
  assert.equal(installed.request, originalRequest);
  assert.equal(installed.token, 'host-token');
});

test('missing browser facilities fail only when their port is used', () => {
  const adapter = factory.createBrowser({});
  assert.equal(adapter.kind, 'browser');
  assert.throws(() => adapter.request('/api'), /browser.fetch/);
  assert.throws(() => adapter.openEventStream('/events'), /browser.EventSource/);
});

test('Bridge preference normalization upgrades known legacy origins and rejects unsafe custom roots', () => {
  for (const empty of [undefined, null, '']) assert.equal(factory.normalizeBridgeUrl(empty), 'https://127.0.0.1:8802');
  for (const [input, expected] of [
    [' http://localhost:8802/ ', 'https://127.0.0.1:8802'],
    ['https://LOCALHOST:8802/', 'https://127.0.0.1:8802'],
    ['http://192.0.2.16:8802/', 'https://192.0.2.16:8802'],
    ['https://bridge.example:9443/', 'https://bridge.example:9443'],
    ['https://[::1]:8802/', 'https://[::1]:8802']
  ]) assert.equal(factory.normalizeBridgeUrl(input), expected);
  for (const input of ['http://localhost:8080/', 'http://localhost/', 'http://localhost:8802/path/',
    'http://localhost:8802/?ch=1', 'http://user@localhost:8802/', 'http://:password@localhost:8802/',
    'localhost:8802', 'not a URL', 'file:///secret', 'ws://localhost:8802']) {
    assert.throws(() => factory.normalizeBridgeUrl(input), input);
  }
});
