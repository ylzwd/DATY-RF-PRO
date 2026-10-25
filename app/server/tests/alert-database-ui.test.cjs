'use strict';
// Isolated UI/repository regressions: no browser, production database, or device.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const crypto=require('node:crypto');
const repositoryFactory=require('../src/platform/alert-database.js');
const scalarFactory=require('../src/platform/database-client.js');
const batchFactory=require('../src/platform/database-batch-client.js');
const {fixture:businessFixture,clone}=require('./business-db-fixture.cjs');
const uiSource=fs.readFileSync(path.join(__dirname,'../src/app/alert-database.js'),'utf8');
const alert=(extra={})=>({archiveId:'a1',deviceId:'fixture_rx_ch1',metric:'rf',firstSeen:1,lastSeen:2,archiveState:'active',value:-90,threshold:-80,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const drain=()=>new Promise(resolve=>setImmediate(resolve));

function mount({storage,scope,clientFactory,batchClientFactory,request=()=>{throw Error('No network allowed');}}){
  const listeners=new Set();
  const global={DatyPlatform:{storage},DatyDatabaseConnection:{
    snapshot:()=>({origin:scope.baseUrl,source:{id:scope.principalId},revision:scope.accessRevision}),
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},request
  },DatyHostFactory:{invokeRuntime(_global,name,...args){return {setTimeout,clearTimeout}[name](...args);}},
  DatyDatabaseClientFactory:{create:clientFactory},DatyDatabaseBatchFactory:{create:batchClientFactory},
  DatyAlertDatabaseFactory:repositoryFactory};
  vm.runInNewContext(uiSource,global,{filename:'src/app/alert-database.js'});
  const ui=global.DatyAlertDatabaseUI.mount(global);
  return {ui,global,changeScope(change){Object.assign(scope,change);for(const listener of listeners)listener();}};
}

function setup({records=[],legacy=[],listHook,saveHook}={}){
  const rows=new Map(records.map(value=>[value.archiveId,{kind:'alerts',id:value.archiveId,revision:1,value:clone(value),deleted:false}]));
  const memory=new Map([['daty_db_alerts',JSON.stringify(legacy)]]),baselines=new Map(),saves=[];
  const scope={baseUrl:'https://127.0.0.1:8802',principalId:'fixture-operator',accessRevision:1};
  let lists=0;
  const storage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)};
  const client={
    list(_kind,{limit,cursor}){
      const number=++lists,offset=cursor===null?0:Number(cursor),all=[...rows.values()].map(clone);
      const result={status:'ready',resources:all.slice(offset,offset+limit),cursor:offset+limit<all.length?String(offset+limit):null,epoch:'fixture-epoch',asOf:1};
      return Promise.resolve(listHook?listHook({number,result,rows}):result);
    },
    async load(_kind,id){const resource=clone(rows.get(id)||null);baselines.set(id,resource?.revision||0);return {status:'ready',resource,epoch:'fixture-epoch'};},
    invalidate(){baselines.clear();}
  };
  const batch={
    async save(writes){
      saves.push(clone(writes));
      const commit=()=>{
        if(writes.some(item=>(rows.get(item.id)?.revision||0)!==baselines.get(item.id)))return {status:'conflict',code:'FIXTURE_CONFLICT'};
        const resources=writes.map(item=>({...clone(item),revision:(rows.get(item.id)?.revision||0)+1,deleted:item.deleted===true}));
        for(const row of resources)rows.set(row.id,row);
        return {status:'saved',resources};
      };
      return saveHook?saveHook({number:saves.length,writes,commit,rows}):commit();
    },
    snapshot:()=>({pending:null,unknown:null}),invalidate(){},async reconcile(){return {status:'unloaded'};}
  };
  return {...mount({storage,scope,clientFactory:()=>client,batchClientFactory:()=>batch}),rows,memory,saves,client,batch,scope,get lists(){return lists;}};
}

