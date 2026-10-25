// Isolated by default. --live allows only read-only local GETs; never receiver controls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..'),live=process.argv.includes('--live'),output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-spectrum-fit-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 try{
  const context=await browser.newContext(),page=await context.newPage(),errors=[],controls=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>{
   const r=route.request(),u=new URL(r.url());
   if(u.pathname==='/api/command')controls.push(r.postData());
   if(live)return r.method()==='GET'&&['localhost','127.0.0.1'].includes(u.hostname)&&['8080','8802','8765'].includes(u.port)?route.continue():route.abort();
   if(r.method()==='GET'&&u.origin==='https://localhost:8080'&&(u.pathname==='/unirf-app.html'||/^\/src\/.*\.(css|js)$/.test(u.pathname)))return route.fulfill({path:path.join(root,u.pathname)});
   return route.fulfill({json:{status:'ok',success:true,devices:[],projects:[],events:[],ip:'127.0.0.1',project:{id:'default'}}});
  });
  await context.addInitScript(live=>{
   window.WebSocket=class extends EventTarget{close(){}send(){throw Error('Live controls forbidden');}};
   // An isolated browser profile emulates an existing manually saved range; no user-profile writes.
   if(live){localStorage.setItem('specStartFreq','640.000');localStorage.setItem('specEndFreq','690.000');}
   if(!live){window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};}
  },live);
  await page.goto('https://localhost:8080/unirf-app.html');
  assert.equal(await page.locator('#scanStatus').count(),0,'Removed topbar scan badge must not return');
  assert.equal(await page.locator('.topbar-actions #datyAccessButton').count(),1);
  assert.equal(await page.locator('.topbar-actions button[onclick="doScan()"]').count(),1);
  assert.equal(await page.locator('.topbar-actions button[onclick="doConnect()"]').count(),1);
  if(live)await page.waitForFunction(()=>DEVICES.length>0,{},{timeout:15000});
  await page.evaluate(()=>{window.notify=()=>{};switchPanel('spectrum');});
  const counts=live?[await page.evaluate(()=>filterRealtimeFasheDevices(DEVICES).length)]:[1,2,4,8,50];
  for(const [width,height]of[[1366,768],[1920,1080]]){
   await page.setViewportSize({width,height});
   for(const count of counts){
    if(!live)await page.evaluate(count=>{
     DEVICES.splice(0,DEVICES.length,...Array.from({length:count},(_,i)=>({id:i+1,_fasheId:`rx_ch${i+1}`,receiver_ip:'192.0.2.1',
      channel_number:i+1,brand:'DATYaudio',model:'DATY-X1',freq:641000+i*250,rf:-35,_online:true,status:'online'})));
     document.getElementById('specStart').value='640.000';document.getElementById('specEnd').value='690.000';updateRangeDisplay();drawSpectrum();updateSpectrumDataSummary();
    },count);
    const before=await page.evaluate(()=>({range:[document.getElementById('specStart').value,document.getElementById('specEnd').value],data:JSON.stringify(DEVICES),saved:[localStorage.getItem('specStartFreq'),localStorage.getItem('specEndFreq')]}));
    await page.getByRole('button',{name:'⤢ 适配设备',exact:true}).click();
    const state=await page.evaluate(()=>{
     const labels=[...document.querySelectorAll('.spectrum-channel-label')],canvas=document.getElementById('spectrumCanvas'),bounds=canvas.getBoundingClientRect();
     const overlaps=labels.flatMap((a,i)=>labels.slice(i+1).filter(b=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return Math.min(ar.right,br.right)-Math.max(ar.left,br.left)>1&&Math.min(ar.bottom,br.bottom)-Math.max(ar.top,br.top)>1;}).map(b=>a.textContent+'/'+b.textContent));
     return {range:[document.getElementById('specStart').value,document.getElementById('specEnd').value],count:labels.length,overlaps,
      left:labels.map(e=>parseFloat(e.style.left)),clipped:labels.filter(e=>{const r=e.getBoundingClientRect();return r.left<bounds.left-1||r.right>bounds.right+1;}).length,
      canvas:[bounds.width,bounds.height],ticks:[...document.querySelectorAll('#freqAxis>span>span')].map(e=>({left:parseFloat(e.style.left),text:e.textContent}))};
    });
    assert.equal(state.count,count);assert.equal(state.clipped,0);assert.deepEqual(state.overlaps,[]);assert.ok(state.ticks.length>=3);
    if(!live)state.left.forEach((left,i)=>assert.ok(Math.abs(left-(i+.5)*100/count)<1e-6));
    assert.ok(state.ticks[0].left===0&&state.ticks.at(-1).left===100);
    if(live){
     const point=await page.evaluate(()=>{
      const canvas=document.getElementById('spectrumCanvas'),s=spectrumPointHoverStates.get(canvas),m=s.markers.at(-1),r=canvas.getBoundingClientRect();
      return {x:r.left+m.x/s.width*r.width,y:Math.min(r.bottom-2,r.top+m.y/s.height*r.height),
       stemY:Math.min(r.bottom-2,r.top+(m.y/s.height+1)/2*r.height),
       text:`${_formatSpectrumChannelLabel(m.device,m.index)} · ${(m.freqKHz/1000).toFixed(3)} MHz`};
     });
     await page.mouse.move(point.x,point.y);
     await page.locator('#spectrumPointTooltip').waitFor({state:'visible'});
     assert.equal(await page.locator('#spectrumPointTooltip').textContent(),point.text);
     await page.mouse.move(point.x,point.stemY);
     await page.locator('#spectrumPointTooltip').waitFor({state:'visible'});
     assert.equal(await page.locator('#spectrumPointTooltip').textContent(),point.text);
     state.hover=point.text;
    }
    await page.locator('#panel-spectrum').screenshot({path:path.join(output,`${live?'live':'fixture'}-${width}-${count}.png`)});
    await page.getByRole('button',{name:'↩ 恢复范围',exact:true}).click();
    const after=await page.evaluate(()=>({range:[document.getElementById('specStart').value,document.getElementById('specEnd').value],data:JSON.stringify(DEVICES),saved:[localStorage.getItem('specStartFreq'),localStorage.getItem('specEndFreq')]}));
    assert.deepEqual(after.range,before.range);assert.deepEqual(after.saved,before.saved);if(!live)assert.equal(after.data,before.data);
    console.log(JSON.stringify({live,size:[width,height],...state}));
   }
  }
  assert.deepEqual(errors,[]);assert.deepEqual(controls,[]);console.log('PASS: spectrum fit/restore, equal frequency spacing, labels, real MHz axis. Screenshots: '+output);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
