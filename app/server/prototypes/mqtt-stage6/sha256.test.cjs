'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Sha256}=require('./sha256.cjs');
test('copied running digest does not finalize or change the original stream',()=>{
 const left=crypto.randomBytes(77),right=crypto.randomBytes(222),hash=new Sha256().update(left);
 assert.equal(hash.copy().digest(),crypto.createHash('sha256').update(left).digest('hex'));
 hash.update(right);assert.equal(hash.digest(),crypto.createHash('sha256').update(left).update(right).digest('hex'));
});
for(const size of [0,1,55,56,57,63,64,65,119,120,127,128,129,131071,131072,131073,1000000]){
 test('SHA-256 native comparison, bytes='+size,()=>{
  const raw=size===1000000?Buffer.alloc(size,'a'):crypto.randomBytes(size),expected=crypto.createHash('sha256').update(raw).digest('hex');
  for(const chunk of [1,63,64,4093,131072]){
   const hash=new Sha256();for(let p=0;p<size;p+=chunk)hash.update(raw.subarray(p,p+chunk));
   assert.equal(hash.digest(),expected);assert.equal(hash.digest(),expected);assert.throws(()=>hash.update(new Uint8Array()),/FINAL/);
  }
 });
}
