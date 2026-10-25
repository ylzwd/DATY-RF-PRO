// Pure snapshot/CAS preparation only. No running Bridge, browser storage or HTTP.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const factory = require('../src/platform/project-concurrency.js');
const api = factory.create();
const clone = value => JSON.parse(JSON.stringify(value));
const record = (id, extra = {}) => ({id, projectId:'default', devices:[], constraints:{backupCount:1}, ...extra});
const base = (extra = {}) => ({id:'default', name:'默认项目', revision:1,
  revision_protocol:factory.PROTOCOL, devices:[], data:{planningHistory:[],
    deletedRecordIds:[], currentPlanningRecordId:null}, ...extra});
const ready = input => { const result = api.prepareSave(input); assert.equal(result.status,'ready'); return result; };
const codes = result => result.conflicts.map(item => item.code);

test('factory import and native factory load perform no I/O', () => {
  const fail = () => { throw new Error('unexpected host access'); };
  const root = {fetch:fail, document:new Proxy({}, {get:fail}), localStorage:new Proxy({}, {get:fail}),
    setTimeout:fail, Date:class { constructor() { fail(); } }};
  vm.createContext(root);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/platform/project-concurrency.js'),'utf8'),root);
  assert.equal(root.DatyProjectConcurrencyFactory.create().PROTOCOL, 'daty-project-revision-v1');
  assert.equal(Object.isFrozen(factory), true);
  assert.equal(Object.isFrozen(api), true);
});

test('unchanged snapshots prepare exact conditional write without adding control fields', () => {
  const original=base(), before=JSON.stringify(original);
  const result=ready({base:original,desired:original,remote:original});
  assert.equal(result.body.expected_revision,1);
  assert.deepEqual(Object.keys(result.body).sort(),['data','devices','expected_revision','id','name']);
  assert.equal(JSON.stringify(original),before);
  result.body.data.deletedRecordIds.push('isolated');
  assert.deepEqual(original.data.deletedRecordIds,[]);
});

test('identical concurrent changes are accepted once as the same desired snapshot', () => {
  const original=base(), desired=clone(original), remote=clone(original);
  desired.name='相同名字'; desired.data.extra={value:2};
  Object.assign(remote,clone(desired),{revision:2});
  const result=ready({base:original,desired,remote});
  assert.equal(result.body.name,'相同名字');
  assert.deepEqual(result.body.data.extra,{value:2});
  assert.equal(result.body.expected_revision,2);
});

test('independent immutable history IDs merge without dropping either client record', () => {
  const original=base(), desired=clone(original), remote=clone(original);
  desired.data.planningHistory=[record('local')];
  remote.revision=2; remote.data.planningHistory=[record('remote')];
  assert.deepEqual(ready({base:original,desired,remote}).body.data.planningHistory.map(item=>item.id),['local','remote']);
});

test('same history ID with different content is explicit conflict, including one-sided mutation', () => {
  for (const preexisting of [false,true]) {
    const original=base(); if(preexisting)original.data.planningHistory=[record('same')];
    const desired=clone(original),remote=clone(original);remote.revision=2;
    desired.data.planningHistory=[record('same',{name:'local'})];
    remote.data.planningHistory=[record('same')];
    const result=api.prepareSave({base:original,desired,remote});
    assert.equal(result.status,'conflict');
    assert.ok(codes(result).includes('HISTORY_ID_CONTENT_CONFLICT'));
    assert.equal(result.body,undefined);
  }
});

test('same history content in different JSON property order is not a conflict', () => {
  const original=base(),desired=clone(original),remote=clone(original);remote.revision=2;
  desired.data.planningHistory=[record('same')];
  remote.data.planningHistory=[{constraints:{backupCount:1},devices:[],projectId:'default',id:'same'}];
  assert.equal(ready({base:original,desired,remote}).body.data.planningHistory.length,1);
});

test('remote tombstone wins over stale local history and cannot be removed', () => {
  const original=base();original.data.planningHistory=[record('old')];
  const desired=clone(original),remote=clone(original);remote.revision=2;
  remote.data.planningHistory=[];remote.data.deletedRecordIds=['old'];
  const first=ready({base:original,desired,remote});
  assert.deepEqual(first.body.data.planningHistory,[]);
  assert.deepEqual(first.body.data.deletedRecordIds,['old']);
  const nextBase={...clone(first.body),revision:2,revision_protocol:factory.PROTOCOL};
  const resurrect=clone(nextBase);resurrect.data.deletedRecordIds=[];resurrect.data.planningHistory=[record('old')];
  const second=ready({base:nextBase,desired:resurrect,remote:nextBase});
  assert.deepEqual(second.body.data.planningHistory,[]);
  assert.deepEqual(second.body.data.deletedRecordIds,['old']);
});

