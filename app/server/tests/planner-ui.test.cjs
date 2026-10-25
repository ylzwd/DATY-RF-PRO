// Single-window planner behavior; isolated DOM, storage and API, no receiver commands.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));
const devices = count => Array.from({length:count}, (_,i) => ({id:i+1,ch:`CH${i+1}`,channel_number:i+1,group_source:'server-fifo-v1',group_number:1,
  name:`Receiver CH${i+1}`,brand:'DATYaudio',model:'DATY-X1',freq:[641000,642000,644000][i] || 650000+i*500,planned:0})).reverse();

function harness(count=12, ranges=false) {
  const elements=new Map(),boot=[],values=new Map(); let observed;
  function element(value='') {
    const events=new Map(),classes=new Set(),attrs={};
    return {value,style:{},textContent:'',innerHTML:'',options:[],hidden:false,disabled:false,tabIndex:0,open:false,
      classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name),add:name=>classes.add(name),remove:name=>classes.delete(name)},
      setAttribute:(name,v)=>attrs[name]=v,getAttribute:name=>attrs[name],
      addEventListener:(name,fn)=>events.set(name,fn),dispatch:(name,event)=>events.get(name)?.(event),
      appendChild(child){this.options.push(child);},focus(){this.focused=true;},showModal(){this.open=true;},close(){this.open=false;}};
  }
  for(const [id,value] of Object.entries({plannerRange:'640000:690000',plannerCompatibility:'standard',plannerBackupCount:'0',
    plannerExcludedRanges:'',plannerLockedAssignments:'',plannerKnownCarriers:'',freqTableBody:'',plannerTableViewport:'',
    plannerPrevPage:'',plannerNextPage:'',plannerPageInfo:'',plannerBasics:'',plannerConstraints:'',plannerBasicTab:'',plannerConstraintsTab:'',
    planResultContent:'',plannerDetailContent:'',plannerResultDialog:'',plannerConstraintSaveStatus:'',plannerLockStatus:'',content:'',
    'panel-planner':'','panel-settings':'',pageTitle:''}))elements.set(id,element(value));
  if (ranges) for (const [id,value] of Object.entries({plannerRangeStart:'630',plannerRangeEnd:'650',specStart:'400',specEnd:'900',rangeDisplay:'',planRangeDisplay:'',statCenterFreq:''})) elements.set(id,element(value));
  for (const [id,e] of elements) e.id=id;
  elements.get('plannerTableViewport').clientHeight=183; // 32px header + 3 x 50px rows + rounding guard
  let html='';
  Object.defineProperty(elements.get('freqTableBody'),'innerHTML',{get:()=>html,set:value=>{
    html=value;
    for(const id of elements.keys())if(id.startsWith('fi_'))elements.delete(id);
    for(const match of value.matchAll(/class="freq-input" value="([^"]+)" id="([^"]+)"/g))elements.set(match[2],element(match[1]));
  }});
  const c=vm.createContext({console:{log(){},warn(){},error(){}},performance,
    document:{readyState:'loading',body:element(),getElementById:id=>elements.get(id)||null,querySelector:s=>s==='.content'?elements.get('content'):null,
      querySelectorAll:s=>s==='.panel'?['panel-planner','panel-settings'].map(id=>elements.get(id)):[],
      createElement:()=>element(),addEventListener:(_,fn)=>boot.push(fn)},
    localStorage:{getItem:key=>values.get(key)??null,setItem:(key,v)=>values.set(key,String(v))},
    notify(){},fetch(){throw Error('Live fetch forbidden');},
    ResizeObserver:class {constructor(fn){observed=fn;}observe(){}},
  });c.window=c;
  for(const name of ['frequency','equipment-profiles','coordination','storage','render',...(ranges?['spectrum']:[]),'navigation','planning-ui'])
    vm.runInContext(fs.readFileSync(path.join(root,'src/modules',name+'.js'),'utf8'),c,{filename:name+'.js'});
  c.DATY_STATE.devices.splice(0,c.DATY_STATE.devices.length,...devices(count));
  c.persistPlanningProject=async()=>{};c._refreshPlannerChannelSelect=()=>{};
  if (ranges) { c.renderFreqAxis=()=>{};c.updateSpectrumDataSummary=()=>{};c.drawSpectrum=()=>{}; }
  return {c,elements,values,edit(id,value){const field=elements.get(id);field.value=value;field.dispatch('input',{target:field});},devices:()=>c.DATY_STATE.devices,boot:async()=>{for(const fn of boot)await fn();},
    resize:height=>{elements.get('plannerTableViewport').clientHeight=height;observed();},
    rows:()=>[...html.matchAll(/id="fi_([^"]+)"/g)].map(m=>Number(m[1])),
    actions:()=>[...html.matchAll(/onclick="([^"]+)"/g)].map(m=>m[1].replaceAll('&quot;','"'))};
}

