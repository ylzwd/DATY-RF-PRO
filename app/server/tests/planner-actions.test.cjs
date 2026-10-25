'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),read=n=>fs.readFileSync(path.join(root,'src/modules',n+'.js'),'utf8');
const factory=require('../src/platform/browser-platform.js').textExports;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const drain=()=>new Promise(resolve=>setImmediate(resolve));
function csv(){
 const events=new Map(),writes=[],notices=[],button={disabled:false,setAttribute(){},removeAttribute(){}};
 const c=vm.createContext({AbortController,DEVICES:[{id:'rx1',_fasheId:'rx1_ch1',name:'鼓手,"主唱"',brand:'DATYaudio',model:'X2',ch:'CH1',ip:'192.0.2.1',freq:641000,planned:641250,equipmentProfileId:'fixture'}],
  document:{getElementById:()=>button},DatyDialogs:{confirm:async()=>true},DatyPlatform:{kind:'native'},DatyTextExportFactory:factory,
  DatyTextExports:{VERSION:factory.VERSION,async saveText(text,options){writes.push({text,options});return{status:'saved'};}},
  notify:(...a)=>notices.push(a),addEventListener:(n,fn)=>events.set(n,fn),removeEventListener:n=>events.delete(n)});
 c.globalThis=c;for(const key of ['Blob','URL','localStorage','fetch'])Object.defineProperty(c,key,{get(){throw Error('Forbidden browser fallback');}});
 const source=read('navigation');vm.runInContext(source.slice(source.indexOf('function escapeCsvCell'),source.indexOf('/**',source.indexOf('function escapeCsvCell'))),c);
 return {c,writes,notices,button,events};
}
test('CSV export preserves UTF8 BOM, CRLF, quotes, all rows and current/planned MHz without mutating devices',async()=>{
 const h=csv(),before=JSON.stringify(h.c.DEVICES);assert.equal(await h.c.exportPlan(),true);
 assert.equal(h.writes.length,1);assert.equal(h.writes[0].text,'\uFEFFdevice_id,name,brand,model,channel,ip,current_mhz,planned_mhz,profile_id\r\nrx1_ch1,"鼓手,""主唱""",DATYaudio,X2,CH1,192.0.2.1,641.000,641.250,fixture');
 assert.equal(JSON.stringify(h.c.DEVICES),before);assert.equal(h.notices.at(-1)[1],'文件已保存');assert.equal(h.button.disabled,false);
 const full=h.c.DatyPlanCsv.prepareExport([...h.c.DEVICES,...h.c.DEVICES],new Date('2026-09-15Z'));assert.equal(full.text.split('\r\n').length,3);
});
test('CSV exports unbound reserves with empty identity and refuses stale pool confirmation',async()=>{
 const h=csv();h.c.DATY_LAST_COORDINATION={frequencyPool:{targetCount:25,actualCount:1,plannedCount:3,complete:false,reservedFrequenciesKHz:[642000,643000]}};
 assert.equal(await h.c.exportPlan(),true);assert.equal(h.writes[0].text.split('\r\n').length,4);assert.ok(h.writes[0].text.endsWith(',预留频点 2（未绑定设备）,,,,,,643.000,'));assert.equal(h.c.DEVICES.length,1);
 const other=csv(),d=deferred();other.c.DATY_LAST_COORDINATION={frequencyPool:{targetCount:25,actualCount:1,plannedCount:2,complete:false,reservedFrequenciesKHz:[642000]}};other.c.DatyDialogs.confirm=()=>d.promise;
 const pending=other.c.exportPlan();other.c.DATY_LAST_COORDINATION=null;d.resolve(true);assert.equal(await pending,false);assert.equal(other.writes.length,0);
});
test('CSV confirmation is single, cancellable and rejects updated frequency/name or changed save owner',async()=>{
 for(const change of ['cancel','freq','name','owner']){
  const h=csv(),d=deferred();h.c.DatyDialogs.confirm=()=>d.promise;const pending=h.c.exportPlan();
  assert.equal(await h.c.exportPlan(),false);assert.equal(h.button.disabled,true);
  if(change==='freq')h.c.DEVICES[0].freq=650000;if(change==='name')h.c.DEVICES[0].name='other';if(change==='owner')h.c.DatyTextExports={...h.c.DatyTextExports};
  d.resolve(change!=='cancel');assert.equal(await pending,false);assert.equal(h.writes.length,0);assert.equal(h.button.disabled,false);
 }
});
test('CSV output distinguishes browser initiation, native failure/cancellation, missing capability and page exit',async()=>{
 const h=csv();h.c.DatyPlatform={kind:'browser',downloadText:(text,options)=>h.writes.push({text,options})};delete h.c.DatyTextExports;
 assert.equal(await h.c.exportPlan(),true);assert.equal(h.notices.at(-1)[1],'已开始下载');
 for(const save of [()=>({status:'saved'}),async()=>{throw Error('disk full');},async()=>({status:'cancelled'})]){
  const x=csv();x.c.DatyTextExports.saveText=save;assert.equal(await x.c.exportPlan(),false);assert.equal(x.writes.length,0);
 }
 const x=csv();delete x.c.DatyTextExports;assert.equal(await x.c.exportPlan(),false);assert.equal(x.writes.length,0);
 const y=csv(),pending=deferred();y.c.DatyTextExports.saveText=()=>pending.promise;const saving=y.c.exportPlan();await drain();y.events.get('pagehide')();assert.equal(await saving,false);pending.resolve({status:'saved'});await drain();assert.deepEqual(y.notices,[]);
});
function windows(){
 const calls=[],edits=[],notices=[],events=new Map(),fields={plannerStepKHz:'25',plannerMinSpacingKHz:'',plannerImdSpacingKHz:'',plannerScanThresholdDbm:'',plannerImdPolicy:'third'},done=deferred();
 const c=vm.createContext({AbortController,DatyPlatform:{kind:'native'},captureConstraintFields:()=>({...fields}),
  document:{getElementById:id=>({id,get value(){return fields[id];},set value(v){fields[id]=v;}})},
  onConstraintEdit:e=>edits.push(e.target.id),readExtraSettings(){if(fields.plannerStepKHz==='')throw Error('不完整草稿');},
  plannerDetailHtml:'<p>完整 &lt;设备&gt; &amp; 约束</p><ul><li>250 kHz</li><li>未做实测</li></ul>',
  DatyPlannerViews:{VERSION:'daty-planner-views-v1',open(model,options){assert.equal(this,c.DatyPlannerViews);calls.push({model,options});return done.promise;}},
  notify:(...a)=>notices.push(a),addEventListener:(n,fn)=>events.set(n,fn),removeEventListener:n=>events.delete(n)});c.global=c;
 const source=read('planning-ui'),start=source.indexOf('  const PLANNER_SAFETY_FIELDS');vm.runInContext(source.slice(start,source.indexOf('  function openPlannerResultDetails()',start)),c);
 return{c,calls,edits,notices,events,fields,done};
}
test('native detail model preserves literal text and line structure without HTML or browser dialogs',async()=>{
 const h=windows(),opening=h.c.openPlannerWindow('details');assert.equal(h.calls[0].model.text,'完整 <设备> & 约束\n• 250 kHz\n• 未做实测');
 assert.equal(h.calls[0].options.onEdit({id:'plannerStepKHz',value:'50'}).accepted,false);h.done.resolve({status:'closed'});assert.equal(await opening,true);assert.deepEqual(h.edits,[]);
});
test('native safety edits retain live drafts, reject wrong fields and stale project/host edits',async()=>{
 const h=windows(),opening=h.c.openPlannerWindow('safety'),edit=h.calls[0].options.onEdit;
 assert.equal(h.calls[0].model.fields.length,5);assert.equal(await h.c.openPlannerWindow('details'),false);
 assert.equal(edit({id:'plannerStepKHz',value:'50'}).accepted,true);assert.equal(h.fields.plannerStepKHz,'50');
 assert.equal(edit({id:'plannerStepKHz',value:''}).validationMessage,'不完整草稿');assert.equal(h.fields.plannerStepKHz,'');
 assert.equal(edit({id:'receiver_ip',value:'other'}).accepted,false);assert.equal(edit({id:'plannerStepKHz',value:25}).accepted,false);
 h.fields.plannerImdPolicy='third-fifth';assert.equal(edit({id:'plannerStepKHz',value:'25'}).accepted,false);
 h.c.closePlannerWindow('safety');assert.equal(await opening,false);assert.equal(edit({id:'plannerStepKHz',value:'25'}).accepted,false);assert.equal(h.fields.plannerStepKHz,'');
});
test('missing or invalid native window never opens browser UI and pagehide rejects late edits',async()=>{
 for(const port of [undefined,{VERSION:'wrong'}, {VERSION:'daty-planner-views-v1',open:()=>({status:'closed'})}]){
  const h=windows();h.c.DatyPlannerViews=port;assert.equal(await h.c.openPlannerWindow('safety'),false);assert.equal(h.notices.at(-1)[1],'规划窗口打开失败');
 }
 const h=windows(),opening=h.c.openPlannerWindow('safety');h.events.get('pagehide')();assert.equal(await opening,false);
 assert.equal(h.calls[0].options.onEdit({id:'plannerStepKHz',value:'60'}).accepted,false);h.done.resolve({status:'closed'});
});
function progress(port){
 const events=new Map(),c=vm.createContext({DatyPlatform:{kind:'native'},DatyDeployProgress:port,
  addEventListener:(n,fn)=>events.set(n,fn),removeEventListener:n=>events.delete(n)});c.window=c;
 Object.defineProperty(c,'document',{get(){throw Error('Native progress must never use DOM');}});vm.runInContext(read('deploy-progress'),c);return {c,events};
}
const row={id:'rx_ch1',brand:'DATYaudio',receiver:'192.0.2.1',channel:'CH1',frequency:'641.250 MHz'};
const state=overrides=>({phase:'running',total:1,acknowledged:0,skipped:0,failed:0,remaining:1,rows:[{id:'rx_ch1',state:'queued'}],...overrides});
test('native progress preserves this, rejects fake success, allows one stop, retains ACK state and guards closing',()=>{
 let options,closed=0,stops=0;const updates=[],handle={update(s){assert.equal(this,handle);updates.push(s);},close(){assert.equal(this,handle);closed++;}},port={VERSION:'daty-deploy-progress-v1',open(o){assert.equal(this,port);options=o;return handle;}};
 const h=progress(port),view=h.c.DatyDeployProgress.open({rows:[row],onStop:()=>stops++});assert.throws(()=>h.c.DatyDeployProgress.open({rows:[row]}),/已有/);
 view.update(state());assert.throws(()=>view.update(state({phase:'success'})),/ACK/);assert.throws(()=>view.update(state({total:2})),/计数/);
 options.onStop();options.onStop();assert.equal(stops,1);assert.equal(options.onClose(),false);view.close();assert.equal(closed,0);
 view.update(state({phase:'success',acknowledged:1,remaining:0,rows:[{id:'rx_ch1',state:'acknowledged'}]}));
 view.update(state());assert.equal(updates.length,2);assert.equal(options.onClose(),true);assert.equal(closed,1);options.onStop();assert.equal(stops,1);
});
test('native progress preparation failure, missing port and pagehide keep control separate from view disposal',()=>{
 for(const port of [undefined,{}, {VERSION:'daty-deploy-progress-v1',open:async()=>({})}]){
  const h=progress(port);assert.throws(()=>h.c.DatyDeployProgress.open({rows:[row]}),/原生|同步/);
 }
 let stopped=0,closed=0;const updates=[];const h=progress({VERSION:'daty-deploy-progress-v1',open:()=>({update:s=>updates.push(s),close:()=>closed++})});
 const view=h.c.DatyDeployProgress.open({rows:[row],onStop:()=>stopped++});view.update(state());view.failBeforeSend('failed before send');
 assert.equal(updates.at(-1).phase,'failed');assert.equal(updates.at(-1).acknowledged,0);assert.equal(updates.at(-1).remaining,1);view.close();assert.equal(closed,1);
 const active=h.c.DatyDeployProgress.open({rows:[row],onStop:()=>stopped++});active.update(state({rows:[{id:'rx_ch1',state:'sending'}]}));assert.throws(()=>active.failBeforeSend('bad'),/已开始/);
 h.events.get('pagehide')();assert.equal(stopped,0);assert.equal(closed,2);active.update(state());
});
test('every planner button and dynamic send row maps to a known checked action; no system confirmation APIs are added',()=>{
 const source=read('planning-ui'),start=source.indexOf('  const plannerActions='),end=source.indexOf('  global.runPlanning',start);
 const globals={};for(const name of ['switchPlannerControlTab','importEquipmentProfile','confirmSelectedLock','removeSelectedLock','saveCurrentPlanningConstraints','runPlanning','openPlannerResultDetails','exportIMDReport','closePlannerWindow','getPlannerWindowModel'])globals[name]=()=>{};
 globals.global=globals;vm.runInNewContext(source.slice(start,end),globals);
 const known=new Set(globals.DatyPlannerActions.list().map(x=>x.id));assert.equal(known.size,18);
 const html=fs.readFileSync(path.join(root,'unirf-app.html'),'utf8').split('<div id="panel-planner"')[1].split('<!-- ═════ DEVICES')[0];
 for(const button of html.matchAll(/<button\b[^>]*>/g)){const action=button[0].match(/data-planner-action="([^"]+)"/);assert.ok(action,button[0]);assert.ok(known.has(action[1]),action[1]);}
 assert.match(read('render'),/data-planner-action="pushOne"/);assert.throws(()=>globals.DatyPlannerActions.execute('pushOne'),/身份/);
 assert.throws(()=>globals.DatyPlannerActions.execute('unknown'),/未知/);
});

test('changed native platform disposes the old progress view before opening a new session',()=>{
 let closed=0;const updates=[],h=progress({VERSION:'daty-deploy-progress-v1',open:()=>({update:s=>updates.push(s),close:()=>closed++})});
 const old=h.c.DatyDeployProgress.open({rows:[row]});h.c.DatyPlatform={kind:'new-native'};
 const next=h.c.DatyDeployProgress.open({rows:[row]});assert.equal(closed,1);old.update(state());assert.equal(updates.length,0);
 next.update(state({rows:[{id:'wrong',state:'sending'}]}));assert.equal(updates[0].rows.length,0);h.events.get('pagehide')();assert.equal(closed,2);
});
