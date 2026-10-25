'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=process.env.DATY_TEST_ASSET_ROOT || path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'src/modules/discovery.js'),'utf8');
const ok=value=>({ok:true,status:200,json:async()=>value});
const state=extra=>({success:true,protocol:'daty-shure-discovery-v1',enabled:true,scanning:false,count:1,scopes:[{scan_network:'192.0.2.0/24',limited_to_24:true}],...extra});
function harness(handler,{realIdentity=false}={}){
 const elements=new Map(),timers=new Map(),calls=[];let seq=0,clock=0;
 const c=vm.createContext({URL,AbortController,console,DEVICES:[],_fasheApiUrl:'',location:{hostname:'192.0.2.16'},
  document:{getElementById(id){if(!elements.has(id))elements.set(id,{style:{},textContent:'',innerHTML:''});return elements.get(id);}},
  DatyMqttDiscoveryIntent:async()=>({}), // Isolated intent boundary; never contacts the formal server.
  DatyFrequency:{frequencyFromPayload:d=>d.freq??null,formatFrequencyMHz:n=>(n/1000).toFixed(3)},
  notify(){},DatyPlatformFactory:{serviceOrigin:(_,host)=>`https://${host}:8802`},
  DatyHostFactory:{invokeRuntime(root,method,...args){
   if(method==='nowMonotonicMs')return clock;
   if(method==='setTimeout'){const id=++seq;timers.set(id,args);if(args[1]===1000)queueMicrotask(()=>{timers.delete(id);clock+=1000;args[0]();});return id;}
   if(method==='clearTimeout')timers.delete(args[0]);
  }},
 });
 c.window=c;c.DatyPlatform={kind:'native',request(url,options){assert.equal(this,c.DatyPlatform);calls.push({url,options});return handler(url,options,calls);}};
 vm.runInContext(source,c);
 c._updateTargetChannelSelect=()=>{};
 if(realIdentity){
  const render=fs.readFileSync(path.join(root,'src/modules/render.js'),'utf8');
  vm.runInContext(render.slice(render.indexOf('function _receiverIdentityText('),render.indexOf('function getChannelCardKey(')),c);
 }else c._serverReceiverKey=d=>d.receiver_id||d.ip;
 c._serverChannelKey=n=>'CH'+n;
 return {c,calls,elements,timers};
}
test('one POST then bounded status reads through the native network and timer ports',async()=>{
 let status=0;
 const h=harness((url,options)=>ok(url.endsWith('/scan')?state({scanning:true,scanned:0,targets:253}):state({scanning:status++===1})));
 const note=await h.c._scanShureReceivers('https://192.0.2.16:8802',()=>true,()=>{});
 assert.match(note,/当前发现 1 台/);assert.match(note,/未覆盖整个子网/);
 assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
 assert.equal(h.calls.find(c=>c.options.method==='POST').options.body,'{}');
 assert.ok(h.calls.every(c=>c.options.redirect==='error'&&c.options.signal));assert.equal(h.timers.size,0);
});
test('uncertain scan POST is never retried',async()=>{
 const h=harness((url)=>url.endsWith('/scan')?Promise.reject(Error('connection lost')):ok(state()));
 await assert.rejects(h.c._scanShureReceivers('https://fixture',()=>true,()=>{}),/connection lost/);
 assert.equal(h.calls.length,2);assert.equal(h.timers.size,0);
});
test('disabled and old server never receive scan POST',async()=>{
 for(const response of [{ok:false,status:404},ok(state({enabled:false}))]){
  const h=harness(()=>response);const note=await h.c._scanShureReceivers('https://fixture',()=>true,()=>{});
  assert.match(note,/关闭|尚未启用/);assert.equal(h.calls.length,1);
 }
});
test('long scan remains explicitly in background, cancelled and error outcomes are not success',async()=>{
 for(const extra of [{scanning:true},{cancelled:true},{error:'无法读取网卡'}]){
  const h=harness(()=>ok(state(extra)));const note=await h.c._scanShureReceivers('https://fixture',()=>true,()=>{});
  assert.match(note,/后台进行|已取消|无法读取网卡/);assert.ok(h.calls.length<=37);assert.equal(h.timers.size,0);
 }
});
test('server change rejects late responses',async()=>{
 let current=true;const h=harness(async()=>{current=false;return ok(state());});
 await assert.rejects(h.c._scanShureReceivers('https://fixture',()=>current,()=>{}),/服务器已切换/);
 assert.equal(h.calls.length,1);
});
test('FAshe and Shure coexist without MQTT imitation or fabricated channels',async()=>{
 const devices=[{receiver_id:'FAshe-a',receiver_ip:'192.0.2.1',channel_number:1,_online:true},
  {receiver_id:'Shure-a',receiver_ip:'192.0.2.2',channel_number:1,_online:true},
  {receiver_id:'Shure-a',receiver_ip:'192.0.2.2',channel_number:2,_online:false}];
 const h=harness(url=>ok(url.includes('/discovery/')?state():url.endsWith('/stats')?{success:true,clients:[{receiver_id:'FAshe-a',receiver_ip:'192.0.2.1'}],external_receivers:[
  {receiver_id:'Shure-a',ip:'192.0.2.2',model:'AD4D',discovered_via:'shure-scp'},
  {receiver_id:'Shure-b',ip:'192.0.2.3',model:'ULXD4',discovered_via:'shure-scp'}]}:{success:true,devices}));
 let list;h.c._renderReceiverList=value=>list=value;
 await h.c.scanForReceivers();
 assert.equal(list.length,3);assert.equal(list[1].channels.length,1);assert.equal(list[2].channels.length,0);
 assert.equal(list[1].http_base,'https://192.0.2.16:8802');assert.equal(h.c._receiverControlSummary(list[1]).label,'能力待确认');
 assert.equal(h.elements.get('btnRecvScan').disabled,false);
});
test('double click creates one scan and releases busy after failure',async()=>{
 let resolve;const h=harness(url=>url.endsWith('/status')?new Promise(r=>resolve=r):Promise.reject(Error('offline')));
 const first=h.c.scanForReceivers();await h.c.scanForReceivers();assert.equal(h.calls.length,1);
 resolve({status:404,ok:false});await first;
 assert.equal(h.calls.length,3);assert.equal(h.elements.get('btnRecvScan').disabled,false);
 assert.equal(vm.runInContext('_receiverScanBusy',h.c),false);assert.equal(h.timers.size,0);
});
test('rendered model and device strings are escaped; Shure has no MQTT message count',()=>{
 const h=harness(()=>{throw Error('no network expected');});
 h.c._renderReceiverList([{discovered_via:'shure-scp',model:'AD4D <script>',ip:'192.0.2.2',ts:1,
   channels:[],http_base:'https://fixture',server_ip:'fixture'}]);
 const html=h.elements.get('receiverList').innerHTML;
 assert.match(html,/AD4D &lt;script&gt;/);assert.match(html,/能力待确认/);assert.doesNotMatch(html,/消息数:/);
 assert.match(html,/暂无通道数据/);
});

