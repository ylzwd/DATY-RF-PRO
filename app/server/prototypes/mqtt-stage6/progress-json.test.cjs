'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {writeProgress}=require('./progress-json.cjs');

test('temporary Windows sharing failures retry the same complete snapshot',async()=>{
 let clock=0,writes=0,calls=0;const sleeps=[];
 const io={writeFile:async(file,value)=>{writes++;assert.equal(JSON.parse(value).sequence,2);},
  rename:async()=>{calls++;if(calls<=3)throw Object.assign(new Error('locked'),{code:['EPERM','EACCES','EBUSY'][calls-1]});}};
 const result=await writeProgress('status.json',{sequence:2},{io,now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;}});
 assert.equal(writes,1);assert.equal(calls,4);assert.equal(result.replace_retries,3);assert.equal(result.replace_wait_ms,150);
 assert.deepEqual(sleeps,[25,50,75]);
});
test('persistent sharing failure terminates at the retry deadline',async()=>{
 let clock=0,calls=0;
 await assert.rejects(writeProgress('status.json',{sequence:2},{retryMs:100,now:()=>clock,sleep:async ms=>{clock+=ms;},
  io:{writeFile:async()=>{},rename:async()=>{calls++;throw Object.assign(new Error('locked'),{code:'EPERM'});}}}),{code:'EPERM'});
 assert.equal(clock,100);assert.equal(calls,4);
});
test('disk or path errors are not retried or hidden',async()=>{
 for(const code of ['ENOSPC','ENOENT','EIO']){
  let calls=0;
  await assert.rejects(writeProgress('status.json',{}, {io:{writeFile:async()=>{},rename:async()=>{calls++;throw Object.assign(new Error(code),{code});}},
   sleep:async()=>assert.fail('Unexpected retry')}),{code});
  assert.equal(calls,1);
 }
});
test('failed temporary write never attempts to replace the valid snapshot',async()=>{
 await assert.rejects(writeProgress('status.json',{}, {io:{writeFile:async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});},
  rename:async()=>assert.fail('Cannot publish incomplete progress')}}),{code:'ENOSPC'});
});
test('invalid retry budget and destination cannot publish evidence',async()=>{
 for(const retryMs of [-1,Infinity,2001])await assert.rejects(writeProgress('status.json',{}, {retryMs}),RangeError);
 await assert.rejects(writeProgress('status.txt',{}),/must end/);
});
