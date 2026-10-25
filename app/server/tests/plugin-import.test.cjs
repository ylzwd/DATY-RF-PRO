const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
let source=fs.readFileSync(path.join(root,'src/platform/plugin-import-host.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'src/modules/plugin-import.js'),'utf8');
if(process.env.DATY_PLUGIN_PUBLIC){const text=fs.readFileSync(process.env.DATY_PLUGIN_PUBLIC,'utf8');source=text.slice(text.indexOf('/* ZIP input is a replaceable host capability.'));}
function harness(){
 const nodes={};for(const id of ['brandPluginImport','pluginImportState','pluginImportQuery'])nodes[id]={hidden:true,textContent:'',setAttribute(){},removeAttribute(){}};
 const calls=[],listeners={};let installed=false,confirms=0,opens=0,mode='',confirmed=true,refreshes=0;
 const bytes=new Uint8Array([80,75,3,4]),digest=crypto.createHash('sha256').update(bytes).digest('hex');
 const preview={trusted:true,id:'shure-scp',brand:'Shure',name:'Shure SCP',version:'test',source_files:12,sha256:digest,revision:0};
 const context=vm.createContext({Uint8Array,AbortController,crypto:crypto.webcrypto,btoa:v=>Buffer.from(v,'binary').toString('base64'),
  _fasheApiUrl:'https://server-a:8080',_serverGeneration:1,document:{getElementById:id=>nodes[id]},DatyPlatform:{kind:'native'},
  addEventListener:(n,f)=>listeners[n]=f,removeEventListener:n=>delete listeners[n],
  DatyDialogs:{confirm:async()=>{confirms++;if(mode==='switch-confirm')context._serverGeneration++;return confirmed;}},
  DatyBrandPlugins:{syncVisibility:()=>refreshes++},
  DatyBinaryImports:{VERSION:'daty-binary-import-v1',openBytes:async()=>{opens++;return {status:'selected',bytes};}},
  DatyPluginRpc:async(base,method,body)=>{
   calls.push({base,method,body});
   if(method==='plugins.status'){
    if(mode==='switch-status')context._serverGeneration++;
    return {revision:mode==='stale-status'?1:0,plugins:mode.startsWith('existing')?[{id:preview.id,sha256:digest,version:preview.version,state:'installed',active:mode==='existing-active',activation:mode==='existing-active'?'active':'inactive'}]:[]};
   }
   if(method==='plugins.preview'){
    if(mode==='bad-preview')return {...preview,sha256:'0'.repeat(64)};
    if(mode==='reject-preview')throw Error('PLUGIN_PACKAGE_NOT_TRUSTED');
    if(mode==='switch-preview')context._fasheApiUrl='https://server-b:8080';
    return preview;
   }
   if(method==='plugins.install'){
    if(mode==='reject-install')throw Object.assign(Error('PLUGIN_REVISION_CHANGED'),{code:'PLUGIN_REVISION_CHANGED'});
    installed=true;
    if(mode==='timeout')throw Error('RPC_TIMEOUT_QUERY_ONLY');
    return {id:preview.id,sha256:digest,operation_id:body.operation_id,state:'installed',activation:mode==='pending'?'pending':mode==='failed'?'failed':'active'};
   }
   if(method==='plugins.operation')return {id:preview.id,sha256:digest,operation_id:body.operation_id,state:'installed',activation:'active'};
  }});
 vm.runInContext(source,context);
 return {context,nodes,calls,bytes,listeners,setMode:v=>mode=v,setConfirm:v=>confirmed=v,stats:()=>({installed,confirms,opens,refreshes})};
}
test('preview, confirm and one durable install result enable the brand',async()=>{
 const h=harness();assert.equal(await h.context.DatyPluginImport.start(),true);
 assert.deepEqual(h.calls.map(c=>c.method),['plugins.preview','plugins.status','plugins.install']);assert.equal(h.stats().confirms,1);assert.equal(h.stats().refreshes,1);
 assert.match(h.nodes.pluginImportState.textContent,/已安装并启用/);assert.equal(h.nodes.brandPluginImport.disabled,false);
});
test('cancel and invalid preview never install',async()=>{
 for(const mode of ['cancel','bad-preview','reject-preview']){
  const h=harness();h.setMode(mode);if(mode==='cancel')h.setConfirm(false);
  assert.equal(await h.context.DatyPluginImport.start(),false);assert.equal(h.calls.filter(c=>c.method==='plugins.install').length,0);
 }
});
test('server changes during preview or confirmation discard old work',async()=>{
 for(const mode of ['switch-preview','switch-status','switch-confirm']){const h=harness();h.setMode(mode);assert.equal(await h.context.DatyPluginImport.start(),false);assert.equal(h.stats().installed,false);}
});
test('unknown installation is queried, never automatically resubmitted',async()=>{
 const h=harness();h.setMode('timeout');assert.equal(await h.context.DatyPluginImport.start(),false);assert.equal(h.nodes.pluginImportQuery.hidden,false);
 assert.equal(await h.context.DatyPluginImport.start(),true);
 assert.deepEqual(h.calls.map(c=>c.method),['plugins.preview','plugins.status','plugins.install','plugins.operation']);assert.equal(h.stats().opens,1);
});
test('same active digest and version skips confirmation and installation',async()=>{
 const h=harness();h.setMode('existing-active');assert.equal(await h.context.DatyPluginImport.start(),true);
 assert.equal(h.stats().confirms,0);assert.equal(h.stats().installed,false);assert.equal(h.stats().refreshes,1);
 assert.match(h.nodes.pluginImportState.textContent,/无需重复安装/);
});
test('inactive installation still requires confirmation and a real activation receipt',async()=>{
 const h=harness();h.setMode('existing-inactive');assert.equal(await h.context.DatyPluginImport.start(),true);
 assert.equal(h.stats().confirms,1);assert.equal(h.stats().installed,true);
});
test('changed registry revision stops before confirmation or install',async()=>{
 const h=harness();h.setMode('stale-status');assert.equal(await h.context.DatyPluginImport.start(),false);
 assert.equal(h.stats().confirms,0);assert.equal(h.stats().installed,false);
});
test('missing MQTT import interface reports refresh before opening a file',async()=>{
 const h=harness();h.context.DatyPluginRpc=undefined;assert.equal(await h.context.DatyPluginImport.start(),false);
 assert.equal(h.stats().opens,0);assert.match(h.nodes.pluginImportState.textContent,/刷新页面/);
});
test('pending and failed activation never claim success',async()=>{
 for(const mode of ['pending','failed']){const h=harness();h.setMode(mode);assert.equal(await h.context.DatyPluginImport.start(),false);assert.equal(h.stats().refreshes,0);assert.doesNotMatch(h.nodes.pluginImportState.textContent,/已安装并启用/);}
});
test('server rejection unlocks explicit fresh selection',async()=>{
 const h=harness();h.setMode('reject-install');assert.equal(await h.context.DatyPluginImport.start(),false);h.setMode('');
 assert.equal(await h.context.DatyPluginImport.start(),true);assert.equal(h.stats().opens,2);
});
test('duplicate click and page close never cause a second install',async()=>{
 const h=harness();let resolve;h.context.DatyBinaryImports.openBytes=()=>new Promise(r=>resolve=r);
 const first=h.context.DatyPluginImport.start();assert.equal(await h.context.DatyPluginImport.start(),false);
 h.listeners.pagehide();resolve({status:'selected',bytes:h.bytes});assert.equal(await first,false);assert.equal(h.calls.length,0);
});
test('native binary host enforces async contract and byte limit without browser fallback',async()=>{
 const h=harness(),host=h.context.DatyPluginImportHost;
 for(const port of [undefined,{VERSION:'bad'},{VERSION:'daty-binary-import-v1',openBytes:()=>({status:'selected',bytes:h.bytes})},
  {VERSION:'daty-binary-import-v1',openBytes:async()=>({status:'selected',bytes:new Uint8Array(131073)})}]){
  const runtime={DatyPlatform:{kind:'native'},DatyBinaryImports:port};await assert.rejects(host.open(runtime));
 }
 const controller=new AbortController();
 const pending=host.open({DatyPlatform:{kind:'native'},DatyBinaryImports:{VERSION:'daty-binary-import-v1',openBytes:()=>new Promise(()=>{})}},{signal:controller.signal});
 controller.abort();assert.equal((await pending).status,'cancelled');
});
test('browser chooser opens in click stack, reads bytes, and handles cancel',async()=>{
 const h=harness(),handlers={};let clicked=false,removed=false;
 const input={addEventListener:(n,f)=>handlers[n]=f,remove:()=>removed=true,click:()=>clicked=true,files:[{name:'test.zip',size:4,arrayBuffer:async()=>h.bytes.buffer}]};
 const runtime={DatyPlatform:{kind:'browser'},document:{createElement:()=>input,body:{appendChild(){}}}};
 const result=h.context.DatyPluginImportHost.open(runtime);assert.equal(clicked,true);await handlers.change();assert.equal((await result).status,'selected');assert.equal(removed,true);
 const cancelled=h.context.DatyPluginImportHost.open(runtime);handlers.cancel();assert.equal((await cancelled).status,'cancelled');
});
