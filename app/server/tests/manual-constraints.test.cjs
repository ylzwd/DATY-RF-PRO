const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const fixture=require('./fixtures/manual-constraints.json'),copy=v=>JSON.parse(JSON.stringify(v));
function harness(devices=fixture.devices,values=new Map()){
 const elements={},boot=[],notices=[],saves=[];
 function element(value=''){
  const events={},attrs={},classes=new Set();
  return {value,innerHTML:'',textContent:'',title:'',style:{},options:[],disabled:false,
   setAttribute:(k,v)=>attrs[k]=v,getAttribute:k=>attrs[k],addEventListener:(k,fn)=>events[k]=fn,dispatch:k=>events[k]?.(),
   classList:{toggle(k,v){v?classes.add(k):classes.delete(k);}},appendChild(v){this.options.push(v);},focus(){this.focused=true;}};
 }
 for(const [id,value]of Object.entries({...fixture.fields,plannerExcludedRanges:'',plannerLockedAssignments:'',plannerKnownCarriers:'',plannerBackupCount:'0'}))elements[id]=element(value);
 for(const id of ['planResultContent','plannerDetailContent','plannerConstraintSummary','plannerConstraintSaveStatus','savePlannerConstraints',
  'plannerBasicTab','plannerConstraintsTab','plannerBasics','plannerConstraints'])elements[id]=element();
 const c=vm.createContext({document:{readyState:'loading',body:element(),getElementById:id=>elements[id]||null,createElement:()=>element(),addEventListener:(_,fn)=>boot.push(fn)},
  localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v))},performance,console:{log(){},warn(){},error(){}},
  notify:(...v)=>notices.push(v),fetch(){throw Error('Live requests forbidden');}});c.window=c;
 for(const name of ['frequency','equipment-profiles','coordination','storage','render','planning-ui'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules',name+'.js'),'utf8'),c);
 c.DATY_STATE.devices.splice(0,c.DATY_STATE.devices.length,...copy(devices));
 c.restorePlanningProjectFromServer=undefined;c.persistPlanningProject=async(record,result)=>{saves.push(copy({record,result}));};
 return {c,e:elements,values,notices,saves,boot:async()=>{for(const fn of boot)await fn();},
  edit(id,value,event='input'){elements[id].value=String(value);elements[id].dispatch(event);},fill(fields=fixture.fields){for(const [id,value]of Object.entries(fields))this.edit(id,value);}};
}

test('all manual fields have examples/help, editable controls and strict 0–4 backup input',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../unirf-app.html'),'utf8');
 for(const id of ['plannerExcludedRanges','plannerKnownCarriers','plannerBackupCount']){
  const tag=html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))[0];
  assert.doesNotMatch(tag,/readonly|disabled/);assert.match(tag,/placeholder=/);assert.match(tag,/aria-describedby=/);
 }
 assert.match(html,/<select id="plannerLockChannel"[^>]*aria-describedby="plannerLockedHint"/);
 assert.match(html,/<input id="plannerLockNote"[^>]*placeholder="职位 \/ 属性 \/ 使用者/);
 assert.match(html,/<textarea id="plannerLockedAssignments" hidden/);
 const h=harness(),parse=h.c.DatyPlanningConstraints.parseBackupCount;
 for(let i=0;i<=4;i++)assert.equal(parse(String(i)),i);
 for(const value of ['', ' ', '-1','5','1.5','1e0','NaN'])assert.throws(()=>parse(value),/0～4/);
});

test('input validation includes actual line numbers, localized separators and unique receiver targeting',()=>{
 const h=harness(),c=h.c.DatyPlanningConstraints;
 assert.equal(c.parseExcludedRanges('660.000～661.000 电视')[0].startKHz,660000);
 assert.equal(c.parseKnownCarriers('670.000，250，对讲')[0].guardKHz,250);
 assert.equal(c.parseLockedAssignments('CH1＝642.000')[0].frequencyKHz,642000);
 assert.throws(()=>c.parseExcludedRanges('\n\n661.000-660.000'),/第 3 行/);
 assert.throws(()=>c.parseKnownCarriers('\n670.000,250.5'),/第 2 行.*正整数/);
 assert.throws(()=>c.parseLockedAssignments('CH1=641.000\n1=642.000'),/第 2 行.*重复设置/);
 h.c.DATY_STATE.devices.push({...fixture.devices[0],id:4,_fasheId:'other-rx_ch1',receiver_ip:'192.0.2.2'});
 assert.throws(()=>c.parseLockedAssignments('CH1=642.000'),/无法唯一匹配/);
 assert.equal(c.parseLockedAssignments('fixture-rx_ch1=642.000')[0].deviceId,1);
 h.c.DATY_STATE.devices.at(-1).id=1;
 assert.throws(()=>c.parseLockedAssignments('fixture-rx_ch1=642.000'),/设备 ID 不唯一/);
});