test('same-ID local ended / server active conflict remains visible and blocks destructive clear',async()=>{
  const local=alert({archiveState:'ended',lastSeen:3,endedAt:3});
  const h=setup({records:[alert()],legacy:[local]});await h.ui.load();
  assert.match(h.ui.status().warning,/1 条旧告警/);
  assert.equal(h.ui.records()[0].archiveState,'ended');
  await assert.rejects(h.ui.clearAll(),/旧告警尚未迁移/);
  assert.deepEqual(JSON.parse(h.memory.get('daty_db_alerts')),[local]);assert.equal(h.saves.length,0);
});

test('flush cannot reuse a pre-commit list as its post-commit readback',async()=>{
  const old=deferred();const h=setup({listHook:({number,result})=>number===1?old.promise:result});
  const saved=h.ui.flush([alert()]);await drain();
  assert.equal(h.rows.size,1);assert.equal(h.lists,1);
  old.resolve({status:'ready',resources:[],cursor:null,epoch:'fixture-epoch',asOf:0});
  const result=await saved;
  assert.equal(result.success,true);assert.equal(result.readBackConfirmed,true);assert.equal(h.lists,2);
  assert.equal(h.ui.records().length,1);assert.equal(result.count,1);
});

test('server switch starts a fresh list and ignores late old-scope data',async()=>{
  const old=deferred(),fresh=deferred();
  const h=setup({listHook:({number,result})=>number===1?old.promise:number===2?fresh.promise:result});
  const previous=h.ui.load();h.changeScope({baseUrl:'https://192.0.2.16:8802'});
  assert.equal(h.lists,2);assert.equal(h.ui.status().loaded,false);
  fresh.resolve({status:'ready',resources:[{kind:'alerts',id:'new',revision:1,deleted:false,value:alert({archiveId:'new'})}],cursor:null,epoch:'fixture-epoch',asOf:2});
  await h.ui.load();old.resolve({status:'ready',resources:[{kind:'alerts',id:'old',revision:1,deleted:false,value:alert({archiveId:'old'})}],cursor:null,epoch:'old',asOf:1});
  assert.equal((await previous).success,false);assert.equal(h.ui.records()[0].archiveId,'new');
  assert.equal(h.ui.status().loaded,true);assert.equal(h.lists,2);
});

test('same-server same-identity logout generation rejects its late old read',async()=>{
  const old=deferred();const h=setup({records:[alert({archiveId:'current'})],listHook:({number,result})=>number===1?old.promise:result});
  const prior=h.ui.load();h.changeScope({accessRevision:2});await h.ui.load();
  old.resolve({status:'ready',resources:[{kind:'alerts',id:'old',revision:1,deleted:false,value:alert({archiveId:'old'})}],cursor:null,epoch:'fixture-epoch',asOf:1});
  assert.equal((await prior).success,false);assert.equal(h.ui.records()[0].archiveId,'current');assert.equal(h.lists,2);
});

test('clearAll uses bounded 200-record batches and confirms final list before replacing mirror',async()=>{
  const records=Array.from({length:405},(_,index)=>alert({archiveId:'a'+index,firstSeen:index,lastSeen:index+1}));
  const h=setup({records,legacy:records});await h.ui.load();
  assert.equal(await h.ui.clearAll(),405);assert.deepEqual(h.saves.map(items=>items.length),[200,200,5]);
  assert(h.saves.every(items=>items.every(item=>item.deleted===true&&item.value===null)));
  assert.deepEqual(JSON.parse(h.memory.get('daty_db_alerts')),[]);assert.equal(h.ui.records().length,0);
  assert.equal([...h.rows.values()].filter(row=>row.deleted).length,405);
});

