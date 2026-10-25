'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const {EventEmitter} = require('node:events'), fs = require('node:fs');
const {ReadonlyDeviceStream, TOPIC, SCHEMA} = require('./readonly-client.cjs');
const {harness, handlers, view, clone} = require('./frontend-harness.cjs');
const STREAM = 'view-' + 'a'.repeat(32), BOOT = 'b'.repeat(32);
const event = (seq=1, kind='device_list', devices=[]) => ({schema: SCHEMA, server_id:'stage2-server',
  boot_id:BOOT, stream_id:STREAM, seq, kind, payload:kind === 'heartbeat' ? null : {devices}});

function fixture(callbacks) {
  let now=0, tick, retry, client, options;
  const calls={snapshots:[],deltas:[],offline:[],online:0,ends:0,connections:0};
  const stream = new ReadonlyDeviceStream({url:'wss://127.0.0.1:19999/mqtt-readonly', now:()=>now,
    timers:{setInterval(fn){tick=fn;return fn;},clearInterval(){tick=null;},
      setTimeout(fn){retry=fn;return fn;},clearTimeout(){retry=null;}},
    connect(url, opts){options=opts;calls.connections++;client=new EventEmitter();
      client.subscribe=(topic, opts, done)=>done(null,[{topic,qos:1}]);
      client.end=()=>{calls.ends++;client.emit('close');};return client;},
    handlers:callbacks || {snapshot:d=>calls.snapshots.push(d),delta:d=>calls.deltas.push(d),
      offline:r=>calls.offline.push(r),online:()=>calls.online++}});
  const api={stream,calls,get client(){return client;},get options(){return options;},
    send(e,packet={}){client.emit('message',TOPIC,Buffer.from(JSON.stringify(e)),packet);},
    connect(id=STREAM){client.emit('connect',{sessionPresent:false,properties:{assignedClientIdentifier:id}});},
    advance(ms){now+=ms;tick?.();},retry(){const fn=retry;retry=null;fn?.();}};
  stream.start();api.connect();return api;
}

test('first snapshot, sparse delta and heartbeat delivered without changing payload',()=>{
  const f=fixture(), devices=[{id:'rx-ch1',freq:640001,af_dbfs:0,batt:null}];
  f.send(event(1,'device_list',devices));f.send(event(2,'device_update',[{id:'rx-ch1',muted:true}]));
  f.send(event(3,'heartbeat'));
  assert.deepEqual(f.calls.snapshots,[devices]);assert.equal(f.calls.deltas.length,1);
  assert.equal(f.calls.online,1);assert.equal(f.calls.offline.length,0);
  assert.equal(f.options.reconnectPeriod,0);assert.equal(f.options.properties.sessionExpiryInterval,0);
  assert.equal(f.options.username,undefined);assert.equal(typeof f.stream.publish,'undefined');f.stream.stop();
});

for (const [name, mutate] of [
  ['sequence gap', e=>({...e,seq:3})], ['wrong boot',e=>({...e,boot_id:'c'.repeat(32)})],
  ['wrong stream',e=>({...e,stream_id:'view-'+'c'.repeat(32)})],
  ['wrong server',e=>({...e,server_id:'other'})], ['unknown schema',e=>({...e,schema:'future'})],
  ['noninteger sequence',e=>({...e,seq:2.5})],['missing devices',e=>({...e,payload:{}})],
  ['command is not telemetry',e=>({...e,kind:'command_update'})]]) {
  test(name+' marks offline and requires a new full snapshot',()=>{
    const f=fixture();f.send(event());const stale=f.client;
    f.send(mutate(event(2,'device_update')));
    assert.equal(f.calls.offline.length,1);assert.equal(f.calls.deltas.length,0);
    f.retry();f.connect();stale.emit('message',TOPIC,Buffer.from(JSON.stringify(event(2,'device_update'))));
    assert.equal(f.calls.deltas.length,0);
    f.send(event(1,'device_list',[{id:'fresh'}]));assert.equal(f.calls.snapshots.length,2);f.stream.stop();
  });
}

test('initial delta, initial heartbeat and retained snapshot are rejected',()=>{
  for(const [kind,retained] of [['device_update',false],['heartbeat',false],['device_list',true]]) {
    const f=fixture();f.send(event(1,kind),{retain:retained});assert.equal(f.calls.offline.length,1);
    assert.equal(f.calls.snapshots.length,0);f.stream.stop();
  }
});
test('QoS duplicates do not reapply state or conceal a stopped source',()=>{
  const f=fixture();f.send(event());f.advance(4000);f.send(event());
  assert.equal(f.calls.snapshots.length,1);f.advance(1100);assert.equal(f.calls.offline[0],'source-idle');f.stream.stop();
});
test('network loss invalidates stale callbacks; stop cancels pending reconnect',()=>{
  const f=fixture();f.send(event());f.client.emit('close');assert.equal(f.calls.offline.length,1);
  f.stream.stop();f.retry();assert.equal(f.calls.connections,1);
});
test('host stop during snapshot cannot subsequently mark the connection online',()=>{
  let f,online=0;
  f=fixture({snapshot(){f.stream.stop();},delta(){},offline(){},online(){online++;}});
  f.send(event());assert.equal(online,0);f.retry();assert.equal(f.calls.connections,1);
});
test('invalid session and rejected subscription cannot mark online',()=>{
  const f=fixture();f.connect('client-selected');assert.equal(f.calls.offline.length,1);assert.equal(f.calls.online,0);f.stream.stop();
  const g=fixture();g.client.subscribe=(topic,opts,done)=>done(null,[{topic,qos:128}]);g.connect();
  assert.equal(g.calls.offline.length,1);assert.equal(g.calls.online,0);g.stream.stop();
});
test('native URL boundary rejects insecure, credentials and query endpoints',()=>{
  for(const url of ['ws://127.0.0.1/mqtt-readonly','wss://user:secret@localhost/mqtt-readonly',
    'wss://localhost/mqtt-readonly?token=1','wss://localhost/other']) {
    assert.throws(()=>new ReadonlyDeviceStream({url}));
  }
});

