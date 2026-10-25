// Candidate UI adapter replay. Original storage/render/planning-ui in a fresh VM,
// in-memory CAS server/authorization only. No live network or business storage.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{randomUUID}=require('node:crypto');
const ROOT=path.join(__dirname,'..'),KEY='daty_planning_history_v1',PROTOCOL='daty-project-revision-v1';
const clone=x=>JSON.parse(JSON.stringify(x));
const record=(id,backup=1)=>({id,type:'daty_rf_planning',projectId:'default',projectName:'默认项目',name:id,devices:[],
  timestamp:1000,options:{backupCount:backup},constraints:{backupCount:backup}});
const project=(selected=null,records=[])=>({id:'default',name:'默认项目',revision:1,revision_protocol:PROTOCOL,devices:[],
  data:{planningHistory:records,deletedRecordIds:[],currentPlanningRecordId:selected?.id||null,
    ...(selected?{constraints:selected.options}:{}),future:{retained:true}}});
const response=(body,status=200)=>({status,ok:status>=200&&status<300,json:async()=>clone(body)});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(t,{localRecord=null,localRecords,remote=project(),mount=true,values:initial={}}={}){
  const values=new Map(Object.entries(initial)),events=new Map(),elements=new Map(),notices=[],calls=[],listeners=new Set();
  if(localRecord||localRecords)values.set(KEY,JSON.stringify({project:{id:'default',name:'默认项目'},currentRecordId:localRecord?.id||null,
    records:localRecords||[localRecord],deletedRecordIds:[]}));
  const storage={getItem:key=>values.get(key)??null,setItem(key,value){if(storage.fail===key)throw new Error('fixture quota');values.set(key,String(value));},removeItem:key=>values.delete(key)};
  const element=(value='')=>({value,innerHTML:'',textContent:'',style:{},disabled:false,options:[],handlers:new Map(),classList:{contains:()=>false},
    addEventListener(name,fn){this.handlers.set(name,fn);},appendChild(item){this.options.push(item);},remove(){},click(){}});
  for(const [id,value]of Object.entries({fasheApiUrl:'https://127.0.0.1:8802',plannerBackupCount:'1',plannerRange:'640000:690000',
    plannerCompatibility:'standard',plannerExcludedRanges:'',plannerLockedAssignments:'',plannerKnownCarriers:'',plannerRangeStart:'640',plannerRangeEnd:'690',
    plannerStepKHz:'25',plannerMinSpacingKHz:'',plannerImdSpacingKHz:'',plannerImdPolicy:'third-fifth',plannerScanThresholdDbm:'',
    plannerConstraintSaveStatus:'',planningHistorySaveStatus:'',planningHistoryProject:'',savePlannerConstraints:'',historyBody:'',freqTableBody:'',planResultContent:''})){
    elements.set(id,element(value));
  }
  elements.get('plannerRange').options=['640000:690000','614250:638000'].map(value=>({value}));
  let stored=remote&&clone(remote),interceptor=null,confirmResult=true,permission=true,auth={origin:'https://127.0.0.1:8802',revision:1};
  const rawRequest=async(url,init={})=>{
    const call={url,method:init.method||'GET',body:init.body&&JSON.parse(init.body)};calls.push(call);
    if(interceptor){const answer=await interceptor(call,init);if(answer!==undefined)return answer;}
    const endpoint=new URL(url).pathname;
    if(call.method==='GET'&&endpoint.startsWith('/api/projects/'))return stored?
      response({success:true,project:stored,revision_protocol:PROTOCOL}):response({success:false,revision_protocol:PROTOCOL},404);
    if(call.method==='POST'&&endpoint==='/api/projects'){
      const body=call.body,expected=stored?.revision||0;
      if(body.expected_revision!==expected)return response({success:false,code:'PROJECT_REVISION_CONFLICT'},409);
      stored={...clone(body),revision:expected+1,revision_protocol:PROTOCOL};delete stored.expected_revision;
      return response({success:true,project_id:body.id,revision:stored.revision,revision_protocol:PROTOCOL});
    }
    if(call.method==='POST'&&endpoint==='/api/coordination-runs')return response({success:true,run_id:'fixture-run',project_id:call.body.project_id});
    throw new Error('Unexpected candidate request '+endpoint);
  };
  const c=vm.createContext({DatyPlatform:{VERSION:'1.0.0',kind:'native-fixture',request:rawRequest,storage,downloadText(){},openEventStream(){throw new Error('No SSE');}},
    document:{readyState:'loading',getElementById:id=>elements.get(id)||null,createElement:()=>element(),body:element(),
      addEventListener(name,fn){events.set('doc:'+name,[...events.get('doc:'+name)||[],fn]);}},
    console:{warn(){},error(){},log(){}},setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},requestAnimationFrame:()=>1,
    addEventListener(name,fn){events.set(name,[...events.get(name)||[],fn]);},removeEventListener(){},notify:(...args)=>notices.push(args),
    URL,AbortController,AbortSignal,Date,crypto:{randomUUID},performance});
  c.window=c;
  function load(relative){vm.runInContext(fs.readFileSync(path.join(ROOT,relative),'utf8'),c,{filename:relative});}
  load('src/platform/browser-platform.js');
  c.DatyHostRuntime={VERSION:'daty-host-runtime-v1',setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},nowEpochMs:Date.now,nowMonotonicMs:()=>performance.now()};
  for(const name of ['frequency','equipment-profiles','coordination','storage','render','planning-ui'])load('src/modules/'+name+'.js');
  c.DatyAccess={snapshot:()=>clone(auth),subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},assertPermission(scope){
    assert.equal(scope,'project.write');if(!permission)throw Object.assign(new Error('fixture permission denied'),{code:'FORBIDDEN'});return clone(auth);}};
  c.DatyDialogs={confirm:async options=>{notices.push(['confirm',options]);return typeof confirmResult==='function'?confirmResult(options):confirmResult;}};
  load('src/platform/project-concurrency.js');load('src/platform/project-sync.js');
  const original=c.persistPlanningProject,originalInit=c.initDatabase;
  load('src/modules/planning-project-storage.js');
  if(mount)vm.runInContext('DatyPlanningProjectStorageFactory.mount(globalThis)',c);
  t.after(()=>{for(const fn of events.get('pagehide')||[])fn({});});
  return {c,values,elements,notices,calls,storage,original,originalInit,
    start:()=>c.DatyPlanningProjectStorage.start(),state:()=>clone(c.DatyPlanningProjectStorage.snapshot()),
    history:()=>JSON.parse(values.get(KEY)||'{}'),remote:()=>clone(stored),setRemote:value=>{stored=value&&clone(value);},
    intercept:fn=>{interceptor=fn;},confirm:value=>{confirmResult=value;},permission:value=>{permission=value;},
    auth:value=>{auth={...auth,...value};for(const fn of listeners)fn(clone(auth));},
    boot:async()=>{for(const fn of events.get('doc:DOMContentLoaded')||[])if(fn.name==='initializeConstraintFields')await fn();},
    edit:(id,value)=>{elements.get(id).value=value;elements.get(id).handlers.get('input')?.();},
    read:expression=>clone(vm.runInContext(expression,c)),posts:()=>calls.filter(call=>call.method==='POST')};
}

