'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {M5Client}=require('./m5-client.cjs'),{FilePort,CHUNK}=require('./file-port.cjs'),{enrollmentPort}=require('./enrollment-port.cjs');
const {storagePort}=require('./storage-port.cjs');
const hash=async x=>crypto.createHash('sha256').update(x).digest('hex');
function harness(mode='files') {
 const wires=[];let client;
 function connect(url,options){
  const w=new EventEmitter();Object.assign(w,{connected:true,options,pubs:[],end(){this.connected=false;},
   subscribe(topic,opts,fn){fn(null,[{topic,qos:1}]);queueMicrotask(()=>w.emit('message',topic,Buffer.from(JSON.stringify({
    schema:'daty-mqtt-'+mode+'-v1',server_id:'stage5-server',client_session_id:(mode==='files'?'m5f-':'m5e-')+'a'.repeat(32),boot_id:'b'.repeat(32),kind:'hello',active_entry:'mqtt',server_time_ms:Date.now()})),{}));},
   publish(topic,body,opts,fn){this.pubs.push(JSON.parse(body));fn();}});wires.push(w);
  queueMicrotask(()=>w.emit('connect',{sessionPresent:false,properties:{assignedClientIdentifier:(mode==='files'?'m5f-':'m5e-')+'a'.repeat(32)}}));return w;
 }
 client=new M5Client({connect,url:'wss://127.0.0.1:49100/mqtt-'+mode,mode,timeoutMs:1000});
 const reply=(result,changes={})=>{const w=wires.at(-1),r=w.pubs.at(-1);w.emit('message',client.replyTopic,Buffer.from(JSON.stringify({...r,kind:'reply',ok:true,result,...changes})),{});};
 return {client,wires,reply};
}
test('PUBACK never means file saved; application result required',async()=>{
 const h=harness();await h.client.start();let settled=false;const p=h.client.call('archives.list',{}).then(v=>{settled=true;return v;});
 await Promise.resolve();assert.equal(settled,false);h.reply({items:[]});assert.deepEqual(await p,{items:[]});h.client.stop();
});
test('disconnect has no replay; enrollment results have no intent cache',async()=>{
 const h=harness('enrollment');await h.client.start();const p=h.client.call('receivers.challenge',{});h.client.stop();await assert.rejects(p,/STOPPED/);
 await h.client.start();assert.equal(h.wires[1].pubs.length,0);assert.equal('intents' in h.client,false);h.client.stop();
});
test('one in flight and bounded packets',async()=>{
 const h=harness();await h.client.start();const p=h.client.call('archives.list',{});await assert.rejects(h.client.call('archives.list',{}),/REQUEST_LIMIT/);
 h.reply({});await p;await assert.rejects(h.client.call('data.invoke',{text:'x'.repeat(300000)}),/MESSAGE_TOO_LARGE/);h.client.stop();
});
test('wrong reply identity stops transport',async()=>{
 const h=harness();await h.client.start();const p=h.client.call('archives.list',{});h.reply({}, {client_session_id:'m5f-'+'f'.repeat(32)});
 await assert.rejects(p,/WRONG_REPLY_SOURCE/);assert.equal(h.client.ready,false);
});
test('late reply from a closed generation cannot settle a new request',async()=>{
 const h=harness();await h.client.start();const old=h.wires[0],p=h.client.call('archives.list',{});h.client.stop();await assert.rejects(p);
 await h.client.start();const next=h.client.call('archives.list',{});old.emit('message','bad',Buffer.from('{}'),{});assert.equal(h.client.ready,true);
 h.reply({items:[]});await next;h.client.stop();
});
test('enrollment request uses original HTTPS namespace without HTTP',async()=>{
 const h=harness('enrollment');const port=enrollmentPort({client:h.client,origin:'https://127.0.0.1:8802'});
 const pending=port('https://127.0.0.1:8802/api/receivers/challenge',{method:'POST',body:'{}'});
 for(let i=0;i<12;i++)await Promise.resolve();h.reply({success:true});assert.equal(JSON.parse(await (await pending).text()).success,true);
 await assert.rejects(port('https://127.0.0.2:8802/api/receivers/enroll',{method:'POST',body:'{}'}),/route rejected/);h.client.stop();
});
test('enrollment abort closes connection; no late secret delivered',async()=>{
 const h=harness('enrollment');await h.client.start();const port=enrollmentPort({client:h.client,origin:'https://127.0.0.1:8802'}),abort=new AbortController();
 const pending=port('https://127.0.0.1:8802/api/receivers/enroll',{method:'POST',body:'{}',signal:abort.signal});abort.abort();await assert.rejects(pending,/STOPPED/);assert.equal(h.client.ready,false);
});
function filePort(call){return new FilePort({client:{call},sha256:hash,encode64:x=>Buffer.from(x).toString('base64'),decode64:x=>Buffer.from(x,'base64')});}
test('upload resumes only the server-confirmed offset and verifies finish',async()=>{
 const raw=Buffer.alloc(CHUNK+3,65),sha=await hash(raw),methods=[];
 const port=filePort(async(m,b)=>{methods.push(m);if(m==='uploads.status')return {id:'x',bytes:raw.length,sha256:sha,state:'uploading',offset:CHUNK};
  if(m==='uploads.chunk'){assert.equal(b.offset,CHUNK);assert.equal(Buffer.from(b.data,'base64').length,3);return {id:'x',sha256:sha,offset:raw.length};}
  return {id:'x',bytes:raw.length,sha256:sha,state:'ready'};});
 await port.upload({id:'x',resume:true,source:{size:raw.length,sha256:async()=>sha,read:async(o,n)=>raw.subarray(o,o+n)}});
 assert.deepEqual(methods,['uploads.status','uploads.chunk','uploads.finish']);
});
test('source digest or transfer identity mismatch never sends a chunk',async()=>{
 let calls=0;const port=filePort(async()=>{calls++;return {id:'wrong',bytes:1,sha256:'a',state:'ready'};});
 await assert.rejects(port.upload({id:'x',source:{size:1,sha256:async()=>'a'}}),/IDENTITY_MISMATCH/);assert.equal(calls,1);
});
test('download chunk corruption never commits destination',async()=>{
 let committed=0,suspended=0;const raw=Buffer.from('abc'),sha=await hash(raw);
 const port=filePort(async()=>({download_id:'x',offset:0,bytes:3,sha256:'0'.repeat(64),file_sha256:sha,eof:true,data:raw.toString('base64')}));
 await assert.rejects(port.download({descriptor:{id:'x',sha256:sha,bytes:3},sink:{write(){},commit(){committed++;},suspend(){suspended++;}}}),/CHUNK_MISMATCH/);
 assert.equal(committed,0);assert.equal(suspended,1);
});
test('whole-file digest, including resumed prefix, required before save',async()=>{
 let committed=0;const raw=Buffer.from('abc'),sha=await hash(raw),port=filePort(async()=>{throw Error('no chunk expected');});
 await assert.rejects(port.download({resume:true,descriptor:{id:'x',sha256:sha,bytes:3},sink:{resume:async()=>3,sha256:async()=>'bad',size:async()=>3,commit(){committed++;}}}),/DIGEST_MISMATCH/);assert.equal(committed,0);
});
test('cancelled upload performs no network request',async()=>{
 let calls=0;const port=filePort(async()=>calls++),signal=new AbortController();signal.abort();
 await assert.rejects(port.upload({id:'x',source:{},signal:signal.signal}),/CANCELLED/);assert.equal(calls,0);
});
test('queued original storage reads cannot execute after reconnect',async()=>{
 let resolve,calls=0;const client={mode:'files',ready:true,generation:1,call:async()=>{calls++;return new Promise(r=>resolve=r);}};
 const request=storagePort({client,files:{},sha256:hash,uuid:()=>'',baseUrl:'https://127.0.0.1:8802'});
 const a=request('https://127.0.0.1:8802/api/database/storage-status'),b=request('https://127.0.0.1:8802/api/database/exports');
 for(let i=0;i<5;i++)await Promise.resolve();client.generation++;resolve({});
 await assert.rejects(a,/CONNECTION_CHANGED/);await assert.rejects(b,/CONNECTION_CHANGED/);assert.equal(calls,1);
});
test('original export cannot save if checksum upload has not completed',async()=>{
 let network=0;const client={mode:'files',ready:true,generation:1,call:async()=>network++},files={upload:async()=>{throw Error('UPLOAD_INCOMPLETE');}};
 const request=storagePort({client,files,sha256:hash,uuid:()=>'',baseUrl:'https://127.0.0.1:8802'});
 await assert.rejects(request('https://127.0.0.1:8802/api/database/exports',{method:'POST',body:JSON.stringify({operation_id:'fixture-operation',text:'bytes',fileName:'x.txt',mimeType:'text/plain'})}),/UPLOAD_INCOMPLETE/);
 assert.equal(network,0);
});
