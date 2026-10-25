// All browser traffic is fulfilled locally. Database is an explicit UI fixture;
// real HTTPS/SQLite receipts are verified by alert-clear.integration.cjs.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-realtime-alerts-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 const errors=[],systemDialogs=[],controls=[];
 try{
  const context=await browser.newContext();
  await context.route('**/*',route=>{
   const r=route.request(),u=new URL(r.url());
   if(u.pathname.startsWith('/api/command'))controls.push(u.pathname);
   if(r.method()==='GET'&&u.origin==='https://localhost:8080'&&
    (u.pathname==='/unirf-app.html'||u.pathname==='/DATYlogo.png'||/^\/src\/.*\.(css|js|png|svg)$/.test(u.pathname)))return route.fulfill({path:path.join(root,decodeURIComponent(u.pathname))});
   return route.fulfill({json:{status:'ok',success:true,devices:[],events:[],projects:[],project:{id:'default'},ip:'127.0.0.1'}});
  });
  await context.addInitScript(()=>{
   window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};
   window.WebSocket=class extends EventTarget{close(){}send(){throw Error('No live sockets');}};
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',async d=>{systemDialogs.push(d.type());await d.dismiss();});
  await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
  await page.evaluate(()=>{
   window.notices=[];window.notify=(...args)=>notices.push(args);window.storedAlerts=new Map();window.failArchive=false;
   window.DatyDatabaseConnection={snapshot:()=>({origin:'https://127.0.0.1:8802',revision:1,source:{id:'layout-fixture'},status:{epoch:'fixture'}}),subscribe:()=>()=>{}};
   window.DatyAlertDatabase={status:()=>({loaded:true,warning:'',pending:null}),load:async()=>({success:true}),records:()=>[...storedAlerts.values()],
    async flush(rows){if(failArchive)return {success:false,error:'Fixture write failure'};
     rows.forEach(r=>storedAlerts.set(r.archiveId,structuredClone(r)));return {success:true,readBackConfirmed:true,changed:rows.length,count:storedAlerts.size,confirmed:rows.map(r=>({id:r.archiveId,snapshot:r}))};}};
   setAlertThresholdSettings({rfWeakDbm:-90,batteryLowPercent:20,afOverloadDbfs:-3});
   window.seedAlerts=()=>{
    _fasheHandleDeviceList([
     {id:'rx-a_ch9',receiver_id:'rx-a',receiver_ip:'192.0.2.102',channel_number:9,name:'Same channel',brand:'DATYaudio',model:'RF PRO',
      group_source:'server-fifo-v1',group_number:11,freq:641000,rf:-40,batt:100,af_dbfs:0,_online:true,status:'online'},
     {id:'rx-b_ch9',receiver_id:'rx-b',receiver_ip:'192.0.2.103',channel_number:9,name:'Same channel',brand:'DATYaudio',model:'RF PRO',
      group_source:'server-fifo-v1',group_number:4,freq:641250,rf:-40,batt:100,af_dbfs:0,_online:true,status:'online'},
     {id:'rx-a_ch1',receiver_id:'rx-a',receiver_ip:'192.0.2.102',channel_number:1,name:'Normal AF',brand:'DATYaudio',model:'RF PRO',
      group_source:'server-fifo-v1',group_number:11,freq:640000,rf:-40,batt:100,af_dbfs:-20,_online:true,status:'online'}]);
   };seedAlerts();switchPanel('dashboard');renderAlerts();
  });
  assert.equal(await page.evaluate(()=>ALERTS.length),2);
  const text=await page.locator('#alertList').innerText();assert.match(text,/192\.0\.2\.102 · GROUP11 · CH9 · DATYaudio RF PRO/);
  assert.match(text,/192\.0\.2\.103 · GROUP4 · CH9/);assert.match(text,/0\.0 dBFS/);assert.doesNotMatch(text,/Normal AF/);
  for(const [width,height]of [[1920,1080],[1366,768],[1024,600]]){
   await page.setViewportSize({width,height});await page.screenshot({path:path.join(output,`overview-${width}x${height}.png`)});
   const overflow=await page.locator('#alertList').evaluate(e=>e.scrollWidth>e.clientWidth+1);assert.equal(overflow,false);
   await page.locator('#realtimeAlertClear').click();await page.locator('#datyConfirmDialog').waitFor();
   assert.equal(await page.locator('#realtimeAlertClear').isDisabled(),true);
   assert.match(await page.locator('#datyConfirmDetails').innerText(),/2 条实时告警/);
   await page.screenshot({path:path.join(output,`confirm-${width}x${height}.png`)});
   const rect=await page.locator('#datyConfirmAccept').boundingBox();assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=width+1&&rect.y+rect.height<=height+1);
   await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>ALERTS.length),2);
  }
  await page.locator('#realtimeAlertClear').click();await page.locator('#datyConfirmAccept').click();
  await page.waitForFunction(()=>ALERTS.length===0);assert.equal(await page.evaluate(()=>storedAlerts.size),2);
  await page.evaluate(()=>{seedAlerts();failArchive=true;});
  await page.locator('#realtimeAlertClear').click();await page.locator('#datyConfirmAccept').click();
  await page.waitForFunction(()=>notices.some(n=>n[1]==='暂未清空'));assert.equal(await page.evaluate(()=>ALERTS.length),2);
  await page.evaluate(()=>{
   const a=DEVICES.find(d=>d._fasheId==='rx-a_ch9');a.afDbfs=null;a.af_dbfs=0;a.af=100;
   evaluateRealtimeAlerts(DEVICES);
  });
  assert.equal(await page.evaluate(()=>ALERTS.length),1);assert.doesNotMatch(await page.locator('#alertList').innerText(),/192\.0\.2\.102/);
  assert.deepEqual(systemDialogs,[]);assert.deepEqual(errors,[]);assert.deepEqual(controls,[]);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,viewports:3,systemDialogs,errors,controls},null,2));
  console.log('PASS: source identity, canonical AF/unknown, app clear/cancel/failure, three viewports; no system dialogs or controls. '+output);
 }catch(error){console.error('Evidence: '+output);throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
