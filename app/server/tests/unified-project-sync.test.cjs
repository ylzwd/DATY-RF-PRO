'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const factory=require('../src/platform/unified-project-sync.js');
const concurrency=require('../src/platform/project-concurrency.js');
const {fixture,response,clone}=require('./business-db-fixture.cjs');
function setup(options={}){
  const h=fixture();h.scope.projectId='default';h.legacy=null;h.hook=null;
  h.ports={...h.ports,concurrency:concurrency.create(),request:(url,init={})=>{
    if(new URL(url).pathname.startsWith('/api/projects/')){
      h.requests.push({url,options:init});return h.legacy?response({success:true,project:h.legacy}):response({success:false},404);
    }
    const override=h.hook?.(url,init);return override===undefined?h.handle(url,init):override;
  },...options};
  h.make=()=>factory.create(h.ports);h.sync=h.make();
  h.posts=()=>h.requests.filter(item=>item.options.method==='POST');
  h.get=(kind,id='default')=>h.resources.get(JSON.stringify([kind,id]));
  h.project=(id='default')=>({id,name:'Fixture project',data:{planningHistory:[],deletedRecordIds:[],currentPlanningRecordId:null,custom:{preserved:true}},devices:[]});
  h.seed=(project=h.project(),revision=1)=>{
    const data=clone(project.data),current={projectId:project.id,currentRecordId:data.currentPlanningRecordId??null,deletedRecordIds:data.deletedRecordIds||[],devices:clone(project.devices)};
    for(const key of ['constraints','constraintFields','last_coordination_at'])if(Object.hasOwn(data,key)){current[key]=data[key];delete data[key];}
    for(const record of data.planningHistory||[])h.put('planning_records',record.id,record);
    for(const key of ['planningHistory','deletedRecordIds','currentPlanningRecordId'])delete data[key];
    h.put('project_metadata',project.id,{id:project.id,name:project.name,data},revision);h.put('planning_current',project.id,current,revision);return project;
  };
  return h;
}
const record=(id='r1',projectId='default')=>({id,projectId,createdAt:'2026-09-13T00:00:00Z',devices:[{id:'receiver-a/CH1',freq:641.25}],constraints:{minSpacingKhz:250},future:{retain:true}});
function withRecord(h,id='r1'){const project=h.project();project.data.planningHistory=[record(id)];project.data.currentPlanningRecordId=id;project.devices=clone(project.data.planningHistory[0].devices);return project;}

test('initial aggregate load is GET-only and retains normalized unknown fields, devices and null constraints',async()=>{
  const h=setup(),project=withRecord(h);project.data.constraints=null;project.data.constraintFields={locked:'receiver-a/CH1'};h.seed(project,7);
  h.get('project_metadata').value.futureMetadata={retained:1};h.get('planning_current').value.futureCurrent={retained:2};
  const result=await h.sync.load();assert.equal(result.status,'loaded');assert.equal(result.project.revision,7);assert.equal(result.project.revision_protocol,factory.PROTOCOL);
  assert.deepEqual(result.project.data,project.data);assert.deepEqual(result.project.devices,project.devices);assert.equal(h.posts().length,0);
  const saved=await h.sync.save(result.project);assert.equal(saved.status,'saved');assert.deepEqual(h.get('project_metadata').value.futureMetadata,{retained:1});assert.deepEqual(h.get('planning_current').value.futureCurrent,{retained:2});
  assert.equal(JSON.parse(h.posts()[0].options.body).writes.length,2);
});

test('legacy nonempty, renamed empty and orphan resources require explicit import without automatic writes',async()=>{
  for(const mode of ['history','devices','name','orphan-current','orphan-record']){
    const h=setup();h.legacy={id:'default',name:'默认项目',data:{},devices:[]};
    if(mode==='history')h.legacy.data.constraints={locked:[641250]};
    if(mode==='devices')h.legacy.devices=[{id:1}];if(mode==='name')h.legacy.name='Operator named project';
    if(mode==='orphan-current')h.put('planning_current','default',{projectId:'default',devices:[]});
    if(mode==='orphan-record')h.put('planning_records','r1',record());
    const result=await h.sync.load();assert.equal(result.status,'unsupported',mode);assert.equal(result.code,'MIGRATION_REQUIRED');assert.equal(h.posts().length,0);assert.equal(h.sync.snapshot().loaded,false);
  }
});

