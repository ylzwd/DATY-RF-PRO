// Opt-in read-only browser diagnostic. No live POST, MQTT or control commands.
const {chromium}=require('playwright');
(async()=>{
  if(!process.argv.includes('--live')) throw Error('Pass --live to inspect the local running UI with GET requests only');
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  try {
    const context=await browser.newContext(),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/*',route=>{
      const r=route.request(),u=new URL(r.url());
      if(r.method()==='GET' && ['localhost','127.0.0.1'].includes(u.hostname) && ['8080','8802','8765'].includes(u.port)) return route.continue();
      return route.abort();
    });
    await context.addInitScript(()=>{
      // Exercise migration of the real historical setting instead of hiding it in the test.
      localStorage.setItem('daty_fashe_api_url','http://localhost:8802');
      window.WebSocket=class extends EventTarget {close(){} send(){throw Error('Live sockets are forbidden');}};
      window.netReadings=[];
      const original=window.fetch;
      window.fetch=async(...args)=>{
        const record={url:String(args[0]),start:performance.now()};netReadings.push(record);
        try {const result=await original(...args);record.headers=performance.now();return result;}
        catch(e){record.error=e.message;record.end=performance.now();throw e;}
      };
    });
    await page.goto('http://localhost:8080/unirf-app.html');
    await page.waitForTimeout(10000);
    console.log(JSON.stringify(await page.evaluate(()=>{
      const requests=netReadings.filter(r=>r.url.endsWith('/api/devices'));
      const elapsed=requests.filter(r=>r.headers).map(r=>r.headers-r.start).sort((a,b)=>a-b);
      return {channels:DEVICES.length,connected:deviceServiceManager.connectedDevices.size,
        apiUrl:_fasheApiUrl,savedApiUrl:localStorage.getItem('daty_fashe_api_url'),sseUrl:_fasheSSE?.url,
        heartbeatTimers:deviceServiceManager.heartbeatTimers?.size ?? (deviceServiceManager.heartbeatTimer != null ? 1 : 0),
        comparable:DEVICES.length>0,
        sseState:_fasheSSE?.readyState,snapshotRequests:requests.length,pending:requests.filter(r=>!r.headers&&!r.end).length,
        headerMs:{median:elapsed[Math.floor(elapsed.length/2)],max:elapsed.at(-1)},errors:netReadings.filter(r=>r.error).map(r=>({url:r.url,error:r.error}))};
    }),null,2));
    console.log(JSON.stringify({pageErrors:errors}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