test('candidate requires explicit mount, replaces only project hooks and leaves immediate initDatabase unchanged',async t=>{
  const h=harness(t,{mount:false});assert.equal(h.c.persistPlanningProject,h.original);assert.equal(h.calls.length,0);
  vm.runInContext('DatyPlanningProjectStorageFactory.mount(globalThis)',h.c);
  assert.notEqual(h.c.persistPlanningProject,h.original);assert.equal(h.c.initDatabase,h.originalInit);
  assert.equal(await h.c.initDatabase(),null);assert.equal(h.calls.length,0);
});

test('restore waits for post-access start and retains server history without touching live device state',async t=>{
  const r=record('server'),h=harness(t,{remote:project(r,[r])});
  const before=h.read('DEVICES');const boot=h.boot();await h.start();await boot;
  assert.equal(h.history().currentRecordId,'server');assert.equal(h.history().records[0].id,'server');
  assert.deepEqual(h.read('DEVICES'),before);assert.equal(h.posts().length,0);assert.equal(h.calls.length,1);
});

test('refresh with local current establishes baseline without replacing local current or form',async t=>{
  const local=record('local',0),remote=record('remote',2),h=harness(t,{localRecord:local,remote:project(remote,[remote])});
  await h.boot();const before=h.values.get(KEY),fields=h.elements.get('plannerBackupCount').value;
  await h.start();assert.equal(h.values.get(KEY),before);assert.equal(h.elements.get('plannerBackupCount').value,fields);
  assert.equal(h.state().reviewRequired,true);assert.equal(h.posts().length,0);
});

