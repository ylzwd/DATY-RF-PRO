'use strict';
// Pure VM/host fixtures: no real filesystem pickers, services or device commands.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),factory=require('../src/platform/browser-platform.js').textFiles;
const options={accept:'.json',maxBytes:100};
const completed=(text='{}',name='sample.json',sizeBytes=Buffer.byteLength(text))=>({status:'completed',name,text,sizeBytes});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const native=port=>({AbortController,DatyPlatform:{kind:'native'},DatyTextFiles:{VERSION:'daty-text-file-v1',...port}});

function browserFixture(){
  const inputs=[],readers=[],events=new Map();
  const browser={AbortController,addEventListener:(n,f)=>events.set(n,f),removeEventListener:n=>events.delete(n),
    document:{body:{appendChild(input){input.attached=true;}},createElement(){
      const listeners=new Map(),input={style:{},addEventListener:(n,f)=>listeners.set(n,f),click(){this.clicked=true;},remove(){this.attached=false;},
        fire:n=>listeners.get(n)?.()};inputs.push(input);return input;
    }},FileReader:class{constructor(){readers.push(this);}readAsText(file,encoding){this.file=file;this.encoding=encoding;this.readyState=1;}abort(){this.aborted=true;this.readyState=2;this.onabort?.();}}};
  return {browser,inputs,readers,events,choose(text,name='sample.json',size=Buffer.byteLength(text)){
    const input=inputs.at(-1);input.files=[{name,text,size}];input.fire('change');
  },finish(text){const reader=readers.at(-1);reader.result=text;reader.readyState=2;reader.onload();}};
}

test('independent file contract preserves platform 1.0.0 and lazy initialization',()=>{
  assert.equal(require('../src/platform/browser-platform.js').VERSION,'1.0.0');
  assert.equal(factory.VERSION,'daty-text-file-v1');
  const c=vm.createContext({});
  for(const key of ['document','FileReader','fetch','localStorage'])Object.defineProperty(c,key,{get(){throw Error('unexpected '+key);}});
  vm.runInContext(fs.readFileSync(path.join(root,'src/platform/browser-platform.js'),'utf8'),c);
  assert.equal(c.DatyTextFileFactory.VERSION,factory.VERSION);
});

test('bound native port returns sanitized completed DTO and strips optional BOM',async()=>{
  let called=false;const port={VERSION:factory.VERSION,openText(o){assert.equal(this,port);assert.equal(o.accept,'.json');called=true;return Promise.resolve(completed('\uFEFF{"使用者":"测试"}'));}};
  const pending=factory.create(port).openText(options);assert.equal(called,true,'same click gesture');
  const result=await pending;assert.equal(result.status,'completed');assert.equal(result.text,'{"使用者":"测试"}');
  assert.equal(result.name,'sample.json');
});

test('native cancellation, synchronous failure and rejected Promise are distinct',async()=>{
  const port=openText=>factory.create({VERSION:factory.VERSION,openText});
  assert.deepEqual(await port(()=>({status:'cancelled'})).openText(options),{status:'cancelled'});
  const error=Error('host failure');
  await assert.rejects(port(()=>{throw error;}).openText(options),e=>e===error);
  await assert.rejects(port(()=>Promise.reject(error)).openText(options),e=>e===error);
});

test('native missing or invalid capabilities never touch browser even on failure',async()=>{
  for(const injected of [undefined,{},null,{VERSION:'future',openText(){throw Error('wrong version');}}]){
    const runtime={AbortController,DatyPlatform:{kind:'native'},DatyTextFiles:injected};
    for(const key of ['document','FileReader'])Object.defineProperty(runtime,key,{get(){throw Error('browser bypass');}});
    await assert.rejects(factory.openLatest(runtime,options),/当前宿主尚未提供文件导入能力/);
  }
});

test('both metadata and actual UTF8 bytes must fit, including multi-byte and surrogate text',async()=>{
  for(const result of [completed('{}','s.json',101),completed('a'.repeat(101),'s.json',1),completed('中'.repeat(34),'s.json',1),completed('😀'.repeat(26),'s.json',1)]){
    await assert.rejects(factory.create({VERSION:factory.VERSION,openText:()=>result}).openText(options),/大小上限/);
  }
  const exact=await factory.create({VERSION:factory.VERSION,openText:()=>completed('😀'.repeat(25))}).openText(options);
  assert.equal(exact.sizeBytes,100);
});

