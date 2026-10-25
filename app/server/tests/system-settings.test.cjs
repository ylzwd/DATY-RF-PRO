'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const factory=require('../src/app/system-settings.js');
const dbFactory=require('../src/platform/database-client.js');
const copy=v=>JSON.parse(JSON.stringify(v));
function fixture(){
 const records=new Map(),operations=new Map(),memory=new Map(),calls=[];let delay=null,readDelay=null,drop=false;
 const response=(status,body)=>({status,json:async()=>({protocol:'daty-business-db-v1',epoch:'epoch1',...body})});
 const request=async(url,init={})=>{
  const path=new URL(url).pathname;calls.push([path,init.method||'GET']);
  if(path==='/api/database/status')return response(200,{success:true});
  if(path.startsWith('/api/database/resources/')){if(readDelay){const wait=readDelay;readDelay=null;await wait;}const id=decodeURIComponent(path.split('/').at(-1));return records.has(id)?response(200,{success:true,resource:copy(records.get(id))}):response(404,{success:false});}
  if(path.startsWith('/api/database/operations/')){const op=operations.get(path.split('/').at(-1));return op?response(200,{success:true,operation:{...op,status:'committed'}}):response(404,{success:false});}
  if(path==='/api/database/write'){
   const body=JSON.parse(init.body),previous=records.get(body.id);
   if(body.expected_revision!==(previous?.revision||0))return response(409,{success:false,code:'REVISION_CONFLICT'});
   if(delay){const wait=delay;delay=null;await wait;}
   const resource={kind:body.kind,id:body.id,revision:body.expected_revision+1,deleted:false,value:body.value};records.set(body.id,resource);
   const receipt={success:true,operation_id:body.operation_id,resource};operations.set(body.operation_id,receipt);
   if(drop){drop=false;throw Error('lost receipt after actual commit');}
   return response(200,receipt);
  }throw Error(path);
 };
 const client=()=>dbFactory.create({storage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)},readScope:()=>({baseUrl:'https://127.0.0.1:8080',accessRevision:1,principalId:'fixture'}),request,schedule:setTimeout,cancel:clearTimeout,newOperationId:()=>require('node:crypto').randomUUID()});
 return {records,operations,calls,memory,request,make:onChange=>factory.create({client:client(),onChange}),block(){let release;delay=new Promise(r=>release=r);return release;},blockRead(){let release;readDelay=new Promise(r=>release=r);return release;},drop(){drop=true;}};
}
const writes=f=>f.calls.filter(c=>c[1]==='POST').length;
test('editing during periodic database read is queued, not rejected as busy',async()=>{const f=fixture(),s=f.make();await s.initialize();const release=f.blockRead(),refresh=s.refresh();const save=s.submit('alert_thresholds',{...factory.defaults.alert_thresholds,rfWeakDbm:-72});await new Promise(r=>setImmediate(r));assert.equal(s.dirty,true);release();await Promise.all([refresh,save]);assert.equal(s.dirty,false);assert.equal(f.records.get('alert_thresholds').value.rfWeakDbm,-72);});
test('all defaults commit once; a fresh client uses database values without another write',async()=>{const f=fixture(),s=f.make();assert.equal(await s.initialize(),true);assert.equal(writes(f),4);assert.equal(f.memory.size,0);await s.submit('alert_sound',{enabled:true});const fresh=f.make();await fresh.initialize();assert.equal(fresh.snapshot('alert_sound').value.enabled,true);assert.equal(writes(f),5);});
test('first edit is submitted immediately; newest edit waits for exact earlier receipt',async()=>{const f=fixture(),s=f.make();await s.initialize();const release=f.block();const a=s.submit('alert_thresholds',{...factory.defaults.alert_thresholds,rfWeakDbm:-85});const b=s.submit('alert_thresholds',{...factory.defaults.alert_thresholds,rfWeakDbm:-70});await new Promise(r=>setImmediate(r));assert.equal(writes(f),5);assert.equal(s.dirty,true);assert.equal(s.snapshot('alert_thresholds').value.rfWeakDbm,-90);release();await Promise.all([a,b]);assert.equal(s.dirty,false);assert.equal(f.records.get('alert_thresholds').value.rfWeakDbm,-70);assert.equal(writes(f),6);});
test('lost receipt is queried before retry; no duplicate transaction until explicit retry',async()=>{const f=fixture(),s=f.make();await s.initialize();f.drop();assert.equal(await s.submit('alert_sound',{enabled:true}),false);assert.equal(s.snapshot('alert_sound').status,'unknown');await s.refresh();assert.equal(writes(f),5);assert.equal(s.dirty,true);await s.retry();assert.equal(s.dirty,false);assert.equal(f.records.get('alert_sound').value.enabled,true);assert.equal(f.memory.size,0);assert.ok(f.calls.some(c=>c[0].startsWith('/api/database/operations/')));});
test('initial commit response lost: resolve operation and load, never reseed over actual setting',async()=>{const f=fixture(),s=f.make();f.drop();assert.equal(await s.initialize(),false);assert.equal(s.ready,false);assert.equal(s.dirty,true);assert.equal(await s.retry(),true);assert.equal(writes(f),4);assert.equal(s.ready,true);});
test('concurrent update is not overwritten; conflict remains visible until explicit retry',async()=>{const f=fixture(),s=f.make();await s.initialize();const r=f.records.get('network_connection');r.revision++;r.value={...r.value,heartbeatSeconds:60};await s.submit('network_connection',{...r.value,heartbeatSeconds:15});assert.equal(s.snapshot('network_connection').status,'conflict');assert.equal(f.records.get('network_connection').value.heartbeatSeconds,60);await s.refresh();assert.equal(s.dirty,true);await s.retry();assert.equal(f.records.get('network_connection').value.heartbeatSeconds,15);assert.equal(s.dirty,false);});
test('scope invalidation prevents stale acknowledgement applying to the new connection',async()=>{const f=fixture(),events=[],s=f.make((id,state)=>events.push([id,state.status]));await s.initialize();const release=f.block();const task=s.submit('alert_sound',{enabled:true});await new Promise(r=>setImmediate(r));s.invalidate();events.length=0;release();await task;assert.equal(s.ready,false);assert.equal(events.length,0);});
test('production mount saves page input without touching localStorage or host files',async()=>{
 const f=fixture(),elements=new Map();
 for(const id of ['rfThreshInput','battThreshInput','battBarsThreshInput','afThreshInput','soundAlertEnabled','autoFrequencyEnabled','systemLocalIp','systemHeartbeat','systemReconnect','systemShureExclusive','systemPcom1','systemSettingsSaveState'])elements.set(id,{value:'',checked:false,type:['systemShureExclusive','systemPcom1'].includes(id)?'checkbox':'text',addEventListener(name,fn){this[name]=fn;}});
 const events={},host={document:{getElementById:id=>elements.get(id)||null},DatyDatabaseClientFactory:dbFactory,DatyDatabaseConnection:{snapshot:()=>({origin:'https://127.0.0.1:8080',revision:1,source:{id:'fixture'}}),request:f.request,subscribe(){}},setTimeout,clearTimeout,addEventListener:(n,fn)=>events[n]=fn,
  setAlertThresholdSettings:v=>{for(const [id,key]of [['rfThreshInput','rfWeakDbm'],['battThreshInput','batteryLowPercent'],['battBarsThreshInput','batteryLowBars'],['afThreshInput','afOverloadDbfs']])elements.get(id).value=String(v[key]);},DatyAlertSound:{setEnabled:v=>elements.get('soundAlertEnabled').checked=v},DatyAutoFrequency:{setEnabled:v=>elements.get('autoFrequencyEnabled').checked=v}};
 Object.defineProperty(host,'localStorage',{get(){throw Error('localStorage forbidden');}});Object.defineProperty(host,'DatyPlatform',{get(){throw Error('host storage forbidden');}});
 const s=factory.mount(host);for(let i=0;i<30&&!s.ready;i++)await new Promise(r=>setImmediate(r));assert.equal(s.ready,true);
 elements.get('rfThreshInput').value='-75';elements.get('rfThreshInput').input();assert.equal(s.dirty,true);let warned=false;events.beforeunload({preventDefault(){warned=true;}});assert.equal(warned,true);
 for(let i=0;i<30&&s.dirty;i++)await new Promise(r=>setImmediate(r));assert.equal(f.records.get('alert_thresholds').value.rfWeakDbm,-75);
 elements.get('systemLocalIp').value='192.0.2.5/24';elements.get('systemLocalIp').input();for(let i=0;i<30&&s.dirty;i++)await new Promise(r=>setImmediate(r));assert.equal(f.records.get('network_connection').value.localIp,'192.0.2.5/24');assert.equal(s.dirty,false);
});