test('first explicit save creates normalized resources and selected run in one ordered atomic batch',async()=>{
  const h=setup();h.legacy={id:'default',name:'默认项目',data:{},devices:[]};assert.equal((await h.sync.load()).project,null);
  const project=withRecord(h);project.data.constraints={locked:[641250]};project.data.constraintFields=null;
  const result=await h.sync.save(project,{run:{project_id:'default',input:{devices:project.devices},result:{valid:true}}});
  assert.equal(result.status,'saved');assert.equal(result.projectSaved,true);assert.equal(result.runStatus,'saved');assert.equal(h.posts().length,1);
  const sent=JSON.parse(h.posts()[0].options.body);assert.deepEqual(sent.writes.map(item=>item.kind),['project_metadata','planning_records','planning_current','planning_runs']);
  assert(sent.writes.every(item=>item.expected_revision===0));assert.deepEqual(h.get('project_metadata').value.data,{custom:{preserved:true}});
  assert.equal(h.get('planning_current').value.constraints.locked[0],641250);assert.equal(h.get('planning_current').value.constraintFields,null);
  assert.equal(h.get('planning_runs','r1').value.projectId,'default');assert(!Object.hasOwn(h.get('planning_runs','r1').value,'project_id'));assert.equal(h.memory.size,0);
  assert(h.requests.every(item=>!/(coordination-runs|command|control|batch_journal)/.test(item.url)));
});

test('save without baseline or wrong project never posts',async()=>{
  const h=setup();assert.equal((await h.sync.save(h.project())).code,'BASELINE_REQUIRED');await h.sync.load();
  assert.equal((await h.sync.save(h.project('other'))).code,'PROJECT_ID_MISMATCH');assert.equal(h.posts().length,0);
});

test('immutable record content edits and missing project attribution stop before POST',async()=>{
  for(const mode of ['edited','unattributed']){
    const h=setup();h.seed(withRecord(h));const loaded=await h.sync.load();const desired=clone(loaded.project);
    if(mode==='edited')desired.data.planningHistory[0].devices[0].freq=642;
    else{desired.data.planningHistory.push(record('r2'));delete desired.data.planningHistory[1].projectId;}
    const result=await h.sync.save(desired);assert.equal(result.status,'conflict');assert.equal(h.posts().length,0);
  }
});

test('explicit tombstone hides record without mutating or deleting immutable historical resource',async()=>{
  const h=setup();h.seed(withRecord(h));const loaded=await h.sync.load(),desired=clone(loaded.project);
  desired.data.planningHistory=[];desired.data.deletedRecordIds=['r1'];desired.data.currentPlanningRecordId=null;
  assert.equal((await h.sync.save(desired)).status,'saved');assert.equal(h.get('planning_records','r1').deleted,false);assert.equal(h.get('planning_records','r1').revision,1);
  assert.deepEqual((await h.sync.load()).project.data.planningHistory,[]);assert(JSON.parse(h.posts()[0].options.body).writes.every(item=>!item.deleted));
});

test('selected missing/deleted records and malformed device snapshots cannot establish restore baseline',async()=>{
  for(const mode of ['missing','deleted','bad-device','bad-data']){
    const h=setup();h.seed(withRecord(h));
    if(mode==='missing')h.get('planning_current').value.currentRecordId='absent';
    if(mode==='deleted')h.get('planning_current').value.deletedRecordIds=['r1'];
    if(mode==='bad-device')h.get('planning_current').value.devices=[{id:'dup'},{id:'dup'}];
    if(mode==='bad-data')h.get('project_metadata').value.data=[];
    assert.notEqual((await h.sync.load()).status,'loaded',mode);assert.equal(h.sync.snapshot().loaded,false);assert.equal(h.posts().length,0);
  }
});