test('malformed result/options cannot be accepted as an empty or successful import',async()=>{
  const results=[null,{}, {status:'error'},completed({},'s.json',1),completed('{}','C:\\secret.json'),completed('{}','../s.json'),completed('{}','s.json',-1)];
  for(const value of results)await assert.rejects(factory.create({VERSION:factory.VERSION,openText:()=>value}).openText(options),/数据格式/);
  for(const opt of [{accept:'.csv',maxBytes:0},{accept:'.csv',maxBytes:1.5},{accept:'',maxBytes:100}]){
    await assert.rejects(factory.create({VERSION:factory.VERSION,openText(){throw Error('must not call');}}).openText(opt),/上限/);
  }
});

test('aborted native read settles promptly and ignores later success or failure',async()=>{
  const d=deferred(),controller=new AbortController();
  const read=factory.create({VERSION:factory.VERSION,openText:()=>d.promise}).openText({...options,signal:controller.signal});
  controller.abort();assert.deepEqual(await read,{status:'cancelled'});d.reject(Error('late disk failure'));
  let calls=0;await factory.create({VERSION:factory.VERSION,openText(){calls++;}}).openText({...options,signal:controller.signal});assert.equal(calls,0);
});

test('browser input is created only on click and removed after successful UTF8 reading',async()=>{
  const h=browserFixture(),adapter=factory.createBrowser(h.browser);assert.equal(h.inputs.length,0);
  const read=adapter.openText(options);assert.equal(h.inputs[0].clicked,true);assert.equal(h.inputs[0].accept,'.json');
  h.choose('{"使用者":"测试"}');assert.equal(h.readers[0].encoding,'utf-8');h.finish('{"使用者":"测试"}');
  assert.equal((await read).status,'completed');assert.equal(h.inputs[0].attached,false);assert.equal(h.events.size,0);
});

test('browser rejects oversized file before constructing FileReader',async()=>{
  const h=browserFixture(),read=factory.createBrowser(h.browser).openText(options);
  h.choose('{}','huge.json',5*1024*1024*1024);
  await assert.rejects(read,/大小上限/);assert.equal(h.readers.length,0);assert.equal(h.inputs[0].attached,false);
});

test('browser cancel, empty selection and page exit clean up without success',async()=>{
  for(const event of ['cancel','change','pagehide']){
    const h=browserFixture(),read=factory.createBrowser(h.browser).openText(options);
    if(event==='pagehide')h.events.get(event)();else h.inputs[0].fire(event);
    assert.equal((await read).status,'cancelled');assert.equal(h.inputs[0].attached,false);assert.equal(h.events.size,0);
  }
});

test('browser read error and thrown read failure reject and clear hidden inputs',async()=>{
  const h=browserFixture(),read=factory.createBrowser(h.browser).openText(options);h.choose('{}');h.readers[0].onerror();
  await assert.rejects(read,/无法读取/);assert.equal(h.inputs[0].attached,false);
  const second=browserFixture();second.browser.FileReader=class{readAsText(){throw Error('read denied');}};
  const next=factory.createBrowser(second.browser).openText(options);second.choose('{}');
  await assert.rejects(next,/read denied/);assert.equal(second.inputs[0].attached,false);
});

test('browser abort stops FileReader and captured late callback cannot complete',async()=>{
  const h=browserFixture(),controller=new AbortController(),read=factory.createBrowser(h.browser).openText({...options,signal:controller.signal});
  h.choose('{}');const callback=h.readers[0].onload;controller.abort();callback();
  assert.equal((await read).status,'cancelled');assert.equal(h.readers[0].aborted,true);assert.equal(h.inputs[0].attached,false);
});

test('latest shared import cancels an older host that ignores abort; reversed completion cannot win',async()=>{
  const calls=[],runtime=native({openText(o){const d=deferred();calls.push({...d,signal:o.signal});return d.promise;}});
  const first=factory.openLatest(runtime,options),second=factory.openLatest(runtime,options);
  assert.equal(calls[0].signal.aborted,true);assert.equal((await first).status,'cancelled');
  calls[1].resolve(completed('{}','second.json'));const result=await second;assert.equal(result.name,'second.json');assert.equal(result.isCurrent(),true);
  calls[0].resolve(completed('{}','first.json'));factory.cancelPending(runtime);assert.equal(result.isCurrent(),false);
});

