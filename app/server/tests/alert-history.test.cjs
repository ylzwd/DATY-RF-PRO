// Isolated browser storage, clock and UI; never controls production receivers.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const root = path.join(__dirname, '..');
const ARCHIVE = 'daty_db_alerts', PENDING = 'daty_pending_alerts_v1';

function harness(values = new Map()) {
  let now = 1780000000000;
  const timers = [], events = new Map(), elements = new Map(), notices = [];
  const fail = new Set();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  for (const id of ['alertList', 'logBody', 'logCount', 'logStorageCount', 'logArchiveStatus',
    'realtimeAlertClear','logPagination', 'logPageInfo', 'logPrevPage', 'logNextPage', 'logArchiveView', 'logTimelineView', 'logClearStorage','logSaveNow','logClearDisplay','logCountUnit','logTimeHeader','logLevelHeader','logDeviceHeader','logStateHeader']) {
    const classes=new Set();
    elements.set(id, {innerHTML:'', textContent:'', style:{}, dataset:{}, attributes:{},
      setAttribute(key,value){this.attributes[key]=value;},
      classList:{contains:key=>classes.has(key),toggle(key,on){if(on)classes.add(key);else classes.delete(key);}}});
  }
  const listen = (name, callback) => events.set(name, [...events.get(name) || [], callback]);
  const context = vm.createContext({Date:Clock, crypto:{randomUUID},AbortController,
    localStorage:{getItem:key => values.get(key) ?? null,
      setItem(key, value) { if (fail.has(key)) throw new Error('QuotaExceededError'); values.set(key, String(value)); },
      removeItem(key) { if (fail.has(key)) throw new Error('QuotaExceededError'); values.delete(key); }},
    document:{readyState:'loading', getElementById:id => elements.get(id) || null, addEventListener:listen,
      createElement:() => ({style:{}, addEventListener() {}, click() {}}), body:{appendChild() {}}},
    console:{log() {}, warn() {}, error() {}},
    notify:(...args) => notices.push(args), confirm:() => true,
    setInterval:(callback, delay) => { timers.push({callback, delay}); return timers.length; },
    setTimeout:() => 1, clearTimeout(){}, requestAnimationFrame:() => 1,
    addEventListener:listen,
  });
  context.window = context;
  context.DatyDialogs={confirm:async options=>context.confirm(options),cancelActive(){}};
  for (const name of ['frequency', 'storage', 'alert-history', 'render', 'timeline']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src/modules', name + '.js'), 'utf8'), context, {filename:name+'.js'});
  }
  context.DatyAlertDatabase={
    status:()=>({loaded:true,pending:null,warning:''}),
    load:async()=>({success:true}),
    records:()=>JSON.parse(context.localStorage.getItem(ARCHIVE)||'[]'),
    async flush(captured){
      const records=JSON.parse(context.localStorage.getItem(ARCHIVE)||'[]');
      if(!Array.isArray(records))throw Error('存档格式无效');
      const map=new Map(records.map(item=>[item.archiveId,item]));
      for(const item of captured)map.set(item.archiveId,context._mergeAlertRecord(map.get(item.archiveId),item));
      context.localStorage.setItem(ARCHIVE,JSON.stringify([...map.values()]));
      return {success:true,readBackConfirmed:true,changed:captured.length,count:map.size,confirmed:captured.map(item=>({id:item.archiveId,snapshot:item}))};
    },
    async clearAll(){context.localStorage.removeItem(ARCHIVE);},
  };
  context.DatyDatabaseConnection={snapshot:()=>({origin:'https://127.0.0.1:8802',revision:1,source:{id:'fixture-peer'},status:{epoch:'fixture'}}),
    request:(...args)=>context.DatyPlatform?.request?context.DatyPlatform.request(...args):context.fetch(...args),subscribe:()=>()=>{}};
  const device = {id:'rx_ch1', _fasheId:'FAshe-MAC-020000000001_ch1', receiver_id:'rx',
    receiver_ip:'192.0.2.102', ip:'192.0.2.102', channel_number:1, ch:'CH1',
    name:'Receiver', rf:-95, afDbfs:-20, batt:100, status:'online', _online:true};
  return {context, values, fail, timers, elements, notices, device,
    now:() => now, advance:ms => { now += ms; },
    evaluate(devices = [device]) { context.DATY_STATE.devices.splice(0, context.DATY_STATE.devices.length, ...devices); return context.evaluateRealtimeAlerts(); },
    records:() => JSON.parse(values.get(ARCHIVE) || '[]'), pending:() => JSON.parse(values.get(PENDING) || '[]'),
    emit:async name => { for (const callback of events.get(name) || []) await callback({}); },
    read:expression => vm.runInContext(expression, context),
  };
}

test('one 30-second timer archives actual alerts without clearing dashboard state', async () => {
  const h = harness();
  h.context.initializeAlertArchiving(); h.context.initializeAlertArchiving();
  assert.equal(h.timers.length, 1); assert.equal(h.timers[0].delay, 30000);
  h.evaluate();
  assert.equal(h.records().length, 0); assert.equal(h.pending().length, 1);
  h.advance(30000); await h.timers[0].callback();
  assert.equal(h.records().length, 1); assert.equal(h.context.DATY_STATE.alerts.length, 1);
  assert.equal(h.elements.get('logCount').textContent, '1');
  assert.match(h.elements.get('logBody').innerHTML, /RF 弱信号/);
  assert.match(h.elements.get('logArchiveStatus').textContent, /最近保存/);
});

