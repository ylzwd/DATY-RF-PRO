// Isolated Chromium/Edge fixture routes only. No live server, credential store,
// certificate-store changes, receiver traffic or production localStorage.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..');
async function textDownload(download){const stream=await download.createReadStream();const parts=[];for await(const part of stream)parts.push(part);return Buffer.concat(parts).toString('utf8');}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.EDGE_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1366,height:768}}),unexpected=[],errors=[];
  const fixtureHost='migration-fixture.invalid';
  try{
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.hostname===fixtureHost && url.pathname==='/ws-probe.html')return route.fulfill({status:200,contentType:'text/html',body:fs.readFileSync(path.join(root,'ws-probe.html'),'utf8')});
      unexpected.push(url.href);return route.abort();
    });
    await context.addInitScript(()=>{
      globalThis.fixtureNetworkAttempts=[];
      globalThis.fetch=url=>{fixtureNetworkAttempts.push(String(url));throw new Error('Unexpected migration fetch');};
      globalThis.WebSocket=class{constructor(url){fixtureNetworkAttempts.push(url);throw new Error('Unexpected migration WS');}};
      globalThis.EventSource=class{constructor(url){fixtureNetworkAttempts.push(url);throw new Error('Unexpected migration SSE');}};
    });
    const oldPage=await context.newPage();oldPage.on('pageerror',error=>errors.push(error.message));
    await oldPage.goto(`http://${fixtureHost}:8080/ws-probe.html?business-migration=1&autoconnect=1`);
    await oldPage.evaluate(()=>{localStorage.setItem('daty_alerts','[{"message":"existing show alert"}]');localStorage.setItem('specStartFreq','640');localStorage.setItem('access_token','must_not_export');});
    assert.equal(await oldPage.locator('#migrationFile').isDisabled(),true);
    const exportedPromise=oldPage.waitForEvent('download');await oldPage.click('#migrationExport');
    const exported=await textDownload(await exportedPromise);
    assert.ok(!exported.includes('must_not_export'));assert.equal(JSON.parse(exported).values.specStartFreq,'640');
    assert.deepEqual(await oldPage.evaluate(()=>fixtureNetworkAttempts),[]);

    const automaticDownload=oldPage.waitForEvent('download');
    await oldPage.goto(`http://${fixtureHost}:8080/ws-probe.html?business-migration=1&auto-export=1`);
    const automatic=JSON.parse(await textDownload(await automaticDownload));
    assert.equal(automatic.values.specStartFreq,'640');
    assert.ok(!JSON.stringify(automatic).includes('must_not_export'));
    assert.equal(await oldPage.evaluate(()=>localStorage.getItem('access_token')),'must_not_export');
    assert.deepEqual(await oldPage.evaluate(()=>fixtureNetworkAttempts),[]);

    const securePage=await context.newPage();securePage.on('pageerror',error=>errors.push(error.message));
    await securePage.goto(`https://${fixtureHost}:8080/ws-probe.html?business-migration=1&autoconnect=1`);
    await securePage.evaluate(()=>localStorage.setItem('specStartFreq','470'));
    assert.equal(await securePage.locator('#migrationFile').isDisabled(),false);
    await securePage.setInputFiles('#migrationFile',{name:'business-backup.json',mimeType:'application/json',buffer:Buffer.from(exported)});
    await securePage.click('#migrationPreview');assert.equal(await securePage.locator('#migrationConfirm').isVisible(),true);
    await securePage.click('#migrationCancel');assert.equal(await securePage.evaluate(()=>localStorage.getItem('daty_alerts')),null);
    await securePage.click('#migrationPreview');const beforeImport=securePage.waitForEvent('download');await securePage.click('#migrationApply');
    assert.equal(JSON.parse(await textDownload(await beforeImport)).values.specStartFreq,'470');
    assert.equal(await securePage.evaluate(()=>localStorage.getItem('specStartFreq')),'470');
    assert.equal(await securePage.evaluate(()=>JSON.parse(localStorage.getItem('daty_alerts'))[0].message),'existing show alert');

    await securePage.check('#migrationOverwrite');await securePage.click('#migrationPreview');
    assert.match(await securePage.textContent('#migrationSummary'),/覆盖/);
    const beforeOverwrite=securePage.waitForEvent('download');await securePage.click('#migrationApply');await textDownload(await beforeOverwrite);
    assert.equal(await securePage.evaluate(()=>localStorage.getItem('specStartFreq')),'640');
    assert.equal(await oldPage.evaluate(()=>localStorage.getItem('access_token')),'must_not_export');
    assert.deepEqual(await securePage.evaluate(()=>fixtureNetworkAttempts),[]);
    assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
    process.stdout.write('PASS isolated HTTP export / HTTPS import UI: exact origins, no probes despite autoconnect, secret exclusion, preview/cancel, keep-existing default, explicit overwrite, before-import downloads.\n');
  }finally{await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
