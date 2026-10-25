'use strict';
// Candidate-only business persistence: memory storage, virtual HTTP and clocks.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const factory = require('../src/platform/database-client.js');
const PROTOCOL = factory.PROTOCOL;
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const flush = async () => { for(let i=0;i<30;i++) await Promise.resolve(); };
const response = (body, status=200) => ({status,ok:status>=200&&status<300,json:async()=>clone(body)});
const sharedState = () => ({epoch:'database-generation-1', resources:new Map(), receipts:new Map(), operation:0});
function harness(shared=sharedState(), memory=new Map()) {
  const requests=[], timers=new Map(); let nextTimer=0;
  const scope={baseUrl:'https://localhost:8802', accessRevision:1, principalId:'operator-public-1'};
  const storage={
    getItem(key){assert.equal(this,storage);return memory.get(key) ?? null;},
    setItem(key,value){assert.equal(this,storage);memory.set(key,value);},
    removeItem(key){assert.equal(this,storage);memory.delete(key);},
  };
  const ports={storage,
    readScope(){assert.equal(this,ports);return scope;},
    schedule(fn,ms){assert.equal(this,ports);const id=++nextTimer;timers.set(id,{fn,ms});return id;},
    cancel(id){assert.equal(this,ports);timers.delete(id);},
    newOperationId(){assert.equal(this,ports);return `database-operation-${++shared.operation}`;},
    request(url,options){assert.equal(this,ports);requests.push({url,options});return ports.handle(url,options);},
    handle(url,options){
      const path=new URL(url).pathname, envelope={protocol:PROTOCOL,epoch:shared.epoch};
      if(path==='/api/database/status')return response({...envelope,success:true});
      if(path.startsWith('/api/database/resources/')) {
        const [,kind,id]=path.match(/^\/api\/database\/resources\/([^/]+)\/(.+)$/);
        const resource=shared.resources.get(JSON.stringify([decodeURIComponent(kind),decodeURIComponent(id)]));
        return resource?response({...envelope,success:true,resource}):response({...envelope,success:false,code:'RESOURCE_NOT_FOUND'},404);
      }
      if(path.startsWith('/api/database/operations/')) {
        const op=decodeURIComponent(path.slice('/api/database/operations/'.length)),operation=shared.receipts.get(op);
        return operation?response({...envelope,success:true,operation}):response({...envelope,success:false,code:'OPERATION_NOT_FOUND'},404);
      }
      assert.equal(path,'/api/database/write'); assert.equal(options.method,'POST');
      const body=JSON.parse(options.body), key=JSON.stringify([body.kind,body.id]);
      if(body.epoch!==shared.epoch)return response({...envelope,success:false,code:'DATABASE_EPOCH_CHANGED'},409);
      const current=shared.resources.get(key);
      if(body.expected_revision!==(current?.revision||0))return response({...envelope,success:false,code:'RESOURCE_REVISION_CONFLICT'},409);
      const resource={kind:body.kind,id:body.id,revision:body.expected_revision+1,value:body.value,deleted:body.deleted};
      shared.resources.set(key,clone(resource));
      shared.receipts.set(body.operation_id,{operation_id:body.operation_id,status:'committed',resource:clone(resource)});
      return response({...envelope,success:true,operation_id:body.operation_id,resource});
    },
  };
  const make=()=>factory.create(ports), client=make();
  return {client,make,ports,storage,memory,scope,requests,timers,shared,
    posts:()=>requests.filter(item=>item.options.method==='POST'),
    expire(){const pending=[...timers.values()];for(const timer of pending){assert.equal(timer.ms,5000);timer.fn();}},
  };
}
const load=(h,kind='settings',id='alerts')=>h.client.load(kind,id);
const save=(h,value={rfWeakDbm:-90})=>h.client.save('settings','alerts',value);

test('actual access client candidate keeps credentials out of journal and handles eager 401 invalidation',async()=>{
  // The production allow-list remains untouched. The root integration must add
  // this exact project.write mapping before deploying either candidate module.
  let source=fs.readFileSync(require.resolve('../src/platform/access-client.js'),'utf8');
  if(!source.includes("'/api/database/write': 'project.write'")){
    const anchor="'/api/projects': 'project.write',";assert.equal(source.split(anchor).length,2);
    source=source.replace(anchor,anchor+" '/api/database/write': 'project.write',");
  }
  const sandbox={module:{exports:{}},URL,Headers,AbortController,require:require('node:module').createRequire(require.resolve('../src/platform/access-client.js'))};vm.runInNewContext(source,sandbox);
  const accessFactory=sandbox.module.exports;
  for(const subscribed of [false,true]){
    const h=harness(),handle=h.ports.handle;let posts=0;
    const auth=accessFactory.create({bridgeUrl:h.scope.baseUrl,transport:(url,options)=>{
      if(url.endsWith('/api/auth/status'))return response({success:true,auth:{protocol:'daty-access-v1',configured:true,authenticated:true,
        principal:{id:'operator-public-1',role:'operator'},permissions:['device.control','project.write','timeline.write','discovery.scan']}});
      if(options.method==='POST'){
        posts++;assert.match(options.headers.authorization,/^Bearer isolated-fixture-/);
        for(const raw of h.memory.values())assert.equal(raw.includes('isolated-fixture-credential'),false);
        return response({success:false},401);
      }
      return handle(url,options);
    }});
    await auth.authenticate('isolated-fixture-credential');
    h.ports.readScope=()=>{const state=auth.snapshot();return {baseUrl:state.origin,accessRevision:state.revision,principalId:state.principal?.id||'anonymous-public'};};
    h.ports.request=(url,options)=>auth.request(url,options);
    if(subscribed)auth.subscribe(()=>h.client.invalidate());
    await load(h);const before=auth.snapshot().revision,result=await save(h);await flush();
    // A synchronous subscription invalidates before the 401 Response reaches
    // this client. That already-returned result is conservative; the late 401
    // still clears only its exact journal, so reauthorization cannot get stuck.
    assert.equal(result.status,subscribed?'unknown':'invalidated');
    if(subscribed)assert.equal(result.invalidated,true);
    assert(auth.snapshot().revision>before);assert.equal(posts,1);assert.equal(h.memory.size,0);
    await auth.authenticate('isolated-fixture-credential');assert.equal((await save(h)).status,'unloaded');
  }
});
