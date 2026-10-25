// Isolated performance/regression checks. Never control the live receiver.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const root = process.env.DATY_TEST_ASSET_ROOT || path.join(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, 'src/modules', name + '.js'), 'utf8');
const quiet = {log(){}, warn(){}, error(){}};
function harness() {
  const calls = [], notices = [];
  const c = vm.createContext({console:quiet, crypto, Date, Promise, performance, setTimeout, clearTimeout, AbortController,
    _fasheApiUrl:'http://isolated', _fasheSSE:{readyState:1}, DEVICES:[],
    fetch:async url => {calls.push(url);return {json:async()=>({success:true,command:{command_id:'c1',status:'published'}})};},
    notify:(...args)=>notices.push(args), filterDevicesChannels(){}, document:{readyState:'loading',addEventListener(){},getElementById(){return null;}}});
  c.window = c;
  c.addEventListener=()=>{};c.setInterval=()=>1;c.clearInterval=()=>{};
  vm.runInContext(source('navigation'), c);
  return {c,calls,notices};
}
const ack = (id='c1', extra={}) => ({command_id:id, status:'acknowledged', actual_value:true, device_id:'receiver-a_ch1', ...extra});

test('button diagnostics measure handler-to-DOM separately from server ACK RTT and stay bounded',async()=>{
  const {c}=harness();c.DEVICES.push({id:1,_fasheId:'receiver-a_ch1',channel:1,muted:false,name:'A'});
  let next=0;c.fetch=async(_url,options)=>{
    const cmd=JSON.parse(options.body),record=ack('d'+(++next),{command:cmd.command,actual_value:cmd.value,
      client_request_id:cmd.client_request_id,ack_round_trip_ms:2.5});
    return {json:async()=>({success:true,command_id:record.command_id,command_record:record})};
  };
  for(let i=0;i<52;i++)await c.setDeviceMuteState(1,i%2===0);
  const trace=c.getMuteControlDiagnostics();assert.equal(trace.length,50);
  const last=trace.at(-1);assert.equal(last.command,'unmute');assert.equal(last.server_ack_ms,2.5);
  assert.equal(last.state,'acknowledged');assert.equal(last.confirmation_path,'http-post');
  assert.ok(last.ack_received_ms>=last.request_start_ms);assert.ok(last.ui_updated_ms>=last.ack_received_ms);
  last.state='tampered';assert.equal(c.getMuteControlDiagnostics().at(-1).state,'acknowledged');
});

test('failed button diagnostic cannot manufacture an ACK or overwrite muted state',async()=>{
  const {c}=harness();c.DEVICES.push({id:1,_fasheId:'receiver-a_ch1',channel:1,muted:true,name:'A'});
  c.fetch=async()=>({json:async()=>({success:false,error:'target offline'})});
  await c.setDeviceMuteState(1,false);const trace=c.getMuteControlDiagnostics().at(-1);
  assert.equal(trace.state,'failed');assert.equal(trace.ack_received_ms,undefined);
  assert.ok(trace.ui_updated_ms>=trace.request_start_ms);assert.equal(c.DEVICES[0].muted,true);
});

test('real matching SSE ACK unlocks CH1 even when the POST response never returns', async () => {
  const {c}=harness();let posted, postSignal;
  c.DEVICES.push({id:1,_fasheId:'receiver-a_ch1',channel:1,muted:false,name:'A'});
  c.fetch=(_url,options)=>{posted=JSON.parse(options.body);postSignal=options.signal;return new Promise(()=>{});};
  const action=c.setDeviceMuteState(1,true);
  await Promise.resolve(); await Promise.resolve();
  c.receiveCommandAcknowledgement(ack('server-command',{client_request_id:posted.client_request_id,command:'mute',expected_value:true}));
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  assert.equal(c.__DATY_MUTE_COMMANDS_IN_FLIGHT.size,0,'device executed but server button stays locked behind HTTP');
  await action;assert.equal(postSignal.aborted,true);assert.equal(c.DEVICES[0].muted,true);
});

test('hung POST or response body has a total deadline and releases the visible channel lock', async () => {
  for (const bodyHangs of [false,true]) {
    const {c,notices}=harness();let signal;
    c.DEVICES.push({id:1,_fasheId:'receiver-a_ch1',channel:1,muted:false,name:'A'});
    const original=c.sendTrackedMuteCommand;c.sendTrackedMuteCommand=cmd=>original(cmd,25);
    c.fetch=async(_url,options)=>{signal=options.signal;return bodyHangs ? {json:()=>new Promise(()=>{})} : new Promise(()=>{});};
    await c.setDeviceMuteState(1,true);
    assert.equal(c.__DATY_MUTE_COMMANDS_IN_FLIGHT.size,0);assert.equal(signal.aborted,true);
    assert.equal(vm.runInContext('muteRequestWaiters.size',c),0);assert.equal(c.DEVICES[0].muted,false);
    assert.ok(notices.some(n=>n[1]==='静音失败'&&n[2].includes('请求超时')));
  }
});

