// Real snapshot -> UI mapping -> planner integration. Isolated DOM/storage; no network writes.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const copy=value=>JSON.parse(JSON.stringify(value));
function receiver(ip,count,mac='02:00:00:00:00:01') {
  const rid='FAshe-MAC-'+mac.replaceAll(':','');
  return Array.from({length:count},(_,i)=>({id:`${rid}_ch${i+1}`,receiver_id:rid,receiver_ip:ip,
    receiver_mac:mac,ip,channel_number:i+1,channel:i+1,ch:`CH${i+1}`,name:`Mic CH${i+1}`,
    brand:'DATYaudio',model:'DATY-X1',group:9,freq:641000+i*250,rf:-50,af_dbfs:-12,batt:90,
    muted:i===1,_online:true,status:'online',_source:`${ip}:mqtt`,capabilities:{write_frequency:true,mute:true}}));
}
function harness(cached=[]) {
  const values=new Map([['daty_devices',JSON.stringify(cached)]]),notices=[],elements=new Map();
  for(const [id,value] of Object.entries({plannerRange:'614250:638000',plannerCompatibility:'standard',
    plannerExcludedRanges:'',plannerLockedAssignments:'',plannerKnownCarriers:'',plannerBackupCount:'0',
    planResultContent:'',freqTableBody:'',historyBody:''}))elements.set(id,{value,innerHTML:'',textContent:'',style:{},options:[],addEventListener(){},appendChild(child){this.options.push(child);}});
  const context=vm.createContext({console:{log(){},warn(){},error(){}},performance,
    document:{readyState:'loading',body:{appendChild(){}},addEventListener(){},getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[],
      createElement:()=>({style:{},addEventListener(){}})},
    localStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value))},
    notify:(...args)=>notices.push(args),fetch:()=>{throw Error('No live requests allowed');}});
  context.window=context;
  for(const module of ['frequency','equipment-profiles','coordination','storage','dashboard','render','navigation','planning-ui','discovery','fashe'])
    vm.runInContext(fs.readFileSync(path.join(root,'src/modules',module+'.js'),'utf8'),context,{filename:module+'.js'});
  context._fasheUpdateUI=()=>{};context._rebuildReceiversFromDevices=()=>{};context.forceRefreshAllPanels=()=>{};
  context.persistPlanningProject=async()=>{};
  return {c:context,values,notices,elements,devices:()=>context.DATY_STATE.devices,
    plan(){context.runPlanning();assert.ok(context.DATY_LAST_COORDINATION,JSON.stringify(notices));return context.DATY_LAST_COORDINATION;}};
}
const cachedRows=raw=>raw.map(d=>({...d,_fasheId:d.id,id:1}));
function unique(h,count) {
  assert.equal(h.devices().length,count);
  assert.equal(new Set(h.devices().map(d=>String(d.id))).size,count);
}

test('first SSE batch allocates unique UI IDs and all four channels can be planned',()=>{
  const h=harness();h.c._fasheHandleDeviceList(receiver('192.0.2.102',4));unique(h,4);
  const result=h.plan();assert.equal(result.assignments.length,4);assert.equal(result.analysis.conflicts.length,0);
  for(const d of h.devices())assert.equal(result.assignments.find(a=>a.deviceId===d.id).frequencyKHz,d.planned);
});

test('SSE repairs duplicate IDs from old cache without changing routes, frequency or mute',()=>{
  const raw=receiver('192.0.2.102',4),h=harness(cachedRows(raw));
  h.c._fasheHandleDeviceList(raw);unique(h,4);assert.equal(h.plan().assignments.length,4);
  for(const d of h.devices()) {
    const original=raw.find(r=>r.id===d._fasheId);
    assert.equal(d.freq,original.freq);assert.equal(d.muted,original.muted);assert.equal(d.channel_number,original.channel_number);
  }
});

test('HTTP snapshot also repairs inherited duplicate UI IDs',()=>{
  const raw=receiver('192.0.2.102',4),h=harness(cachedRows(raw));
  h.c._onServerData({type:'device_list',devices:raw});unique(h,4);assert.equal(h.plan().assignments.length,4);
});

test('planning preflight repairs known cached IDs after connection marks channels online',()=>{
  const cached=cachedRows(receiver('192.0.2.102',4));cached[2].id=null;delete cached[3].id;
  const h=harness(cached);h.devices().forEach(d=>{d._online=true;d.status='online';});assert.equal(h.plan().assignments.length,4);unique(h,4);
});