test('unsaved manual constraints jointly override old-frequency preferences and are saved with the exact run',async()=>{
 const h=harness();await h.boot();h.fill();const before=copy(h.c.DATY_STATE.devices.map(d=>({id:d.id,freq:d.freq})));
 h.c.runPlanning();const result=h.c.DATY_LAST_COORDINATION;
 assert.ok(result);assert.deepEqual(copy(result.errors),[]);assert.equal(result.assignments.length,3);
 assert.equal(result.assignments.find(a=>a.deviceId===1).frequencyKHz,642000);
 assert.notEqual(result.assignments.find(a=>a.deviceId===2).frequencyKHz,645000);
 assert.equal(result.assignments.find(a=>a.deviceId===3).frequencyKHz,655000);
 assert.equal(result.assignments.find(a=>a.deviceId===1).backupFrequenciesKHz.length,0);
 const frequencies=[];
 for(const assignment of result.assignments){
  frequencies.push(assignment.frequencyKHz,...assignment.backupFrequenciesKHz);
  if(!assignment.locked)assert.equal(assignment.backupFrequenciesKHz.length,2);
 }
 // Independent arithmetic oracle for every primary/backup and the fixed external carrier.
 for(const f of frequencies){assert.ok(f>=640000&&f<=690000);assert.equal(f%fixture.expected.coordinationStepKHz,0);assert.ok(!(f>=644500&&f<=645500)&&!(f>=660000&&f<=661000));assert.ok(Math.abs(f-641000)>=250);}
 for(let i=0;i<frequencies.length;i++)for(let j=i+1;j<frequencies.length;j++)assert.ok(Math.abs(frequencies[i]-frequencies[j])>=fixture.expected.minimumChannelSpacingKHz);
 const sources=[...frequencies,641000];
 for(let i=0;i<sources.length;i++)for(let j=i+1;j<sources.length;j++){
  for(let v=0;v<frequencies.length;v++)if(v!==i&&v!==j)for(const product of [2*sources[i]-sources[j],2*sources[j]-sources[i]])assert.ok(Math.abs(product-frequencies[v])>=250);
  for(let k=j+1;k<sources.length;k++)for(let v=0;v<frequencies.length;v++)if(![i,j,k].includes(v))for(const product of [sources[i]+sources[j]-sources[k],sources[i]+sources[k]-sources[j],sources[j]+sources[k]-sources[i]])assert.ok(Math.abs(product-frequencies[v])>=250);
 }
 assert.deepEqual(copy(h.c.DATY_STATE.devices.map(d=>({id:d.id,freq:d.freq}))),before);
 assert.equal(h.saves.length,1);assert.deepEqual(h.saves[0].record.constraintFields,fixture.fields);
 assert.equal(h.saves[0].record.options.knownCarriers.length,1);assert.equal(h.saves[0].record.options.excludedRanges.length,2);
 assert.match(h.e.plannerConstraintSummary.textContent,/已叠加.*排除 2.*锁定 1.*占用 1.*备用 2/);
 assert.match(h.e.plannerDetailContent.innerHTML,/不能覆盖 Profile/);
});

