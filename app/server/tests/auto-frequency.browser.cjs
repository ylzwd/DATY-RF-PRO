// Isolated UI, real production algorithm; all network fulfilled, no field commands.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..'),out=fs.mkdtempSync(path.join(os.tmpdir(),'daty-auto-frequency-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 try{
  const context=await browser.newContext(),page=await context.newPage(),errors=[],commands=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>{
   const req=route.request(),u=new URL(req.url());
   if(req.method()!=='GET')commands.push({url:req.url(),method:req.method()});
   if(req.method()==='GET'&&u.origin==='https://localhost:8080'&&(u.pathname==='/unirf-app.html'||u.pathname==='/DATYlogo.png'||/^\/src\/.*\.(js|css|png)$/.test(u.pathname)))
    return route.fulfill({path:path.join(root,u.pathname)});
   return route.fulfill({json:{status:'ok',success:true,devices:[],projects:[],events:[],project:{id:'default'},ip:'127.0.0.1'}});
  });
  await context.addInitScript(()=>{
   window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};
   window.WebSocket=class extends EventTarget{close(){}send(){throw Error('No field socket');}};
   window.autoCalls=0;const NativeWorker=window.Worker;
   window.Worker=class extends NativeWorker{postMessage(...args){autoCalls++;return super.postMessage(...args);}};
   localStorage.setItem('daty_alert_sound_v1','{"enabled":false}');
  });
  await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
  await page.evaluate(()=>{
   document.getElementById('plannerRange').value='custom';document.getElementById('plannerRangeStart').value='640.000';
   document.getElementById('plannerRangeEnd').value='650.000';document.getElementById('plannerBackupCount').value='1';
   DEVICES.splice(0,DEVICES.length,...[1,2].map(i=>({id:'rx'+i,_fasheId:'rx'+i,receiver_id:'receiver'+i,receiver_ip:'192.0.2.'+i,
    channel_number:1,brand:'DATYaudio',model:'RF PRO',_online:true,status:'online',freq:641000,planned:649000,rf:-50,afDbfs:-20,batt:90})));
   window.originalPlan=JSON.stringify(DEVICES.map(d=>({freq:d.freq,planned:d.planned})));
   evaluateRealtimeAlerts();
  });
  await page.waitForFunction(()=>DatyAutoFrequency.getState().result?.entries.length===2);
  assert.equal(await page.locator('[data-auto-frequency]').count(),1);
  assert.match(await page.locator('[data-auto-frequency]').textContent(),/192\.0\.2\.1/);
  const calls=await page.evaluate(()=>autoCalls);
  await page.evaluate(()=>{for(let i=0;i<50;i++){DEVICES[0].rf=-95-i%2;DEVICES[0].batt=5;DEVICES[0].afDbfs=0;DEVICES[0].muted=i%2===0;evaluateRealtimeAlerts();}});
  await page.evaluate(()=>new Promise(r=>setTimeout(r,400)));
  assert.equal(await page.evaluate(()=>autoCalls),calls,'Level/mute updates must not rerun IMD');
  await page.getByRole('button',{name:'查看换频建议',exact:true}).click();
  await page.locator('#datyConfirmDialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#datyConfirmRows tr').count(),2);
  assert.match(await page.locator('#datyConfirmMessage').textContent(),/单独替换/);
  await page.getByRole('button',{name:'前往频率规划',exact:true}).click();
  assert.equal(await page.locator('#panel-planner').evaluate(e=>e.classList.contains('active')),true);
  assert.equal(await page.evaluate(()=>JSON.stringify(DEVICES.map(d=>({freq:d.freq,planned:d.planned})))),await page.evaluate(()=>originalPlan));
  // Actual changed carrier invalidates displayed candidates immediately; clean replacement removes them.
  await page.evaluate(()=>{DEVICES[1].freq=642000;evaluateRealtimeAlerts();});
  assert.equal(await page.locator('[data-auto-frequency]').count(),0);
  await page.waitForFunction(()=>DatyAutoFrequency.getState().phase==='ready');
  assert.equal(await page.evaluate(()=>DatyAutoFrequency.getState().result.entries.length),0,'Weak RF/AF/battery alone do not recommend');
  // Imported real CSV-equivalent scan is distinct from the simulated spectrum curve.
  await page.evaluate(()=>setImportedScanPoints(Array.from({length:101},(_,i)=>({frequencyKHz:640000+i*100,levelDbm:i===10?-40:-100})),'fixture CSV'));
  await page.waitForFunction(()=>DatyAutoFrequency.getState().result?.entries.some(e=>e.evidence==='scan'));
  await page.evaluate(()=>switchPanel('settings'));
  await page.locator('#autoFrequencyEnabled').evaluate(e=>{e.checked=false;e.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await page.locator('[data-auto-frequency]').count(),0);
  assert.equal(await page.locator('#autoFrequencyDetails').isDisabled(),true);
  await page.reload({waitUntil:'networkidle'});
  assert.equal(await page.locator('#autoFrequencyEnabled').isChecked(),false);
  await page.evaluate(()=>switchPanel('settings'));
  for(const [width,height]of[[1920,1080],[1366,768],[1280,720]]){
   await page.setViewportSize({width,height});
   const overflow=await page.evaluate(()=>['html','body','.content','#panel-settings'].filter(s=>{const e=document.querySelector(s);return e.scrollWidth>e.clientWidth+1||e.scrollHeight>e.clientHeight+1;}));
   assert.deepEqual(overflow,[]);
   await page.screenshot({path:path.join(out,`settings-${width}.png`)});
  }
  // Heavy IMD is in a real Worker. The page's timer and controls remain usable,
  // then disabling cancels the in-flight job and cannot resurrect old results.
  await page.evaluate(()=>{
   document.getElementById('plannerRange').value='custom';document.getElementById('plannerRangeStart').value='640.000';
   document.getElementById('plannerRangeEnd').value='690.000';
   DEVICES.splice(0,DEVICES.length,...Array.from({length:50},(_,i)=>({id:'heavy'+i,_fasheId:'heavy'+i,receiver_id:'r'+i,
    receiver_ip:'192.0.2.'+(i+1),channel_number:1,brand:'DATYaudio',model:'RF PRO',freq:641000+i*250,_online:true,status:'online'})));
   DatyAutoFrequency.setEnabled(true);DatyAutoFrequency.refresh(true);
  });
  const tick=await page.evaluate(()=>new Promise(resolve=>{const t=performance.now();setTimeout(()=>resolve(performance.now()-t),50);}));
  assert.ok(tick<600,'Background IMD must not block UI timer: '+tick);
  await page.evaluate(()=>DatyAutoFrequency.setEnabled(false));
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,400)));
  assert.equal(await page.evaluate(()=>DatyAutoFrequency.getState().result),null);
  assert.deepEqual(errors,[]);assert.deepEqual(commands,[]);
  console.log('PASS: background IMD, cancellation, read-only suggestions, identities, cache, live invalidation, actual scan, navigation without deployment, preference/reload, UI. '+out);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
