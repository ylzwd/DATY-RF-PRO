// Read-only browser transport probe: GET /health + normal CORS preflight, never /api/command.
const {chromium}=require('playwright');
(async()=>{
  if(!process.argv.includes('--live'))throw Error('Pass --live for read-only local Bridge timing');
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  try{
    const context=await browser.newContext(),page=await context.newPage();
    // Real HTTP navigation keeps Chromium's loopback address-space classification.
    // Suppress app scripts so the probe has no background traffic or writes.
    await context.route('**/*.js*',r=>r.fulfill({body:'',contentType:'application/javascript'}));
    await page.goto('http://localhost:8080/unirf-app.html');
    const result=await page.evaluate(async()=>{
      const rows=[];
      for(const host of ['localhost','127.0.0.1']){
        for(const preflight of [false,true]){
          const times=[];
          for(let i=0;i<4;i++){
            const start=performance.now();
            const response=await fetch(`http://${host}:8802/health?readonly_probe=${i}`,{
              cache:'no-store',headers:preflight?{'Content-Type':'application/json'}:{},signal:AbortSignal.timeout(5000)});
            const data=await response.json();if(data.status!=='ok')throw Error('Bridge not healthy');
            times.push(Number((performance.now()-start).toFixed(3)));
          }
          rows.push({host,preflight,ms:times});
        }
      }
      return rows;
    });
    console.log(JSON.stringify(result,null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
