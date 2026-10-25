'use strict';
// Test evidence only. One awaited writer per destination; never unlink the
// previous complete snapshot to work around a Windows sharing violation.
const fs=require('node:fs/promises');
const {performance}=require('node:perf_hooks');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function writeProgress(file,value,{retryMs=2000,io=fs,now=()=>performance.now(),sleep=wait}={}){
 if(!Number.isFinite(retryMs)||retryMs<0||retryMs>2000)throw new RangeError('Invalid progress retry budget');
 const temporary=file.replace(/\.json$/,'.pending');
 if(temporary===file)throw new Error('Progress destination must end in .json');
 await io.writeFile(temporary,JSON.stringify(value),'utf8');
 const began=now();let retries=0;
 for(;;){
  try{
   await io.rename(temporary,file);
   return {replace_retries:retries,replace_wait_ms:retries?now()-began:0};
  }catch(error){
   const remaining=retryMs-(now()-began);
   if(!['EPERM','EACCES','EBUSY'].includes(error.code)||remaining<=0){
    error.message=`Progress snapshot replacement failed (${retries} retries): ${error.message}`;
    throw error;
   }
   retries++;await sleep(Math.min(25*Math.min(retries,8),remaining));
  }
 }
}
module.exports={writeProgress};
