// Browser-module integration in isolated memory. No live writes or device commands.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const copy=value=>JSON.parse(JSON.stringify(value));
function harness() {
  const elements=new Map(),created=[],values=new Map(),notices=[],boot=[];
  function element(value='') {
    const events=new Map();
    return {value,style:{},textContent:'',innerHTML:'',options:[],
      addEventListener:(event,fn)=>events.set(event,fn),dispatch:event=>events.get(event)?.(),
      remove(){},click(){},appendChild(){}};
  }
  for(const [id,value] of Object.entries({plannerRange:'600000:610000',plannerCompatibility:'standard',
    plannerExcludedRanges:'',plannerLockedAssignments:'',plannerKnownCarriers:'',plannerBackupCount:'0',
    specStart:'600',specEnd:'610',planResultContent:''})) elements.set(id,element(value));
  const context=vm.createContext({console:{log(){},warn(){},error(){}},performance,
    document:{readyState:'loading',body:element(),getElementById:id=>elements.get(id)||null,
      createElement:()=>{const e=element();created.push(e);return e;},addEventListener:(_,fn)=>boot.push(fn)},
    localStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)},
    AbortController,
    FileReader:class {readAsText(file){this.result=file.text;this.onload();}},
    notify:(...args)=>notices.push(args),clearInterval(){},
    renderFreqTable(){},saveDataToStorage(){},setPlanningSaveStatus(){},
    savePlanningResult:()=>({}),persistPlanningProject:async()=>{},
    DATY_STATE:{devices:[{id:1,brand:'DATYaudio',model:'RF PRO',ch:'CH1',freq:600000,planned:0}]}});
  context.window=context;context.DatyDialogs={confirm:async()=>true};
  vm.runInContext(fs.readFileSync(path.join(root,'src/platform/browser-platform.js'),'utf8'),context);
  for(const name of ['frequency','equipment-profiles','coordination','scan-csv','spectrum','planning-ui'])
    vm.runInContext(fs.readFileSync(path.join(root,'src/modules',name+'.js'),'utf8'),context,{filename:name+'.js'});
  // Canvas layout is not under test here; real scan import/state and planner logic are.
  context.updateRangeDisplay=()=>{};context.drawSpectrum=()=>{};
  return {c:context,elements,values,notices,boot:async()=>{for(const fn of boot)await fn();},
    choose(text,name='scan.csv'){const input=created.at(-1);input.files=[{name,text,size:Buffer.byteLength(text)}];input.dispatch('change');}};
}
const fixture=name=>fs.readFileSync(path.join(__dirname,'fixtures',name),'utf8');

test('bad CSV import preserves the prior scan and plan; good import invalidates the plan',async()=>{
  const h=harness();await h.boot();
  let read=h.c.importScan('CSV');h.choose(fixture('scan-reference-mhz.csv'));await read;
  h.c.runPlanning();const previous=h.c.DATY_LAST_COORDINATION;
  assert.equal(previous.assignments.length,1);
  const scan=copy(h.c.getCurrentScanPoints());
  read=h.c.importScan('CSV');h.choose(fixture('scan-invalid-empty.csv'));await read;
  assert.equal(h.c.DATY_LAST_COORDINATION,previous);
  assert.deepEqual(copy(h.c.getCurrentScanPoints()),scan);
  assert.ok(h.notices.some(x=>x[1]==='扫描导入失败'));
  read=h.c.importScan('CSV');h.choose(fixture('scan-reference-khz.csv'));await read;
  assert.equal(h.c.DATY_LAST_COORDINATION,null);assert.equal(h.c.DATY_STATE.devices[0].planned,0);
});

test('changed constraints, cleared scan and failed planning invalidate stale assignments',async()=>{
  const h=harness();await h.boot();h.c.runPlanning();
  assert.ok(h.c.DATY_LAST_COORDINATION);
  h.elements.get('plannerBackupCount').dispatch('input');
  assert.equal(h.c.DATY_LAST_COORDINATION,null);assert.equal(h.c.DATY_STATE.devices[0].planned,0);
  h.c.runPlanning();h.c.clearImportedScan();
  assert.equal(h.c.DATY_LAST_COORDINATION,null);
  h.c.runPlanning();h.elements.get('plannerRange').value='bad';h.c.runPlanning();
  assert.equal(h.c.DATY_LAST_COORDINATION,null);assert.equal(h.c.DATY_STATE.devices[0].planned,0);
  assert.match(h.elements.get('planResultContent').textContent,/规划失败/);
});

test('Profile UI import validates atomically and only success invalidates old results',async()=>{
  const h=harness();await h.boot();h.c.runPlanning();
  const previous=h.c.DATY_LAST_COORDINATION;
  const profile=copy(h.c.DatyEquipmentProfiles.resolveEquipmentProfile({brand:'DATYaudio'}));profile.id='lab-profile';
  let read=h.c.importEquipmentProfile();h.choose(JSON.stringify([profile,{id:'broken'}]),'bad.json');await read;
  assert.equal(h.c.DATY_LAST_COORDINATION,previous);
  assert.equal(h.values.has(h.c.DatyEquipmentProfiles.STORAGE_KEY),false);
  read=h.c.importEquipmentProfile();h.choose(JSON.stringify(profile),'good.json');await read;
  assert.equal(h.c.DATY_LAST_COORDINATION,null);assert.equal(h.c.DATY_STATE.devices[0].planned,0);
});

test('UI rejects fractional guard kHz instead of rounding it into a different constraint',async()=>{
  const h=harness();await h.boot();
  assert.throws(()=>h.c.DatyPlanningConstraints.parseKnownCarriers('600.000,250.5,occupied'),/正整数/);
  assert.throws(()=>h.c.DatyPlanningConstraints.parseKnownCarriers('600.0005,250,occupied'),/精度/);
});