test('all pages preserve numeric CH order, full device list and stable action targets',()=>{
  const h=harness(12),before=copy(h.devices()),ids=[],clicked=[];
  h.c.pushFreq=id=>clicked.push(id);h.c.renderFreqTable(false);
  do {
    ids.push(...h.rows());h.actions().forEach(action=>vm.runInContext(action,h.c));
    if(h.elements.get('plannerNextPage').disabled)break;
    h.c.changePlannerTablePage(1);
  }while(ids.length<20);
  assert.deepEqual(ids,Array.from({length:12},(_,i)=>i+1));assert.deepEqual(clicked,ids);
  assert.deepEqual(copy(h.devices()),before);
  assert.match(h.elements.get('plannerPageInfo').textContent,/10–12.*4\/4/);
});

test('same CH on separate receivers remains independent across page boundaries',()=>{
  const h=harness(4);h.devices().forEach(d=>{d.ch='CH1';d.channel_number=1;d.ip=`192.0.2.${d.id}`;d._fasheId=`rx-${d.id}_ch1`;});
  h.elements.get('plannerTableViewport').clientHeight=83;h.c.renderFreqTable(false);
  const targets=[];
  h.c.pushFreq=id=>targets.push(h.c.buildTargetedDeviceCommand(h.devices().find(d=>d.id===id),'set_freq',641));
  for(let i=0;i<4;i++){vm.runInContext(h.actions()[0],h.c);h.c.changePlannerTablePage(1);}
  assert.deepEqual(targets.map(t=>t.device_id),['rx-4_ch1','rx-3_ch1','rx-2_ch1','rx-1_ch1']);
  assert.equal(new Set(targets.map(t=>t.ip)).size,4);
});

test('ResizeObserver recalculates page size and retains the visible channel area',async()=>{
  const h=harness();await h.boot();h.c.renderFreqTable(false);h.c.changePlannerTablePage(1);
  assert.deepEqual(h.rows(),[4,5,6]);h.resize(233);assert.deepEqual(h.rows(),[1,2,3,4]);
  h.resize(133);assert.deepEqual(h.rows(),[1,2]);
  assert.match(h.elements.get('plannerPageInfo').textContent,/1\/6/);
});

test('device removal clamps last page and zero channels disables both controls',()=>{
  const h=harness();h.c.renderFreqTable(false);h.c.changePlannerTablePage(99);
  h.devices().splice(0,10);h.c.renderFreqTable(false);assert.deepEqual(h.rows(),[1,2]);
  assert.equal(h.elements.get('plannerNextPage').disabled,true);
  h.devices().splice(0);h.c.renderFreqTable(false);assert.deepEqual(h.rows(),[]);
  assert.equal(h.elements.get('plannerPageInfo').textContent,'暂无通道');
  assert.equal(h.elements.get('plannerPrevPage').disabled,true);
});

test('frequency input draft survives pagination but expires when source/planned frequency changes',()=>{
  const h=harness();h.c.renderFreqTable(false);h.elements.get('fi_1').value='645.125';
  h.c.changePlannerTablePage(1);h.c.changePlannerTablePage(-1);
  assert.equal(h.elements.get('fi_1').value,'645.125');
  h.devices().find(d=>d.id===1).planned=642500;h.c.renderFreqTable(true);
  assert.equal(h.elements.get('fi_1').value,'642.500');
});