test('separate clients merge disjoint ordinary data while preserving original editing baseline',async()=>{
  const h=setup();h.seed();const second=h.make();const a=(await h.sync.load()).project,b=(await second.load()).project;
  a.data.clientA={value:1};b.data.clientB={value:2};assert.equal((await second.save(b)).status,'saved');
  assert.equal((await h.sync.save(a)).status,'saved');assert.deepEqual(h.get('project_metadata').value.data,{custom:{preserved:true},clientA:{value:1},clientB:{value:2}});
  assert.deepEqual(h.posts().map(item=>JSON.parse(item.options.body).writes[0].expected_revision),[1,2]);
});

test('simultaneous atomic planning edits conflict; no latest GET silently replaces baseline',async()=>{
  const h=setup();h.seed();const second=h.make();const a=(await h.sync.load()).project,b=(await second.load()).project;
  a.data.constraints={locked:[641250]};b.data.constraints={locked:[642250]};assert.equal((await second.save(b)).status,'saved');
  const result=await h.sync.save(a);assert.equal(result.status,'conflict');assert(result.conflicts.some(item=>item.code==='PLANNING_SNAPSHOT_CONFLICT'));assert.equal(h.posts().length,1);assert.equal(h.sync.snapshot().project.revision,1);
});

test('resource revision conflict on final batch leaves current and new record untouched',async()=>{
  const h=setup();h.seed();const project=(await h.sync.load()).project;project.data.planningHistory=[record()];project.data.currentPlanningRecordId='r1';
  let once=false;h.hook=(url,init)=>{if(url.endsWith('/api/database/batch')&&!once){once=true;const current=h.get('planning_current');h.put('planning_current','default',{...current.value,constraints:{other:true}},2);}};
  const result=await h.sync.save(project);assert.equal(result.status,'conflict');assert.equal(h.get('project_metadata').revision,1);assert.equal(h.get('planning_records','r1'),undefined);assert.equal(h.receipts.size,0);
});

test('torn aggregate between independent GETs is refused without advancing baseline',async()=>{
  const h=setup();h.seed();let count=0;h.hook=url=>{if(url.includes('/api/database/resources/project_metadata/')&&++count===2)h.get('project_metadata').revision++;};
  const result=await h.sync.load();assert.equal(result.status,'conflict');assert.equal(result.code,'PROJECT_READ_CHANGED');assert.equal(h.sync.snapshot().loaded,false);
});

test('all historical pages load and cursor cycles or changing high-water mark fail closed',async()=>{
  for(const mode of ['valid','cycle','as-of']){
    const h=setup();h.seed(withRecord(h));const rows=Array.from({length:205},(_,n)=>({kind:'planning_records',id:'x'+n,revision:1,deleted:false,value:record('x'+n)}));
    h.hook=url=>{const parsed=new URL(url);if(parsed.pathname==='/api/database/resources'&&parsed.searchParams.get('kind')==='planning_records'){
      h.requests.push({url,options:{}});const second=!!parsed.searchParams.get('cursor');
      assert.equal(parsed.searchParams.get('project_id'),'default');
      return response({success:true,...h.envelope(),project_id:'default',resources:second?rows.slice(199):[h.get('planning_records','r1'),...rows.slice(0,199)],next_cursor:second?(mode==='cycle'?'page2':null):'page2',as_of:second&&mode==='as-of'?2:1});
    }};
    const result=await h.sync.load();if(mode==='valid'){assert.equal(result.status,'loaded');assert.equal(result.project.data.planningHistory.length,206);}else assert.notEqual(result.status,'loaded');assert.equal(h.posts().length,0);
  }
});

