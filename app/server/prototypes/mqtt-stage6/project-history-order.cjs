'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),{createRequire}=Module;
const [source,candidate]=process.argv.slice(2),originalRequire=createRequire(path.resolve(source,'tests/unified-project-sync.test.cjs'));
const prefix=fs.readFileSync(path.join(source,'tests/unified-project-sync.test.cjs'),'utf8').split("test('initial aggregate load")[0];
function harness(root){
 const mod=new Module(path.resolve(source,'tests/m6-order-harness.cjs'),module);
 mod.require=name=>name==='../src/platform/unified-project-sync.js'?require(path.resolve(root,'src/platform/unified-project-sync.js')):originalRequire(name);
 mod._compile(prefix+'\nmodule.exports={setup,record,response,clone};',mod.id);
 const {setup,record,response,clone}=mod.exports,h=setup();h.seed();
 h.hook=(url,init)=>{
  const u=new URL(url);if(u.pathname!=='/api/database/resources'||u.searchParams.get('kind')!=='planning_records')return;
  return Promise.resolve(h.handle(url,init)).then(async r=>{const body=await r.json();body.resources.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);return response(body,r.status);});
 };
 return {h,record,clone};
}
async function replay(root){
 const {h,record,clone}=harness(root);await h.sync.load();const statuses=[];
 for(const id of ['z-record','a-record','m-record']){
  const desired=clone(h.sync.snapshot().project);desired.data.planningHistory.push(record(id));
  desired.data.currentPlanningRecordId=id;desired.devices=clone(record(id).devices);
  const result=await h.sync.save(desired);statuses.push({status:result.status,code:result.code});if(result.status!=='saved')break;
 }
 return {h,statuses};
}
(async()=>{
 const original=await replay(source),fixed=await replay(candidate);
 assert.equal(original.statuses.at(-1).code,'PROJECT_REVISION_CONFLICT','Must reproduce the old ordering bug');
 assert.deepEqual(fixed.statuses.map(x=>x.status),['saved','saved','saved']);
 // A real edit with an unchanged metadata revision must remain a conflict.
 fixed.h.get('planning_records','z-record').value.future.retain=false;
 const result=await fixed.h.sync.save(fixed.h.sync.snapshot().project);
 assert.equal(result.status,'conflict');assert.equal(result.code,'PROJECT_REVISION_CONFLICT');
 console.log(JSON.stringify({ok:true,original:original.statuses,fixed:fixed.statuses,real_content_conflict_preserved:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
