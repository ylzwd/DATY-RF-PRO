'use strict';
// Production coordinator with injected network/dialogs; no live traffic or filesystem deletion.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../src/app/server-storage.js'),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(options={}){
  const calls=[],dialogs=[],events={},memory=new Map(),elements=new Map();let revision=1,plan;
  for(const id of ['clearServerArchives','createServerArchive','serverStorageStatus','serverArchiveSummary'])elements.set(id,{dataset:{},disabled:false,textContent:'',setAttribute(){}});
  const context={AbortController,AbortSignal,TextEncoder,crypto:crypto.webcrypto,console,
    document:{getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[]},
    DatyPlatform:{storage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)}},
    DatyDialogs:{confirm:async value=>{dialogs.push(value);return options.confirm?options.confirm(value):true;}},
    addEventListener:(name,fn)=>events[name]=fn};
  const receipt=()=>({...plan,status:options.partial?'partial':'completed',deletedCount:options.partial?0:plan.count,freedBytes:options.partial?0:plan.bytes});
  context.DatyDatabaseConnection={snapshot:()=>({origin:'https://fixture.invalid',revision,source:{id:'fixture'},status:{epoch:'fixture'}}),request:async(url,request)=>{
    const route=new URL(url).pathname.split('/api/database/')[1],body=request.body?JSON.parse(request.body):undefined;calls.push({route,body});
    let value;
    if(route==='storage-status')value={cleanupProtocol:'daty-archive-cleanup-v1',databaseBytes:1,diskFreeBytes:1000,archives:0,exports:1};
    else if(route==='archives'||route==='exports')value={items:[]};
    else if(route==='archive-cleanups'){
      plan={protocol:'daty-archive-cleanup-v1',id:body.operation_id,status:'prepared',planSha256:'a'.repeat(64),bytes:100,count:options.empty?0:1,items:options.empty?[]:[{category:'exports',id:'x'.repeat(32),fileName:'actual.txt'}]};
      if(options.invalidPlan)plan.bytes=-1;
      value={record:plan};
    }else if(route.endsWith('/commit')){
      if(options.loseReply)throw Error('connection closed');
      value={record:options.badReceipt?{...receipt(),id:'wrong'}:receipt()};
    }else if(route.startsWith('archive-cleanups/'))value={record:options.uncommitted?plan:receipt()};
    else throw Error('Unexpected route '+route);
    return {ok:true,status:200,json:async()=>({success:true,...value})};
  }};
  vm.runInNewContext(source,context);
  return {context,calls,dialogs,elements,events,api:context.DatyServerStorage,change:()=>revision++,
    commits:()=>calls.filter(c=>c.route.endsWith('/commit')),message:()=>elements.get('serverStorageStatus').textContent};
}
test('cleanup cancel preserves files and does not send a commit',async()=>{
  const h=setup({confirm:()=>false});await h.api.refresh();assert.equal(await h.api.clearArchiveFiles(),false);
  assert.equal(h.commits().length,0);assert.match(h.message(),/已取消/);assert.equal(h.elements.get('createServerArchive').disabled,false);
});
test('cleanup freezes scope and sends the exact acknowledged digest once',async()=>{
  const h=setup();await h.api.refresh();assert.equal(await h.api.clearArchiveFiles({category:'exports',id:'x'.repeat(32)}),true);
  assert.equal(h.commits().length,1);assert.equal(h.commits()[0].body.planSha256,'a'.repeat(64));assert.equal(h.commits()[0].body.confirmed,true);
  assert.equal(h.dialogs[0].details[0].value,'actual.txt');assert.match(h.message(),/已清理 1.*100 B.*数据库保留/);
});
test('duplicate cleanup and archive creation cannot overlap pending confirmation',async()=>{
  const gate=deferred(),h=setup({confirm:()=>gate.promise});await h.api.refresh();const action=h.api.clearArchiveFiles();
  await new Promise(setImmediate);assert.equal(await h.api.clearArchiveFiles(),false);assert.equal(await h.api.createArchive(),false);
  assert.equal(h.elements.get('createServerArchive').disabled,true);gate.resolve(true);assert.equal(await action,true);assert.equal(h.commits().length,1);
});
test('server switch or closing page invalidates an open confirmation without deleting',async()=>{
  for(const close of [false,true]){
    const gate=deferred(),h=setup({confirm:()=>gate.promise});await h.api.refresh();const action=h.api.clearArchiveFiles();await new Promise(setImmediate);
    if(close)h.events.pagehide();else h.change();gate.resolve(true);assert.equal(await action,false);assert.equal(h.commits().length,0);
  }
});
test('lost commit response reads exact receipt without a second deletion POST',async()=>{
  const h=setup({loseReply:true});await h.api.refresh();assert.equal(await h.api.clearArchiveFiles(),true);assert.equal(h.commits().length,1);
  assert.equal(h.calls.filter(c=>c.route.startsWith('archive-cleanups/')&&!c.body).length,1);
});
test('uncommitted or partial cleanup never reports complete or retries automatically',async()=>{
  for(const options of [{loseReply:true,uncommitted:true},{partial:true},{badReceipt:true}]){
    const h=setup(options);await h.api.refresh();assert.equal(await h.api.clearArchiveFiles(),false);assert.equal(h.commits().length,1);
    assert.doesNotMatch(h.message(),/已清理 1/);assert.equal(h.elements.get('serverStorageStatus').dataset.state,'error');
  }
});
test('empty scope or invalid plan never opens destructive confirmation',async()=>{
  for(const options of [{empty:true},{invalidPlan:true}]){
    const h=setup(options);await h.api.refresh();await h.api.clearArchiveFiles();assert.equal(h.dialogs.length,0);assert.equal(h.commits().length,0);
  }
});