test('lost commit reply blocks load and save across reconstruction; explicit receipt GET proves batch once',async()=>{
  const h=setup();await h.sync.load();h.state.dropReply=true;const first=await h.sync.save(withRecord(h),{run:{project_id:'default',result:{valid:true}}});
  assert.equal(first.status,'unknown');assert.equal(h.memory.size,1);const second=h.make();assert.equal(second.snapshot().unknown.projectId,'default');
  assert.equal((await second.load()).status,'unknown');assert.equal((await second.save(withRecord(h))).status,'unknown');assert.equal(h.posts().length,1);
  const reconciled=await second.reconcile();assert.equal(reconciled.status,'saved');assert.equal(reconciled.reconciled,true);assert.equal(reconciled.runStatus,'saved');assert.equal(reconciled.project.revision,1);assert.equal(h.memory.size,0);assert.equal(h.posts().length,1);
  assert.equal((await second.save(reconciled.project)).status,'saved');assert.equal(h.posts().length,2);
});

test('unknown transaction cannot reconcile in another project and does not leak into another principal',async()=>{
  const h=setup();await h.sync.load();h.state.dropReply=true;await h.sync.save(withRecord(h));h.scope.projectId='other';
  assert.equal(h.sync.snapshot().status,'unknown');assert.equal((await h.sync.reconcile()).code,'PENDING_OTHER_PROJECT');assert.equal(h.posts().length,1);
  h.scope.principalId='another-public-operator';assert.equal(h.sync.snapshot().unknown,null);h.scope.principalId='fixture-public-operator';h.scope.projectId='default';
  assert.equal((await h.sync.reconcile()).reconciled,true);assert.equal(h.posts().length,1);
});

test('tampered, absent and restored-database receipts keep durable unknown without repost',async()=>{
  for(const mode of ['tamper','absent','epoch']){
    const h=setup();await h.sync.load();h.state.dropReply=true;const result=await h.sync.save(withRecord(h));
    if(mode==='tamper')h.receipts.get(result.operationId).resources.reverse();if(mode==='absent')h.receipts.clear();if(mode==='epoch')h.state.epoch='restored-db';
    assert.notEqual((await h.sync.reconcile()).status,'saved',mode);assert(h.sync.snapshot().unknown);assert.equal(h.memory.size,1);assert.equal(h.posts().length,1);
  }
});

test('confirmed historical receipt remains confirmed when latest aggregate reload is unavailable',async()=>{
  const h=setup();await h.sync.load();h.state.dropReply=true;await h.sync.save(withRecord(h));
  h.hook=url=>url.includes('/api/database/resources/')?response({success:false,...h.envelope(),code:'UNAVAILABLE'},503):undefined;
  const result=await h.sync.reconcile();assert.equal(result.status,'saved');assert.equal(result.reconciled,true);assert.equal(result.reloadRequired,true);assert.equal(result.project,undefined);assert.equal(h.memory.size,0);assert.equal(h.sync.snapshot().loaded,false);assert.equal(h.posts().length,1);
});

test('old epoch and authorization changes cannot save using previously loaded baseline',async()=>{
  for(const mode of ['epoch','revision','principal']){
    const h=setup();h.seed();const project=(await h.sync.load()).project;
    if(mode==='epoch')h.state.epoch='restored-db';if(mode==='revision')h.scope.accessRevision++;if(mode==='principal')h.scope.principalId='other';
    assert.notEqual((await h.sync.save(project)).status,'saved');assert.equal(h.posts().length,0);
  }
});

test('scope changes during deferred GET invalidate response and do not advance a different project',async()=>{
  const h=setup();h.seed();let release,entered;const entrance=new Promise(resolve=>entered=resolve);
  h.hook=(url,init)=>{if(url.includes('/api/database/resources/project_metadata/')){h.hook=null;entered();return new Promise(resolve=>release=()=>resolve(h.handle(url,init)));}};
  const loading=h.sync.load();await entrance;h.scope.projectId='other';release();assert.equal((await loading).status,'invalidated');assert.equal(h.sync.snapshot().loaded,false);assert.equal(h.posts().length,0);
});

