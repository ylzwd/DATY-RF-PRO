'use strict';
// Production report/UI functions with injected dialogs, output, clock and state.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'src/modules/planning-ui.js'),'utf8');
const exportsFactory=require('../src/platform/browser-platform.js').textExports;
const frequencyContext=vm.createContext({});frequencyContext.window=frequencyContext;
vm.runInContext(fs.readFileSync(path.join(root,'src/modules/frequency.js'),'utf8'),frequencyContext);
const frequency=frequencyContext.DatyFrequency,fixedDate=new Date('2026-09-12T17:00:00.000Z');
const result={retention:{retainedCount:1,changedCount:1},engineVersion:'fixture-engine',options:{compatibilityLevel:'standard',rangeStartKHz:640000,rangeEndKHz:690000,stepKHz:250},
 assignments:[{deviceId:'rx1_ch1',brand:'DATYaudio',brandKey:'datyaudio',frequencyKHz:641250,minimumChannelSpacingKHz:250,channelSpacingKHz:250,intermodSpacingKHz:125,candidateStepKHz:250,
  profileId:'daty',profileBandId:'UHF',profileModeId:'normal',profileSource:'user-verified',deploymentEligible:true,locked:false,backupFrequenciesKHz:[642500],scanLevelDbm:null,retainedOriginal:false,changeReason:'固定夹具'}],
 unassignedDeviceIds:[],analysis:{conflicts:[],minChannelSpacingKHz:250,minImdSeparationKHz:null,minImdMarginKHz:null},errors:[],warnings:['数学校验并非实测'],profileSnapshots:[{id:'daty'}]};
const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const drain=()=>new Promise(resolve=>setImmediate(resolve));
function harness(platform={kind:'native'},plan=clone(result)){
 const a=source.indexOf('  function buildIMDReportText('),b=source.indexOf('  // daty-auto-frequency-v1.',a);assert.ok(a>=0&&b>a);
 const notices=[],calls=[],dialogs=[],browserReads=[],listeners=new Map(),devices=[{id:'rx1_ch1',ch:'CH1',rf:-45}],fields={range:'640-690'};
 const button={disabled:false,attributes:{},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];}};
 const port={VERSION:'daty-text-export-v1',async saveText(text,options){assert.equal(this,port);calls.push({text,options});return {status:'saved'};}};
 const context={DatyFrequency:frequency,lastCoordination:plan,getDevices:()=>devices,captureConstraintFields:()=>fields,AbortController,
  Date:class extends Date{constructor(...args){super(...(args.length?args:[fixedDate]));}},
  notify:(...args)=>notices.push(args),DatyPlatform:platform,DatyTextExports:port,DatyTextExportFactory:exportsFactory,
  DatyDialogs:{async confirm(options){dialogs.push(options);return true;}},
  document:{getElementById:id=>id==='plannerExportReport'?button:null},
  addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
  removeEventListener(name,fn){listeners.get(name)?.delete(fn);}};
 for(const key of ['Blob','URL','localStorage','fetch'])Object.defineProperty(context,key,{get(){browserReads.push(key);throw Error('Browser bypass: '+key);},configurable:true});
 const c=vm.createContext(context);c.global=c;vm.runInContext(source.slice(a,b),c);
 return {c,notices,calls,dialogs,browserReads,button,devices,fields,port,emit(name){for(const fn of listeners.get(name)||[])fn();},listeners};
}

test('native report uses bound async save with unchanged UTF-8 report, filename, units and all evidence',async()=>{
 const h=harness(),before=JSON.stringify(h.c.lastCoordination);assert.equal(await h.c.exportIMDReport(),true);
 assert.equal(h.calls.length,1);assert.deepEqual(h.browserReads,[]);assert.equal(JSON.stringify(h.c.lastCoordination),before);
 assert.equal(h.calls[0].options.fileName,'DATY_Coordination_2026-09-12.txt');assert.equal(h.calls[0].options.mimeType,'text/plain;charset=utf-8');
 assert.equal(h.calls[0].text,h.c.buildIMDReportText(h.c.lastCoordination,h.devices,fixedDate));
 for(const text of ['641.250 MHz','minimumChannelSpacingKHz=250','642.500','scan=N/A dBm','不计算 IMD 功率','未做 WWB6 实测对照'])assert.ok(h.calls[0].text.includes(text),text);
 assert.equal(h.notices.at(-1)[1],'文件已保存');assert.equal(h.button.disabled,false);assert.equal(h.button.attributes['aria-busy'],undefined);
});