function jobs(options={}){
  const memory=new Map(),calls=[],elements=new Map([['serverStorageStatus',{dataset:{},textContent:''}]]);let revision=1,reads=0;
  const id='task-id-1234567890',record={id,status:'saved',sha256:'a'.repeat(64),bytes:123};
  const c={AbortController,AbortSignal,TextEncoder,crypto:crypto.webcrypto,console,location:{origin:'https://browser.invalid'},addEventListener(){},
    document:{getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[],addEventListener(){}},
    DatyPlatform:{storage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)}},
    DatyHostFactory:{invokeRuntime:(_g,name,...a)=>({setTimeout:(fn)=>setTimeout(fn,0),clearTimeout}[name])(...a)},
    DatyDialogs:{confirm:async()=>true},DatyBusinessMigration:{KEYS:[],FORMAT:'fixture'},
    DatyBusinessDatabaseFactory:{mount(){}},DatyBusinessDatabase:{hydrate:async()=>{}},DatyAlertDatabaseUI:{mount(){}},DatyAlertDatabase:{load:async()=>{}},
    DatyPlanningProjectStorage:{start:async()=>{}},restorePlanningProjectFromServer:async()=>{},getCurrentPlanningProject:()=>({id:'default'}),
    DatyPlanningConstraints:{captureConstraintFields:()=>({}),restoreSnapshot(){}},flushAlertArchive:async()=>({success:true})};
  c.DatyDatabaseConnection={snapshot:()=>({origin:'https://fixture.invalid',revision,status:{epoch:'fixture'},source:{id:'fixture'}}),request:async(url,request)=>{
    const route=new URL(url).pathname.split('/api/database/')[1],body=request.body?JSON.parse(request.body):null;calls.push({route,body});let value;
    if(options.beforeReply)await options.beforeReply({route,body,change:()=>revision++});
    if(route==='exports'&&body)value={record:{id:body.operation_id,status:'saved',sha256:crypto.createHash('sha256').update(body.text).digest('hex')}};
    else if(route==='browser-import/preview')value={ready:false,conflicts:[]};
    else if(route==='draft')value={draft:null};
    else if(route==='storage-status')value={databaseBytes:1,diskFreeBytes:1000,archives:0,exports:0};
    else if(route==='archives'&&body){record.id=body.operation_id;if(options.loseReply)throw Error('reply lost');value={record};}
    else if(route==='archives'||route==='exports')value={items:[]};
    else if(route.startsWith('archives/')){reads++;if(options.unavailable)throw Error('not yet confirmed');value={record:{...record,...options.receipt,...(options.running&&reads===1?{status:'running',stage:'制作快照'}:{})}};}
    else throw Error('Unexpected fixture route '+route);
    return {ok:true,status:200,json:async()=>({success:true,...value})};
  }};
  vm.runInNewContext(source,c);
  return {api:c.DatyServerStorage,calls,memory,record,id,c,change:()=>revision++,message:()=>elements.get('serverStorageStatus').textContent,
    pending:(epoch='fixture')=>memory.set('daty_server_archive_job_v1',JSON.stringify({id,origin:'https://fixture.invalid',epoch}))};
}
test('reloaded page observes the exact pending archive and never creates another',async()=>{
  const h=jobs({running:true});h.pending();assert.equal(await h.api.resumeArchive(),true);
  assert.equal(h.calls.filter(x=>x.route==='archives'&&x.body).length,0);assert.equal(h.calls.filter(x=>x.route.startsWith('archives/')).length,2);
  assert.equal(h.memory.has('daty_server_archive_job_v1'),false);
});
test('pending archive scope, malformed receipt and lost response preserve evidence without repost',async()=>{
  let h=jobs();h.pending('old-epoch');assert.equal(await h.api.resumeArchive(),false);assert.equal(h.calls.length,0);
  for(const options of [{unavailable:true},{receipt:{id:'wrong'}},{receipt:{sha256:'bad'}},{beforeReply:({change})=>change()}]){
    h=jobs(options);h.pending();assert.equal(await h.api.createArchive(),false);assert.ok(h.memory.has('daty_server_archive_job_v1'));
    assert.equal(h.calls.filter(x=>x.body).length,0);assert.doesNotMatch(h.message(),/^完整存档已保存在服务器/);
  }
});
test('new archive lost POST reply is reconciled once by GET with validated digest',async()=>{
  const h=jobs({loseReply:true});await h.api.bootstrap();assert.equal(await h.api.createArchive(),true);
  assert.equal(h.calls.filter(x=>x.route==='archives'&&x.body).length,1);
  assert.equal(h.calls.filter(x=>x.route.startsWith('archives/')).length,1);assert.equal(h.memory.has('daty_server_archive_job_v1'),false);
});
