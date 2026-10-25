'use strict';
// Full page + actual view handlers; synthetic ports, no live network or controls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..');
(async()=>{
  const out=process.env.DATY_DATA_SHOTS||fs.mkdtempSync(path.join(os.tmpdir(),'daty-data-r19-'));fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch({headless:true,executablePath:process.env.EDGE_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const context=await browser.newContext(),errors=[],writes=[];
  try{
    await context.route('**/*',route=>{
      const req=route.request(),url=new URL(req.url());
      if(req.method()==='GET'&&url.origin==='https://localhost:8080'&&(url.pathname==='/unirf-app.html'||url.pathname==='/DATYlogo.png'||/^\/src\/.*\.(js|css|png|svg)$/.test(url.pathname)))return route.fulfill({path:path.join(root,decodeURIComponent(url.pathname))});
      if(req.method()!=='GET')writes.push(url.pathname);
      return route.fulfill({json:{success:true,devices:[],projects:[],events:[],ip:'127.0.0.1'}});
    });
    await context.addInitScript(()=>{window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};window.WebSocket=class extends EventTarget{close(){}};});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
    await page.evaluate(()=>{
      window.fixtureCalls=[];window.fixtureImports=[];
      window.DatyDatabaseConnection={snapshot:()=>({origin:'https://fixture.invalid',revision:1,source:{id:'fixture'},status:{epoch:'fixture'}}),request:async(url,options)=>{
        const route=new URL(url).pathname.split('/api/database/')[1];fixtureCalls.push({route,method:options.method});
        const data=route==='storage-status'?{databaseBytes:75161927680,diskFreeBytes:150323855360,archives:53,exports:53,cleanupProtocol:'daty-archive-cleanup-v1',archiveBusy:false}
          :{items:Array.from({length:53},(_,i)=>({id:(route+'-'+i).padEnd(32,'x'),fileName:route==='archives'?`DATY_full_20260920_${i}.zip`:`DATY_plan_${i}.csv`,status:i%9===0?'failed':'saved',bytes:1024*(i+1),createdAtMs:1790000000000-i*60000}))};
        return {ok:true,status:200,json:async()=>({success:true,...data})};},subscribe:()=>()=>{}};
      const alerts=Array.from({length:205},(_,i)=>({archiveId:'alarm-'+i,deviceId:`GROUP${i%2+1} CH${i%50+1}`,receiverIP:i%2?'192.0.2.103':'192.0.2.102',metric:'rf',level:i%3?'warn':'crit',msg:`RF 弱信号：当前 -93 dBm，阈值 -90 dBm`,firstSeen:1790000000000-i*60000,lastSeen:1790000001000,archiveState:i%2?'ended':'active',endedAt:i%2?1790000001000:null}));
      window.DatyAlertDatabase={status:()=>({loaded:true,warning:'',pending:null}),records:()=>alerts,load:async()=>({success:true})};
      HISTORY.splice(0,HISTORY.length,...Array.from({length:53},(_,i)=>({id:'plan-'+i,name:'现场方案 '+i,projectId:'default',timestamp:1790000000000-i*1000,time:'2026/9/20 20:30',channels:100,algo:i%2?'标准':'紧凑',imdConflicts:i%9===0?2:0,imdMargin:250,constraints:{excludedRanges:[],lockedAssignments:[],knownCarriers:[]}})));
      window.DatyBusinessDatabase={savePage:async()=>true,saveImportedScan:async file=>{fixtureImports.push(file.name);setImportedScanPoints(DatyScanCsv.parseScanCsv(file.text).points,file.name);return true;}};
      window.DatyTextFileFactory={cancelPending(){},openLatest:async()=>({status:'completed',name:'现场扫描.csv',text:'Frequency (MHz),Level (dBm)\n641.000,-80\n665.250,-85\n641.000,-82',isCurrent:()=>true})};
      switchPanel('data');renderHistory();
    });
    await page.addStyleTag({content:'#notif{display:none!important}'}); // Hide only fixture network notices in screenshots.
    const layouts=[];
    for(const [width,height]of [[1366,900],[1024,600]]){
      await page.setViewportSize({width,height});
      for(const [id,name]of [['dataHistory','history'],['dataImport','import'],['dataLog','alerts'],['dataServer','archives']]){
        await page.locator('#'+id+'Tab').click();
        if(id==='dataServer')await page.waitForFunction(()=>document.querySelectorAll('#serverArchiveList tr').length===20);
        if(id==='dataLog')await page.waitForFunction(()=>document.querySelectorAll('#logBody tr').length===20);
        assert.equal(await page.locator('#panel-data [role="tab"][aria-selected="true"]').getAttribute('id'),id+'Tab');
        await page.screenshot({path:path.join(out,`${name}-${width}x${height}.png`),animations:'disabled'});
        if(id==='dataServer'){const box=await page.locator('#serverArchivePagination').boundingBox();assert.ok(box.y+box.height<=height,'archive pager always visible');}
        const measure=await page.locator('#'+id).evaluate(e=>({width:e.clientWidth,scrollWidth:e.scrollWidth}));
        assert.ok(measure.scrollWidth<=measure.width+1,`${id} horizontal page overflow`);layouts.push({id,width,height,...measure});
      }
    }
    await page.setViewportSize({width:1366,height:900});
    await page.locator('#dataHistoryTab').click();await page.locator('#historySearch').fill('现场方案 52');
    assert.equal(await page.locator('#historyBody tr').count(),1);assert.match(await page.locator('#historyBody').textContent(),/现场方案 52/);
    assert.match(await page.locator('#historyBody button').first().getAttribute('onclick'),/plan-52/);await page.locator('#historySearch').fill('');
    await page.locator('#dataLogTab').click();await page.locator('#alertLevelFilter').selectOption('crit');await page.locator('#alertStateFilter').selectOption('active');
    assert.match(await page.locator('#alertFilterCount').textContent(),/显示 35 \/ 共 205/);
    assert.equal(await page.locator('#logBody tr').count(),20);await page.locator('#logNextPage').click();assert.equal(await page.locator('#logBody tr').count(),15);
    await page.locator('#dataServerTab').click();await page.locator('#archiveSearch').fill('plan_52');
    assert.equal(await page.locator('#serverArchiveList tr').count(),1);assert.match(await page.locator('#serverArchiveList').textContent(),/DATY_plan_52.csv/);
    await page.locator('#archiveSearch').fill('');await page.locator('#serverArchiveNext').click();assert.match(await page.locator('#serverArchivePageInfo').textContent(),/第 2\/6 页/);
    await page.locator('#dataImportTab').click();const button=page.locator('.data-import-card').last();await button.focus();await page.keyboard.press('Enter');
    await page.locator('#datyConfirmAccept').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>fixtureImports.length),0);
    await page.screenshot({path:path.join(out,'import-preview.png')});await page.locator('#datyConfirmCancel').click();assert.equal(await page.evaluate(()=>fixtureImports.length),0);
    await button.click();await page.locator('#datyConfirmAccept').click();await page.waitForFunction(()=>fixtureImports.length===1);
    assert.match(await page.locator('#scanImportStatus').textContent(),/已保存到服务器/);
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,layouts,errors,writes},null,2));console.log('PASS four views, filters, stable actions, 20-row pagination, keyboard, preview/cancel/save; screenshots: '+out);
  }finally{await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
