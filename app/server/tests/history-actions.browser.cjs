// Production history UI against isolated records/API routes; never reach live services.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-history-actions-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 try {
  const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage(),errors=[],dialogs=[],writes=[],controls=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',async dialog=>{dialogs.push(dialog.type());await dialog.dismiss();});
  await context.route('**/*',route=>{
   const req=route.request(),u=new URL(req.url());
   if(req.method()==='GET'&&u.origin==='https://localhost:8080'&&(u.pathname==='/unirf-app.html'||u.pathname==='/DATYlogo.png'||/^\/src\/.*\.(css|js)$/.test(u.pathname)))return route.fulfill({path:path.join(root,u.pathname)});
   if(req.method()!=='GET'){writes.push({path:u.pathname,body:req.postDataJSON()});if(u.pathname!=='/api/projects')controls.push(u.pathname);}
   return route.fulfill({json:{success:true,devices:[],events:[],projects:[],project:{id:'default'},ip:'127.0.0.1'}});
  });
  await context.addInitScript(()=>{window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};window.WebSocket=class extends EventTarget{close(){}send(){throw Error('Real socket forbidden');}};});
  await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
  await page.evaluate(()=>{
   window.notices=[];window.notify=(...args)=>notices.push(args);
   window.historyFixture=()=>{
    const device={id:'rx-a_ch1',_fasheId:'rx-a_ch1',receiver_ip:'192.0.2.10',ip:'192.0.2.10',receiver_mac:'02:00:00:00:00:01',channel_number:1,ch:'CH1',brand:'DATYaudio',model:'DATY-X1',name:'原始名称',freq:641000,planned:0,rf:-50,batt:85,muted:false,_online:false,status:'offline'};
    DEVICES.splice(0,DEVICES.length,device);
    HISTORY.splice(0,HISTORY.length,...Array.from({length:41},(_,i)=>({type:'daty_rf_planning',id:'plan-'+i,name:'演出规划 '+String(i).padStart(2,'0'),date:'2026-09-15',time:'2026/09/15 12:30:00',projectId:'default',projectName:'剧场 A',channels:1,
     devices:[{...device,planned:650000}],constraints:{lockedAssignments:[{deviceId:device.id,frequencyKHz:650000,reason:'鼓手'}],backupCount:0},
     constraintFields:{plannerLockedAssignments:'rx-a_ch1=650.000 鼓手',plannerBackupCount:'0',plannerRange:'custom',plannerRangeStart:'640.000',plannerRangeEnd:'690.000'}})));
    currentPlanningProject={id:'default',name:'剧场 A'};currentPlanningRecordId='plan-0';planningHistoryDeletedIds.clear();planningHistoryPage=1;
    persistPlanningHistoryState();DatyPlanningConstraints.restoreSnapshot(HISTORY[0]);renderHistory();switchPanel('data');
   };historyFixture();
  });
  const rows=()=>page.locator('#historyBody tr');
  const action=(row,name)=>row.getByRole('button',{name,exact:true}).click();
  const state=()=>page.evaluate(()=>({history:HISTORY,devices:DEVICES,current:currentPlanningRecordId,fields:DatyPlanningConstraints.captureConstraintFields()}));
  for(const [width,height]of[[1920,1080],[1366,768],[1280,720],[1024,768],[1024,600]]){
   await page.setViewportSize({width,height});
   for(const [name,index]of[['加载',0],['导出',1],['删除',2]]){
    const before=await state();await action(rows().first(),name);
    assert.equal(await page.locator('#datyConfirmTitle').textContent(),name+'规划历史');
    assert.ok((await page.locator('#datyConfirmDetails').textContent()).includes('演出规划 00'));
    assert.equal(await page.evaluate(()=>document.activeElement.id),'datyConfirmCancel');
    const geometry=await page.locator('#datyConfirmDialog').evaluate(el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,overflow:el.scrollWidth>el.clientWidth+1};});
    assert.ok(geometry.x>=0&&geometry.y>=0&&geometry.right<=width&&geometry.bottom<=height);assert.equal(geometry.overflow,false);
    await page.screenshot({path:path.join(output,`${width}x${height}-${index}.png`)});
    if(index===0)await page.keyboard.press('Escape');else if(index===1)await page.click('#datyConfirmClose');else await page.click('#datyConfirmCancel');
    await page.locator('#datyConfirmDialog').waitFor({state:'detached'});assert.deepEqual(await state(),before);
   }
  }
  assert.equal(writes.length,0,'cancel produces no project writes');
  // Export the selected second-page record and inspect the actual JSON download.
  await page.click('#historyNextPage');const expected=await page.evaluate(()=>JSON.parse(JSON.stringify(HISTORY[20])));
  await action(rows().first(),'导出');const downloaded=page.waitForEvent('download');await page.click('#datyConfirmAccept');
  const download=await downloaded;assert.deepEqual(JSON.parse(fs.readFileSync(await download.path(),'utf8')),expected);
  assert.equal(await page.evaluate(()=>notices.at(-1)[1]),'已开始下载');assert.equal(writes.length,0);
  await action(rows().first(),'加载');const beforeDevices=await page.evaluate(()=>DEVICES.map(({planned,...d})=>d));await page.click('#datyConfirmAccept');
  await page.waitForFunction(()=>currentPlanningRecordId==='plan-20');
  assert.deepEqual(await page.evaluate(()=>DEVICES.map(({planned,...d})=>d)),beforeDevices);
  assert.equal(await page.locator('#plannerLockedAssignments').inputValue(),'rx-a_ch1=650.000 鼓手');
  // Delete the current record; keep current input and write the existing tombstone format.
  await page.evaluate(()=>{planningHistoryPage=1;renderHistory();});const beforeFields=await page.evaluate(()=>DatyPlanningConstraints.captureConstraintFields());
  await action(rows().first(),'删除');assert.match(await page.locator('#datyConfirmWarnings').textContent(),/未保存草稿/);await page.click('#datyConfirmAccept');
  await page.waitForFunction(()=>!planningHistoryActionPending);assert.equal(await page.evaluate(()=>currentPlanningRecordId),null);
  assert.deepEqual(await page.evaluate(()=>DatyPlanningConstraints.captureConstraintFields()),beforeFields);
  assert.equal(await page.evaluate(()=>HISTORY.some(r=>r.id==='plan-20')),false);assert.ok(writes.at(-1).body.data.planningHistory.every(r=>r.id!=='plan-20'));
  assert.ok(await page.evaluate(()=>planningHistoryDeletedIds.has('plan-20')));
  // Confirmation never executes against changed records or newly saved project state.
  await action(rows().first(),'删除');const count=await page.evaluate(()=>HISTORY.length);
  await page.evaluate(()=>{HISTORY[0].name='修改后的规划';});await page.click('#datyConfirmAccept');await page.waitForFunction(()=>!planningHistoryActionPending);
  assert.equal(await page.evaluate(()=>HISTORY.length),count);assert.match(await page.evaluate(()=>notices.at(-1)[2]),/已变化/);
  // Injected native export completion/cancellation gets truthful app feedback.
  await page.evaluate(()=>{window.savedTexts=[];window.DatyTextExports={VERSION:'daty-text-export-v1',async saveText(text,options){savedTexts.push([text,options.fileName]);return {status:'saved'};}};});
  await action(rows().first(),'导出');await page.click('#datyConfirmAccept');await page.waitForFunction(()=>!planningHistoryActionPending);
  assert.equal(await page.evaluate(()=>savedTexts.length),1);assert.equal(await page.evaluate(()=>notices.at(-1)[1]),'文件已保存');
  await page.evaluate(()=>{DatyTextExports.saveText=async()=>({status:'cancelled'});});const noticeCount=await page.evaluate(()=>notices.length);
  await action(rows().first(),'导出');await page.click('#datyConfirmAccept');await page.waitForFunction(()=>!planningHistoryActionPending);assert.equal(await page.evaluate(()=>notices.length),noticeCount);
  // Text-only rendering of arbitrary record names and keyboard focus containment.
  await page.evaluate(()=>{HISTORY[0].name='<img src=x onerror=alert(1)> & 引号 "';renderHistory();});await action(rows().first(),'删除');
  assert.equal(await page.locator('#datyConfirmDialog img').count(),0);assert.match(await page.locator('#datyConfirmDetails').textContent(),/<img src=x/);
  for(let i=0;i<7;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('#datyConfirmDialog')),true);}
  await page.keyboard.press('Escape');assert.deepEqual(errors,[]);assert.deepEqual(dialogs,[]);assert.deepEqual(controls,[]);
  console.log('PASS: app history load/export/delete; five viewports, cancellation, JSON, identity, native export, no browser dialogs. Screenshots: '+output);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
