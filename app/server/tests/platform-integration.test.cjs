'use strict';
// Full production modules with an injected host. No live network or browser storage.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const factory = require('../src/platform/browser-platform.js');
const read = name => fs.readFileSync(path.join(__dirname, '../src/modules', name + '.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const response = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => body});
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const command = {device_id: 'receiver-a_ch1', receiver_id: 'receiver-a', channel_number: 1, command: 'mute', value: true};
const ack = (posted, extra = {}) => ({command_id: 'cmd-1', status: 'acknowledged',
  device_id: posted.device_id, command: posted.command, actual_value: posted.value,
  client_request_id: posted.client_request_id, ...extra});

test('production page loads the platform once before its consumers and retains seven panels and existing styles', () => {
  const html = fs.readFileSync(path.join(__dirname, '../unirf-app.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(match => match[1].split('?')[0]);
  const platform = 'src/platform/browser-platform.js';
  assert.equal(scripts.filter(src => src === platform).length, 1);
  for (const name of ['frequency', 'storage', 'navigation', 'init', 'fashe', 'alert-history', 'timeline',
    'equipment-profiles', 'render', 'spectrum', 'planning-ui', 'rf-simulation-view', 'ip-detection']) {
    const index = scripts.indexOf('src/modules/' + name + '.js');
    assert.ok(index > scripts.indexOf(platform), name + ' must load after the platform');
  }
  const panels = [...html.matchAll(/\bid=["']panel-([^"']+)["']/g)].map(match => match[1]);
  assert.deepEqual(panels.sort(), ['dashboard', 'channels', 'spectrum', 'planner', 'devices', 'data', 'settings'].sort());
  const styles = [...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)].map(match => match[1].split('?')[0]);
  for (const style of ['src/styles/main.css', 'src/styles/deploy-progress.css']) assert.ok(styles.includes(style), style);
});

function harness(t, {values = new Map(), load = ['navigation']} = {}) {
  const requests = [], downloads = [], writes = [], bypasses = [], controllers = [], timers = new Map(), listeners = new Map(), elements = new Map();
  let timerId = 0;
  function element(value = '') {
    return {value, textContent: '', innerHTML: '', style: {}, classList: {contains: () => false},
      appendChild() {}, removeChild() {}, addEventListener() {}, click() { throw new Error('Unexpected browser download'); }};
  }
  elements.set('fasheApiUrl', element('http://localhost:8802'));
  const ports = {
    kind: 'integration-host',
    request(url, init) {
      assert.equal(this, ports, 'native host method receiver was lost');
      requests.push({url, init});
      return ports.handleRequest(url, init);
    },
    handleRequest() { throw new Error('Unexpected host request'); },
    openEventStream(url) {
      assert.equal(this, ports);
      const handlers = new Map();
      const stream = {url, readyState: 1, closed: false,
        addEventListener(name, fn) { handlers.set(name, fn); },
        close() { this.readyState = 2; this.closed = true; },
        emit(name, data) { const handler = handlers.get(name); assert.ok(handler, name); handler({data: JSON.stringify(data)}); }
      };
      ports.streams.push(stream); return stream;
    },
    streams: [],
    storage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { writes.push(['set', key, value]); values.set(key, value); },
      removeItem(key) { writes.push(['remove', key]); values.delete(key); }
    },
    downloadText(text, options) { assert.equal(this, ports); downloads.push({text, options}); }
  };
  const context = {
    console: {log() {}, warn() {}, error() {}}, crypto, URL, Date, Promise, performance, AbortSignal,
    AbortController: class extends AbortController { constructor() { super(); controllers.push(this); } },
    DatyPlatformFactory: factory, DatyPlatform: factory.create(ports),
    document: {readyState: 'loading', body: element(), createElement: () => element(),
      getElementById: id => elements.get(id) || null,
      addEventListener(name, fn) { listeners.set(name, [...listeners.get(name) || [], fn]); }},
    addEventListener() {}, notify() {}, filterDevicesChannels() {},
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, {fn, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return ++timerId; }, clearInterval() {},
    _fasheApiUrl: 'https://127.0.0.1:8802', _fasheSSE: {readyState: 1}
  };
  for (const name of ['fetch', 'localStorage', 'EventSource', 'Blob']) {
    Object.defineProperty(context, name, {get() { bypasses.push(name); throw new Error('Forbidden browser facility: ' + name); }});
  }
  const c = vm.createContext(context); c.window = c;
  c.DatyHostFactory = factory.host;
  c.DatyHostRuntime = {VERSION:'daty-host-runtime-v1', setTimeout:c.setTimeout, clearTimeout:c.clearTimeout,
    setInterval:c.setInterval, clearInterval:c.clearInterval, nowEpochMs:() => Date.now(), nowMonotonicMs:() => performance.now()};
  const run = name => vm.runInContext(read(name), c, {filename: name + '.js'});
  for (const name of load) run(name);
  t.after(() => assert.deepEqual(bypasses, [], 'production module bypassed injected host'));
  return {c, run, ports, values, writes, requests, downloads, controllers, elements, element, listeners,
    async fireTimer(delay) {
      const item = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(item, 'expected scheduled timer at ' + delay + ' ms');
      timers.delete(item[0]); await item[1].fn(); await tick();
    }
  };
}

test('injected SSE ACK completes a command before its POST response and aborts that single request', async t => {
  const h = harness(t, {load: ['navigation', 'fashe']});
  h.c._fasheStartSSE();
  let posted;
  h.ports.handleRequest = (_url, init) => { posted = JSON.parse(init.body); return new Promise(() => {}); };
  const action = h.c.sendTrackedDeviceCommand(command, 1000);
  h.ports.streams[0].emit('command_update', {data: ack(posted)});
  assert.equal((await action).status, 'acknowledged');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, 'https://127.0.0.1:8802/api/command');
  assert.equal(h.requests[0].init.signal, h.controllers[0].signal);
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal(vm.runInContext('muteRequestWaiters.size', h.c), 0);
});

test('accepted POST is not a device ACK and the host path still waits for matching execution', async t => {
  const h = harness(t); let posted, settled = false;
  h.ports.handleRequest = (_url, init) => {
    posted = JSON.parse(init.body);
    return Promise.resolve(response({success: true, command_id: 'cmd-1', command_record: {...ack(posted), status: 'published'}}));
  };
  const action = h.c.sendTrackedDeviceCommand(command, 1000);
  action.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  h.c.receiveCommandAcknowledgement(ack(posted));
  assert.equal((await action).actual_value, true);
  assert.equal(h.requests.length, 1);
});

test('lost SSE uses the host ACK query with its original AbortSignal and never reposts control', async t => {
  const h = harness(t); let posted;
  h.ports.handleRequest = (url, init) => {
    if (init.method === 'POST') {
      posted = JSON.parse(init.body);
      return Promise.resolve(response({success: true, command_id: 'cmd-1'}));
    }
    assert.equal(url, 'https://127.0.0.1:8802/api/commands/cmd-1');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.signal, h.controllers[1].signal);
    return Promise.resolve(response({success: true, command: ack(posted)}));
  };
  const action = h.c.sendTrackedDeviceCommand(command, 1000);
  await tick(); await h.fireTimer(100);
  assert.equal((await action).command_id, 'cmd-1');
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests.filter(item => item.init.method === 'POST').length, 1);
  assert.ok(h.controllers.every(controller => controller.signal.aborted));
});