test('clearAll reports partial commit and preserves all original local mirror records',async()=>{
  const records=Array.from({length:405},(_,index)=>alert({archiveId:'a'+index,firstSeen:index,lastSeen:index+1}));
  const h=setup({records,legacy:records,saveHook:({number,commit})=>number===2?{status:'conflict',code:'RESOURCE_REVISION_CONFLICT'}:commit()});
  await h.ui.load();await assert.rejects(h.ui.clearAll(),/已标记删除 200 条/);
  assert.deepEqual(h.saves.map(items=>items.length),[200,200]);
  assert.equal([...h.rows.values()].filter(row=>row.deleted).length,200);
  assert.deepEqual(JSON.parse(h.memory.get('daty_db_alerts')),records);
});

test('clearAll final list failure does not announce success or erase the local mirror',async()=>{
  const original=alert();const h=setup({records:[original],legacy:[original],listHook:({number,result})=>number===2?{status:'error',code:'OFFLINE',message:'offline'}:result});
  await h.ui.load();await assert.rejects(h.ui.clearAll(),/删除已提交 1 条，但列表未确认/);
  assert.equal(h.rows.get('a1').deleted,true);assert.deepEqual(JSON.parse(h.memory.get('daty_db_alerts')),[original]);
});

test('clearAll rejects a newer revision observed after the confirmation list',async()=>{
  const h=setup({records:[alert()],legacy:[alert()]});await h.ui.load();
  h.rows.get('a1').revision=2;h.rows.get('a1').value.lastSeen=5;
  await assert.rejects(h.ui.clearAll(),/已有新版本/);assert.equal(h.saves.length,0);assert.equal(h.rows.get('a1').deleted,false);
});

test('server change during clear stops subsequent batches and retains old local mirror',async()=>{
  const held=deferred(),records=Array.from({length:201},(_,index)=>alert({archiveId:'a'+index,firstSeen:index,lastSeen:index+1}));
  const h=setup({records,legacy:records,saveHook:({commit})=>{const result=commit();return held.promise.then(()=>result);}});
  await h.ui.load();const clearing=h.ui.clearAll();await drain();
  h.changeScope({baseUrl:'https://192.0.2.16:8802'});held.resolve();
  await assert.rejects(clearing,/服务器已切换/);assert.equal(h.saves.length,1);
  assert.deepEqual(JSON.parse(h.memory.get('daty_db_alerts')),records);
});

function setupReal(h=businessFixture()){
  return {...mount({storage:h.storage,scope:h.scope,clientFactory:ports=>scalarFactory.create(ports),batchClientFactory:ports=>batchFactory.create(ports),request:(...args)=>h.ports.request(...args)}),fixture:h};
}
const posts=h=>h.requests.filter(item=>item.options.method==='POST');

test('real lost batch reply is durably journaled across UI reconstruction and reconciled using GET only',async()=>{
  const h=businessFixture(),first=setupReal(h);await first.ui.load();h.state.dropReply=true;
  const lost=await first.ui.flush([alert()]);assert.equal(lost.success,false);assert.equal(lost.status,'unknown');
  assert.equal(posts(h).length,1);assert.equal(h.memory.size,1);
  assert.equal(first.ui.status().pending.status,'unknown');
  // Even an equal GET value is not the exact durable transaction receipt.
  const unchanged=await first.ui.flush([alert()]);assert.equal(unchanged.status,'unknown');assert.equal(unchanged.success,false);
  await assert.rejects(first.ui.clearAll(),/尚未核对/);assert.equal(posts(h).length,1);assert.equal(h.memory.size,1);
  first.ui.dispose();const next=setupReal(h);await next.ui.load();
  assert.equal(next.ui.status().pending.status,'unknown');
  // A new lifecycle while a receipt is unknown must not trigger a second POST.
  const blocked=await next.ui.flush([alert({lastSeen:5})]);assert.equal(blocked.status,'unknown');assert.equal(posts(h).length,1);
  const reconciled=await next.ui.reconcile();assert.equal(reconciled.status,'reconciled');assert.equal(h.memory.size,0);assert.equal(posts(h).length,1);
  assert(h.requests.some(item=>new URL(item.url).pathname.startsWith('/api/database/operations/')));
  assert.equal((await next.ui.load({fresh:true})).success,true);assert.equal(next.ui.records()[0].lastSeen,2);
});