test('local tombstones and remote tombstones union while preserving unrelated new history', () => {
  const original=base();original.data.planningHistory=[record('a'),record('b')];
  const desired=clone(original),remote=clone(original);remote.revision=2;
  desired.data.planningHistory=[record('b')];desired.data.deletedRecordIds=['a'];
  remote.data.planningHistory=[record('a'),record('new')];remote.data.deletedRecordIds=['b'];
  const result=ready({base:original,desired,remote});
  assert.deepEqual(result.body.data.deletedRecordIds,['a','b']);
  assert.deepEqual(result.body.data.planningHistory.map(item=>item.id),['new']);
});

test('history absence without a deletion tombstone cannot silently delete or resurrect', () => {
  const original=base();original.data.planningHistory=[record('old')];
  const desired=clone(original),remote=clone(original);remote.revision=2;remote.data.planningHistory=[];
  const result=api.prepareSave({base:original,desired,remote});
  assert.ok(codes(result).includes('HISTORY_REMOVAL_REQUIRES_TOMBSTONE'));
  assert.equal(result.body,undefined);
});

test('deletion of the selected history requires explicit atomic snapshot resolution', () => {
  const original=base();original.data.planningHistory=[record('old')];original.data.currentPlanningRecordId='old';
  original.data.constraints={backupCount:1};
  const desired=clone(original),remote=clone(original);remote.revision=2;
  remote.data.deletedRecordIds=['old'];remote.data.planningHistory=[];
  const result=api.prepareSave({base:original,desired,remote});
  assert.ok(codes(result).includes('SELECTED_RECORD_DELETED'));
  assert.equal(result.body,undefined);
  assert.equal(desired.data.currentPlanningRecordId,'old');
});

test('planning constraints, fields, current selection and devices are one atomic snapshot', () => {
  const original=base();original.data.constraints={backupCount:1};original.data.constraintFields={text:'1'};
  const desired=clone(original),remote=clone(original);remote.revision=2;
  desired.data.constraints.backupCount=2;
  remote.devices=[{id:'other',freq:641250}];
  const result=api.prepareSave({base:original,desired,remote});
  assert.deepEqual(codes(result),['PLANNING_SNAPSHOT_CONFLICT']);
  assert.equal(result.body,undefined);
});

test('last coordination time participates in atomic planning snapshot', () => {
  const original=base(),desired=clone(original),remote=clone(original);remote.revision=2;
  desired.data.constraints={backupCount:2};remote.data.last_coordination_at='2026-09-13T00:00:00Z';
  assert.ok(codes(api.prepareSave({base:original,desired,remote})).includes('PLANNING_SNAPSHOT_CONFLICT'));
});

test('identical concurrent complete planning snapshots merge as one snapshot', () => {
  const original=base(),desired=clone(original);
  desired.data.planningHistory=[record('both')];desired.data.currentPlanningRecordId='both';
  desired.data.constraints={backupCount:3};desired.data.constraintFields={text:'3'};
  desired.devices=[{id:'rx_ch1',freq:641250}];
  const remote={...clone(desired),revision:2};
  const result=ready({base:original,desired,remote});
  assert.deepEqual(result.body.devices,desired.devices);
  assert.deepEqual(result.body.data,desired.data);
});

test('new deletion conflicts with an independent edit instead of silently losing it', () => {
  for(const deletingSide of ['desired','remote']) {
    const original=base();original.data.planningHistory=[record('deleted')];
    const desired=clone(original),remote=clone(original);remote.revision=2;
    const deleting=deletingSide==='desired'?desired:remote;
    const editing=deletingSide==='desired'?remote:desired;
    deleting.data.planningHistory=[];deleting.data.deletedRecordIds=['deleted'];
    editing.data.planningHistory=[record('deleted',{name:'independent-edited-content'})];
    const before=JSON.stringify({original,desired,remote});
    const result=api.prepareSave({base:original,desired,remote});
    assert.deepEqual(result.conflicts,[{code:'HISTORY_DELETE_EDIT_CONFLICT',path:'/data/planningHistory',recordId:'deleted'}]);
    assert.equal(result.body,undefined);
    assert.equal(JSON.stringify({original,desired,remote}),before);
  }
});

