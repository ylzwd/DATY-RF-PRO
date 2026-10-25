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
const accessFactory=require('../src/platform/access-client.js');
function accessStatus(){return response({success:true,auth:{protocol:'daty-access-v1',configured:true,authenticated:true,
  principal:{id:'isolated-operator',role:'operator'},permissions:['device.control','project.write','timeline.write','discovery.scan']}});}
test('real DatyAccess 401 generation change releases only the refused write, with and without immediate invalidation',async()=>{
  for(const subscribed of [false,true]){
    const h=harness(),original=h.ports.handle;let posts=0;
    const auth=accessFactory.create({bridgeUrl:h.scope.baseUrl,transport:(url,options)=>{
      if(url.endsWith('/api/auth/status'))return Promise.resolve(accessStatus());
      if(options.method==='POST'){posts++;return Promise.resolve(response({success:false},401));}
      return original(url,options);
    }});
    await auth.authenticate('isolated-fixture-key');
    h.ports.readScope=function(){const current=auth.snapshot();return {baseUrl:current.origin,projectId:'default',accessRevision:current.revision};};
    h.ports.request=function(url,options){return auth.request(url,options);};
    if(subscribed)auth.subscribe(()=>h.api.invalidate());
    await h.api.load();const oldRevision=auth.snapshot().revision;
    const result=await h.api.save(project(),{run:{input:{},result:{}}});await flush();
    assert.equal(result.status,'invalidated');assert.ok(auth.snapshot().revision>oldRevision);
    assert.equal(h.api.snapshot().unknown,null);assert.equal(h.api.snapshot().loaded,false);assert.equal(posts,1);
    await auth.authenticate('isolated-fixture-key');
    assert.equal((await h.api.save(project())).code,'BASELINE_REQUIRED');
    assert.equal((await h.api.load()).status,'loaded');assert.equal(posts,1);
  }
});
test('a late old-server 401 cannot revoke a new real access session or clear its separate unknown write',async()=>{
  const h=harness(),oldPost=deferred(),newPost=deferred();let selected='https://127.0.0.1:8802';const posted=[];
  const auth=accessFactory.create({getBridgeUrl:()=>selected,transport:(url,options)=>{
    if(url.endsWith('/api/auth/status'))return Promise.resolve(accessStatus());
    if(options.method==='POST'){posted.push(url);return url.startsWith('https://127.0.0.1:')?oldPost.promise:newPost.promise;}
    return Promise.resolve(response({success:true,revision_protocol:PROTOCOL,project:project()}));
  }});
  await auth.authenticate('isolated-fixture-old');
  h.ports.readScope=function(){const current=auth.snapshot();return {baseUrl:current.origin,projectId:'default',accessRevision:current.revision};};
  h.ports.request=function(url,options){return auth.request(url,options);};
  auth.subscribe(()=>h.api.invalidate());
  await h.api.load();const oldSaving=h.api.save(project());await flush();
  selected='https://192.0.2.2:8802';await auth.authenticate('isolated-fixture-new');await h.api.load();
  const newSaving=h.api.save(project());await flush();const revision=auth.snapshot().revision;
  oldPost.resolve(response({success:false},401));await oldSaving;await flush();
  assert.equal(auth.snapshot().origin,selected);assert.equal(auth.snapshot().authenticated,true);assert.equal(auth.snapshot().revision,revision);
  assert.equal(h.api.snapshot().unknown.phase,'project');assert.equal(h.api.snapshot().pending,'save');
  newPost.resolve(response({success:true,project_id:'default',revision:2,revision_protocol:PROTOCOL}));assert.equal((await newSaving).status,'saved');
  selected='https://127.0.0.1:8802';await auth.authenticate('isolated-fixture-old');assert.equal((await h.api.load()).status,'loaded');
  assert.equal(posted.length,2);
});
