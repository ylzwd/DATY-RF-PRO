// Isolated fixtures by default; --live permits only local GETs in a fresh browser profile.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..'),live=process.argv.includes('--live'),output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-rf-frequency-axis-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 try{
  for(const dpr of live?[1]:[1,2]){
   const context=await browser.newContext({deviceScaleFactor:dpr}),page=await context.newPage(),errors=[],controls=[];
   page.on('pageerror',e=>errors.push(e.message));
   await context.route('**/*',route=>{
    const r=route.request(),u=new URL(r.url());if(u.pathname==='/api/command')controls.push(r.postData());
    if(live)return r.method()==='GET'&&['localhost','127.0.0.1'].includes(u.hostname)&&['8080','8802','8765'].includes(u.port)?route.continue():route.abort();
    if(r.method()==='GET'&&u.origin==='https://localhost:8080'&&(u.pathname==='/unirf-app.html'||/^\/src\/.*\.(css|js)$/.test(u.pathname)))return route.fulfill({path:path.join(root,u.pathname)});
    return route.fulfill({json:{status:'ok',success:true,devices:[],projects:[],events:[],ip:'127.0.0.1',project:{id:'default'}}});
   });
   await context.addInitScript(live=>{
    // Only this fresh profile: emulate previously saved manual bounds, never clear user state.
    if(localStorage.getItem('specStartFreq')===null)localStorage.setItem('specStartFreq','640.000');
    if(localStorage.getItem('specEndFreq')===null)localStorage.setItem('specEndFreq','690.000');
    window.WebSocket=class extends EventTarget{close(){}send(){throw Error('Controls forbidden');}};
    if(!live){window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};}
    window.rfPaintRects=[];window.rfTextCalls=[];
    for(const name of ['clearRect','fillRect','fillText']){
     const original=CanvasRenderingContext2D.prototype[name];
     CanvasRenderingContext2D.prototype[name]=function(...args){
      if(this.canvas.id==='rfBarChart'){
       if(name==='clearRect'){window.rfPaintRects=[];window.rfTextCalls=[];}
       else if(name==='fillText')window.rfTextCalls.push({args,color:this.fillStyle,font:this.font,transform:[this.getTransform().a,this.getTransform().d]});
       else window.rfPaintRects.push(args);
      }
      return original.apply(this,args);
     };
    }
   },live);
   await page.goto('https://localhost:8080/unirf-app.html');
   if(live)await page.waitForFunction(()=>DEVICES.length>0,{},{timeout:15000});
   await page.evaluate(()=>{window.notify=()=>{};});

   async function dashboard(label){
    await page.evaluate(()=>switchPanel('dashboard'));
    const state=await page.evaluate(()=>{
     const canvas=document.getElementById('rfBarChart'),bounds=canvas.getBoundingClientRect(),axis=document.getElementById('rfFrequencyAxis'),ax=axis.getBoundingClientRect();
     const start=Number(document.getElementById('specStart').value),end=Number(document.getElementById('specEnd').value);
     const devices=DEVICES.filter(d=>Number.isInteger(Number(d.freq))&&Number(d.freq)>0&&Number(d.freq)>=start*1000&&Number(d.freq)<=end*1000).slice().sort((a,b)=>a.freq-b.freq);
     return {range:[start,end],expected:devices.map(d=>({freq:Number(d.freq),rf:Number(d.rf)})),rects:window.rfPaintRects.filter((_,i)=>i%3===1),
      width:Math.round(bounds.width),height:Math.round(bounds.height),backing:[canvas.width,canvas.height],
      axisOffset:ax.left-bounds.left,axisWidth:ax.width,ticks:[...axis.querySelectorAll('span>span')].map(e=>({text:e.textContent,left:parseFloat(e.style.left)})),
      clipped:[...axis.querySelectorAll('span>span')].some(e=>{const r=e.getBoundingClientRect();return r.left<ax.left-1||r.right>ax.right+1;}),
      overflow:document.querySelector('.content').scrollHeight>document.querySelector('.content').clientHeight+1,
      font:[getComputedStyle(axis).fontFamily,getComputedStyle(axis).fontSize,getComputedStyle(axis).color],texts:window.rfTextCalls,
      yLabelPixels:canvas.getContext('2d').getImageData(0,0,Math.floor(50*devicePixelRatio),canvas.height).data.some((v,i)=>i%4===3&&v>0)};
    });
    assert.equal(state.rects.length,state.expected.length);assert.equal(state.clipped,false);assert.equal(state.overflow,false);
    assert.equal(state.yLabelPixels,true,JSON.stringify(state.texts));assert.equal(state.texts.length,5);
    assert.equal(state.axisOffset,56);assert.ok(Math.abs(state.axisWidth-(state.width-104))<=1);
    assert.equal(parseFloat(state.ticks[0].text),state.range[0]);assert.equal(parseFloat(state.ticks.at(-1).text),state.range[1]);
    state.rects.forEach((r,i)=>{
     const d=state.expected[i],expectedX=56+(d.freq-state.range[0]*1000)/((state.range[1]-state.range[0])*1000)*(state.width-104);
     assert.ok(Math.abs(r[0]+r[2]/2-expectedX)<1e-6);
     assert.ok(Math.abs(r[3]-Math.max(0,Math.min(1,(d.rf+90)/60))*(state.height-34))<1e-6);
    });
    assert.equal(state.backing[0],Math.round(state.width*dpr));
    await page.locator('#panel-dashboard').screenshot({path:path.join(output,`${live?'live':'fixture'}-${label}-dpr${dpr}.png`)});
    return state;
   }

   for(const [width,height]of[[1366,768],[1920,1080]]){
    await page.setViewportSize({width,height});
    const counts=live?[await page.evaluate(()=>DEVICES.length)]:[1,4,50];
    for(const count of counts){
     if(!live)await page.evaluate(count=>{
      DEVICES.splice(0,DEVICES.length,...Array.from({length:count},(_,i)=>({id:i+1,_fasheId:`rx_ch${i+1}`,receiver_ip:'192.0.2.1',
       channel_number:i+1,brand:'DATYaudio',model:'DATY-X1',freq:641000+i*250,rf:-35,_online:true,status:'online'})));
     },count);
     const before=await page.evaluate(()=>JSON.stringify(DEVICES));
     const manual=await dashboard(`${width}-${count}-manual`);
     assert.deepEqual(manual.range,await page.evaluate(()=>getPlanningSpectrumRangeMHz(DatyPlanningConstraints.readPlanningRange())));
     await page.evaluate(()=>switchPanel('spectrum'));
     await page.getByRole('button',{name:'⤢ 适配设备',exact:true}).click();
     const spectrum=await page.evaluate(()=>({range:[Number(document.getElementById('specStart').value),Number(document.getElementById('specEnd').value)],
      font:['fontFamily','fontSize','color'].map(k=>getComputedStyle(document.getElementById('freqAxis'))[k])}));
     const fitted=await dashboard(`${width}-${count}-fit`);assert.deepEqual(fitted.range,spectrum.range);assert.deepEqual(fitted.font,spectrum.font);
     if(!live)fitted.rects.forEach((r,i)=>assert.ok(Math.abs((r[0]+r[2]/2-56)/(fitted.width-104)-(i+.5)/count)<1e-6));
     await page.evaluate(()=>switchPanel('spectrum'));
     await page.getByRole('button',{name:'↩ 恢复范围',exact:true}).click();
     assert.deepEqual((await dashboard(`${width}-${count}-restored`)).range,manual.range);
     if(!live)assert.equal(await page.evaluate(()=>JSON.stringify(DEVICES)),before);
     console.log(JSON.stringify({live,size:[width,height],count,dpr,manual:manual.range,fitted:fitted.range}));
    }
   }
   if(!live){
    // Irregular/duplicate frequencies, bounds and changed telemetry must use frequency, never channel index.
    await page.evaluate(()=>{
     DEVICES.splice(0,DEVICES.length,...[650000,641000,641250,642000,641250,640000,650001,639999].map((freq,i)=>({id:i+1,channel_number:i+1,_fasheId:`irregular${i}`,freq,rf:-30-i*5,status:'online'})));
     switchPanel('spectrum');
    });
    // Isolated narrow chart fixture; display state has no editable spectrum inputs.
    await page.evaluate(()=>{document.getElementById('specStart').value='640.000';document.getElementById('specEnd').value='650.000';updateRangeDisplay(false);});
    const irregular=await dashboard('irregular');assert.equal(irregular.expected.length,6);assert.deepEqual(irregular.range,[640,650]);
    await page.evaluate(()=>{DEVICES[1].freq=646000;DEVICES[1].rf=-65;forceRefreshAllPanels({realtime:true});});
    await dashboard('telemetry');
    await page.reload();
    const restored=await page.evaluate(()=>getPlanningSpectrumRangeMHz(DatyPlanningConstraints.readPlanningRange()));
    assert.deepEqual((await dashboard('reload')).range,restored,'Reload derives the view from current planning, not an old manual zoom');
   }
   assert.deepEqual(errors,[]);assert.deepEqual(controls,[]);await context.close();
  }
  console.log('PASS: shared manual MHz axis/fit/restore, actual RF positions/heights, DOM fonts, resize/DPR, no controls. Screenshots: '+output);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