test('cached divergent planning needs explicit review; cancel sends nothing, accept retains both histories and remote unknown data',async t=>{
  const local=record('local',0),remote=record('remote',2),h=harness(t,{localRecord:local,remote:project(remote,[remote])});
  await h.boot();await h.start();h.confirm(false);
  await assert.rejects(h.c.persistPlanningProject(),failure=>failure.syncStatus==='cancelled');assert.equal(h.posts().length,0);
  h.confirm(true);await h.c.persistPlanningProject();
  assert.deepEqual(h.remote().data.planningHistory.map(item=>item.id),['local','remote']);
  assert.equal(h.remote().data.currentPlanningRecordId,'local');assert.deepEqual(h.remote().data.future,{retained:true});
  assert.equal(h.posts()[0].body.expected_revision,1);assert.equal(h.history().currentRecordId,'local');
});

test('ordinary known baseline save captures original record and rejects parallel save without losing either local snapshot',async t=>{
  const h=harness(t);await h.start();const first=h.c.savePlanningResult([],null,{backupCount:0});
  const gate=deferred();let blocked=false;
  h.intercept(async call=>{if(call.method==='GET'&&!blocked){blocked=true;await gate.promise;}});
  const firstSave=h.c.persistPlanningProject(first);await tick();
  const second=h.c.savePlanningResult([],null,{backupCount:2});
  await assert.rejects(h.c.persistPlanningProject(second),failure=>failure.syncStatus==='busy');
  assert.equal(h.history().records.length,2);gate.resolve();await firstSave;
  assert.equal(h.remote().data.currentPlanningRecordId,first.id);assert.equal(h.history().currentRecordId,second.id);
  await h.c.persistPlanningProject(second);assert.equal(h.remote().data.currentPlanningRecordId,second.id);
  assert.equal(h.remote().data.planningHistory.length,2);
});

test('user edits during initial remote load survive restoration and force review before later save',async t=>{
  const remote=record('remote',2),h=harness(t,{remote:project(remote,[remote])}),gate=deferred();
  h.intercept(async call=>{if(call.method==='GET')await gate.promise;});
  const boot=h.boot(),start=h.start();await tick();h.edit('plannerBackupCount','4');gate.resolve();await start;await boot;
  assert.equal(h.elements.get('plannerBackupCount').value,'4');assert.equal(h.c.getCurrentPlanningRecord(),null);
  assert.equal(h.state().reviewRequired,true);assert.equal(h.posts().length,0);
});

test('confirmation becomes invalid after editing or switching target and does not post stale planning',async t=>{
  for(const change of ['edit','target']){
    const h=harness(t,{localRecord:record('local'),remote:project(record('remote'),[record('remote')])});
    await h.boot();await h.start();const gate=deferred();h.confirm(()=>gate.promise);
    const save=h.c.persistPlanningProject();await tick();
    if(change==='edit')h.edit('plannerBackupCount','3');else h.elements.get('fasheApiUrl').value='https://other-fixture.invalid:8802';
    gate.resolve(true);await assert.rejects(save,failure=>failure.syncStatus==='invalidated');assert.equal(h.posts().length,0);
  }
});

test('draft target mismatch and missing project permission refuse writes without changing local data',async t=>{
  const h=harness(t,{localRecord:record('same'),remote:project(record('same'),[record('same')])});await h.boot();await h.start();
  const before=h.values.get(KEY);h.elements.get('fasheApiUrl').value='https://wrong-fixture.invalid:8802';
  await assert.rejects(h.c.persistPlanningProject(),failure=>failure.code==='PROJECT_TARGET_MISMATCH');
  h.elements.get('fasheApiUrl').value='https://localhost:8802';h.permission(false);
  await assert.rejects(h.c.persistPlanningProject(),/permission denied/);
  assert.equal(h.posts().length,0);assert.equal(h.values.get(KEY),before);
});

test('unknown project POST blocks repeated saving and reloading instead of replaying',async t=>{
  const h=harness(t);await h.start();const r=h.c.savePlanningResult([],null,{backupCount:1});
  h.intercept(call=>{if(call.method==='POST')throw new Error('fixture lost response');});
  await assert.rejects(h.c.persistPlanningProject(r),failure=>failure.syncStatus==='unknown');
  await assert.rejects(h.c.persistPlanningProject(r),failure=>failure.syncStatus==='unknown');
  await assert.rejects(h.c.DatyPlanningProjectStorage.loadBaseline(),failure=>failure.syncStatus==='unknown');
  assert.equal(h.posts().length,1);assert.equal(h.history().currentRecordId,r.id);
});