test('tabs and keyboard switch views without replacing unsaved constraint values',async()=>{
  const h=harness();await h.boot();h.elements.get('plannerExcludedRanges').value='660.000-661.000 television';
  h.c.switchPlannerControlTab('constraints');assert.equal(h.elements.get('plannerBasics').hidden,true);
  assert.equal(h.elements.get('plannerConstraintsTab').getAttribute('aria-selected'),'true');
  h.elements.get('plannerConstraintsTab').dispatch('keydown',{key:'Home',preventDefault(){}});
  assert.equal(h.elements.get('plannerConstraints').hidden,true);assert.equal(h.elements.get('plannerBasicTab').tabIndex,0);
  assert.match(h.elements.get('plannerExcludedRanges').value,/television/);
});

test('real plan resets pagination, keeps caveats/details and never exports only the visible page',()=>{
  const h=harness(3);h.elements.get('plannerTableViewport').clientHeight=83;h.c.renderFreqTable(false);h.c.changePlannerTablePage(2);
  h.c.runPlanning();assert.ok(h.c.DATY_LAST_COORDINATION);assert.deepEqual(h.rows(),[1]);
  assert.match(h.elements.get('planResultContent').innerHTML,/建议调整 3 个/);
  assert.equal(h.c.DATY_LAST_COORDINATION.allocationOrder.enabled,true);
  assert.deepEqual(copy(h.c.DATY_LAST_COORDINATION.assignments.slice().sort((a,b)=>a.deviceId-b.deviceId).map(a=>a.frequencyKHz)),[640000,665000,689750]);
  assert.match(h.elements.get('plannerDetailContent').innerHTML,/不等同 WWB6/);
  const csv=h.c.buildPlanCsv();for(const ch of ['CH1','CH2','CH3'])assert.ok(csv.includes(ch));
  h.c.openPlannerResultDetails();assert.equal(h.elements.get('plannerResultDialog').open,true);
  h.c.invalidateCoordination('规划约束已修改');
  assert.equal(h.c.DATY_LAST_COORDINATION,null);
  assert.match(h.elements.get('plannerDetailContent').innerHTML,/规划约束已修改/);
  assert.doesNotMatch(h.elements.get('plannerDetailContent').innerHTML,/保留原频 3 个/);
});

test('switching panels applies planner-only fixed layout without breaking settings',()=>{
  const h=harness();h.c.switchPanel('planner');assert.equal(h.elements.get('content').classList.contains('planner-view'),true);
  h.c.switchPanel('settings');assert.equal(h.elements.get('content').classList.contains('planner-view'),false);
  assert.equal(h.elements.get('content').classList.contains('settings-view'),true);
});

test('actual GROUP order and source snapshot reach history and report without changing live frequencies',()=>{
 const h=harness(3),original=copy(h.devices());
 for(const d of h.devices())d.group_number={1:10,2:1,3:2}[d.id];
 h.c.runPlanning();const result=h.c.DATY_LAST_COORDINATION;
 assert.equal(result.search.complete,true);
 assert.deepEqual(copy(result.allocationOrder.deviceIds),[2,3,1]);
 assert.deepEqual([2,3,1].map(id=>h.devices().find(d=>d.id===id).planned),[640000,665000,689750]);
 assert.deepEqual(copy(h.devices().map(d=>d.freq)),original.map(d=>d.freq));
 const text=h.c.DatyCoordinationReport.buildText(result,h.devices(),new Date('2026-09-15T00:00:00Z'));
 assert.ok(text.indexOf('GROUP1 ·')<text.indexOf('GROUP2 ·'));assert.ok(text.indexOf('GROUP2 ·')<text.indexOf('GROUP10 ·'));
 assert.match(text,/按 GROUP 数字升序/);
 const history=JSON.parse(h.values.get('daty_planning_history_v1'));
 const saved=history.records[0];assert.deepEqual(saved.coordination.allocationOrder.deviceIds,[2,3,1]);
 assert.deepEqual(saved.coordination.assignments.map(a=>[a.deviceId,a.groupNumber,a.frequencyKHz]),copy(result.assignments).map(a=>[a.deviceId,a.groupNumber,a.frequencyKHz]));
});