test('new tombstone conflicts with the other client newly adding that same ID', () => {
  for(const deletingSide of ['desired','remote']) {
    const original=base(),desired=clone(original),remote=clone(original);remote.revision=2;
    const deleting=deletingSide==='desired'?desired:remote;
    const adding=deletingSide==='desired'?remote:desired;
    deleting.data.deletedRecordIds=['simultaneous'];adding.data.planningHistory=[record('simultaneous')];
    const result=api.prepareSave({base:original,desired,remote});
    assert.ok(codes(result).includes('HISTORY_DELETE_EDIT_CONFLICT'));
    assert.equal(result.body,undefined);
  }
});

test('mutual explicit tombstones delete even if obsolete cached bodies still differ', () => {
  const original=base();original.data.planningHistory=[record('deleted')];
  const desired=clone(original),remote=clone(original);remote.revision=2;
  desired.data.deletedRecordIds=['deleted'];remote.data.deletedRecordIds=['deleted'];
  desired.data.planningHistory=[record('deleted',{name:'obsolete-local'})];
  remote.data.planningHistory=[record('deleted',{name:'obsolete-remote'})];
  const result=ready({base:original,desired,remote});
  assert.deepEqual(result.body.data.planningHistory,[]);
  assert.deepEqual(result.body.data.deletedRecordIds,['deleted']);
});

test('baseline tombstone prevents revival and does not conflict with differing older caches', () => {
  const original=base();original.data.deletedRecordIds=['long-deleted'];
  const desired=clone(original),remote=clone(original);remote.revision=2;
  desired.data.deletedRecordIds=[];remote.data.deletedRecordIds=[];
  desired.data.planningHistory=[record('long-deleted',{name:'very-old-local'})];
  remote.data.planningHistory=[record('long-deleted',{name:'different-old-remote'})];
  const result=ready({base:original,desired,remote});
  assert.deepEqual(result.body.data.planningHistory,[]);
  assert.deepEqual(result.body.data.deletedRecordIds,['long-deleted']);
});

test('one-sided complete planning snapshot change is retained intact', () => {
  const original=base(),desired=clone(original),remote=clone(original);remote.revision=2;
  desired.data.planningHistory=[record('new')];desired.data.currentPlanningRecordId='new';
  desired.data.constraints={backupCount:2};desired.data.constraintFields={text:'2'};
  desired.devices=[{id:'rx_ch1',freq:641000}];remote.data.venue='新增远程字段';
  const result=ready({base:original,desired,remote});
  assert.equal(result.body.data.currentPlanningRecordId,'new');
  assert.deepEqual(result.body.data.constraints,desired.data.constraints);
  assert.deepEqual(result.body.data.constraintFields,desired.data.constraintFields);
  assert.deepEqual(result.body.devices,desired.devices);
  assert.equal(result.body.data.venue,'新增远程字段');
});

test('unknown nested fields merge only when individual changes do not conflict', () => {
  const original=base();original.data.vendor={a:1,b:1,retained:['x']};
  const desired=clone(original),remote=clone(original);remote.revision=2;
  desired.data.vendor.a=2;remote.data.vendor.b=3;remote.data.future={enabled:false};
  assert.deepEqual(ready({base:original,desired,remote}).body.data.vendor,{a:2,b:3,retained:['x']});
  assert.deepEqual(ready({base:original,desired,remote}).body.data.future,{enabled:false});
  remote.data.vendor.a=4;
  assert.deepEqual(api.prepareSave({base:original,desired,remote}).conflicts,
    [{code:'FIELD_CONFLICT',path:'/data/vendor/a'}]);
});

test('ordinary explicit deletion conflicts with an independent edit of the same field', () => {
  const original=base();original.data.note='before';
  const desired=clone(original),remote=clone(original);remote.revision=2;
  delete desired.data.note;remote.data.note='remote';
  assert.ok(codes(api.prepareSave({base:original,desired,remote})).includes('FIELD_CONFLICT'));
  remote.data.note='before';
  assert.equal(Object.hasOwn(ready({base:original,desired,remote}).body.data,'note'),false);
});

test('revision capability is mandatory; old server has no prepared write', () => {
  const original=base(),remote=clone(original);delete remote.revision_protocol;
  for(const protocol of [undefined,'old',null]) {
    const result=api.prepareSave({base:original,desired:original,remote,protocol});
    assert.deepEqual(result,{status:'unsupported',code:'PROJECT_REVISION_UNSUPPORTED'});
  }
  assert.equal(ready({base:original,desired:original,remote,protocol:factory.PROTOCOL}).body.expected_revision,1);
});

test('invalid revision values are rejected rather than coerced', () => {
  for(const value of [undefined,null,true,false,0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1,NaN,Infinity]) {
    const original=base(),remote=clone(original);remote.revision=value;
    assert.throws(()=>api.prepareSave({base:original,desired:original,remote}),factory.ProjectConcurrencyError);
  }
});

