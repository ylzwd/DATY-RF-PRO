// Isolated lock-editor events: no live APIs, device controls or production storage.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const copy=v=>JSON.parse(JSON.stringify(v));
const assetRoot=process.env.DATY_TEST_ASSET_ROOT || path.join(__dirname,'..');
const devices=()=>[
 {id:1,_fasheId:'rx-a_ch1',receiver_ip:'192.0.2.1',receiver_mac:'00:11:22:33:44:01',channel_number:1,ch:'CH1',freq:641000,_online:true,status:'online',brand:'DATYaudio',model:'DATY-X1'},
 {id:2,_fasheId:'rx-b_ch1',receiver_ip:'192.0.2.2',receiver_mac:'00:11:22:33:44:02',channel_number:1,ch:'CH1',freq:645000,_online:true,status:'online',brand:'DATYaudio',model:'DATY-X1'}
];
async function harness(list=devices()){
 const e={},boot=[],notices=[],saved=[],storage=new Map();
 function element(value=''){
  const events={},attrs={};return {value,innerHTML:'',textContent:'',title:'',options:[],disabled:false,style:{},
   setAttribute:(k,v)=>attrs[k]=v,getAttribute:k=>attrs[k],addEventListener:(k,fn)=>events[k]=fn,dispatch:k=>events[k]?.(),
   classList:{toggle(){}},appendChild(o){this.options.push(o);},focus(){document.activeElement=this;}};
 }
 for(const [id,value]of Object.entries({plannerRange:'640000:690000',plannerCompatibility:'standard',plannerBackupCount:'0',
  plannerExcludedRanges:'',plannerKnownCarriers:'',plannerLockedAssignments:'',plannerLockChannel:'',plannerLockNote:'',plannerConfirmLock:'',plannerRemoveLock:'',plannerLockCount:'',
  plannerConstraintSummary:'',plannerConstraintSaveStatus:'',savePlannerConstraints:'',freqTableBody:'',planResultContent:'',plannerDetailContent:''}))e[id]=element(value);
 const document={readyState:'loading',activeElement:null,body:element(),getElementById:id=>e[id]||null,createElement:()=>element(),addEventListener:(event,fn)=>{if(event==='DOMContentLoaded')boot.push(fn);}};
 const c=vm.createContext({document,performance,addEventListener(){},setInterval(){return 1;},clearInterval(){},console:{log(){},warn(){},error(){}},
  localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v))},fetch(){throw Error('Live API forbidden');},notify:(...v)=>notices.push(v)});c.window=c;
 for(const name of ['frequency','equipment-profiles','coordination','storage','dashboard','render','planning-ui'])vm.runInContext(fs.readFileSync(path.join(assetRoot,'src/modules',name+'.js'),'utf8'),c);
 c.DATY_STATE.devices.splice(0,c.DATY_STATE.devices.length,...copy(list));
 c.restorePlanningProjectFromServer=undefined;c.persistPlanningProject=async(record,result)=>saved.push(copy({record,result}));
 for(const fn of boot)await fn();
 const select=value=>{document.activeElement=e.plannerLockChannel;e.plannerLockChannel.value=value;e.plannerLockChannel.dispatch('change');};
 return {c,e,notices,saved,document,select,devices:c.DATY_STATE.devices,
  confirm(){document.activeElement=e.plannerConfirmLock;e.plannerConfirmLock.dispatch('click');},
  note(value){document.activeElement=e.plannerLockNote;e.plannerLockNote.value=value;e.plannerLockNote.dispatch('input');},
  remove(){document.activeElement=e.plannerRemoveLock;e.plannerRemoveLock.dispatch('click');},
  locks(){return copy(c.DatyPlanningConstraints.readConstraintFields().lockedAssignments);},
  refresh(){c.renderFreqTable(false);}};
}

