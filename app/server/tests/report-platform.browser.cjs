'use strict';
// Actual production planning/export UI against synthetic devices and isolated API routes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright'),root=path.join(__dirname,'..');
const output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-report-export-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 try{
  const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage(),errors=[],writes=[],dialogs=[],downloads=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.type());await d.dismiss();});
  page.on('download',d=>downloads.push(d));
  await context.route('**/*',route=>{
   const request=route.request(),url=new URL(request.url());
   if(request.method()==='GET'&&url.origin==='https://127.0.0.1:8080'&&
    (url.pathname==='/unirf-app.html'||url.pathname==='/DATYlogo.png'||/^\/src\/.*\.(css|js)$/.test(url.pathname)))return route.fulfill({path:path.join(root,url.pathname)});
   if(request.method()!=='GET')writes.push(url.pathname);
   return route.fulfill({json:{status:'ok',success:true,devices:[],projects:[],events:[],ip:'127.0.0.1',project:{id:'default'}}});
  });
  await context.addInitScript(()=>{
   window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};
   window.WebSocket=class extends EventTarget{close(){}send(){throw Error('Network forbidden');}};
  });
  await page.goto('https://127.0.0.1:8080/unirf-app.html',{waitUntil:'networkidle'});
  await page.evaluate(()=>{window.notices=[];const original=notify;window.notify=(...args)=>{notices.push(args);original(...args);};switchPanel('planner');});
  const open=()=>page.click('#plannerExportReport'),settled=()=>page.waitForFunction(()=>!document.getElementById('plannerExportReport').disabled);
  const accept=async()=>{await page.click('#datyConfirmAccept');await settled();};
  const state=()=>page.evaluate(()=>JSON.stringify([DEVICES,DATY_LAST_COORDINATION,HISTORY,DatyPlanningConstraints.captureConstraintFields()]));
  await open();assert.equal(await page.locator('#datyConfirmDialog').count(),0);assert.equal(await page.textContent('#notifTitle'),'无可导出结果');
  await page.evaluate(()=>{
   window.persistPlanningProject=async()=>{};
   DEVICES.splice(0,DEVICES.length,...[641000,642000,644000].map((freq,i)=>({id:i+1,ch:'CH'+(i+1),channel_number:i+1,brand:'DATYaudio',model:'DATY-X1',name:'Report fixture',freq,planned:0,_source:'manual'})));
   document.getElementById('plannerRange').value='custom';document.getElementById('plannerRangeStart').value='640.000';
   document.getElementById('plannerRangeEnd').value='690.000';document.getElementById('plannerBackupCount').value='0';
  });
  await page.click('.planner-run-button');await page.waitForFunction(()=>!!window.DATY_LAST_COORDINATION);
  const stateBefore=await state();
  for(const [width,height]of[[1920,1080],[1366,768],[1280,720],[1024,768],[1024,600]]){
   await page.setViewportSize({width,height});await open();
   assert.equal(await page.locator('#datyConfirmTitle').textContent(),'导出频率规划报告');
   const details=await page.locator('#datyConfirmDetails').textContent();
   for(const text of ['640.000–690.000 MHz','已规划 3 · 未规划 0','TXT 文本 · UTF-8','DATY_Coordination_'])assert.ok(details.includes(text),text);
   assert.equal(await page.evaluate(()=>document.activeElement.id),'datyConfirmCancel');
   const layout=await page.locator('#datyConfirmDialog').evaluate(el=>{
    const b=el.getBoundingClientRect(),accept=el.querySelector('#datyConfirmAccept').getBoundingClientRect();
    return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,overflow:el.scrollWidth>el.clientWidth+1,acceptBottom:accept.bottom};
   });
   assert.ok(layout.x>=0&&layout.y>=0&&layout.right<=width&&layout.bottom<=height&&layout.acceptBottom<=height);
   assert.equal(layout.overflow,false);assert.equal(await page.isDisabled('#plannerExportReport'),true);
   await page.screenshot({path:path.join(output,`${width}x${height}.png`)});
   await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'datyConfirmClose');
   await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'datyConfirmAccept');
   if(height===600)await page.click('#datyConfirmClose');else if(width===1280)await page.click('#datyConfirmCancel');else await page.keyboard.press('Escape');
   await settled();assert.equal(await page.evaluate(()=>document.activeElement.id),'plannerExportReport');assert.equal(await state(),stateBefore);
  }
  assert.equal(downloads.length,0);assert.deepEqual(writes,[]);
  // A real browser download must preserve every field of the existing report text.
  await open();const nextDownload=page.waitForEvent('download');await accept();
  const download=await nextDownload,text=fs.readFileSync(await download.path(),'utf8');
  const omitTime=s=>s.replace(/^生成时间:.*$/m,'生成时间: <clock>');
  assert.match(download.suggestedFilename(),/^DATY_Coordination_\d{4}-\d{2}-\d{2}\.txt$/);
  const expected=await page.evaluate(()=>DatyCoordinationReport.buildText(DATY_LAST_COORDINATION,DEVICES));
  assert.equal(omitTime(text),omitTime(expected));
  for(const value of ['CH1','CH2','CH3','minimumChannelSpacingKHz=250','未做 WWB6 实测对照'])assert.ok(text.includes(value),value);
  assert.equal(await page.textContent('#notifTitle'),'已开始下载');assert.equal(await state(),stateBefore);
  // Inject the native async output capability without changing the production browser adapter.
  await page.evaluate(()=>{
   window.reportHostWrites=[];
   window.DatyTextExports={VERSION:'daty-text-export-v1',async saveText(text,options){reportHostWrites.push({text,fileName:options.fileName,bound:this===DatyTextExports});return {status:'saved'};}};
  });
  await open();await accept();const host=await page.evaluate(()=>reportHostWrites);
  assert.equal(host.length,1);assert.equal(host[0].bound,true);assert.equal(omitTime(host[0].text),omitTime(text));
  assert.equal(await page.textContent('#notifTitle'),'文件已保存');assert.equal(await state(),stateBefore);
  // Native picker cancellation and failure retain the plan and allow manual retry.
  await page.evaluate(()=>{DatyTextExports.saveText=async()=>({status:'cancelled'});});let count=await page.evaluate(()=>notices.length);
  await open();await accept();assert.equal(await page.evaluate(()=>notices.length),count);
  await page.evaluate(()=>{DatyTextExports.saveText=async()=>{throw Error('fixture output failure');};});
  await open();await accept();assert.equal(await page.textContent('#notifTitle'),'报告导出失败');
  assert.equal(await state(),stateBefore);assert.equal(downloads.length,1);
  // Changed inputs invalidate only the pending export; it must not save any stale text.
  await page.evaluate(()=>{DatyTextExports.saveText=async()=>{reportHostWrites.push({unexpected:true});return {status:'saved'};};});
  await open();await page.evaluate(()=>{document.getElementById('plannerRangeStart').value='645.000';});await accept();
  assert.match(await page.textContent('#notifMsg'),/规划结果或输入已变化/);assert.equal(await page.evaluate(()=>reportHostWrites.length),1);
  await page.evaluate(()=>{document.getElementById('plannerRangeStart').value='640.000';});
  // Page exit cancels an app review; no stale acceptance or unhandled rejection.
  await open();count=await page.evaluate(()=>notices.length);
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await settled();
  assert.equal(await page.locator('#datyConfirmDialog').count(),0);assert.equal(await page.evaluate(()=>notices.length),count);
  assert.equal(await state(),stateBefore);assert.equal(downloads.length,1);assert.deepEqual(writes,[]);assert.deepEqual(dialogs,[]);assert.deepEqual(errors,[]);
  console.log('PASS: report app export, five viewports, real TXT download, native saved/cancel/error, stale inputs, focus/pagehide, complete report preservation; zero system dialogs or external writes. Screenshots: '+output);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