test('host-delivered wrong receiver, wrong actual mute state, and failed ACK cannot report success', async t => {
  for (const extra of [{device_id: 'receiver-b_ch1'}, {actual_value: false}, {status: 'failed', error: 'receiver rejected'}]) {
    const h = harness(t); let posted;
    h.ports.handleRequest = (_url, init) => { posted = JSON.parse(init.body); return new Promise(() => {}); };
    const action = h.c.sendTrackedDeviceCommand(command, 1000);
    h.c.receiveCommandAcknowledgement(ack(posted, extra));
    await assert.rejects(action, /不匹配|receiver rejected/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].init.signal.aborted, true);
  }
});

test('host transport rejection permits a later real ACK without automatically duplicating the POST', async t => {
  const h = harness(t); let posted;
  h.ports.handleRequest = (_url, init) => { posted = JSON.parse(init.body); return Promise.reject(new Error('response lost')); };
  const action = h.c.sendTrackedDeviceCommand({...command, command: 'unmute', value: false}, 1000);
  await tick(); h.c.receiveCommandAcknowledgement(ack(posted));
  assert.equal((await action).actual_value, false);
  assert.equal(h.requests.length, 1);
});

test('device cache loads and saves through host storage while cached receivers remain offline', t => {
  const values = new Map([
    ['daty_devices', JSON.stringify([{id: 1, _fasheId: 'receiver-a_ch1', freq: 641000, _online: true, muted: true}])],
    ['daty_alerts', JSON.stringify([{id: 'rf-low', msg: '弱信号'}])]
  ]);
  const h = harness(t, {values, load: []});
  h.run('frequency'); h.run('storage');
  const devices = vm.runInContext('DEVICES', h.c);
  assert.equal(devices.length, 1); assert.equal(devices[0].freq, 641000);
  assert.equal(devices[0]._online, false); assert.equal(devices[0].muted, true);
  h.c.saveDataToStorage();
  assert.equal(JSON.parse(values.get('daty_devices'))[0]._online, false);
  assert.equal(JSON.parse(values.get('daty_alerts'))[0].msg, '弱信号');
  assert.deepEqual(h.writes.map(item => item.slice(0, 2)), [['set', 'daty_devices'], ['set', 'daty_alerts']]);
});