test('commit guard rejects completed result after a new request or host replacement',async()=>{
  const runtime=native({openText:()=>completed()});const first=await factory.openLatest(runtime,options);
  const second=factory.openLatest(runtime,options);assert.equal(first.isCurrent(),false);await second;
  const third=await factory.openLatest(runtime,options);runtime.DatyPlatform={kind:'native'};assert.equal(third.isCurrent(),false);
  const d=deferred();runtime.DatyTextFiles={VERSION:factory.VERSION,openText:()=>d.promise};
  const pending=factory.openLatest(runtime,options);runtime.DatyTextFiles={};d.resolve(completed());assert.equal((await pending).status,'cancelled');
});

test('latest accepts external cancellation and already-aborted signals without opening picker',async()=>{
  const d=deferred(),controller=new AbortController();let calls=0,signal;
  const runtime=native({openText(o){calls++;signal=o.signal;return d.promise;}});
  const pending=factory.openLatest(runtime,{...options,signal:controller.signal});controller.abort();
  assert.equal((await pending).status,'cancelled');assert.equal(signal.aborted,true);d.reject(Error('late'));
  assert.equal((await factory.openLatest(runtime,{...options,signal:controller.signal})).status,'cancelled');assert.equal(calls,1);
});

function integration(){
  const values=new Map(),notices=[],calls=[],elements=new Map();
  const context={AbortController,console:{log(){},warn(){},error(){}},performance,crypto:{randomUUID:()=> 'test-record'},
    document:{readyState:'loading',addEventListener(){},createElement(tag){if(tag==='input')throw Error('browser input forbidden');return {value:'',textContent:''};},
      getElementById(id){if(!elements.has(id))elements.set(id,{value:'',style:{},options:[],textContent:'',innerHTML:'',appendChild(item){this.options.push(item);}});return elements.get(id);}},
    DatyPlatform:{kind:'native',storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}},
    DatyTextFileFactory:factory,DatyTextFiles:{VERSION:factory.VERSION,openText(options){const d=deferred();calls.push({...d,options});return d.promise;}},
    notify:(...args)=>notices.push(args),renderFreqTable(){},renderHistory(){},clearInterval(){},
    FileReader:class{constructor(){throw Error('browser reader forbidden');}}};
  context.DatyDialogs={confirm:async()=>true};
  const c=vm.createContext(context);c.window=c;
  for(const module of ['frequency','equipment-profiles','coordination','scan-csv','storage','spectrum','planning-ui']){
    vm.runInContext(fs.readFileSync(path.join(root,'src/modules',module+'.js'),'utf8'),c);
  }
  c.drawSpectrum=()=>{};c.updateRangeDisplay=()=>{};
  return {c,calls,values,notices,elements};
}
test('page teardown also invalidates completed result during caller await continuation',async()=>{
  const events=new EventTarget(),runtime=native({openText:()=>completed()});
  runtime.addEventListener=events.addEventListener.bind(events);runtime.removeEventListener=events.removeEventListener.bind(events);
  const pending=factory.openLatest(runtime,options);
  pending.then(()=>events.dispatchEvent(new Event('pagehide')));
  const result=await pending;assert.equal(result.isCurrent(),false);
});

test('invalid latest options reject asynchronously before superseding any current import',async()=>{
  const d=deferred(),runtime=native({openText:()=>d.promise}),read=factory.openLatest(runtime,options);
  await assert.rejects(factory.openLatest(runtime,undefined),/字节上限/);
  d.resolve(completed());assert.equal((await read).isCurrent(),true);
});

test('late failure notification has a commit guard without mutating original host error',async()=>{
  const original=Error('failed read'),runtime=native({openText:()=>Promise.reject(original)});
  const pending=factory.openLatest(runtime,options);
  pending.catch(()=>factory.cancelPending(runtime));
  let caught;try{await pending;}catch(error){caught=error;}
  assert.equal(caught.message,original.message);assert.equal(caught.cause,original);assert.equal(caught.isCurrent(),false);
  assert.equal(original.isCurrent,undefined);
});
const csv='Frequency (MHz),Level (dBm)\n641.000,-80\n641.250,-81';
test('production native CSV uses original parser, atomic bad-file behavior and latest-read guard',async()=>{
  const h=integration(),first=h.c.importScan('CSV'),second=h.c.importFile('CSV');
  h.calls[1].resolve(completed(csv,'new.csv'));assert.equal(await second,true);h.calls[0].resolve(completed(csv.replaceAll('641.','642.'),'old.csv'));
  assert.equal(await first,false);assert.equal(h.c.getCurrentScanPoints()[0].frequencyKHz,641000);
  const before=JSON.stringify(h.c.getCurrentScanPoints()),bad=h.c.importScan('CSV');h.calls[2].resolve(completed('Frequency,Level\n641,-80','bad.csv'));
  assert.equal(await bad,false);assert.equal(JSON.stringify(h.c.getCurrentScanPoints()),before);
});

