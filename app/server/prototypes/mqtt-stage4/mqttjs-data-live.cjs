/* Existing MQTT.js bundle + original repositories over real WSS and SQLite. */
'use strict';
process.on('uncaughtException',error=>{console.error(error.stack);process.exit(1);});
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {DataClient}=require('./data-client.cjs'),{createRequestPort}=require('./database-port.cjs');
const [url,caPath,bundlePath,wsBundlePath]=process.argv.slice(2);
const {ws:WebSocket}=require(wsBundlePath),ca=fs.readFileSync(caPath);
const root=path.resolve(__dirname,'../..');
const context=vm.createContext({console,URL,WebSocket,TextEncoder,TextDecoder,AbortController,AbortSignal,Blob,
  navigator:{language:'en-US',userAgent:'stage4-isolated'},document:{},performance,
  setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate,queueMicrotask});
context.window=context;context.self=context;vm.runInContext(fs.readFileSync(bundlePath,'utf8'),context);
let publishes=0;
const client=new DataClient({url,timeoutMs:8000,connect:(address,options)=>{
  const mqtt=context.mqtt.connect(address,{...options,forceNativeWebSocket:true,timerVariant:'native',
    createWebsocket:(target,protocols)=>new WebSocket(target,protocols,{ca,rejectUnauthorized:true,origin:'https://127.0.0.1:8080'})});
  const publish=mqtt.publish.bind(mqtt);mqtt.publish=(...args)=>{publishes++;return publish(...args);};return mqtt;
}});
(async()=>{
 try{
  await client.start();
  const baseUrl='https://127.0.0.1:8802',request=createRequestPort({client,baseUrl}),memory=new Map();
  const ports={request,readScope:()=>({baseUrl,principalId:'network:127.0.0.1',accessRevision:1}),
    schedule:setTimeout,cancel:clearTimeout,storage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)},
    newOperationId:()=>crypto.randomUUID().replaceAll('-','')};
  const repository=require(path.join(root,'src/platform/database-client.js')).create(ports);
  const loaded=await repository.load('settings','alert_sound');assert.equal(loaded.status,'ready',JSON.stringify(loaded));
  const saved=await repository.save('settings','alert_sound',{enabled:true});assert.equal(saved.status,'saved',JSON.stringify(saved));
  const batch=require(path.join(root,'src/platform/database-batch-client.js')).create({...ports,resourceClient:repository});
  const alerts=require(path.join(root,'src/platform/alert-database.js')).create({client:repository,batchClient:batch});
  const rows=Array.from({length:3},(_,i)=>({archiveId:'mqtt-live-'+i,deviceId:'rx-ch1',metric:'af',firstSeen:1000+i,lastSeen:2000+i,
    endedAt:3000+i,archiveState:'ended',level:'critical',value:0,threshold:-5,msg:'AF fixture',groupNumber:4}));
  let flushed=await alerts.flush(rows);assert.equal(flushed.success,true,JSON.stringify(flushed));
  const listed=await alerts.list();assert.equal(listed.success,true,JSON.stringify(listed));
  const scope=alerts.captureClear();
  const newRow={...rows[0],archiveId:'mqtt-live-new'};
  flushed=await alerts.flush([newRow]);assert.equal(flushed.success,true,JSON.stringify(flushed));
  const cleared=await alerts.clear(rows.map(r=>r.archiveId),scope);assert.equal(cleared.success,true,JSON.stringify(cleared));
  await alerts.list();assert.deepEqual(alerts.records().map(r=>r.archiveId),['mqtt-live-new']);
  flushed=await alerts.flush(rows);assert.equal(flushed.success,true);await alerts.list();assert.equal(alerts.records().length,1);
  // Same operation promise publishes once; reconnect recovery reads only.
  const status=await client.call('database.status',{}),intent={operation_id:crypto.randomUUID().replaceAll('-',''),epoch:status.body.epoch,
    kind:'settings',id:'alert_sound',expected_revision:1,value:{enabled:false}};
  const before=publishes,a=client.write('database.write',intent),b=client.write('database.write',intent);assert.equal(a,b);
  assert.equal((await a).status,200);assert.equal(publishes-before,1);
  const receipt=await client.query(intent.operation_id);assert.equal(receipt.body.operation.state,'committed');
  client.stop();await client.start();const recovered=await client.query(intent.operation_id);assert.equal(recovered.body.operation.state,'committed');
  const fresh=require(path.join(root,'src/platform/database-client.js')).create(ports);
  const sound=await fresh.load('settings','alert_sound');assert.equal(sound.resource.value.enabled,false);
  console.log(JSON.stringify({ok:true,library:'MQTT.js 5.10.4 browser bundle',transport:'MQTT5/WSS verified temporary CA',
    original_resource_repository:true,original_batch_repository:true,original_alert_repository:true,
    duplicate_write_publications:1,original_alert_clear_kept_new_lifecycle:true,reconnect_query_state:'committed',pubs:publishes}));
 }finally{client.stop();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
