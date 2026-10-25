// Opt-in live GET snapshot; solve/preflight ONLY in a fresh isolated browser. No live control/project writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),root=path.join(__dirname,'..');
(async()=>{
 if(!process.argv.includes('--live-readonly'))throw Error('Use --live-readonly to allow localhost GETs');
 const response=await fetch('http://127.0.0.1:8802/api/devices');assert.equal(response.status,200);
 const snapshot=(await response.json()).devices;assert.ok(snapshot.length);
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 try{
  const context=await browser.newContext(),page=await context.newPage(),errors=[],writes=[];
  let staticQueue=Promise.resolve(); // Do not flood the small Python static-server listen backlog.
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());
   if(req.method()==='GET'&&u.origin==='http://localhost:8080'&&(u.pathname==='/unirf-app.html'||/^\/src\/.*\.(css|js)$/.test(u.pathname))){
    staticQueue=staticQueue.then(async()=>{try{
     const r=await route.fetch({url:req.url().replace('localhost','127.0.0.1')});assert.equal(r.status(),200);assert.deepEqual(await r.body(),fs.readFileSync(path.join(root,u.pathname)));await route.fulfill({response:r});
    }catch(error){errors.push(error.message);await route.abort();}});return staticQueue;
   }
   if(req.method()!=='GET')writes.push(req.url());
   return route.fulfill({json:{status:'ok',success:true,devices:[],projects:[],events:[],ip:'127.0.0.1',project:{id:'isolated'}}});
  });
  await context.addInitScript(()=>{window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};window.WebSocket=class extends EventTarget{close(){}send(){throw Error('No sockets');}};});
  await page.goto('http://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
  const expectBrandGate=process.argv.includes('--expect-brand-gate');
  const result=await page.evaluate(({snapshot,expectBrandGate})=>{
   _fasheDisconnect();window._fasheConnect=()=>{};deviceServiceManager.stopDiscovery();deviceServiceManager.startDiscovery=()=>{};
   window.notify=()=>{};window.persistPlanningProject=async()=>{};
   _fasheHandleDeviceList(snapshot);switchPanel('planner');
   document.getElementById('plannerRange').value='640000:690000';document.getElementById('plannerBackupCount').value='0';
   const before=DEVICES.map(d=>[d._fasheId,d.freq]),started=performance.now();runPlanning();
   let targets=[],preflightError=null;
   try{targets=DatyPlanningDeployment.preflight();}catch(error){if(!expectBrandGate)throw error;preflightError=error.message;}
   return {channels:DEVICES.length,preflightTargets:targets.length,elapsedMs:performance.now()-started,
    errors:DATY_LAST_COORDINATION.errors,preflightError,frequenciesKHz:DATY_LAST_COORDINATION.assignments.map(a=>a.frequencyKHz),retained:DATY_LAST_COORDINATION.retention.retainedCount,
    changes:DATY_LAST_COORDINATION.retention.changedCount,profiles:[...new Set(DEVICES.map(d=>DatyEquipmentProfiles.resolveEquipmentProfile(d).id))],
    targets:targets.map(t=>({id:t.command.device_id,ip:t.command.receiver_ip,ch:t.command.channel_number,valueMHz:t.command.value})),
    actualUnchanged:JSON.stringify(before)===JSON.stringify(DEVICES.map(d=>[d._fasheId,d.freq]))};
  },{snapshot,expectBrandGate});
  assert.deepEqual(result.errors,[]);assert.equal(result.actualUnchanged,true);
  assert.ok(result.frequenciesKHz.every(f=>f%250===0));
  if(expectBrandGate){assert.equal(result.preflightTargets,0);assert.match(result.preflightError,/Bridge 尚未启用调频品牌核验/);}
  else assert.equal(result.preflightTargets,snapshot.length);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);console.log(JSON.stringify({...result,liveControlWrites:0,liveProjectWrites:0}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