test('every latest edit invalidates old plans, aggregates validation feedback and focuses the faulty field',async()=>{
 const h=harness();await h.boot();h.c.runPlanning();assert.ok(h.c.DATY_LAST_COORDINATION);
 h.edit('plannerBackupCount','');assert.equal(h.c.DATY_LAST_COORDINATION,null);assert.equal(h.e.plannerBackupCount.getAttribute('aria-invalid'),'true');
 h.edit('plannerExcludedRanges','bad','change');assert.equal(h.e.plannerExcludedRanges.getAttribute('aria-invalid'),'true');
 h.c.runPlanning();assert.equal(h.e.plannerExcludedRanges.focused,true);assert.equal(h.c.DATY_LAST_COORDINATION,null);
 assert.match(h.e.plannerConstraintSummary.textContent,/排除区.*备用频率/);assert.ok(h.c.DATY_STATE.devices.every(d=>d.planned===0));
 h.edit('plannerExcludedRanges','');h.edit('plannerBackupCount','0');h.edit('plannerLockedAssignments','CH1=643.000');h.c.runPlanning();
 assert.equal(h.c.DATY_LAST_COORDINATION.assignments.find(a=>a.deviceId===1).frequencyKHz,643000);
});

test('manual lock cannot override exclusion, fixed occupation, hardware/range/grid, scan or mutual IMD safety',()=>{
 const cases=[
  [{plannerLockedAssignments:'CH1=641.000',plannerExcludedRanges:'640.500-641.500 禁用'},/禁用/],
  [{plannerLockedAssignments:'CH1=641.000',plannerKnownCarriers:'641.000,250,占用'},/占用/],
  [{plannerLockedAssignments:'CH1=639.000'},/范围|频段/],
  [{plannerLockedAssignments:'CH1=641.001'},/栅格/],
  [{plannerLockedAssignments:'CH1=641.000\nCH2=641.125'},/250 kHz.*栅格/],
  [{plannerLockedAssignments:'CH1=641.000\nCH2=641.000'},/锁定冲突/],
  [{plannerLockedAssignments:'CH1=641.000\nCH2=641.250',plannerMinSpacingKHz:'350'},/锁定冲突/],
  [{plannerLockedAssignments:'CH1=641.000\nCH2=642.000\nCH3=643.000'},/互调/],
 ];
 for(const [fields,reason]of cases){const h=harness();h.fill(fields);h.c.runPlanning();const r=h.c.DATY_LAST_COORDINATION;assert.ok(r.errors.length);assert.equal(r.assignments.length,0);assert.match(r.errors.join('；'),reason);}
 const h=harness();h.fill({plannerLockedAssignments:'CH1=641.000'});
 h.c.getCurrentScanPoints=()=>[640500,640700,640900,641100,641300,641500].map(frequencyKHz=>({frequencyKHz,levelDbm:-30}));
 h.c.runPlanning();assert.match(h.c.DATY_LAST_COORDINATION.errors.join('；'),/实测峰值/);assert.equal(h.c.DATY_LAST_COORDINATION.assignments.length,0);
});

test('hand-entered backup 3/4 reaches the solver and an insufficient count is reported honestly',()=>{
 for(const n of [3,4]){const h=harness([fixture.devices[0]]);h.fill({plannerBackupCount:String(n)});h.c.runPlanning();assert.equal(h.c.DATY_LAST_COORDINATION.options.backupCount,n);assert.equal(h.c.DATY_LAST_COORDINATION.assignments[0].backupFrequenciesKHz.length,n);}
 const h=harness([{...fixture.devices[0],freq:640000}]);h.fill({plannerRange:'640000:640350',plannerBackupCount:'4'});h.c.runPlanning();
 const r=h.c.DATY_LAST_COORDINATION;assert.equal(r.assignments[0].backupFrequenciesKHz.length,1);assert.ok(r.warnings.some(w=>/1\/4.*备用/.test(w)));
});

test('saved manual fields including backup 4 restore from current project, not stale defaults',async()=>{
 const h=harness([fixture.devices[0]]);await h.boot();h.fill({plannerLockedAssignments:'CH1=642.000',plannerBackupCount:'4'});
 await h.c.saveCurrentPlanningConstraints();assert.equal(h.saves.length,1);
 const restored=harness([fixture.devices[0]],h.values);await restored.boot();
 assert.equal(restored.e.plannerBackupCount.value,'4');assert.match(restored.e.plannerLockedAssignments.value,/642.000/);
 restored.edit('plannerLockedAssignments','CH1=643.000');restored.c.runPlanning();
 assert.equal(restored.c.DATY_LAST_COORDINATION.assignments[0].frequencyKHz,643000);
});
