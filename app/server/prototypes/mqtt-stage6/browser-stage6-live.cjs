'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const [url,certPath,playwrightPath,executable,output]=process.argv.slice(2);
const {chromium}=require(playwrightPath);
const certificate=new crypto.X509Certificate(fs.readFileSync(certPath));
const pin=crypto.createHash('sha256').update(certificate.publicKey.export({type:'spki',format:'der'})).digest('base64');
(async()=>{
 const browser=await chromium.launch({executablePath:executable,headless:true,args:['--ignore-certificate-errors-spki-list='+pin]});
 try{
  // Only this ephemeral fixture leaf key is pinned. Normal Node MQTT/TLS tests
  // separately verify the fixture CA. Never blanket-disable certificate checks.
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  const errors=[],requests=[],blocked=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
  page.on('request',r=>requests.push({url:r.url(),type:r.resourceType(),method:r.method()}));
  await context.route('**/*',route=>{
    const u=new URL(route.request().url());
    if(u.hostname!=='127.0.0.1'&&u.protocol!=='blob:'&&u.protocol!=='data:'){
      blocked.push(u.origin);return route.abort();
    }
    return route.continue();
  });
  await page.goto(url,{waitUntil:'load',timeout:20000});
  await page.waitForFunction(()=>typeof DEVICES!=='undefined'&&DEVICES.filter(d=>d._online!==false&&d._fasheId).length===4,{timeout:15000});
  await page.waitForTimeout(1200);
  await page.waitForFunction(()=>DatyServerStorage.ready,null,{timeout:25000});
  const state=await page.evaluate(()=>({devices:DEVICES.map(d=>({id:d._fasheId,group:d.group,ch:d.channel_number??d.channel,source:d._source})),
    database:DatyDatabaseConnection.snapshot(),audit:DatyMqttAudit}));
  for(const panel of ['dashboard','channels','planner','devices','data','settings']){
    await page.evaluate(panel=>switchPanel(panel,document.querySelector('[onclick*="'+panel+'"]')),panel);
    await page.waitForTimeout(80);
  }
  const domain=async(path,body)=>page.evaluate(async({path,body})=>{
    const origin=DatyDatabaseConnection.snapshot().origin;
    const response=await DatyPlatform.request(origin+path,body?{method:'POST',body:JSON.stringify(body)}:{});
    return {status:response.status,body:await response.json()};
  },{path,body});
  await page.evaluate(()=>switchPanel('planner'));
  await page.selectOption('#plannerRange','custom');await page.fill('#plannerRangeStart','640');await page.fill('#plannerRangeEnd','690');
  await page.click('#plannerConstraintsTab');await page.fill('#plannerBackupCount','0');
  // Selection is a preview. Only the original add/remove buttons commit locks.
  const option=await page.locator('#plannerLockChannel option:not([value=""])').first().getAttribute('value');
  const initialLocks=await page.inputValue('#plannerLockedAssignments');
  await page.selectOption('#plannerLockChannel',option);
  assert.equal(await page.inputValue('#plannerLockedAssignments'),initialLocks);
  await page.fill('#plannerLockNote','鼓手');await page.click('#plannerConfirmLock');
  assert.match(await page.inputValue('#plannerLockedAssignments'),/鼓手/);
  await page.selectOption('#plannerLockChannel','lock:0');await page.click('#plannerRemoveLock');
  assert.equal(await page.inputValue('#plannerLockedAssignments'),initialLocks);
  await page.click('#plannerBasicTab');
  const plans=[];
  for(const [level,imd,threshold]of [['standard',250,-78],['robust',150,-75],['more-frequencies',0,-72]]){
    await page.selectOption('#plannerCompatibility',level);
    await page.locator('[data-planner-action="plan"]').click();
    await page.waitForFunction(()=>!!DATY_LAST_COORDINATION,null,{timeout:15000});
    await page.waitForFunction(()=>/已保存到当前项目/.test(document.getElementById('plannerConstraintSaveStatus').textContent),null,{timeout:15000}).catch(async error=>{
      const diagnostic=await page.evaluate(()=>({planner:document.getElementById('plannerConstraintSaveStatus').textContent,
        storage:document.getElementById('serverStorageStatus').textContent,audit:DatyMqttAudit,
        database:DatyDatabaseConnection.snapshot(),text:document.body.innerText.slice(-6000)}));
      fs.writeFileSync(output+'/browser-planning-failure.json',JSON.stringify({level,diagnostic,errors},null,2));throw error;
    });
    const record=await page.evaluate(()=>getCurrentPlanningRecord());
    const saved=await domain('/api/database/resources/planning_runs/'+encodeURIComponent(record.id));
    assert.equal(saved.status,200,JSON.stringify(saved));const run=saved.body.resource.value;
    assert.equal(run.input.options.compatibilityLevel,level);assert.equal(run.result.assignments.length,4);
    for(const item of run.result.compatibility.devices)assert.deepEqual([item.channelSpacingKHz,item.intermodSpacingKHz,item.scanThresholdDbm],[250,imd,threshold]);
    plans.push(record.id);
  }
  await page.click('#plannerPushAll');await page.locator('#datyConfirmDialog').waitFor();
  await page.click('#datyConfirmCancel');await page.waitForFunction(()=>!DatyPlanningDeployment.isBusy());
  await page.click('#plannerPushAll');await page.locator('#datyConfirmDialog').waitFor();
  assert.equal(await page.locator('#datyConfirmRows tr').count(),4);
  await page.click('#datyConfirmAccept');await page.waitForFunction(()=>!DatyPlanningDeployment.isBusy(),null,{timeout:25000});
  if(!/下发成功/.test(await page.locator('#datyProgressTitle').innerText())){
    fs.writeFileSync(output+'/deployment-failure.json',JSON.stringify(await page.evaluate(()=>({
      text:document.getElementById('datyProgressDialog').innerText,audit:DatyMqttAudit,
      devices:DEVICES.map(d=>({id:d.id,receiver:d._fasheId,ip:d.receiver_ip,source:d._source,freq:d.freq})),
      diagnostics:globalThis.DATY_DEPLOYMENT_DIAGNOSTICS||null})),null,2));
  }
  assert.match(await page.locator('#datyProgressTitle').innerText(),/下发成功/);
  assert.equal(await page.$eval('#datyProgressBar',bar=>bar.value),4);await page.click('#datyProgressClose');
  // Original export coordinator persists exact bytes before the browser host.
  const text='\ufeff真实导出,AF\r\n通道,-12\r\n'.repeat(15000);
  const archive=await page.evaluate(text=>DatyServerStorage.archiveText(text,{fileName:'MQTT完整性.csv',mimeType:'text/csv',source:'m6-isolated-acceptance'}),text);
  const repeatedBody={operation_id:crypto.randomUUID().replaceAll('-',''),text:'已消费上传仍能查询同一操作\r\n',fileName:'重复导出.txt',mimeType:'text/plain',source:'m6-isolated-repeat'};
  const firstExport=await domain('/api/database/exports',repeatedBody),sameExport=await domain('/api/database/exports',repeatedBody);
  assert.equal(firstExport.status,200,JSON.stringify(firstExport));assert.deepEqual(sameExport,firstExport);
  assert.equal((await domain('/api/database/exports',{...repeatedBody,fileName:'改名.txt'})).status,409);
  assert.equal((await domain('/api/database/exports',{...repeatedBody,text:'改变内容'})).status,409);
  await page.evaluate(()=>{switchPanel('data');document.getElementById('dataServerTab').click();});
  await page.evaluate(()=>DatyServerStorage.refresh());
  const downloadPromise=page.waitForEvent('download');
  await page.locator('#serverArchiveList tr').filter({hasText:'MQTT完整性.csv'}).getByRole('link',{name:'下载',exact:true}).click();
  const download=await downloadPromise;await download.saveAs(output+'/verified-download.csv');
  const raw=fs.readFileSync(output+'/verified-download.csv');assert.equal(raw.toString('utf8'),text);
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),archive.sha256);
  const largePromise=page.waitForEvent('download',{timeout:90000});
  await page.locator('#serverArchiveList tr').filter({hasText:'MQTT大型下载.zip'}).getByRole('link',{name:'下载',exact:true}).click();
  const largeDownload=await largePromise;await largeDownload.saveAs(output+'/verified-large-download.zip');
  const largeBytes=fs.statSync(output+'/verified-large-download.zip').size;assert.ok(largeBytes>64*1024*1024);
  const row=page.locator('#serverArchiveList tr').filter({hasText:'MQTT完整性.csv'});
  await row.getByRole('button',{name:'删除',exact:true}).click();await page.locator('#datyConfirmDialog').waitFor();await page.click('#datyConfirmCancel');
  assert.equal((await domain('/api/database/exports/'+archive.id)).body.record.status,'saved');
  await row.getByRole('button',{name:'删除',exact:true}).click();await page.locator('#datyConfirmDialog').waitFor();await page.click('#datyConfirmAccept');
  await page.waitForFunction(()=>document.getElementById('serverStorageStatus').textContent.includes('已清理 1 份'));
  assert.equal((await domain('/api/database/exports/'+archive.id)).body.record.status,'deleted');
  await page.evaluate(async()=>{
    for(let i=0;i<205;i++)queueAlertForArchive({id:'mqtt-fixture-'+i,archiveId:'mqtt-fixture-'+i,deviceId:'rx',ts:1000+i,firstSeen:1000+i,lastSeen:2000+i,msg:'Fixture '+i,metric:'rf'},'ended');
  });
  await page.evaluate(()=>document.getElementById('dataLogTab').click());
  await page.click('#logSaveNow');
  await page.waitForFunction(()=>!_alertManualSavePending&&_pendingAlertArchive.size===0);
  await page.click('#logArchiveView');await page.waitForFunction(()=>!_alertArchiveReading);
  assert.equal(await page.evaluate(()=>readAlertArchive().filter(x=>x.id.startsWith('mqtt-fixture-')).length),205);
  await page.click('#logClearDisplay');assert.equal(await page.locator('#logCount').innerText(),'0');
  await page.click('#logArchiveView');await page.waitForFunction(()=>!_alertArchiveReading);
  assert.equal(await page.evaluate(()=>readAlertArchive().filter(x=>x.id.startsWith('mqtt-fixture-')).length),205);
  await page.click('#logTimelineView');await page.waitForFunction(()=>!getServerTimelineState().loading);
  assert.equal(await page.evaluate(()=>getServerTimelineState().error),false);
  assert.equal(await page.locator('#logSaveNow').isDisabled(),true);
  const timelineCount=Number(await page.locator('#logCount').innerText());assert.ok(timelineCount>0);
  await page.click('#logClearDisplay');assert.equal(await page.locator('#logCount').innerText(),'0');
  await page.click('#logTimelineView');await page.waitForFunction(()=>!getServerTimelineState().loading);
  assert.ok(Number(await page.locator('#logCount').innerText())>=timelineCount);
  await page.click('#logArchiveView');await page.waitForFunction(()=>!_alertArchiveReading);
  await page.click('#logClearStorage');await page.locator('#datyConfirmDialog').waitFor();await page.click('#datyConfirmCancel');
  await page.waitForFunction(()=>!_alertArchiveClearPending);
  assert.equal(await page.evaluate(()=>readAlertArchive().filter(x=>x.id.startsWith('mqtt-fixture-')).length),205);
  await page.click('#logClearStorage');await page.locator('#datyConfirmDialog').waitFor();await page.click('#datyConfirmAccept');
  await page.waitForFunction(()=>!_alertArchiveClearPending);
  assert.equal(await page.evaluate(()=>readAlertArchive().filter(x=>x.id.startsWith('mqtt-fixture-')).length),0);
  await page.reload({waitUntil:'load'});await page.waitForFunction(()=>DatyServerStorage.ready,null,{timeout:25000});
  for(const id of plans)assert.equal(await page.evaluate(id=>HISTORY.some(x=>x.id===id),id),true);
  await page.evaluate(()=>{switchPanel('data');document.getElementById('dataServerTab').click();});
  await page.screenshot({path:output+'/page-data.png',fullPage:false});
  const audit=await page.evaluate(()=>DatyMqttAudit);
  const business=requests.filter(r=>/\/api\/|\/health(?:\?|$)|local-ip\.json/.test(r.url));
  const result={ok:!!state.database.source&&state.devices.length===4&&business.length===0&&audit.every(x=>x.type!=='forbidden'),
    transport:'MQTT',tls:'isolated fixture leaf SPKI pin; Node verifies CA separately',
    devices:state.devices,database_connected:!!state.database.source,actual_business_http:business,
    forbidden_calls:audit.filter(x=>x.type==='forbidden'),blocked_remote_origins:blocked,
    page_errors:errors,logical_routes:[...new Set(audit.filter(x=>x.type==='mqtt-route').map(x=>x.path))],
    verified_actions:{lock_preview_add_remove:true,three_modes_saved:plans.length,export_verified_bytes:raw.length,
      opfs_available:await page.evaluate(()=>!!navigator.storage?.getDirectory),deployment_cancel_and_four_acks:true,delete_cancel_confirm:true,
      export_repeat_and_conflict:true,export_repeat_id:repeatedBody.operation_id,large_download_bytes:largeBytes,
      alerts_archived:205,alert_five_buttons:true,timeline_display_clear_preserves_database:true,history_after_reload:true},
    full_feature_acceptance:false};
  fs.writeFileSync(output+'/browser-result.json',JSON.stringify(result,null,2));
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  console.log(JSON.stringify({ok:result.ok,channels:state.devices.length,actual_business_http:business.length,page_errors:errors.length}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