test('periodic/manual saves update one occurrence and preserve original occurrence time', async () => {
  const h = harness(); h.evaluate();
  const occurred = h.now();
  (await h.context.flushAlertArchive());
  h.advance(5000); h.device.rf = -100; h.evaluate();
  await h.context.exportAlertsToDB(); await h.context.exportAlertsToDB();
  assert.equal(h.records().length, 1);
  assert.equal(h.records()[0].ts, occurred);
  assert.equal(h.records()[0].lastSeen, occurred + 5000);
  assert.equal(h.records()[0].value, -100);
  assert.equal(h.records()[0].receiverIP, '192.0.2.102');
  assert.equal(h.records()[0].channel, 1);
});

test('sub-30-second alerts survive recovery and browser reload before archival', async () => {
  const h = harness(); h.evaluate(); const occurred = h.now();
  h.advance(100); h.device.rf = -40; h.evaluate();
  assert.equal(h.context.DATY_STATE.alerts.length, 0);
  assert.equal(h.pending()[0].archiveState, 'ended');
  const reopened = harness(h.values);
  reopened.context.initializeAlertArchiving(); (await reopened.context.flushAlertArchive());
  assert.equal(reopened.records().length, 1);
  assert.equal(reopened.records()[0].ts, occurred);
  assert.equal(reopened.records()[0].endedAt, occurred + 100);
  assert.match(reopened.elements.get('logBody').innerHTML, /已结束/);
});

test('retriggering the same receiver/CH/metric creates a separate occurrence', async () => {
  const h = harness(); h.evaluate();
  h.device.rf = -40; h.evaluate();
  h.device.rf = -95; h.evaluate(); // same mocked millisecond still must be distinct
  (await h.context.flushAlertArchive());
  assert.equal(h.records().length, 2);
  assert.notEqual(h.records()[0].archiveId, h.records()[1].archiveId);
  assert.deepEqual(h.records().map(r => r.archiveState).sort(), ['active','ended']);
});

test('RF/battery/AF boundaries are independently archived per receiver and CH', async () => {
  const h = harness();
  h.device.rf = -90; h.device.batt = 20; h.device.afDbfs = -3;
  h.evaluate([h.device, {...h.device, id:'other', _fasheId:'other_ch1', receiver_ip:'192.0.2.103'}]);
  (await h.context.flushAlertArchive());
  assert.equal(h.records().length, 6);
  assert.deepEqual([...new Set(h.records().map(r => r.metric))].sort(), ['af','battery','rf']);
  h.evaluate([{...h.device, rf:null, batt:null, afDbfs:null}]);
  (await h.context.flushAlertArchive());
  assert.ok(h.records().every(r => r.archiveState === 'ended'));
});

test('pagehide and visibility changes synchronously save pending alerts', async () => {
  for (const event of ['pagehide', 'visibilitychange']) {
    const h = harness(); h.context.initializeAlertArchiving(); h.evaluate();
    await h.emit(event);
    assert.equal(h.records().length, 1);
  }
});

test('saved history is rendered even with zero active alerts; legacy fields remain intact', async () => {
  const legacy = {id:12, time:'旧时间', level:'WARN', device:'旧接收机', event:'旧事件'};
  const h = harness(new Map([[ARCHIVE, JSON.stringify([legacy])]]));
  h.context.renderLog();
  assert.equal(h.context.DATY_STATE.alerts.length, 0);
  assert.match(h.elements.get('logBody').innerHTML, /旧接收机/);
  assert.match(h.elements.get('logBody').innerHTML, /旧事件/);
  assert.match(h.elements.get('logBody').innerHTML, /旧时间/);
  h.evaluate(); (await h.context.flushAlertArchive());
  assert.deepEqual(h.records()[0], legacy);
});

test('quota errors retain pending data, report failure and retry without duplication', async () => {
  const h = harness(); h.evaluate(); h.fail.add(ARCHIVE);
  assert.equal((await h.context.flushAlertArchive()).success, false);
  assert.equal(h.pending().length, 1);
  assert.match(h.elements.get('logArchiveStatus').textContent, /保存失败/);
  await h.context.exportAlertsToDB();
  assert.equal(h.notices.at(-1)[1], '保存失败');
  h.fail.clear(); assert.equal((await h.context.flushAlertArchive()).success, true);
  (await h.context.flushAlertArchive()); assert.equal(h.records().length, 1);
});

test('failed pending checkpoint cannot break realtime evaluation or lose in-memory events', async () => {
  const h = harness(); h.fail.add(PENDING); h.fail.add('daty_devices'); h.fail.add('daty_alerts');
  assert.doesNotThrow(() => h.evaluate());
  assert.equal(h.context.DATY_STATE.alerts.length, 1);
  h.fail.clear(); (await h.context.flushAlertArchive());
  assert.equal(h.records().length, 1);
});

test('malformed stored history is never silently overwritten', async () => {
  for (const bad of ['{broken', '{}', '[null]']) {
    const h = harness(new Map([[ARCHIVE,bad]])); h.evaluate();
    assert.equal((await h.context.flushAlertArchive()).success, false);
    assert.equal(h.values.get(ARCHIVE), bad);
    h.context.renderLog(); assert.match(h.elements.get('logBody').innerHTML, /读取失败/);
  }
});

