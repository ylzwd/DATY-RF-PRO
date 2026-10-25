'use strict';
// Real Node native request port -> certificate-verified HTTPS -> Unified API ->
// disposable SQLite. This file never accepts a server address or a DB path.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),https=require('node:https');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),crypto=require('node:crypto');
const scalarFactory=require('../src/platform/database-client.js');
const batchFactory=require('../src/platform/database-batch-client.js');
// Intentionally public test credential from tests/access_test_support.py.
const TEST_TOKEN='daty_0123456789abcdef_'+'A'.repeat(43);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

async function startFixture(){
  const bundled=path.resolve(__dirname,'../../tools/python/python.exe');
  const python=process.env.DATY_TEST_PYTHON||(fs.existsSync(bundled)?bundled:'python');
  const child=spawn(python,['-B','-u',path.join(__dirname,'unified-http-fixture.py'),'--stdio-fixture'],{
    cwd:path.resolve(__dirname,'..'),windowsHide:true,stdio:['pipe','pipe','pipe']
  });
  const ready=deferred(),closed=deferred(),pending=new Map();let sequence=0,stderr='';
  const deadline=setTimeout(()=>{ready.reject(Error('Temporary TLS fixture startup timed out'));child.kill();},20000);
  const lines=readline.createInterface({input:child.stdout});
  lines.on('line',line=>{
    try{
      const value=JSON.parse(line);
      if(value.event==='ready')ready.resolve(value);
      else if(pending.has(value.id)){pending.get(value.id).resolve(value);pending.delete(value.id);}
      else throw Error('Unexpected fixture reply');
    }catch(error){ready.reject(error);for(const item of pending.values())item.reject(error);pending.clear();}
  });
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-8000);});
  child.on('error',error=>{ready.reject(error);for(const item of pending.values())item.reject(error);pending.clear();});
  child.on('exit',code=>{
    const error=Error('Temporary TLS fixture exited '+code+(stderr?'\n'+stderr:''));
    ready.reject(error);for(const item of pending.values())item.reject(error);pending.clear();closed.resolve(code);
  });
  let info;
  try{info=await ready.promise;}finally{clearTimeout(deadline);}
  const origin=new URL(info.origin);
  assert.equal(origin.protocol,'https:');assert.equal(origin.hostname,'127.0.0.1');assert(origin.port&&Number(origin.port)>1024);
  assert.equal(info.temporary,true);assert.equal(info.device_commands,0);assert.match(info.ca,/BEGIN CERTIFICATE/);
  async function control(command){
    const id=++sequence,reply=deferred();pending.set(id,reply);
    const timer=setTimeout(()=>{pending.delete(id);reply.reject(Error('Fixture control timed out: '+command));},10000);
    child.stdin.write(JSON.stringify({id,command})+'\n');
    try{return await reply.promise;}finally{clearTimeout(timer);}
  }
  return {...info,control,async stop(){
    const timeout=setTimeout(()=>child.kill(),10000);
    try{await control('shutdown');child.stdin.end();assert.equal(await closed.promise,0);}finally{clearTimeout(timeout);lines.close();}
  }};
}

function nativeClient(server,{memory=new Map(),token=TEST_TOKEN}={}){
  const scope={baseUrl:server.origin,principalId:'0123456789abcdef',accessRevision:1},requests=[];
  const state={token};
  const storage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)};
  const ports={storage,readScope:()=>scope,schedule:setTimeout,cancel:clearTimeout,newOperationId:()=>crypto.randomUUID(),
    request(url,options={}){
      assert.equal(new URL(url).origin,server.origin,'Fixture port must never reach another server');
      assert(new URL(url).pathname.startsWith('/api/database/'),'No receiver or legacy control endpoint is allowed');
      assert.equal(options.redirect,'error');
      requests.push({url,method:options.method||'GET'});
      return new Promise((resolve,reject)=>{
        const headers={...options.headers};if(state.token!==null)headers.Authorization='Bearer '+state.token;
        if(options.body!==undefined)headers['Content-Length']=Buffer.byteLength(options.body);
        const request=https.request(url,{method:options.method||'GET',headers,ca:server.ca,rejectUnauthorized:true,
          minVersion:'TLSv1.2',agent:false,signal:options.signal},response=>{
          const chunks=[];let size=0;
          response.on('data',chunk=>{size+=chunk.length;if(size>1024*1024)response.destroy(Error('Fixture response exceeds 1 MiB'));else chunks.push(chunk);});
          response.on('aborted',()=>reject(Error('TLS response ended before declared Content-Length')));
          response.on('error',reject);
          response.on('end',()=>{
            if(!response.complete){reject(Error('Incomplete real HTTPS response'));return;}
            const raw=Buffer.concat(chunks).toString('utf8');
            resolve({status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300,json:async()=>JSON.parse(raw)});
          });
        });
        request.on('error',reject);request.end(options.body);
      });
    }};
  const client=scalarFactory.create(ports),batch=batchFactory.create({...ports,resourceClient:client,journalId:'tls-fixture'});
  return {client,batch,ports,memory,requests,state,scope,posts:()=>requests.filter(item=>item.method==='POST')};
}

