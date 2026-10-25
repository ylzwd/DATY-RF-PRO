// No live planning or controls: fresh browser profile, fixture devices and intercepted APIs.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright'),fixture=require('./fixtures/manual-constraints.json');
const root=path.join(__dirname,'..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-manual-constraints-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 try{
  const context=await browser.newContext(),page=await context.newPage(),errors=[],controls=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>{
   const r=route.request(),u=new URL(r.url());if(u.pathname==='/api/command')controls.push(r.postData());
   if(r.method()==='GET'&&u.origin==='https://localhost:8080'&&(u.pathname==='/unirf-app.html'||/^\/src\/.*\.(css|js)$/.test(u.pathname)))return route.fulfill({path:path.join(root,u.pathname)});
   return route.fulfill({json:{success:true,devices:[],projects:[],events:[],ip:'127.0.0.1',project:{id:'fixture',name:'Isolated constraint test'}}});
  });
  await context.addInitScript(()=>{
   window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};
   window.WebSocket=class extends EventTarget{close(){}send(){throw Error('Controls forbidden');}};
  });
  await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
  await page.evaluate(devices=>{
   // Stop delayed discovery/SSE retries in this fixture so mocked empty snapshots cannot change its online state.
   _fasheDisconnect();window._fasheConnect=()=>{};deviceServiceManager.stopDiscovery();deviceServiceManager.startDiscovery=()=>{};
   window.notify=()=>{};window.savedRuns=[];window.persistPlanningProject=async(record,result)=>savedRuns.push(structuredClone({record,result}));
   DATY_STATE.devices.splice(0,DATY_STATE.devices.length,...devices.map(d=>({...d,_online:true,status:'online',rf:-50,afDbfs:-12,batt:90})));
   switchPanel('planner');
  },fixture.devices);
  for(const [width,height]of[[1920,1080],[1366,768],[1024,600]]){
   await page.setViewportSize({width,height});await page.click('#plannerBasicTab');await page.selectOption('#plannerRange',fixture.fields.plannerRange);
   await page.click('#plannerConstraintsTab');
   for(const id of ['plannerExcludedRanges','plannerKnownCarriers','plannerBackupCount']){
    const input=page.locator('#'+id);assert.equal(await input.isEditable(),true);
    assert.ok(await input.getAttribute('placeholder'));
    const hint=page.locator('#'+await input.getAttribute('aria-describedby'));
    assert.ok(await hint.isVisible());assert.ok((await hint.getAttribute('title')).length>20);
    await input.fill(fixture.fields[id]);
   }
   await page.evaluate(()=>{
    for(const d of DATY_STATE.devices){d._online=true;d.status='online';}
    const field=document.getElementById('plannerLockedAssignments');field.value='';field.dispatchEvent(new Event('input'));
    DATY_STATE.devices[0].freq=642000;renderFreqTable(false);
   });
   assert.equal(await page.locator('#plannerLockChannel option[value="device:fixture-rx_ch1"]').count(),1,JSON.stringify(await page.evaluate(()=>({devices:DATY_STATE.devices,options:document.getElementById('plannerLockChannel').innerHTML}))));
   await page.selectOption('#plannerLockChannel','device:fixture-rx_ch1');
   await page.fill('#plannerLockNote','主持人优先');await page.click('#plannerConfirmLock');
   await page.evaluate(()=>{DATY_STATE.devices[0].freq=641000;renderFreqTable(false);});
   assert.match(await page.textContent('#plannerConstraintSummary'),/待联合校验.*排除 2.*锁定 1.*占用 1.*备用 2/);
   const before=await page.evaluate(()=>({real:DATY_STATE.devices.map(d=>[d.id,d.freq,d.muted]),saves:savedRuns.length}));
   await page.locator('#panel-planner').screenshot({path:path.join(output,`${width}-editable.png`)});
   await page.click('.planner-run-button');
   const planned=await page.evaluate(()=>({result:structuredClone(DATY_LAST_COORDINATION),real:DATY_STATE.devices.map(d=>[d.id,d.freq,d.muted]),last:savedRuns.at(-1),saves:savedRuns.length}));
   assert.deepEqual(planned.result.errors,[]);assert.equal(planned.result.assignments.find(a=>a.deviceId===1).frequencyKHz,642000);
   assert.notEqual(planned.result.assignments.find(a=>a.deviceId===2).frequencyKHz,645000);assert.equal(planned.result.assignments.find(a=>a.deviceId===3).frequencyKHz,655000);
   assert.deepEqual(planned.real,before.real);assert.equal(planned.saves,before.saves+1);
   assert.deepEqual(planned.last.record.constraintFields,{...fixture.fields,plannerLockedAssignments:'fixture-rx_ch1=642.000 主持人优先'});assert.match(await page.textContent('#plannerConstraintSummary'),/已叠加到本次规划/);
   assert.match(await page.textContent('.planner-applied-constraints'),/排除 2.*锁定 1.*占用 1.*备用 2/);
   // Check both directions of edit feedback; invalid current drafts may not leave old deployable results.
   await page.fill('#plannerBackupCount','5');assert.equal(await page.locator('#plannerBackupCount').getAttribute('aria-invalid'),'true');
   await page.click('.planner-run-button');assert.equal(await page.evaluate(()=>DATY_LAST_COORDINATION),null);
   assert.equal(await page.evaluate(()=>document.activeElement.id),'plannerBackupCount');
   await page.fill('#plannerBackupCount','4');assert.equal(await page.locator('#plannerBackupCount').getAttribute('aria-invalid'),'false');
   await page.click('.planner-run-button');assert.equal(await page.evaluate(()=>DATY_LAST_COORDINATION.options.backupCount),4);
   await page.fill('#plannerExcludedRanges','641.500-642.500 主持人锁定冲突');
   await page.click('.planner-run-button');
   assert.equal(await page.evaluate(()=>DATY_LAST_COORDINATION.assignments.length),0);
   await page.getByRole('button',{name:'详情 / 限制',exact:true}).click();
   assert.match(await page.textContent('#plannerDetailContent'),/主持人锁定冲突/);await page.keyboard.press('Escape');
   const overflow=await page.evaluate(()=>['.content','#panel-planner','.planner-control-card','#plannerConstraints','#planResultContent'].filter(selector=>{
    const e=document.querySelector(selector);return e.scrollWidth>e.clientWidth+1||e.scrollHeight>e.clientHeight+1;
   }));assert.deepEqual(overflow,[]);
   await page.locator('#panel-planner').screenshot({path:path.join(output,`${width}-conflict.png`)});
   console.log(JSON.stringify({size:[width,height],editable:4,unsavedOverlay:'PASS',backup4:'PASS',conflict:'PASS',overflow:false}));
  }
  // Exercise the actual two-box UI with two independent receivers sharing CH1.
  await page.setViewportSize({width:1366,height:768});
  await page.evaluate(()=>{
   DATY_STATE.devices.splice(0,DATY_STATE.devices.length,...[1,2].map(n=>({id:n,_fasheId:`note-rx-${n}_ch1`,receiver_ip:`192.0.2.${n}`,group_source:'server-fifo-v1',group_number:n===1?2:10,channel_number:1,ch:'CH1',
    name:`测试接收机 ${n}`,brand:'DATYaudio',model:'DATY-X1',freq:n===1?641000:645000,_online:true,status:'online',muted:false,rf:-50,batt:90,afDbfs:-12})));
   DatyPlanningConstraints.restoreSnapshot({constraintFields:{plannerRange:'640000:690000',plannerBackupCount:'0'}});renderFreqTable(false);
  });
  await page.click('#plannerConstraintsTab');
  assert.equal(await page.locator('#plannerLockedAssignments').isVisible(),false);
  assert.match(await page.locator('#plannerLockChannel').textContent(),/192\.0\.2\.1 · GROUP2 · CH1 · 641\.000 MHz/);
  assert.match(await page.locator('#plannerLockChannel').textContent(),/192\.0\.2\.2 · GROUP10 · CH1 · 645\.000 MHz/);
  await page.selectOption('#plannerLockChannel','device:note-rx-1_ch1');await page.fill('#plannerLockNote','主持人');await page.click('#plannerConfirmLock');
  await page.selectOption('#plannerLockChannel','device:note-rx-2_ch1');assert.equal(await page.inputValue('#plannerLockNote'),'');await page.fill('#plannerLockNote','嘉宾');await page.click('#plannerConfirmLock');
  assert.deepEqual(await page.locator('.planner-lock-note').allTextContents(),['锁定 · 主持人','锁定 · 嘉宾']);
  await page.selectOption('#plannerLockChannel','lock:0');assert.equal(await page.inputValue('#plannerLockNote'),'主持人');
  await page.locator('#plannerLockNote').focus();await page.keyboard.press('End');await page.keyboard.insertText(' ');
  await page.evaluate(()=>{DATY_STATE.devices[0].freq=649000;forceRefreshAllPanels({realtime:true,alertsEvaluated:true});});
  assert.equal(await page.inputValue('#plannerLockNote'),'主持人 ');assert.equal(await page.evaluate(()=>document.activeElement.id),'plannerLockNote');
  assert.match(await page.locator('#plannerLockChannel').getAttribute('title'),/当前频点 649.000/);
  assert.deepEqual(await page.locator('.planner-lock-value').allTextContents(),['641.000 MHz','645.000 MHz']);
  await page.fill('#plannerLockNote','<img src=x onerror=alert(1)> 主持人');await page.click('#plannerConfirmLock');
  assert.equal(await page.locator('.planner-locked-cell img').count(),0);assert.match(await page.locator('.planner-lock-note').first().textContent(),/<img src=x/);
  await page.fill('#plannerLockNote','主持人');await page.click('#plannerConfirmLock');await page.click('#savePlannerConstraints');
  await page.waitForFunction(()=>savedRuns.at(-1)?.record.constraints.lockedAssignments.length===2);
  await page.evaluate(()=>{
   window.noteSavedRecord=structuredClone(savedRuns.at(-1).record);
   DATY_STATE.devices[0].id=11;DATY_STATE.devices[1].id=12;
   DatyPlanningConstraints.restoreSnapshot(noteSavedRecord);renderFreqTable(false);
  });
  assert.equal(await page.inputValue('#plannerLockNote'),'主持人');
  assert.deepEqual(await page.evaluate(()=>DatyPlanningConstraints.readConstraintFields().lockedAssignments.map(l=>[l.deviceId,l.frequencyKHz,l.reason])),[[11,641000,'主持人'],[12,645000,'嘉宾']]);
  await page.locator('#panel-planner').screenshot({path:path.join(output,'1366-two-receivers-notes.png')});
  await page.evaluate(()=>{DATY_STATE.devices[0]._online=false;DATY_STATE.devices[0].status='offline';renderFreqTable(false);});
  assert.match(await page.locator('#plannerLockChannel').textContent(),/离线\/待连接锁定/);
  assert.equal(await page.inputValue('#plannerLockNote'),'主持人');await page.fill('#plannerLockNote','待上线主持人');await page.click('#plannerConfirmLock');
  await page.evaluate(()=>{DATY_STATE.devices.splice(0,1);renderFreqTable(false);});
  await page.click('#savePlannerConstraints');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'plannerLockChannel');
  assert.equal(await page.getAttribute('#plannerLockChannel','aria-invalid'),'true');
  await page.click('#plannerRemoveLock');assert.equal(await page.locator('.planner-lock-note').textContent(),'锁定 · 嘉宾');
  assert.equal(await page.evaluate(()=>DatyPlanningConstraints.readConstraintFields().lockedAssignments.length),1);
  assert.deepEqual(errors,[]);assert.deepEqual(controls,[]);console.log('PASS: editable hints, unsaved constraints, global solver, backups, conflicts, two-receiver CH identity, note escaping/editing, telemetry snapshots, offline locks, project restore and layout. Screenshots: '+output);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