test('more than 200 writes never splits into partial batches',async()=>{
  const h=setup();await h.sync.load();const project=h.project();project.data.planningHistory=Array.from({length:199},(_,n)=>record('r'+n));
  assert.equal((await h.sync.save(project)).code,'PROJECT_BATCH_TOO_LARGE');assert.equal(h.posts().length,0);assert.equal(h.resources.size,0);
});

test('untrusted inputs, wrong run project, and failed journal persistence send no request',async()=>{
  for(const mode of ['secret','run','storage']){
    const h=setup();await h.sync.load();const project=withRecord(h);let options={};
    if(mode==='secret')project.data.token='not-business';if(mode==='run')options={run:{projectId:'other'}};
    if(mode==='storage')h.storage.setItem=()=>{throw Error('fixture unavailable');};
    assert.notEqual((await h.sync.save(project,options)).status,'saved');assert.equal(h.posts().length,0);
  }
});

test('missing public principal returns unauthorized without synthesizing an identity',async()=>{
  const h=setup();delete h.scope.principalId;assert.equal((await h.sync.load()).status,'unauthorized');assert.equal(h.sync.snapshot().loaded,false);assert.equal(h.requests.length,0);
});

test('loopback host normalization stays HTTPS and never introduces an alternate control endpoint',async()=>{
  const h=setup();h.scope.baseUrl='https://localhost:8802';await h.sync.load();assert(h.requests.every(item=>new URL(item.url).origin==='https://127.0.0.1:8802'));
  h.scope.baseUrl='http://127.0.0.1:8802';assert.notEqual((await h.sync.load()).status,'loaded');assert(h.requests.every(item=>item.url.startsWith('https:')));
});

function provenanceFixture(h){
  const points=[{frequencyKHz:641000,levelDbm:-90},{frequencyKHz:641250,levelDbm:-85}];
  h.put('scans','scan-at-computation',{projectId:'default',name:'actual.csv',sourceKind:'imported_csv',frequencyUnit:'kHz',levelUnit:'dBm',points});
  const source={scope:clone(h.scope),epoch:h.state.epoch,scan:clone(h.get('scans','scan-at-computation'))};
  const profile={id:'catalog-profile',source:'custom',manufacturer:'DATYaudio',future:{intact:true}};
  const result={engineVersion:'exact-solver-v1',options:{scanPoints:clone(points)},profileSnapshots:[{deviceId:1,profile},{deviceId:2,profile:clone(profile)}]};
  return {source,result,profile,options:{run:{project_id:'default',input:{devices:[{id:1},{id:2}],options:{scanPoints:clone(points)}},result},provenance:source}};
}

test('computation-bound evidence is detached and invalidated when actual result input changes',()=>{
  const h=setup(),p=provenanceFixture(h),captured=factory.captureRunSources(p.source);
  factory.rememberRunSources(p.result,captured);p.source.scan.value.points[0].levelDbm=-10;
  assert.equal(factory.readRunSources(p.result).scan.value.points[0].levelDbm,-90);
  p.result.options.scanPoints[0].levelDbm=-40;assert.equal(factory.readRunSources(p.result),null);
  assert.equal(factory.readRunSources({...p.result}),null,'Arbitrary copied old result cannot acquire new-current proof');
});

test('computed Profile snapshots save exact per-run resources atomically, not a later catalog version',async()=>{
  const h=setup(),p=provenanceFixture(h);h.put('profiles','catalog-profile',{...p.profile,future:{intact:false}},9);await h.sync.load();
  const result=await h.sync.save(withRecord(h),p.options);assert.equal(result.status,'saved');
  const run=h.get('planning_runs','r1').value,profile=h.get('profiles','run-profile:r1:0');
  assert.equal(profile.revision,1);assert.equal(profile.value.source,'planning-snapshot');assert.equal(profile.value.originalSource,'custom');assert.equal(profile.value.originalProfileId,'catalog-profile');assert.equal(profile.value.future.intact,true);
  assert.equal(h.get('profiles','catalog-profile').revision,9);assert.deepEqual(run.result,p.result);
  assert.deepEqual(run.profileRefs,[{id:'run-profile:r1:0',revision:1}]);assert.equal(run.engineVersion,'exact-solver-v1');assert.equal(run.inputVerification,'computed-inputs-linked');assert.equal(run.scanId,'scan-at-computation');
  assert.deepEqual(JSON.parse(h.posts()[0].options.body).writes.map(item=>item.kind),['project_metadata','planning_records','planning_current','profiles','planning_runs']);
  assert.equal(h.posts().length,1);
});