test('confirmed project plus unknown run reports partial truth and never replays run or project',async t=>{
  const h=harness(t);await h.start();const result={assignments:[],analysis:{conflicts:[]}},r=h.c.savePlanningResult([],result,{backupCount:0});
  h.intercept(call=>call.url.endsWith('/api/coordination-runs')?response({success:false},500):undefined);
  await assert.rejects(h.c.persistPlanningProject(r,result),failure=>failure.syncStatus==='partial'&&failure.projectSaved&&/项目已保存/.test(failure.message));
  assert.equal(h.remote().data.currentPlanningRecordId,r.id);assert.equal(h.posts().length,2);
  await assert.rejects(h.c.persistPlanningProject(r,result),failure=>failure.syncStatus==='unknown');assert.equal(h.posts().length,2);
  assert.equal(h.posts()[1].body.input.devices.length,0);assert.deepEqual(h.posts()[1].body.result,result);
});

test('restore combines deletion tombstones, rejects stale selection and performs no device changes',async t=>{
  const old=record('deleted'),retained=record('remote'),remote=project(null,[retained]);remote.data.deletedRecordIds=['deleted'];
  const h=harness(t,{localRecords:[old],remote});const before=h.read('DEVICES');
  const boot=h.boot();await h.start();await boot;
  assert.deepEqual(h.history().deletedRecordIds,['deleted']);assert.deepEqual(h.history().records.map(item=>item.id),['remote']);
  assert.equal(h.history().currentRecordId,null);assert.deepEqual(h.read('DEVICES'),before);assert.equal(h.posts().length,0);
});

test('restore quota failure does not partially mutate current project, history or devices',async t=>{
  const remote=project(record('remote'),[record('remote')]),h=harness(t,{remote});
  const before=h.read('({project:currentPlanningProject,current:currentPlanningRecordId,records:HISTORY,devices:DEVICES})');
  h.storage.fail=KEY;const boot=h.boot();await h.start();await boot;
  assert.deepEqual(h.read('({project:currentPlanningProject,current:currentPlanningRecordId,records:HISTORY,devices:DEVICES})'),before);
  assert.equal(h.values.get(KEY),undefined);assert.match(h.elements.get('planningHistorySaveStatus').textContent,/quota/);
});

test('old server without revision capability never falls back to former unconditional project POST',async t=>{
  const h=harness(t),legacy=project();delete legacy.revision_protocol;
  h.intercept(call=>call.method==='GET'?response({success:true,project:legacy}):undefined);
  await assert.rejects(h.start(),failure=>failure.syncStatus==='unsupported');
  const r=h.c.savePlanningResult([],null,{backupCount:0});await assert.rejects(h.c.persistPlanningProject(r),failure=>failure.syncStatus==='unsupported');
  assert.equal(h.posts().length,0);assert.equal(h.history().records.length,1);
});

test('initial authorization generation change only reloads GET baseline, never writes or blocks device initialization',async t=>{
  const h=harness(t),gate=deferred();let blocked=false;
  h.intercept(async call=>{if(call.method==='GET'&&!blocked){blocked=true;await gate.promise;}});
  const starting=h.start();await tick();assert.equal(await h.c.initDatabase(),null);
  h.auth({revision:2});gate.resolve();await starting;
  assert.equal(h.state().scope.accessRevision,2);assert.equal(h.state().loaded,true);
  assert.equal(h.calls.filter(call=>call.method==='GET').length,2);assert.equal(h.posts().length,0);
});

test('editing during first create-only baseline load invalidates captured save before any POST',async t=>{
  const h=harness(t,{remote:null}),gate=deferred();h.intercept(async call=>{if(call.method==='GET')await gate.promise;});
  const starting=h.start();await tick();const first=h.c.savePlanningResult([],null,{backupCount:0});
  const saving=h.c.persistPlanningProject(first);
  const second=h.c.savePlanningResult([],null,{backupCount:2});gate.resolve();await starting;
  await assert.rejects(saving,failure=>failure.syncStatus==='invalidated');
  assert.equal(h.history().records.length,2);assert.equal(h.history().currentRecordId,second.id);assert.equal(h.posts().length,0);
});