test('browser output reports download started, never claims completed disk save',async()=>{
 const calls=[],platform={kind:'browser',downloadText(text,options){assert.equal(this,platform);calls.push({text,options});}};
 const h=harness(platform);delete h.c.DatyTextExports;assert.equal(await h.c.exportIMDReport(),true);
 assert.equal(calls.length,1);assert.equal(h.notices.at(-1)[1],'已开始下载');assert.deepEqual(h.browserReads,[]);
});

test('confirmation and native save cancellation produce no success notice and allow retry',async()=>{
 const h=harness();h.c.DatyDialogs.confirm=async()=>false;assert.equal(await h.c.exportIMDReport(),false);assert.equal(h.calls.length,0);
 h.c.DatyDialogs.confirm=async()=>true;h.port.saveText=async()=>({status:'cancelled'});
 assert.equal(await h.c.exportIMDReport(),false);assert.deepEqual(h.notices,[]);assert.equal(h.button.disabled,false);
});

test('one export remains pending through confirmation and file write; repeated calls never duplicate output',async()=>{
 const h=harness(),decision=deferred(),save=deferred();let confirms=0,writes=0;
 h.c.DatyDialogs.confirm=()=>{confirms++;return decision.promise;};h.port.saveText=()=>{writes++;return save.promise;};
 const pending=h.c.exportIMDReport();assert.equal(h.button.disabled,true);assert.equal(await h.c.exportIMDReport(),false);
 assert.equal(confirms,1);assert.equal(writes,0);decision.resolve(true);await drain();
 assert.equal(writes,1);assert.equal(await h.c.exportIMDReport(),false);assert.deepEqual(h.notices,[]);
 save.resolve({status:'saved'});assert.equal(await pending,true);assert.equal(h.button.disabled,false);
});

test('replaced/invalidated plans, mutated results, changed inputs or channel labels invalidate old confirmation',async()=>{
 for(const change of ['replace','invalidate','result','fields','channel']){
  const h=harness(),decision=deferred();h.c.DatyDialogs.confirm=()=>decision.promise;const pending=h.c.exportIMDReport();
  if(change==='replace')h.c.lastCoordination=clone(h.c.lastCoordination);
  if(change==='invalidate')h.c.lastCoordination=null;
  if(change==='result')h.c.lastCoordination.options.stepKHz=500;
  if(change==='fields')h.fields.range='650-680';
  if(change==='channel')h.devices[0].ch='CH8';
  decision.resolve(true);assert.equal(await pending,false);assert.equal(h.calls.length,0);
  assert.match(h.notices.at(-1)[2],/规划结果或输入已变化/);assert.equal(h.button.disabled,false);
 }
});

test('unrelated live RF telemetry does not prevent exporting the reviewed plan snapshot',async()=>{
 const h=harness(),decision=deferred();h.c.DatyDialogs.confirm=()=>decision.promise;
 const pending=h.c.exportIMDReport();h.devices[0].rf=-60;decision.resolve(true);
 assert.equal(await pending,true);assert.equal(h.calls.length,1);assert.equal(h.devices[0].rf,-60);
});

test('changed dialog/platform/save owner while reviewing cannot redirect report output',async()=>{
 for(const owner of ['DatyDialogs','DatyPlatform','DatyTextExportFactory','DatyTextExports']){
  const h=harness(),decision=deferred();h.c.DatyDialogs.confirm=()=>decision.promise;const pending=h.c.exportIMDReport();
  h.c[owner]={...h.c[owner]};decision.resolve(true);assert.equal(await pending,false);assert.equal(h.calls.length,0);
  assert.match(h.notices.at(-1)[2],/保存环境已变化/);
 }
});

