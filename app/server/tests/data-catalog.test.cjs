'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createReader,describe}=require('../src/modules/data-catalog.js');
const {route}=require('../prototypes/mqtt-stage4/database-port.cjs');
function fixture(){
 let context={origin:'https://fixture.invalid',revision:1,sourceId:'peer',epoch:'epoch',projectId:'default',projectName:'Default'},calls=[];
 let item={kind:'scans',id:'safe',revision:1,digest:'abc',saved_at_ms:100,project_id:'default',summary:{name:'<img onerror=alert(1)>',point_count:2,source_kind:'imported_csv',min_khz:640000,max_khz:641000}};
 let response={success:true,protocol:'daty-business-db-v1',epoch:'epoch',catalog_protocol:'daty-business-catalog-v1',kind:'scans',project_id:'default',as_of:3,items:[item],next_cursor:null},hold;
 const reader=createReader({context:()=>context,request:async(url,options)=>{calls.push({url,options});if(hold)await hold;return {ok:true,json:async()=>response};}});
 return {reader,calls,item,context,set response(v){response=v;},get response(){return response;},set hold(v){hold=v;}};
}
test('catalog routes through MQTT GET with typed bounded page',()=>{
 assert.deepEqual(route(new URL('https://fixture.invalid/api/database/catalog?kind=scans&limit=20&project_id=default'),'GET'),{method:'database.catalog',body:{kind:'scans',limit:20,project_id:'default'}});
 assert.throws(()=>route(new URL('https://fixture.invalid/api/database/catalog'),'POST'));
});
test('project required and only GET paths are emitted',async()=>{
 const f=fixture(),page=await f.reader.list('scans');assert.equal(page.items.length,1);
 assert.match(f.calls[0].url,/project_id=default/);assert.equal(f.calls[0].options.method,'GET');
 f.response={...f.response,kind:'settings',project_id:null,items:[]};await f.reader.list('settings');assert.doesNotMatch(f.calls[1].url,/project_id/);
});
test('server or project changes while waiting reject late reply',async()=>{
 for(const field of ['origin','projectId','epoch','sourceId','revision']){
  const f=fixture();let release;f.hold=new Promise(r=>release=r);const pending=f.reader.list('scans');f.context[field]='changed';release();await assert.rejects(pending,/变化/);
 }
});
test('duplicate IDs, invalid version, epoch and project cannot be rendered',async()=>{
 for(const mutate of [f=>f.response.items.push(f.item),f=>f.item.revision=0,f=>f.response.epoch='wrong',f=>f.response.project_id='other']){
  const f=fixture();mutate(f);await assert.rejects(f.reader.list('scans'));
 }
});
test('detail verifies identity and exact listed revision before export',async()=>{
 const f=fixture(),page=await f.reader.list('scans');f.response={success:true,protocol:'daty-business-db-v1',epoch:'epoch',resource:{kind:'scans',id:'safe',revision:1,deleted:false,value:{points:[1,2]}}};
 const saved=await f.reader.detail(page,f.item);assert.deepEqual(saved.resource.value.points,[1,2]);assert.equal(saved.digest,'abc');
 for(const patch of [{revision:2},{deleted:true},{id:'different'}]){const old={...f.response.resource};Object.assign(f.response.resource,patch);await assert.rejects(f.reader.detail(page,f.item));f.response.resource=old;}
 f.context.projectId='other';await assert.rejects(f.reader.detail(page,f.item),/变化/);
});
test('descriptions preserve zero and identify simulation separately',()=>{
 assert.match(describe({kind:'settings',id:'alert_thresholds',summary:{rf_weak_dbm:-90,battery_low_percent:20,af_overload_dbfs:0}}).info,/AF 0 dBFS/);
 const f=fixture();f.item.summary.source_kind='simulation';assert.match(describe(f.item).info,/模拟资料/);assert.equal(describe(f.item).title,'<img onerror=alert(1)>');
});