test('explicit unknown reconciliation is read-only and does not replay the project or queued run',async t=>{
  const h=harness(t);await h.start();const r=h.c.savePlanningResult([],null,{backupCount:1});
  h.intercept(call=>{if(call.method==='POST'){
    const observed={...clone(call.body),revision:call.body.expected_revision+1,revision_protocol:PROTOCOL};delete observed.expected_revision;
    h.setRemote(observed);throw new Error('fixture reply lost after commit');
  }});
  await assert.rejects(h.c.persistPlanningProject(r),failure=>failure.syncStatus==='unknown');
  h.intercept(null);const reconciled=await h.c.DatyPlanningProjectStorage.reconcile();
  assert.equal(reconciled.status,'saved');assert.equal(reconciled.reconciled,true);
  assert.equal(h.posts().length,1);assert.equal(h.history().currentRecordId,r.id);
});

test('original render deletion reaches only candidate CAS hook and retains current form as unsaved draft',async t=>{
  const selected=record('selected',2),h=harness(t,{localRecord:selected,remote:project(selected,[selected])});
  h.c.DatyHostMessages={VERSION:'daty-host-messages-v1',confirm:()=>true};
  await h.boot();await h.start();const before=h.elements.get('plannerBackupCount').value;
  await h.c.deleteHistory(0);await vm.runInContext('planningProjectSaveQueue',h.c);await tick();
  assert.equal(h.history().currentRecordId,null);assert.deepEqual(h.history().deletedRecordIds,['selected']);
  assert.deepEqual(h.remote().data.deletedRecordIds,['selected']);assert.deepEqual(h.remote().data.planningHistory,[]);
  assert.equal(h.elements.get('plannerBackupCount').value,before);assert.equal(h.posts().length,1);
  assert.equal(h.posts()[0].body.expected_revision,1);
});

test('empty legacy project adopts the actual server name instead of silently renaming it on the next plan',async t=>{
  const remote={...project(),name:'远端剧场项目',data:{}},h=harness(t,{remote});
  const boot=h.boot();await h.start();await boot;
  assert.equal(h.c.getCurrentPlanningProject().name,'远端剧场项目');
  const r=h.c.savePlanningResult([],null,{backupCount:0});await h.c.persistPlanningProject(r);
  assert.equal(h.remote().name,'远端剧场项目');assert.equal(h.history().project.name,'远端剧场项目');
});

test('existing save button reaches unknown read-only confirmation; cancel sends zero new requests and retains lock',async t=>{
  const h=harness(t);await h.start();const r=h.c.savePlanningResult([],null,{backupCount:1});
  h.intercept(call=>{if(call.method==='POST')throw new Error('fixture reply lost');});
  await assert.rejects(h.c.persistPlanningProject(r),failure=>failure.syncStatus==='unknown');
  const before=h.calls.length;h.confirm(false);
  await assert.rejects(h.c.persistPlanningProject(r),failure=>failure.code==='PROJECT_RECONCILE_CANCELLED');
  assert.equal(h.calls.length,before);assert.ok(h.state().unknown);assert.equal(h.posts().length,1);
  assert.match(h.notices.findLast(item=>item[0]==='confirm')[1].title,/只读核对/);
});

test('confirmed read-only reconciliation terminates current save; only a subsequent explicit save can POST again',async t=>{
  const h=harness(t);await h.start();const r=h.c.savePlanningResult([],null,{backupCount:1});
  h.intercept(call=>{if(call.method==='POST'){
    const committed={...clone(call.body),revision:call.body.expected_revision+1,revision_protocol:PROTOCOL};delete committed.expected_revision;
    h.setRemote(committed);throw new Error('fixture reply lost after commit');
  }});
  await assert.rejects(h.c.persistPlanningProject(r),failure=>failure.syncStatus==='unknown');
  h.intercept(null);h.confirm(true);const before=h.calls.length;
  await assert.rejects(h.c.persistPlanningProject(r),failure=>failure.syncStatus==='reconciled'&&failure.reconciled&&/再次主动保存/.test(failure.message));
  assert.deepEqual(h.calls.slice(before).map(call=>call.method),['GET']);assert.equal(h.posts().length,1);
  assert.equal(h.state().unknown,null);assert.equal(h.history().currentRecordId,r.id);
  await h.c.persistPlanningProject(r);assert.equal(h.posts().length,2);
});