function cardFixture(){return {receiver_id:'rx-card',receiver_ip:'192.0.2.10',channel_number:1,brand:'DATYaudio',model:'RF PRO',freq:641000,_online:true,status:'online'};}
test('page restoration reads current server data without starting another active scan',async()=>{
 const d=cardFixture(),h=harness(url=>ok(url.endsWith('/stats')?{success:true,clients:[{receiver_id:d.receiver_id,receiver_ip:d.receiver_ip,connected_at:'2026-09-17T00:00:00Z',message_count:9}]}:{success:true,devices:[d]}));
 let cards;h.c._renderReceiverList=value=>cards=value;
 await h.c.scanForReceivers({passive:true,quiet:true});
 assert.equal(cards.length,1);assert.equal(cards[0].channels[0].freq,641000);assert.equal(cards[0].message_count,9);
 assert.equal(cards[0].server_ip,'192.0.2.16');assert.equal(h.elements.get('discoveredReceivers').style.display,'');
 assert.equal(h.calls.length,2);assert.ok(h.calls.every(call=>!call.options.method||call.options.method==='GET'));
});
test('SSE full snapshots restore cards and preserve last confirmed cards as offline on empty snapshot',()=>{
 const h=harness(()=>{throw Error('no network');});let cards;h.c._renderReceiverList=value=>cards=value;
 const d=cardFixture();h.c._rebuildReceiversFromDevices([d],{renderCards:true});assert.equal(cards.length,1);
 assert.equal(cards[0].http_base,'https://192.0.2.16:8802');assert.equal(cards[0]._displayOffline,false);
 h.c._rebuildReceiversFromDevices([],{renderCards:true});assert.equal(cards.length,1);assert.equal(cards[0]._displayOffline,true);
 assert.equal(cards[0].channels[0]._online,false);assert.equal(d._online,true,'view must not mutate live state');
 assert.equal(vm.runInContext('_discoveredReceivers.length',h.c),0,'retained view must not inflate planner targets');
 h.c._rebuildReceiversFromDevices([{...d,freq:642000}],{renderCards:true});assert.equal(cards.length,1);assert.equal(cards[0]._displayOffline,false);
 assert.equal(cards[0].channels[0].freq,642000);
});
test('live delta view excludes manual devices and preserves scan metadata',()=>{
 const h=harness(()=>{});let cards;h.c._renderReceiverList=value=>cards=value;const d=cardFixture();
 h.c._rebuildReceiversFromDevices([d],{renderCards:true});
 h.c._rememberReceiverCards([{receiver_id:d.receiver_id,ip:d.receiver_ip,http_base:'https://192.0.2.16:8802',message_count:42,connected_at:'2026-09-17T00:00:00Z',channels:[d]}]);
 h.c.DEVICES=[{...d,_fasheId:'rx_ch1',freq:643000,muted:true},{...d,id:'manual',receiver_id:'manual',receiver_ip:'192.0.2.99'}];
 h.c._refreshReceiverCardsFromLiveState();assert.equal(cards.length,1);assert.equal(cards[0].channels[0].freq,643000);
 assert.equal(cards[0].channels[0].muted,true);assert.equal(cards[0].message_count,42);
});
test('refresh keeps existing cards visible and late HTTP data cannot overwrite a newer SSE update',async()=>{
 let release;const d=cardFixture(),h=harness(url=>url.endsWith('/stats')?new Promise(resolve=>release=()=>resolve(ok({success:true,clients:[]}))):ok({success:true,devices:[d]}));
 let cards;h.c._renderReceiverList=value=>cards=value;h.c._rebuildReceiversFromDevices([d],{renderCards:true});
 const restore=h.c.scanForReceivers({passive:true,quiet:true});assert.equal(h.elements.get('discoveredReceivers').style.display,'');
 h.c._rebuildReceiversFromDevices([{...d,freq:649000}],{renderCards:true});release();await restore;
 assert.equal(cards[0].channels[0].freq,649000);assert.equal(cards[0]._displayOffline,false);
});
test('server change clears old-server display and never merges old cards into new scope',()=>{
 const h=harness(()=>{});let cards;h.c._renderReceiverList=value=>cards=value;h.c._rebuildReceiversFromDevices([cardFixture()],{renderCards:true});
 h.c.DEVICES=[{...cardFixture(),_fasheId:'rx_ch1'}];
 h.c._fasheApiUrl='https://192.0.2.88:8802';h.c._refreshReceiverCardsFromLiveState();assert.equal(cards.length,0);
 assert.equal(h.elements.get('discoveredReceivers').style.display,'none');
});


