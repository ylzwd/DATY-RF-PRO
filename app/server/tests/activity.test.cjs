'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createReader,title,outcome}=require('../src/modules/activity.js'),{route}=require('../prototypes/mqtt-stage4/database-port.cjs');
function fixture(){let state={origin:'https://fixture.invalid',revision:1,source:{id:'peer'},status:{epoch:'e'}},response={success:true,epoch:'e',activity_protocol:'daty-activity-v1',source:'timeline',as_of:1,next_cursor:null,items:[{source:'timeline',id:1,time_ms:1000,kind:'command.unknown',target:'rx_ch1'}]},hold;const calls=[];
const reader=createReader({snapshot:()=>state,request:async(url,init)=>{calls.push({url,init});if(hold)await hold;return {ok:true,json:async()=>response};}});return {reader,state,calls,get response(){return response;},set response(v){response=v;},set hold(v){hold=v;}};}
test('only acknowledged stage implies execution confirmation',()=>{
 assert.equal(outcome({outcome:'acknowledged'}),'设备已确认');
 for(const s of ['published','unknown','timeout','reviewed','accepted','observed','committed'])assert.notEqual(outcome({outcome:s}),'设备已确认');
 assert.equal(title({kind:'channel.changed'}),'通道状态变化');assert.equal(title({kind:'settings'}),'系统设置');
});
test('activity routes accept only bounded typed GETs',()=>{
 assert.deepEqual(route(new URL('https://fixture.invalid/api/database/activity?source=timeline&from_ms=1000&limit=20'),'GET'),{method:'database.activity.list',body:{source:'timeline',from_ms:1000,limit:20}});
 assert.deepEqual(route(new URL('https://fixture.invalid/api/database/activity/operations/12'),'GET'),{method:'database.activity.get',body:{source:'operations',id:12}});
 assert.throws(()=>route(new URL('https://fixture.invalid/api/database/activity'),'POST'));
 assert.throws(()=>route(new URL('https://fixture.invalid/api/database/activity?source=timeline&from_ms=-1'),'GET'));
});
test('loaded pages retain source and filter snapshot; no write emitted',async()=>{const f=fixture(),filters={source:'timeline',category:'commands'},page=await f.reader.list(filters);filters.category='all';assert.equal(page.filters.category,'commands');assert.equal(f.calls[0].init.method,'GET');});
test('late old-server reply, duplicate IDs, wrong source and epoch fail closed',async()=>{
 const f=fixture();let release;f.hold=new Promise(r=>release=r);const pending=f.reader.list({source:'timeline'});f.state.revision++;release();await assert.rejects(pending,/变化/);
 for(const mutate of [f=>f.response.items.push(f.response.items[0]),f=>f.response.epoch='other',f=>f.response.source='operations']){const g=fixture();mutate(g);await assert.rejects(g.reader.list({source:'timeline'}));}
});
test('detail must match the selected source and record id',async()=>{const f=fixture(),page=await f.reader.list({source:'timeline'});f.response={success:true,epoch:'e',activity_protocol:'daty-activity-v1',source:'timeline',id:1,record:{details:{actual:0,expected:0}}};assert.equal((await f.reader.detail(page,page.items[0])).record.details.actual,0);f.response.id=2;await assert.rejects(f.reader.detail(page,page.items[0]));});