test('native database host over genuine disposable TLS and SQLite',{timeout:60000},async t=>{
  const server=await startFixture();let passed=0,totalPosts=0;
  try{
    await t.test('CA validation is required; authenticated baseline traverses real HTTP',async()=>{
      const before=await server.control('stats');
      await assert.rejects(new Promise((resolve,reject)=>{
        const request=https.get(server.origin+'/api/database/status',{rejectUnauthorized:true,agent:false},response=>{response.resume();resolve();});
        request.on('error',reject);
      }),/certificate|issuer|self.signed/i);
      assert.equal((await server.control('stats')).db_accesses,before.db_accesses);
      const h=nativeClient(server),ready=await h.client.load('settings','alert_sound');
      assert.equal(ready.status,'ready');assert.equal(ready.resource,null);assert(h.requests.length===2);passed++;
    });
    await t.test('two independent clients racing one revision produce one commit and one conflict',async()=>{
      await server.control('reset');const a=nativeClient(server),b=nativeClient(server);
      await Promise.all([a.client.load('settings','alert_sound'),b.client.load('settings','alert_sound')]);
      const results=await Promise.all([a.client.save('settings','alert_sound',{enabled:true}),b.client.save('settings','alert_sound',{enabled:false})]);
      assert.deepEqual(results.map(item=>item.status).sort(),['conflict','saved']);
      const stats=await server.control('stats');assert.equal(stats.resources,1);assert.equal(stats.versions,1);assert.equal(stats.operations,1);assert.equal(stats.audit,1);
      assert.equal(a.memory.size+b.memory.size,0);totalPosts+=a.posts().length+b.posts().length;passed++;
    });
    await t.test('invalid second batch member rolls back the first member and every receipt',async()=>{
      await server.control('reset');const h=nativeClient(server);
      for(const id of ['alert_sound','auto_frequency'])assert.equal((await h.client.load('settings',id)).status,'ready');
      const result=await h.batch.save([{kind:'settings',id:'alert_sound',value:{enabled:true}},{kind:'settings',id:'auto_frequency',value:{enabled:'false'}}]);
      assert.equal(result.status,'rejected');assert.equal(h.memory.size,0);
      const stats=await server.control('stats');for(const key of ['resources','versions','operations','batches','audit'])assert.equal(stats[key],0,key);
      totalPosts+=h.posts().length;passed++;
    });
    await t.test('batch stale member conflict cannot partially commit another member',async()=>{
      await server.control('reset');const a=nativeClient(server),b=nativeClient(server);
      for(const id of ['alert_sound','auto_frequency'])await a.client.load('settings',id);
      await b.client.load('settings','auto_frequency');assert.equal((await b.client.save('settings','auto_frequency',{enabled:true})).status,'saved');
      assert.equal((await a.batch.save([{kind:'settings',id:'alert_sound',value:{enabled:true}},{kind:'settings',id:'auto_frequency',value:{enabled:false}}])).status,'conflict');
      assert.equal((await a.client.load('settings','alert_sound')).resource,null);
      assert.equal((await a.client.load('settings','auto_frequency')).resource.value.enabled,true);
      const stats=await server.control('stats');assert.equal(stats.resources,1);assert.equal(stats.operations,1);assert.equal(stats.batches,0);
      totalPosts+=a.posts().length+b.posts().length;passed++;
    });
    await t.test('lost scalar reply survives controller reconstruction and reconciles the historical exact receipt',async()=>{
      await server.control('reset');const first=nativeClient(server);await first.client.load('settings','alert_sound');
      await server.control('drop_next_post_reply');const lost=await first.client.save('settings','alert_sound',{enabled:true});
      assert.equal(lost.status,'unknown');assert.equal(first.memory.size,1);
      const other=nativeClient(server);await other.client.load('settings','alert_sound');assert.equal((await other.client.save('settings','alert_sound',{enabled:false})).status,'saved');
      const next=nativeClient(server,{memory:first.memory});assert.equal(next.client.snapshot('settings','alert_sound').status,'unknown');
      assert.equal((await next.client.save('settings','alert_sound',{enabled:true})).status,'unknown');assert.equal(next.posts().length,0);
      const receipt=await next.client.reconcile('settings','alert_sound');assert.equal(receipt.status,'reconciled');assert.equal(receipt.resource.revision,1);assert.equal(receipt.resource.value.enabled,true);
      assert.equal(next.memory.size,0);assert.equal(next.posts().length,0);assert.equal((await next.client.load('settings','alert_sound')).resource.revision,2);
      assert.equal((await server.control('stats')).operations,2);totalPosts+=first.posts().length+other.posts().length;passed++;
    });
    await t.test('lost atomic batch reply is recovered by ordered exact receipt GET without repeating POST',async()=>{
      await server.control('reset');const first=nativeClient(server);
      const inputs=[{kind:'settings',id:'alert_sound',value:{enabled:true}},{kind:'settings',id:'auto_frequency',value:{enabled:false}}];
      for(const item of inputs)await first.client.load(item.kind,item.id);
      await server.control('drop_next_post_reply');const lost=await first.batch.save(inputs);assert.equal(lost.status,'unknown');assert.equal(first.memory.size,1);
      const next=nativeClient(server,{memory:first.memory});assert.equal(next.batch.snapshot().status,'unknown');
      for(const item of inputs)await next.client.load(item.kind,item.id);
      assert.equal((await next.batch.save(inputs)).status,'unknown');assert.equal(next.posts().length,0);
      const receipt=await next.batch.reconcile();assert.equal(receipt.status,'reconciled');assert.deepEqual(receipt.resources.map(item=>item.id),['alert_sound','auto_frequency']);
      assert.deepEqual(receipt.resources.map(item=>item.revision),[1,1]);assert.deepEqual(receipt.resources.map(item=>item.value),inputs.map(item=>item.value));
      assert.equal(next.memory.size,0);assert.equal(next.posts().length,0);
      const stats=await server.control('stats');assert.equal(stats.batches,1);assert.equal(stats.operations,2);assert.equal(stats.resources,2);
      totalPosts+=first.posts().length;passed++;
    });
    await t.test('restored epoch refuses old baselines and preserves unresolved old-epoch journal',async()=>{
      await server.control('reset');const pending=nativeClient(server),stale=nativeClient(server);
      await pending.client.load('settings','alert_sound');await stale.client.load('settings','auto_frequency');
      await server.control('drop_next_post_reply');assert.equal((await pending.client.save('settings','alert_sound',{enabled:true})).status,'unknown');
      const changed=await server.control('rotate_epoch');assert.notEqual(changed.epoch,changed.previous_epoch);
      const next=nativeClient(server,{memory:pending.memory});const outcome=await next.client.reconcile('settings','alert_sound');
      assert.equal(outcome.status,'unknown');assert.equal(outcome.code,'EPOCH_CHANGED');assert.equal(next.memory.size,1);
      assert.equal(next.requests.filter(item=>new URL(item.url).pathname.startsWith('/api/database/operations/')).length,0);
      const rejected=await stale.client.save('settings','auto_frequency',{enabled:true});assert.equal(rejected.status,'conflict');assert.equal(rejected.code,'DATABASE_EPOCH_CHANGED');
      assert.equal(stale.memory.size,0);assert.equal((await server.control('stats')).operations,1);
      totalPosts+=pending.posts().length+stale.posts().length;passed++;
    });
    await t.test('401 rejects reads and writes before SQLite access and clears only definitively refused intent',async()=>{
      await server.control('reset');const denied=nativeClient(server,{token:null}),before=await server.control('stats');
      assert.equal((await denied.client.load('settings','alert_sound')).status,'unauthorized');assert.equal((await server.control('stats')).db_accesses,before.db_accesses);
      const h=nativeClient(server);await h.client.load('settings','alert_sound');const loaded=await server.control('stats');h.state.token=null;
      assert.equal((await h.client.save('settings','alert_sound',{enabled:true})).status,'unauthorized');assert.equal(h.memory.size,0);
      const stats=await server.control('stats');assert.equal(stats.db_accesses,loaded.db_accesses);assert.equal(stats.operations,0);assert.equal(stats.resources,0);
      totalPosts+=h.posts().length;passed++;
    });
    const final=await server.control('stats');assert.equal(final.device_commands,0);assert.equal(final.foreign_key_errors,0);
    t.diagnostic(JSON.stringify({transport:'verified-temporary-https',checks:passed,actualPosts:totalPosts,deviceCommands:0,productionWrites:0}));
  }finally{await server.stop();}
});