function projectFixture() {
  const record = {id: 'local', type: 'daty_rf_planning', projectId: 'show-1', timestamp: 1720000000000,
    devices: [{id: 1, freq: 641000, planned: 641250, brand: 'DATYaudio'}],
    options: {lockedAssignments: [{deviceId: 1, frequencyKHz: 641250}]}, constraintFields: {notes: '主持人'}};
  const values = new Map([['daty_planning_history_v1', JSON.stringify({
    project: {id: 'show-1', name: '演出项目'}, records: [record], currentRecordId: 'local', deletedRecordIds: ['removed']
  })]]);
  return {record, values};
}

test('project host GET merges remote history and unrelated fields before the matching project POST', async t => {
  const {values, record} = projectFixture();
  const h = harness(t, {values, load: ['storage']});
  let saved;
  h.ports.handleRequest = (url, init) => {
    assert.ok(init.signal instanceof AbortSignal);
    if (init.method !== 'POST') {
      assert.equal(url, 'https://127.0.0.1:8802/api/projects/show-1');
      return Promise.resolve(response({success: true, project: {data: {
        untouched: {venue: '音乐厅'}, planningHistory: [{id: 'remote'}, {id: 'removed'}, {id: 'local', stale: true}]
      }}}));
    }
    assert.equal(url, 'https://127.0.0.1:8802/api/projects');
    saved = JSON.parse(init.body); return Promise.resolve(response({success: true}));
  };
  await h.c.persistPlanningProject();
  assert.equal(h.requests.length, 2);
  assert.equal(saved.id, 'show-1'); assert.equal(saved.name, '演出项目');
  assert.deepEqual(saved.data.untouched, {venue: '音乐厅'});
  assert.deepEqual(saved.data.planningHistory.map(item => item.id), ['local', 'remote']);
  assert.deepEqual(saved.data.constraints, record.options);
  assert.deepEqual(saved.data.constraintFields, record.constraintFields);
  assert.deepEqual(saved.devices, record.devices);
});

test('failed project host read cannot replace unknown remote history with a local-only write', async t => {
  const h = harness(t, {...projectFixture(), load: ['storage']});
  h.ports.handleRequest = () => Promise.resolve(response({success: false, error: 'database unavailable'}, 503));
  await assert.rejects(h.c.persistPlanningProject(), /database unavailable/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].init.method, undefined);
});

test('existing report and planning exports preserve file names and exact content through download port', async t => {
  const h = harness(t, {load: ['navigation', 'storage']});
  const content = '通道,频率 MHz\r\nCH1,641.250';
  h.c.DatyTextExportFactory={saveText:async(_runtime,text,options)=>{h.c.DatyPlatform.downloadText(text,options);return {status:'saved'};}};
  await h.c.downloadGeneratedFile('DATY_channels.csv', content, 'text/csv');
  const plan = {name: '主持/CH 1', date: '2026-09-11', devices: [{freq: 641250}], options: {backupCount: 2}};
  h.c.downloadPlanningFile(plan);
  assert.deepEqual(plain(h.downloads), [
    {text: content, options: {fileName: 'DATY_channels.csv', mimeType: 'text/csv;charset=utf-8'}},
    {text: JSON.stringify(plan, null, 2), options: {fileName: 'guihua_2026-09-11_主持_CH_1.json', mimeType: 'application/json'}}
  ]);
  assert.equal(h.requests.length, 0);
});