test('compact page plans only actual channels across the selected range, with no automatic reserve pool',()=>{
 const h=harness(2);h.elements.get('plannerCompatibility').value='more-frequencies';h.c.runPlanning();
 const result=h.c.DATY_LAST_COORDINATION;assert.equal(result.options.minimumFrequencyCount,0);assert.equal(result.frequencyPool,undefined);assert.equal(result.assignments.length,2);
 assert.deepEqual(copy(result.assignments).sort((a,b)=>a.allocationRank-b.allocationRank).map(a=>a.frequencyKHz),[640000,690000]);
 assert.equal(h.devices().length,2);assert.match(h.elements.get('planResultContent').innerHTML,/按实际通道分布于设定范围/);
 const report=h.c.DatyCoordinationReport.buildText(result,h.devices());assert.match(report,/按 2 个实际通道分散于设定范围/);assert.doesNotMatch(report,/预留频点 \(kHz\):/);
 const saved=JSON.parse(h.values.get('daty_planning_history_v1')).records[0];assert.deepEqual(saved.coordination.distribution,copy(result.distribution));
 h.elements.get('plannerCompatibility').value='standard';assert.equal(h.c.DatyPlanningConstraints.getOptions().minimumFrequencyCount,0);
});
test('replanning uses the current online count and does not allocate an offline receiver channel',()=>{
 const h=harness(3);h.elements.get('plannerCompatibility').value='more-frequencies';h.c.runPlanning();assert.equal(h.c.DATY_LAST_COORDINATION.assignments.length,3);
 const offline=h.devices()[0];offline._fasheId='offline_ch1';offline._online=false;offline.status='offline';h.c.runPlanning();
 const result=h.c.DATY_LAST_COORDINATION;assert.equal(result.distribution.targetCount,2);assert.equal(result.assignments.length,2);assert.ok(result.assignments.every(a=>a.deviceId!==offline.id));assert.equal(result.frequencyPool,undefined);
});