test('late successful POST after logout cannot clear durable receipt or publish old-scope success',async()=>{
  const h=businessFixture(),held=deferred(),started=deferred();
  h.ports.request=(url,options={})=>{
    const result=h.handle(url,options);
    if(options.method==='POST'){started.resolve();return held.promise.then(()=>result);}return result;
  };
  const app=setupReal(h);await app.ui.load();const saving=app.ui.flush([alert()]);await started.promise;
  app.changeScope({accessRevision:2});const outcome=await saving;
  assert.equal(outcome.success,false);assert.equal(outcome.status,'unknown');assert.equal(h.memory.size,1);
  held.resolve();await drain();assert.equal(h.memory.size,1);assert.equal(posts(h).length,1);
  assert.equal((await app.ui.reconcile()).status,'reconciled');assert.equal(h.memory.size,0);assert.equal(posts(h).length,1);
});

function mountArchiveButton(app){
  // Historical UDB candidate only. Keep its original SHA guard; never recapture it from deployed source.
  const source=fs.readFileSync(path.join(__dirname,'fixtures/udb-alert-history-baseline.txt'));
  const hash=crypto.createHash('sha256').update(source).digest('hex');
  let text=source.toString('utf8').replace(/\r\n/g,'\n');
  for(const name of ['udb-alert-history','udb-alert-review']){
    const patch=JSON.parse(fs.readFileSync(path.join(__dirname,'../patches/'+name+'.json'),'utf8'));
    assert.equal(patch.sourceSha256,hash);
    for(const change of patch.changes){
      const before=change.before.replace(/\r\n/g,'\n'),index=text.indexOf(before);
      assert(index>=0&&text.indexOf(before,index+1)<0,'Unique reviewed patch anchor: '+change.id);
      text=text.slice(0,index)+change.after.replace(/\r\n/g,'\n')+text.slice(index+before.length);
    }
  }
  const notifications=[];
  Object.assign(app.global,{document:{getElementById:()=>null},ALERTS:[],renderLog(){},notify:(...args)=>notifications.push(args)});
  Object.defineProperty(app.global,'confirm',{get(){assert.fail('Browser confirm fallback is forbidden');}});
  vm.runInNewContext(text,app.global,{filename:'candidate/alert-history.js'});
  return {click:()=>app.global.exportAlertsToDB(),notifications};
}

async function unknownApp(){
  const h=businessFixture(),app=setupReal(h);await app.ui.load();h.state.dropReply=true;
  assert.equal((await app.ui.flush([alert()])).status,'unknown');return {h,app};
}

test('historical candidate archive button requests DatyDialogs confirmation then only GETs the exact unknown receipt',async()=>{
  const {h,app}=await unknownApp(),decision=deferred(),dialogs=[];
  const queued=JSON.stringify([alert({lastSeen:5})]);h.memory.set('daty_pending_alerts_v1',queued);
  app.global.DatyDialogs={confirm(options){dialogs.push(options);return decision.promise;}};
  const button=mountArchiveButton(app),before=h.requests.length,click=button.click();
  await drain();assert.equal(dialogs.length,1);assert.match(dialogs[0].title,/只读核对/);
  assert.match(dialogs[0].warnings.join(' '),/不重发/);assert.equal(h.requests.length,before);
  decision.resolve(true);await click;
  const requests=h.requests.slice(before);
  assert.equal(requests.filter(item=>new URL(item.url).pathname.startsWith('/api/database/operations/')).length,1);
  assert(requests.every(item=>item.options.method!=='POST'));assert.equal(posts(h).length,1);
  assert.equal(h.memory.get('daty_pending_alerts_v1'),queued);
  assert.equal(app.ui.status().pending,null);assert.equal(app.ui.records()[0].archiveId,'a1');
  assert.match(button.notifications.at(-1)[2],/本次没有重发保存/);
});