const shureChannel=(extra={})=>({id:'Shure-ULXD4-192.0.2.107_ch1',receiver_id:'Shure-ULXD4-192.0.2.107',
 receiver_ip:'192.0.2.107',receiver_mac:'00:0E:DD:AD:31:A3',brand:'Shure',model:'ULXD4',channel_number:1,
 _source:'shure-scp',_online:true,status:'online',freq:640000,
 capabilities:{adapter:'shure-scp',read_only:false,mute:true,write_frequency:true},...extra});
const discoveredShure=(d=shureChannel())=>({receiver_id:d.receiver_id,ip:d.receiver_ip,model:d.model,brand:d.brand,
 discovered_via:'shure-scp',settings:{receiver_mac:d.receiver_mac},channels:[d],http_base:'https://192.0.2.16:8802'});

test('real MAC identity unifies discovery settings and live channels in both arrival orders',()=>{
 for(const scanFirst of [true,false]){
  const h=harness(()=>{}, {realIdentity:true}),d=shureChannel();let cards;
  h.c._renderReceiverList=v=>cards=v;
  const scan=()=>h.c._rememberReceiverCards([discoveredShure(d)]);
  const live=()=>h.c._rebuildReceiversFromDevices([d],{renderCards:true});
  if(scanFirst){scan();live();}else{live();scan();}
  assert.equal(cards.length,1);assert.equal(cards[0]._displayOffline,false);
  assert.equal(cards[0].receiver_mac,'00:0e:dd:ad:31:a3');assert.equal(cards[0].channels.length,1);
  assert.equal(h.c._receiverControlSummary(cards[0]).label,'可控');
  h.c._rebuildReceiversFromDevices([],{renderCards:true});assert.equal(cards.length,1);
  assert.equal(h.c._receiverControlSummary(cards[0]).label,'离线');
  live();assert.equal(cards.length,1);assert.equal(h.c._receiverControlSummary(cards[0]).label,'可控');
 }
});