test('preselect and role entry remain a draft until explicit confirmation; cancel discards only that draft',async()=>{
 const h=await harness();h.c.runPlanning();const plan=h.c.DATY_LAST_COORDINATION;
 h.select('device:rx-a_ch1');assert.deepEqual(h.locks(),[]);assert.equal(h.e.plannerLockNote.disabled,false);
 h.note('鼓手');h.refresh();assert.deepEqual(h.locks(),[]);assert.equal(h.e.plannerLockNote.value,'鼓手');
 assert.equal(h.c.DATY_LAST_COORDINATION,plan);h.remove();assert.deepEqual(h.locks(),[]);
 assert.equal(h.e.plannerLockChannel.value,'');assert.equal(h.e.plannerLockNote.value,'');
 h.select('device:rx-a_ch1');h.note('主唱');h.confirm();h.confirm();
 assert.deepEqual(h.locks(),[{deviceId:1,frequencyKHz:641000,reason:'主唱'}]);assert.equal(h.c.DATY_LAST_COORDINATION,null);
 h.select('device:rx-b_ch1');h.note('未确认');h.remove();
 assert.deepEqual(h.locks(),[{deviceId:1,frequencyKHz:641000,reason:'主唱'}]);
 h.select('lock:0');h.remove();h.remove();assert.deepEqual(h.locks(),[]);
});

test('pending confirmation keeps displayed frequency and receiver identity across telemetry refreshes',async()=>{
 const h=await harness();h.select('device:rx-a_ch1');h.note('鼓手');h.devices[0].freq=649000;h.refresh();
 assert.deepEqual(h.locks(),[]);assert.match(h.e.plannerLockChannel.title,/641.000/);
 h.confirm();assert.equal(h.locks()[0].frequencyKHz,641000);
 for(const kind of ['offline','replacement']){
  const s=await harness();s.select('device:rx-a_ch1');s.note('不能误锁');
  if(kind==='offline')s.devices[0]._online=false;else s.devices[0].receiver_mac='AA:BB:CC:DD:EE:FF';
  s.refresh();s.confirm();assert.deepEqual(s.locks(),[]);
 }
});

test('confirmed role edits need confirmation, switching discards them, and repeated cancel never removes a neighbour',async()=>{
 const h=await harness();h.select('device:rx-a_ch1');h.note('鼓手');h.confirm();
 h.select('device:rx-b_ch1');h.note('主唱');h.confirm();h.c.runPlanning();const plan=h.c.DATY_LAST_COORDINATION;
 h.select('lock:0');h.note('未确认修改');h.refresh();assert.equal(h.locks()[0].reason,'鼓手');assert.equal(h.e.plannerLockNote.value,'未确认修改');
 assert.equal(h.c.DATY_LAST_COORDINATION,plan);h.select('lock:1');h.select('lock:0');assert.equal(h.e.plannerLockNote.value,'鼓手');
 h.note('鼓手 / 返听');h.confirm();assert.equal(h.locks()[0].reason,'鼓手 / 返听');
 h.remove();h.remove();h.refresh();assert.deepEqual(h.locks(),[{deviceId:2,frequencyKHz:645000,reason:'主唱'}]);
 assert.equal(h.e.plannerLockChannel.value,'');assert.equal(h.e.plannerConfirmLock.disabled,true);
});

test('pending edits cannot overwrite or remove a different constraint after row indices change',async()=>{
 for(const action of ['confirm','remove']){
  const h=await harness();h.select('device:rx-a_ch1');h.note('鼓手');h.confirm();
  h.select('device:rx-b_ch1');h.note('主唱');h.confirm();h.select('lock:0');h.note('旧行草稿');
  h.e.plannerLockedAssignments.value='rx-b_ch1=645.000 主唱';h.refresh();h[action]();
  assert.deepEqual(h.locks(),[{deviceId:2,frequencyKHz:645000,reason:'主唱'}]);
 }
});

