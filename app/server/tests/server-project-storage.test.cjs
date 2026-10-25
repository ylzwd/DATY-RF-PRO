// Candidate UI adapter replay. Original storage/render/planning-ui in a fresh VM,
// in-memory CAS server/authorization only. No live network or business storage.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./business-db-fixture.cjs');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{randomUUID}=require('node:crypto');
const ROOT=path.join(__dirname,'..'),KEY='daty_planning_history_v1',PROTOCOL='daty-business-db-v1';
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
  const db=fixture();db.scope.principalId='network:127.0.0.1';
  function seed(p){
    db.resources.clear();if(!p)return;
    const data=clone(p.data),current={projectId:p.id,currentRecordId:data.currentPlanningRecordId??null,deletedRecordIds:data.deletedRecordIds||[],devices:p.devices||[]};
    for(const key of ['constraints','constraintFields','last_coordination_at'])if(Object.hasOwn(data,key)){current[key]=data[key];delete data[key];}
    for(const item of data.planningHistory||[])db.put('planning_records',item.id,item);
    for(const key of ['planningHistory','deletedRecordIds','currentPlanningRecordId'])delete data[key];
    db.put('project_metadata',p.id,{id:p.id,name:p.name,data},p.revision||1);db.put('planning_current',p.id,current,p.revision||1);
  }
  seed(stored);auth.source={id:'network:127.0.0.1',kind:'network-peer',authenticated:false};
  const rawRequest=async(url,init={})=>{
    const call={url,method:init.method||'GET',body:init.body&&JSON.parse(init.body)};calls.push(call);
    if(interceptor){const answer=await interceptor(call,init);if(answer!==undefined)return answer;}
    if(new URL(url).pathname.startsWith('/api/projects/'))return response({success:false},404);
    const result=await db.handle(url,init);
    return {...result,json:async()=>vm.runInContext('JSON.parse('+JSON.stringify(JSON.stringify(await result.json()))+')',c)};
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
  c.DatyDatabaseConnection={snapshot:()=>vm.runInContext('JSON.parse('+JSON.stringify(JSON.stringify(auth))+')',c),subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},assertConnected(){if(!permission)throw Object.assign(new Error('fixture connection unavailable'),{code:'FORBIDDEN'});return clone(auth);}};
  c.DatyDialogs={confirm:async options=>{notices.push(['confirm',options]);return typeof confirmResult==='function'?confirmResult(options):confirmResult;}};
  load('src/platform/project-concurrency.js');load('src/platform/database-client.js');load('src/platform/database-batch-client.js');load('src/platform/unified-project-sync.js');
  const original=c.persistPlanningProject,originalInit=c.initDatabase;
  load('src/modules/planning-project-storage.js');
  if(mount)vm.runInContext('DatyPlanningProjectStorageFactory.mount(globalThis)',c);
  t.after(()=>{for(const fn of events.get('pagehide')||[])fn({});});
  return {c,db,values,elements,notices,calls,storage,original,originalInit,
    start:()=>c.DatyPlanningProjectStorage.start(),state:()=>clone(c.DatyPlanningProjectStorage.snapshot()),
    history:()=>JSON.parse(values.get(KEY)||'{}'),remote:()=>clone(stored),setRemote:value=>{stored=value&&clone(value);seed(stored);},
    intercept:fn=>{interceptor=fn;},confirm:value=>{confirmResult=value;},permission:value=>{permission=value;},
    auth:value=>{auth={...auth,...value};for(const fn of listeners)fn(clone(auth));},
    boot:async()=>{for(const fn of events.get('doc:DOMContentLoaded')||[])if(fn.name==='initializeConstraintFields')await fn();},
    edit:(id,value)=>{elements.get(id).value=value;elements.get(id).handlers.get('input')?.();},
    read:expression=>clone(vm.runInContext(expression,c)),posts:()=>calls.filter(call=>call.method==='POST')};
}


