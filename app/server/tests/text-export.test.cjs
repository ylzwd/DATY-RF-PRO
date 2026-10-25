// Isolated host output contracts; no filesystem writes, downloads or device I/O.
const {test}=require('node:test'),assert=require('node:assert/strict');
const factory=require('../src/platform/browser-platform.js').textExports;
const options=()=>({fileName:'规划.json',mimeType:'application/json'});
test('browser output reports download-started and preserves receiver, text and options',async()=>{
 const calls=[],platform={kind:'browser',downloadText(text,opts){assert.equal(this,platform);calls.push([text,opts]);}};
 assert.deepEqual(await factory.saveText({DatyPlatform:platform},'{"频率":641000}',options()),{status:'download-started'});
 assert.deepEqual(calls, [['{"频率":641000}',options()]]);
});
test('native output awaits saved or cancelled, retaining this and exact UTF-8 text',async()=>{
 for(const status of ['saved','cancelled']) {
  const port={VERSION:factory.VERSION,async saveText(text,opts){assert.equal(this,port);assert.equal(text,'鼓手\n641000');assert.equal(opts.fileName,'规划.json');return {status};}};
  assert.deepEqual(await factory.saveText({DatyPlatform:{kind:'native'},DatyTextExports:port},'鼓手\n641000',options()),{status});
 }
});
test('missing or malformed native export never falls back to browser download',async()=>{
 for(const port of [undefined,null,{VERSION:'bad',saveText:async()=>({status:'saved'})},{VERSION:factory.VERSION,saveText:()=>({status:'saved'})},{VERSION:factory.VERSION,saveText:async()=>({status:'download-started'})}]) {
  await assert.rejects(factory.saveText({DatyPlatform:{kind:'native',downloadText(){throw Error('fallback');}},DatyTextExports:port},'{}',options()),/DatyTextExports/);
 }
});
test('native write failures propagate without success or retry',async()=>{
 let calls=0;const runtime={DatyPlatform:{kind:'native'},DatyTextExports:{VERSION:factory.VERSION,async saveText(){calls++;throw Error('disk full');}}};
 await assert.rejects(factory.saveText(runtime,'{}',options()),/disk full/);assert.equal(calls,1);
});
test('abort settles an uncooperative save without waiting for late completion',async()=>{
 const controller=new AbortController();let complete,calls=0;
 const runtime={DatyPlatform:{kind:'native'},DatyTextExports:{VERSION:factory.VERSION,saveText(){calls++;return new Promise(resolve=>complete=resolve);}}};
 const saving=factory.saveText(runtime,'{}',{...options(),signal:controller.signal});controller.abort();
 assert.deepEqual(await saving,{status:'cancelled'});complete({status:'saved'});
 assert.deepEqual(await factory.saveText(runtime,'{}',{...options(),signal:controller.signal}),{status:'cancelled'});assert.equal(calls,1);
});
test('host change suppresses a late saved result or error',async()=>{
 for(const failure of [false,true]){
  let complete,fail;const runtime={DatyPlatform:{kind:'native'},DatyTextExports:{VERSION:factory.VERSION,saveText:()=>new Promise((resolve,reject)=>{complete=resolve;fail=reject;})}};
  const saving=factory.saveText(runtime,'{}',options());runtime.DatyPlatform={kind:'replacement'};
  if(failure)fail(Error('late failure'));else complete({status:'saved'});
  assert.deepEqual(await saving,{status:'cancelled'});
 }
});
test('invalid filenames and non-text exports fail before host I/O',async()=>{
 const runtime={DatyPlatform:{kind:'browser',downloadText(){throw Error('unexpected I/O');}}};
 for(const fileName of ['','../bad.json','C:\\bad.json','bad\nfile'])await assert.rejects(factory.saveText(runtime,'{}',{...options(),fileName}),/invalid/);
 await assert.rejects(factory.saveText(runtime,{},options()),/invalid/);
});
