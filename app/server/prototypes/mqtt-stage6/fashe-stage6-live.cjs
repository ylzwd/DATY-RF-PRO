'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {writeProgress}=require('./progress-json.cjs');
const [url,wssOrigin,certPath,playwrightPath,executable,output,duration='60']=process.argv.slice(2);
const {chromium}=require(playwrightPath),cert=new crypto.X509Certificate(fs.readFileSync(certPath));
const pin=crypto.createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest('base64');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const soak=process.env.DATY_M6_SOAK;
if(soak&&!['24h','pilot'].includes(soak))throw Error('Invalid soak mode');
if(soak==='24h')assert.equal(Number(duration),86400);
(async()=>{
 const browser=await chromium.launch({executablePath:executable,headless:true,args:['--ignore-certificate-errors-spki-list='+pin]});
 let profiler;
 try{
  const pages=[],contexts=[],businessHttp=[],errors=[],requestFailures=[];
  const recordResourceFailure=(request,page)=>{
    requestFailures.push({page,url:request.url(),type:request.resourceType(),error:request.failure()});
    fs.writeFileSync(output+'/request-failures.json',JSON.stringify(requestFailures,null,2));
  };
  for(let i=1;i<=2;i++){
    const context=await browser.newContext({viewport:{width:1280,height:900}});contexts.push(context);
    await context.addInitScript(({i,wssOrigin})=>{
      localStorage.setItem('fashe_receiver_mac_v1','02:00:00:00:00:0'+i);
      localStorage.setItem('fashe_auto_server_v1','https://127.0.0.1:8802');
      localStorage.setItem('fashe_deviceCount','50');localStorage.setItem('fashe_updateInterval','50');
      localStorage.setItem('fashe_deviceBrand','DATYaudio');
      // Only the fixture's canonical signed receiver URL maps to its ephemeral
      // listener. Production hosts/ports and certificate policy are untouched.
      const Native=globalThis.WebSocket;
      globalThis.WebSocket=class extends Native{constructor(url,protocols){
        if(String(url)==='wss://127.0.0.1:8083/mqtt')url=wssOrigin+'/mqtt';
        super(url,protocols);
      }};
    },{i,wssOrigin});
    await context.route('**/*',route=>{
      const req=route.request(),u=new URL(req.url());
      if(/\/api\//.test(u.pathname))businessHttp.push(req.url());
      if(!['127.0.0.1',''].includes(u.hostname)&&!['blob:','data:'].includes(u.protocol))return route.abort();
      return route.continue();
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    page.on('requestfailed',request=>recordResourceFailure(request,'receiver-'+i));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.goto(url,{waitUntil:'load'});pages.push(page);
    try{await page.waitForFunction(()=>typeof mqttClient!=='undefined'&&mqttClient?.connected&&devices.length===50,null,{timeout:25000});}
    catch(error){
      const diagnostic=await page.evaluate(()=>({feedback:document.getElementById('pairingFeedback')?.textContent,
        status:document.getElementById('serverStatusText')?.textContent,origin:document.getElementById('autoPairServer')?.value,
        channels:typeof devices!=='undefined'?devices.length:null,transport:!!globalThis.FasheMqttEnrollment,
        powered:typeof isPoweredOn!=='undefined'?isPoweredOn:null}));
      fs.writeFileSync(output+'/fashe-start-failure.json',JSON.stringify({index:i,diagnostic,errors,businessHttp,requestFailures},null,2));throw error;
    }
  }
  const snapshot=page=>page.evaluate(()=>({connected:mqttClient?.connected===true,powered:isPoweredOn,channels:devices.length,
    mac:getLocalMacAddress(),assignment:FashePairing.serverAssignment(),version:CLOCK_ACK_CLIENT_VERSION,
    receiver_id:FashePairing.publicInfo()?.receiver_id,credential_id:FashePairing.publicInfo()?.credential_id,
    expires_at:FashePairing.publicInfo()?.expires_at,frequencies:devices.map(d=>d.frequency),muted:devices.map(d=>d.muted)}));
  const before=await Promise.all(pages.map(snapshot));
  const appContext=await browser.newContext({viewport:{width:1440,height:1000}});
  await appContext.route('**/*',route=>{const u=new URL(route.request().url());
    if(/\/api\//.test(u.pathname))businessHttp.push(route.request().url());
    if(u.hostname!=='127.0.0.1'&&!['blob:','data:'].includes(u.protocol))return route.abort();return route.continue();});
  const app=await appContext.newPage();app.on('pageerror',e=>errors.push(e.message));
  app.on('requestfailed',request=>recordResourceFailure(request,'server-page'));
  app.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  if(process.env.DATY_M6_PROFILE){profiler=await appContext.newCDPSession(app);await profiler.send('Profiler.enable');await profiler.send('Profiler.start');}
  await app.goto(new URL('/server/unirf-app.html',url).href,{waitUntil:'load'});
  await app.waitForFunction(()=>typeof DEVICES!=='undefined'&&DEVICES.filter(d=>d._online!==false&&['02:00:00:00:00:01','02:00:00:00:00:02'].includes(d.receiver_mac)).length===100,null,{timeout:20000});
  const began=performance.now(),startedUtc=new Date().toISOString(),renewals=[[],[]],previousExpiry=before.map(x=>x.expires_at),disconnectedSince=[null,null];
  let lastSample=performance.now(),largestSamplingGap=0;
  const progressIo={replace_retries:0,max_replace_wait_ms:0};
  if(soak)for(const receiver of before)assert(receiver.expires_at*1000-Date.now()>7.9*3600000,'Natural 8-hour lease required');
  for(let i=0;performance.now()-began<Number(duration)*1000;i++){
    await sleep(1000);
    const now=performance.now();largestSamplingGap=Math.max(largestSamplingGap,now-lastSample);lastSample=now;
    if(soak)assert(largestSamplingGap<30000,'Continuous observation interrupted (sleep/freeze or host overload)');
    const current=await Promise.all(pages.map(snapshot));
    if(soak){
      for(let n=0;n<2;n++){
        assert.equal(current[n].receiver_id,before[n].receiver_id);assert.equal(current[n].credential_id,before[n].credential_id);
        assert.equal(current[n].assignment.group_number,before[n].assignment.group_number);
        if(current[n].expires_at>previousExpiry[n]){
          renewals[n].push({at_utc:new Date().toISOString(),elapsed_seconds:(now-began)/1000,old_expiry:previousExpiry[n],new_expiry:current[n].expires_at});
          previousExpiry[n]=current[n].expires_at;
        }
        if(current[n].connected)disconnectedSince[n]=null;
        else if(disconnectedSince[n]===null)disconnectedSince[n]=now;
        assert(disconnectedSince[n]===null||now-disconnectedSince[n]<5000,'Receiver connection unavailable for five seconds');
      }
    }
    // Concurrent archive readiness uses observed load in ordinary integration
    // runs too. Reporting progress must not depend on natural-renewal mode.
    const progress={started_utc:startedUtc,elapsed_seconds:(now-began)/1000,updated_utc:new Date().toISOString(),
      natural_renewals:renewals,largest_sampling_gap_ms:largestSamplingGap,progress_io:{...progressIo},receivers:current.map(({frequencies,muted,...rest})=>rest)};
    const saved=await writeProgress(output+'/browser-soak-progress.json',progress);
    progressIo.replace_retries+=saved.replace_retries;
    progressIo.max_replace_wait_ms=Math.max(progressIo.max_replace_wait_ms,saved.replace_wait_ms);
    const appState=await app.evaluate(()=>({online:DEVICES.filter(d=>d._online!==false&&['02:00:00:00:00:01','02:00:00:00:00:02'].includes(d.receiver_mac)).length,
      audit:DatyMqttAudit,totals:DatyMqttAuditTotals}));
    if(appState.online!==100){
      const logs=await Promise.all(pages.map(p=>p.locator('#logContainer').innerText()));
      fs.writeFileSync(output+'/fashe-load-failure.json',JSON.stringify({second:i,current,logs,appState,errors,businessHttp},null,2));
    }
    assert.equal(appState.online,100,'Original server page lost online channels');
    if(!current.every(x=>x.connected&&x.powered&&x.channels===50)){
      const logs=await Promise.all(pages.map(p=>p.locator('#logContainer').innerText()));
      fs.writeFileSync(output+'/fashe-load-failure.json',JSON.stringify({second:i,current,logs,errors,businessHttp},null,2));
    }
    assert(current.every(x=>(soak||x.connected)&&x.powered&&x.channels===50),'100CH receiver connection lost under load');
  }
  // Stop only the periodic fixture telemetry, while keeping both MQTT sessions
  // and clock ACKs alive. Verify the queued tail BEFORE forced renewal/close.
  await Promise.all(pages.map(page=>page.evaluate(()=>stopUpdates())));
  fs.writeFileSync(output+'/drain.request.json',JSON.stringify({at:Date.now()}));
  const drainDeadline=performance.now()+30000;
  while(!fs.existsSync(output+'/drain.reply.json')){if(performance.now()>drainDeadline)throw Error('Isolated pipeline failed to drain');await sleep(100);}
  const drain=JSON.parse(fs.readFileSync(output+'/drain.reply.json','utf8'));
  const drained=await Promise.all(pages.map(snapshot));
  for(const receiver of drained){
    const rows=drain.rows.filter(row=>row.receiver_mac===receiver.mac);assert.equal(rows.length,50);
    for(let i=0;i<50;i++){
      assert.equal(rows[i].frequency_khz,Math.round(receiver.frequencies[i]*1000));
      assert.equal(rows[i].muted,Number(receiver.muted[i]));assert.equal(rows[i].declared_online,1);
    }
  }
  assert.equal(drain.bus.stale,0);assert.equal(drain.persistence.outstanding,0);assert.equal(drain.persistence.complete,true);
  // Exercise the original renewal path now, without pretending this covers
  // actual 8-hour expiry. The later fixed-build 24h test must cover that clock.
  if(!soak){
    await pages[0].evaluate(()=>FashePairing.autoConnect({renew:true}));
    await pages[0].waitForFunction(()=>mqttClient?.connected===true,null,{timeout:15000});
  }
  if(soak==='24h')assert(renewals.every(events=>events.length>=2),'Both receivers must naturally renew more than once');
  await sleep(2000);const after=await Promise.all(pages.map(snapshot));
  for(let i=0;i<2;i++){
    assert.equal(after[i].receiver_id,before[i].receiver_id);assert.equal(after[i].credential_id,before[i].credential_id);
    assert.equal(after[i].assignment.group_number,before[i].assignment.group_number);
    assert.deepEqual(after[i].frequencies,before[i].frequencies);assert.deepEqual(after[i].muted,before[i].muted);
  }
  assert.deepEqual(after.map(x=>x.assignment.group_number),[1,2]);assert.equal(businessHttp.length,0);
  assert.equal(await app.evaluate(()=>DatyMqttAuditTotals.forbidden),0);
  assert.deepEqual(errors,[],'Original page/receiver handlers reported an error');
  const result={ok:true,receivers:after.map(({frequencies,muted,...rest})=>rest),update_interval_ms:50,
    read_verification:await app.evaluate(()=>DatyMqttReadVerification()),read_timing:await app.evaluate(()=>DatyMqttReadTiming()),
    business_http_requests:businessHttp,errors,forced_renewal:!soak,actual_eight_hour_renewal:soak==='24h'&&renewals.every(events=>events.length>=2),
    natural_renewals:renewals,started_utc:startedUtc,largest_sampling_gap_ms:largestSamplingGap,progress_io:progressIo,
    original_channel_state_preserved:true,drain_before_renewal:!soak,continuous_seconds:(performance.now()-began)/1000,soak_started:soak==='24h',remote_copies_updated:false};
  fs.writeFileSync(output+'/fashe-browser-result.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({ok:true,receivers:2,channels:100,errors:errors.length,forced_renewal:!soak}));
 }finally{if(profiler){const {profile}=await profiler.send('Profiler.stop');fs.writeFileSync(output+'/page-profile.json',JSON.stringify(profile));}await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
