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

test('factory has no browser facilities, mounts only when explicitly loaded',()=>{
  const sandbox={};
  for(const key of ['fetch','localStorage','document'])Object.defineProperty(sandbox,key,{get(){throw new Error('browser fallback');}});
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/platform/database-client.js'),'utf8'),sandbox);
  assert.equal(sandbox.DatyDatabaseClientFactory.PROTOCOL,PROTOCOL);
  assert.throws(()=>factory.create({}),/ports/);
});
test('load establishes a strict absent-resource baseline before a confirmed save',async()=>{
  const h=harness();assert.equal((await save(h)).status,'unloaded');assert.equal(h.requests.length,0);
  assert.deepEqual(await load(h),{status:'ready',epoch:h.shared.epoch,resource:null});
  const result=await save(h);assert.equal(result.status,'saved');assert.equal(result.resource.revision,1);
  assert.equal(h.memory.size,0);assert.equal(h.client.snapshot('settings','alerts').loaded,true);assert.equal(h.timers.size,0);
  assert(h.requests.every(item=>item.url.startsWith('https://127.0.0.1:8802/')));
  assert(h.requests.every(item=>item.options.redirect==='error'&&item.options.cache==='no-store'&&item.options.signal instanceof AbortSignal));
});
test('writes are journaled completely and synchronously before the single POST',async()=>{
  const h=harness();await load(h);const handle=h.ports.handle;
  h.ports.handle=(url,options)=>{
    if(options.method==='POST'){
      const [raw]=h.memory.values(), record=JSON.parse(raw);
      assert.deepEqual(record.body,JSON.parse(options.body));assert.deepEqual(record.scope,{baseUrl:'https://127.0.0.1:8802',principalId:h.scope.principalId});
      assert.equal(record.protocol,PROTOCOL);assert.equal(record.body.expected_revision,0);
    }
    return handle(url,options);
  };
  assert.equal((await save(h)).status,'saved');assert.equal(h.posts().length,1);
});
test('invalid HTTPS scope, public identity and resource identity cause no request',async()=>{
  for(const mutate of [h=>h.scope.baseUrl='http://127.0.0.1:8802',h=>h.scope.baseUrl='https://u:p@127.0.0.1:8802',h=>h.scope.baseUrl='https://127.0.0.1:8802/private',h=>h.scope.principalId='',h=>h.scope.accessRevision=null]){
    const h=harness();mutate(h);assert.equal((await load(h)).status,'error');assert.equal(h.requests.length,0);
  }
  const h=harness();assert.equal((await h.client.load('../devices','x')).status,'error');assert.equal((await h.client.load('settings','')).status,'error');assert.equal(h.requests.length,0);
});
test('business values reject credentials and non-JSON without invoking accessors',async()=>{
  const values=[{access_token:'never-store'},{nested:{AppSecret:'never-store'}},{password:'never-store'},{x:NaN},{x:undefined},{x:new Date()},[1,,3]];
  const cyclic={};cyclic.self=cyclic;values.push(cyclic);
  const getter={};Object.defineProperty(getter,'x',{enumerable:true,get(){assert.fail('getter invoked');}});values.push(getter);
  const hidden={};Object.defineProperty(hidden,'toJSON',{value(){assert.fail('toJSON invoked');}});values.push(hidden);
  for(const value of values){const h=harness();await load(h);assert.equal((await save(h,value)).status,'error');assert.equal(h.posts().length,0);assert.equal(h.memory.size,0);}
  const h=harness();await load(h);assert.equal((await save(h,{_source:'manual',session:'public-description',provenance:{url:'https://public.example/spec',verified:false}})).status,'saved');
});
test('journal quota failure, no-op storage and asynchronous storage fail closed before POST',async()=>{
  for(const replacement of [()=>{throw new Error('quota');},()=>{},()=>Promise.resolve()]){
    const h=harness();await load(h);h.storage.setItem=replacement;
    assert.equal((await save(h)).status,'error');assert.equal(h.posts().length,0);
  }
});
test('unsupported protocol, wrong resource and malformed 404 never establish a baseline',async()=>{
  for(const reply of [{success:true,epoch:'e'}, {success:true,protocol:PROTOCOL,epoch:'e',resource:{kind:'wrong',id:'alerts',revision:1,deleted:false,value:{}}}]){
    const h=harness();const handle=h.ports.handle;h.ports.handle=(url,options)=>url.includes('/resources/')?response(reply):handle(url,options);
    assert.equal((await load(h)).status,'error');assert.equal((await save(h)).status,'unloaded');
  }
  const h=harness();const handle=h.ports.handle;h.ports.handle=(url,options)=>url.includes('/resources/')?response({success:true,protocol:PROTOCOL,epoch:h.shared.epoch},404):handle(url,options);
  assert.equal((await load(h)).status,'error');
});
test('two clients cannot silently overwrite the same revision; conflict requires reload',async()=>{
  const shared=sharedState(),a=harness(shared),b=harness(shared);await load(a);await load(b);
  assert.equal((await save(a,{name:'first'})).status,'saved');const result=await save(b,{name:'second'});
  assert.equal(result.status,'conflict');assert.equal(b.memory.size,0);assert.equal((await save(b)).status,'unloaded');
  assert.equal(shared.resources.get('["settings","alerts"]').value.name,'first');assert.equal(b.posts().length,1);
});
test('different resources have independent revisions and busy protection',async()=>{
  const h=harness();await load(h);await h.client.load('settings','sound');const hold=deferred(),handle=h.ports.handle;
  h.ports.handle=(url,options)=>options.method==='POST'&&JSON.parse(options.body).id==='alerts'?hold.promise:handle(url,options);
  const pending=save(h);await flush();assert.equal((await save(h)).status,'busy');assert.equal((await load(h)).status,'busy');
  assert.equal((await h.client.save('settings','sound',{enabled:false})).status,'saved');
  hold.resolve(handle(h.posts()[0].url,h.posts()[0].options));assert.equal((await pending).status,'saved');assert.equal(h.posts().length,2);
});
test('lost commit reply survives controller recreation and reconciles only its exact receipt',async()=>{
  const h=harness();await load(h);const handle=h.ports.handle;
  h.ports.handle=(url,options)=>{const reply=handle(url,options);if(options.method==='POST')return Promise.reject(new Error('connection lost after commit'));return reply;};
  const result=await save(h,{value:4});assert.equal(result.status,'unknown');assert.equal(h.memory.size,1);
  h.client=h.make();assert.equal(h.client.snapshot('settings','alerts').status,'unknown');
  assert.equal((await load(h)).status,'unknown');assert.equal((await save(h)).status,'unknown');assert.equal(h.posts().length,1);
  h.ports.handle=handle;const settled=await h.client.reconcile('settings','alerts');assert.equal(settled.status,'reconciled');assert.equal(settled.resource.value.value,4);
  assert.equal(h.memory.size,0);assert.equal((await save(h)).status,'unloaded');assert.equal(h.posts().length,1);
  await load(h);assert.equal(h.client.snapshot('settings','alerts').resource.revision,1);
});
test('operation 404 is unresolved, never authority to replay a write',async()=>{
  const h=harness();await load(h);const handle=h.ports.handle;
  h.ports.handle=(url,options)=>options.method==='POST'?Promise.reject(new Error('unknown delivery')):handle(url,options);
  await save(h);const result=await h.client.reconcile('settings','alerts');
  assert.equal(result.status,'unknown');assert.equal(result.code,'OPERATION_NOT_FOUND');assert.equal(h.memory.size,1);assert.equal((await save(h)).status,'unknown');assert.equal(h.posts().length,1);
});
test('receipt must match operation, target, revision, deleted state and complete content',async()=>{
  for(const mutate of [op=>op.operation_id='another',op=>op.resource.id='other',op=>op.resource.revision++,op=>op.resource.deleted=true,op=>op.resource.value.extra=1,op=>op.status='accepted']){
    const h=harness();await load(h);const handle=h.ports.handle;
    h.ports.handle=(url,options)=>{const reply=handle(url,options);return options.method==='POST'?Promise.reject(new Error('lost')):reply;};
    const pending=await save(h,{a:1});mutate(h.shared.receipts.get(pending.operationId));h.ports.handle=handle;
    assert.equal((await h.client.reconcile('settings','alerts')).status,'unknown');assert.equal(h.memory.size,1);assert.equal(h.posts().length,1);
  }
});
test('database epoch change invalidates baselines and never clears an old pending write',async()=>{
  const h=harness();await load(h);const handle=h.ports.handle;
  h.ports.handle=(url,options)=>options.method==='POST'?Promise.reject(new Error('lost')):handle(url,options);
  await save(h);h.shared.epoch='restored-database-2';
  const result=await h.client.reconcile('settings','alerts');assert.equal(result.status,'unknown');assert.equal(result.code,'EPOCH_CHANGED');assert.equal(h.memory.size,1);
  assert.equal(h.requests.filter(item=>item.url.includes('/operations/')).length,0);
});
test('server epoch rejection is a definitive non-write requiring fresh load',async()=>{
  const h=harness();await load(h);h.shared.epoch='restored-database-2';
  const result=await save(h);assert.equal(result.status,'conflict');assert.equal(result.code,'DATABASE_EPOCH_CHANGED');assert.equal(h.memory.size,0);assert.equal(h.shared.receipts.size,0);
  assert.equal((await save(h)).status,'unloaded');assert.equal((await load(h)).epoch,h.shared.epoch);
});
test('five-second deadline covers response JSON and late success cannot mutate the baseline',async()=>{
  const h=harness();await load(h);const hold=deferred(),handle=h.ports.handle;
  h.ports.handle=(url,options)=>options.method==='POST'?{status:200,json:()=>hold.promise}:handle(url,options);
  const pending=save(h);await flush();h.expire();const result=await pending;
  assert.equal(result.status,'unknown');assert.equal(result.code,'REQUEST_TIMEOUT');assert.equal(h.timers.size,0);assert.equal(h.posts()[0].options.signal.aborted,true);
  hold.resolve(await handle(h.posts()[0].url,h.posts()[0].options).json());await flush();assert.equal(h.client.snapshot('settings','alerts').status,'unknown');assert.equal(h.memory.size,1);
});
test('read body timeout leaves no baseline or pending write',async()=>{
  const h=harness();h.ports.handle=()=>({status:200,json:()=>new Promise(()=>{})});
  const pending=load(h);await flush();h.expire();assert.equal((await pending).code,'REQUEST_TIMEOUT');assert.equal(h.client.snapshot('settings','alerts').loaded,false);assert.equal(h.memory.size,0);
});
test('synchronous known-unsent proof may release the journal, asynchronous claims cannot',async()=>{
  for(const synchronous of [true,false]){
    const h=harness();await load(h);const handle=h.ports.handle;
    h.ports.handle=(url,options)=>{if(options.method!=='POST')return handle(url,options);const error=Object.assign(new Error('not sent'),{knownUnsent:true});if(synchronous)throw error;return Promise.reject(error);};
    const result=await save(h);assert.equal(result.status,synchronous?'error':'unknown');assert.equal(h.memory.size,synchronous?0:1);assert.equal(h.posts().length,1);
  }
});
test('401 revocation before response settles only the exact journal and invalidates old authorization',async()=>{
  const h=harness();await load(h);const handle=h.ports.handle;
  h.ports.handle=(url,options)=>{if(options.method!=='POST')return handle(url,options);h.scope.accessRevision++;return {status:401,json(){assert.fail('401 body is not required');}};};
  const result=await save(h);assert.equal(result.status,'invalidated');assert.equal(h.memory.size,0);assert.equal(h.client.snapshot('settings','alerts').loaded,false);assert.equal(h.posts().length,1);
});
test('scope changes do not lose pending data across server or principal switches',async()=>{
  for(const field of ['baseUrl','principalId']){
    const h=harness();await load(h);const original=h.scope[field],hold=deferred(),handle=h.ports.handle;
    h.ports.handle=(url,options)=>options.method==='POST'?hold.promise:handle(url,options);
    const write=save(h);await flush();h.scope[field]=field==='baseUrl'?'https://192.0.2.16:8802':'other-public-principal';
    assert.equal(h.client.snapshot('settings','alerts').status,'unloaded');const result=await write;assert.equal(result.status,'unknown');assert.equal(result.invalidated,true);
    assert.equal(h.memory.size,1);h.scope[field]=original;assert.equal(h.client.snapshot('settings','alerts').status,'unknown');assert.equal((await save(h)).status,'unknown');assert.equal(h.posts().length,1);
    hold.reject(new Error('old request closed'));await flush();
  }
});
test('corrupt or namespace-mismatched journal is preserved and blocks all writes',async()=>{
  for(const corrupt of ['not json',JSON.stringify({protocol:PROTOCOL,scope:{},body:{}})]){
    const h=harness();await load(h);const handle=h.ports.handle;h.ports.handle=(url,options)=>options.method==='POST'?Promise.reject(new Error('lost')):handle(url,options);await save(h);
    const key=[...h.memory.keys()][0];h.memory.set(key,corrupt);h.client=h.make();assert.equal((await load(h)).code,'JOURNAL_INVALID');assert.equal((await save(h)).code,'JOURNAL_INVALID');assert.equal(h.memory.get(key),corrupt);assert.equal(h.posts().length,1);
  }
});
test('receipt cleanup failure stays unknown and can be reconciled without another POST',async()=>{
  const h=harness();await load(h);const remove=h.storage.removeItem;h.storage.removeItem=()=>{throw new Error('storage removal unavailable');};
  assert.equal((await save(h)).status,'unknown');assert.equal(h.memory.size,1);h.storage.removeItem=remove;
  assert.equal((await h.client.reconcile('settings','alerts')).status,'reconciled');assert.equal(h.posts().length,1);assert.equal(h.memory.size,0);
});
test('another controller journal cannot be erased or ignored just before send',async()=>{
  const h=harness();await load(h);const pending=save(h);const key=[...h.memory.keys()][0],record=JSON.parse(h.memory.get(key));
  record.body.operation_id='newer-operation';h.memory.set(key,JSON.stringify(record));
  const result=await pending;assert.equal(result.status,'unknown');assert.equal(h.posts().length,0);assert.equal(JSON.parse(h.memory.get(key)).body.operation_id,'newer-operation');
});
test('timer setup failure and invalid operation ID cannot send writes',async()=>{
  const h=harness();await load(h);h.ports.schedule=()=>{throw new Error('no timer');};assert.equal((await save(h)).status,'error');assert.equal(h.posts().length,0);assert.equal(h.memory.size,0);
  const b=harness();await load(b);b.ports.newOperationId=()=>null;assert.equal((await save(b)).status,'error');assert.equal(b.posts().length,0);assert.equal(b.memory.size,0);
});
test('tombstones retain CAS identity and snapshots cannot mutate the stored baseline',async()=>{
  const h=harness();await load(h);const input={nested:{label:'original'}};const result=await save(h,input);input.nested.label='mutated';result.resource.value.nested.label='also-mutated';
  assert.equal(h.client.snapshot('settings','alerts').resource.value.nested.label,'original');
  const removed=await h.client.save('settings','alerts',null,{deleted:true});assert.equal(removed.status,'saved');assert.equal(removed.resource.revision,2);assert.equal(removed.resource.deleted,true);
  h.client=h.make();const loaded=await load(h);assert.equal(loaded.resource.revision,2);assert.equal(loaded.resource.deleted,true);
  assert.equal((await save(h,{restored:true})).resource.revision,3);
});
test('resource IDs are encoded and epoch changes between status and resource fail closed',async()=>{
  const h=harness();assert.equal((await h.client.load('views','client/中文 ?#')).status,'ready');assert(h.requests[1].url.includes('client%2F'));
  const a=harness(),handle=a.ports.handle;a.ports.handle=(url,options)=>{if(url.includes('/resources/'))a.shared.epoch='changed-between-reads';return handle(url,options);};
  assert.equal((await load(a)).code,'EPOCH_CHANGED');assert.equal((await save(a)).status,'unloaded');
});
test('high-water list results are validated but never establish write baselines',async()=>{
  const h=harness();h.ports.handle=()=>response({success:true,protocol:PROTOCOL,epoch:h.shared.epoch,as_of:12,next_cursor:null,
    resources:[{kind:'settings',id:'alerts',revision:8,value:{enabled:true},deleted:false}]});
  const result=await h.client.list('settings');assert.equal(result.status,'ready');assert.equal(result.asOf,12);
  assert.equal((await save(h)).status,'unloaded');assert.equal(h.posts().length,0);assert.equal(h.timers.size,0);
});
test('malformed and repeated list entries or stale epochs cannot pass as a complete snapshot',async()=>{
  const h=harness();await load(h);const item={kind:'settings',id:'alerts',revision:1,value:{},deleted:false};
  h.ports.handle=()=>response({success:true,protocol:PROTOCOL,epoch:h.shared.epoch,as_of:1,next_cursor:null,resources:[item,item]});
  assert.equal((await h.client.list('settings')).code,'INVALID_LIST');
  h.ports.handle=()=>response({success:true,protocol:PROTOCOL,epoch:'new-epoch',as_of:1,next_cursor:null,resources:[item]});
  assert.equal((await h.client.list('settings')).code,'EPOCH_CHANGED');assert.equal(h.client.snapshot('settings','alerts').loaded,false);
  assert.equal((await h.client.list('settings',{limit:201})).status,'error');
});
