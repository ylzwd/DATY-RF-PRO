'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {M6Client}=require('./m6-client.cjs'),{applicationPort}=require('./application-port.cjs');
const {enrollmentPort}=require('../mqtt-stage5/enrollment-port.cjs');
const [serverUrl,caPath,bundlePath,wsBundlePath]=process.argv.slice(2),ROOT=path.resolve(__dirname,'../..');
const {ws:WebSocket}=require(wsBundlePath),ca=fs.readFileSync(caPath),uuid=()=>crypto.randomUUID().replaceAll('-','');
const context=vm.createContext({console,URL,WebSocket,TextEncoder,TextDecoder,AbortController,AbortSignal,Blob,
  navigator:{language:'en-US',userAgent:'stage6-isolated'},document:{},performance,
  setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate,queueMicrotask});
context.window=context;context.self=context;vm.runInContext(fs.readFileSync(bundlePath,'utf8'),context);
const connect=(mode)=>(url,options)=>context.mqtt.connect(url,{...options,forceNativeWebSocket:true,timerVariant:'native',
  createWebsocket:(target,protocols)=>new WebSocket(target,protocols,{ca,rejectUnauthorized:true,
    origin:mode==='app'?'https://127.0.0.1:8080':'http://127.0.0.1:8081'})});
const app=new M6Client({url:serverUrl+'/mqtt-app',mode:'app',uuid,connect:connect('app')}),
  enrollment=new M6Client({url:serverUrl+'/mqtt-enrollment',mode:'enrollment',uuid,connect:connect('enrollment')});
const hash=async raw=>crypto.createHash('sha256').update(raw).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let stream;
(async()=>{
 try{
  const navigation=vm.createContext({console,URL,crypto:crypto.webcrypto,TextEncoder,TextDecoder,AbortController,AbortSignal,
    performance,Date,Map,Set,setTimeout,clearTimeout,setInterval,clearInterval});
  navigation.window=navigation;navigation._fasheApiUrl='https://127.0.0.1:8802';
  vm.runInContext(fs.readFileSync(path.join(ROOT,'src/modules/frequency.js'),'utf8'),navigation);
  vm.runInContext(fs.readFileSync(path.join(ROOT,'src/modules/navigation.js'),'utf8'),navigation);
  const port=applicationPort({client:app,baseUrl:'https://127.0.0.1:8802',connect:connect('app'),uuid,sha256:hash,
    encode64:raw=>Buffer.from(raw).toString('base64'),decode64:raw=>Buffer.from(raw,'base64'),normalizeBrand:b=>b,
    toKHz:(n,u)=>navigation.DatyFrequency.toFrequencyKHz(n,u),onCommand:r=>navigation.receiveCommandAcknowledgement(r)});
  navigation.DatyPlatform=port;
  const status=await (await port.request('https://127.0.0.1:8802/api/database/status')).json();
  assert.equal(status.success,true);assert.equal(status.storage_source.ip,'127.0.0.1');
  const reads=await Promise.all(Array.from({length:8},()=>port.request('https://127.0.0.1:8802/health').then(r=>r.json())));
  assert(reads.every(r=>r.status==='ok'));
  let snapshot,delta=0;
  stream=port.openEventStream('https://127.0.0.1:8802/api/updates');
  stream.addEventListener('device_list',e=>{snapshot=JSON.parse(e.data);});
  stream.addEventListener('device_update',()=>delta++);
  for(let i=0;i<200&&!snapshot;i++)await sleep(10);
  assert.equal(snapshot.devices.length,4);
  const targets=await port.serial.call('commands.targets',{}),target=targets.targets[0].target;
  const command={type:'device_command',...target,command:'mute',value:true};
  navigation.testCommand=command;
  const result=await vm.runInContext('sendTrackedDeviceCommand(testCommand)',navigation);
  assert.equal(result.status,'acknowledged');assert.equal(result.actual_value,true);
  assert.equal(result.device_id,target.device_id);assert.equal(result.execution_evidence.receiver_session_id,target.receiver_session_id);
  assert.equal(result.outcome,'acknowledged');
  const rejected={...command,receiver_session_id:'stale'};
  await assert.rejects(()=>port.request('https://127.0.0.1:8802/api/command',{method:'POST',body:JSON.stringify({...rejected,client_request_id:uuid()})}),/BINDING_CHANGED/);
  const resource={operation_id:uuid(),epoch:status.epoch,kind:'preferences',id:'m6-node',expected_revision:0,value:{activePanel:'data'}};
  const saved=await (await port.request('https://127.0.0.1:8802/api/database/write',{method:'POST',body:JSON.stringify(resource)})).json();assert.equal(saved.success,true);
  const read=await (await port.request('https://127.0.0.1:8802/api/database/resources/preferences/m6-node')).json();assert.deepEqual(read.resource.value,resource.value);
  const auto=require(path.resolve(ROOT,'../FAshe/src/auto-pair.js'));
  const key=await crypto.webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']),names=[];
  const automatic=auto.create({browser:{crypto:crypto.webcrypto},keyStore:async name=>{names.push(name);return key;},
    request:enrollmentPort({client:enrollment,origin:'https://127.0.0.1:8802'})});
  const identity={receiver_mac:'02:00:00:00:00:01',brand:'DATYaudio',max_channels:50};
  const first=await automatic.enroll('https://127.0.0.1:8802',identity);
  enrollment.stop();const second=await automatic.enroll('https://127.0.0.1:8802',identity);
  assert.equal(first.pairing.receiver_id,second.pairing.receiver_id);assert.equal(first.pairing.credential_id,second.pairing.credential_id);
  assert.equal(first.group_number,second.group_number);assert.notEqual(first.pairing.secret,second.pairing.secret);
  assert(names.every(n=>n==='https://127.0.0.1:8802|'+identity.receiver_mac));
  assert.equal(enrollment.pending.size,0);
  console.log(JSON.stringify({ok:true,real_mqttjs:true,tls_verified:true,shared_listener:true,original_navigation_ack:true,
    snapshot_channels:snapshot.devices.length,delta_events:delta,parallel_reads:reads.length,wrong_session_rejected:true,
    real_database:true,original_auto_pair:true,renewal_identity_and_group_preserved:true,https_key_namespace_preserved:true,
    live_commands:0,full_browser_window:false}));
 }finally{stream?.close();app.stop();enrollment.stop();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