for(const [level,guard,threshold] of [['standard',250,-78],['robust',150,-75],['more-frequencies',0,-72]])
test(`${level}: one-click uses selected range, current online targets and mode protections together`,()=>{
 const h=harness(4,true);
 h.devices().forEach(d=>Object.assign(d,{_fasheId:'scope-rx_ch'+d.id,_online:true,status:'online',group_number:d.id<=2?2:10}));
 h.elements.get('plannerRange').value='custom';h.elements.get('plannerRangeStart').value='640';h.elements.get('plannerRangeEnd').value='690';
 h.elements.get('plannerCompatibility').value=level;h.c.runPlanning();
 const check=(start,end,count)=>{
   const result=h.c.DATY_LAST_COORDINATION;assert.ok(result);assert.equal(result.search.complete,true,JSON.stringify(result.errors));
   assert.equal(result.options.compatibilityLevel,level);assert.equal(result.options.rangeStartKHz,start);assert.equal(result.options.rangeEndKHz,end);
   assert.equal(result.distribution.targetCount,count);assert.equal(result.assignments.length,count);assert.equal(result.frequencyPool,undefined);
   assert.equal(result.distribution.enabled,true);assert.equal(result.distribution.preferredFrequencies[0].frequencyKHz,start);
   assert.equal(result.distribution.preferredFrequencies.at(-1).frequencyKHz,end);
   const rows=copy(result.assignments).sort((a,b)=>a.allocationRank-b.allocationRank);
   for(let i=0;i<rows.length;i++){
     assert.ok(rows[i].frequencyKHz>=start&&rows[i].frequencyKHz<=end);
     if(i)assert.ok(rows[i].frequencyKHz>rows[i-1].frequencyKHz);
   }
   assert.equal(result.compatibility.devices.length,count);
   for(const row of result.compatibility.devices)assert.deepEqual([row.channelSpacingKHz,row.intermodSpacingKHz,row.scanThresholdDbm],[250,guard,threshold]);
   const saved=JSON.parse(h.values.get('daty_planning_history_v1')).records[0];
   assert.deepEqual([saved.options.compatibilityLevel,saved.options.rangeStartKHz,saved.options.rangeEndKHz,saved.options.minimumFrequencyCount,saved.options.frequencyDistribution],
     [level,start,end,0,'spread-range']);
   assert.deepEqual(saved.coordination.options,copy(result.options));assert.deepEqual(saved.coordination.distribution,copy(result.distribution));
   return result;
 };
 check(640000,690000,4);
 const offline=h.devices()[0];offline._online=false;offline.status='offline';
 h.elements.get('plannerRangeStart').value='650';h.elements.get('plannerRangeEnd').value='680';h.c.runPlanning();
 const result=check(650000,680000,3);assert.ok(result.assignments.every(row=>row.deviceId!==offline.id));assert.equal(offline.planned,0);
});
test('production markup retains one copy of all planning fields, dialogs and paging hooks',()=>{
  const html=fs.readFileSync(path.join(root,'unirf-app.html'),'utf8');
  for(const id of ['plannerRange','plannerAlgorithm','targetChannelSelect','plannerCompatibility','plannerExcludedRanges',
    'plannerLockedAssignments','plannerKnownCarriers','plannerBackupCount','savePlannerConstraints',
    'plannerResultDialog','freqTableBody','plannerPrevPage','plannerNextPage'])
    assert.equal(html.split(`id="${id}"`).length-1,1,id);
  assert.match(html,/640000:690000/);assert.match(html,/role="tablist"/);
  assert.match(html,/<th>当前频率<\/th><th[^>]*>锁定频率<\/th><th>规划频率<\/th>/);
  assert.match(html,/<th>编组<\/th><th>通道<\/th>/);
  assert.match(html,/class="pc-locked"/);assert.match(html,/planning-ui\.js\?v=r19-data-management1/);
});

function lockedCells(h) {
  return [...h.elements.get('freqTableBody').innerHTML.matchAll(/<td class="planner-locked-cell"[^>]*><span[^>]*>([^<]+)<\/span>/g)].map(m=>m[1]);
}

test('locked column reads live unsaved constraints in MHz, updates and clears without planning or changing telemetry',async()=>{
  const h=harness(3);await h.boot();const before=copy(h.devices());
  h.c.renderFreqTable(false);assert.deepEqual(lockedCells(h),['—','—','—']);
  const field=h.elements.get('plannerLockedAssignments');field.value='CH2=642.125 主持人';field.dispatch('input');
  assert.deepEqual(lockedCells(h),['—','642.125 MHz','—']);
  field.value='CH2=643.25';field.dispatch('input');assert.deepEqual(lockedCells(h),['—','643.250 MHz','—']);
  field.value='';field.dispatch('input');assert.deepEqual(lockedCells(h),['—','—','—']);
  assert.deepEqual(copy(h.devices()),before);
});

test('valid lock rows remain visible next to incomplete rows, invalid units never become lock values',async()=>{
  const h=harness(3);await h.boot();const field=h.elements.get('plannerLockedAssignments');
  field.value='CH1=641.125\nCH2=\nCH3=644.0005';field.dispatch('input');
  assert.deepEqual(lockedCells(h),['641.125 MHz','—','—']);
  assert.equal(h.elements.get('plannerLockStatus').hidden,false);
  assert.equal(field.getAttribute('aria-invalid'),'true');
  field.value='CH1=641.125';field.dispatch('input');
  assert.equal(h.elements.get('plannerLockStatus').hidden,true);assert.equal(field.getAttribute('aria-invalid'),'false');
});