test('passive scan with actual canonical identity counts one Shure and does not start discovery',async()=>{
 const d=shureChannel(),r=discoveredShure(d),h=harness(url=>ok(url.endsWith('/stats')
  ?{success:true,clients:[],external_receivers:[r]}:{success:true,devices:[d]}),{realIdentity:true});
 let cards;h.c._renderReceiverList=v=>cards=v;
 await h.c.scanForReceivers({passive:true,quiet:true});
 assert.equal(cards.length,1);assert.equal(cards[0].channels.length,1);
 assert.match(h.elements.get('recvScanStatusText').textContent,/发现 1 台接收机，1 个通道/);
 assert.equal(h.calls.length,2);assert.ok(h.calls.every(call=>call.options.method!=='POST'));
 assert.equal(vm.runInContext('_discoveredReceivers.length',h.c),1);
});

test('new live MAC/current capability wins over late scan, and missing MAC can be learned without duplicates',()=>{
 const h=harness(()=>{},{realIdentity:true});let cards;h.c._renderReceiverList=v=>cards=v;
 const d=shureChannel(),weak={...d,receiver_mac:undefined};
 h.c._rememberReceiverCards([{...discoveredShure(weak),settings:{},channels:[weak]}]);
 h.c._rebuildReceiversFromDevices([{...d,freq:645000,capabilities:{read_only:true,mute:false,write_frequency:false}}],{renderCards:true});
 h.c._rememberReceiverCards([discoveredShure(d)],{preferCurrentChannels:true,missingOffline:false,source:null});
 assert.equal(cards.length,1);assert.equal(cards[0].channels[0].freq,645000);
 assert.equal(h.c._receiverControlSummary(cards[0]).label,'只读');
 assert.equal(cards[0].receiver_mac,'00:0e:dd:ad:31:a3');
});

test('same IP never joins conflicting MACs, different IDs, different server sources or ambiguous aliases',()=>{
 const h=harness(()=>{},{realIdentity:true}),a=discoveredShure(),b=discoveredShure(shureChannel({receiver_mac:'00:0E:DD:AD:31:B4'}));
 assert.equal(h.c._coalesceReceiverCards([a,b]).length,2);
 assert.equal(h.c._coalesceReceiverCards([a,{...a,http_base:'https://192.0.2.88:8802'}]).length,2);
 const weak={...a,settings:{},channels:[],receiver_mac:undefined};
 assert.equal(h.c._coalesceReceiverCards([weak,a,b]).length,3);
 assert.equal(h.c._coalesceReceiverCards([weak,{...weak,receiver_id:'another-receiver'}]).length,2);
 const conflict={...a,settings:{receiver_mac:'00:0E:DD:AD:31:B4'}};
 assert.equal(h.c._coalesceReceiverCards([a,conflict]).length,2);
 assert.equal(h.c._receiverControlSummary(h.c._normalizeReceiverCard(conflict)).label,'能力待确认');
});

test('card header uses actual capabilities, allows mute-only/frequency-only, and rejects stale/offline/unknown claims',()=>{
 const h=harness(()=>{}, {realIdentity:true});
 const cases=[
  [shureChannel(),'可控','调频 / 输出静音'],
  [shureChannel({capabilities:{mute:true,write_frequency:false}}),'可控','输出静音'],
  [shureChannel({capabilities:{mute:false,write_frequency:true}}),'可控','调频'],
  [shureChannel({capabilities:{read_only:true,mute:true,write_frequency:true}}),'只读','仅支持监测'],
  [shureChannel({capabilities:undefined}),'能力待确认','等待服务器上报'],
  [shureChannel({_online:false,status:'offline'}),'离线','恢复在线'],
  [shureChannel({shure:{stale_fields:['muted','frequency_khz']}}),'状态待更新','状态已过期'],
 ];
 for(const [d,label,detail] of cases){
  h.c._renderReceiverList([discoveredShure(d)]);
  const html=h.elements.get('receiverList').innerHTML;
  assert.ok(html.includes(' · '+label),label);assert.ok(html.includes(detail),detail);
  if(label!=='可控')assert.doesNotMatch(html,/ · 可控/);
 }
 const receiver=discoveredShure();receiver.channels.push(shureChannel({channel_number:2,_online:false,status:'offline'}));
 assert.equal(h.c._receiverControlSummary(receiver).label,'部分通道可控');
});