test('scan reference stays with computation source even when current pointer later changes',async()=>{
  const h=setup(),p=provenanceFixture(h);h.put('scans','new-current',{...p.source.scan.value,name:'new.csv'});h.put('scan_current','default',{projectId:'default',scanId:'new-current'});await h.sync.load();
  assert.equal((await h.sync.save(withRecord(h),p.options)).status,'saved');assert.equal(h.get('planning_runs','r1').value.scanId,'scan-at-computation');
  assert(!h.requests.some(item=>item.url.includes('scan_current')),'Never reads a later current scan to manufacture provenance');
});

test('missing computation evidence removes claimed scan/profile references and preserves explicit unverified input',async()=>{
  const h=setup(),p=provenanceFixture(h);await h.sync.load();delete p.options.provenance;p.options.run.scanId='pretend-current';p.options.run.profileRefs=[{id:'pretend',revision:123}];
  assert.equal((await h.sync.save(withRecord(h),p.options)).status,'saved');const value=h.get('planning_runs','r1').value;
  assert.equal(value.scanId,undefined);assert.equal(value.inputVerification,'unverified');assert(value.inputEvidence.missing.includes('SCAN_COMPUTATION_SOURCE_UNCONFIRMED'));assert.equal(value.profileRefs[0].id,'run-profile:r1:0');
});

test('wrong epoch, operator, project, points and simulation sources cannot become real scan evidence',async()=>{
  for(const mode of ['epoch','operator','project','points','simulation']){
    const h=setup(),p=provenanceFixture(h);await h.sync.load();
    if(mode==='epoch')p.source.epoch='old-epoch';if(mode==='operator')p.source.scope.principalId='other';if(mode==='project')p.source.scan.value.projectId='other';
    if(mode==='points')p.source.scan.value.points[0].levelDbm=-10;if(mode==='simulation')p.source.scan.value.sourceKind='simulation';
    assert.equal((await h.sync.save(withRecord(h),p.options)).status,'saved');const value=h.get('planning_runs','r1').value;
    assert.equal(value.scanId,undefined,mode);assert.equal(value.inputVerification,'unverified');
  }
});

test('source changed since computation is reported missing, never relabelled to its newer revision',async()=>{
  const h=setup(),p=provenanceFixture(h);await h.sync.load();h.get('scans','scan-at-computation').revision=2;
  assert.equal((await h.sync.save(withRecord(h),p.options)).status,'saved');const value=h.get('planning_runs','r1').value;
  assert.equal(value.scanId,undefined);assert(value.inputEvidence.missing.includes('SCAN_SOURCE_CHANGED_OR_MISSING'));
});

test('lost profile+run batch response remains one journaled atomic operation and reconciles without re-saving profiles',async()=>{
  const h=setup(),p=provenanceFixture(h);await h.sync.load();h.state.dropReply=true;assert.equal((await h.sync.save(withRecord(h),p.options)).status,'unknown');
  const next=h.make();assert.equal((await next.reconcile()).status,'saved');assert.equal(h.posts().length,1);assert.equal(h.get('profiles','run-profile:r1:0').revision,1);
});

test('one original Profile ID with conflicting computed snapshots cannot save misleading bindings',async()=>{
  const h=setup(),p=provenanceFixture(h);await h.sync.load();p.result.profileSnapshots[1].profile.future.intact=false;
  assert.equal((await h.sync.save(withRecord(h),p.options)).code,'PROFILE_SNAPSHOT_CONFLICT');assert.equal(h.posts().length,0);
});