test('repeated lock aliases for one device report duplicate instead of choosing one frequency',()=>{
  const h=harness(3);h.elements.get('plannerLockedAssignments').value='CH1=641.125\n1=643.125';h.c.renderFreqTable(false);
  assert.deepEqual(lockedCells(h),['重复设置','—','—']);
  assert.match(h.elements.get('plannerLockStatus').title,/重复设置/);
});

test('same CH on multiple receivers cannot borrow a lock; stable IDs only affect their own receiver',()=>{
  const h=harness(2);h.devices().forEach(d=>{d.ch='CH1';d.channel_number=1;d.ip=`192.0.2.${d.id}`;d._fasheId=`rx-${d.id}_ch1`;});
  const field=h.elements.get('plannerLockedAssignments');field.value='CH1=641.125';h.c.renderFreqTable(false);
  assert.deepEqual(lockedCells(h),['—','—']);assert.equal(h.elements.get('plannerLockStatus').hidden,false);
  field.value='rx-1_ch1=641.125';h.c.renderFreqTable(false);
  assert.deepEqual(lockedCells(h),['—','641.125 MHz']);assert.equal(h.elements.get('plannerLockStatus').hidden,true);
});

test('duplicate local IDs never copy a uniquely targeted receiver lock to another row',()=>{
  const h=harness(2);h.devices().forEach((d,i)=>{d.id=1;d._fasheId=`rx-${i}_ch1`;});
  h.elements.get('plannerLockedAssignments').value='rx-0_ch1=641.125';h.c.renderFreqTable(false);
  assert.deepEqual(lockedCells(h),['—','—']);assert.match(h.elements.get('plannerLockStatus').title,/ID 不唯一/);
});

test('locks survive pagination and show immediately when constraints are restored from history',()=>{
  const h=harness(12);
  h.c.DatyPlanningConstraints.restoreSnapshot({constraintFields:{plannerLockedAssignments:'CH10=672.125'}});
  assert.deepEqual(lockedCells(h),['—','—','—']);h.c.changePlannerTablePage(3);
  assert.deepEqual(h.rows(),[10,11,12]);assert.deepEqual(lockedCells(h),['672.125 MHz','—','—']);
  h.c.DatyPlanningConstraints.restoreSnapshot({constraintFields:{plannerLockedAssignments:'CH12=675.000'}});
  assert.deepEqual(lockedCells(h),['—','—','675.000 MHz']);
});

test('historical receiver identity follows a new local ID and never matches an offline target by reused ID',()=>{
  const h=harness(2);h.devices().forEach(d=>{d.ch='CH1';d.channel_number=1;d.ip=`192.0.2.${d.id}`;d._fasheId=`rx-${d.id}_ch1`;});
  const saved=copy(h.devices().find(d=>d.id===1));h.devices().find(d=>d.id===1).id=99;
  const record={devices:[saved],constraints:{lockedAssignments:[{deviceId:1,frequencyKHz:641125}]}};
  h.c.DatyPlanningConstraints.restoreSnapshot(record);assert.deepEqual(lockedCells(h),['—','641.125 MHz']);
  h.devices().splice(1,1);h.devices()[0].id=1;
  h.c.DatyPlanningConstraints.restoreSnapshot(record);assert.deepEqual(lockedCells(h),['—']);
  assert.equal(h.elements.get('plannerLockStatus').hidden,false);
});


function linkedValues(h) {
  return ['plannerRangeStart','plannerRangeEnd','specStart','specEnd'].map(id=>h.elements.get(id).value);
}

test('effective planning presets drive a spectrum view with exactly 10 MHz padding on each side',async()=>{
  const h=harness(3,true);await h.boot();
  assert.deepEqual(linkedValues(h),['640.000','690.000','630.000','700.000']);
  h.edit('plannerRange','614250:638000');
  assert.deepEqual(linkedValues(h),['614.250','638.000','604.250','648.000']);
  const options=h.c.DatyPlanningConstraints.getOptions();
  assert.deepEqual([options.rangeStartKHz,options.rangeEndKHz],[614250,638000]);
  assert.equal(h.elements.get('planRangeDisplay').textContent,'规划范围 614.250–638.000 MHz');
});

