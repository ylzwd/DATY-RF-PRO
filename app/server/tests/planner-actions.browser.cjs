// Full planner action surfaces with isolated data/API; no production controls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright'),root=path.join(__dirname,'..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-planner-actions-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 try{
  const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage(),errors=[],systemDialogs=[],writes=[];
  await context.route('**/*',route=>{const q=route.request(),u=new URL(q.url());
   if(q.method()==='GET'&&u.origin==='https://localhost:8080'&&(u.pathname==='/unirf-app.html'||u.pathname==='/DATYlogo.png'||/^\/src\/.*\.(css|js)$/.test(u.pathname)))return route.fulfill({path:path.join(root,u.pathname)});
   if(q.method()!=='GET')writes.push(u.pathname);return route.fulfill({json:{success:true,devices:[],projects:[],events:[],ip:'127.0.0.1',project:{id:'default'}}});});
  await context.addInitScript(()=>{window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};window.WebSocket=class extends EventTarget{close(){}send(){throw Error('No live socket');}};});
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{systemDialogs.push(d.message());await d.dismiss();});
  await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
  await page.evaluate(()=>{
   window.savedRuns=[];window.persistPlanningProject=async record=>savedRuns.push(structuredClone(record));window.notices=[];window.notify=(...a)=>notices.push(a);
   DEVICES.splice(0,DEVICES.length,...[641000,642000,644000].map((freq,i)=>({id:i+1,ch:'CH'+(i+1),channel_number:i+1,group_source:'server-fifo-v1',group_number:1,brand:'DATYaudio',model:'DATY-X1',name:'隔离测试通道 '+i,freq,planned:0,_source:'manual',_online:true,rf:-50,afDbfs:-12,batt:90})));
   switchPanel('planner');document.getElementById('plannerRange').value='custom';document.getElementById('plannerRangeStart').value='640.000';document.getElementById('plannerRangeEnd').value='690.000';document.getElementById('plannerBackupCount').value='0';
   window.profileFixture=structuredClone(DatyEquipmentProfiles.resolveEquipmentProfile({brand:'DATYaudio'}));profileFixture.id='planner-native-fixture';
  });
  const click=action=>page.locator('#panel-planner [data-planner-action="'+action+'"]').filter({visible:true}).first().click();
  const snapshot=()=>page.evaluate(()=>JSON.stringify([DEVICES,DatyPlanningConstraints.captureConstraintFields()]));
  async function windowCheck(id,label){
   const box=await page.locator('#'+id).evaluate(el=>{const b=el.getBoundingClientRect();return {inside:b.x>=0&&b.y>=0&&b.right<=innerWidth+1&&b.bottom<=innerHeight+1,overflow:el.scrollWidth>el.clientWidth+1};});
   assert.equal(box.inside,true,label);assert.equal(box.overflow,false,label);
   await page.screenshot({path:path.join(output,label+'.png')});
  }
  for(const [width,height]of[[1920,1080],[1366,768],[1280,720],[1024,768],[1024,600]]){
   await page.setViewportSize({width,height});await click('basic');
   await page.focus('#plannerBasicTab');await page.keyboard.press('End');assert.equal(await page.getAttribute('#plannerConstraintsTab','aria-selected'),'true');await page.keyboard.press('Home');
   await click('safety');await windowCheck('plannerSafetyDialog',`${width}x${height}-safety`);
   await page.fill('#plannerStepKHz','25');await page.fill('#plannerMinSpacingKHz','');await page.fill('#plannerImdSpacingKHz','');
   await page.locator('#plannerSafetyDialog .planner-dialog-footer button').click();assert.equal(await page.evaluate(()=>document.getElementById('plannerSafetyDialog').open),false);
   assert.equal(await page.evaluate(()=>document.activeElement.dataset.plannerAction),'safety');
   await click('plan');await page.waitForFunction(()=>!!DATY_LAST_COORDINATION);
   const before=await snapshot();await click('details');await windowCheck('plannerResultDialog',`${width}x${height}-details`);
   assert.match(await page.textContent('#plannerDetailContent'),/250 kHz/);await page.keyboard.press('Escape');assert.equal(await snapshot(),before);
   await click('exportPlan');await windowCheck('datyConfirmDialog',`${width}x${height}-csv`);
   assert.match(await page.textContent('#datyConfirmDetails'),/全部 3 · 已规划 3/);await page.click('#datyConfirmCancel');await page.waitForFunction(()=>!document.getElementById('plannerExportPlan').disabled);assert.equal(await snapshot(),before);
  }
  await click('exportPlan');const downloadEvent=page.waitForEvent('download');await page.click('#datyConfirmAccept');
  const download=await downloadEvent;assert.match(download.suggestedFilename(),/^DATY_RF_Plan_\d{4}-\d{2}-\d{2}\.csv$/);
  const bytes=fs.readFileSync(await download.path());assert.equal(bytes.subarray(0,3).toString('hex'),'efbbbf');assert.equal(bytes.toString('utf8'),await page.evaluate(()=>buildPlanCsv()));
  await page.waitForFunction(()=>!document.getElementById('plannerExportPlan').disabled);assert.equal(await page.evaluate(()=>notices.at(-1)[1]),'已开始下载');
  // Lock, note edit, removal and save use the real original adapter and project-history path.
  await click('constraints');await page.selectOption('#plannerLockChannel','device:1');await page.fill('#plannerLockNote','鼓手');await page.click('#plannerConfirmLock');
  const live=await page.evaluate(()=>DEVICES.map(({planned,...d})=>d));await click('saveConstraints');await page.waitForFunction(()=>!document.getElementById('savePlannerConstraints').disabled);
  assert.equal(await page.evaluate(()=>savedRuns.at(-1).constraints.lockedAssignments[0].reason),'鼓手');
  await click('removeLock');assert.equal(await page.inputValue('#plannerLockedAssignments'),'');assert.deepEqual(await page.evaluate(()=>DEVICES.map(({planned,...d})=>d)),live);
  // Read a selected native file into the existing import adapter, then exercise the real app review UI.
  await click('basic');await page.evaluate(()=>{window.DatyTextFiles={VERSION:'daty-text-file-v1',async openText(){const text=JSON.stringify(profileFixture);return {status:'completed',name:'配置<测试>.json',text,sizeBytes:new TextEncoder().encode(text).length};}};});
  const profiles=()=>page.evaluate(()=>localStorage.getItem(DatyEquipmentProfiles.STORAGE_KEY));let previous=await profiles();
  await click('importProfile');await page.locator('#datyConfirmDialog').waitFor();await windowCheck('datyConfirmDialog','1024x600-profile');
  assert.match(await page.textContent('#datyConfirmDetails'),/配置<测试>.json/);assert.equal(await page.locator('#datyConfirmDetails img').count(),0);
  await page.click('#datyConfirmCancel');assert.equal(await profiles(),previous);
  await click('importProfile');await page.locator('#datyConfirmDialog').waitFor();
  await page.evaluate(()=>{localStorage.setItem(DatyEquipmentProfiles.STORAGE_KEY,'[]');});await page.click('#datyConfirmAccept');
  await page.waitForFunction(()=>notices.at(-1)?.[1]==='Profile 导入失败');assert.equal(await profiles(),'[]');
  await click('importProfile');await page.locator('#datyConfirmDialog').waitFor();await page.click('#datyConfirmAccept');
  await page.waitForFunction(()=>notices.at(-1)?.[1]==='Profile 已导入');assert.ok((await profiles()).includes('planner-native-fixture'));
  // Native planner windows receive typed models and route live changes through the same invalidation path.
  await page.evaluate(()=>{window.nativeViews=[];window.DatyPlannerViews={VERSION:'daty-planner-views-v1',open(model,options){return new Promise(resolve=>nativeViews.push({model,options,resolve}));}};});
  await click('safety');assert.equal(await page.evaluate(()=>document.getElementById('plannerSafetyDialog').open),false);
  assert.equal(await page.evaluate(()=>nativeViews.at(-1).model.fields.length),5);
  const accepted=await page.evaluate(()=>nativeViews.at(-1).options.onEdit({id:'plannerStepKHz',value:'50'}));assert.equal(accepted.accepted,true);
  assert.equal(await page.inputValue('#plannerStepKHz'),'50');assert.equal(await page.evaluate(()=>DATY_LAST_COORDINATION),null);
  await page.evaluate(()=>closePlannerWindow('safety'));await page.waitForTimeout(0);
  assert.equal(await page.evaluate(()=>nativeViews.at(-1).options.onEdit({id:'plannerStepKHz',value:'75'}).accepted),false);
  await click('details');assert.match(await page.evaluate(()=>nativeViews.at(-1).model.text),/重新规划/);
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await page.waitForTimeout(0);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);assert.deepEqual(systemDialogs,[]);
  console.log('PASS: all planner action surfaces, five-window layouts, actual CSV, save/remove locks, Profile review/cancel/stale store, native safety/details and lifecycle. No external writes. Screenshots: '+output);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
