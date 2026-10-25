const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=process.env.DATY_TEST_ASSET_ROOT || path.join(__dirname,'..');
const publicBuild=root.replaceAll('\\','/').endsWith('/public');
const source=publicBuild?fs.readFileSync(path.join(root,'src/modules/discovery.js'),'utf8').split('/* DATY_PLUGIN_SOURCE_EXPORT_BEGIN */')[1].split('/* DATY_PLUGIN_SOURCE_EXPORT_END */')[0]:['src/platform/plugin-export-host.js','src/modules/plugin-source-catalog.js','src/modules/plugin-source-export.js'].map(n=>fs.readFileSync(path.join(root,n),'utf8')).join('\n');
function harness(){
 const calls=[],notices=[],saves=[],listeners={},timers=new Map();let index=0,adapters={'shure-scp':{}},pending=null,saveResult={status:'download-started'};
 const button={disabled:false,setAttribute(k,v){this[k]=v;},removeAttribute(k){delete this[k];}},list={hidden:true,children:[],replaceChildren(){this.children=[];},appendChild(n){this.children.push(n);}};
 const context=vm.createContext({AbortController,Uint8Array,crypto:crypto.webcrypto,atob:v=>Buffer.from(v,'base64').toString('binary'),
  _fasheApiUrl:'https://server-a:8080',_serverGeneration:1,DatyPlatform:{kind:'browser'},
  document:{getElementById:id=>id==='developerPluginExport'?button:id==='developerPluginExports'?list:null,createElement:()=>({addEventListener(name,fn){this[name]=fn;}})},
  addEventListener:(n,f)=>listeners[n]=f,removeEventListener:n=>delete listeners[n],notify:(...args)=>notices.push(args),
  _discoveryRuntime(method,...args){if(method==='clearTimeout'){timers.delete(args[0]);return;}assert.equal(method,'setTimeout');timers.set(++index,args[0]);return index;},
  _discoveryRequest:async(url,options)=>{calls.push({url,options});if(pending)await pending;return {ok:true,json:async()=>({success:true,adapters})};}});
 vm.runInContext(source,context);
 const realHost=context.DatyPluginExportHost;
 context.DatyPluginExportHost={save:async(runtime,bytes,opts)=>{saves.push({bytes,opts});return saveResult;}};
 return {context,realHost,button,list,calls,notices,saves,timers,listeners,setAdapters:v=>adapters=v,setPending:v=>pending=v,setSaveResult:v=>saveResult=v};
}
test('registered Shure export downloads actual ZIP once; no data/settings request',async()=>{
 const h=harness();assert.equal(await h.context.exportDeveloperPlugin(),true);assert.equal(h.saves.length,1);
 const saved=h.saves[0];assert.equal(Buffer.from(saved.bytes).subarray(0,4).toString('hex'),'504b0304');
 assert.match(saved.opts.fileName,/^DATY-shure-scp-[a-f0-9]+\.zip$/);assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].url,'https://server-a:8080/api/capabilities');assert.equal(h.calls[0].options.method,'GET');
 assert.match(h.notices[0][1],/已开始下载/);assert.equal(h.button.disabled,false);assert.equal(h.timers.size,0);
});
test('unregistered, invalid or inherited capabilities never expose exports',async()=>{
 for(const adapters of [{},{'unknown-readonly':{}},{'shure-scp':[]},Object.create({'shure-scp':{}})]){
  const h=harness();h.setAdapters(adapters);assert.equal(await h.context.exportDeveloperPlugin(),false);assert.equal(h.saves.length,0);
 }
});
test('double click does not start a duplicate request/download',async()=>{
 const h=harness();let release;h.setPending(new Promise(r=>release=r));const first=h.context.exportDeveloperPlugin();
 assert.equal(h.button.disabled,true);assert.equal(await h.context.exportDeveloperPlugin(),false);release();
 assert.equal(await first,true);assert.equal(h.calls.length,1);assert.equal(h.saves.length,1);
});
test('server change during read discards the old export',async()=>{
 const h=harness();let release;h.setPending(new Promise(r=>release=r));const task=h.context.exportDeveloperPlugin();
 h.context._fasheApiUrl='https://server-b:8080';h.context._serverGeneration++;release();
 assert.equal(await task,false);assert.equal(h.saves.length,0);assert.equal(h.notices.length,0);
});
test('corrupt ZIP is rejected before save',async()=>{
 const h=harness();h.context.DatyPluginSourceCatalog=[{...h.context.DatyPluginSourceCatalog[0],sha256:'0'.repeat(64)}];
 assert.equal(await h.context.exportDeveloperPlugin(),false);assert.equal(h.saves.length,0);assert.match(h.notices[0][2],/校验失败/);
});
test('future brands share the registry and require explicit selection when several are available',async()=>{
 const h=harness();const item=h.context.DatyPluginSourceCatalog[0];h.context.DatyPluginSourceCatalog=[item,{...item,id:'future-brand',name:'Future Brand',adapterKeys:['future-adapter']}];
 h.setAdapters({'shure-scp':{},'future-adapter':{}});assert.equal(await h.context.exportDeveloperPlugin(),false);
 assert.equal(h.saves.length,0);assert.equal(h.list.hidden,false);assert.equal(h.list.children.length,3);
 assert.equal(await h.context.exportDeveloperPlugin('future-brand'),true);assert.equal(h.saves.length,1);
 assert.match(h.notices[0][2],/Future Brand/);
});
test('cancelled and failed saves never claim success; button recovers',async()=>{
 for(const result of [{status:'cancelled'},{status:'unknown'}]){
  const h=harness();h.setSaveResult(result);assert.equal(await h.context.exportDeveloperPlugin(),false);assert.equal(h.button.disabled,false);
  assert.ok(h.notices.every(n=>!n[1].includes('已开始下载')&&!n[1].includes('已保存')));
 }
 const h=harness();h.context.DatyPluginExportHost={save:async()=>{throw Error('disk error');}};
 assert.equal(await h.context.exportDeveloperPlugin(),false);assert.match(h.notices[0][2],/disk error/);assert.equal(h.button.disabled,false);
});
test('page leave and timeout discard pending export',async()=>{
 for(const abort of [h=>h.listeners.pagehide(),h=>Array.from(h.timers.values())[0]()]){
  const h=harness();let release;h.setPending(new Promise(r=>release=r));const task=h.context.exportDeveloperPlugin();abort(h);release();
  assert.equal(await task,false);assert.equal(h.saves.length,0);assert.equal(h.button.disabled,false);
 }
});
test('binary browser host produces correct Blob and releases URL after download',async()=>{
 const h=harness(),events=[];let blob,cleanup;
 const runtime={DatyPlatform:{kind:'browser'},Blob,URL:{createObjectURL:b=>{blob=b;return 'blob:fixture';},revokeObjectURL:u=>events.push(u)},
  document:{createElement:()=>({click(){events.push('download');},remove(){events.push('remove');}}),body:{appendChild:()=>events.push('append')}},
  setTimeout:f=>{cleanup=f;}};
 const bytes=Uint8Array.from([80,75,3,4]);assert.equal((await h.realHost.save(runtime,bytes,{fileName:'test.zip'})).status,'download-started');
 assert.deepEqual(Buffer.from(await blob.arrayBuffer()),Buffer.from(bytes));assert.equal(blob.type,'application/zip');
 assert.deepEqual(events,['append','download','remove']);cleanup();assert.equal(events.at(-1),'blob:fixture');
});
test('native binary output requires its port, handles cancellation and unknown results',async()=>{
 const h=harness(),bytes=Uint8Array.from([80,75]),runtime={DatyPlatform:{kind:'native'}};
 await assert.rejects(h.realHost.save(runtime,bytes,{fileName:'test.zip'}),/未提供/);
 runtime.DatyBinaryExports={VERSION:'daty-binary-export-v1',saveBytes:async()=>({status:'saved'})};
 assert.equal((await h.realHost.save(runtime,bytes,{fileName:'test.zip'})).status,'saved');
 runtime.DatyBinaryExports.saveBytes=async()=>({status:'unknown'});await assert.rejects(h.realHost.save(runtime,bytes,{fileName:'test.zip'}),/未确认/);
 const abort=new AbortController();abort.abort();assert.equal((await h.realHost.save(runtime,bytes,{fileName:'test.zip',signal:abort.signal})).status,'cancelled');
});
