'use strict';
// Real current HTTPS + SQLite, own temporary fixture only. No production browser
// or receiver traffic; fixture refuses every device-control request.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),https=require('node:https'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),readline=require('node:readline');
const root=path.resolve(__dirname,'..'),record=(id,n=1)=>({archiveId:id,deviceId:'isolated-rx-ch1',metric:'rf',firstSeen:1000+n,lastSeen:2000+n,endedAt:3000+n,archiveState:'ended',level:'warn',value:-90,threshold:-80,msg:'Isolated alert '+id});
(async()=>{
 const child=spawn('C:\\ProgramData\\DATY RF PRO\\runtime\\python\\python.exe',['-B',path.join(__dirname,'server-storage-fixture.py'),'--stdio-fixture'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 let stderr='',resolveReady,rejectReady;const ready=new Promise((a,b)=>{resolveReady=a;rejectReady=b;}),pending=new Map();let serial=0;
 child.stderr.on('data',data=>stderr+=data);child.on('error',rejectReady);child.on('exit',code=>{if(code)rejectReady(Error(stderr||'Fixture exited '+code));});
 readline.createInterface({input:child.stdout}).on('line',line=>{try{const item=JSON.parse(line);if(item.event==='ready')resolveReady(item);else if(pending.has(item.id)){pending.get(item.id)(item.result);pending.delete(item.id);}}catch(_){}});
 let agent,app;
 try{
  const fixture=await ready;assert.match(fixture.origin,/^https:\/\/127\.0\.0\.1:\d+$/);agent=new https.Agent({ca:fixture.ca});const traffic=[];
  const request=async(url,options={})=>new Promise((resolve,reject)=>{
   assert.equal(new URL(url).origin,fixture.origin);const method=options.method||'GET';traffic.push({method,path:new URL(url).pathname,body:options.body});
   const req=https.request(url,{agent,method,signal:options.signal,headers:{'Content-Type':'application/json',Origin:'https://localhost:8080',...(options.body?{'Content-Length':Buffer.byteLength(options.body)}:{})}},response=>{
    const data=[];response.on('data',x=>data.push(x));response.on('end',()=>{const text=Buffer.concat(data).toString();resolve({status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300,json:async()=>JSON.parse(text),text:async()=>text});});
   });req.on('error',reject);if(options.body)req.write(options.body);req.end();
  });
  const api=async(route,options)=>{const response=await request(fixture.origin+route,options);const body=await response.json();assert.equal(response.ok,true,JSON.stringify(body));return body;};
  const command=name=>new Promise(resolve=>{const id=++serial;pending.set(id,resolve);child.stdin.write(JSON.stringify({id,command:name})+'\n');});
  const stats=()=>command('stats');
  const status=await api('/api/database/status'),memory=new Map([['daty_db_alerts',JSON.stringify([record('legacy-only')])]]),notices=[],dialogs=[];
  const makeApp=()=>{
   const elements=new Map();for(const id of ['logBody','logCount','logStorageCount','logArchiveStatus','logCountUnit','logTimeHeader','logLevelHeader','logDeviceHeader','logStateHeader','logArchiveView','logTimelineView','logSaveNow','logClearStorage','logClearDisplay','logPagination','logPageInfo','logPrevPage','logNextPage'])elements.set(id,{innerHTML:'',textContent:'',style:{},dataset:{},attributes:{},classList:{toggle(){}},setAttribute(name,value){this.attributes[name]=value;}});
   const global={AbortController,AbortSignal,TextEncoder,crypto:crypto.webcrypto,console,ALERTS:[],elements,document:{getElementById:id=>elements.get(id)||null},location:{origin:'https://localhost:8080'},addEventListener(){},
    notify:(...args)=>notices.push(args),DatyDialogs:{confirm:async options=>{dialogs.push(options);return true;}},
    DatyPlatform:{storage:{getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)}},
    DatyDatabaseConnection:{snapshot:()=>({origin:fixture.origin,source:{id:'isolated-network-peer'},revision:1,status}),request,subscribe:()=>()=>{}},
    DatyHostFactory:{invokeRuntime:(_global,name,...args)=>({setTimeout,clearTimeout}[name](...args))},
    DatyBusinessMigration:require('../src/platform/browser-data-migration.js'),DatyAlertDatabaseFactory:require('../src/platform/alert-database.js'),
    DatyDatabaseClientFactory:{create:ports=>require('../src/platform/database-client.js').create({...ports,newOperationId:crypto.randomUUID})},
    DatyDatabaseBatchFactory:{create:ports=>require('../src/platform/database-batch-client.js').create({...ports,newOperationId:crypto.randomUUID})}};
   global.window=global;const context=vm.createContext(global);
   for(const source of ['src/app/server-storage.js','src/app/alert-database.js','src/modules/alert-history.js','src/modules/render.js','src/modules/timeline.js'])vm.runInContext(fs.readFileSync(path.join(root,source),'utf8'),context,{filename:source});
   global.DatyAlertDatabaseUI.mount(global);return global;
  };
  app=makeApp();await app.DatyAlertDatabase.load();
  const records=Array.from({length:205},(_,i)=>record('server-'+i,i));
  for(const row of records)app.queueAlertForArchive(row,'ended');assert.equal(await app.exportAlertsToDB(),true,JSON.stringify(notices.at(-1)));
  assert.equal((await stats()).tables.biz_alerts,205);assert.equal(JSON.parse(memory.get('daty_pending_alerts_v1')).length,0);
  assert.equal(await app.clearAllAlertsFromDB(),false);assert.match(notices.at(-1)[2],/迁移/);assert.equal(dialogs.length,0);
  await app.DatyServerStorage.archiveBrowserCache();
  const exports=(await api('/api/database/exports')).items;
  const archived=await api('/api/database/exports/'+exports[0].id+'/download');assert.equal(JSON.parse(archived.values.daty_db_alerts)[0].archiveId,'legacy-only');
  app.DatyDialogs.confirm=async()=>false;assert.equal(await app.clearAllAlertsFromDB(),false);assert.equal(app.DatyAlertDatabase.records().length,205);
  let approve,opened;const dialogOpened=new Promise(resolve=>opened=resolve);
  app.DatyDialogs.confirm=options=>{dialogs.push(options);opened();return new Promise(resolve=>approve=resolve);};
  const before=await stats(),clearing=app.clearAllAlertsFromDB();await dialogOpened;
  assert.equal(await app.clearAllAlertsFromDB(),false);
  app.queueAlertForArchive(records[0],'ended');const queued=memory.get('daty_pending_alerts_v1');
  assert.equal((await app.flushAlertArchive()).success,false);assert.equal(memory.get('daty_pending_alerts_v1'),queued);
  approve(true);assert.equal(await clearing,true,JSON.stringify(notices.at(-1)));assert.equal(app.DatyAlertDatabase.records().length,0);
  assert.equal(memory.get('daty_pending_alerts_v1'),queued);assert.deepEqual(JSON.parse(memory.get('daty_db_alerts')),[]);
  const after=await stats();assert.equal(after.tables.biz_alerts,before.tables.biz_alerts);assert.equal(after.tables.db_audit-before.tables.db_audit,205);
  const deletes=traffic.filter(q=>q.method==='POST'&&q.path==='/api/database/batch').map(q=>JSON.parse(q.body)).filter(q=>q.writes.every(item=>item.deleted));
  assert.deepEqual(deletes.map(q=>q.writes.length),[200,5]);
  assert.equal((await app.flushAlertArchive()).success,true);assert.equal(app.DatyAlertDatabase.records().length,0,'Stale lifecycle must not revive');
  app.DatyAlertDatabase.dispose();app=makeApp();await app.DatyServerStorage.archiveBrowserCache();await app.DatyAlertDatabase.load({fresh:true});assert.equal(app.DatyAlertDatabase.records().length,0);
  app.queueAlertForArchive(record('new-lifecycle'),'ended');assert.equal((await app.flushAlertArchive()).success,true);assert.equal(app.DatyAlertDatabase.records().length,1);
  // All five production handlers share the real temporary database connection.
  await command('seed-receiver');const timelineBefore=(await api('/api/timeline?limit=200')).events;assert(timelineBefore.length>0);
  const beforeTimeline=traffic.length;assert.equal(await app.loadServerTimeline(),true);
  assert.equal(app.elements.get('logCount').textContent,String(timelineBefore.length));assert.equal(app.elements.get('logSaveNow').disabled,true);assert.equal(app.elements.get('logClearStorage').disabled,true);
  assert.equal(await app.exportAlertsToDB(),false);assert.equal(await app.clearAllAlertsFromDB(),false);
  app.clearDataLog();assert.match(app.elements.get('logBody').innerHTML,/当前显示已清空/);
  assert(traffic.slice(beforeTimeline).every(item=>item.method==='GET'));
  assert.equal(await app.showAlertArchive(),true);assert.equal(app.elements.get('logCount').textContent,'1');assert.match(app.elements.get('logStorageCount').textContent,/服务器告警/);
  app.DatyDialogs.confirm=async()=>true;assert.equal(await app.clearAllAlertsFromDB(),true);
  assert.equal(app.elements.get('logCount').textContent,'0');assert.deepEqual((await api('/api/timeline?limit=200')).events,timelineBefore);
  app.clearDataLog();assert.equal(await app.showAlertArchive(),true);assert.equal(app.elements.get('logCount').textContent,'0');
  // Dashboard clear uses the same real server transaction and retains AF source evidence.
  app.updateDashboardStats=()=>{};app.saveDataToStorage=()=>{};
  const afDevices=[{id:'fixture-a_ch9',_fasheId:'fixture-a_ch9',receiver_id:'fixture-a',receiver_ip:'192.0.2.102',
    channel_number:9,ch:'CH9',name:'Same name',brand:'DATYaudio',model:'RF PRO',group_source:'server-fifo-v1',group_number:11,
    _online:true,status:'online',rf:-40,batt:100,afDbfs:0},
    {id:'fixture-b_ch9',_fasheId:'fixture-b_ch9',receiver_id:'fixture-b',receiver_ip:'192.0.2.103',
    channel_number:9,ch:'CH9',name:'Same name',brand:'DATYaudio',model:'RF PRO',group_source:'server-fifo-v1',group_number:4,
    _online:true,status:'online',rf:-40,batt:100,afDbfs:0}];
  app.evaluateRealtimeAlerts(afDevices);assert.equal(app.ALERTS.length,2);
  app.DatyDialogs.confirm=async()=>false;assert.equal(await app.clearAlerts(),false);assert.equal(app.ALERTS.length,2);
  app.DatyDialogs.confirm=async()=>true;assert.equal(await app.clearAlerts(),true,JSON.stringify(notices.at(-1)));assert.equal(app.ALERTS.length,0);
  const afSaved=JSON.parse(JSON.stringify(app.DatyAlertDatabase.records().filter(r=>r.metric==='af')));assert.equal(afSaved.length,2);
  assert.deepEqual(afSaved.map(r=>[r.receiverIP,r.groupNumber,r.channel,r.value]).sort(),[['192.0.2.102',11,9,0],['192.0.2.103',4,9,0]]);
  app.DatyAlertDatabase.dispose();app=makeApp();await app.DatyAlertDatabase.load({fresh:true});
  assert.deepEqual(JSON.parse(JSON.stringify(app.DatyAlertDatabase.records().filter(r=>r.metric==='af'))),afSaved);
  const finalStats=await stats();assert.equal(finalStats.commands,0);assert.equal(finalStats.foreignKeys,0);
  console.log(JSON.stringify({pass:true,deleted:206,batches:[200,5,1],fiveButtonsVerified:true,dashboardClearVerified:true,afSourcePersisted:true,timelineRetained:true,manualSaveAll:205,legacySourceRetained:true,auditVersionsRetained:true,reloadedEmpty:true,staleLifecycleNotRevived:true,newLifecycleSaved:true,commands:0,temporary:fixture.temporary}));
 }finally{
  app?.DatyAlertDatabase.dispose();agent?.destroy();child.stdin.end(JSON.stringify({command:'shutdown'})+'\n');
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill();resolve();},10000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