test('expired request ACK or another browser ACK cannot release a new request on the same CH', async () => {
  const {c}=harness();const sent=[];
  c.fetch=async(_url,options)=>{sent.push(JSON.parse(options.body));return new Promise(()=>{});};
  const cmd={device_id:'receiver-a_ch1',command:'mute',value:true};
  await assert.rejects(c.sendTrackedMuteCommand(cmd,20),/请求超时/);
  const second=c.sendTrackedMuteCommand(cmd,1000);let complete=false;second.then(()=>complete=true);
  c.receiveCommandAcknowledgement(ack('old',{command:'mute',client_request_id:sent[0].client_request_id}));
  c.receiveCommandAcknowledgement(ack('another-browser',{command:'mute',client_request_id:'other-window-request'}));
  await Promise.resolve();assert.equal(complete,false);
  c.receiveCommandAcknowledgement(ack('new',{command:'mute',client_request_id:sent[1].client_request_id}));
  assert.equal((await second).command_id,'new');
});

test('network response error still permits a matching real SSE confirmation', async () => {
  const {c}=harness();let request;
  c.fetch=async(_url,options)=>{request=JSON.parse(options.body);throw Error('response lost');};
  const waiting=c.sendTrackedMuteCommand({device_id:'receiver-a_ch1',command:'unmute',value:false},1000);
  await Promise.resolve();
  c.receiveCommandAcknowledgement(ack('executed',{command:'unmute',actual_value:false,client_request_id:request.client_request_id}));
  assert.equal((await waiting).actual_value,false);
});

test('correlated ACK with a wrong receiver, action or actual state fails without changing UI', async () => {
  for(const extra of [{device_id:'receiver-b_ch1'},{command:'unmute'},{actual_value:false}]) {
    const {c}=harness();let request;
    c.fetch=async(_url,options)=>{request=JSON.parse(options.body);return new Promise(()=>{});};
    const waiting=c.sendTrackedMuteCommand({device_id:'receiver-a_ch1',command:'mute',value:true},1000);
    c.receiveCommandAcknowledgement(ack('bad',{command:'mute',client_request_id:request.client_request_id,...extra}));
    await assert.rejects(waiting,/不匹配/);
  }
});

test('HTTP rejection terminates without waiting for a fake ACK', async () => {
  const {c}=harness();c.fetch=async()=>({json:async()=>({success:false,error:'offline target'})});
  await assert.rejects(c.sendTrackedMuteCommand({device_id:'receiver-a_ch1',command:'mute',value:true},1000),/offline target/);
  assert.equal(vm.runInContext('muteRequestWaiters.size',c),0);
});

test('pushed ACK completes immediately, with no 250 ms wait and no HTTP query', async t => {
  const {c,calls}=harness();
  const started=performance.now(), waiting=c.waitForCommandAcknowledgement('c1');
  c.receiveCommandAcknowledgement(ack());
  assert.equal((await waiting).command_id, 'c1');
  const elapsed=performance.now()-started;
  assert.equal(calls.length,0);
  assert.ok(elapsed < 100, `unexpected fixed wait: ${elapsed} ms`);
  assert.equal(vm.runInContext('commandAcknowledgementWaiters.size', c),0);
  t.diagnostic(`isolated pushed-ACK delivery: ${elapsed.toFixed(3)} ms (not LAN RTT)`);
});

test('ACK before POST response is cached; late published cannot overwrite it', async () => {
  const {c,calls}=harness();
  c.receiveCommandAcknowledgement(ack());
  c.receiveCommandAcknowledgement({command_id:'c1',status:'published'});
  assert.equal((await c.waitForCommandAcknowledgement('c1')).status,'acknowledged');
  assert.equal(calls.length,0);
});

test('wrong command ID and published are not success; multiple waiters receive real failure', async () => {
  const {c}=harness();
  const a=c.waitForCommandAcknowledgement('c1',1000), b=c.waitForCommandAcknowledgement('c1',1000);
  c.receiveCommandAcknowledgement(ack('wrong'));
  c.receiveCommandAcknowledgement({command_id:'c1',status:'published'});
  assert.equal(vm.runInContext('commandAcknowledgementWaiters.get("c1").size', c),2);
  c.receiveCommandAcknowledgement({command_id:'c1',status:'failed',error:'target disconnected'});
  await assert.rejects(a,/target disconnected/); await assert.rejects(b,/target disconnected/);
});

