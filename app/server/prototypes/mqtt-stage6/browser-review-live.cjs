'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const [url,certPath,playwrightPath,executable,output,fixturePath]=process.argv.slice(2);
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
const {chromium}=require(playwrightPath),cert=new crypto.X509Certificate(fs.readFileSync(certPath));
const pin=crypto.createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest('base64');
(async()=>{
 const browser=await chromium.launch({executablePath:executable,headless:true,args:['--ignore-certificate-errors-spki-list='+pin]});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[],http=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',r=>{if(/\/api\//.test(r.url()))http.push(r.url());});
  await context.route('**/*',route=>{const u=new URL(route.request().url());return u.hostname==='127.0.0.1'||['data:','blob:'].includes(u.protocol)?route.continue():route.abort();});
  await page.goto(url,{waitUntil:'load'});await page.waitForFunction(()=>DatyServerStorage.ready&&DEVICES.length===4,null,{timeout:25000});
  const beginCommand=async()=>{
   await page.evaluate(fixture=>{
    const base=DatyDatabaseConnection.snapshot().origin;
    const command={...fixture.target,expected_brand:fixture.target.expected_brand,client_request_id:crypto.randomUUID().replaceAll('-',''),command:'set_freq',value:666.000};
    delete command.device_channel_key;
    globalThis.__reviewResult=DatyPlatform.request(base+'/api/command',{method:'POST',body:JSON.stringify(command)})
      .then(async response=>({status:response.status,body:await response.json()}));
   },fixture);
  };
  for(const decision of ['Cancel','Accept']){
   await beginCommand();await page.locator('#datyConfirmDialog').waitFor();
   assert.match(await page.locator('#datyConfirmDialog').innerText(),/复核结果未确认/);
   await page.click('#datyConfirm'+decision);
   const result=await page.evaluate(()=>__reviewResult);assert.equal(result.status,409);
   const uncertain=await page.evaluate(()=>DatyMqttControl.uncertain(DatyDatabaseConnection.snapshot().origin));
   assert.equal(uncertain.operations.some(item=>item.operation_id===fixture.command_operation_id),decision==='Cancel');
  }
  // Confirmation only releases the fence. A subsequent deliberate operation is
  // the sole new execution; the old unknown operation is never replayed.
  await beginCommand();const sent=await page.evaluate(()=>__reviewResult);assert.equal(sent.status,200,JSON.stringify(sent));
  await page.waitForFunction(async id=>{
    const base=DatyDatabaseConnection.snapshot().origin,r=await DatyPlatform.request(base+'/api/commands/'+id),body=await r.json();
    return body.command?.status==='acknowledged';
  },sent.body.command_id,{timeout:10000});
  for(const decision of ['Cancel','Accept']){
   await page.evaluate(()=>{globalThis.__scanReview=DatyMqttDiscoveryIntent(DatyDatabaseConnection.snapshot().origin,'scan')
     .then(value=>({value}),error=>({error:error.message}));});
   await page.locator('#datyConfirmDialog').waitFor();assert.match(await page.locator('#datyConfirmDialog').innerText(),/复核结果未知的扫描/);
   await page.click('#datyConfirm'+decision);const result=await page.evaluate(()=>__scanReview);
   assert.match(result.error,decision==='Cancel'?/取消复核/:/已复核原扫描/);
  }
  const intent=await page.evaluate(()=>DatyMqttDiscoveryIntent(DatyDatabaseConnection.snapshot().origin,'scan'));
  assert.ok(intent.operation_id);assert.ok(Number.isSafeInteger(intent.expected_generation));
  assert.equal(await page.evaluate(()=>DatyMqttAuditTotals.forbidden),0);assert.deepEqual(errors,[]);assert.deepEqual(http,[]);
  const result={ok:true,command_cancel_accept_requires_new_action:true,old_unknown_never_replayed:true,
    discovery_cancel_accept_no_auto_scan:true,isolated_new_command_id:sent.body.command_id,actual_business_http:0,page_errors:errors};
  fs.writeFileSync(output+'/browser-review-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
