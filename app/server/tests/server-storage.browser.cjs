'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),https=require('node:https'),{spawn}=require('node:child_process'),readline=require('node:readline');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-server-storage-browser-'));
(async()=>{
 const child=spawn('C:\\ProgramData\\DATY RF PRO\\runtime\\python\\python.exe',['-B',path.join(__dirname,'server-storage-fixture.py'),'--stdio-fixture'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 let stderr='',readyResolve,readyReject;const ready=new Promise((a,b)=>{readyResolve=a;readyReject=b;}),pending=new Map();let serial=0;
 child.stderr.on('data',data=>stderr+=data);child.on('exit',code=>{if(code)readyReject(Error(stderr||'Fixture exited '+code));});
 readline.createInterface({input:child.stdout}).on('line',line=>{try{const value=JSON.parse(line);if(value.event==='ready')readyResolve(value);else if(pending.has(value.id)){pending.get(value.id)(value.result);pending.delete(value.id);}}catch(_){}});
 const fixture=await ready,agent=new https.Agent({ca:fixture.ca});
 const command=name=>new Promise(resolve=>{const id=++serial;pending.set(id,resolve);child.stdin.write(JSON.stringify({id,command:name})+'\n');});
 const request=(route,method='GET',body)=>new Promise((resolve,reject)=>{
  const req=https.request(fixture.origin+route,{agent,method,headers:{'Content-Type':'application/json',Origin:'https://localhost:8080',...(body?{'Content-Length':Buffer.byteLength(body)}:{})}},response=>{const data=[];response.on('data',b=>data.push(b));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(data)}));});req.on('error',reject);if(body)req.write(body);req.end();});
 const errors=[],failures=[],notices=[],requests=[];let browser,loseCleanupReply=false;
 try{
  await command('seed-receiver');browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage();
  await context.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();setTimeout(()=>this.onopen?.(),0);}close(){}};});
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')notices.push(m.text());});
  page.on('dialog',d=>{errors.push('Unexpected system dialog: '+d.message());void d.dismiss();});
  const routeHandler=async route=>{
   const q=route.request(),u=new URL(q.url());
   if(u.pathname==='/api/updates')return route.fulfill({status:200,contentType:'text/event-stream',body:''});
   if(q.method()==='GET'&&(u.pathname==='/unirf-app.html'||u.pathname==='/DATYlogo.png'||u.pathname.startsWith('/src/'))){const file=path.join(root,u.pathname);if(fs.existsSync(file))return route.fulfill({path:file});}
   if(u.pathname.startsWith('/api/')||u.pathname==='/health'){
    const result=await request(u.pathname+u.search,q.method(),q.postData());requests.push({path:u.pathname,method:q.method(),status:result.status});
    if(loseCleanupReply&&u.pathname.endsWith('/commit')&&u.pathname.includes('/archive-cleanups/')){loseCleanupReply=false;return route.abort('connectionreset');}
    if(result.status>=400)failures.push({path:u.pathname,status:result.status,body:result.body.toString().slice(0,300)});
    return route.fulfill({status:result.status,headers:result.headers,body:result.body});
   }
   return route.fulfill({status:404,json:{success:false}});
  };await context.route('**/*',routeHandler);
  await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'domcontentloaded'});
  try{await page.waitForFunction(()=>globalThis.DatyServerStorage?.ready,null,{timeout:30000});}catch(error){throw Error('Bootstrap failed: '+JSON.stringify({errors,notices,failures,status:await page.locator('#serverStorageStatus').textContent(),planning:await page.locator('#planningHistorySaveStatus').textContent()}));}
  await command('seed-receiver');
  const devices=JSON.parse((await request('/api/devices')).body).devices;
  await page.evaluate(devices=>_fasheHandleDeviceList(devices),devices);
  await page.waitForFunction(()=>DEVICES.length===2,null,{timeout:15000});
  await page.evaluate(()=>{switchPanel('planner');document.getElementById('plannerRange').value='custom';document.getElementById('plannerRangeStart').value='640';document.getElementById('plannerRangeEnd').value='690';document.getElementById('plannerBackupCount').value='0';});
  // Real isolated SQLite draft persistence: preselection is not a lock, confirmation is,
  // and removing one confirmed receiver channel survives a fresh page without touching the other.
  const readLockDraft=async()=>JSON.parse((await request('/api/database/draft?project_id=default')).body).draft?.value?.payload?.fields?.plannerLockedAssignments||'';
  const waitLockDraft=async expected=>{
   for(let i=0;i<100;i++){if(await readLockDraft()===expected)return;await new Promise(resolve=>setTimeout(resolve,50));}
   assert.equal(await readLockDraft(),expected);
  };
  await page.click('#plannerConstraintsTab');
  const choices=await page.locator('#plannerLockChannel option').evaluateAll(items=>items.map(o=>o.value).filter(v=>v.startsWith('device:')));
  assert.equal(choices.length,2);
  await page.selectOption('#plannerLockChannel',choices[0]);await page.fill('#plannerLockNote','鼓手');
  assert.equal(await page.inputValue('#plannerLockedAssignments'),'');
  await page.evaluate(()=>DatyServerStorage.saveDraft());assert.equal(await readLockDraft(),'');
  await page.click('#plannerConfirmLock');
  const firstLock=await page.inputValue('#plannerLockedAssignments');assert.match(firstLock,/鼓手/);await waitLockDraft(firstLock);
  await page.selectOption('#plannerLockChannel',choices[1]);await page.fill('#plannerLockNote','主唱');
  await page.click('#plannerRemoveLock');assert.equal(await page.inputValue('#plannerLockedAssignments'),firstLock);
  await page.selectOption('#plannerLockChannel',choices[1]);await page.fill('#plannerLockNote','主唱');await page.click('#plannerConfirmLock');
  const bothLocks=await page.inputValue('#plannerLockedAssignments');await waitLockDraft(bothLocks);
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>DatyServerStorage.ready);
  assert.equal(await page.inputValue('#plannerLockedAssignments'),bothLocks);
  await command('seed-receiver');await page.evaluate(devices=>{_fasheHandleDeviceList(devices);switchPanel('planner');switchPlannerControlTab('constraints');},devices);
  await page.selectOption('#plannerLockChannel','lock:0');await page.click('#plannerRemoveLock');
  const secondLock=await page.inputValue('#plannerLockedAssignments');assert.match(secondLock,/主唱/);assert.doesNotMatch(secondLock,/鼓手/);await waitLockDraft(secondLock);
  assert.equal(await page.locator('#plannerRemoveLock').isDisabled(),true);
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>DatyServerStorage.ready);
  assert.equal(await page.inputValue('#plannerLockedAssignments'),secondLock);
  await command('seed-receiver');await page.evaluate(devices=>{_fasheHandleDeviceList(devices);switchPanel('planner');switchPlannerControlTab('constraints');},devices);
  await page.selectOption('#plannerLockChannel','lock:0');await page.click('#plannerRemoveLock');await waitLockDraft('');
  await page.click('#plannerBasicTab');
  await page.locator('[data-planner-action="plan"]').click();
  await page.waitForFunction(()=>!!DATY_LAST_COORDINATION);
  await page.waitForFunction(()=>/已保存到当前项目/.test(document.getElementById('plannerConstraintSaveStatus').textContent),null,{timeout:15000}).catch(async()=>{throw Error('Planning save: '+await page.locator('#plannerConstraintSaveStatus').textContent()+' '+JSON.stringify(failures.slice(-5)));});
  const snapshot=await command('stats');assert.equal(snapshot.tables.biz_planning_records,1);assert.equal(snapshot.tables.db_planning_runs,1);assert.equal(snapshot.foreignKeys,0);
  await page.locator('#plannerExportPlan').click();await page.locator('#datyConfirmDialog').waitFor();const downloading=page.waitForEvent('download');await page.locator('#datyConfirmAccept').click();const download=await downloading;
  assert.ok(fs.readFileSync(await download.path()).toString('utf8').includes('device_id,name,brand'));
  await page.evaluate(async()=>{
    document.getElementById('rfThreshInput').value='-65';document.getElementById('battThreshInput').value='25';document.getElementById('afThreshInput').value='-6';
    if(!await DatyBusinessDatabase.saveThresholdSettings())throw Error('Threshold storage failed');
    if(!await DatyBusinessDatabase.setBooleanPreference('alert_sound',false,v=>DatyAlertSound.setEnabled(v)))throw Error('Boolean storage failed');
    const profile=structuredClone(DatyEquipmentProfiles.getAllEquipmentProfiles({persistMigration:false}).find(p=>p.id==='datyaudio-fashe-protocol'));
    profile.id='storage-fixture-custom';profile.models=['Storage fixture'];profile.source='custom';
    if(!await DatyBusinessDatabase.saveImportedProfiles([profile]))throw Error('Profile storage failed');
  });
  await page.evaluate(()=>showAddDeviceModal());await page.locator('#addDev_name').fill('人工设备原名');await page.locator('#addDev_ch').fill('CH9');await page.locator('#addDev_ip').fill('192.0.2.199');await page.locator('#addDev_freq').fill('642');
  await page.locator('#addDev_save').click();await page.waitForFunction(()=>!document.getElementById('addDeviceModal'));
  const manualId=await page.evaluate(()=>DEVICES.find(d=>d.name==='人工设备原名').id);
  await page.evaluate(id=>showAddDeviceModal(DEVICES.find(d=>d.id===id)),manualId);await page.locator('#addDev_model').fill('新型号');await page.locator('#addDev_save').click();await page.waitForFunction(()=>!document.getElementById('addDeviceModal'));
  assert.equal(await page.evaluate(id=>DEVICES.find(d=>d.id===id).name,manualId),'人工设备原名');assert.equal(await page.evaluate(id=>DEVICES.find(d=>d.id===id).model,manualId),'新型号');
  await page.evaluate(()=>switchPanel('planner'));
  const csv='frequency_khz,level_dbm\n640000,-90\n641000,-88\n642000,-85\n690000,-92\n';
  assert.equal(await page.evaluate(async text=>DatyBusinessDatabase.saveImportedScan({name:'original-scan.csv',text,points:DatyScanCsv.parseScanCsv(text).points}),csv),true);
  const scan=JSON.parse((await request('/api/database/resources?kind=scans')).body).resources;assert.equal(scan[0].value.original.text,csv);assert.equal(scan[0].value.points.length,4);
  const alertResult=await page.evaluate(async()=>{
    for(let i=0;i<205;i++)queueAlertForArchive({id:'fixture-'+i,archiveId:'fixture-'+i,deviceId:'rx',ts:1000+i,firstSeen:1000+i,lastSeen:2000+i,msg:'Fixture '+i,metric:'rf'},'ended');
    return flushAlertArchive(undefined,{all:true});
  });assert.equal(alertResult.success,true);assert.equal(alertResult.pending,0);assert.equal((await command('stats')).tables.biz_alerts,205);
  const business=JSON.parse((await request('/api/database/business-snapshot')).body);assert.equal(business.source,'server-sqlite');assert.ok(business.resources.some(r=>r.kind==='profiles'));assert.ok(business.resources.some(r=>r.kind==='scans'));
  // Incomplete drafts persist honestly; an old writer receives a conflict.
  await page.evaluate(()=>{document.getElementById('plannerRangeStart').value='640.';});assert.equal(await page.evaluate(()=>DatyServerStorage.saveDraft()),true);
  const draft=JSON.parse((await request('/api/database/draft?project_id=default')).body);assert.equal(draft.draft.value.payload.fields.plannerRangeStart,'640.');
  const conflict=await request('/api/database/draft','POST',JSON.stringify({projectId:'default',fields:{plannerRangeStart:'wrong'},expected_draft_id:null,operation_id:require('node:crypto').randomUUID(),epoch:draft.epoch}));assert.equal(conflict.status,409);
  await page.evaluate(()=>{document.getElementById('plannerRangeStart').value='640';});assert.equal(await page.evaluate(()=>DatyServerStorage.saveDraft()),true);
  await page.evaluate(()=>{switchPanel('data');document.getElementById('dataServerTab').click();});
  await page.waitForFunction(()=>document.querySelectorAll('#serverArchiveList tr').length>=2);
  for(const [width,height]of[[1920,1080],[1366,768],[1280,720],[1024,768],[1024,600]]){
    await page.setViewportSize({width,height});assert.equal(await page.locator('#createServerArchive').isVisible(),true);
    const layout=await page.evaluate(()=>{
      const panel=document.getElementById('dataServer'),bounds=panel.getBoundingClientRect();
      return {overflow:panel.scrollWidth>panel.clientWidth+1,clipped:[...panel.querySelectorAll('button,a.btn')].filter(e=>{
        const r=e.getBoundingClientRect();return r.right>bounds.right+1||r.left<bounds.left-1||r.width<20;
      }).map(e=>e.textContent)};
    });assert.equal(layout.overflow,false);assert.deepEqual(layout.clipped,[]);
    await page.screenshot({path:path.join(output,width+'x'+height+'-server.png')});
  }
  const commits=()=>requests.filter(r=>r.path.includes('/archive-cleanups/')&&r.path.endsWith('/commit')).length;
  await page.click('#clearServerArchives');await page.locator('#datyConfirmDialog').waitFor();
  await page.screenshot({path:path.join(output,'1024x600-cleanup-confirm.png')});
  assert.equal(await page.isDisabled('#createServerArchive'),true);
  assert.equal(await page.evaluate(()=>DatyServerStorage.clearArchiveFiles()),false,'double click must not start another cleanup');
  await page.keyboard.press('Escape');assert.equal(commits(),0);assert.equal(await page.isDisabled('#createServerArchive'),false);
  const one=JSON.parse((await request('/api/database/exports','POST',JSON.stringify({operation_id:require('node:crypto').randomUUID(),text:'delete only this export',fileName:'单文件删除测试.txt',mimeType:'text/plain'}))).body).record;
  await page.evaluate(()=>DatyServerStorage.refresh());
  await page.locator('#serverArchiveList tr').filter({hasText:'单文件删除测试.txt'}).getByRole('button',{name:'删除',exact:true}).click();
  await page.click('#datyConfirmAccept');await page.waitForFunction(()=>document.getElementById('serverStorageStatus').textContent.includes('已清理 1 份'));
  assert.equal(JSON.parse((await request('/api/database/exports/'+one.id)).body).record.status,'deleted');assert.equal(commits(),1);
  await page.locator('#createServerArchive').click();await page.locator('#datyConfirmDialog').waitFor();await page.screenshot({path:path.join(output,'1024x600-archive-confirm.png')});await page.locator('#datyConfirmAccept').click();
  await page.waitForFunction(()=>document.getElementById('serverStorageStatus').textContent.includes('完整存档已保存在服务器'),null,{timeout:60000});
  const archives=JSON.parse((await request('/api/database/archives')).body).items;assert.equal(archives[0].status,'saved');assert.ok(archives[0].tables>=50);assert.ok(archives[0].exports>=2);
  const zip=await request('/api/database/archives/'+archives[0].id+'/download');assert.equal(zip.status,200);assert.equal(zip.body.subarray(0,2).toString(),'PK');fs.writeFileSync(path.join(output,'complete.zip'),zip.body);
  const dbRecords=JSON.parse((await request('/api/database/resources?kind=planning_records')).body).resources;
  assert.ok(dbRecords.length>=1);const planId=dbRecords[0].id;
  // A separate browser has no cache and must recover real server history.
  const freshContext=await browser.newContext();await freshContext.route('**/*',routeHandler);await freshContext.addInitScript(()=>{window.EventSource=class extends EventTarget{close(){}};});const fresh=await freshContext.newPage();await fresh.goto('https://localhost:8080/unirf-app.html');await fresh.waitForFunction(()=>DatyServerStorage.ready,null,{timeout:30000});
  assert.equal(await fresh.evaluate(id=>HISTORY.some(r=>r.id===id),planId),true);
  assert.equal(await fresh.evaluate(()=>getAlertThresholdSettings().rfWeakDbm),-65);
  assert.equal(await fresh.evaluate(()=>DatyEquipmentProfiles.loadCustomEquipmentProfiles({persistMigration:false}).some(p=>p.id==='storage-fixture-custom')),true);
  assert.equal(await fresh.evaluate(()=>getCurrentScanPoints().length),4);
  await freshContext.close();
  const beforeCleanup=await command('stats');await page.evaluate(()=>DatyServerStorage.refresh());
  await page.click('#clearServerArchives');await page.locator('#datyConfirmDialog').waitFor();
  const newer=JSON.parse((await request('/api/database/exports','POST',JSON.stringify({operation_id:require('node:crypto').randomUUID(),text:'created after prepared selection',fileName:'保留新文件.txt',mimeType:'text/plain'}))).body).record;
  await page.click('#datyConfirmAccept');await page.waitForFunction(()=>/已清理 .*业务数据库保留/.test(document.getElementById('serverStorageStatus').textContent));
  assert.deepEqual(JSON.parse((await request('/api/database/exports')).body).items.map(i=>i.id),[newer.id]);
  assert.equal(JSON.parse((await request('/api/database/archives')).body).items.length,0);
  assert.deepEqual(await command('stats'),beforeCleanup,'file cleanup must not alter SQLite rows or publish controls');
  // A committed deletion with a lost HTTP response is reconciled using GET only.
  loseCleanupReply=true;const priorCommits=commits();await page.click('#clearServerArchives');await page.click('#datyConfirmAccept');
  await page.waitForFunction(()=>document.getElementById('serverArchiveList').textContent==='尚无存档');
  assert.equal(commits(),priorCommits+1);assert.equal(await page.isDisabled('#clearServerArchives'),true);
  assert.equal(JSON.parse((await request('/api/database/exports')).body).items.length,0);
  await page.screenshot({path:path.join(output,'1024x600-cleanup-empty.png')});
  // Reopening the application may create a new browser-cache archive; it must still hydrate the intact database.
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>DatyServerStorage.ready);
  assert.equal(await page.evaluate(id=>HISTORY.some(r=>r.id===id),planId),true);
  assert.equal(await page.evaluate(()=>getAlertThresholdSettings().rfWeakDbm),-65);
  const final=await command('stats');assert.equal(final.commands,0);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({fixture:fixture.temporary,archives,stats:final,requests,failures,errors,notices},null,2));
  console.log('PASS: real temporary HTTPS/SQLite, planner/history/export/full ZIP, five viewports, cleanup cancel/single/all/new-file preservation/lost reply reconciliation, database preservation and fresh browser recovery, zero device commands. '+output);
 }catch(error){fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({errors,notices,failures,requests,stderr},null,2));console.error('Evidence: '+output);throw error;}
 finally{await browser?.close();child.stdin.write(JSON.stringify({command:'shutdown'})+'\n');child.stdin.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
