// Optional read-only benchmark: GET /api/devices only, isolated planner, no POST/control/storage.
// node tests/p0-live-check.cjs [--live]
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const context=vm.createContext({localStorage:{getItem:()=>null,setItem:()=>{throw Error('No storage writes');}}});
context.window=context;
for(const name of ['frequency','equipment-profiles','coordination'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules',name+'.js'),'utf8'),context);
function check(label,devices,backupCount=1) {
  const c=context.DatyCoordination,input={rangeStartKHz:614250,rangeEndKHz:638000,backupCount};
  const start=performance.now(),result=c.coordinateFrequencies(devices,input),elapsedMs=performance.now()-start;
  const repeated=c.coordinateFrequencies(devices,input);
  assert.equal(JSON.stringify(result),JSON.stringify(repeated));
  const analysis=c.analyzeFrequencyPlan(devices,new Map(result.assignments.map(x=>[x.deviceId,x.frequencyKHz])),input);
  assert.equal(analysis.conflicts.length,0);
  console.log(JSON.stringify({label,channels:devices.length,assigned:result.assignments.length,
    backups:result.assignments.reduce((n,x)=>n+x.backupFrequenciesKHz.length,0),elapsedMs:Math.round(elapsedMs*10)/10,
    nodes:result.search.nodes,truncated:result.search.truncated,netMarginKHz:analysis.minImdMarginKHz,
    repeatIdentical:true,conflicts:analysis.conflicts.length,errors:result.errors,warnings:result.warnings}));
}
(async()=>{
  if(process.argv.includes('--live')) {
    const response=await fetch('http://127.0.0.1:8802/api/devices',{signal:AbortSignal.timeout(5000)});
    assert.ok(response.ok);const data=await response.json();assert.ok(data.success);
    check('live receiver snapshot; mathematical planning only',data.devices);
  }
  for(const n of [4,8,12])check('synthetic fixed benchmark; not measurement',Array.from({length:n},(_,i)=>({id:i+1,brand:'DATYaudio',model:'RF PRO',ch:`CH${i+1}`,freq:620000})),0);
})().catch(error=>{console.error(error);process.exitCode=1;});