const suffix={rxA:102,rxB:103,unknown:104,newRX:105,managed:106};
const raw=(rx,group,ch)=>({id:rx+'_ch'+ch,receiver_id:rx,receiver_mac:'02:00:00:00:00:'+String(suffix[rx]-100).padStart(2,'0'),
  receiver_ip:'192.169.0.'+suffix[rx],channel:ch,channel_number:ch,
  group_number:group,group_source:group===null?null:'server-fifo-v1',group:999,
  brand:'DATYaudio',model:'RF PRO',freq:640000+ch*250,af_dbfs:0,batt:0,rf:-40,_online:true});

test('actual production handlers: group numeric sort, sparse null/zero, pagination, empty/removal, ownership',()=>{
  const a=harness(),b=harness(), f=fixture(handlers(b));
  a.DEVICES.push({id:900,name:'manual',channel_number:1});b.DEVICES.push(clone(a.DEVICES[0]));
  a.DEVICES.push({...a._fasheNormalizeDevice(raw('managed',null,1)),_serverManaged:true});
  b.DEVICES.push(clone(a.DEVICES[1]));
  const devices=[];for(const [rx,group] of [['rxA',10],['rxB',2],['unknown',null]])
    for(let ch=50;ch>0;ch--)devices.push(raw(rx,group,ch));
  let seq=1;
  const apply=(kind,ds)=>{a[kind==='device_list'?'_fasheHandleDeviceList':'_fasheHandleDeviceUpdate'](clone(ds));
    f.send(event(seq++,kind,clone(ds)));assert.deepEqual(view(b),view(a));};
  apply('device_list',devices);
  assert.deepEqual(view(b).sorted.slice(0,3).map(d=>[d.group_number,d.channel_number]),[[2,1],[2,2],[2,3]]);
  assert.equal(view(b).table[2].devices[10].group_number,10);
  apply('device_update',[{id:'rxA_ch9',af_dbfs:null,batt:0},{id:'rxA_ch10',af_dbfs:0},
    {...raw('newRX',1,3),name:'new delta'}]);
  let d=b.DEVICES.find(d=>d._fasheId==='rxA_ch9');assert.equal(d.afDbfs,null);assert.equal(d.batt,0);
  apply('device_update',[{id:'rxA_ch9',muted:true}]);assert.equal(d.afDbfs,null);
  apply('device_update',[{id:'rxB_ch1',group_number:11},{id:'rxA_ch1',group_number:null}]);
  a._fasheMarkDevicesOffline();f.client.emit('close');assert.deepEqual(view(b),view(a));
  assert.equal(b.DEVICES.find(d=>d._serverManaged)._online,true);
  f.retry();f.connect();seq=1;apply('device_list',[raw('rxA',10,9)]);apply('device_list',[]);
  assert.equal(b.DEVICES.length,2);f.stream.stop();
});

for(const [name,source] of [['isolated actual TLS/SSE',process.env.MQTT_STAGE2_COMPARISON],
  ['captured live SSE shadow replay',process.env.MQTT_STAGE2_LIVE_COMPARISON]]) {
test(name+' vs Broker MQTT transcript: every normalized state and page match', {skip:!source},()=>{
  const transcript=JSON.parse(fs.readFileSync(source,'utf8'));
  const a=harness(),b=harness(),f=fixture(handlers(b));let stream;
  for(const row of transcript) {
    if(row.offline){a._fasheMarkDevicesOffline();f.client.emit('close');assert.deepEqual(view(b),view(a));f.retry();stream=null;continue;}
    if(stream!==row.mqtt.stream_id){f.connect(row.mqtt.stream_id);stream=row.mqtt.stream_id;}
    if(row.sse) a[row.sse.kind==='device_list'?'_fasheHandleDeviceList':'_fasheHandleDeviceUpdate'](clone(row.sse.payload.devices));
    f.send(row.mqtt);assert.deepEqual(view(b),view(a),row.label);
  }
  if(name==='isolated actual TLS/SSE') assert.equal(b.DEVICES.length,0);
  else assert.equal(b.DEVICES.length,100);
  f.stream.stop();
});
}