test('no SSE uses immediate HTTP fallback and validates returned command ID', async () => {
  const {c}=harness(); c._fasheSSE=null;
  c.fetch=async()=>({json:async()=>({success:true,command:ack()})});
  assert.equal((await c.waitForCommandAcknowledgement('c1',1000)).status,'acknowledged');
  c.fetch=async()=>({json:async()=>({success:true,command:ack('wrong')})});
  await assert.rejects(c.waitForCommandAcknowledgement('c2',25),/超时/);
});

test('lost SSE falls back; network failure/hung request still has deadline and cleanup', async () => {
  const {c}=harness();
  c.fetch=async()=>({json:async()=>({success:true,command:ack()})});
  assert.equal((await c.waitForCommandAcknowledgement('c1',1000)).status,'acknowledged');
  c._fasheSSE=null;
  let signal;
  c.fetch=async (_url, options) => {signal=options.signal;return new Promise(()=>{});};
  await assert.rejects(c.waitForCommandAcknowledgement('hung',25),/超时/);
  assert.equal(signal.aborted,true);
  assert.equal(vm.runInContext('commandAcknowledgementWaiters.size', c),0);
});

test('terminal ACK cache remains bounded under long sessions', () => {
  const {c}=harness();
  for(let i=0;i<1000;i++) c.receiveCommandAcknowledgement(ack('c'+i));
  assert.equal(vm.runInContext('commandAcknowledgementCache.size', c),256);
});

test('same-channel double click is fenced, different receivers remain independent, HTTP alone never mutes', async () => {
  const {c,notices}=harness();
  c.DEVICES.push({id:1,_fasheId:'receiver-a_ch1',receiver_id:'receiver-a',channel:1,muted:false,name:'A'},
    {id:2,_fasheId:'receiver-b_ch1',receiver_id:'receiver-b',channel:1,muted:false,name:'B'});
  let posts=0;
  c.fetch=async(_url, options)=>{posts++; const command=JSON.parse(options.body); return {json:async()=>({success:true,command_id:command.device_id})};};
  const a=c.setDeviceMuteState(1,true);
  await Promise.resolve();
  await c.setDeviceMuteState(1,false);
  const b=c.setDeviceMuteState(2,true);
  assert.equal(posts,2);
  assert.equal(c.DEVICES[0].muted,false);
  c.receiveCommandAcknowledgement(ack('receiver-a_ch1'));
  c.receiveCommandAcknowledgement(ack('receiver-b_ch1',{device_id:'receiver-b_ch1'}));
  await Promise.all([a,b]);
  assert.equal(c.DEVICES.every(d=>d.muted),true);
  assert.equal(c.__DATY_MUTE_COMMANDS_IN_FLIGHT.size,0);
  assert.ok(notices.some(n=>n[1]==='正在等待设备确认'));
});

test('a delayed ACK cannot overwrite a newer telemetry snapshot', async () => {
  const {c}=harness();
  c.DEVICES.push({id:1,_fasheId:'receiver-a_ch1',channel:1,muted:false,_lastRealtimeAt:1,name:'A'});
  c.fetch=async()=>({json:async()=>({success:true,command_id:'c1'})});
  const waiting=c.setDeviceMuteState(1,true);
  c.DEVICES[0]={...c.DEVICES[0],_lastRealtimeAt:2,muted:false};
  c.receiveCommandAcknowledgement(ack()); await waiting;
  assert.equal(c.DEVICES[0].muted,false);
});

test('SSE subscribes to command_update before any device_list has arrived', () => {
  const {c}=harness(); const events=new Map(); let received;
  Object.assign(c,{document:{addEventListener(){}},EventSource:function(){this.addEventListener=(name, fn)=>events.set(name,fn);},
    receiveCommandAcknowledgement:command=>received=command});
  vm.runInContext(source('fashe'),c);
  c._fasheStartSSE();
  events.get('command_update')({data:JSON.stringify({data:ack()})});
  assert.equal(received.command_id,'c1');
});

