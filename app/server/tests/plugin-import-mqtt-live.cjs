/* Actual shipped importer + browser boot + MQTT.js over verified TLS.
 * File chooser and confirmation are injected host edges; no browser UI automation. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const root=path.resolve(__dirname,'..'),publicRoot=path.resolve(root,'../public');
const {ws:WebSocket}=require(config.wsBundle),ca=fs.readFileSync(config.ca);
const nodes={};for(const id of ['brandPluginImport','pluginImportState','pluginImportQuery'])nodes[id]={hidden:true,textContent:'',setAttribute(){},removeAttribute(){}};
const listeners=new Map(),calls=[],sockets=[];let selected=fs.readFileSync(config.zip),confirm=false,confirmations=0,refreshes=0,chooserClicks=0;
const context=vm.createContext({console,URL,WebSocket,Uint8Array,TextEncoder,TextDecoder,AbortController,AbortSignal,Blob,performance,
 crypto:crypto.webcrypto,btoa:v=>Buffer.from(v,'binary').toString('base64'),atob:v=>Buffer.from(v,'base64').toString('binary'),
 setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate,queueMicrotask,
 navigator:{language:'zh-CN',userAgent:'daty-plugin-interface-test'},location:{href:'https://127.0.0.1:8080/unirf-app.html'},
 _fasheApiUrl:'https://127.0.0.1:8802',_serverGeneration:1,__DATY_MQTT6_CONFIG:{wssOrigin:config.wss},
 DatyPlatform:{kind:'browser'},DatyPlatformFactory:{create:value=>value},
 DatyBrandPlugins:{syncVisibility:()=>refreshes++},
 DatyDialogs:{confirm:async details=>{confirmations++;assert.equal(details.rows[0].brand,'Shure');assert.equal(details.rows[0].files,'12');return confirm;}},
 addEventListener:(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
 removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn),
 document:{getElementById:id=>nodes[id],body:{appendChild(){}},createElement:tag=>{
  assert.equal(tag,'input');const events={};return {addEventListener:(name,fn)=>events[name]=fn,remove(){},
   files:[{name:'existing-shure.zip',size:selected.length,arrayBuffer:async()=>Uint8Array.from(selected).buffer}],
   click(){chooserClicks++;queueMicrotask(()=>events.change());}};
 }}});
context.window=context;context.self=context;
vm.runInContext(fs.readFileSync(config.mqttBundle,'utf8'),context);
const actualConnect=context.mqtt.connect;
context.mqtt={connect:(url,options)=>actualConnect(url,{...options,forceNativeWebSocket:true,
 createWebsocket:(target,protocols)=>{
  const socket=new WebSocket(target,protocols,{ca,rejectUnauthorized:true,origin:'https://127.0.0.1:8080'});sockets.push(socket);return socket;
 }})};
vm.runInContext(fs.readFileSync(path.join(publicRoot,'src/mqtt6/bundle.js'),'utf8'),context);
vm.runInContext(fs.readFileSync(path.join(config.surface==='source'?root:publicRoot,config.surface==='source'?'prototypes/mqtt-stage6/browser-boot.js':'src/mqtt6/browser-boot.js'),'utf8'),context);
const rpc=context.DatyPluginRpc;
let dropReceipt=config.dropReceipt;
context.DatyPluginRpc=async(base,method,body,signal)=>{
 assert(['plugins.preview','plugins.status','plugins.install','plugins.operation'].includes(method));
 if(config.production && method==='plugins.install')throw Error('Read-only formal verification forbids installation');
 calls.push({method,operation_id:body?.operation_id});
 const result=await rpc(base,method,body,signal);
 if(method==='plugins.install' && dropReceipt){dropReceipt=false;throw Error('TEST_RESPONSE_LOST_AFTER_DURABLE_INSTALL');}
 return result;
};
const surface=config.surface==='source'?root:publicRoot;
const html=fs.readFileSync(path.join(surface,'unirf-app.html'),'utf8');
const onclick=html.match(/<button\b[^>]*id="brandPluginImport"[^>]*onclick="([^"]+)"/)[1];
assert.equal(onclick,'importPlugin()');
const discovery=fs.readFileSync(path.join(surface,'src/modules/discovery.js'),'utf8');
vm.runInContext(discovery.match(/function importPlugin\(\) \{[^}]*\}/)[0],context);
if(config.surface==='source'){
 for(const file of ['src/platform/plugin-import-host.js','src/modules/plugin-import.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
}else vm.runInContext(discovery.slice(discovery.indexOf('/* ZIP input is a replaceable host capability.')),context);
const status=()=>rpc(context._fasheApiUrl,'plugins.status',{});
const click=()=>vm.runInContext(onclick,context);
(async()=>{
 try{
  const before=await status(),original=selected;
  if(!config.production){
   assert.equal(before.plugins.length,0);
   assert.equal(await click(),false);assert.equal(confirmations,1); // Cancel a verified package.
   assert.equal((await status()).revision,0);
   selected=Buffer.concat([original,Buffer.from('tampered')]);
   assert.equal(await click(),false);assert.match(nodes.pluginImportState.textContent,/PLUGIN_PACKAGE_NOT_TRUSTED/);
   assert.equal((await status()).plugins.length,0);assert.equal(confirmations,1);
   selected=original;confirm=true;
   const result=await click();
   if(config.dropReceipt){
    assert.equal(result,false);assert.equal(nodes.pluginImportQuery.hidden,false);
    assert.equal(await context.DatyPluginImport.query(),true);
   }else assert.equal(result,true);
   assert.match(nodes.pluginImportState.textContent,/已安装并启用/);
  }
  const installed=await status(),count=confirmations;
  assert.equal(installed.plugins[0].active,true);assert.equal(installed.plugins[0].sha256,crypto.createHash('sha256').update(original).digest('hex'));
  assert.equal(await click(),true);assert.equal(confirmations,count);assert.match(nodes.pluginImportState.textContent,/无需重复安装/);
  const after=await status();assert.equal(after.revision,installed.revision);
  assert.equal(calls.filter(x=>x.method==='plugins.install').length,config.production?0:1);
  assert.equal(nodes.brandPluginImport.disabled,false);
  const intent=calls.find(x=>x.method==='plugins.install');
  if(intent){const receipt=await rpc(context._fasheApiUrl,'plugins.operation',{operation_id:intent.operation_id});assert.equal(receipt.activation,'active');assert.equal(receipt.state,'installed');}
  console.log(JSON.stringify({ok:true,surface:config.surface,realMqttJs:true,tlsVerified:true,actualImporterAndBoot:true,
   sourceZipSha256:installed.plugins[0].sha256,revision:after.revision,calls,chooserClicks,confirmations,refreshes,
   queryAfterLostReceipt:!!config.dropReceipt,productionReadOnly:!!config.production,browserWindowTested:false}));
 }finally{for(const fn of Array.from(listeners.get('pagehide')||[]))fn();for(const socket of sockets)socket.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
