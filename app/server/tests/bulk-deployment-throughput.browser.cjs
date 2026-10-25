// Offline 100-channel telemetry/deployment replay. All sockets and requests are intercepted.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright'),root=path.join(__dirname,'..');
const baseline=process.env.DATY_DEPLOY_BASELINE;
const snapshot=Array.from({length:100},(_,i)=>{
 const rx=Math.floor(i/50)+1,ch=i%50+1,rid=`fixture-rx${rx}`;
 return {id:`${rid}_ch${ch}`,receiver_id:rid,receiver_ip:`192.0.2.${rx}`,ip:`192.0.2.${rx}`,receiver_mac:`02:00:00:00:00:0${rx}`,
  channel_number:ch,channel:ch,ch:`CH${ch}`,group_number:rx===1?4:11,group_source:'server-fifo-v1',group:rx===1?4:11,
  brand:'DATYaudio',model:'DATY-X1',name:`Receiver ${rx} CH${ch}`,freq:640000+250*i,muted:false,rf:-60,af_dbfs:-15,batt:90,
  _online:true,status:'online',_source:`${rid}:mqtt:isolated-session`,
  capabilities:{adapter:'fashe-mqtt',write_frequency:true,read_frequency:true,read_only:false,mute:true,
   frequency_control:{scope:'fashe-protocol',min_khz:400000,max_khz:900000,step_khz:1,origin_khz:0,ack_mode:'command-id',brand_binding:'expected-brand-v1'}}};
});
(async()=>{
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-bulk-throughput-')),commands=[],audits=[],errors=[];
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try{
  const context=await browser.newContext({viewport:{width:1366,height:768}}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(req.method()==='GET'&&url.origin==='https://localhost:8080'&&(url.pathname==='/unirf-app.html'||/^\/src\/.*\.(css|js)$/.test(url.pathname))){
    const file=baseline&&url.pathname==='/src/modules/planning-deploy.js'?baseline:path.join(root,url.pathname);
    return route.fulfill({path:file});
   }
   if(url.pathname==='/api/timeline/events'){audits.push(JSON.parse(req.postData()));return route.fulfill({json:{success:true}});}
   if(url.pathname==='/api/command'){
    const cmd=JSON.parse(req.postData());commands.push(cmd);assert.equal(cmd.command,'set_freq');
    const source=snapshot.find(d=>d.id===cmd.device_id);assert.ok(source);assert.equal(cmd.receiver_id,source.receiver_id);
    assert.equal(cmd.receiver_ip,source.receiver_ip);assert.equal(cmd.channel_number,source.channel_number);assert.equal(cmd.expected_brand,'datyaudio');
    const ack={command_id:`fixture-command-${commands.length}`,client_request_id:cmd.client_request_id,device_id:cmd.device_id,
     command:cmd.command,status:'acknowledged',actual_value:cmd.value,brand:source.brand,expected_brand:cmd.expected_brand};
    await new Promise(resolve=>setTimeout(resolve,10));
    await page.evaluate(({cmd,ack})=>{
     const device=fixtureDevices.find(d=>d.id===cmd.device_id);device.freq=Math.round(cmd.value*1000);
     testSse.dispatchEvent(new MessageEvent('device_update',{data:JSON.stringify({devices:[device]})}));
     testSse.dispatchEvent(new MessageEvent('command_update',{data:JSON.stringify({data:ack})}));
    },{cmd,ack});
    try{return await route.fulfill({json:{success:true,command_id:ack.command_id,command_record:ack}});}catch(error){if(!req.failure())throw error;return;}
   }
   return route.fulfill({json:{status:'ok',success:true,devices:[],projects:[],events:[],ip:'127.0.0.1',project:{id:'isolated',name:'Isolated deployment'}}});
  });
  await context.addInitScript(()=>{
   window.fixtureInterval=window.setInterval;window.fixtureClearInterval=window.clearInterval;window.setInterval=()=>0;
   window.EventSource=class extends EventTarget{readyState=1;constructor(){super();window.testSse=this;}close(){this.readyState=2;}};
   window.WebSocket=class extends EventTarget{close(){}send(){throw Error('Live sockets prohibited');}};
  });
  await page.goto('https://localhost:8080/unirf-app.html');await page.waitForFunction(()=>!!window.testSse);
  await page.evaluate(snapshot=>{
   deviceServiceManager.stopDiscovery();deviceServiceManager.startDiscovery=()=>{};window.notify=()=>{};window.persistPlanningProject=async()=>{};
   window.fixtureDevices=snapshot;testSse.dispatchEvent(new MessageEvent('device_list',{data:JSON.stringify({devices:snapshot})}));switchPanel('planner');
   for(const [id,value]of Object.entries({plannerRange:'custom',plannerRangeStart:'640.000',plannerRangeEnd:'690.000',plannerCompatibility:'more-frequencies',plannerBackupCount:'0',plannerStepKHz:'25',plannerImdPolicy:'third'}))document.getElementById(id).value=value;
   runPlanning();if(!DATY_LAST_COORDINATION?.search.complete)throw Error('Fixture plan incomplete');
   window.measure={fullRefreshes:0,analyses:0,telemetryEvents:0,maxHeartbeatGapMs:0};
   const refresh=window.forceRefreshAllPanels;window.forceRefreshAllPanels=options=>{if(!options?.realtime)measure.fullRefreshes++;return refresh(options);};
   const engine=window.DatyCoordination;window.DatyCoordination={...engine,analyzeFrequencyPlan(...args){measure.analyses++;return engine.analyzeFrequencyPlan(...args);}};
   let previous=performance.now();window.heartbeat=fixtureInterval(()=>{const now=performance.now();measure.maxHeartbeatGapMs=Math.max(measure.maxHeartbeatGapMs,now-previous);previous=now;},20);
   window.telemetry=fixtureInterval(()=>{for(const device of fixtureDevices){testSse.dispatchEvent(new MessageEvent('device_update',{data:JSON.stringify({devices:[device]})}));measure.telemetryEvents++;}},50);
   window.deploymentStarted=performance.now();window.deploymentPromise=pushAllFreq().then(result=>{window.deploymentResult=result;measure.ms=performance.now()-deploymentStarted;fixtureClearInterval(telemetry);fixtureClearInterval(heartbeat);});
  },snapshot);
  await page.getByRole('button',{name:'确认全部下发',exact:true}).click();
  await page.waitForFunction(()=>!!window.deploymentResult,{},{timeout:60000});
  const result=await page.evaluate(()=>({result:deploymentResult,measure,diagnostics:DatyPlanningDeployment.getDiagnostics?.(),phase:document.getElementById('datyProgressDialog').dataset.phase,
   allMatch:DEVICES.every(d=>d.freq===d.planned)}));
  assert.equal(result.result.ok,true);assert.equal(result.phase,'success');assert.equal(result.allMatch,true);
  assert.equal(commands.length,result.result.acknowledged);assert.equal(result.result.acknowledged+result.result.skipped,100);
  assert.equal(new Set(commands.map(c=>c.client_request_id)).size,commands.length);assert.ok(result.measure.telemetryEvents>=100);
  if(!baseline){assert.equal(result.measure.fullRefreshes,0);assert.equal(result.measure.analyses,2);await page.waitForFunction(()=>DatyPlanningDeployment.getDiagnostics().at(-1).audit==='saved');assert.equal(audits.length,1);assert.equal(audits[0].details.acknowledged,commands.length);}
  for(const [width,height]of [[1366,768],[1024,600],[1920,1080]]){
   await page.setViewportSize({width,height});await page.screenshot({path:path.join(output,`completed-${width}.png`)});
   assert.equal(await page.locator('#datyProgressClose').isVisible(),true);
   assert.ok(await page.locator('#datyProgressClose').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}));
  }
  assert.deepEqual(errors,[]);result.output=output;result.baseline=!!baseline;
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({baseline:!!baseline,...result.measure,...result.result,output}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