test('list growth, reorder, SSE/HTTP handover and reconnect preserve established IDs',()=>{
  const h=harness();let previous=new Map();
  for(const count of [1,2,4,8,4]) {
    const raw=receiver('192.0.2.102',count).reverse();h.c._fasheHandleDeviceList(raw);unique(h,count);
    for(const d of h.devices())if(previous.has(d._fasheId))assert.equal(d.id,previous.get(d._fasheId));
    previous=new Map(h.devices().map(d=>[d._fasheId,d.id]));
    h.c._onServerData({type:'device_list',devices:raw});unique(h,count);
    h.c._fasheHandleDeviceList(raw);unique(h,count);
    for(const d of h.devices())assert.equal(d.id,previous.get(d._fasheId));
  }
});

test('same CH/group/name on two receivers never collapses and command targets stay separate',()=>{
  const raw=[...receiver('192.0.2.102',2),...receiver('192.0.2.103',2,'02:00:00:00:00:02')];
  const h=harness();h.c._fasheHandleDeviceList(raw);unique(h,4);assert.equal(h.plan().assignments.length,4);
  for(const d of h.devices()) {
    const cmd=h.c.buildTargetedDeviceCommand(d,'set_freq',620.125);
    assert.equal(cmd.device_id,d._fasheId);assert.equal(cmd.ip,d.ip);assert.equal(cmd.channel,d.channel_number);
  }
});

test('manual IDs are reserved; ambiguous/missing manual identity still fails closed',()=>{
  const manual={id:1,brand:'DATYaudio',model:'RF PRO',ch:'CH1',freq:620000,_source:'manual'};
  const h=harness([manual]);h.c._fasheHandleDeviceList(receiver('192.0.2.102',4));unique(h,5);
  assert.equal(h.devices().find(d=>!d._fasheId).id,1);
  const invalid=harness([{...manual,id:null}]);invalid.c.runPlanning();
  assert.equal(invalid.c.DATY_LAST_COORDINATION,null);assert.match(invalid.elements.get('planResultContent').textContent,/ID/);
});

test('genuinely ambiguous stable identities cannot be hidden by local ID repair',()=>{
  const raw=receiver('192.0.2.102',1)[0],h=harness(cachedRows([raw,raw]));
  h.devices().forEach(d=>{d._online=true;d.status='online';});
  h.c.runPlanning();assert.equal(h.c.DATY_LAST_COORDINATION,null);
  assert.match(h.elements.get('planResultContent').textContent,/ID/);
});

test('subsequent HTTP/SSE telemetry preserves computed frequencies and routes for all channels',()=>{
  const raw=receiver('192.0.2.102',4),h=harness();h.c._fasheHandleDeviceList(raw);
  const result=h.plan(),planned=new Map(h.devices().map(d=>[d._fasheId,d.planned]));
  h.c._onServerData({type:'device_list',devices:raw});
  h.c._fasheHandleDeviceList(raw);
  assert.equal(h.c.DATY_LAST_COORDINATION,result);
  for(const d of h.devices())assert.equal(d.planned,planned.get(d._fasheId));
});

test('old duplicate UI IDs do not break receiver-based historical locks or plan restoration',()=>{
  const raw=receiver('192.0.2.102',4),h=harness(cachedRows(raw));
  h.devices().forEach(d=>{d._online=true;d.status='online';});
  const saved=h.devices()[1];
  h.c.repairRealtimeDeviceIds(h.devices());unique(h,4);
  assert.equal(h.c.findPlanningDevice({...saved,id:1}),h.devices()[1]);
  h.c.DatyPlanningConstraints.restoreSnapshot({constraints:{
    // Real historical keys must be unambiguous; this record retains stable channel identity.
    lockedAssignments:[{deviceId:101,frequencyKHz:620000}]},
    options:{rangeStartKHz:614250,rangeEndKHz:638000},
    devices:cachedRows(raw).map((d,i)=>({...d,id:100+i}))});
  const lock=h.c.DatyPlanningConstraints.readConstraintFields().lockedAssignments[0];
  assert.equal(lock.deviceId,h.devices()[1].id);
  const result=h.plan();assert.equal(result.assignments.find(a=>a.deviceId===lock.deviceId).frequencyKHz,620000);
});

