// Run: node --test tests/planning-history.test.cjs
// Exercise production browser modules in an isolated DOM/storage/API harness.
// No requests or control commands are sent to running services or receivers.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');

const KEY = 'daty_planning_history_v1';

test('partial legacy field snapshots preserve compatibility from saved options',async()=>{
  const h=harness();await h.boot();
  h.context.DatyPlanningConstraints.restoreSnapshot({options:{compatibilityLevel:'more-frequencies'},constraintFields:{plannerBackupCount:'0'}});
  assert.equal(h.elements.get('plannerCompatibility').value,'more-frequencies');
  assert.equal(h.context.DatyPlanningConstraints.getOptions().compatibilityLevel,'more-frequencies');
});
test('invalid compatibility cannot be silently saved as standard',async()=>{
  const h=harness();await h.boot();h.edit('plannerCompatibility','bad-level');
  assert.equal(await h.context.saveCurrentPlanningConstraints(),false);assert.equal(h.api.writes.length,0);
  assert.throws(()=>h.context.DatyPlanningConstraints.getOptions(),/兼容级别/);
});
const clone = value => JSON.parse(JSON.stringify(value));
const receiver = (id, ip, extras = {}) => ({
  id, _fasheId:`FAshe-${ip}_ch1`, receiver_ip:ip, ip, ch:'CH1', channel_number:1,
  brand:'DATYaudio', model:'DATY-X1', name:`${ip} CH1`, freq:620000, planned:0,
  rf:-60, afDbfs:-12, batt:85, muted:false, _online:true, _source:'fashe', ...extras
});
const a = receiver(1, '192.0.2.102');
const b = receiver(2, '192.0.2.103');
const response = (body, status = 200) => ({ok:status >= 200 && status < 300, status, json:async () => clone(body)});

function server(initial = []) {
  const projects = new Map(initial.map(project => [project.id, clone(project)]));
  const writes = [], runs = [], reads = [];
  return {projects, writes, runs, reads, fetch:async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (init.method === 'POST' && pathname === '/api/projects') {
      const body = JSON.parse(init.body);
      writes.push(body);
      projects.set(body.id, {...projects.get(body.id), ...clone(body)});
      return response({success:true, project_id:body.id});
    }
    if (init.method === 'POST' && pathname === '/api/coordination-runs') {
      runs.push(JSON.parse(init.body));
      return response({success:true, run_id:randomUUID()});
    }
    assert.equal(init.method || 'GET', 'GET', 'History must never issue a device command');
    assert.match(pathname, /^\/api\/projects\//);
    const id = decodeURIComponent(pathname.slice('/api/projects/'.length));
    reads.push(id);
    return projects.has(id) ? response({success:true, project:projects.get(id)}) : response({success:false}, 404);
  }};
}

