const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/modules/init.js'),'utf8');
const managerSource=source.slice(source.indexOf('const DEVICE_SERVICE_ARCHITECTURE ='),source.indexOf('// 创建全局服务管理器实例'));
const fixture=n=>Array.from({length:n},(_,i)=>({id:`receiver-a_ch${i+1}`,receiver_id:'receiver-a',ip:'127.0.0.2',
  channel_number:i+1,brand:'DATYaudio',model:'RF PRO',group:7,_online:true,status:'online',muted:false}));
function harness(){
  const timers=new Map(),requests=[];let next=1,now=10000;
  const c=vm.createContext({console:{log(){},warn(){},error(){}},Date,AbortController,Promise,setTimeout,clearTimeout,
    performance:{now:()=>now},DEVICES:[],_fasheApiUrl:'http://isolated',notify(){},renderDevTable(){},renderMonitorGrid(){},
    document:{getElementById:()=>({value:'http://isolated'})},
    setInterval(fn){const id=next++;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id),
    fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({devices:fixture(50)})};}});
  vm.runInContext(managerSource+'\nglobalThis.manager = new DeviceServiceManager();',c);
  return {c,m:c.manager,timers,requests,advance:ms=>now+=ms};
}
test('50CH share one heartbeat timer and one full snapshot per tick, not 50 downloads',async()=>{
  const {m,timers,requests,advance}=harness();
  await m.scanNetworkDevices();assert.equal(m.connectedDevices.size,50);
  assert.equal(timers.size,1,'per-CH timers flood the shared HTTP connection pool');
  advance(1100);await Promise.all([...timers.values()].map(fn=>fn()));
  assert.equal(requests.length,2);m.disconnectAll();assert.equal(timers.size,0);
});
test('fresh SSE snapshot is reused without background HTTP, preserving receiver + CH',async()=>{
  const {c,m,requests}=harness();let data=fixture(50);data.push({...data[0],id:'receiver-b_ch1',receiver_id:'receiver-b',ip:'127.0.0.3'});
  c.getFasheServiceSnapshot=()=>data;
  await m.scanNetworkDevices();assert.equal(requests.length,0);assert.equal(m.connectedDevices.size,51);
  assert.equal(m.connectedDevices.get('receiver-b_ch1').channel_number,1);
  data=data.filter(d=>d.id!=='receiver-a_ch1');await m.scanNetworkDevices();
  assert.equal(m.connectedDevices.has('receiver-a_ch1'),false);assert.equal(m.connectedDevices.has('receiver-b_ch1'),true);
  data=[];await m.scanNetworkDevices();assert.equal(m.connectedDevices.size,0);m.disconnectAll();
});
test('overlapping discovery and heartbeat share one pending HTTP request',async()=>{
  const {c,m}=harness();let calls=0,release;
  c.fetch=()=>{calls++;return new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>({devices:fixture(50)})}));};
  const first=m.scanNetworkDevices();const second=m.scanNetworkDevices();
  assert.equal(calls,1);release();await Promise.all([first,second]);assert.equal(m.connectedDevices.size,50);m.disconnectAll();
});
test('hung snapshot body times out, aborts and allows a later request',async()=>{
  const {c,m,advance}=harness();m.snapshotTimeoutMs=25;let signal;
  c.fetch=async(_url,options)=>{signal=options.signal;return {ok:true,json:()=>new Promise(()=>{})};};
  await m.scanNetworkDevices();assert.equal(signal.aborted,true);assert.equal(m.connectedDevices.size,0);
  advance(1500);c.fetch=async()=>({ok:true,json:async()=>({devices:fixture(2)})});
  await m.scanNetworkDevices();assert.equal(m.connectedDevices.size,2);m.disconnectAll();
});
test('disconnect cancels pending work and late responses cannot reconnect devices',async()=>{
  const {c,m}=harness();let release,signal;
  c.fetch=(_url,options)=>{signal=options.signal;return new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>({devices:fixture(2)})}));};
  const pending=m.scanNetworkDevices();m.disconnectAll();release();await pending;
  assert.equal(signal.aborted,true);assert.equal(m.connectedDevices.size,0);
});

test('SSE reuse requires an open connection and fresh receipt, never browser/server clock difference',()=>{
  let now=100;
  const c=vm.createContext({performance:{now:()=>now},document:{addEventListener(){}},
    DEVICES:[{id:1,_fasheId:'receiver-a_ch1',muted:false},{id:2,name:'manual'},
      {id:3,_fasheId:'other-server_ch1',_serverManaged:true}]});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules/fashe.js'),'utf8'),c);
  assert.equal(c.getFasheServiceSnapshot(),null);
  vm.runInContext('_fasheConnected=true; _fasheSSE={readyState:1}; _fasheLastReceivedAt=100;',c);
  const data=c.getFasheServiceSnapshot();assert.equal(data.length,1);assert.equal(data[0].id,'receiver-a_ch1');
  assert.equal(c.DEVICES[0].id,1,'reading the snapshot must not change page IDs');
  now=10200;assert.equal(c.getFasheServiceSnapshot(),null);
  now=200;vm.runInContext('_fasheSSE.readyState=0;',c);assert.equal(c.getFasheServiceSnapshot(),null);
  vm.runInContext('_fasheSSE.readyState=1; _fasheConnected=false;',c);assert.equal(c.getFasheServiceSnapshot(),null);
});

test('empty SSE snapshot clears service connections but does not delete manual UI devices',async()=>{
  const {c,m}=harness();c.DEVICES.push({id:'manual',muted:false});
  c.getFasheServiceSnapshot=()=>fixture(2);await m.scanNetworkDevices();
  c.getFasheServiceSnapshot=()=>[];await m.scanNetworkDevices();
  assert.equal(m.connectedDevices.size,0);assert.equal(m.discoveredDevices.size,0);
  assert.equal(c.DEVICES.length,1);assert.equal(c.DEVICES[0].id,'manual');m.disconnectAll();
});
