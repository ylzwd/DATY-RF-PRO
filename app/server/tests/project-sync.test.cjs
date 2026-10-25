'use strict';
// Candidate C2 orchestration: virtual HTTP, virtual clocks and memory only.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const factory=require('../src/platform/project-sync.js');
const concurrency=require('../src/platform/project-concurrency.js');
const PROTOCOL=concurrency.PROTOCOL,clone=value=>JSON.parse(JSON.stringify(value));
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const response=(body,status=200)=>({status,ok:status>=200&&status<300,json:async()=>clone(body)});
const project=()=>({id:'default',name:'project',revision:1,revision_protocol:PROTOCOL,devices:[],
  data:{planningHistory:[],deletedRecordIds:[],currentPlanningRecordId:null,other:{a:1,b:1}}});
function harness(shared={project:project()}){
  let id=0;const tasks=new Map(),requests=[],scope={baseUrl:'https://localhost:8802',projectId:'default',accessRevision:1};
  const ports={concurrency,
    readScope(){assert.equal(this,ports);return scope;},
    schedule(fn,ms){assert.equal(this,ports);tasks.set(++id,{fn,ms});return id;},
    cancel(id){assert.equal(this,ports);tasks.delete(id);},
    request(url,options){assert.equal(this,ports);requests.push({url,options});return ports.handle(url,options);},
    handle(url,options){
      if(options.method!=='POST')return Promise.resolve(shared.project
        ?response({success:true,revision_protocol:PROTOCOL,project:shared.project})
        :response({success:false,revision_protocol:PROTOCOL},404));
      const body=JSON.parse(options.body);
      if(url.endsWith('/api/coordination-runs'))return Promise.resolve(response({success:true,run_id:'run-1',project_id:body.project_id}));
      const revision=shared.project?.revision||0;
      if(body.expected_revision!==revision)return Promise.resolve(response({success:false,code:'PROJECT_REVISION_CONFLICT',revision_protocol:PROTOCOL},409));
      const {expected_revision,...value}=body;
      shared.project={...clone(value),revision:revision+1,revision_protocol:PROTOCOL};
      return Promise.resolve(response({success:true,project_id:body.id,revision:revision+1,revision_protocol:PROTOCOL}));
    }};
  const api=factory.create(ports);
  return {api,ports,scope,shared,tasks,requests,
    posts:()=>requests.filter(r=>r.options.method==='POST'),
    async expire(){for(const [key,value]of [...tasks]){tasks.delete(key);assert.equal(value.ms,5000);value.fn();}await flush();}};
}
test('module load is pure and factory requires explicit host ports',()=>{
  const fail=()=>{throw Error('host bypass');};const c=vm.createContext({fetch:fail,setTimeout:fail,document:new Proxy({}, {get:fail})});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/platform/project-sync.js'),'utf8'),c);
  assert.equal(c.DatyProjectSyncFactory.VERSION,'daty-project-sync-v1');assert.throws(()=>factory.create({}),/ports/);
});
test('save cannot manufacture an editing baseline from its own fresh GET',async()=>{
  const h=harness();const result=await h.api.save(project());assert.equal(result.code,'BASELINE_REQUIRED');assert.equal(h.requests.length,0);
  const loaded=await h.api.load();assert.equal(loaded.status,'loaded');assert.equal(loaded.scope.baseUrl,'https://127.0.0.1:8802');
  loaded.project.data.other.a=99;loaded.scope.projectId='changed';
  const view=h.api.snapshot();assert.equal(view.project.data.other.a,1);assert.equal(view.scope.projectId,'default');
  view.project.name='mutated';assert.equal(h.api.snapshot().project.name,'project');
});
test('load keeps valid null creation baseline only when 404 has the real protocol marker',async()=>{
  const h=harness({project:null});assert.equal((await h.api.load()).project,null);assert.equal(h.api.snapshot().loaded,true);
  const result=await h.api.save(project());assert.equal(result.status,'saved');assert.equal(result.revision,1);
  assert.equal(JSON.parse(h.posts()[0].options.body).expected_revision,0);
  const old=harness({project:null});old.ports.handle=()=>Promise.resolve(response({success:false},404));
  assert.equal((await old.api.load()).status,'unsupported');assert.equal((await old.api.save(project())).code,'BASELINE_REQUIRED');assert.equal(old.posts().length,0);
});
test('save merges against actual editing baseline, GET latest never replaces it before commit',async()=>{
  const h=harness();await h.api.load();const desired=h.api.snapshot().project;desired.data.other.a=2;
  h.shared.project.data.other.b=3;h.shared.project.revision=2;
  const gate=deferred(),original=h.ports.handle;
  h.ports.handle=(url,options)=>options.method==='POST'?gate.promise:original(url,options);
  const pending=h.api.save(desired);desired.name='changed after click';await flush();
  assert.equal(h.posts().length,1);assert.equal(h.api.snapshot().project.revision,1);
  const body=JSON.parse(h.posts()[0].options.body);assert.deepEqual(body.data.other,{a:2,b:3});assert.equal(body.name,'project');
  assert.equal(body.expected_revision,2);assert.ok(h.requests.every(r=>r.options.redirect==='error'&&r.options.signal instanceof AbortSignal));
  gate.resolve(response({success:true,project_id:'default',revision:3,revision_protocol:PROTOCOL}));
  assert.equal((await pending).status,'saved');assert.equal(h.api.snapshot().project.revision,3);assert.equal(h.tasks.size,0);
});
test('same-field and atomic planning conflicts return zero POST and retain the original baseline',async()=>{
  for(const atomic of [false,true]){
    const h=harness();await h.api.load();const desired=h.api.snapshot().project;
    if(atomic){desired.devices=[{id:'CH1',freq:641000}];h.shared.project.data.constraints={backupCount:2};}
    else{desired.name='local';h.shared.project.name='remote';}
    h.shared.project.revision=2;assert.equal((await h.api.save(desired)).status,'conflict');
    assert.equal(h.posts().length,0);assert.equal(h.api.snapshot().project.revision,1);
  }
});
test('unsupported latest server never receives a conditional or legacy unconditional POST',async()=>{
  const h=harness();await h.api.load();h.ports.handle=()=>Promise.resolve(response({success:true,project:{...project(),revision_protocol:undefined}}));
  assert.equal((await h.api.save(project())).status,'unsupported');assert.equal(h.posts().length,0);
});
test('single-flight duplicate save returns busy instead of queuing or replaying a captured POST',async()=>{
  const h=harness();await h.api.load();const gate=deferred(),original=h.ports.handle;
  h.ports.handle=(url,options)=>options.method==='POST'?gate.promise:original(url,options);
  const pending=h.api.save(project());await flush();assert.equal((await h.api.save(project())).status,'busy');assert.equal((await h.api.load()).status,'busy');
  gate.resolve(response({success:true,project_id:'default',revision:2,revision_protocol:PROTOCOL}));await pending;
  assert.equal(h.posts().length,1);
});
test('two independent clients reaching the same revision cannot silently overwrite each other',async()=>{
  const shared={project:project()},a=harness(shared),b=harness(shared);await a.api.load();await b.api.load();
  const desiredA=a.api.snapshot().project,desiredB=b.api.snapshot().project;desiredA.name='A';desiredB.name='B';
  const gets=[];
  for(const h of [a,b]){const original=h.ports.handle;h.ports.handle=(url,options)=>{
    if(options.method==='POST')return original(url,options);
    const gate=deferred();gets.push(()=>gate.resolve(response({success:true,revision_protocol:PROTOCOL,project:project()})));return gate.promise;
  };}
  const savingA=a.api.save(desiredA),savingB=b.api.save(desiredB);await flush();gets.forEach(fn=>fn());
  const results=await Promise.all([savingA,savingB]);assert.deepEqual(results.map(x=>x.status),['saved','conflict']);
  assert.equal(shared.project.name,'A');assert.equal(a.posts().length,1);assert.equal(b.posts().length,1);
  assert.equal(b.api.snapshot().project.name,'project');
});
test('whole GET plus response body timeout is bounded even when the host ignores abort',async()=>{
  const h=harness(),body=deferred();h.ports.handle=()=>Promise.resolve({status:200,ok:true,json:()=>body.promise});
  const pending=h.api.load();await flush();const signal=h.requests[0].options.signal;
  await h.expire();assert.equal((await pending).code,'REQUEST_TIMEOUT');assert.equal(signal.aborted,true);
  body.resolve({success:true,revision_protocol:PROTOCOL,project:project()});await flush();
  assert.equal(h.api.snapshot().loaded,false);assert.equal(h.tasks.size,0);
});
test('unknown project POST blocks load/save/invalidate bypass; exact read-only reconciliation unlocks',async()=>{
  const h=harness();await h.api.load();const original=h.ports.handle,body=deferred();
  h.ports.handle=(url,options)=>{
    if(options.method!=='POST')return original(url,options);
    original(url,options);return Promise.resolve({status:200,ok:true,json:()=>body.promise});
  };
  const desired=h.api.snapshot().project;desired.name='committed with lost response';const pending=h.api.save(desired);await flush();
  await h.expire();assert.equal((await pending).status,'unknown');assert.equal((await h.api.save(desired)).status,'unknown');
  h.api.invalidate();h.scope.accessRevision++;assert.equal((await h.api.load()).status,'unknown');
  h.ports.handle=original;const reconciled=await h.api.reconcile();assert.equal(reconciled.status,'saved');assert.equal(reconciled.reconciled,true);
  assert.equal(h.posts().length,1);assert.equal(h.api.snapshot().project.name,desired.name);
  body.resolve({success:true,project_id:'default',revision:2,revision_protocol:PROTOCOL});await flush();assert.equal(h.posts().length,1);
});
test('unproven content or later revision cannot clear an unknown POST and reconciliation never posts',async()=>{
  const h=harness();await h.api.load();const original=h.ports.handle;
  h.ports.handle=(url,options)=>options.method==='POST'?Promise.reject(Error('network lost')):original(url,options);
  assert.equal((await h.api.save(project())).status,'unknown');h.ports.handle=original;
  assert.equal((await h.api.reconcile()).status,'unknown');
  h.shared.project.revision=3;assert.equal((await h.api.reconcile()).status,'unknown');
  h.shared.project.revision=2;h.shared.project.name='different';assert.equal((await h.api.reconcile()).status,'unknown');assert.equal(h.posts().length,1);
});
test('scope and authorization changes during GET prevent POST; late results cannot load another project',async()=>{
  for(const phase of ['load','save']){
    const h=harness();if(phase==='save')await h.api.load();const gate=deferred();h.ports.handle=()=>gate.promise;
    const pending=phase==='load'?h.api.load():h.api.save(project());await flush();h.scope.accessRevision++;
    gate.resolve(response({success:true,revision_protocol:PROTOCOL,project:project()}));
    assert.equal((await pending).status,'invalidated');assert.equal(h.posts().length,0);assert.equal(h.api.snapshot().loaded,false);
  }
});
test('explicit invalidation aborts pending POST but cannot erase its unknown write lock',async()=>{
  const h=harness();await h.api.load();const original=h.ports.handle,gate=deferred();
  h.ports.handle=(url,options)=>options.method==='POST'?gate.promise:original(url,options);
  const pending=h.api.save(project());await flush();const signal=h.posts()[0].options.signal;h.api.invalidate();
  assert.equal((await pending).status,'invalidated');assert.equal(signal.aborted,true);
  gate.resolve(response({success:true,project_id:'default',revision:2,revision_protocol:PROTOCOL}));await flush();
  assert.equal((await h.api.load()).status,'unknown');assert.equal(h.posts().length,1);assert.equal(h.api.snapshot().loaded,false);
});
test('HTTP 401 is a known pre-write refusal, invalidates baseline and never sends the requested run',async()=>{
  const h=harness();await h.api.load();const original=h.ports.handle;
  h.ports.handle=(url,options)=>options.method==='POST'?Promise.resolve(response({success:false},401)):original(url,options);
  const result=await h.api.save(project(),{run:{input:{},result:{}}});assert.equal(result.status,'unauthorized');assert.equal(result.projectSaved,false);
  assert.equal(h.api.snapshot().unknown,null);assert.equal(h.api.snapshot().loaded,false);assert.equal(h.posts().length,1);
  assert.equal((await h.api.save(project())).code,'BASELINE_REQUIRED');
});
test('partial run failure does not hide confirmed project save; unknown run is never replayed',async()=>{
  for(const unknown of [false,true]){
    const h=harness();await h.api.load();const original=h.ports.handle;
    h.ports.handle=(url,options)=>url.endsWith('/api/coordination-runs')
      ?unknown?Promise.reject(Error('run lost')):Promise.resolve(response({success:false},400)):original(url,options);
    const result=await h.api.save(project(),{run:{input:{devices:[]},result:{ok:true}}});
    assert.equal(result.status,'partial');assert.equal(result.projectSaved,true);assert.equal(result.runStatus,unknown?'unknown':'failed');
    assert.equal(h.api.snapshot().project.revision,2);assert.equal(h.posts().length,2);
    if(unknown){assert.equal((await h.api.save(project())).status,'unknown');assert.equal((await h.api.reconcile()).runStatus,'unknown');assert.equal(h.posts().length,2);}
  }
});
test('matching project then real run confirmation returns saved; mismatched run target is partial unknown',async()=>{
  const h=harness();await h.api.load();const result=await h.api.save(project(),{run:{input:{},result:{}}});
  assert.equal(result.status,'saved');assert.equal(result.runStatus,'saved');assert.equal(result.runId,'run-1');assert.equal(h.posts().length,2);
  const other=harness();await other.api.load();const original=other.ports.handle;
  other.ports.handle=(url,options)=>url.endsWith('/api/coordination-runs')?Promise.resolve(response({success:true,run_id:'x',project_id:'wrong'})):original(url,options);
  assert.equal((await other.api.save(project(),{run:{input:{},result:{}}})).runStatus,'unknown');
});
test('reconciling an unknown project save never automatically sends its previously requested run',async()=>{
  const h=harness();await h.api.load();const original=h.ports.handle;
  h.ports.handle=(url,options)=>{const actual=original(url,options);return options.method==='POST'?Promise.reject(Error('lost project response')):actual;};
  assert.equal((await h.api.save(project(),{run:{input:{},result:{}}})).status,'unknown');h.ports.handle=original;
  const result=await h.api.reconcile();assert.equal(result.status,'partial');assert.equal(result.runStatus,'not-sent');assert.equal(h.posts().length,1);
});
test('device set ordering is normalized without changing history order or device identity/content',async()=>{
  const value=project();value.devices=[{id:'CH2',freq:641250},{id:'CH10',freq:643250},{id:'CH1',freq:641000}];
  value.data.planningHistory=[{id:'z'},{id:'a'}];const h=harness({project:value});await h.api.load();
  assert.deepEqual(h.api.snapshot().project.devices.map(d=>d.id),['CH1','CH10','CH2']);
  const result=await h.api.save(value);assert.equal(result.status,'saved');
  assert.deepEqual(result.project.data.planningHistory.map(r=>r.id),['z','a']);assert.equal(value.devices[0].id,'CH2');
});
test('wrong project, plaintext scope, invalid JSON and async timer handles perform no writes',async()=>{
  const h=harness();await h.api.load();const invalid=project();invalid.id='wrong';assert.equal((await h.api.save(invalid)).code,'PROJECT_ID_MISMATCH');
  h.scope.baseUrl='http://127.0.0.1:8802';assert.equal((await h.api.load()).code,'INVALID_SCOPE');assert.equal(h.posts().length,0);
  const getter=project();Object.defineProperty(getter.data,'secret',{enumerable:true,get(){throw Error('must not read accessor');}});
  assert.equal((await h.api.save(getter)).status,'error');assert.equal(h.posts().length,0);
  const other=harness();other.ports.schedule=()=>Promise.resolve(1);assert.equal((await other.api.load()).code,'INVALID_TIMER');assert.equal(other.requests.length,0);
});
test('wrong project/revision/protocol success receipts remain unknown instead of advancing the baseline',async()=>{
  for(const extra of [{project_id:'other'},{revision:3},{revision_protocol:'legacy'},{success:false}]){
    const h=harness();await h.api.load();const original=h.ports.handle;
    h.ports.handle=(url,options)=>options.method==='POST'
      ?Promise.resolve(response({success:true,project_id:'default',revision:2,revision_protocol:PROTOCOL,...extra})):original(url,options);
    assert.equal((await h.api.save(project())).status,'unknown');assert.equal(h.api.snapshot().project.revision,1);
    assert.equal((await h.api.save(project())).status,'unknown');assert.equal(h.posts().length,1);
  }
});
test('scope changing after project confirmation but before run POST preserves partial execution evidence',async()=>{
  const h=harness();await h.api.load();const original=h.ports.schedule;let requestsScheduled=0;
  h.ports.schedule=function(...args){requestsScheduled++;if(requestsScheduled===3)h.scope.accessRevision++;return original.apply(this,args);};
  const result=await h.api.save(project(),{run:{input:{},result:{}}});
  assert.equal(result.status,'invalidated');assert.equal(result.projectSaved,true);assert.equal(result.runStatus,'not-sent');
  assert.equal(h.posts().length,1);assert.equal(h.shared.project.revision,2);assert.equal(h.api.snapshot().loaded,false);
});
test('only an explicit synchronous knownUnsent true releases a host-refused project POST',async()=>{
  for(const mode of ['proven','unknown','async','string']){
    const h=harness();await h.api.load();const original=h.ports.handle;
    h.ports.handle=(url,options)=>{
      if(options.method!=='POST')return original(url,options);
      const error=Object.assign(Error('isolated host refusal'),{knownUnsent:mode==='string'?'true':mode==='proven'||mode==='async'});
      if(mode==='async')return Promise.reject(error);throw error;
    };
    const result=await h.api.save(project());
    assert.equal(result.status,mode==='proven'?'error':'unknown');
    assert.equal(h.api.snapshot().unknown===null,mode==='proven');assert.equal(h.posts().length,1);
    if(mode==='proven'){assert.equal(result.knownUnsent,true);assert.equal(result.projectSaved,false);assert.equal(h.api.snapshot().project.revision,1);}
  }
});
test('a synchronously unsent run reports partial without retaining an unknown retry lock',async()=>{
  const h=harness();await h.api.load();const original=h.ports.handle;
  h.ports.handle=(url,options)=>{if(url.endsWith('/api/coordination-runs'))throw Object.assign(Error('not sent'),{knownUnsent:true});return original(url,options);};
  const result=await h.api.save(project(),{run:{input:{},result:{}}});
  assert.equal(result.status,'partial');assert.equal(result.runStatus,'not-sent');assert.equal(result.projectSaved,true);
  assert.equal(h.api.snapshot().unknown,null);assert.equal(h.api.snapshot().project.revision,2);assert.equal(h.posts().length,2);
});