function harness({values = new Map(), devices = [a, b], api = server(), fetch = api.fetch} = {}) {
  const notices = [], downloads = [], listeners = new Map(), elements = new Map();
  function element(value = '') {
    const events = new Map();
    return {value, textContent:'', innerHTML:'', style:{}, disabled:false, options:[],
      appendChild(child) { this.options.push(child); }, removeChild() {}, remove() {}, click() {},
      addEventListener(name, fn) { events.set(name, fn); }, dispatch(name) { return events.get(name)?.(); }};
  }
  for (const [id, value] of Object.entries({
    plannerExcludedRanges:'', plannerLockedAssignments:'', plannerKnownCarriers:'', plannerBackupCount:'1',
    plannerRange:'614250:638000', plannerCompatibility:'standard', fasheApiUrl:'http://test.invalid:8802',
    savePlannerConstraints:'', plannerConstraintSaveStatus:'', planningHistorySaveStatus:'',
    planningHistoryProject:'', historyBody:'', planResultContent:'', freqTableBody:'',
    historyPagination:'', historyPageInfo:'', historyPrevPage:'', historyNextPage:''
  })) elements.set(id, element(value));
  elements.get('plannerRange').options = ['614250:638000', '470000:608000', 'scan'].map(value => ({value}));
  const context = vm.createContext({
    document:{readyState:'loading', body:element(), createElement:() => element(),
      getElementById:id => elements.get(id) || null,
      addEventListener(name, fn) { listeners.set(name, [...listeners.get(name) || [], fn]); }},
    localStorage:{getItem:key => values.get(key) ?? null, setItem:(key, value) => values.set(key, String(value)), removeItem:key => values.delete(key)},
    fetch, AbortController, AbortSignal, performance, crypto:{randomUUID}, Blob,
    URL:{createObjectURL:blob => { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {}},
    console:{log() {}, warn() {}, error() {}}, confirm:() => true,
    notify:(...args) => notices.push(args), setTimeout, clearTimeout
  });
  context.window = context;
  context.DatyDialogs={confirm:async options=>context.confirm(options),cancelActive(){}};
  context.DatyPlatform={kind:'browser',storage:context.localStorage,request:fetch,downloadText(text,options){downloads.push(new Blob([text],{type:options.mimeType}));}};
  context.DatyTextExportFactory=require('../src/platform/browser-platform.js').textExports;
  for (const name of ['frequency', 'equipment-profiles', 'coordination', 'storage', 'render', 'planning-ui']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', name + '.js'), 'utf8'), context, {filename:name + '.js'});
  }
  context.DATY_STATE.devices.splice(0, context.DATY_STATE.devices.length, ...clone(devices));
  return {context, values, elements, api, notices, downloads,
    boot:async () => { for (const fn of listeners.get('DOMContentLoaded') || []) await fn(); },
    history:() => JSON.parse(values.get(KEY) || '{}'),
    flush:() => vm.runInContext('planningProjectSaveQueue', context),
    edit(id, value) { elements.get(id).value = value; elements.get(id).dispatch('input'); },
    status:() => elements.get('plannerConstraintSaveStatus').textContent
  };
}

function fill(h) {
  h.edit('plannerExcludedRanges', '615.000-616.000 电视');
  h.edit('plannerLockedAssignments', `${a._fasheId}=620.000 主持人`);
  h.edit('plannerKnownCarriers', '630.500,250,对讲');
  h.edit('plannerBackupCount', '0');
  h.edit('plannerCompatibility', 'robust');
}

test('explicit save persists all constraints, raw fields and receiver identity without a download', async () => {
  const api = server([{id:'default', name:'默认项目', data:{venue:'剧场A'}}]);
  const h = harness({api}); await h.boot(); fill(h);
  await h.context.saveCurrentPlanningConstraints();
  const record = h.history().records[0];
  assert.equal(record.constraints.backupCount, 0);
  assert.equal(record.constraints.excludedRanges[0].startKHz, 615000);
  assert.equal(record.constraints.lockedAssignments[0].deviceId, 1);
  assert.equal(record.constraints.knownCarriers[0].guardKHz, 250);
  assert.equal(record.constraintFields.plannerCompatibility, 'robust');
  assert.equal(record.options.rangeStartKHz, 614250);
  assert.equal(record.devices[0]._fasheId, a._fasheId);
  assert.equal(api.writes[0].data.venue, '剧场A');
  assert.deepEqual(api.writes[0].data.planningHistory, h.history().records);
  assert.equal(api.runs.length, 0);
  assert.equal(h.downloads.length, 0);
  assert.match(h.status(), /已保存到当前项目及规划历史/);
});

test('browser restart restores selected history, including backup zero', async () => {
  const h = harness(); await h.boot(); fill(h); await h.context.saveCurrentPlanningConstraints();
  const reloaded = harness({values:h.values, api:h.api}); await reloaded.boot();
  assert.equal(reloaded.elements.get('plannerExcludedRanges').value, '615.000-616.000 电视');
  assert.equal(reloaded.elements.get('plannerBackupCount').value, '0');
  assert.equal(reloaded.elements.get('plannerCompatibility').value, 'robust');
  assert.equal(reloaded.history().records.length, 1);
  reloaded.context.renderHistory();
  assert.match(reloaded.elements.get('historyBody').innerHTML, /备用 0/);
});

test('same-day records remain distinct; old records clear absent constraint fields', async () => {
  const h = harness(); await h.boot(); fill(h); await h.context.saveCurrentPlanningConstraints();
  h.edit('plannerBackupCount', '2'); await h.context.saveCurrentPlanningConstraints();
  assert.equal(h.history().records.length, 2);
  const [latest, first] = h.history().records;
  assert.notEqual(latest.id, first.id);
  await h.context.loadHistory(first.id);
  assert.equal(h.elements.get('plannerBackupCount').value, '0');
  h.context.loadPlanFromData({type:'daty_rf_planning', devices:[], name:'旧记录'});
  assert.equal(h.elements.get('plannerExcludedRanges').value, '');
  assert.equal(h.elements.get('plannerLockedAssignments').value, '');
  assert.equal(h.elements.get('plannerBackupCount').value, '1');
});

test('history targets receiver plus CH, survives local ID changes and does not restore telemetry', async () => {
  const h = harness({devices:[{...b, id:1}, {...a, id:88}]}); await h.boot();
  const before = clone(h.context.DATY_STATE.devices);
  assert.equal(h.context.loadPlanFromData({type:'daty_rf_planning', name:'身份测试', devices:[{...a, planned:622000, muted:true, rf:-90}],
    constraints:{lockedAssignments:[{deviceId:1, frequencyKHz:622000}], backupCount:0}}), true);
  assert.deepEqual(clone(h.context.DATY_STATE.devices), [before[0], {...before[1], planned:622000}]);
  assert.equal(h.context.DatyPlanningConstraints.readConstraintFields().lockedAssignments[0].deviceId, 88);
  assert.match(h.elements.get('freqTableBody').innerHTML, /待重新校验/);
  assert.doesNotMatch(h.elements.get('freqTableBody').innerHTML, /无冲突/);
});

test('offline historical locks never fall through to a reused numeric ID', async () => {
  const saved = {...a}; delete saved._fasheId;
  const h = harness({devices:[{...b, id:1}]}); await h.boot();
  h.context.loadPlanFromData({type:'daty_rf_planning', devices:[saved], constraints:{lockedAssignments:[{deviceId:1, frequencyKHz:622000}]}});
  assert.throws(() => h.context.DatyPlanningConstraints.readConstraintFields(), /原接收机通道尚未找到/);
  h.context.DATY_STATE.devices.push({...a, id:99});
  assert.equal(h.context.DatyPlanningConstraints.readConstraintFields().lockedAssignments[0].deviceId, 99);
});

test('identity matcher handles MAC enrichment, rejects conflicting MAC and preserves zero planned', async () => {
  const h = harness({devices:[{...a, receiver_mac:'AA:BB:CC:DD:EE:01', planned:620000}]}); await h.boot();
  assert.equal(h.context.findPlanningDevice({...a, _fasheId:undefined, id:55}).id, 1);
  assert.equal(h.context.findPlanningDevice({...a, receiver_mac:'AA:BB:CC:DD:EE:02'}), null);
  h.context.loadPlanFromData({type:'daty_rf_planning', devices:[a]});
  assert.equal(h.context.DATY_STATE.devices[0].planned, 0);
});

test('legacy manual matching works but never matches a different receiver by CH alone', async () => {
  const h = harness({devices:[{id:7, ch:'CH1', _source:'manual'}, a]}); await h.boot();
  assert.equal(h.context.findPlanningDevice({id:7, ch:'CH1'}).id, 7);
  assert.equal(h.context.findPlanningDevice({id:8, ch:'CH1'}), null);
});

test('real coordination run automatically saves constraints, result and run under current project', async () => {
  const h = harness(); await h.boot(); fill(h);
  h.context.runPlanning(); await h.flush();
  const record = h.history().records[0];
  assert.ok(record.coordination.assignments.length > 0);
  assert.equal(record.coordination.analysis.conflicts.length, 0);
  assert.equal(record.constraints.backupCount, 0);
  assert.equal(record.options.compatibilityLevel, 'robust');
  assert.equal(record.coordination.assignments.find(item => item.deviceId === 1).frequencyKHz, 620000);
  assert.deepEqual(h.api.runs[0].input.options, record.options);
  assert.deepEqual(h.api.runs[0].result, record.coordination);
  assert.equal(h.api.runs[0].project_id, 'default');
});

test('new browser restores server project and a legacy server-only constraints snapshot', async () => {
  const h = harness(); await h.boot(); fill(h); await h.context.saveCurrentPlanningConstraints();
  const restored = harness({api:h.api}); await restored.boot();
  assert.equal(restored.history().currentRecordId, h.history().currentRecordId);
  assert.equal(restored.elements.get('plannerBackupCount').value, '0');
  const old = harness({api:server([{id:'default', name:'剧场', devices:[a], data:{constraints:{backupCount:0,
    rangeStartKHz:500000, rangeEndKHz:510000, compatibilityLevel:'robust', excludedRanges:[{startKHz:501000, endKHz:502000}]}}}])});
  await old.boot();
  assert.equal(old.elements.get('plannerRange').value, '500000:510000');
  assert.equal(old.elements.get('plannerCompatibility').value, 'robust');
  assert.equal(old.elements.get('plannerBackupCount').value, '0');
  assert.equal(old.history().project.name, '剧场');
});

test('history load changes project; subsequent save does not leak to default or erase other project data', async () => {
  const api = server([{id:'show-A', name:'演出A', data:{venue:'A'}}]);
  const h = harness({api}); await h.boot();
  h.context.loadPlanFromData({type:'daty_rf_planning', projectId:'show-A', projectName:'演出A', devices:[]});
  await h.context.saveCurrentPlanningConstraints();
  assert.equal(api.writes[0].id, 'show-A');
  assert.equal(api.writes[0].data.venue, 'A');
  assert.ok(api.writes[0].data.planningHistory.every(item => item.projectId === 'show-A'));
  assert.equal(api.projects.has('default'), false);
});

test('network or application failure retains local history and never claims server success', async () => {
  for (const failure of [() => { throw new Error('offline'); }, () => response({success:false, error:'拒绝保存'})]) {
    const h = harness({fetch:async (url, init) => init?.method === 'POST' ? failure() : response({success:false}, 404)});
    await h.boot(); await h.context.saveCurrentPlanningConstraints();
    assert.equal(h.history().records.length, 1);
    assert.match(h.status(), /服务器未同步/);
    assert.equal(h.elements.get('savePlannerConstraints').disabled, false);
  }
});

test('invalid form, corrupt imports and full local storage do not mutate saved project', async () => {
  const h = harness(); await h.boot();
  h.edit('plannerExcludedRanges', '616-615'); await h.context.saveCurrentPlanningConstraints();
  assert.equal(h.history().records, undefined);
  h.edit('plannerExcludedRanges', ''); h.edit('plannerBackupCount', '5');
  await h.context.saveCurrentPlanningConstraints(); assert.equal(h.api.writes.length, 0);
  assert.equal(h.context.loadPlanFromData({type:'daty_rf_planning', devices:[], constraints:{excludedRanges:{bad:true}}}), false);
  h.context.localStorage.setItem = () => { throw new Error('QuotaExceeded'); };
  assert.equal(h.context.loadPlanFromData({type:'daty_rf_planning', projectId:'unwritten', devices:[]}), false);
  assert.equal(h.context.getCurrentPlanningProject().id, 'default');
});

test('late project response cannot overwrite edited form', async () => {
  let complete;
  const h = harness({fetch:() => new Promise(resolve => { complete = resolve; })});
  const boot = h.boot(); await new Promise(resolve => setImmediate(resolve));
  h.edit('plannerBackupCount', '2');
  complete(response({success:true, project:{id:'default', data:{constraints:{backupCount:0}}}}));
  await boot;
  assert.equal(h.elements.get('plannerBackupCount').value, '2');
  assert.equal(h.history().records, undefined);
  assert.match(h.status(), /未保存/);
});

test('late save response cannot erase unsaved changes status', async () => {
  const api = server(); let complete;
  const h = harness({api, fetch:(url, init) => init?.method === 'POST'
    ? new Promise(resolve => { complete = () => resolve(api.fetch(url, init)); }) : api.fetch(url, init)});
  await h.boot(); const saving = h.context.saveCurrentPlanningConstraints();
  await new Promise(resolve => setImmediate(resolve));
  h.edit('plannerBackupCount', '2'); complete(); await saving;
  assert.match(h.status(), /未保存/);
  assert.equal(h.history().records[0].constraints.backupCount, 1);
});

test('delete current history persists null selection and never resurrects old constraints', async () => {
  const h = harness(); await h.boot(); fill(h); await h.context.saveCurrentPlanningConstraints();
  h.edit('plannerBackupCount', '2'); await h.context.saveCurrentPlanningConstraints();
  await h.context.deleteHistory(0); await h.flush();
  assert.equal(h.history().currentRecordId, null);
  assert.equal(h.api.projects.get('default').data.currentPlanningRecordId, null);
  assert.equal(h.api.projects.get('default').data.constraints, undefined);
  const restored = harness({api:h.api}); await restored.boot();
  assert.equal(restored.history().records.length, 1);
  assert.equal(restored.history().currentRecordId, null);
  assert.equal(restored.elements.get('plannerExcludedRanges').value, '');
});

test('JSON export includes constraints and stable identity, without changing current project', async () => {
  const h = harness(); await h.boot(); fill(h); await h.context.saveCurrentPlanningConstraints();
  const saved = h.history().records[0]; await h.context.exportHistory(saved.id);
  const exported = JSON.parse(await h.downloads[0].text());
  assert.deepEqual(exported, saved);
  assert.equal(h.history().currentRecordId, saved.id);
});

test('saving constraint-only project works without connected devices or a scan', async () => {
  const h = harness({devices:[]}); await h.boot();
  h.edit('plannerRange', 'scan'); h.edit('plannerBackupCount', '0');
  await h.context.saveCurrentPlanningConstraints();
  assert.equal(h.history().records[0].devices.length, 0);
  assert.equal(h.history().records[0].constraintFields.plannerRange, 'scan');
  assert.match(h.status(), /已保存到当前项目/);
});

test('history locks without receiver identity are rejected instead of matching a reused ID', async () => {
  const h = harness(); await h.boot();
  h.context.loadPlanFromData({type:'daty_rf_planning', devices:[], constraints:{lockedAssignments:[{deviceId:1, frequencyKHz:622000}]}});
  assert.throws(() => h.context.DatyPlanningConstraints.readConstraintFields(), /原接收机通道尚未找到/);
});

test('serialized server writes preserve newest snapshot and recover after an earlier failure', async () => {
  const api = server(); let release;
  let posts = 0;
  const h = harness({api, fetch:(url, init) => {
    if (init?.method === 'POST' && ++posts === 1) return new Promise(resolve => { release = () => resolve(response({success:false, error:'first save failed'}, 500)); });
    return api.fetch(url, init);
  }});
  await h.boot();
  const first = h.context.savePlanningResult([], null, {backupCount:0});
  const failed = h.context.persistPlanningProject(first).catch(error => error.message);
  const second = h.context.savePlanningResult([], null, {backupCount:2});
  const saved = h.context.persistPlanningProject(second);
  await new Promise(resolve => setImmediate(resolve)); release();
  assert.equal(await failed, 'first save failed'); await saved;
  assert.equal(api.writes.length, 1);
  assert.equal(api.writes[0].data.currentPlanningRecordId, second.id);
  assert.equal(api.writes[0].data.constraints.backupCount, 2);
  assert.equal(api.writes[0].data.planningHistory.length, 2);
});

test('disabled server persistence is explicitly reported as local-only', async () => {
  const h = harness(); await h.boot(); h.context.DATY_DISABLE_SERVER_PERSISTENCE = true;
  await h.context.saveCurrentPlanningConstraints();
  assert.equal(h.history().records.length, 1);
  assert.equal(h.api.writes.length, 0);
  assert.match(h.status(), /服务器未同步/);
});

test('save preserves remote history that was not loaded before local editing', async () => {
  const remote = {id:'remote-only', type:'daty_rf_planning', projectId:'default', devices:[], constraints:{backupCount:0}};
  const api = server([{id:'default', name:'默认项目', data:{planningHistory:[remote], currentPlanningRecordId:remote.id}}]);
  const h = harness({api}); // Save before startup restoration, as with an edited/slow-loading browser.
  await h.context.saveCurrentPlanningConstraints();
  assert.equal(api.writes[0].data.planningHistory.length, 2);
  assert.deepEqual(api.writes[0].data.planningHistory[1], remote);
});

test('offline history deletion stays deleted on reload and on the next server save', async () => {
  const h = harness(); await h.boot(); await h.context.saveCurrentPlanningConstraints();
  const deletedId = h.history().currentRecordId;
  h.context.DATY_DISABLE_SERVER_PERSISTENCE = true;
  await h.context.deleteHistory(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.history().deletedRecordIds, [deletedId]);
  const reload = harness({api:h.api, values:h.values}); await reload.boot();
  assert.equal(reload.history().records.length, 0);
  await reload.context.saveCurrentPlanningConstraints();
  assert.equal(h.api.projects.get('default').data.planningHistory.some(item => item.id === deletedId), false);
});

function pagedHistory(count) {
  const records=Array.from({length:count},(_,i)=>({id:`history-${i}`,type:'daty_rf_planning',projectId:'default',
    name:`计划 ${i}`,date:'2026-09-11',time:'2026/9/11 12:00:00',devices:[],constraints:{backupCount:i%3}}));
  const values=new Map([[KEY,JSON.stringify({project:{id:'default',name:'默认项目'},currentRecordId:null,records})]]);
  return {h:harness({values}),records};
}
function historyRows(h) {
  return [...h.elements.get('historyBody').innerHTML.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m=>({html:m[1],
    actions:[...m[1].matchAll(/onclick="([^"]+)"/g)].map(a=>a[1].replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&'))}));
}

test('planning history uses 20-row pages at zero/exact/partial boundaries without changing stored records',()=>{
  for(const count of [0,1,20,21,40,41,205]) {
    const {h,records}=pagedHistory(count),before=h.values.get(KEY);h.context.renderHistory();
    assert.equal(h.elements.get('historyPagination').hidden,count===0);
    assert.equal(h.elements.get('historyPrevPage').disabled,true);
    assert.equal(h.elements.get('historyNextPage').disabled,count<=20);
    if(count){
      const actual=[];h.context.loadHistory=id=>actual.push(id);
      do {
        const rows=historyRows(h);assert.ok(rows.length<=20);
        rows.forEach(row=>vm.runInContext(row.actions[0],h.context));
        if(h.elements.get('historyNextPage').disabled)break;
        h.context.changePlanningHistoryPage(1);
      }while(actual.length<=count);
      assert.deepEqual(actual,records.map(r=>r.id));
      assert.match(h.elements.get('historyPageInfo').textContent,/每页 20 条/);
    }
    assert.equal(h.values.get(KEY),before);assert.equal(h.api.writes.length,0);
  }
});

test('second-page load and export target that record, including full saved constraints',async()=>{
  const {h,records}=pagedHistory(41);h.context.renderHistory();h.context.changePlanningHistoryPage(1);
  const row=historyRows(h)[0];
  await vm.runInContext(row.actions[1],h.context);
  assert.equal(JSON.parse(await h.downloads[0].text()).id,records[20].id);
  await vm.runInContext(row.actions[0],h.context);
  assert.equal(h.context.getCurrentPlanningRecord().id,records[20].id);
  assert.equal(h.elements.get('plannerBackupCount').value,String(records[20].constraints.backupCount));
  assert.equal(h.api.writes.length,0);
});

test('delete on a later page removes only its record and clamps an emptied last page',async()=>{
  const {h,records}=pagedHistory(41);h.context.renderHistory();h.context.changePlanningHistoryPage(2);
  await vm.runInContext(historyRows(h)[0].actions[2],h.context);await h.flush();
  assert.deepEqual(h.history().records.map(r=>r.id),records.slice(0,40).map(r=>r.id));
  assert.deepEqual(h.history().deletedRecordIds,[records[40].id]);
  assert.match(h.elements.get('historyPageInfo').textContent,/第 2\/2 页/);
  assert.equal(historyRows(h).length,20);
  assert.equal(h.elements.get('historyNextPage').disabled,true);
});

test('captured second-page delete action remains bound to its ID after a new record is inserted',async()=>{
  const {h,records}=pagedHistory(41);h.context.renderHistory();h.context.changePlanningHistoryPage(1);
  const action=historyRows(h)[0].actions[2];
  const added=h.context.savePlanningResult([],null,{backupCount:0});
  await vm.runInContext(action,h.context);await h.flush();
  assert.ok(h.history().records.some(r=>r.id===added.id));
  assert.ok(h.history().records.some(r=>r.id===records[19].id));
  assert.ok(!h.history().records.some(r=>r.id===records[20].id));
});

test('paged delete still requires confirmation and missing IDs never fall back to a row number',()=>{
  const {h}=pagedHistory(21),before=h.values.get(KEY);h.context.renderHistory();h.context.changePlanningHistoryPage(1);
  h.context.confirm=()=>false;vm.runInContext(historyRows(h)[0].actions[2],h.context);
  assert.equal(h.values.get(KEY),before);
  h.context.confirm=()=>true;h.context.deleteHistoryById('missing');
  assert.equal(h.values.get(KEY),before);assert.equal(h.api.writes.length,0);
});

test('history cells preserve full escaped text, current marker and special-character record IDs',()=>{
  const record={id:'record-"\'<&',type:'daty_rf_planning',name:'演出 <A> "长名称" '+ '节目安排'.repeat(50),devices:[],algo:'算法 <A>',constraints:{backupCount:0}};
  const h=harness({values:new Map([[KEY,JSON.stringify({records:[record],currentRecordId:record.id})]])});
  h.context.renderHistory();const row=historyRows(h)[0],clicked=[];
  h.context.loadHistory=id=>clicked.push(id);h.context.exportHistory=id=>clicked.push(id);h.context.deleteHistoryById=id=>clicked.push(id);
  row.actions.forEach(action=>vm.runInContext(action,h.context));assert.deepEqual(clicked,[record.id,record.id,record.id]);
  assert.ok(row.html.includes('title="演出 &lt;A&gt; &quot;长名称&quot;'));
  assert.ok(row.html.includes('title="算法 &lt;A&gt;"'));assert.match(row.html,/>当前<\/span>/);
  assert.equal(h.history().records[0].name,record.name);
});


test('history actions require async app confirmation; native missing/boolean confirmation cannot fall back',async()=>{
 for(const dialogs of [undefined,{confirm:()=>true},{confirm:async()=>false}]) {
  const {h}=pagedHistory(2),before=h.values.get(KEY);h.context.DatyDialogs=dialogs;
  h.context.confirm=()=>{throw Error('Browser dialog forbidden');};
  assert.equal(await h.context.deleteHistory(0),false);assert.equal(await h.context.loadHistory('history-0',true),false);
  assert.equal(await h.context.exportHistory('history-0'),false);assert.equal(h.values.get(KEY),before);assert.equal(h.downloads.length,0);
 }
});
test('history dialog cancellation, single active action and stale targets never mutate data',async()=>{
 for(const action of ['load','export','delete']) {
  const {h}=pagedHistory(2);let decide;const calls=[];
  h.context.DatyDialogs={confirm:options=>{calls.push(clone(options));return new Promise(resolve=>decide=resolve);}};
  const invoke=()=>action==='load'?h.context.loadHistory('history-0',true):action==='export'?h.context.exportHistory('history-0'):h.context.deleteHistory(0);
  const first=invoke();assert.equal(await invoke(),false);assert.equal(calls.length,1);assert.equal(calls[0].details[0].value,'计划 0');
  const before=h.values.get(KEY);decide(false);assert.equal(await first,false);assert.equal(h.values.get(KEY),before);
  const stale=invoke();h.context.savePlanningResult([],null,{backupCount:0});const changed=h.values.get(KEY);
  decide(true);assert.equal(await stale,false);assert.equal(h.values.get(KEY),changed);assert.equal(h.downloads.length,0);
 }
});
test('confirmation rechecks the record contents and unsaved planner fields, not just the row ID',async()=>{
 for(const change of ['record','fields','bridge']) {
  const {h}=pagedHistory(2);let decide;h.context.DatyDialogs={confirm:()=>new Promise(resolve=>decide=resolve)};
  const result=h.context.loadHistory('history-0',true);
  if(change==='record')vm.runInContext('HISTORY[0].name="changed"',h.context);
  if(change==='fields')h.elements.get('plannerBackupCount').value='9';
  if(change==='bridge')h.elements.get('fasheApiUrl').value='https://other.invalid:8802';
  const before=h.values.get(KEY);decide(true);assert.equal(await result,false);assert.equal(h.values.get(KEY),before);
 }
});
test('confirmed delete rolls back on local write failure; missing row load never opens a chooser',async()=>{
 const {h}=pagedHistory(2);const before=h.values.get(KEY);
 h.context.DatyPlatform.storage.setItem=()=>{throw Error('disk full');};
 assert.equal(await h.context.deleteHistory(0),false);assert.equal(h.values.get(KEY),before);
 assert.equal(vm.runInContext('HISTORY.length',h.context),2);assert.equal(vm.runInContext('planningHistoryDeletedIds.size',h.context),0);
 h.context.DatyTextFileFactory={openLatest(){throw Error('Unexpected chooser');}};
 assert.equal(await h.context.loadHistory('missing',true),false);
});
test('export differentiates browser download initiation from native save and file cancellation',async()=>{
 const {h}=pagedHistory(1);assert.equal(await h.context.exportHistory('history-0'),true);assert.equal(h.notices.at(-1)[1],'已开始下载');
 h.context.DatyPlatform.kind='native';let calls=0;
 h.context.DatyTextExports={VERSION:'daty-text-export-v1',async saveText(){calls++;return {status:'cancelled'};}};
 const notices=h.notices.length;assert.equal(await h.context.exportHistory('history-0'),false);assert.equal(h.notices.length,notices);
 h.context.DatyTextExports.saveText=async()=>({status:'saved'});assert.equal(await h.context.exportHistory('history-0'),true);assert.equal(h.notices.at(-1)[1],'文件已保存');assert.equal(calls,1);
});