test('alert archive retains host pending cache while server persistence is unavailable', async t => {
  const h=harness(t,{load:[]});h.c.ALERTS=[];h.run('alert-history');
  h.c.queueAlertForArchive({id:'rf-low',ts:1000,message:'CH1 RF 弱信号'});
  assert.equal((await h.c.flushAlertArchive()).success,false);
  assert.ok(h.values.has('daty_pending_alerts_v1'));
  assert.equal(h.values.has('daty_db_alerts'),false);
  assert.equal(h.requests.length,0);
});

test('health, SSE lifecycle and Timeline use injected ports with the same normalized IPv4 base', async t => {
  const h = harness(t, {load: ['navigation', 'fashe']});
  h.c.DEVICES = [];
  h.c.alertLogView = 'archive'; h.c.ALERT_LOG_PAGE_SIZE = 20;
  h.c.renderAlertLogPagination = (_count, page = 1) => page;
  h.c.alertLogEmptyMarkup=(title,message)=>'<tr><td>'+title+' '+message+'</td></tr>';
  h.c.DatyDatabaseConnection={snapshot:()=>({origin:'https://127.0.0.1:8802',revision:1,source:{id:'fixture-peer'},status:{epoch:'fixture'}}),request:(...args)=>h.c.DatyPlatform.request(...args),subscribe:()=>()=>{}};
  for (const id of ['logBody', 'logCount']) h.elements.set(id, h.element());
  h.run('timeline');
  h.ports.handleRequest = (url, init) => {
    if (url.endsWith('/health')) {
      assert.ok(init.signal instanceof AbortSignal);
      return Promise.resolve(response({status: 'ok'}));
    }
    assert.equal(url, 'https://127.0.0.1:8802/api/timeline?limit=200');
    return Promise.resolve(response({success: true, events: [{ts: 1, event_type: 'command_ack', device_id: 'receiver-a_ch1', summary: '<confirmed>', details: {muted: true}}]}));
  };
  vm.runInContext("_fasheApiUrl = 'http://localhost:8802';", h.c);
  h.c._fasheConnect(); await tick();
  assert.equal(h.requests[0].url, 'https://127.0.0.1:8802/health');
  assert.equal(h.ports.streams[0].url, 'https://127.0.0.1:8802/api/updates');
  await h.c.loadServerTimeline();
  assert.equal(h.elements.get('logCount').textContent, '1');
  assert.match(h.elements.get('logBody').innerHTML, /&lt;confirmed&gt;/);
  h.c._fasheDisconnect();
  assert.equal(h.ports.streams[0].closed, true);
  assert.equal(h.requests.length, 2);
});

test('full startup module keeps shared cancellable snapshot polling behind host request port', async t => {
  const h = harness(t, {load: []});
  h.c.DEVICES = [];
  for (const name of ['initializeAlertArchiving', 'renderAlerts', 'renderFreqTable', 'renderHistory', 'renderLog',
    'loadSavedFreqRange', 'renderFreqAxis', 'initScanData', 'drawRFBarChart', 'getLocalIP', 'renderDeviceGridChannels',
    'renderDeviceGrid', 'updateDashboardStats']) h.c[name] = () => {};
  h.c.initDatabase = async () => null; h.c.repairRealtimeDeviceIds = () => 0;
  h.run('init'); await tick();
  const manager = vm.runInContext('deviceServiceManager', h.c);
  let resolveRequest;
  h.ports.handleRequest = () => new Promise(resolve => { resolveRequest = resolve; });
  const first = manager.getBridgeSnapshot(), second = manager.getBridgeSnapshot();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, 'https://127.0.0.1:8802/api/devices');
  assert.equal(h.requests[0].init.signal, h.controllers[0].signal);
  const devices = [{id: 'receiver-a_ch1', receiver_id: 'receiver-a', channel_number: 1}];
  resolveRequest(response({devices}));
  assert.deepEqual(plain(await first), devices); assert.deepEqual(plain(await second), devices);
  manager.snapshotCache = null;
  const cancelled = manager.getBridgeSnapshot();
  manager.disconnectAll();
  await assert.rejects(cancelled, /取消/);
  assert.equal(h.requests[1].init.signal.aborted, true);
  assert.equal(h.requests.filter(item => item.init.method === 'POST').length, 0);
});