test('confirmed reconciliation that cannot prove prior commit stays locked and never issues another write',async t=>{
  const h=harness(t);await h.start();const r=h.c.savePlanningResult([],null,{backupCount:1});
  h.intercept(call=>{if(call.method==='POST')throw new Error('fixture request lost');});
  await assert.rejects(h.c.persistPlanningProject(r),failure=>failure.syncStatus==='unknown');
  h.intercept(null);h.confirm(true);const before=h.calls.length;
  await assert.rejects(h.c.persistPlanningProject(r),failure=>failure.syncStatus==='unknown');
  assert.deepEqual(h.calls.slice(before).map(call=>call.method),['GET']);assert.ok(h.state().unknown);assert.equal(h.posts().length,1);
});

test('target change while confirming read-only reconciliation cancels even the query',async t=>{
  const h=harness(t);await h.start();const r=h.c.savePlanningResult([],null,{backupCount:1});
  h.intercept(call=>{if(call.method==='POST')throw new Error('fixture reply lost');});
  await assert.rejects(h.c.persistPlanningProject(r),failure=>failure.syncStatus==='unknown');
  const gate=deferred();h.confirm(()=>gate.promise);const before=h.calls.length;
  const checking=h.c.persistPlanningProject(r);await tick();h.elements.get('fasheApiUrl').value='https://other.invalid:8802';
  gate.resolve(true);await assert.rejects(checking,failure=>failure.syncStatus==='invalidated');
  assert.equal(h.calls.length,before);assert.equal(h.posts().length,1);
});

test('two-client planning conflict is recoverable from original save hook through explicit GET-only reload then confirmed CAS',async t=>{
  const original=record('original',1),h=harness(t,{localRecord:original,remote:project(original,[original])});
  await h.boot();await h.start();const local=h.c.savePlanningResult([],null,{backupCount:0});
  const other=record('other-client',2),latest=project(other,[other,original]);latest.revision=2;h.setRemote(latest);
  await assert.rejects(h.c.persistPlanningProject(local),failure=>failure.syncStatus==='conflict');assert.equal(h.posts().length,0);
  h.confirm(false);const cancelCount=h.calls.length;
  await assert.rejects(h.c.persistPlanningProject(local),failure=>failure.code==='PROJECT_CONFLICT_REVIEW_CANCELLED');
  assert.equal(h.calls.length,cancelCount);assert.equal(h.state().status,'conflict');
  const before=h.values.get(KEY);h.confirm(true);const reloading=h.calls.length;
  await assert.rejects(h.c.persistPlanningProject(local),failure=>failure.syncStatus==='reloaded');
  assert.deepEqual(h.calls.slice(reloading).map(call=>call.method),['GET']);assert.equal(h.posts().length,0);
  assert.equal(h.values.get(KEY),before);assert.equal(h.state().reviewRequired,true);
  await h.c.persistPlanningProject(local);
  assert.equal(h.posts().length,1);assert.equal(h.posts()[0].body.expected_revision,2);
  assert.equal(h.remote().data.currentPlanningRecordId,local.id);
  assert.deepEqual(new Set(h.remote().data.planningHistory.map(item=>item.id)),new Set([local.id,'original','other-client']));
  assert.ok(h.notices.some(item=>item[0]==='confirm'&&/确认项目同步基准/.test(item[1].title)));
});

test('conflict baseline reload never authorizes a further concurrent remote atomic change',async t=>{
  const original=record('original'),h=harness(t,{localRecord:original,remote:project(original,[original])});
  await h.boot();await h.start();const local=h.c.savePlanningResult([],null,{backupCount:0});
  const other=record('other',2),latest=project(other,[other,original]);latest.revision=2;h.setRemote(latest);
  await assert.rejects(h.c.persistPlanningProject(local),failure=>failure.syncStatus==='conflict');
  await assert.rejects(h.c.persistPlanningProject(local),failure=>failure.syncStatus==='reloaded');
  const gate=deferred();h.confirm(()=>gate.promise);const saving=h.c.persistPlanningProject(local);await tick();
  const newest=record('newest',3),third=project(newest,[newest,other,original]);third.revision=3;h.setRemote(third);
  gate.resolve(true);await assert.rejects(saving,failure=>failure.syncStatus==='conflict');
  assert.equal(h.posts().length,0);assert.equal(h.remote().data.currentPlanningRecordId,'newest');
});