test('history restore discards unconfirmed edits instead of confirming them into the restored project',async()=>{
 const h=await harness();h.select('device:rx-a_ch1');h.note('不能恢复为锁定');
 h.c.DatyPlanningConstraints.restoreSnapshot({constraintFields:{plannerLockedAssignments:'rx-b_ch1=645.000 历史主唱'}});
 h.confirm();assert.deepEqual(h.locks(),[{deviceId:2,frequencyKHz:645000,reason:'历史主唱'}]);
});

test('confirmed, pending, offline and unknown groups remain numeric GROUP then CH ordered',async()=>{
 const list=[{...devices()[0],group_source:'server-fifo-v1',group_number:10},
 {...devices()[1],group_source:'server-fifo-v1',group_number:2},
 {...devices()[1],id:3,_fasheId:'rx-b_ch10',ch:'CH10',channel_number:10,group_source:'server-fifo-v1',group_number:2},
 {...devices()[0],id:4,_fasheId:'rx-c_ch1',group_source:'client',group_number:1}];
 const h=await harness(list);h.select('device:rx-a_ch1');h.confirm();h.devices[0]._online=false;
 h.select('device:rx-b_ch10');h.note('待确认');h.refresh();
 const values=[...h.e.plannerLockChannel.innerHTML.matchAll(/<option value="([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(values,['device:rx-b_ch1','device:rx-b_ch10','lock:0','device:rx-c_ch1']);
 assert.equal(h.locks().length,1);h.confirm();assert.equal(h.locks()[1].deviceId,3);
});

test('two online same-number CH options retain receiver identity and support independent notes/multiple locks',async()=>{
 const h=await harness(devices().map((d,i)=>({...d,group_source:'server-fifo-v1',group_number:i?'10':2}))),before=copy(h.devices);
 assert.match(h.e.plannerLockChannel.innerHTML,/192\.0\.2\.1 · GROUP2 · CH1 · 641\.000 MHz/);assert.match(h.e.plannerLockChannel.innerHTML,/192\.0\.2\.2 · GROUP10 · CH1 · 645\.000 MHz/);
 h.select('device:rx-a_ch1');h.confirm();h.note('主持人');h.confirm();h.select('device:rx-b_ch1');h.confirm();assert.equal(h.e.plannerLockNote.value,'');h.note('嘉宾');h.confirm();
 assert.deepEqual(h.locks(),[{deviceId:1,frequencyKHz:641000,reason:'主持人'},{deviceId:2,frequencyKHz:645000,reason:'嘉宾'}]);
 assert.match(h.e.plannerLockChannel.innerHTML,/192\.0\.2\.1 · GROUP2 · CH1 · 641\.000 MHz · 已锁定 · 主持人/);
 h.select('lock:0');assert.equal(h.e.plannerLockNote.value,'主持人');h.note('主讲');h.confirm();assert.equal(h.locks()[1].reason,'嘉宾');
 assert.match(h.e.freqTableBody.innerHTML,/锁定 · 主讲/);assert.match(h.e.freqTableBody.innerHTML,/锁定 · 嘉宾/);
 assert.deepEqual(copy(h.devices.map(({planned,...d})=>d)),before);
});

test('lock captures displayed frequency; live frequency, missing telemetry and note typing never move it',async()=>{
 const h=await harness();h.select('device:rx-a_ch1');h.confirm();h.note('主持人 ');h.confirm();h.devices[0].freq=649000;h.refresh();
 assert.equal(h.locks()[0].frequencyKHz,641000);assert.equal(h.e.plannerLockNote.value,'主持人');
 assert.match(h.e.plannerLockChannel.title,/当前频点 649.000/);
 h.devices[0].freq=null;h.refresh();assert.equal(h.locks()[0].frequencyKHz,641000);assert.match(h.e.plannerLockChannel.title,/当前频点 —/);
});

test('only online channels with canonical valid kHz are selectable; mute is not offline',async()=>{
 const list=Array.from({length:7},(_,i)=>({...devices()[0],id:i+1,_fasheId:`rx-a_ch${i+1}`,channel_number:i+1,ch:`CH${i+1}`}));
 list[0]._online='false';list[1].status='offline';list[2].freq=null;list[3].freq=641;list[4].freq=641000.5;list[5].freq='641000';list[6].muted=true;
 const h=await harness(list);for(let i=1;i<=6;i++)assert.doesNotMatch(h.e.plannerLockChannel.innerHTML,new RegExp(`device:rx-a_ch${i}`));
 assert.match(h.e.plannerLockChannel.innerHTML,/device:rx-a_ch7/);
});

test('stale open dropdown cannot lock a now-offline/replaced receiver or reused local ID',async()=>{
 for(const replace of [false,true]){
  const h=await harness();if(replace)h.devices.splice(0,1,{...devices()[0],receiver_mac:'AA:BB:CC:DD:EE:FF',receiver_ip:'192.0.2.9'});else h.devices[0]._online=false;
  h.select('device:rx-a_ch1');h.confirm();assert.deepEqual(h.locks(),[]);assert.ok(h.notices.some(n=>n[1]==='无法锁定'));
 }
});

test('offline locks remain editable/removable; unknown historical identities never fall through to another CH1',async()=>{
 const h=await harness();h.select('device:rx-a_ch1');h.confirm();h.note('主持人');h.confirm();h.select('device:rx-b_ch1');h.confirm();h.note('嘉宾');h.confirm();
 h.devices.splice(0,1);h.refresh();assert.match(h.e.plannerLockChannel.innerHTML,/离线\/待连接锁定/);
 h.select('lock:0');assert.equal(h.e.plannerLockNote.value,'主持人');h.note('待上线');h.confirm();
 assert.throws(()=>h.locks(),/原接收机通道尚未找到/);assert.doesNotMatch(h.e.freqTableBody.innerHTML,/锁定 · 待上线/);
 h.remove();assert.deepEqual(h.locks(),[{deviceId:2,frequencyKHz:645000,reason:'嘉宾'}]);
});

test('cancel then reselect uses new frequency, without cancelling another receiver lock',async()=>{
 const h=await harness();h.select('device:rx-a_ch1');h.confirm();h.select('device:rx-b_ch1');h.confirm();h.select('lock:0');h.remove();
 assert.equal(h.locks().length,1);assert.equal(h.locks()[0].deviceId,2);
 h.devices[0].freq=649000;h.refresh();h.select('device:rx-a_ch1');h.confirm();assert.equal(h.locks().find(l=>l.deviceId===1).frequencyKHz,649000);
});

test('remarks are escaped, bounded, cannot inject extra locks, and blank notes retain default lock semantics',async()=>{
 const h=await harness();h.select('device:rx-a_ch1');h.confirm();h.note('<img src=x onerror=alert(1)> & 嘉宾\nrx-b_ch1=646.000');h.confirm();
 assert.equal(h.locks().length,1);assert.doesNotMatch(h.e.freqTableBody.innerHTML,/<img/);assert.match(h.e.freqTableBody.innerHTML,/&lt;img/);
 assert.doesNotMatch(h.e.plannerLockChannel.innerHTML,/<img/);assert.match(h.e.plannerLockChannel.innerHTML,/&lt;img/);
 h.note('人'.repeat(90));h.confirm();assert.equal(h.locks()[0].reason.length,80);
 h.note('');h.confirm();assert.equal(h.locks()[0].reason,'用户锁定');assert.equal(h.locks()[0].frequencyKHz,641000);
});

test('notes and multiple locks save to project/history, restore by receiver after IDs change and enter global solver',async()=>{
 const h=await harness();h.select('device:rx-a_ch1');h.confirm();h.note('主持人');h.confirm();h.select('device:rx-b_ch1');h.confirm();h.note('嘉宾');h.confirm();
 await h.c.saveCurrentPlanningConstraints();assert.equal(h.saved.length,1);
 const record=h.saved[0].record;assert.equal(record.constraints.lockedAssignments[1].reason,'嘉宾');
 const next=await harness(devices().map(d=>({...d,id:d.id+10,freq:d.freq+2000})));
 next.c.DatyPlanningConstraints.restoreSnapshot(record);assert.deepEqual(next.locks().map(l=>l.deviceId),[11,12]);
 assert.equal(next.locks()[0].frequencyKHz,641000);assert.equal(next.e.plannerLockNote.value,'主持人');
 const before=next.devices.map(d=>d.freq);next.c.runPlanning();assert.deepEqual(copy(next.c.DATY_LAST_COORDINATION.errors),[]);
 assert.deepEqual(copy(next.c.DATY_LAST_COORDINATION.assignments.map(a=>a.frequencyKHz)),[641000,645000]);
 assert.deepEqual(next.devices.map(d=>d.freq),before);
});

test('legacy multiline or malformed historic locks are preserved, exposed and individually removable',async()=>{
 const h=await harness();const raw='\nrx-a_ch1=642.000 旧主持人\n\nBAD-OLD-LOCK\nrx-b_ch1=646.000 旧嘉宾';
 h.c.DatyPlanningConstraints.restoreSnapshot({constraintFields:{plannerLockedAssignments:raw}});
 assert.equal(h.e.plannerLockedAssignments.value,raw);assert.match(h.e.plannerLockChannel.innerHTML,/BAD-OLD-LOCK/);
 h.select('lock:3');assert.equal(h.e.plannerLockNote.disabled,true);h.remove();
 assert.deepEqual(h.locks().map(l=>l.reason),['旧主持人','旧嘉宾']);
});

test('viewing existing lock does not invalidate a plan; actual note edit does, with visible error focus',async()=>{
 const h=await harness();h.select('device:rx-a_ch1');h.confirm();h.c.runPlanning();assert.ok(h.c.DATY_LAST_COORDINATION);
 h.select('lock:0');assert.ok(h.c.DATY_LAST_COORDINATION);h.note('新使用者');h.confirm();assert.equal(h.c.DATY_LAST_COORDINATION,null);
 h.devices.splice(0,1);h.refresh();h.c.runPlanning();assert.equal(h.document.activeElement,h.e.plannerLockChannel);
 assert.equal(h.e.plannerLockChannel.getAttribute('aria-invalid'),'true');
});


test('device usage editor updates only the matching lock note and reports persistence outcome',async()=>{
 const h=await harness();h.select('device:rx-a_ch1');h.confirm();h.note('鼓手');h.confirm();h.select('device:rx-b_ch1');h.confirm();h.note('主唱');h.confirm();
 const editor=h.c.DatyPlanningConstraints.createLockedUsageEditor(h.devices[0]);
 assert.equal(editor.value,'鼓手');assert.equal(editor.disabled,false);
 h.devices[0].freq=650000;const before=copy(h.devices);assert.equal(editor.apply('鼓手 / 返听'),true);
 assert.deepEqual(h.locks(),[{deviceId:1,frequencyKHz:641000,reason:'鼓手 / 返听'},{deviceId:2,frequencyKHz:645000,reason:'主唱'}]);
 assert.deepEqual(copy(h.devices),before);assert.equal(await h.c.saveCurrentPlanningConstraints(),true);
 assert.equal(h.saved[0].record.constraints.lockedAssignments[0].reason,'鼓手 / 返听');
 editor.apply('');assert.equal(h.locks()[0].reason,'用户锁定');assert.equal(h.locks()[0].frequencyKHz,641000);
 h.c.persistPlanningProject=async()=>{throw Error('offline');};assert.equal(await h.c.saveCurrentPlanningConstraints(),false);
});

test('device usage editor rejects stale, duplicate, absent and replaced receiver locks',async()=>{
 for(const kind of ['note','removed','duplicate','replacement']) {
  const h=await harness();h.select('device:rx-a_ch1');h.confirm();h.note('鼓手');h.confirm();
  const editor=h.c.DatyPlanningConstraints.createLockedUsageEditor(h.devices[0]);
  if(kind==='note')h.note('已被修改');h.confirm();
  if(kind==='removed')h.remove();
  if(kind==='duplicate')h.e.plannerLockedAssignments.value+='\nrx-a_ch1=642.000 重复';
  if(kind==='replacement')h.devices[0].receiver_mac='AA:BB:CC:DD:EE:FF';
  const raw=h.e.plannerLockedAssignments.value;assert.throws(()=>editor.apply('不能覆盖'),/已变化/);
  assert.equal(h.e.plannerLockedAssignments.value,raw);
 }
 const h=await harness();const editor=h.c.DatyPlanningConstraints.createLockedUsageEditor(h.devices[0]);
 assert.equal(editor.disabled,true);assert.equal(editor.value,'');assert.throws(()=>editor.apply('不能新增'),/已变化/);assert.deepEqual(h.locks(),[]);
});

test('channel usage follows confirmed lock notes without telemetry and clears when unlocked',async()=>{
 const h=await harness(),d=h.devices[0],usage={textContent:'',hidden:true},frequency={textContent:''};
 const card={dataset:{},querySelector:s=>s==='[data-role="usage"]'?usage:s==='[data-role="frequency"]'?frequency:null};
 h.c.filterDevicesChannels=()=>h.c.patchChannelCard(card,d);
 h.c.patchChannelCard(card,d);assert.equal(usage.hidden,true);
 h.select('device:rx-a_ch1');h.note('主唱');assert.equal(usage.hidden,true);h.confirm();
 assert.equal(usage.textContent,'主唱');assert.equal(usage.hidden,false);assert.equal(frequency.textContent,'641.000 MHz');
 assert.equal(h.c.getChannelCardState(h.devices[1]).usage,'','another receiver CH1 must not inherit the role');
 h.note('主唱 / 返听');h.confirm();assert.equal(usage.textContent,'主唱 / 返听');
 h.remove();assert.equal(usage.textContent,'');assert.equal(usage.hidden,true);assert.equal(d.freq,641000);
});

test('channel usage honors restored identity, escapes text and hides ambiguous or default notes',async()=>{
 const h=await harness();h.select('device:rx-a_ch1');h.note('主唱 <img src=x>');h.confirm();
 const html=h.c.createChannelCardHTML(h.devices[0]);assert.match(html,/主唱 &lt;img src=x&gt;/);assert.doesNotMatch(html,/<img/);
 await h.c.saveCurrentPlanningConstraints();const record=h.saved[0].record;
 const next=await harness(devices().map(d=>({...d,id:d.id+10,freq:d.freq+2000})));
 next.c.DatyPlanningConstraints.restoreSnapshot(record);
 assert.equal(next.c.getChannelCardState(next.devices[0]).usage,'主唱 <img src=x>');
 assert.equal(next.c.getChannelCardState(next.devices[1]).usage,'');
 assert.match(next.c.createChannelCardHTML(next.devices[0]),/643.000 MHz/,'actual frequency is not replaced with the lock frequency');
 next.devices[0].receiver_mac='AA:BB:CC:DD:EE:FF';assert.equal(next.c.getChannelCardState(next.devices[0]).usage,'');
 for(const raw of ['CH1=641.000 不唯一','rx-a_ch1=641.000 用户锁定','rx-a_ch1=641.000 手动指定频率','rx-a_ch1=641.000 主唱\nrx-a_ch1=642.000 重复']){
  h.c.DatyPlanningConstraints.restoreSnapshot({constraintFields:{plannerLockedAssignments:raw}});
  assert.equal(h.c.getChannelCardState(h.devices[0]).usage,'');
 }
});
