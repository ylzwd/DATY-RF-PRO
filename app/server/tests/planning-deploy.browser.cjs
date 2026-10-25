// Real server browser UI + current FAshe message/identity handler in isolated VMs.
// Every API/socket is intercepted; no production control or project write is possible.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const {chromium}=require('playwright'),root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'../FAshe/index.html'),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
const capabilities={adapter:'fashe-mqtt',write_frequency:true,read_frequency:true,read_only:false,mute:true,
 frequency_control:{scope:'fashe-protocol',min_khz:400000,max_khz:900000,step_khz:1,origin_khz:0,ack_mode:'command-id',brand_binding:'expected-brand-v1'}};
function receiver(n,freqs){
 const ip=`192.0.2.${n}`,mac=`02:00:00:00:00:0${n}`,rid='FAshe-MAC-'+mac.replaceAll(':',''),reports=[],cards=[];
 const devices=freqs.map((f,i)=>({id:i+1,channel:i+1,name:`Receiver ${n} CH${i+1}`,brand:'DATYaudio',model:'DATY-X1',frequency:f,muted:false,rfLevel:-50,afLevel:-12,battery:90}));
 const c=vm.createContext({isCurrentSession:()=>true,checkpointChannels(){},console:{log(){}},devices,performance,messageCount:0,groupMapping:{},GROUP_NUMBER:9,
  getReceiverIP:()=>ip,getReceiverClientId:()=>`FAshe-${ip}`,getLocalMacAddress:()=>mac,masterNowMs:Date.now,
  MQTT_TOPIC_RECEIVE:'down',MQTT_TOPIC_SEND:'up',MQTT_TOPIC_CLOCK_SYNC:'clock',
  mqttClient:{connected:true,publish:(topic,body)=>reports.push({topic,body:JSON.parse(body)})},
  DATYaudioProfile:{clampAfDbfs:x=>Math.max(-40,Math.min(0,x))},scheduleRealtimeStats(){},log(){},
  updateDeviceMeters:list=>cards.push(...list.map(d=>({id:d.id,frequency:d.frequency}))),document:{getElementById(){throw Error('Unexpected DOM before ACK');}}});
 vm.runInContext(section('    function parseChannelNumber(','    // MQTT 连接 ID'),c);
 vm.runInContext(section('    function sendDeviceStatus(','    // 发送指令到服务器（保留兼容）'),c);
 c.mqttClient.on=(_name,handler)=>c.handle=handler;
 vm.runInContext(section("        mqttClient.on('message', function(topic, message) {","        mqttClient.on('error'"),c);
 return {c,devices,reports,cards,rid,ip,mac,snapshot:()=>devices.map(d=>({id:`${rid}_ch${d.channel}`,receiver_id:rid,receiver_ip:ip,ip,receiver_mac:mac,
  channel_number:d.channel,channel:d.channel,ch:`CH${d.channel}`,brand:d.brand,model:d.model,name:d.name,freq:Math.round(d.frequency*1000),muted:d.muted,
  _online:true,status:'online',_source:`${rid}:mqtt:isolated-session`,rf:-50,af_dbfs:-12,batt:90,capabilities}))};
}
(async()=>{
 const receivers=[receiver(1,[641,645]),receiver(2,[655])],commands=[],errors=[],nativeDialogs=[],output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-planning-deploy-'));
 let ackGate=null,corruptNextAck=false,authReads=0;
 function gateNextAck(){let release;const promise=new Promise(resolve=>{release=resolve;});ackGate={promise};return release;}
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 try{
  const context=await browser.newContext({viewport:{width:1366,height:768}}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{nativeDialogs.push(d.message());await d.dismiss();});
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(req.method()==='GET'&&url.origin==='https://localhost:8080'&&(url.pathname==='/unirf-app.html'||/^\/src\/.*\.(css|js)$/.test(url.pathname)))return route.fulfill({path:path.join(root,url.pathname)});
   if(url.pathname==='/api/auth/status'){authReads++;throw Error('Removed authorization API requested');}
   if(url.pathname==='/api/command'){
    assert.equal(req.headers().authorization,undefined);
    assert.equal(url.hostname,'127.0.0.1');const cmd=JSON.parse(req.postData());assert.equal(cmd.command,'set_freq');commands.push(cmd);
    const command_id=`fixture-command-${commands.length}`;const outgoing={...cmd,command_id};
    const before=receivers.map(r=>r.reports.length);
    // The same packet reaches both VM receivers. Production FAshe identity logic must reject the other IP/MAC.
    receivers.forEach(r=>r.c.handle('down',JSON.stringify(outgoing)));
    const changed=receivers.filter((r,i)=>r.reports.length>before[i]);assert.equal(changed.length,1);
    const receiver=changed[0],report=receiver.reports.at(-1).body;
    assert.equal(report.command_id,command_id);assert.equal(report.freq_mhz,cmd.value);assert.equal(report.channel_number,cmd.channel_number);
    assert.equal(receiver.cards.at(-1).frequency,cmd.value);assert.equal(receiver.cards.at(-1).id,cmd.channel_number);
    const device=receiver.snapshot().find(d=>d.channel_number===cmd.channel_number);
    assert.equal(cmd.expected_brand,'datyaudio');
    const ack={command_id,client_request_id:cmd.client_request_id,device_id:device.id,command:'set_freq',actual_value:report.freq_mhz,status:'acknowledged',brand:device.brand,expected_brand:cmd.expected_brand};
    if(corruptNextAck){corruptNextAck=false;ack.actual_value+=0.25;}
    // Delay only the isolated receiver's confirmation, never a production device.
    const gate=ackGate;ackGate=null;if(gate)await gate.promise;
    await page.evaluate(({device,ack})=>{
     testSse.dispatchEvent(new MessageEvent('device_update',{data:JSON.stringify({devices:[device]})}));
     testSse.dispatchEvent(new MessageEvent('command_update',{data:JSON.stringify({data:ack})}));
    },{device,ack});
    await new Promise(resolve=>setTimeout(resolve,300));
    try{return await route.fulfill({json:{success:true,command_id,command_record:ack}});}catch(error){if(!req.failure())throw error;return;}
   }
   return route.fulfill({json:{status:'ok',success:true,devices:[],projects:[],events:[],ip:'127.0.0.1',project:{id:'isolated',name:'Isolated planning deployment'}}});
  });
  await context.addInitScript(()=>{window.setInterval=()=>0;window.EventSource=class extends EventTarget{readyState=1;constructor(){super();window.testSse=this;}close(){this.readyState=2;}};window.WebSocket=class extends EventTarget{close(){}send(){throw Error('No live sockets');}};});
  await page.goto('https://localhost:8080/unirf-app.html');await page.waitForFunction(()=>!!window.testSse);
  await page.evaluate(snapshot=>{
   deviceServiceManager.stopDiscovery();deviceServiceManager.startDiscovery=()=>{};window.notify=()=>{};window.persistPlanningProject=async()=>{};
   testSse.dispatchEvent(new MessageEvent('device_list',{data:JSON.stringify({devices:snapshot})}));switchPanel('planner');
  },receivers.flatMap(r=>r.snapshot()));
  await page.fill('#plannerRangeStart','640.000');await page.fill('#plannerRangeEnd','690.000');assert.equal(await page.inputValue('#plannerRange'),'custom');
  await page.getByRole('button',{name:'安全参数',exact:true}).click();await page.fill('#plannerStepKHz','25');await page.fill('#plannerMinSpacingKHz','500');
  await page.selectOption('#plannerImdPolicy','third-fifth');
  await page.locator('#plannerSafetyDialog').getByRole('button',{name:'关闭 ×'}).click();
  await page.click('.planner-run-button');await page.waitForFunction(()=>DATY_LAST_COORDINATION?.search.complete);
  assert.deepEqual(await page.evaluate(()=>DATY_LAST_COORDINATION.options.imdOrders),[3,5]);
  assert.ok(await page.evaluate(()=>DATY_LAST_COORDINATION.assignments.every(a=>a.frequencyKHz%250===0)));
  const ids=await page.evaluate(()=>Object.fromEntries(DEVICES.map(d=>[d._fasheId,d.id])));
  // Manual frequency changes now enter the same hard-constraint pipeline, not a shadow text box.
  for(const [rid,ch,value]of [[receivers[0].rid,1,'642.000'],[receivers[0].rid,2,'647.000'],[receivers[1].rid,1,'658.000']]){
   await page.fill('#fi_'+ids[`${rid}_ch${ch}`],value);await page.locator('#plannerPageInfo').click();
  }
  await page.click('#plannerConstraintsTab');assert.match(await page.textContent('#plannerLockCount'),/3/);await page.fill('#plannerBackupCount','0');
  await page.selectOption('#plannerLockChannel','lock:0');await page.fill('#plannerLockNote','主持人');await page.click('#plannerConfirmLock');
  await page.click('.planner-run-button');await page.waitForFunction(()=>DATY_LAST_COORDINATION?.search.complete);
  const rawBefore=receivers.flatMap(r=>r.devices.map(d=>d.frequency));assert.deepEqual(rawBefore,[641,645,655]);
  const otherId=ids[`${receivers[1].rid}_ch1`];
  assert.equal(await page.locator('#datyAccessDialog,#datyAccessButton').count(),0);
  assert.equal(await page.evaluate(()=>typeof window.DatyAccess),'undefined');
  await page.click('#plannerPushAll');await page.locator('#datyConfirmDialog').waitFor({state:'visible'});
  assert.equal(commands.length,0);await page.click('#datyConfirmCancel');
  await page.waitForFunction(()=>!DatyPlanningDeployment.isBusy());assert.equal(commands.length,0);
  await page.locator(`#fi_${otherId}`).locator('xpath=ancestor::tr').getByRole('button',{name:'下发',exact:true}).click();
  await page.locator('#datyConfirmDialog').waitFor({state:'visible'});
  assert.match(await page.textContent('#datyConfirmTitle'),/单通道/);
  assert.equal(await page.locator('#datyConfirmRows tr').count(),1);
  assert.match(await page.textContent('#datyConfirmRows'),/192\.0\.2\.2/);
  assert.match(await page.textContent('#datyConfirmRows'),/655\.000/);
  assert.match(await page.textContent('#datyConfirmRows'),/658\.000/);
  assert.equal(commands.length,0,'The preview must not send commands before approval.');
  await page.click('#datyConfirmCancel');
  await page.waitForFunction(()=>!DatyPlanningDeployment.isBusy());
  assert.equal(commands.length,0,'Cancel must never send a device command.');
  assert.equal(await page.locator('#datyProgressDialog').isVisible(),false,'Cancellation must not open deployment progress.');
  await page.locator(`#fi_${otherId}`).locator('xpath=ancestor::tr').getByRole('button',{name:'下发',exact:true}).click();
  const releaseSingle=gateNextAck(),singleRequest=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/command');
  await page.click('#datyConfirmAccept');
  await singleRequest;await page.locator('#datyProgressDialog').waitFor({state:'visible'});
  assert.equal(await page.$eval('#datyProgressBar',bar=>bar.value),0,'Published command is not receiver confirmation.');
  assert.equal(await page.$eval('#datyProgressBar',bar=>bar.max),1);
  assert.equal(await page.evaluate(id=>DEVICES.find(d=>d.id===id).freq,otherId),655000,'The server must keep the actual frequency until matching ACK.');
  assert.doesNotMatch(await page.textContent('#datyProgressTitle'),/成功/);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#datyProgressDialog').isVisible(),true,'Waiting for ACK cannot be dismissed as complete.');
  await page.screenshot({path:path.join(output,'single-awaiting-receiver.png')});
  releaseSingle();
  await page.waitForFunction(()=>!DatyPlanningDeployment.isBusy());assert.equal(commands.length,1);assert.equal(commands[0].receiver_ip,'192.0.2.2');
  assert.equal(await page.$eval('#datyProgressBar',bar=>bar.value),1);
  assert.match(await page.textContent('#datyProgressTitle'),/下发成功/);
  assert.match(await page.textContent('#datyProgressRows'),/已确认/);
  await page.click('#datyProgressClose');
  assert.deepEqual(receivers.flatMap(r=>r.devices.map(d=>d.frequency)),[641,645,658]);
  // Small viewport has multiple pages: all-send still addresses the entire verified plan.
  await page.setViewportSize({width:1024,height:600});await page.click('#plannerPushAll');
  await page.locator('#datyConfirmDialog').waitFor({state:'visible'});
  assert.match(await page.textContent('#datyConfirmTitle'),/全部/);
  assert.equal(await page.locator('#datyConfirmRows tr').count(),3,'All-send preview includes channels on other pages.');
  assert.match(await page.textContent('#datyConfirmWarnings'),/扫描/);
  assert.equal(commands.length,1,'Opening all-send must wait for explicit approval.');
  await page.click('#datyConfirmCancel');await page.waitForFunction(()=>!DatyPlanningDeployment.isBusy());
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'plannerPushAll','Cancelling batch restores focus after the button is enabled again.');
  assert.equal(commands.length,1,'Cancelling bulk approval sends no additional commands.');
  await page.click('#plannerPushAll');await page.locator('#datyConfirmDialog').waitFor({state:'visible'});
  await page.screenshot({path:path.join(output,'1024-all-confirm.png')});
  const releaseFirst=gateNextAck(),firstBatchRequest=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/command');
  await page.click('#datyConfirmAccept');await firstBatchRequest;
  assert.equal(await page.$eval('#datyProgressBar',bar=>bar.value),0);
  assert.equal(await page.$eval('#datyProgressBar',bar=>bar.max),3);
  const releaseSecond=gateNextAck(),secondBatchRequest=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/command');
  releaseFirst();await secondBatchRequest;
  assert.equal(await page.$eval('#datyProgressBar',bar=>bar.value),2,'One exact ACK and one honest unchanged skip complete two of three rows.');
  assert.doesNotMatch(await page.textContent('#datyProgressTitle'),/成功/);
  await page.screenshot({path:path.join(output,'1024-all-awaiting-receiver.png')});
  releaseSecond();await page.waitForFunction(()=>!DatyPlanningDeployment.isBusy());
  assert.equal(commands.length,3);assert.deepEqual(receivers.flatMap(r=>r.devices.map(d=>d.frequency)),[642,647,658]);
  assert.match(await page.textContent('#plannerDeployStatus'),/设备 ACK 2.*原频一致 1.*失败 0/);
  assert.deepEqual(await page.evaluate(()=>DEVICES.map(d=>d.freq)),[642000,647000,658000]);
  assert.equal(await page.$eval('#datyProgressBar',bar=>bar.value),3);
  assert.match(await page.textContent('#datyProgressTitle'),/下发成功/);
  await page.screenshot({path:path.join(output,'1024-all-ack.png')});
  await page.click('#datyProgressClose');
  // Repeating an unchanged batch performs no device writes and must not fabricate ACK success.
  await page.click('#plannerPushAll');await page.click('#datyConfirmAccept');await page.waitForFunction(()=>!DatyPlanningDeployment.isBusy());
  assert.equal(commands.length,3);
  assert.match(await page.textContent('#datyProgressTitle'),/无需下发/);
  assert.doesNotMatch(await page.textContent('#datyProgressTitle'),/成功/);
  await page.click('#datyProgressClose');
  await page.setViewportSize({width:1366,height:768});await page.evaluate(()=>switchPanel('channels'));
  assert.equal(await page.locator('#deviceGridChannels .device-card').count(),3);
  for(const freq of ['642.000','647.000','658.000'])assert.match(await page.textContent('#deviceGridChannels'),new RegExp(freq));
  // An ACK for a different frequency must terminate as failure, with no success or completed progress.
  await page.evaluate(()=>switchPanel('planner'));corruptNextAck=true;
  await page.locator(`#fi_${otherId}`).locator('xpath=ancestor::tr').getByRole('button',{name:'下发',exact:true}).click();
  await page.click('#datyConfirmAccept');await page.waitForFunction(()=>!DatyPlanningDeployment.isBusy());
  assert.equal(commands.length,4);assert.match(await page.textContent('#datyProgressTitle'),/下发失败/);
  assert.match(await page.textContent('#datyProgressRows'),/频率不匹配/);
  assert.equal(await page.$eval('#datyProgressBar',bar=>bar.value),0);
  assert.equal(await page.evaluate(id=>DEVICES.find(d=>d.id===id).freq,otherId),658000);
  await page.screenshot({path:path.join(output,'single-wrong-ack-failure.png')});await page.click('#datyProgressClose');
  assert.equal(authReads,0);assert.deepEqual(nativeDialogs,[]);assert.deepEqual(errors,[]);console.log('PASS: no authorization UI/API → direct single/all review and cancellation → custom settings/locks/global solver → app confirmation/cancel → single and all → delayed current FAshe handler ACK → honest progress; unchanged skips and wrong ACK rejection retained. '+output);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