test('ID repair preserves manual entries and healthy string IDs; rerunning is idempotent',()=>{
  const raw=cachedRows(receiver('192.0.2.102',4));raw[1].id='1';raw[2].id='already-unique';
  const h=harness([{id:1,ch:'CH5',freq:620000,_source:'manual'},...raw]);
  assert.equal(h.c.repairRealtimeDeviceIds(h.devices()),3);unique(h,5);
  assert.equal(h.devices()[0].id,1);assert.equal(h.devices()[3].id,'already-unique');
  assert.equal(h.c.repairRealtimeDeviceIds(h.devices()),0);
});

function tableRows(h) {
  return [...h.elements.get('freqTableBody').innerHTML.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(match=>({
    html:match[1],group:match[1].match(/<td class="planner-group-cell">([^<]+)<\/td>/)[1],id:match[1].match(/id="fi_([^"]+)"/)[1],
    frequency:match[1].match(/class="freq-input" value="([^"]+)"/)[1],
    action:match[1].match(/onclick="([^"]+)"/)[1].replaceAll('&quot;','"')}));
}

test('planning table keeps CH ascending within a receiver GROUP without reassigning frequencies, channels or actions',()=>{
  const h=harness();h.c._fasheHandleDeviceList(receiver('192.0.2.102',4).reverse());
  [638000,614250,620000,0].forEach((frequency,i)=>{h.devices()[i].planned=frequency;});
  const before=copy(h.devices());h.c.renderFreqTable(true);
  const rows=tableRows(h),expected=[before[3],before[2],before[1],before[0]];
  assert.deepEqual(rows.map(r=>r.frequency),['—','620.000','614.250','638.000']);
  assert.deepEqual(rows.map(r=>r.id),expected.map(d=>String(d.id)));
  assert.deepEqual(copy(h.devices()),before);
  const clicked=[];h.c.pushFreq=id=>clicked.push(id);
  rows.forEach((row,i)=>{assert.ok(row.html.includes(`<td>${expected[i].ch}</td>`));vm.runInContext(row.action,h.c);});
  assert.deepEqual(clicked,expected.map(d=>d.id));
});

test('unassigned and invalid planning values do not change CH ordering',()=>{
  const h=harness();h.c._fasheHandleDeviceList(receiver('192.0.2.102',8));
  [null,620000,'614250',0,620000,NaN,-1,undefined].forEach((frequency,i)=>{h.devices()[i].planned=frequency;});
  h.c.renderFreqTable(true);
  assert.deepEqual(tableRows(h).map(r=>r.id),Array.from(h.devices(),d=>String(d.id)));
});

test('before planning, the same CH ordering applies regardless of current frequency',()=>{
  const h=harness();h.c._fasheHandleDeviceList(receiver('192.0.2.102',4).reverse());
  [650000,470000,0,600000].forEach((frequency,i)=>{h.devices()[i].freq=frequency;});
  h.c.renderFreqTable(false);
  assert.deepEqual(tableRows(h).map(r=>r.id),[3,2,1,0].map(i=>String(h.devices()[i].id)));
  assert.ok(tableRows(h).every(r=>r.frequency==='—'));
});

test('actual planning and repeated snapshot refresh keep CH1 at the top',()=>{
  const h=harness(),raw=receiver('192.0.2.102',4).reverse();h.c._fasheHandleDeviceList(raw);
  const result=h.plan(),initial=tableRows(h);
  const byCh=Array.from(h.devices()).sort((a,b)=>a.channel_number-b.channel_number);
  const expected=byCh.map(d=>(result.assignments.find(a=>a.deviceId===d.id).frequencyKHz/1000).toFixed(3));
  assert.deepEqual(initial.map(r=>r.frequency),expected);
  assert.deepEqual(initial.map(r=>r.id),byCh.map(d=>String(d.id)));
  h.c._onServerData({type:'device_list',devices:raw});h.c._fasheHandleDeviceList(raw);h.c.renderFreqTable(true);
  assert.deepEqual(tableRows(h).map(r=>[r.id,r.frequency]),initial.map(r=>[r.id,r.frequency]));
});

test('GROUP sorts numerically before CH, unknown GROUP last, with stable same-CH actions',()=>{
  const fixtures=[
    {id:1,group_number:10,ch:'CH1'}, {id:2,group_number:'2',ch:'CH10'},
    {id:3,group_number:2,ch:'CH2'}, {id:4,group_number:2,ch:'CH2'},
    {id:5,group_number:null,ch:'CH1'}, {id:6,group_number:2,ch:'unknown'},
    {id:7,group_number:1,ch:'CH12'}, {id:8,group_number:0,ch:'CH2'},
    {id:9,group_number:1,group:1,group_source:undefined,ch:'CH3'},
    {id:10,group_number:true,ch:'CH4'}
  ];
  const h=harness(fixtures.map(d=>({group_source:'server-fifo-v1',...d,brand:'DATYaudio',model:'RF PRO',freq:641000,planned:642000})));
  // Even an existing local display number is not authoritative server information.
  h.c.getReceiverGroupNumber(h.devices().find(d=>d.id===9));
  const storedBefore=[...h.values];
  const before=copy(h.devices()),expected=['7','3','4','2','6','1','5','8','9','10'];
  for(const planned of [false,true]){
    h.c.renderFreqTable(planned);const rows=tableRows(h);
    assert.deepEqual(rows.map(r=>r.id),expected);assert.deepEqual(copy(h.devices()),before);
    assert.deepEqual(rows.map(r=>r.group),['GROUP1','GROUP2','GROUP2','GROUP2','GROUP2','GROUP10','—','—','—','—']);
    assert.deepEqual([...h.values],storedBefore,'Rendering must not allocate browser group numbers');
    const clicked=[];h.c.pushFreq=id=>clicked.push(String(id));rows.forEach(row=>vm.runInContext(row.action,h.c));
    assert.deepEqual(clicked,expected);
  }
});

test('new 640-690 MHz range is selectable and actual planning preserves clean current frequencies',()=>{
  const html=fs.readFileSync(path.join(root,'unirf-app.html'),'utf8');
  const range=html.match(/<select id="plannerRange"[^>]*>([\s\S]*?)<\/select>/)[1];
  for(const value of ['614250:638000','470000:608000','640000:690000','scan'])assert.ok(range.includes(`value="${value}"`));
  assert.ok(range.includes('640.000–690.000 MHz'));
  const h=harness(),raw=receiver('192.0.2.102',3);[641000,642000,644000].forEach((freq,i)=>raw[i].freq=freq);
  h.c._fasheHandleDeviceList(raw);h.elements.get('plannerRange').value='640000:690000';
  const result=h.plan();assert.equal(result.options.rangeStartKHz,640000);assert.equal(result.options.rangeEndKHz,690000);
  assert.equal(result.retention.retainedCount,3);assert.equal(result.retention.changedCount,0);
  assert.equal(result.analysis.conflicts.length,0);
  assert.match(h.elements.get('planResultContent').innerHTML,/保留原频 3 个/);
  assert.ok(tableRows(h).every(row=>row.html.includes('保留原频')));
  h.c.DatyPlanningConstraints.restoreSnapshot({options:result.options,constraints:{},devices:[]});
  assert.equal(h.elements.get('plannerRange').value,'640000:690000');
});

if(process.env.DATY_ID_LIVE_CHECK==='1')test('read-only live snapshot follows SSE mapping then the real planning entry',async()=>{
  const response=await fetch('http://127.0.0.1:8802/api/devices',{signal:AbortSignal.timeout(5000)});
  const data=await response.json();assert.equal(data.success,true);
  const h=harness(cachedRows(data.devices));h.c._fasheHandleDeviceList(data.devices);
  h.elements.get('plannerRange').value='640000:690000';
  unique(h,data.devices.length);const result=h.plan();
  assert.equal(result.assignments.length,data.devices.length);assert.equal(result.analysis.conflicts.length,0);
  console.log(JSON.stringify({source:'live GET snapshot -> SSE UI mapping -> runPlanning; isolated storage',
    channels:h.devices().length,uniqueIds:new Set(h.devices().map(d=>d.id)).size,assignments:result.assignments.length,
    range:[result.options.rangeStartKHz,result.options.rangeEndKHz],retained:result.retention.retainedCount,changed:result.retention.changedCount,
    table:tableRows(h).map(r=>({id:r.id,plannedMHz:r.frequency})),
    targets:h.devices().map(d=>({id:d.id,device_id:d._fasheId,ip:d.ip,channel:d.channel_number})),errors:result.errors}));
});