test('custom Profile imports and exact readback use the same native host store as project history', t => {
  const h=harness(t,{load:['frequency','equipment-profiles']});
  const profiles=h.c.DatyEquipmentProfiles;
  const candidate=plain(profiles.getAllEquipmentProfiles().find(p=>p.id==='datyaudio-fashe-protocol'));
  candidate.id='native-fixture-daty';candidate.models=['Native fixture'];
  profiles.saveCustomEquipmentProfile(candidate);
  const stored=JSON.parse(h.values.get(profiles.STORAGE_KEY));
  assert.equal(stored.length,1);assert.equal(stored[0].id,candidate.id);
  assert.equal(stored[0].minimumChannelSpacingKHz,250);
  assert.equal(profiles.resolveEquipmentProfile({brand:'DATYaudio',equipmentProfileId:candidate.id}).id,candidate.id);
  assert.deepEqual(h.writes.map(w=>w.slice(0,2)),[['set','daty_equipment_profiles_v2']]);
  const before=h.values.get(profiles.STORAGE_KEY);
  assert.throws(()=>profiles.saveCustomEquipmentProfiles([candidate,{id:'invalid'}]));
  assert.equal(h.values.get(profiles.STORAGE_KEY),before,'Invalid batch must not partially replace profiles.');
  assert.equal(h.requests.length,0);
});

test('native threshold and receiver-group persistence keeps units, identities and server GROUP priority', t => {
  const thresholds={rfWeakDbm:-65,batteryLowPercent:25,afOverloadDbfs:-6};
  const values=new Map([['daty_alert_thresholds_v1',JSON.stringify(thresholds)],
    ['daty_receiver_group_numbers_v1',JSON.stringify({'ip:192.168.50.10':7})]]);
  const h=harness(t,{values,load:['render']});
  assert.deepEqual(plain(h.c.getAlertThresholdSettings()),thresholds);
  h.c.setAlertThresholdSettings({rfWeakDbm:-70,afOverloadDbfs:0});
  assert.deepEqual(JSON.parse(values.get('daty_alert_thresholds_v1')),{...thresholds,rfWeakDbm:-70,afOverloadDbfs:0});
  assert.equal(h.c.getReceiverGroupNumber({receiver_ip:'192.168.50.10',channel_number:1}),7);
  assert.equal(h.c.getReceiverGroupNumber({receiver_ip:'192.168.50.10',channel_number:8}),7);
  assert.equal(h.c.getReceiverGroupNumber({receiver_ip:'192.168.50.10',group_source:'server-fifo-v1',group_number:2}),2);
  assert.equal(h.c.getReceiverGroupNumber({receiver_ip:'192.168.50.11'}),8);
  assert.equal(JSON.parse(values.get('daty_receiver_group_numbers_v1'))['ip:192.168.50.11'],8);
  assert.equal(h.requests.length,0);
});

test('native spectrum preferences restore and save exact MHz strings; fit-only updates do not overwrite them', t => {
  const values=new Map([['specStartFreq','640.000'],['specEndFreq','690.000']]);
  const h=harness(t,{values,load:['frequency','spectrum']});
  for(const id of ['specStart','specEnd','rangeDisplay','planRangeDisplay','statCenterFreq'])h.elements.set(id,h.element());
  h.c.renderFreqAxis=()=>{};h.c.updateSpectrumDataSummary=()=>{};h.c.drawSpectrum=()=>{};
  h.c.loadSavedFreqRange();
  assert.equal(h.elements.get('specStart').value,'640.000');assert.equal(h.elements.get('statCenterFreq').textContent,'665.000');
  h.elements.get('specStart').value='641.250';h.elements.get('specEnd').value='689.750';h.c.updateRangeDisplay(false);
  assert.equal(values.get('specStartFreq'),'640.000');assert.equal(h.writes.length,0);
  h.c.updateRangeDisplay();assert.equal(values.get('specStartFreq'),'641.250');assert.equal(values.get('specEndFreq'),'689.750');
  h.elements.get('specStart').value='400';h.elements.get('specEnd').value='900';h.c.restoreSpectrumRange();
  assert.equal(h.elements.get('specStart').value,'641.250');assert.equal(h.elements.get('specEnd').value,'689.750');
  h.elements.get('specStart').value='';h.elements.get('specEnd').value='';h.c.updateRangeDisplay();
  assert.equal(values.get('specStartFreq'),'641.250');assert.equal(values.get('specEndFreq'),'689.750');
  assert.deepEqual(Array.from(h.c.getSpectrumRangeMHz()),[641.25,689.75],'invalid drafts must not overwrite the last valid chart or saved range');
  assert.equal(h.requests.length,0);
});