test('same revision with changed content or a lower restored revision is not trusted', () => {
  const original=base(),remote=clone(original);remote.data.unknown='changed';
  assert.deepEqual(codes(api.prepareSave({base:original,desired:original,remote})),['REVISION_CONTENT_MISMATCH']);
  original.revision=3;remote.revision=2;
  assert.deepEqual(codes(api.prepareSave({base:original,desired:original,remote})),['PROJECT_REVISION_ROLLBACK']);
});

test('new project uses create-only zero revision and creation collisions are explicit', () => {
  const desired=base();delete desired.revision;delete desired.revision_protocol;
  assert.equal(ready({base:null,desired,remote:null,protocol:factory.PROTOCOL}).body.expected_revision,0);
  assert.deepEqual(codes(api.prepareSave({base:null,desired,remote:base()})),['PROJECT_ALREADY_EXISTS']);
  assert.deepEqual(codes(api.prepareSave({base:base(),desired,remote:null,protocol:factory.PROTOCOL})),['PROJECT_REMOVED']);
});

test('exhausted safe integer revision never prepares an overflowing next write', () => {
  const original=base({revision:Number.MAX_SAFE_INTEGER});
  assert.deepEqual(codes(api.prepareSave({base:original,desired:original,remote:original})),['PROJECT_REVISION_EXHAUSTED']);
});

test('cross project identity, duplicate IDs and malformed tombstones are rejected', () => {
  const original=base(),remote=base({id:'other'});
  assert.throws(()=>api.mergeProject({base:original,desired:original,remote}),/同一项目/);
  for(const data of [
    {planningHistory:[record('same'),record('same')]},
    {planningHistory:[{id:'other',projectId:'elsewhere'}]},
    {planningHistory:[{id:''}]}, {deletedRecordIds:[null]}, {deletedRecordIds:{}}
  ]) {
    assert.throws(()=>api.mergeProject({base:null,desired:base({data}),remote:null}),factory.ProjectConcurrencyError);
  }
});

test('selected missing record is explicit conflict rather than a fabricated planning state', () => {
  const original=base(),desired=clone(original);desired.data.currentPlanningRecordId='missing';
  assert.deepEqual(codes(api.mergeProject({base:original,desired,remote:original})),['SELECTED_RECORD_MISSING']);
});

test('prototype-shaped JSON keys are preserved without mutating object prototypes', () => {
  const original=base();original.data.extra=JSON.parse('{"__proto__":{"safe":1},"constructor":{"a":1}}');
  const desired=clone(original),remote=clone(original);remote.revision=2;
  desired.data.extra.constructor.a=2;remote.data.extra.__proto__.safe=3;
  const result=ready({base:original,desired,remote});
  assert.equal(Object.getPrototypeOf(result.body.data.extra),Object.prototype);
  assert.equal(Object.hasOwn(result.body.data.extra,'__proto__'),true);
  assert.deepEqual(result.body.data.extra.__proto__,{safe:3});
  assert.equal(Object.prototype.safe,undefined);
});

test('accessors and non-JSON values are rejected without invoking getters', () => {
  const original=base();let invoked=0;
  Object.defineProperty(original.data,'trap',{enumerable:true,get(){invoked++;throw new Error('must not execute');}});
  assert.throws(()=>api.mergeProject({base:null,desired:original,remote:null}),factory.ProjectConcurrencyError);
  assert.equal(invoked,0);
  const cyclic=base();cyclic.data.cycle=cyclic;
  assert.throws(()=>api.mergeProject({base:null,desired:cyclic,remote:null}),factory.ProjectConcurrencyError);
});

test('lone surrogate values and keys are rejected while valid Unicode pairs remain unchanged', () => {
  for(const value of ['\ud800','\udfff']) {
    const desired=base();desired.data.text=value;
    assert.throws(()=>api.mergeProject({base:null,desired,remote:null}),factory.ProjectConcurrencyError);
    delete desired.data.text;desired.data[value]='value';
    assert.throws(()=>api.mergeProject({base:null,desired,remote:null}),factory.ProjectConcurrencyError);
  }
  const desired=base();desired.data.text='麦克🎤';
  assert.equal(ready({base:null,desired,remote:null,protocol:factory.PROTOCOL}).body.data.text,'麦克🎤');
});

test('malformed or duplicate device IDs cannot produce a server write body', () => {
  for(const devices of [[null],[{}],[{id:true}],[{id:1.1}],[{id:' '}],[{id:1},{id:'1'}]]) {
    assert.throws(()=>api.prepareSave({base:null,desired:base({devices}),remote:null,protocol:factory.PROTOCOL}),factory.ProjectConcurrencyError);
  }
});
