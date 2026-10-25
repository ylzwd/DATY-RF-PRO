// Fully isolated fixtures: no live API/receiver controls, no user browser storage.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-spectrum-hover-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 try{
  for(const dpr of [1,1.5,2]){
   const context=await browser.newContext({deviceScaleFactor:dpr}),page=await context.newPage(),errors=[],controls=[];
   page.on('pageerror',e=>errors.push(e.message));
   await context.route('**/*',route=>{
    const r=route.request(),u=new URL(r.url());
    if(u.pathname==='/api/command')controls.push(r.postData());
    if(r.method()==='GET'&&u.origin==='https://localhost:8080'&&(u.pathname==='/unirf-app.html'||/^\/src\/.*\.(css|js)$/.test(u.pathname)))return route.fulfill({path:path.join(root,u.pathname)});
    return route.fulfill({json:{status:'ok',success:true,devices:[],projects:[],events:[],ip:'127.0.0.1',project:{id:'default'}}});
   });
   await context.addInitScript(()=>{
    window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};
    window.WebSocket=class extends EventTarget{close(){}send(){throw Error('Receiver controls forbidden');}};
    window.spectrumPaint=[];
    for(const name of ['clearRect','stroke','fill','fillRect','strokeRect']){
     const original=CanvasRenderingContext2D.prototype[name];
     CanvasRenderingContext2D.prototype[name]=function(...args){
      if(this.canvas.id==='spectrumCanvas'){
       if(name==='clearRect')window.spectrumPaint=[];
       else window.spectrumPaint.push({op:name,color:String(name.startsWith('stroke')?this.strokeStyle:this.fillStyle)});
      }
      return original.apply(this,args);
     };
    }
   });
   await page.goto('https://localhost:8080/unirf-app.html');
   await page.evaluate(()=>{window.notify=()=>{};document.getElementById('specCurveMode').value='envelope';switchPanel('spectrum');});
   for(const [width,height]of[[1366,768],[1920,1080]]){
    await page.setViewportSize({width,height});
    for(const count of [1,4,50]){
     await page.evaluate(count=>{
      DEVICES.splice(0,DEVICES.length,...Array.from({length:count},(_,i)=>({id:i+1,_fasheId:`rx_ch${i+1}`,receiver_ip:'192.0.2.1',
       channel_number:i+1,brand:'DATYaudio',model:'DATY-X1',freq:641000+i*250,rf:i%3===0?-30:i%3===1?-60:-90,_online:true,status:'online'})));
      document.getElementById('specStart').value='640.000';document.getElementById('specEnd').value='690.000';updateRangeDisplay();drawSpectrum();
     },count);
     const before=await page.evaluate(()=>JSON.stringify(DEVICES));
     await page.getByRole('button',{name:'⤢ 适配设备',exact:true}).click();
     const plot=await page.locator('#spectrumCanvas').boundingBox();
     const axis=await page.locator('.spectrum-rf-axis span').evaluateAll(labels=>labels.map(e=>({
      text:e.textContent,y:parseFloat(e.style.top),height:e.getBoundingClientRect().height,
      center:e.getBoundingClientRect().y+e.getBoundingClientRect().height/2,
     })));
     axis.forEach((label,i)=>{
      assert.equal(label.text,`${-30-i*20} dBm`);assert.equal(label.y,10+i*30);
      if(i<3)assert.ok(Math.abs(label.center-(plot.y+plot.height*label.y/100))<2);
     });
     const tooltip=page.locator('#spectrumPointTooltip');
     for(let i=0;i<count;i++){
      const x=plot.x+(i+.5)*plot.width/count,y=plot.y+plot.height*(i%3===0?.1:i%3===1?.55:1);
      await page.mouse.move(x,Math.min(y,plot.y+plot.height-2));
      await tooltip.waitFor({state:'visible'});
      assert.equal(await tooltip.textContent(),`CH${i+1} · ${(641+i*.25).toFixed(3)} MHz`);
      const bounds=await tooltip.boundingBox();assert.ok(bounds.x>=plot.x&&bounds.x+bounds.width<=plot.x+plot.width+1);
      assert.ok(bounds.y>=plot.y&&bounds.y+bounds.height<=plot.y+plot.height+1);
      // Sample the middle and bottom of each visible stem as well as its circle.
      if(i%3!==2)for(const stemY of [(y+plot.y+plot.height)/2,plot.y+plot.height-4]){
       await page.mouse.move(x,stemY);await tooltip.waitFor({state:'visible'});
       assert.equal(await tooltip.textContent(),`CH${i+1} · ${(641+i*.25).toFixed(3)} MHz`);
       const stemTip=await tooltip.boundingBox();
       assert.ok(stemTip.y+stemTip.height>=stemY-12&&stemTip.y<=stemY+12);
       assert.ok(stemTip.x>=plot.x&&stemTip.x+stemTip.width<=plot.x+plot.width+1);
      }
     }
     const paint=await page.evaluate(()=>window.spectrumPaint);
     assert.equal(paint.filter(p=>p.op==='stroke').length,55+count);
     assert.equal(paint.filter(p=>p.op==='stroke'&&p.color==='#fbbf24').length,1);
     assert.equal(paint.filter(p=>p.op==='fill').length,count);
     assert.ok(paint.every(p=>p.op!=='fillRect'&&p.op!=='strokeRect'));
     assert.ok(paint.filter(p=>p.op==='fill').every(p=>p.color==='#10b981'));
     await page.locator('#panel-spectrum').screenshot({path:path.join(output,`${width}-${count}-dpr${dpr}.png`)});
     await page.mouse.move(plot.x+plot.width/2,plot.y+plot.height*.03);await tooltip.waitFor({state:'hidden'});
     assert.equal(await page.evaluate(()=>JSON.stringify(DEVICES)),before);
     await page.getByRole('button',{name:'↩ 恢复范围',exact:true}).click();
     assert.deepEqual(await page.evaluate(()=>[document.getElementById('specStart').value,document.getElementById('specEnd').value]),['640.000','690.000']);
     console.log(JSON.stringify({size:[width,height],count,dpr,grid:54,hover:'PASS'}));
    }
   }
   // Stationary pointer must update after telemetry; large movement/offline clears stale popup.
   await page.evaluate(()=>{
    DEVICES.splice(0,DEVICES.length,{id:1,_fasheId:'rx_ch1',channel_number:1,freq:641000,rf:-60,status:'online'});
    document.getElementById('specStart').value='640';document.getElementById('specEnd').value='642';drawSpectrum();
   });
   const plot=await page.locator('#spectrumCanvas').boundingBox(),tooltip=page.locator('#spectrumPointTooltip');
   await page.mouse.move(plot.x+plot.width*.5,plot.y+plot.height*.8);await tooltip.waitFor({state:'visible'});
   await page.evaluate(()=>{DEVICES[0].freq=641001;drawSpectrum();});assert.equal(await tooltip.textContent(),'CH1 · 641.001 MHz');
   await page.evaluate(()=>{DEVICES[0].freq=641800;drawSpectrum();});await tooltip.waitFor({state:'hidden'});
   await page.evaluate(()=>{DEVICES[0].freq=641000;drawSpectrum();});await tooltip.waitFor({state:'visible'});
   await page.evaluate(()=>{DEVICES[0]._online=false;drawSpectrum();});await tooltip.waitFor({state:'hidden'});
   assert.deepEqual(errors,[]);assert.deepEqual(controls,[]);await context.close();
  }
  console.log('PASS: denser grid, no red bands, circle + full stem hover/telemetry/offline, fit/restore, DPR. Screenshots: '+output);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