test('missing/invalid confirmation or native save capability cannot fall back or report success',async()=>{
 const cases=[h=>delete h.c.DatyDialogs,h=>h.c.DatyDialogs={confirm:()=>true},h=>h.c.DatyDialogs={confirm:async()=>'true'},
  h=>delete h.c.DatyTextExportFactory,h=>delete h.c.DatyTextExports,h=>h.port.saveText=()=>({status:'saved'}),
  h=>h.port.saveText=async()=>({status:'download-started'}),h=>h.port.saveText=async()=>{throw Error('disk full');}];
 for(const change of cases){const h=harness();change(h);assert.equal(await h.c.exportIMDReport(),false);
  assert.equal(h.calls.length,0);assert.deepEqual(h.browserReads,[]);assert.ok(!h.notices.some(n=>['文件已保存','已开始下载'].includes(n[1])));assert.equal(h.button.disabled,false);}
});

test('pagehide during confirmation rejects late approval; during native write aborts and suppresses late results',async()=>{
 const h=harness(),decision=deferred();h.c.DatyDialogs.confirm=()=>decision.promise;
 const pending=h.c.exportIMDReport();h.emit('pagehide');decision.resolve(true);assert.equal(await pending,false);assert.equal(h.calls.length,0);
 h.c.DatyDialogs.confirm=async()=>true;const write=deferred();let signal;
 h.port.saveText=(_text,options)=>{signal=options.signal;return write.promise;};
 const saving=h.c.exportIMDReport();await drain();h.emit('pagehide');assert.equal(await saving,false);assert.equal(signal.aborted,true);
 write.resolve({status:'saved'});await drain();assert.deepEqual(h.notices,[]);assert.equal(h.listeners.get('pagehide').size,0);
});

test('host replacement during native save suppresses old completion; saved text stays the reviewed snapshot',async()=>{
 const h=harness(),write=deferred();let text;
 h.port.saveText=value=>{text=value;return write.promise;};const before=h.c.buildIMDReportText(h.c.lastCoordination,h.devices,fixedDate);
 const saving=h.c.exportIMDReport();await drain();h.c.DatyPlatform={kind:'replacement'};h.c.lastCoordination=null;
 write.resolve({status:'saved'});assert.equal(await saving,false);assert.deepEqual(h.notices,[]);assert.equal(text,before);
});

test('no valid coordination result cannot export stale or placeholder output',async()=>{
 const h=harness(undefined,null);assert.equal(await h.c.exportIMDReport(),false);assert.equal(h.calls.length,0);
 assert.equal(h.dialogs.length,0);assert.equal(h.notices[0][1],'无可导出结果');
});

test('pure export model is deterministic, covers all assignments and reports incomplete plans without claiming approval',()=>{
 const h=harness(),many=clone(result);many.assignments.push({...many.assignments[0],deviceId:'rx2_ch8',brand:'AMSaudio',frequencyKHz:650000,backupFrequenciesKHz:[]});
 many.errors=['未分配原因'];many.unassignedDeviceIds=['missing'];many.analysis.conflicts=[{type:'fixture'}];
 const channels=[{id:'rx1_ch1',ch:'CH1'},{id:'rx2_ch8',ch:'CH8'}],before=JSON.stringify([many,channels]);
 const prepared=h.c.prepareIMDReportExport(many,channels,fixedDate);
 assert.equal(JSON.stringify(prepared),JSON.stringify(h.c.prepareIMDReportExport(many,channels,fixedDate)));
 assert.ok(prepared.text.includes('DATYaudio CH1'));assert.ok(prepared.text.includes('AMSaudio CH8, 650.000 MHz'));
 assert.ok(prepared.text.includes('【未分配原因】'));assert.equal(JSON.stringify([many,channels]),before);assert.deepEqual(h.browserReads,[]);
 assert.equal(prepared.dialog.details.find(d=>d.label==='规划范围').value,'640.000–690.000 MHz');
 assert.equal(prepared.dialog.details.find(d=>d.label==='校核结果').value,'冲突 1 · 错误 1 · 提示 1');
});