test('display margins preserve fractional MHz and never expand the actual solver range or device frequencies',async()=>{
  const h=harness(3,true);await h.boot();const original=h.devices().map(d=>d.freq);
  h.c.runPlanning();assert.ok(h.c.DATY_LAST_COORDINATION);
  h.edit('plannerRangeStart','640.125');h.edit('plannerRangeEnd','680.375');
  assert.equal(h.elements.get('plannerRange').value,'custom');
  assert.deepEqual(linkedValues(h),['640.125','680.375','630.125','690.375']);
  assert.equal(h.c.DATY_LAST_COORDINATION,null);
  assert.deepEqual(Array.from(h.c.getSpectrumRangeMHz()),[630.125,690.375]);
  h.c.runPlanning();assert.ok(h.c.DATY_LAST_COORDINATION);
  assert.deepEqual([h.c.DATY_LAST_COORDINATION.options.rangeStartKHz,h.c.DATY_LAST_COORDINATION.options.rangeEndKHz],[640125,680375]);
  assert.ok(h.c.DATY_LAST_COORDINATION.assignments.every(a=>a.frequencyKHz>=640125&&a.frequencyKHz<=680375));
  assert.deepEqual(h.devices().map(d=>d.freq),original);
});

test('invalid planning drafts keep the last padded view and cannot plan or overwrite saved display preferences',async()=>{
  const h=harness(3,true);await h.boot();h.edit('plannerRangeStart','640.125');
  for (const value of ['', '695', 'bad']) {
    const saved=[h.values.get('specStartFreq'),h.values.get('specEndFreq')];h.edit('plannerRangeStart',value);
    assert.deepEqual(Array.from(h.c.getSpectrumRangeMHz()),[630.125,700]);
    assert.deepEqual([h.values.get('specStartFreq'),h.values.get('specEndFreq')],saved);
    assert.equal(h.elements.get('plannerRangeStart').getAttribute('aria-invalid'),'true');
    h.c.runPlanning();assert.equal(h.c.DATY_LAST_COORDINATION,null);
  }
  h.edit('plannerRangeStart','641.250');assert.equal(h.elements.get('plannerRangeStart').getAttribute('aria-invalid'),'false');
  assert.deepEqual(Array.from(h.c.getSpectrumRangeMHz()),[631.25,700]);
});

test('history restore derives margins from the actual saved range rather than stale custom display values',async()=>{
  const h=harness(3,true);await h.boot();
  h.c.DatyPlanningConstraints.restoreSnapshot({constraintFields:{plannerRange:'614250:638000',plannerRangeStart:'640.000',plannerRangeEnd:'690.000'}});
  assert.deepEqual(linkedValues(h),['614.250','638.000','604.250','648.000']);
  h.c.DatyPlanningConstraints.restoreSnapshot({constraintFields:{plannerRange:'custom',plannerRangeStart:'631.125',plannerRangeEnd:'654.375'}});
  assert.deepEqual(linkedValues(h),['631.125','654.375','621.125','664.375']);
});

test('scan import pads only the view without creating scan points or expanding scan-mode planner bounds',async()=>{
  const h=harness(3,true);await h.boot();
  const points=[{frequencyKHz:635125,levelDbm:-90},{frequencyKHz:655375,levelDbm:-88}];
  h.c.setImportedScanPoints(points,'fixture.csv');
  assert.equal(h.elements.get('plannerRange').value,'scan');
  assert.deepEqual(linkedValues(h),['635.125','655.375','625.125','665.375']);
  assert.deepEqual(copy(h.c.getCurrentScanPoints()),points);
  const options=h.c.DatyPlanningConstraints.getOptions();
  assert.deepEqual([options.rangeStartKHz,options.rangeEndKHz],[635125,655375]);
  h.c.clearImportedScan();assert.deepEqual(linkedValues(h),['','','','']);
  assert.throws(()=>h.c.DatyPlanningConstraints.getOptions(),/CSV/);
  assert.deepEqual(Array.from(h.c.getSpectrumRangeMHz()),[625.125,665.375]);
});