test('simulation cache invalidation observes native Profile changes without writing them or treating AF as RF', t => {
  const h=harness(t,{load:[]});let builds=0;
  h.c.DatyRfSimulation={DEFAULTS:{},build:()=>({fixtureBuild:++builds})};h.run('rf-simulation-view');
  const devices=[{_fasheId:'fixture_ch1',freq:641000,rf:-50,af_dbfs:-10,brand:'DATYaudio'}];
  const first=h.c.DatyRfSimulationView.get(devices,640,690);
  devices[0].af_dbfs=0;devices[0].muted=true;
  assert.equal(h.c.DatyRfSimulationView.get(devices,640,690),first);assert.equal(builds,1);
  h.values.set('daty_equipment_profiles_v2','[{"fixture":"new"}]');
  assert.notEqual(h.c.DatyRfSimulationView.get(devices,640,690),first);assert.equal(builds,2);
  h.values.set('daty_equipment_profiles_v1','[{"fixture":"legacy"}]');
  h.c.DatyRfSimulationView.get(devices,640,690);assert.equal(builds,3);
  assert.equal(h.writes.length,0);assert.equal(h.requests.length,0);
});

test('native IP detection uses the host cache after failed readonly probes and keeps successful API persistence', async t => {
  const h=harness(t,{values:new Map([['daty_local_ip','192.168.50.10']]),load:['ip-detection']});
  h.elements.set('localIP',h.element());h.elements.set('settingsLocalIP',h.element());
  h.c.applyIPToUI('192.168.50.16','fixture');assert.equal(h.values.get('daty_local_ip'),'192.168.50.16');
  h.ports.handleRequest=()=>Promise.resolve(response({success:false}));
  await h.c.getLocalIP();assert.equal(h.elements.get('localIP').textContent,'局域网 192.168.50.16');
  assert.equal(h.requests.length,2);assert.ok(h.requests.every(r=>!r.init.method||r.init.method==='GET'));
  h.ports.handleRequest=()=>Promise.resolve(response({success:true,ip:'192.168.50.17',all_ips:['192.168.50.17']}));
  assert.equal(await h.c.fetchIPFromAPIService(),true);assert.equal(h.values.get('daty_local_ip'),'192.168.50.17');
});

test('legacy planning draft uses host storage but never overrides existing project history', async t => {
  for(const hasHistory of [false,true]){
    const values=new Map([['daty_planner_constraints_v1',JSON.stringify({plannerExcludedRanges:'650.000-651.000 保留区域',plannerBackupCount:'0'})]]);
    if(hasHistory)values.set('daty_planning_history_v1','{"records":[]}');
    const h=harness(t,{values,load:['frequency']});h.c.DEVICES=[];h.c.getCurrentPlanningRecord=()=>null;
    h.elements.set('plannerExcludedRanges',h.element(''));h.elements.set('plannerBackupCount',h.element('1'));
    h.run('planning-ui');
    const initialize=h.listeners.get('DOMContentLoaded').find(fn=>fn.name==='initializeConstraintFields');assert.ok(initialize);
    await initialize();
    assert.equal(h.elements.get('plannerExcludedRanges').value,hasHistory?'':'650.000-651.000 保留区域');
    assert.equal(h.elements.get('plannerBackupCount').value,hasHistory?'1':'0');
    assert.equal(h.writes.length,0);assert.equal(h.requests.length,0);
  }
});

