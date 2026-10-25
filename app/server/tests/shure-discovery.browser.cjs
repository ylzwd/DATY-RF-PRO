'use strict';
// Every request fulfilled from project files or fixtures; no field network/control.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'daty-shure-ui-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 const context=await browser.newContext(),page=await context.newPage();const calls=[],errors=[];let scanError=false;
 const devices=[{id:'FAshe-fixture_ch2',receiver_id:'FAshe-fixture',receiver_ip:'192.0.2.102',channel_number:2,brand:'DATYaudio',model:'RF PRO',name:'CH2',group_number:2,group_source:'server-fifo-v1',freq:640250},
  {id:'Shure-AD4D-192.0.2.20_ch2',receiver_id:'Shure-AD4D-192.0.2.20',receiver_ip:'192.0.2.20',channel_number:2,brand:'Shure',model:'AD4D',name:'Backing <Vox>',freq:642000},
  {id:'Shure-AD4D-192.0.2.20_ch1',receiver_id:'Shure-AD4D-192.0.2.20',receiver_ip:'192.0.2.20',channel_number:1,brand:'Shure',model:'AD4D',name:'Lead',freq:641000}].map(d=>({...d,_source:d.brand==='Shure'?'shure-scp':'fixture:mqtt',_online:true,status:'online',rf:-45,af_dbfs:-10,batt:null,muted:null,
   capabilities:{adapter:d.brand==='Shure'?'shure-scp-readonly':'fashe-mqtt',discover:true,read_frequency:true,write_frequency:false,read_only:true,mute:false}}));
 await context.route('**/*',async route=>{
  const r=route.request(),u=new URL(r.url());calls.push({path:u.pathname,method:r.method()});
  if(r.method()==='GET'&&u.origin==='https://localhost:8080'&&(u.pathname==='/unirf-app.html'||u.pathname==='/DATYlogo.png'||/^\/src\/.*\.(css|js|png|svg)$/.test(u.pathname)))return route.fulfill({path:path.join(root,u.pathname)});
  if(u.pathname==='/api/command')throw Error('Field control forbidden');
  if(u.pathname.startsWith('/api/discovery/shure/'))return route.fulfill({json:{success:true,protocol:'daty-shure-discovery-v1',enabled:true,scanning:false,count:1,scanned:253,targets:253,scopes:[{scan_network:'192.0.2.0/24',limited_to_24:true}],error:scanError?'隔离扫描失败':null}});
  if(u.pathname==='/api/stats')return route.fulfill({json:{success:true,clients:[{receiver_id:'FAshe-fixture',receiver_ip:'192.0.2.102'}],external_receivers:[{ip:'192.0.2.20',receiver_id:'Shure-AD4D-192.0.2.20',model:'AD4D',discovered_via:'shure-scp',ts:Date.now()/1000}]}});
  if(u.pathname==='/api/devices')return route.fulfill({json:{success:true,devices}});
  return route.fulfill({json:{success:true,status:'ok',devices:[],events:[],projects:[],project:{id:'default'},ip:'127.0.0.1'}});
 });
 await context.addInitScript(()=>{window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};window.WebSocket=class extends EventTarget{close(){}send(){throw Error('Socket forbidden');}};});
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
  await page.evaluate(()=>{switchPanel('devices');switchTab('devScan',document.querySelector('[onclick*="devScan"]'));});
  await page.waitForFunction(()=>document.getElementById('receiverList').textContent.includes('Shure AD4D'));
  assert.equal(await page.locator('#discoveredReceivers').isVisible(),true,'initial load restores cards without clicking scan');
  assert.equal(calls.filter(c=>c.path==='/api/discovery/shure/scan').length,0,'page restoration is read-only');
  await page.reload({waitUntil:'networkidle'});
  await page.evaluate(()=>{switchPanel('devices');switchTab('devScan',document.querySelector('[onclick*="devScan"]'));});
  await page.waitForFunction(()=>document.getElementById('receiverList').textContent.includes('Shure AD4D'));
  assert.equal(await page.locator('#discoveredReceivers').isVisible(),true,'refresh restores the result card automatically');
  assert.match(await page.locator('#receiverList').textContent(),/DATYaudio RF PRO/);
  assert.equal(calls.filter(c=>c.path==='/api/discovery/shure/scan').length,0);
  await page.evaluate(devices=>{_fasheHandleDeviceList(devices);switchPanel('devices');switchTab('devScan',document.querySelector('[onclick*="devScan"]'));},devices);
  for(const [width,height] of [[1920,1080],[1366,768],[1024,600]]){
   await page.setViewportSize({width,height});await page.evaluate(()=>scanForReceivers());
   await page.waitForFunction(()=>document.getElementById('btnRecvScan').disabled===false);
   assert.match(await page.locator('#receiverList').innerText(),/Shure AD4D · 只读/);
   assert.match(await page.locator('#receiverList').innerText(),/DATYaudio RF PRO/);
   assert.doesNotMatch(await page.locator('#receiverList').innerText(),/FAshe/);
   assert.match(await page.locator('#recvScanStatusText').innerText(),/2 台接收机，3 个通道/);
   assert.match(await page.locator('#recvScanHint').innerText(),/未覆盖整个子网/);
   const text=await page.locator('#receiverList').innerText();assert.ok(text.indexOf('Lead')<text.indexOf('Backing <Vox>'));
   assert.equal(await page.locator('#receiverList script').count(),0);
   const overflow=await page.evaluate(()=>['html','body','#receiverList'].filter(s=>{const e=document.querySelector(s);return e.scrollWidth>e.clientWidth+1;}));
   assert.deepEqual(overflow,[]);
   await page.screenshot({path:path.join(out,`${width}x${height}.png`)});
   // Product summary is also live in data management and the spectrum source.
   await page.evaluate(()=>{forceRefreshAllPanels();switchPanel('data');switchTab('dataImport',document.getElementById('dataImportTab'));});
   assert.match(await page.locator('#receiverDataTitle').innerText(),/DATYaudio RF PRO.*Shure AD4D/);
   await page.screenshot({path:path.join(out,`data-${width}x${height}.png`)});
   await page.evaluate(()=>{_fasheConnected=true;switchPanel('spectrum');});
   assert.match(await page.locator('#deviceDataSource').innerText(),/DATYaudio RF PRO.*Shure AD4D/);
   const spectrumOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1);
   assert.equal(spectrumOverflow,false);
   await page.screenshot({path:path.join(out,`spectrum-${width}x${height}.png`)});
   await page.evaluate(()=>{switchPanel('devices');switchTab('devScan',document.querySelector('[onclick*="devScan"]'));});
  }
  scanError=true;await page.evaluate(()=>scanForReceivers());assert.match(await page.locator('#recvScanHint').innerText(),/隔离扫描失败/);
  // Real production SSE handlers drive this view too; no new command/publication path.
  await page.evaluate(()=>_fasheHandleDeviceUpdate([{id:'FAshe-fixture_ch2',freq:646000,batt:73}]));
  await page.waitForFunction(()=>document.getElementById('receiverList').textContent.includes('646.000 MHz'));
  assert.match(await page.locator('#receiverList').textContent(),/73%/);
  await page.evaluate(()=>_fasheMarkDevicesOffline());
  assert.match(await page.locator('#receiverList').textContent(),/离线 · 上次数据/);
  await page.evaluate(devices=>_fasheHandleDeviceList(devices),devices);
  await page.evaluate(()=>_fasheHandleDeviceList([]));
  assert.equal(await page.locator('#discoveredReceivers').isVisible(),true);
  assert.match(await page.locator('#receiverList').textContent(),/离线 · 上次数据/);
  await page.evaluate(devices=>_fasheHandleDeviceList(devices),devices);
  await page.waitForFunction(()=>!document.getElementById('receiverList').textContent.includes('离线 · 上次数据'));
  const stable=await page.evaluate(devices=>{
    const card=document.getElementById('receiverList').firstElementChild;
    _fasheHandleDeviceList(devices);
    return document.getElementById('receiverList').firstElementChild===card;
  },devices);assert.equal(stable,true,'same snapshot retains existing card DOM');
  assert.equal(await page.locator('#btnRecvScan').isVisible(),false,'summary card stays hidden');
  const result=await page.evaluate(()=>{
   switchTab('devOnline',document.getElementById('tabOnlineCount'));renderDevTable();
   return [...document.querySelectorAll('#devTableBody tr[data-device-key]')].map(row=>row.children[0].textContent+' '+row.children[1].textContent);
  });
  assert.match(result[0],/GROUP2.*CH2/);assert.match(result[1],/CH1/);assert.match(result[2],/CH2/);
  await page.evaluate(()=>{
    _fasheHandleDeviceUpdate([{id:'FAshe-fixture_ch2',brand:'AMSaudio',model:'GT6000'}]);
    forceRefreshAllPanels();switchPanel('data');switchTab('dataImport',document.getElementById('dataImportTab'));
  });
  assert.match(await page.locator('#receiverDataTitle').innerText(),/AMSaudio GT6000/);
  assert.doesNotMatch(await page.locator('#receiverDataTitle').innerText(),/DATYaudio RF PRO/);
  assert.equal(calls.filter(c=>c.path==='/api/command').length,0);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({viewports:3,controls:0,errors,ordering:result},null,2));
  console.log(JSON.stringify({passed:true,output:out,viewports:3,controls:0}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
