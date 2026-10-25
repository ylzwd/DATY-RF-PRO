'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {M5Client}=require('./m5-client.cjs'),{FilePort}=require('./file-port.cjs'),{enrollmentPort}=require('./enrollment-port.cjs');
const {storagePort}=require('./storage-port.cjs');
const [fileUrl,enrollUrl,caPath,bundlePath,wsBundlePath]=process.argv.slice(2);
const {ws:WebSocket}=require(wsBundlePath),ca=fs.readFileSync(caPath),uuid=()=>crypto.randomUUID().replaceAll('-','');
const context=vm.createContext({console,URL,WebSocket,TextEncoder,TextDecoder,AbortController,AbortSignal,Blob,
  navigator:{language:'en-US',userAgent:'stage5-isolated'},document:{},performance,
  setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate,queueMicrotask});
context.window=context;context.self=context;vm.runInContext(fs.readFileSync(bundlePath,'utf8'),context);
function make(url,mode) {return new M5Client({url,mode,uuid,connect:(address,options)=>context.mqtt.connect(address,{...options,forceNativeWebSocket:true,timerVariant:'native',
  createWebsocket:(target,protocols)=>new WebSocket(target,protocols,{ca,rejectUnauthorized:true,origin:mode==='files'?'https://127.0.0.1:8080':'http://127.0.0.1:8081'})})});}