test('legacy Profile migration keeps the same host, v1 source and readonly no-write option', t => {
  const h=harness(t,{load:['frequency','equipment-profiles']});const profiles=h.c.DatyEquipmentProfiles;
  const legacy=plain(profiles.getAllEquipmentProfiles().find(p=>p.id==='datyaudio-fashe-protocol'));
  legacy.id='native-legacy-profile';delete legacy.bands;delete legacy.modes;delete legacy.provenance;
  const raw=JSON.stringify([legacy]);h.values.set('daty_equipment_profiles_v1',raw);
  const readonly=profiles.getAllEquipmentProfiles({persistMigration:false}).find(p=>p.id===legacy.id);
  assert.equal(readonly.deploymentEligible,false);assert.equal(readonly.provenance.verified,false);
  assert.equal(h.writes.length,0);assert.equal(h.values.has('daty_equipment_profiles_v2'),false);
  const migrated=profiles.getAllEquipmentProfiles().find(p=>p.id===legacy.id);assert.equal(migrated.id,legacy.id);
  assert.equal(h.values.get('daty_equipment_profiles_v1'),raw);
  assert.equal(JSON.parse(h.values.get('daty_equipment_profiles_v2'))[0].id,legacy.id);
  assert.deepEqual(h.writes.map(w=>w.slice(0,2)),[['set','daty_equipment_profiles_v2']]);
});

test('invalid Profile storage is not overwritten and failed host writes do not silently use browser storage', t => {
  const h=harness(t,{load:['frequency','equipment-profiles','render']});const profiles=h.c.DatyEquipmentProfiles;
  const candidate=plain(profiles.getAllEquipmentProfiles().find(p=>p.id==='datyaudio-fashe-protocol'));candidate.id='test-host-write';
  for(const raw of ['{broken','{}','[{"id":"invalid"}]']){
    h.values.set(profiles.STORAGE_KEY,raw);assert.throws(()=>profiles.saveCustomEquipmentProfile(candidate));
    assert.equal(h.values.get(profiles.STORAGE_KEY),raw);assert.equal(h.writes.length,0);
  }
  h.values.delete(profiles.STORAGE_KEY);
  const failure=new Error('Host storage full');h.ports.storage.setItem=()=>{throw failure;};
  assert.throws(()=>profiles.saveCustomEquipmentProfile(candidate),error=>error===failure);
  // Preserve existing in-memory threshold behavior, not a write to an unrelated store.
  h.c.setAlertThresholdSettings({rfWeakDbm:-60});assert.equal(h.c.getAlertThresholdSettings().rfWeakDbm,-60);
  assert.equal(h.values.has('daty_alert_thresholds_v1'),false);assert.equal(h.writes.length,0);
  h.c.DatyPlatform={storage:undefined};
  assert.throws(()=>profiles.saveCustomEquipmentProfile(candidate));assert.equal(h.writes.length,0);
});

test('browser adapter and native host preserve byte-identical Profile, threshold and frequency preference payloads', t => {
  const results=[];
  for(const browserAdapter of [false,true]){
    const h=harness(t,{load:[]});
    if(browserAdapter)h.c.DatyPlatform=factory.createBrowser({localStorage:h.ports.storage});
    for(const name of ['frequency','equipment-profiles','render','spectrum'])h.run(name);
    h.c.setAlertThresholdSettings({rfWeakDbm:-72,batteryLowPercent:30,afOverloadDbfs:-4});
    const profile=plain(h.c.DatyEquipmentProfiles.getAllEquipmentProfiles().find(p=>p.id==='datyaudio-fashe-protocol'));
    profile.id='same-profile';h.c.DatyEquipmentProfiles.saveCustomEquipmentProfile(profile);
    h.elements.set('specStart',h.element('640.000'));h.elements.set('specEnd',h.element('690.000'));h.elements.set('rangeDisplay',h.element());
    h.c.renderFreqAxis=()=>{};h.c.updateSpectrumDataSummary=()=>{};h.c.updateRangeDisplay();
    results.push([...h.values.entries()].sort((a,b)=>a[0].localeCompare(b[0])));
    assert.equal(h.requests.length,0);
  }
  assert.deepEqual(results[0],results[1]);
});