test('50 state packets evaluate every alarm edge but schedule only one DOM frame', () => {
  const {c}=harness(); const frames=[],evaluated=[],painted=[];
  Object.assign(c,{document:{addEventListener(){}},requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){},
    evaluateRealtimeAlerts:devices=>evaluated.push(devices[0].rf)});
  vm.runInContext(source('fashe'),c);
  c._fasheFlushUI=()=>painted.push(c.DEVICES[0].rf);
  c.DEVICES.push({rf:-50});
  for(let i=0;i<50;i++){c.DEVICES[0].rf=i%2 ? -50 : -90;c._fasheUpdateUI(c.DEVICES,1);}
  assert.equal(evaluated.length,50);assert.equal(frames.length,1);assert.equal(painted.length,0);
  frames[0]();assert.deepEqual(painted,[-50]);
});

test('realtime repaint skips hidden panels, keeps sidebar stats and channel filters', () => {
  const calls=[];
  const c=vm.createContext({console:quiet,DEVICES:[],addEventListener(){},setInterval:()=>1,clearInterval(){},
    document:{addEventListener(){},getElementById:id=>({classList:{contains:()=>id==='panel-channels'}})},
    evaluateRealtimeAlerts:()=>calls.push('alerts'),updateDashboardStats:()=>calls.push('dashboard-stats')});
  vm.runInContext(source('render'),c);
  c.evaluateRealtimeAlerts=()=>calls.push('alerts');
  for(const name of ['updateDeviceConnectionSummary','renderProtocolStatus','renderDevTable','renderDeviceGridChannels','renderDeviceGrid',
    'renderMonitorGrid','renderFreqTable','filterDevicesChannels'])c[name]=()=>calls.push(name);
  c.forceRefreshAllPanels({realtime:true});
  assert.deepEqual(calls,['alerts','updateDeviceConnectionSummary','dashboard-stats','filterDevicesChannels']);
});

test('disconnect cancels scheduled connected display; background frame fallback still paints', async () => {
  const {c}=harness();const frames=[],paints=[];
  Object.assign(c,{document:{addEventListener(){}},requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){}});
  vm.runInContext(source('fashe'),c);
  c._fasheFlushUI=()=>paints.push('paint');
  c._fasheUpdateUI([],0);c._fasheMarkDevicesOffline();frames[0]();
  assert.equal(paints.length,0);
  c._fasheUpdateUI([],0);
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(paints.length,1);
});


const shureMuteDevice=()=>({id:1,_fasheId:'shure-a_ch1',receiver_id:'shure-a',receiver_ip:'192.0.2.107',receiver_mac:'00:0E:DD:AD:31:A3',
 channel_number:1,_source:'shure-scp',brand:'Shure',status:'online',_online:true,muted:false,name:'Shure',_lastRealtimeAt:1,
 shure:{schema:'daty-shure-telemetry-v1',meter_state:'live',meter_stream_id:'stream-a',receiver_muted:false,transmitter_muted:false,
  field_times:{muted:1000,battery_bars:900},stale_fields:[],audio_dbfs:-10,battery_bars:4},capabilities:{adapter:'shure-scp',mute:true}});