test('server adapter mounts only project hooks and startup performs reads',async t=>{
 const h=harness(t,{mount:false});assert.equal(h.c.persistPlanningProject,h.original);
 vm.runInContext('DatyPlanningProjectStorageFactory.mount(globalThis)',h.c);await h.start();
 assert.equal(h.c.initDatabase,h.originalInit);assert.equal(h.posts().length,0);assert.equal(h.state().loaded,true);
});
test('server history restores after original cache is archived, with live devices unchanged',async t=>{
 const remote=record('remote'),h=harness(t,{remote:project(remote,[remote])});
 h.c.DatyServerStorage={legacyArchived:true};await h.boot();await h.start();
 const before=h.read('DEVICES');await h.c.restorePlanningProjectFromServer();
 assert.equal(h.c.getCurrentPlanningRecord().id,'remote');assert.deepEqual(h.read('DEVICES'),before);assert.equal(h.posts().length,0);
});
test('late restore retains newer form input and local history',async t=>{
 const remote=record('remote'),h=harness(t,{remote:project(remote,[remote])}),gate=deferred();
 h.c.DatyServerStorage={legacyArchived:true};h.intercept(async c=>{if(c.url.includes('/resources/project_metadata/'))await gate.promise;});
 const start=h.start(),restore=h.c.restorePlanningProjectFromServer();await tick();h.edit('plannerBackupCount','7');gate.resolve();
 await start;assert.equal(await restore,false);assert.equal(h.elements.get('plannerBackupCount').value,'7');assert.equal(h.posts().length,0);
});
test('cancel divergent baseline saves nothing; acceptance uses one atomic batch',async t=>{
 const local=record('local'),remote=record('remote',2),h=harness(t,{localRecord:local,remote:project(remote,[remote])});await h.boot();await h.start();
 h.confirm(false);await assert.rejects(h.c.persistPlanningProject(),e=>e.syncStatus==='cancelled');assert.equal(h.posts().length,0);
 h.confirm(true);await h.c.persistPlanningProject();assert.equal(h.posts().length,1);assert.ok(h.posts()[0].url.endsWith('/database/batch'));
 assert.equal(h.db.resources.get('["planning_current","default"]').value.currentRecordId,'local');
 assert.ok(h.db.resources.has('["planning_records","remote"]'));assert.ok(h.db.resources.has('["planning_records","local"]'));
});
test('changed input while confirmation is open cannot save captured stale plan',async t=>{
 const local=record('local'),remote=record('remote',2),h=harness(t,{localRecord:local,remote:project(remote,[remote])}),gate=deferred();await h.boot();await h.start();h.confirm(()=>gate.promise);
 const saving=h.c.persistPlanningProject();await tick();h.edit('plannerBackupCount','4');gate.resolve(true);
 await assert.rejects(saving,e=>e.syncStatus==='invalidated');assert.equal(h.posts().length,0);
});
test('conflict preserves server state and requires read-only review before another save',async t=>{
 const h=harness(t,{localRecord:record('local')});await h.boot();await h.start();h.db.state.rejectNext='RESOURCE_REVISION_CONFLICT';
 await assert.rejects(h.c.persistPlanningProject(),e=>e.syncStatus==='conflict');const count=h.posts().length;
 await assert.rejects(h.c.persistPlanningProject(),e=>e.syncStatus==='reloaded');assert.equal(h.posts().length,count);
 assert.equal(h.db.resources.has('["planning_records","local"]'),false);
});
test('lost commit reply never replays writes; read-only receipt reconciliation preserves history',async t=>{
 const h=harness(t,{localRecord:record('local')});await h.boot();await h.start();h.db.state.dropReply=true;
 await assert.rejects(h.c.persistPlanningProject(),e=>e.syncStatus==='unknown');assert.equal(h.posts().length,1);
 await assert.rejects(h.c.persistPlanningProject(),e=>e.syncStatus==='reconciled');assert.equal(h.posts().length,1);
 assert.equal(h.db.resources.get('["planning_current","default"]').value.currentRecordId,'local');
});
test('target mismatch and page exit prohibit writes',async t=>{
 const h=harness(t,{localRecord:record('local')});await h.start();h.elements.get('fasheApiUrl').value='https://192.0.2.200:8802';
 await assert.rejects(h.c.persistPlanningProject(),e=>e.code==='PROJECT_TARGET_MISMATCH');assert.equal(h.posts().length,0);
});