test('clear current is display-only and automatic archiving continues while hidden', async () => {
  const h = harness(); h.evaluate(); (await h.context.flushAlertArchive());
  h.context.clearDataLog(); (await h.context.flushAlertArchive());
  assert.equal(h.records().length, 1);
  assert.equal(h.context.DATY_STATE.alerts.length, 1);
  assert.match(h.elements.get('logBody').innerHTML, /当前显示已清空/);
  await h.context.showAlertArchive(); assert.match(h.elements.get('logBody').innerHTML, /RF 弱信号/);
});

test('clear archived history requires confirmation and does not delete realtime or other storage', async () => {
  const h = harness(); h.values.set('unrelated-project', 'keep'); h.evaluate(); (await h.context.flushAlertArchive());
  h.context.confirm = () => false; await h.context.clearAllAlertsFromDB();
  assert.equal(h.records().length, 1);
  h.context.confirm = () => true; await h.context.clearAllAlertsFromDB();
  assert.equal(h.records().length, 0); assert.equal(h.context.DATY_STATE.alerts.length, 1);
  assert.equal(h.values.get('unrelated-project'), 'keep');
  (await h.context.flushAlertArchive()); assert.equal(h.records().length, 1);
});

test('dashboard clear first archives; storage failure prevents clearing live alerts', async () => {
  const h = harness(); h.context.updateDashboardStats = () => {}; h.evaluate();
  h.fail.add(ARCHIVE); await h.context.clearAlerts();
  assert.equal(h.context.DATY_STATE.alerts.length, 1);
  h.fail.clear(); await h.context.clearAlerts();
  assert.equal(h.context.DATY_STATE.alerts.length, 0); assert.equal(h.records().length, 1);
});

test('history escapes payload text and never replaces a severity badge with a storage count', async () => {
  const h = harness(); h.device.name = '<img src=x onerror=alert(1)>'; h.evaluate();
  (await h.context.flushAlertArchive());
  for (const id of ['logBody', 'alertList']) {
    assert.doesNotMatch(h.elements.get(id).innerHTML, /<img/);
    assert.match(h.elements.get(id).innerHTML, /&lt;img/);
  }
  assert.match(h.elements.get('logBody').innerHTML, />WARN<\/span>/);
  assert.match(h.elements.get('logStorageCount').textContent, /1 条/);
});

test('history pagination bounds DOM work without discarding stored records', async () => {
  const records = Array.from({length:205}, (_,i) => ({archiveId:`a${i}`, ts:10000+i, msg:`event-${i}`}));
  const h = harness(new Map([[ARCHIVE,JSON.stringify(records)]]));
  h.context.renderLog();
  assert.equal((h.elements.get('logBody').innerHTML.match(/<tr>/g) || []).length, 20);
  assert.match(h.elements.get('logPageInfo').textContent, /第 1\/11 页 · 每页 20 条/);
  h.context.changeAlertLogPage(10);
  assert.equal((h.elements.get('logBody').innerHTML.match(/<tr>/g) || []).length, 5);
  assert.equal(h.records().length, 205);
});

test('20-row pagination covers zero, exact and partial pages with correct button boundaries', async () => {
  for (const size of [0,1,20,21,40,41]) {
    const records = Array.from({length:size}, (_,i) => ({archiveId:`a${i}`,ts:10000+i,msg:`event-${i}`}));
    const h = harness(new Map([[ARCHIVE,JSON.stringify(records)]]));h.context.renderLog();
    assert.equal(h.elements.get('logPrevPage').disabled,true);
    assert.equal(h.elements.get('logNextPage').disabled,size<=20);
    assert.equal(h.elements.get('logPagination').hidden,size===0);
    if (!size) continue;
    const seen=[];
    while (true) {
      const html=h.elements.get('logBody').innerHTML;
      seen.push(...[...html.matchAll(/>event-(\d+)(?:<button|<\/td>)/g)].map(m=>Number(m[1])));
      if (h.elements.get('logNextPage').disabled) break;
      h.context.changeAlertLogPage(1);
    }
    assert.deepEqual(seen,Array.from({length:size},(_,i)=>size-i-1));
    assert.deepEqual(h.records(),records);
  }
});

test('archive growth keeps the current page, shrink clamps it and corrupt data hides stale paging', async () => {
  const records=Array.from({length:41},(_,i)=>({archiveId:`a${i}`,ts:10000+i,msg:`event-${i}`}));
  const h=harness(new Map([[ARCHIVE,JSON.stringify(records)]]));h.context.renderLog();h.context.changeAlertLogPage(2);
  h.values.set(ARCHIVE,JSON.stringify([...records,{archiveId:'new',ts:20000,msg:'new'}]));h.context.renderLog();
  assert.match(h.elements.get('logPageInfo').textContent,/第 3\/3 页/);
  h.values.set(ARCHIVE,JSON.stringify(records.slice(0,20)));h.context.renderLog();
  assert.match(h.elements.get('logPageInfo').textContent,/第 1\/1 页/);
  h.values.set(ARCHIVE,'broken');h.context.renderLog();
  assert.equal(h.elements.get('logPagination').hidden,true);
  assert.equal(h.elements.get('logCount').textContent,'—');
  assert.equal(h.values.get(ARCHIVE),'broken');
});