test('late project restore cannot overwrite planner edits made while startup is awaiting the server',async()=>{
  const h=harness(3,true);
  h.c.restorePlanningProjectFromServer=async canRestore=>{
    assert.equal(canRestore(),true);h.edit('plannerRangeStart','631.125');h.edit('plannerRangeEnd','656.375');
    assert.equal(canRestore(),false);
  };
  await h.boot();assert.deepEqual(linkedValues(h),['631.125','656.375','621.125','666.375']);
});

test('unavailable preference storage does not break padding or retain a stale deployable plan',async()=>{
  const h=harness(3,true);await h.boot();h.c.runPlanning();assert.ok(h.c.DATY_LAST_COORDINATION);
  h.c.localStorage.setItem=()=>{throw Error('Storage unavailable');};
  assert.doesNotThrow(()=>h.edit('plannerRangeStart','641.125'));
  assert.deepEqual(linkedValues(h),['641.125','690.000','631.125','700.000']);
  assert.equal(h.c.DATY_LAST_COORDINATION,null);
  assert.deepEqual(Array.from(h.c.getSpectrumRangeMHz()),[631.125,700]);
});

test('display margins may extend beyond RF tuning limits while the planner keeps its valid integer kHz limits',async()=>{
  const h=harness(3,true);await h.boot();h.edit('plannerRangeStart','30.000');h.edit('plannerRangeEnd','3000.000');
  assert.deepEqual(Array.from(h.c.getSpectrumRangeMHz()),[20,3010]);
  const options=h.c.DatyPlanningConstraints.getOptions();assert.deepEqual([options.rangeStartKHz,options.rangeEndKHz],[30000,3000000]);
  const range={rangeStartKHz:640125,rangeEndKHz:690375},before=copy(range);
  assert.deepEqual(Array.from(h.c.getPlanningSpectrumRangeMHz(range)),[630.125,700.375]);assert.deepEqual(range,before);
  assert.equal(h.c.getPlanningSpectrumRangeMHz({rangeStartKHz:690000,rangeEndKHz:640000}),null);
});

test('fit is a temporary chart zoom and restore follows the latest padded planner range without changing the plan',async()=>{
  const h=harness(3,true);await h.boot();
  h.devices().forEach(d=>Object.assign(d,{_fasheId:`fixture_ch${d.channel_number}`,_online:true}));
  h.c.runPlanning();const plan=h.c.DATY_LAST_COORDINATION;assert.ok(plan);
  h.c.fitSpectrumToDevices();assert.deepEqual(Array.from(h.c.getSpectrumRangeMHz()),[640.25,644.75]);
  assert.equal(h.c.DATY_LAST_COORDINATION,plan);assert.equal(h.elements.get('plannerRange').value,'640000:690000');
  h.c.restoreSpectrumRange();assert.deepEqual(Array.from(h.c.getSpectrumRangeMHz()),[630,700]);assert.equal(h.c.DATY_LAST_COORDINATION,plan);
  h.c.fitSpectrumToDevices();h.edit('plannerRangeEnd','680.000');h.c.restoreSpectrumRange();
  assert.deepEqual(Array.from(h.c.getSpectrumRangeMHz()),[630,690]);
});

test('old manual display preferences cannot override the planning-derived range on startup or restore',async()=>{
  const h=harness(3,true);await h.boot();h.values.set('specStartFreq','470');h.values.set('specEndFreq','608');
  h.c.loadSavedFreqRange();assert.deepEqual(linkedValues(h),['640.000','690.000','630.000','700.000']);
  h.c.restoreSpectrumRange();assert.deepEqual(Array.from(h.c.getSpectrumRangeMHz()),[630,700]);
  assert.equal(h.values.get('specStartFreq'),'470');assert.equal(h.values.get('specEndFreq'),'608');
});