test('production clearing scan or editing constraints cancels queued native imports',async()=>{
  for(const action of ['clearImportedScan','invalidateCoordination']){
    const h=integration(),read=h.c.importScan('CSV');
    h.c[action]();h.calls[0].resolve(completed(csv));assert.equal(await read,false);assert.equal(h.c.getCurrentScanPoints().length,0);
  }
});

test('production Profile uses unchanged atomic validator and cancels earlier scan across categories',async()=>{
  const h=integration(),profile=JSON.parse(JSON.stringify(h.c.DatyEquipmentProfiles.resolveEquipmentProfile({brand:'DATYaudio'})));profile.id='file-input-profile';
  const scan=h.c.importScan('CSV'),read=h.c.importEquipmentProfile();h.calls[1].resolve(completed(JSON.stringify(profile),'profile.json'));
  assert.equal(await read,true);h.calls[0].resolve(completed(csv));assert.equal(await scan,false);assert.equal(h.c.getCurrentScanPoints().length,0);
  const before=JSON.stringify([...h.values]),bad=h.c.importEquipmentProfile();h.calls[2].resolve(completed(JSON.stringify([profile,{id:'bad'}])));
  assert.equal(await bad,false);assert.equal(JSON.stringify([...h.values]),before);
});

test('production history import uses existing validation; cancelled or malformed inputs do not save',async()=>{
  const h=integration(),record={type:'daty_rf_planning',name:'fixture',devices:[],options:{}};
  let read=h.c.loadHistory('from-file');h.calls[0].resolve(completed(JSON.stringify(record)));assert.equal(await read,true);
  const before=JSON.stringify([...h.values]);read=h.c.loadHistory('cancelled');h.calls[1].resolve({status:'cancelled'});assert.equal(await read,false);
  read=h.c.loadHistory('broken');h.calls[2].resolve(completed('{'));assert.equal(await read,false);assert.equal(JSON.stringify([...h.values]),before);
});

test('history restore while an older read is pending prevents the late file from changing the active project',async()=>{
  const h=integration(),read=h.c.loadHistory('old-file');
  h.c.loadPlanFromData({type:'daty_rf_planning',name:'current',projectId:'current',devices:[]});
  const before=JSON.stringify([...h.values]);h.calls[0].resolve(completed(JSON.stringify({type:'daty_rf_planning',name:'old',projectId:'old',devices:[]})));
  assert.equal(await read,false);assert.equal(JSON.stringify([...h.values]),before);
});

test('file import is not allowed to invalidate a currently running deployment',async()=>{
  const h=integration(),read=h.c.importScan('CSV');h.c.DatyPlanningDeployment={isBusy:()=>true};
  h.calls[0].resolve(completed(csv));assert.equal(await read,false);assert.equal(h.c.getCurrentScanPoints().length,0);
  assert.match(h.notices.at(-1)[2],/正在下发/);
});

test('scan preview cancellation and changed server or deployment during confirmation never save or apply',async()=>{
  for(const mode of ['cancel','server','deploy','new-file']){
    const h=integration(),decision=deferred();let revision=1,saves=0,details;
    h.c.DatyDatabaseConnection={snapshot:()=>({origin:'https://fixture.invalid',revision,status:{epoch:'e'}})};
    h.c.DatyBusinessDatabase={saveImportedScan:async()=>{saves++;return true;}};
    h.c.DatyDialogs={confirm:value=>{details=value;return decision.promise;}};
    const read=h.c.importScan('CSV');h.calls[0].resolve(completed(csv,'preview.csv'));
    await new Promise(setImmediate);assert.equal(saves,0);assert.equal(h.c.getCurrentScanPoints().length,0);
    assert.ok(details.details.some(d=>d.value==='preview.csv'));
    if(mode==='server')revision++;if(mode==='deploy')h.c.DatyPlanningDeployment={isBusy:()=>true};
    if(mode==='new-file')h.c.invalidateCoordination();
    decision.resolve(mode!=='cancel');assert.equal(await read,false,mode);assert.equal(saves,0);assert.equal(h.c.getCurrentScanPoints().length,0);
  }
});
