'use strict';
// Real Node sync controllers -> candidate Python Bridge -> temporary SQLite.
// Only the owned ephemeral 127.0.0.1 TLS fixture is reachable; no live services.
const assert=require('node:assert/strict'),path=require('node:path'),https=require('node:https');
const {spawn}=require('node:child_process'),{createInterface}=require('node:readline');
const syncFactory=require('../src/platform/project-sync.js'),concurrency=require('../src/platform/project-concurrency.js');
const root=path.resolve(__dirname,'..'),copy=v=>JSON.parse(JSON.stringify(v));
async function main(){
  const python=process.env.DATY_TEST_PYTHON || path.resolve(__dirname,'../../tools/python/python.exe');
  const child=spawn(python,['-B',path.join(__dirname,'c2-http-fixture.py')],{
    cwd:root,windowsHide:true,env:{...process.env,PYTHONPATH:root},stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout}),queued=[],waiting=[];let errors='',finished=false;
  child.stderr.on('data',chunk=>errors+=chunk);
  lines.on('line',line=>{const value=JSON.parse(line);if(waiting.length)waiting.shift()(value);else queued.push(value);});
  const next=()=>queued.length?Promise.resolve(queued.shift()):new Promise(resolve=>waiting.push(resolve));
  const exited=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{finished=true;resolve(code);});});
  let deadline;
  try{
    const timeout=new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Fixture startup timeout: '+errors)),15000);});
    const info=await Promise.race([next(),timeout,exited.then(code=>{throw Error('Fixture exited '+code+': '+errors);})]);
    clearTimeout(deadline);assert.equal(info.fixture,'daty-c2-isolated-v1');assert.ok(Number.isInteger(info.port)&&info.port>0);
    const origin='https://127.0.0.1:'+info.port,calls=[];
    function transport(url,options={}){
      const target=new URL(url);assert.equal(target.origin,origin,'Never contact a running/remote server');
      assert.match(target.pathname,/^\/api\/(projects(?:\/.*)?|timeline)$/);
      calls.push({method:options.method||'GET',path:target.pathname,body:options.body?JSON.parse(options.body):null});
      return new Promise((resolve,reject)=>{
        const request=https.request(target,{method:options.method||'GET',ca:info.ca,signal:options.signal,
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+info.token,...options.headers}},response=>{
          let data='';response.setEncoding('utf8');response.on('data',chunk=>data+=chunk);
          response.on('end',()=>resolve({status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300,
            json:async()=>JSON.parse(data)}));response.on('error',reject);
        });request.on('error',reject);request.end(options.body);
      });
    }
    function client(request=transport,projectId='default'){
      return syncFactory.create({request,readScope:()=>({baseUrl:origin,projectId,accessRevision:1}),
        schedule:setTimeout,cancel:clearTimeout,concurrency});
    }
    let gate=null;
    const gated=async function(url,options){const response=await transport(url,options);
      if(gate && (options.method||'GET')==='GET')await new Promise(resolve=>{
        gate.push(resolve);if(gate.length===2){const ready=gate;gate=null;ready.forEach(fn=>fn());}
      });return response;};
    const a=client(gated),b=client(gated);
    assert.equal((await a.load()).status,'loaded');assert.equal((await b.load()).status,'loaded');
    const da=copy(a.snapshot().project),db=copy(b.snapshot().project);
    da.data.alice='retained';db.data.bob='retained';gate=[];
    const results=await Promise.all([a.save(da),b.save(db)]);
    assert.deepEqual(results.map(r=>r.status).sort(),['conflict','saved']);
    assert.equal(calls.filter(x=>x.method==='POST').length,2);
    const loser=results[0].status==='conflict'?a:b,desired=results[0].status==='conflict'?da:db;
    // Explicit new user save, never automatic replay; three-way merge retains
    // both independent edits against the original editing baseline.
    assert.equal((await loser.save(desired)).status,'saved');
    const observed=await (await transport(origin+'/api/projects/default')).json();
    assert.equal(observed.project.data.alice,'retained');assert.equal(observed.project.data.bob,'retained');
    assert.equal(observed.project.revision,3);
    const old=await transport(origin+'/api/projects',{method:'POST',body:JSON.stringify({id:'default',data:{discard:true}})});
    assert.equal(old.status,428);
    let loseReply=true;
    const uncertain=client(async function(url,options){const response=await transport(url,options);
      if(loseReply&&options.method==='POST'){loseReply=false;await response.json();throw Error('Simulated reply loss AFTER real commit');}
      return response;});
    assert.equal((await uncertain.load()).status,'loaded');
    const unknownBody=copy(uncertain.snapshot().project);unknownBody.data.confirmedLater=true;
    assert.equal((await uncertain.save(unknownBody)).status,'unknown');
    const before=calls.length;assert.equal((await uncertain.save(unknownBody)).status,'unknown');assert.equal(calls.length,before);
    const reconciled=await uncertain.reconcile();assert.equal(reconciled.status,'saved');assert.equal(reconciled.reconciled,true);
    assert.equal(calls.slice(before).filter(x=>x.method==='POST').length,0,'Read-only reconciliation never resends');
    const first=client(transport,'新建/项目 +1');assert.equal((await first.load()).status,'loaded');assert.equal(first.snapshot().project,null);
    assert.equal((await first.save({id:'新建/项目 +1',name:'Unicode fixture',data:{},devices:[]})).status,'saved');
    child.stdin.write('stats\n');const stats=await next();
    assert.equal(stats.fixture_stats.commands,0);assert.equal(stats.fixture_stats.timeline_events,4);
    console.log('PASS: real CA-validated candidate Bridge + two sync clients: CAS conflict, explicit merge, old 428, committed reply loss/GET reconciliation, Unicode create; 4 audited commits, zero receiver commands.');
  } finally {
    clearTimeout(deadline);
    if(!finished)child.stdin.end('stop\n');
    let timer;const code=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture shutdown timeout')),10000);})]);clearTimeout(timer);
    lines.close();if(code!==0)throw Error('Fixture cleanup failed: '+errors);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