test('cancelling the historical candidate archive button review issues zero GET or POST and preserves pending intent',async()=>{
  for(const answer of [false,null,undefined,'true']){
    const {h,app}=await unknownApp();app.global.DatyDialogs={confirm:async()=>answer};
    const before=h.requests.length,journals=[...h.memory],button=mountArchiveButton(app);
    await button.click();assert.equal(h.requests.length,before);assert.deepEqual([...h.memory],journals);
    assert.equal(app.ui.status().pending.status,'unknown');assert.equal(posts(h).length,1);
    assert(!button.notifications.some(item=>item[0]==='✓'));
  }
});

test('missing application dialog cannot start reconciliation or fall back to browser confirmation',async()=>{
  const {h,app}=await unknownApp(),before=h.requests.length;
  assert.equal((await app.ui.reviewPending()).status,'error');assert.equal(h.requests.length,before);
  assert.equal(app.ui.status().pending.status,'unknown');
});

test('server or authorization change while review dialog is open cannot reconcile another scope',async()=>{
  for(const change of [{baseUrl:'https://192.0.2.16:8802'},{accessRevision:2}]){
    const {h,app}=await unknownApp(),decision=deferred();app.global.DatyDialogs={confirm:()=>decision.promise};
    const reviewing=app.ui.reviewPending();app.changeScope(change);await app.ui.load();
    const before=h.requests.length;decision.resolve(true);
    assert.equal((await reviewing).status,'invalidated');assert.equal(h.requests.length,before);
    assert.equal(h.requests.filter(item=>new URL(item.url).pathname.startsWith('/api/database/operations/')).length,0);
    assert.equal(h.memory.size,1);assert.equal(posts(h).length,1);
  }
});

test('late receipt following authorization switch cannot clear the old journal or produce review success',async()=>{
  const {h,app}=await unknownApp(),held=deferred(),started=deferred();app.global.DatyDialogs={confirm:async()=>true};
  h.ports.request=(url,options)=>{
    const response=h.handle(url,options);
    if(new URL(url).pathname.startsWith('/api/database/operations/')){started.resolve();return held.promise.then(()=>response);}
    return response;
  };
  const reviewing=app.ui.reviewPending();await started.promise;app.changeScope({accessRevision:2});
  assert.equal((await reviewing).status,'invalidated');held.resolve();await drain();
  assert.equal(h.memory.size,1);assert.equal(posts(h).length,1);
});

test('scope change during review readback must not report old-server reconciliation as current success',async()=>{
  const {h,app}=await unknownApp(),held=deferred(),started=deferred();app.global.DatyDialogs={confirm:async()=>true};let first=true;
  h.ports.request=(url,options)=>{
    const response=h.handle(url,options);
    if(first&&new URL(url).pathname==='/api/database/resources'){
      first=false;started.resolve();return held.promise.then(()=>response);
    }
    return response;
  };
  const reviewing=app.ui.reviewPending();await started.promise;app.changeScope({accessRevision:2});
  const result=await reviewing;held.resolve();await drain();
  assert.equal(result.status,'invalidated');assert.equal(posts(h).length,1);
});

test('malformed local archive is never converted to empty or overwritten by clear',async()=>{
  for(const raw of ['', 'not-json', '{}', 'null', '[null]', '[[]]', '[false]']){
    const h=setup();h.memory.set('daty_db_alerts',raw);await h.ui.load();
    await assert.rejects(h.ui.clearAll(),/格式异常|迁移/,JSON.stringify(raw));
    assert.equal(h.memory.get('daty_db_alerts'),raw);assert.equal(h.saves.length,0);
    assert.match(h.ui.status().warning,/格式异常/);
  }
});