function shureMuteReceipt(c,d,value=true,at=2000){
 const command=c.buildTargetedDeviceCommand(d,value?'mute':'unmute',value);
 const {device_id,receiver_id,receiver_ip,receiver_mac,receiver_session_id,channel_number,expected_brand}=command;
 return {command_id:'saved-shure-command',device_id,command:command.command,status:'readback_confirmed',expected_brand,actual_value:value,
  execution_evidence:{source:'shure-post-write-readback',execution_ack_supported:false,actual_value:value,
   sent_at_ms:at-200,received_at_ms:at,target:{device_id,receiver_id,receiver_ip,receiver_mac,receiver_session_id,channel_number,expected_brand}}};
}
test('saved Shure readback updates the card despite intervening RF/AF, with no optimistic state change',async()=>{
 const {c}=harness(),d=shureMuteDevice();c.DEVICES.push(d);let resolve,posted;
 c.fetch=(_url,options)=>{posted=JSON.parse(options.body);return new Promise(r=>resolve=r);};
 const action=c.setDeviceMuteState(1,true);await Promise.resolve();
 assert.equal(d.muted,false,'sending is not a physical acknowledgement');
 d._lastRealtimeAt=2;d.shure={...d.shure,audio_dbfs:-3};
 const receipt={...shureMuteReceipt(c,d),client_request_id:posted.client_request_id};
 resolve({json:async()=>({success:true,command_id:receipt.command_id,command_record:receipt})});
 await action;assert.equal(d.muted,true);assert.equal(d.shure.receiver_muted,true);
 assert.equal(d.shure.audio_dbfs,-3);assert.equal(d.shure.field_times.muted,2000);
 assert.equal(d.shure.transmitter_muted,false);assert.equal(c.__DATY_MUTE_COMMANDS_IN_FLIGHT.size,0);
});
test('old full mute metadata and RF-only packets cannot undo a saved observation; newer true or false metadata wins',()=>{
 const {c}=harness(),d=shureMuteDevice(),original=d.shure;
 c.rememberConfirmedShureMuteView(d,shureMuteReceipt(c,d));
 assert.equal(original.receiver_muted,false,'input telemetry object must not be mutated');
 c.applyConfirmedShureMuteView(d);assert.equal(d.muted,true,'RF-only update keeps the projection');
 d.shure={...original,audio_dbfs:-2};d.muted=false;c.applyConfirmedShureMuteView(d);
 assert.equal(d.muted,true);assert.equal(d.shure.audio_dbfs,-2);assert.equal(d.shure.battery_bars,4);
 d.shure={...original,field_times:{muted:2001}};d.muted=false;c.applyConfirmedShureMuteView(d);
 assert.equal(d.muted,false);assert.equal(vm.runInContext('confirmedShureMuteViews.size',c),0);
});
test('Shure view obeys exact target, offline, generation, expiry and subsequent reverse command',()=>{
 for(const mutate of [d=>{d.receiver_mac='different';},d=>{d.shure={...d.shure,meter_stream_id:'stream-b'};},d=>{d._online=false;},d=>{d.shure={...d.shure,meter_state:'stale'};}]){
  const {c}=harness(),d=shureMuteDevice(),receipt=shureMuteReceipt(c,d);mutate(d);
  c.rememberConfirmedShureMuteView(d,receipt);assert.equal(d.muted,false);assert.equal(vm.runInContext('confirmedShureMuteViews.size',c),0);
 }
 const {c}=harness(),d=shureMuteDevice();let now=0;c.performance={now:()=>now};
 c.rememberConfirmedShureMuteView(d,shureMuteReceipt(c,d));
 c.rememberConfirmedShureMuteView(d,shureMuteReceipt(c,d,false,2300));assert.equal(d.muted,false);
 c.rememberConfirmedShureMuteView(d,shureMuteReceipt(c,d,true,2200));assert.equal(d.muted,false,'late old proof cannot undo unmute');
 now=15001;c.applyConfirmedShureMuteView(d);assert.equal(d.shure.field_times.muted,1000);
 assert.equal(vm.runInContext('confirmedShureMuteViews.size',c),0);
});
test('only validated Shure readback can populate the view; DATY ACK and missing/invalid proof remain unchanged',()=>{
 for(const change of [r=>{r.status='acknowledged';},r=>{r.execution_evidence=null;},r=>{r.execution_evidence.actual_value=false;},
  r=>{r.execution_evidence.received_at_ms=NaN;},r=>{r.execution_evidence.sent_at_ms=3000;}]){
  const {c}=harness(),d=shureMuteDevice(),receipt=shureMuteReceipt(c,d);change(receipt);
  assert.equal(c.rememberConfirmedShureMuteView(d,receipt),false);assert.equal(d.muted,false);
 }
});
test('real frontend snapshot and delta paths retain readback until newer mute field arrives',()=>{
 const {c}=harness();c.document={readyState:'loading',addEventListener(){},getElementById(){return null;}};
 c.localStorage={getItem:()=>null,setItem(){}};c.addEventListener=()=>{};c.setInterval=()=>1;c.clearInterval=()=>{};
 c.DatyFrequency={frequencyFromPayload:(d,p=null)=>d.freq??p,formatFrequencyMHz:n=>(n/1000).toFixed(3)};
 for(const module of ['dashboard','render','fashe'])vm.runInContext(source(module),c);
 c._fasheUpdateUI=()=>{};
 const initial=shureMuteDevice(),raw={...initial,id:initial._fasheId,model:'ULXD4',channel:1,freq:640000,rf:-40,af_dbfs:-10,batt:null};
 const d=c._fasheNormalizeDevice(raw);c.DEVICES.push(d);c.rememberConfirmedShureMuteView(d,shureMuteReceipt(c,d));
 c._fasheHandleDeviceUpdate([{...raw,rf:-30}]);assert.equal(d.muted,true);assert.equal(d.rf,-30);
 const restored=c._fasheNormalizeDevice(raw);assert.equal(restored.muted,true,'full snapshot also uses saved observation');
 c.DEVICES.splice(0,1,restored);
 c._fasheHandleDeviceUpdate([{...raw,muted:false,shure:{...raw.shure,field_times:{muted:2100}}}]);
 assert.equal(restored.muted,false);assert.equal(restored.shure.receiver_muted,false);
});