test('compact log cells retain full escaped messages, targets and end times in tooltips', async () => {
  const message='Long <script> message "quoted" & '+ 'RF weak signal '.repeat(30);
  const h=harness(new Map([[ARCHIVE,JSON.stringify([{archiveId:'a',ts:10000,deviceId:'rx"<1>',receiverIP:'192.0.2.1',msg:message,archiveState:'ended',endedAt:20000}])]]));
  h.context.renderLog();const html=h.elements.get('logBody').innerHTML;
  assert.ok(html.includes(`title="${h.context.escapeAlertText(message)}"`));
  assert.ok(html.includes('title="rx&quot;&lt;1&gt; · 192.0.2.1"'));
  assert.match(html,/title="已结束 · /);assert.doesNotMatch(html,/<script>/);
  assert.equal(h.records()[0].msg,message);
});

test('Timeline also shows 20 rows per page without fetching again or overwriting archive data', async () => {
  const h=harness();h.evaluate();(await h.context.flushAlertArchive());const before=JSON.stringify(h.records());
  let requests=0;
  h.context.fetch=async()=>{requests++;return {ok:true,json:async()=>({success:true,events:Array.from({length:45},(_,i)=>({ts:10000+i,event_type:'state',summary:`audit-${i}`}))})};};
  await h.context.loadServerTimeline();
  assert.equal((h.elements.get('logBody').innerHTML.match(/<tr>/g)||[]).length,20);
  h.context.changeAlertLogPage(1);assert.match(h.elements.get('logBody').innerHTML,/>audit-20<\/td>/);
  h.context.changeAlertLogPage(1);assert.equal((h.elements.get('logBody').innerHTML.match(/<tr>/g)||[]).length,5);
  assert.equal(h.elements.get('logNextPage').disabled,true);assert.equal(requests,1);
  (await h.context.flushAlertArchive());assert.match(h.elements.get('logBody').innerHTML,/>audit-40<\/td>/);
  await h.context.showAlertArchive();assert.match(h.elements.get('logBody').innerHTML,/RF 弱信号/);
  assert.equal(JSON.stringify(h.records()),before);
});

test('latest Timeline reload wins, and failures leave no stale count or pagination', async () => {
  const h=harness(),pending=[];
  h.context.fetch=()=>new Promise(resolve=>pending.push(resolve));
  const first=h.context.loadServerTimeline(),second=h.context.loadServerTimeline();
  pending[1]({ok:true,json:async()=>({success:true,events:[{ts:1000,event_type:'state',summary:'newest'}]})});await second;
  pending[0]({ok:true,json:async()=>({success:true,events:[{ts:900,event_type:'state',summary:'outdated'}]})});await first;
  assert.match(h.elements.get('logBody').innerHTML,/newest/);assert.doesNotMatch(h.elements.get('logBody').innerHTML,/outdated/);
  h.context.fetch=async()=>({ok:true,json:async()=>({success:true,events:[null]})});await h.context.loadServerTimeline();
  assert.match(h.elements.get('logBody').innerHTML,/格式错误/);
  assert.equal(h.elements.get('logCount').textContent,'—');assert.equal(h.elements.get('logPagination').hidden,true);
});

test('Timeline is not overwritten by timer and a late response cannot replace archive view', async () => {
  const h = harness(); h.evaluate();
  let resolveFetch;
  h.context.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
  const loading = h.context.loadServerTimeline();
  (await h.context.flushAlertArchive());
  assert.match(h.elements.get('logBody').innerHTML, /正在读取服务端/);
  await h.context.showAlertArchive();
  resolveFetch({ok:true, json:async () => ({success:true, events:[]})}); await loading;
  assert.match(h.elements.get('logBody').innerHTML, /RF 弱信号/);
});

test('active cache loads without a device cache and startup does not delete IndexedDB', async () => {
  const cached = {id:'old', msg:'cached', ts:10000};
  const h = harness(new Map([['daty_alerts',JSON.stringify([cached])]]));
  assert.equal(h.context.DATY_STATE.alerts.length, 1);
  h.context.initializeAlertArchiving(); (await h.context.flushAlertArchive());
  assert.equal(h.records().length, 1);
  await h.context.initDatabase();
  for (const file of ['storage', 'init']) assert.doesNotMatch(fs.readFileSync(path.join(root,'src/modules',file+'.js'),'utf8'), /deleteDatabase\(/);
});

test('HTML loads archiver before rendering and boot; all edited modules parse', async () => {
  const html = fs.readFileSync(path.join(root, 'unirf-app.html'),'utf8');
  assert.ok(html.indexOf('src/modules/storage.js') < html.indexOf('src/modules/alert-history.js'));
  assert.ok(html.indexOf('src/modules/alert-history.js') < html.indexOf('src/modules/render.js'));
  for (const id of ['logStorageCount','logArchiveStatus','logPagination']) assert.equal((html.match(new RegExp(`id="${id}"`,'g')) || []).length, 1);
  for (const name of ['storage','alert-history','render','timeline','init']) new vm.Script(fs.readFileSync(path.join(root,'src/modules',name+'.js'),'utf8'));
});

test('archive clear waits for app confirmation and coalesces repeated clicks', async () => {
  const h=harness();h.evaluate();(await h.context.flushAlertArchive());let approve,calls=0,options;
  h.context.DatyDialogs.confirm=o=>{calls++;options=o;return new Promise(resolve=>approve=resolve);};
  const pending=h.context.clearAllAlertsFromDB();
  assert.equal(h.elements.get('logClearStorage').disabled,true);
  assert.equal(await h.context.clearAllAlertsFromDB(),false);assert.equal(calls,1);
  assert.equal(h.records().length,1);assert.equal(options.tone,'danger');
  assert.equal(options.details.find(x=>x.label==='记录数量').value,'1 条');
  h.device.rf=-98;h.advance(2000);h.evaluate();const queued=h.values.get(PENDING);
  approve(true);assert.equal(await pending,true);assert.equal(h.records().length,0);
  assert.equal(h.values.get(PENDING),queued);assert.equal(h.context.DATY_STATE.alerts.length,1);
  assert.equal(h.elements.get('logClearStorage').disabled,false);
});

test('another tab changing the archive while confirming invalidates an old decision', async () => {
  const h=harness();h.evaluate();(await h.context.flushAlertArchive());let approve;
  h.context.DatyDialogs.confirm=()=>new Promise(resolve=>approve=resolve);
  const pending=h.context.clearAllAlertsFromDB();
  const updated=JSON.stringify([...h.records(),{archiveId:'other-tab',firstSeen:1,lastSeen:2}]);h.values.set(ARCHIVE,updated);
  approve(true);assert.equal(await pending,false);assert.equal(h.values.get(ARCHIVE),updated);
  assert.match(h.notices.at(-1)[2],/存储已更新/);assert.equal(h.elements.get('logClearStorage').disabled,false);
});

test('auto-save during clear confirmation retains pending events without competing with deletion',async()=>{
  const h=harness();h.evaluate();await h.context.flushAlertArchive();let approve;
  const before=h.values.get(ARCHIVE);h.context.DatyDialogs.confirm=()=>new Promise(resolve=>approve=resolve);
  const clearing=h.context.clearAllAlertsFromDB();h.advance(30000);h.device.rf=-100;h.evaluate();
  const waiting=await h.context.flushAlertArchive();assert.equal(waiting.success,false);
  assert.equal(h.values.get(ARCHIVE),before);const pending=h.values.get(PENDING);assert(h.pending().length);
  approve(true);assert.equal(await clearing,true);assert.equal(h.values.get(PENDING),pending);
  assert.equal(h.read('_alertArchiveError'),'');assert.equal(h.records().length,0);
});

test('missing, synchronous, rejected or non-boolean confirmation cannot clear archive', async () => {
  for(const dialogs of [undefined,{}, {confirm:()=>true}, {confirm:async()=>({approved:true})}, {confirm:async()=>{throw Error('unavailable');}}]){
    const h=harness();h.evaluate();(await h.context.flushAlertArchive());const before=h.values.get(ARCHIVE);
    h.context.DatyDialogs=dialogs;assert.equal(await h.context.clearAllAlertsFromDB(),false);
    assert.equal(h.values.get(ARCHIVE),before);assert.equal(h.elements.get('logClearStorage').disabled,false);
  }
});

test('changed platform, storage or confirmation owner invalidates archive deletion', async () => {
  for(const change of ['platform','storage','dialogs']){
    const h=harness();h.context.DatyPlatform={kind:'native',storage:h.context.localStorage};
    h.evaluate();(await h.context.flushAlertArchive());const before=h.values.get(ARCHIVE);let approve;
    h.context.DatyDialogs.confirm=()=>new Promise(resolve=>approve=resolve);
    const pending=h.context.clearAllAlertsFromDB();
    if(change==='platform')h.context.DatyPlatform={...h.context.DatyPlatform};
    if(change==='storage')h.context.DatyPlatform.storage={...h.context.localStorage};
    if(change==='dialogs')h.context.DatyDialogs={...h.context.DatyDialogs};
    approve(true);assert.equal(await pending,false);assert.equal(h.values.get(ARCHIVE),before);
    assert.equal(h.elements.get('logClearStorage').disabled,false);
  }
});

test('empty or unreadable archives do not open destructive confirmation', async () => {
  for(const value of ['[]','broken']){
    const h=harness(new Map([[ARCHIVE,value]]));let calls=0;
    h.context.DatyDialogs.confirm=async()=>{calls++;return true;};
    assert.equal(await h.context.clearAllAlertsFromDB(),false);assert.equal(calls,0);
    assert.equal(h.values.get(ARCHIVE),value);
  }
});

test('storage delete failure is reported without clearing pending or realtime events', async () => {
  const h=harness();h.evaluate();(await h.context.flushAlertArchive());h.advance(2000);h.evaluate();
  const before=[h.values.get(ARCHIVE),h.values.get(PENDING)];h.fail.add(ARCHIVE);
  assert.equal(await h.context.clearAllAlertsFromDB(),false);
  assert.deepEqual([h.values.get(ARCHIVE),h.values.get(PENDING)],before);
  assert.equal(h.context.DATY_STATE.alerts.length,1);assert.equal(h.notices.at(-1)[1],'清空失败');
  assert.equal(h.elements.get('logClearStorage').disabled,false);
});

test('archive, Timeline and cleared display expose their actual selected source', async () => {
  const h=harness();const selected=()=>['logArchiveView','logTimelineView'].map(id=>h.elements.get(id).attributes['aria-pressed']);
  await h.context.showAlertArchive();assert.deepEqual(selected(),['true','false']);
  h.context.fetch=async()=>({ok:true,json:async()=>({success:true,events:[]})});
  await h.context.loadServerTimeline();assert.deepEqual(selected(),['false','true']);
  assert.match(h.elements.get('logBody').innerHTML,/Timeline 暂无事件/);
  h.context.clearDataLog();assert.deepEqual(selected(),['false','false']);
  await h.context.showAlertArchive();assert.deepEqual(selected(),['true','false']);
  assert.doesNotMatch(h.context.alertLogEmptyMarkup('<img>','<script>','<svg>'),/<img>|<script>|<svg>/);
});

test('dashboard uses async app confirmation, cancels safely and ignores duplicate clicks', async () => {
  const h=harness();h.context.updateDashboardStats=()=>{};h.evaluate();let decide,options;
  h.context.confirm=()=>{throw Error('No system dialogs');};
  h.context.DatyDialogs.confirm=value=>{options=value;return new Promise(resolve=>decide=resolve);};
  const action=h.context.clearAlerts();assert.equal(h.elements.get('realtimeAlertClear').disabled,true);
  assert.equal(await h.context.clearAlerts(),false);assert.equal(h.records().length,0);
  assert.equal(options.title,'清空实时告警');decide(false);assert.equal(await action,false);
  assert.equal(h.context.DATY_STATE.alerts.length,1);assert.equal(h.elements.get('realtimeAlertClear').disabled,false);
});

test('dashboard clear rejects missing, invalid and failed app dialogs without archiving',async()=>{
  for(const dialog of [undefined,{confirm:()=>true},{confirm:async()=>1},{confirm:async()=>{throw Error('dialog failed');}}]){
    const h=harness();h.evaluate();h.context.DatyDialogs=dialog;
    assert.equal(await h.context.clearAlerts(),false);assert.equal(h.context.DATY_STATE.alerts.length,1);
    assert.equal(h.records().length,0);assert.equal(h.elements.get('realtimeAlertClear').disabled,false);
  }
});

test('dashboard confirmation retains newly arrived alerts and refuses a changed database scope',async()=>{
  const h=harness();h.context.updateDashboardStats=()=>{};h.evaluate();let decide;
  h.context.DatyDialogs.confirm=()=>new Promise(resolve=>decide=resolve);
  const action=h.context.clearAlerts();h.evaluate([h.device,{...h.device,id:'new',_fasheId:'new_ch1',receiver_id:'new'}]);
  decide(true);assert.equal(await action,true);assert.equal(h.context.DATY_STATE.alerts.length,1);
  assert.equal(h.context.DATY_STATE.alerts[0].receiverId,'new');assert.equal(h.records().length,2);
  const changed=h.context.clearAlerts();h.context.DatyDatabaseConnection={snapshot:()=>({origin:'https://other',revision:2})};
  decide(true);assert.equal(await changed,false);assert.equal(h.context.DATY_STATE.alerts.length,1);
});

test('dashboard archives all 205 selected alerts and keeps changes arriving during I/O',async()=>{
  const h=harness();h.context.updateDashboardStats=()=>{};
  const devices=Array.from({length:205},(_,i)=>({...h.device,id:'rx'+i,_fasheId:'rx'+i+'_ch1'}));h.evaluate(devices);
  assert.equal(await h.context.clearAlerts(),true);assert.equal(h.records().length,205);assert.equal(h.context.DATY_STATE.alerts.length,0);
  h.evaluate();const original=h.context.DatyAlertDatabase.flush;let release;
  h.context.DatyAlertDatabase.flush=async rows=>{await new Promise(resolve=>release=resolve);return original(rows);};
  const clearing=h.context.clearAlerts();await drain();
  h.advance(100);h.device.rf=-99;h.evaluate();release();assert.equal(await clearing,true);
  assert.equal(h.context.DATY_STATE.alerts.length,1);assert.equal(h.context.DATY_STATE.alerts[0].value,-99);
  assert.equal(h.pending().length,1);
});

test('AF uses canonical live dBFS for both cards and alerts, never stale aliases or percentages',()=>{
  const h=harness();h.device.rf=-40;
  for(const bad of [null,undefined,'',false,'bad',1,-41]){
    const d={...h.device,afDbfs:bad,af_dbfs:0,af_level:0,af:100};h.evaluate([d]);
    assert.equal(h.context.getAfMeter(d).available,false);assert.equal(h.context.DATY_STATE.alerts.length,0);
  }
  for(const af of [-40,-3,0]){
    const d={...h.device,afDbfs:af,af_dbfs:-20,af:100};h.evaluate([d]);
    assert.equal(h.context.getAfMeter(d).dbfs,af);assert.equal(h.context.DATY_STATE.alerts.length,af>=-3?1:0);
    if(af>=-3)assert.equal(h.context.DATY_STATE.alerts[0].value,af);
  }
  const legacy={...h.device,af_dbfs:-2};delete legacy.afDbfs;h.evaluate([legacy]);assert.equal(h.context.DATY_STATE.alerts[0].value,-2);
});

test('AF source distinguishes identical CH names by actual IP/GROUP and refreshes source metadata',async()=>{
  const h=harness(),a={...h.device,rf:-40,afDbfs:0,brand:'DATYaudio',model:'DATY-X1',group_number:11,group_source:'server-fifo-v1'};
  const b={...a,id:'other_ch1',_fasheId:'other_ch1',receiver_id:'other',receiver_ip:'192.0.2.103',group_number:4};
  h.evaluate([a,b]);const alerts=h.context.DATY_STATE.alerts;
  assert.equal(alerts.length,2);assert.match(alerts[0].msg,/192\.0\.2\.102 · GROUP11 · CH1 · DATYaudio DATY-X1/);
  assert.match(alerts[1].msg,/192\.0\.2\.103 · GROUP4 · CH1/);assert.notEqual(alerts[0].key,alerts[1].key);
  const occurrence=alerts[0].archiveId;h.advance(100);a.receiver_ip='192.0.2.190';a.group_number=2;a.model='RF PRO';h.evaluate([a,b]);
  assert.equal(alerts[0].archiveId,occurrence);assert.equal(alerts[0].receiverIP,'192.0.2.190');assert.equal(alerts[0].groupNumber,2);
  assert.equal(alerts[0].receiverModel,'RF PRO');await h.context.flushAlertArchive();
  const row=h.records().find(r=>r.archiveId===occurrence);assert.equal(row.receiverIP,'192.0.2.190');assert.equal(row.channelId,a._fasheId);
  delete a.group_source;h.evaluate([a]);assert.match(alerts[0].msg,/GROUP 未知/);assert.equal(alerts[0].groupNumber,null);
});

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const drain=()=>new Promise(resolve=>setImmediate(resolve));
function seedPending(h,count){for(let i=0;i<count;i++)h.context.queueAlertForArchive({archiveId:'pending-'+i,deviceId:'rx_ch1',metric:'rf',firstSeen:1000+i,lastSeen:2000+i,msg:'queued '+i},'ended');}

test('archive button queries fresh database and never reports a failed read as empty',async()=>{
  const h=harness(),gate=deferred();let options;
  h.context.DatyAlertDatabase.load=input=>{options=input;return gate.promise;};
  const loading=h.context.showAlertArchive();assert.equal(options.fresh,true);
  assert.match(h.elements.get('logBody').innerHTML,/正在读取服务器/);assert.equal(h.elements.get('logCount').textContent,'—');
  gate.resolve({success:false,error:'server offline'});assert.equal(await loading,false);
  assert.match(h.elements.get('logBody').innerHTML,/server offline/);assert.doesNotMatch(h.elements.get('logBody').innerHTML,/暂无已归档/);
  h.context.DatyAlertDatabase.load=async()=>{h.values.set(ARCHIVE,JSON.stringify([{archiveId:'from-other-tab',msg:'server-new'}]));return {success:true};};
  assert.equal(await h.context.showAlertArchive(),true);assert.match(h.elements.get('logBody').innerHTML,/server-new/);
  assert.match(h.elements.get('logStorageCount').textContent,/服务器告警/);
});

test('clearing display during archive read hides late results and explicit refresh restores them',async()=>{
  const h=harness(),gate=deferred();h.context.DatyAlertDatabase.load=()=>gate.promise;
  const loading=h.context.showAlertArchive();h.context.clearDataLog();gate.resolve({success:true});await loading;
  assert.match(h.elements.get('logBody').innerHTML,/当前显示已清空/);assert.equal(h.elements.get('logClearDisplay').disabled,true);
  await h.context.showAlertArchive();assert.equal(h.elements.get('logClearDisplay').disabled,false);
});

test('manual save captures all 405 queued alerts and checkpoints each confirmed batch',async()=>{
  const h=harness();seedPending(h,405);const sizes=[],flush=h.context.DatyAlertDatabase.flush;
  h.context.DatyAlertDatabase.flush=async records=>{sizes.push(records.length);return flush(records);};
  assert.equal(await h.context.exportAlertsToDB(),true);assert.deepEqual(sizes,[200,200,5]);
  assert.equal(h.pending().length,0);assert.equal(h.records().length,405);assert.match(h.notices.at(-1)[2],/确认 405/);
});

test('failure after first manual batch reports partial save and preserves only unconfirmed queue',async()=>{
  const h=harness();seedPending(h,405);let calls=0;const flush=h.context.DatyAlertDatabase.flush;
  h.context.DatyAlertDatabase.flush=async records=>++calls===2?{success:false,error:'fixture offline'}:flush(records);
  assert.equal(await h.context.exportAlertsToDB(),false);assert.equal(calls,2);
  assert.equal(h.records().length,200);assert.equal(h.pending().length,205);assert.match(h.notices.at(-1)[1],/部分保存/);assert.match(h.notices.at(-1)[2],/200/);
});

test('manual double click and auto tick share one writer, and display clear survives save completion',async()=>{
  const h=harness();seedPending(h,1);const gate=deferred(),flush=h.context.DatyAlertDatabase.flush;let calls=0;
  h.context.DatyAlertDatabase.flush=async records=>{calls++;await gate.promise;return flush(records);};
  const saving=h.context.exportAlertsToDB();assert.equal(h.elements.get('logSaveNow').disabled,true);assert.equal(h.elements.get('logClearStorage').disabled,true);
  assert.equal(await h.context.exportAlertsToDB(),false);assert.equal(await h.context.clearAllAlertsFromDB(),false);
  const tick=h.context.flushAlertArchive();h.context.clearDataLog();gate.resolve();await Promise.all([saving,tick]);
  assert.equal(calls,1);assert.match(h.elements.get('logBody').innerHTML,/当前显示已清空/);assert.equal(h.records().length,1);
});

test('manual save waits for automatic batch then drains remaining queued records',async()=>{
  const h=harness();seedPending(h,205);const gate=deferred(),flush=h.context.DatyAlertDatabase.flush,sizes=[];
  h.context.DatyAlertDatabase.flush=async records=>{sizes.push(records.length);if(sizes.length===1)await gate.promise;return flush(records);};
  const automatic=h.context.flushAlertArchive(),manual=h.context.exportAlertsToDB();gate.resolve();await Promise.all([automatic,manual]);
  assert.deepEqual(sizes,[200,5]);assert.equal(h.pending().length,0);assert.equal(h.records().length,205);
});

test('server commit with failed readback is explicitly saved-but-not-refreshed',async()=>{
  const h=harness();seedPending(h,1);const flush=h.context.DatyAlertDatabase.flush;
  h.context.DatyAlertDatabase.flush=async rows=>({...await flush(rows),readBackConfirmed:false});
  assert.equal(await h.context.exportAlertsToDB(),true);assert.equal(h.pending().length,0);assert.match(h.notices.at(-1)[1],/列表待刷新/);
  assert.match(h.notices.at(-1)[2],/列表读取未完成/);assert.doesNotMatch(h.notices.at(-1)[2],/共 0/);
});

test('new lifecycle during manual save remains pending and is not silently part of captured input',async()=>{
  const h=harness();seedPending(h,1);const gate=deferred(),flush=h.context.DatyAlertDatabase.flush;
  h.context.DatyAlertDatabase.flush=async rows=>{await gate.promise;return flush(rows);};
  const saving=h.context.exportAlertsToDB();h.context.queueAlertForArchive({archiveId:'new-lifecycle',firstSeen:3,lastSeen:4,msg:'new'},'ended');gate.resolve();await saving;
  assert.equal(h.records().length,1);assert.equal(h.pending().length,1);assert.equal(h.pending()[0].archiveId,'new-lifecycle');
});

test('timeline uses the database connection, disables archive mutation, and clear display sends no write',async()=>{
  const h=harness();let reads=0,flushes=0,clears=0;
  h.context.DatyAlertDatabase.flush=async()=>{flushes++;throw Error('must not save');};h.context.DatyAlertDatabase.clearAll=async()=>{clears++;};
  h.elements.set('fasheApiUrl',{value:'https://192.0.2.200:8802'});
  h.context.fetch=async(url,init)=>{reads++;assert.equal(url,'https://127.0.0.1:8802/api/timeline?limit=200');assert.equal(init.method,undefined);return {ok:true,json:async()=>({success:true,events:[]})};};
  assert.equal(await h.context.loadServerTimeline(),true);assert.equal(h.elements.get('logSaveNow').disabled,true);assert.equal(h.elements.get('logClearStorage').disabled,true);
  assert.equal(await h.context.exportAlertsToDB(),false);assert.equal(await h.context.clearAllAlertsFromDB(),false);
  h.context.clearDataLog();assert.equal(reads,1);assert.equal(flushes,0);assert.equal(clears,0);
  assert.equal(h.elements.get('logSaveNow').disabled,true);await h.context.showAlertArchive();assert.equal(h.elements.get('logSaveNow').disabled,false);
});

test('timeline clears a loaded old-server snapshot when connection generation changes',async()=>{
  const h=harness();let changed;h.context.DatyDatabaseConnection.subscribe=fn=>{changed=fn;return()=>{};};
  h.context.fetch=async()=>({ok:true,json:async()=>({success:true,events:[{ts:1,event_type:'old',summary:'previous-server'}]})});
  await h.context.loadServerTimeline();changed();assert.doesNotMatch(h.elements.get('logBody').innerHTML,/previous-server/);
  assert.equal(h.elements.get('logCount').textContent,'—');assert.match(h.elements.get('logBody').innerHTML,/服务器连接已变化/);
});

test('timeline timeout and clearing display abort a read even if the network ignores cancellation',async()=>{
  const h=harness();let timeout,signal;h.context.setTimeout=fn=>{timeout=fn;return 1;};
  h.context.fetch=(_url,options)=>{signal=options.signal;return new Promise(()=>{});};
  const timed=h.context.loadServerTimeline();timeout();assert.equal(await timed,false);assert.equal(signal.aborted,true);
  assert.match(h.elements.get('logBody').innerHTML,/超时/);
  const abandoned=h.context.loadServerTimeline();h.context.clearDataLog();assert.equal(await abandoned,false);
  assert.equal(signal.aborted,true);assert.match(h.elements.get('logBody').innerHTML,/当前显示已清空/);
});

test('clearing display while delete confirmation is open remains blank after confirmed deletion',async()=>{
  const h=harness();seedPending(h,1);await h.context.flushAlertArchive();const decision=deferred();h.context.DatyDialogs.confirm=()=>decision.promise;
  const clearing=h.context.clearAllAlertsFromDB();h.context.clearDataLog();decision.resolve(true);assert.equal(await clearing,true);
  assert.equal(h.records().length,0);assert.match(h.elements.get('logBody').innerHTML,/当前显示已清空/);
});

test('server change during save stops subsequent batches and retains old-scope pending intent',async()=>{
  const h=harness();seedPending(h,205);const gate=deferred(),flush=h.context.DatyAlertDatabase.flush;let calls=0;
  h.context.DatyAlertDatabase.flush=async rows=>{calls++;await gate.promise;return flush(rows);};
  const saving=h.context.exportAlertsToDB();h.context.DatyDatabaseConnection={...h.context.DatyDatabaseConnection,snapshot:()=>({origin:'https://192.0.2.99:8802',revision:2,source:{id:'other'}})};
  gate.resolve();assert.equal(await saving,false);assert.equal(calls,1);assert.equal(h.pending().length,205);assert.match(h.notices.at(-1)[2],/连接已变化/);
});

test('successful delete clears an earlier read error and renders the confirmed empty archive',async()=>{
  const h=harness();seedPending(h,1);await h.context.flushAlertArchive();
  h.context.DatyAlertDatabase.load=async()=>({success:false,error:'temporary read error'});await h.context.showAlertArchive();
  assert.match(h.elements.get('logBody').innerHTML,/temporary read error/);
  assert.equal(await h.context.clearAllAlertsFromDB(),true);assert.doesNotMatch(h.elements.get('logBody').innerHTML,/temporary read error/);
  assert.match(h.elements.get('logBody').innerHTML,/服务器暂无已归档告警/);
});