const files=make(fileUrl,'files'),enroll=make(enrollUrl,'enrollment');
const hash=async raw=>crypto.createHash('sha256').update(raw).digest('hex');
(async()=>{
 try{
  await files.start();await enroll.start();
  const raw=Buffer.from('\ufeff640.250,0\r\n实际 GROUP11 CH1\r\n'.repeat(18000)),sha=await hash(raw),id=uuid();
  const port=new FilePort({client:files,sha256:hash,encode64:x=>Buffer.from(x).toString('base64'),decode64:x=>Buffer.from(x,'base64'),uuid});
  const source={size:raw.length,sha256:()=>hash(raw),read:async(o,n)=>raw.subarray(o,o+n)};
  await port.upload({id,source});const eid=uuid();
  const exported=await files.call('exports.create',{operation_id:eid,upload_id:id,sha256:sha,fileName:'真实扫描.csv',mimeType:'text/csv',source:'mqttjs-fixture'});
  assert.equal(exported.result.sha256,sha);files.stop();await files.start();
  const query=await files.query(eid);assert.equal(query.state,'completed');
  const opened=await files.call('downloads.open',{operation_id:uuid(),category:'exports',id:eid,sha256:sha});
  const bytes=Buffer.alloc(raw.length);let committed=false;
  const sink={write:async(o,x)=>Buffer.from(x).copy(bytes,o),size:async()=>bytes.length,sha256:()=>hash(bytes),commit:async()=>{committed=true;}};
  await port.download({descriptor:opened.result,sink});assert.equal(committed,true);assert.deepEqual(bytes,raw);
  const request=storagePort({client:files,files:port,sha256:hash,uuid,baseUrl:'https://127.0.0.1:8802'});
  const status=await (await request('https://127.0.0.1:8802/api/database/status')).json(),memory=new Map(),elements=new Map();
  let hostSaves=0,confirmations=0;
  for(const name of ['serverStorageStatus','serverArchiveSummary','clearServerArchives','createServerArchive'])elements.set(name,{textContent:'',dataset:{},setAttribute(){}});
  const storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
  const coordinator=vm.createContext({AbortController,AbortSignal,TextEncoder,crypto:crypto.webcrypto,console,
    document:{getElementById:k=>elements.get(k)||null,querySelectorAll:()=>[]},addEventListener(){},
    DatyPlatform:{storage},DatyHostFactory:{invokeRuntime:(_,name,...args)=>globalThis[name](...args)},
    DatyDialogs:{confirm:async()=>{confirmations++;return true;}},
    DatyDatabaseConnection:{snapshot:()=>({origin:'https://127.0.0.1:8802',revision:1,source:{id:'network:127.0.0.1'},status}),request},
    DatyTextExportFactory:{saveText:async(runtime,text)=>{assert.equal(text,raw.toString('utf8'));hostSaves++;return {status:'saved'};}},
    rawText:raw.toString('utf8'),exportOptions:{operationId:uuid(),fileName:'原导出.csv',mimeType:'text/csv'}});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../src/app/server-storage.js'),'utf8'),coordinator);
  const saved=await vm.runInContext('DatyTextExportFactory.saveText(globalThis,rawText,exportOptions)',coordinator);
  assert.equal(saved.status,'saved');assert.equal(hostSaves,1);assert.equal(memory.has('daty_server_export_pending_v1'),false);
  await coordinator.DatyServerStorage.refresh(); // three original parallel queries
  assert.equal(await coordinator.DatyServerStorage.clearArchiveFiles({category:'exports',id:coordinator.exportOptions.operationId}),true);
  assert.equal(confirmations,1);
  const resource=require(path.resolve(__dirname,'../../src/platform/database-client.js')).create({request,storage,
    readScope:()=>({baseUrl:'https://127.0.0.1:8802',principalId:'network:127.0.0.1',accessRevision:1}),schedule:setTimeout,cancel:clearTimeout,newOperationId:uuid});
  const loaded=await resource.load('legacy_snapshots','mqtt5-large-native');assert.equal(loaded.status,'ready');
  const value={sourceOrigin:'mqtt5-original-resource',sourceKey:'large-native',payload:{text:'原始数据'.repeat(100000),zero:0,unknown:null}};
  const stored=await resource.save('legacy_snapshots','mqtt5-large-native',value);assert.equal(stored.status,'saved',JSON.stringify(stored).slice(0,400));
  const reloaded=await resource.load('legacy_snapshots','mqtt5-large-native');assert.deepEqual(reloaded.resource.value,value);
  const auto=require(path.resolve(__dirname,'../../../FAshe/src/auto-pair.js'));
  const key=await crypto.webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']),names=[];
  const identity={receiver_mac:'02:00:00:00:00:01',brand:'DATYaudio',max_channels:50};
  const automatic=auto.create({browser:{crypto:crypto.webcrypto},keyStore:async name=>{names.push(name);return key;},
    request:enrollmentPort({client:enroll,origin:'https://127.0.0.1:8802'})});
  const first=await automatic.enroll('https://127.0.0.1:8802',identity);
  enroll.stop();await enroll.start();
  const second=await automatic.enroll('https://127.0.0.1:8802',identity);
  assert.equal(key.privateKey.extractable,false);assert.deepEqual(names,['https://127.0.0.1:8802|'+identity.receiver_mac,'https://127.0.0.1:8802|'+identity.receiver_mac]);
  for(const name of ['receiver_id','credential_id','receiver_mac','ca_sha256','broker_url'])assert.equal(first.pairing[name],second.pairing[name]);
  assert.equal(first.group_number,11);assert.equal(second.group_number,11);assert.notEqual(first.pairing.secret,second.pairing.secret);
  assert.equal(enroll.pending.size,0);assert.equal('intents' in enroll,false);
  // Output public proof only. Secrets/key material never reach files or stdout.
  console.log(JSON.stringify({ok:true,library:'MQTT.js 5.10.4 browser bundle',transport:'MQTT5/WSS verified temporary CA',bytes:raw.length,sha256:sha,
    export_download_equal:true,reconnect_query:true,original_auto_pair:true,nonextractable_key:true,https_key_namespace_preserved:true,
    identity_unchanged:true,group:11,renewed_secret_rotated:true,original_server_storage:true,original_text_export_host:true,
    original_cleanup_confirmations:confirmations,original_resource_large_document:true}));
 }finally{files.stop();enroll.stop();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