test('local archive changed while deletion is in flight is preserved after server readback',async()=>{
  const held=deferred(),h=setup({records:[alert()],legacy:[alert()],saveHook:({commit})=>{const result=commit();return held.promise.then(()=>result);}});
  await h.ui.load();const clearing=h.ui.clearAll();await drain();h.memory.set('daty_db_alerts','not-json');held.resolve();
  await assert.rejects(clearing,/本机旧记录另有变化/);assert.equal(h.memory.get('daty_db_alerts'),'not-json');
  assert.equal(h.rows.get('a1').deleted,true);assert.equal(h.saves.length,1);
});

function attachServerArchive(h,{replyHook}={}){
  const archived=[],originalRequest=h.global.DatyDatabaseConnection.request;
  Object.assign(h.global,{AbortController,AbortSignal,TextEncoder,crypto:crypto.webcrypto,
    document:{getElementById:()=>null},location:{origin:'https://localhost:8080'},addEventListener(){},
    DatyBusinessMigration:require('../src/platform/browser-data-migration.js')});
  h.global.DatyDatabaseConnection.request=async(url,options)=>{
    if(!url.endsWith('/api/database/exports'))return originalRequest(url,options);
    const body=JSON.parse(options.body);archived.push(body);
    const reply={ok:true,status:200,json:async()=>({success:true,record:{status:'saved',id:body.operation_id,sha256:crypto.createHash('sha256').update(body.text).digest('hex')}})};
    return replyHook?replyHook(reply,body):reply;
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/app/server-storage.js'),'utf8'),h.global);
  return {archive:h.global.DatyServerStorage,archived};
}

test('verified archived legacy cache yields to server records and no longer blocks clearing',async()=>{
  const old=alert({archiveId:'old-browser'}),h=setup({records:[alert()],legacy:[old]});
  await h.ui.load();await assert.rejects(h.ui.prepareClear(),/迁移/);
  const {archive,archived}=attachServerArchive(h);await archive.archiveBrowserCache();
  const token=await h.ui.prepareClear();assert.equal(token.count,1);assert.equal(h.ui.status().warning,'');
  assert.equal(h.ui.records()[0].archiveId,'a1');assert.equal(await h.ui.clearAll(token),1);h.ui.cancelClear(token);
  assert.equal(h.ui.records().length,0);assert.deepEqual(JSON.parse(JSON.parse(archived[0].text).values.daty_db_alerts),[old]);
  assert.deepEqual(JSON.parse(h.memory.get('daty_db_alerts')),[]);
});

test('cache export IDs bind purpose and content while exact retries retain their intent',async()=>{
  const h=setup();h.memory.set('daty_db_alerts','not-json');h.memory.set('daty_server_draft_pending_v1','unconfirmed draft');
  const intents=new Map();const {archive,archived}=attachServerArchive(h,{replyHook:(reply,body)=>{
    const prior=intents.get(body.operation_id);if(prior)assert.deepEqual(body,prior);else intents.set(body.operation_id,body);return reply;
  }});
  await archive.archiveBrowserCache('browser-cache-at-full-archive');
  const first=archived.slice();assert.equal(first.length,3);
  await archive.archiveBrowserCache('browser-origin-before-server-storage');
  const second=archived.slice(3);assert.equal(second.length,3);
  for(let i=0;i<3;i++){assert.equal(first[i].text,second[i].text);assert.notEqual(first[i].operation_id,second[i].operation_id);assert.ok(second[i].operation_id.length<=80);}
  await archive.archiveBrowserCache('browser-origin-before-server-storage');
  assert.deepEqual(archived.slice(6),second);assert.equal(intents.size,6);
  assert.equal(h.memory.get('daty_db_alerts'),'not-json');assert.equal(h.memory.get('daty_server_draft_pending_v1'),'unconfirmed draft');
});

test('failed or mismatched archive receipts never bypass legacy preservation',async()=>{
  for(const replyHook of [()=>{throw Error('offline');},reply=>({...reply,json:async()=>({success:true,record:{id:'wrong',status:'saved',sha256:'wrong'}})})]){
    const h=setup({legacy:[alert({archiveId:'old'})]}),{archive}=attachServerArchive(h,{replyHook});
    await assert.rejects(archive.archiveBrowserCache());await assert.rejects(h.ui.prepareClear(),/迁移/);
    assert.equal(h.saves.length,0);assert.equal(archive.isCacheArchived('daty_db_alerts',h.memory.get('daty_db_alerts')),false);
  }
});

test('archive acknowledgement is exact-cache and connection scoped, not a generic legacy flag',async()=>{
  const h=setup({legacy:[alert({archiveId:'old'})]});h.global.DatyServerStorage={legacyArchived:true};
  await assert.rejects(h.ui.prepareClear(),/迁移/);
  const {archive}=attachServerArchive(h);await archive.archiveBrowserCache();const raw=h.memory.get('daty_db_alerts');
  assert.equal(archive.isCacheArchived('daty_db_alerts',raw),true);
  h.memory.set('daty_db_alerts',JSON.stringify([alert({archiveId:'changed'})]));await assert.rejects(h.ui.prepareClear(),/迁移/);
  h.memory.set('daty_db_alerts',raw);h.changeScope({accessRevision:2});assert.equal(archive.isCacheArchived('daty_db_alerts',raw),false);
  await assert.rejects(h.ui.prepareClear(),/迁移/);assert.equal(h.saves.length,0);
});

test('server switch during archive cannot authorize adopting old-source cache',async()=>{
  const h=setup({legacy:[alert()]}),{archive}=attachServerArchive(h,{replyHook:reply=>{h.changeScope({baseUrl:'https://192.0.2.16:8802'});return reply;}});
  await assert.rejects(archive.archiveBrowserCache(),/连接已变化/);
  assert.equal(archive.isCacheArchived('daty_db_alerts',h.memory.get('daty_db_alerts')),false);
});

test('clear preparation awaits in-flight save, pauses new saves and releases on cancel',async()=>{
  const held=deferred(),h=setup({saveHook:({commit})=>held.promise.then(commit)});await h.ui.load();
  const saving=h.ui.flush([alert()]);await drain();const preparing=h.ui.prepareClear();await drain();
  assert.equal((await h.ui.flush([alert({archiveId:'new'})])).status,'busy');
  held.resolve();assert.equal((await saving).success,true);const token=await preparing;assert.equal(token.count,1);
  h.ui.cancelClear(token);assert.equal((await h.ui.flush([alert({archiveId:'new'})])).success,true);
  assert.equal(h.ui.records().length,2);
});

test('confirmed clear deletes only captured IDs even after another client inserts and the view refreshes',async()=>{
  const h=setup({records:[alert()]});const token=await h.ui.prepareClear();
  h.rows.set('new',{kind:'alerts',id:'new',revision:1,deleted:false,value:alert({archiveId:'new'})});
  await h.ui.load({fresh:true});assert.equal(await h.ui.clearAll(token),1);h.ui.cancelClear(token);
  assert.equal(h.ui.records().length,1);assert.equal(h.ui.records()[0].archiveId,'new');assert.equal(h.rows.get('new').deleted,false);
});

test('confirmed revisions survive background list reload and reject changed records',async()=>{
  const h=setup({records:[alert()]});const token=await h.ui.prepareClear();
  h.rows.get('a1').revision=2;h.rows.get('a1').value.lastSeen=9;await h.ui.load({fresh:true});
  await assert.rejects(h.ui.clearAll(token),/已有新版本/);assert.equal(h.saves.length,0);h.ui.cancelClear(token);
  const fresh=await h.ui.prepareClear();assert.equal(await h.ui.clearAll(fresh),1);h.ui.cancelClear(fresh);
});

test('clear rejects changed database epoch, changed local cache and reused confirmation',async()=>{
  const h=setup({records:[alert()]});let token=await h.ui.prepareClear();
  const read=h.client.load;h.client.load=async(...args)=>({...await read(...args),epoch:'replaced-db'});
  await assert.rejects(h.ui.clearAll(token),/数据库已变化/);assert.equal(h.saves.length,0);h.ui.cancelClear(token);h.client.load=read;
  token=await h.ui.prepareClear();h.memory.set('daty_db_alerts','[{}]');
  await assert.rejects(h.ui.clearAll(token),/存储已更新/);h.ui.cancelClear(token);h.memory.set('daty_db_alerts','[]');
  token=await h.ui.prepareClear();assert.equal(await h.ui.clearAll(token),1);
  await assert.rejects(h.ui.clearAll(token),/确认已失效/);h.ui.cancelClear(token);
  await assert.rejects(h.ui.clearAll(token),/确认已失效/);assert.equal(h.saves.length,1);
});

test('production clear button passes the prepared server snapshot and releases cancellation',async()=>{
  const h=setup({records:[alert()],legacy:[alert()]});await h.ui.load();
  const notices=[],decision=deferred();Object.assign(h.global,{document:{getElementById:()=>null},ALERTS:[],renderLog(){},notify:(...args)=>notices.push(args),DatyDialogs:{confirm:()=>decision.promise}});
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/modules/alert-history.js'),'utf8'),h.global);
  const click=h.global.clearAllAlertsFromDB();await drain();assert.equal(await h.global.clearAllAlertsFromDB(),false);
  decision.resolve(false);assert.equal(await click,false);assert.equal(h.saves.length,0);
  h.global.DatyDialogs.confirm=async()=>true;assert.equal(await h.global.clearAllAlertsFromDB(),true);
  assert.equal(h.rows.get('a1').deleted,true);assert.match(notices.at(-1)[2],/1 条/);
  assert.equal((await h.ui.flush([alert({archiveId:'next'})])).success,true);
});

test('lost delete receipt remains unknown, blocks repeat deletion and reconciles without another POST',async()=>{
  const h=businessFixture(),app=setupReal(h);await app.ui.load();assert.equal((await app.ui.flush([alert()])).success,true);
  const token=await app.ui.prepareClear();h.state.dropReply=true;
  await assert.rejects(app.ui.clearAll(token),/未确认/);app.ui.cancelClear(token);const count=posts(h).length;
  await assert.rejects(app.ui.prepareClear(),/尚未核对/);assert.equal(posts(h).length,count);
  app.global.DatyDialogs={confirm:async()=>true};assert.equal((await app.ui.reviewPending()).status,'reconciled');
  assert.equal(posts(h).length,count);assert.equal(app.ui.records().length,0);
});

test('failed archive refresh exposes readError while preserving previous records until a successful read',async()=>{
  let offline=false;const h=setup({records:[alert()],listHook:({result})=>offline?{success:false,status:'error',message:'read offline'}:result});
  await h.ui.load();offline=true;assert.equal((await h.ui.load({fresh:true})).success,false);
  assert.equal(h.ui.records().length,1);assert.match(h.ui.status().readError,/read offline/);
  offline=false;assert.equal((await h.ui.load({fresh:true})).success,true);assert.equal(h.ui.status().readError,'');assert.equal(h.saves.length,0);
});

test('thrown archive transport read is a reported failure rather than an unhandled promise',async()=>{
  const h=setup({records:[alert()]});await h.ui.load();h.client.list=async()=>{throw Error('read transport failed');};
  const result=await h.ui.load({fresh:true});assert.equal(result.success,false);assert.match(h.ui.status().readError,/transport failed/);
  assert.equal(h.ui.records().length,1);assert.equal(h.saves.length,0);
});
