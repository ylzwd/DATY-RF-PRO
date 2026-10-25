// Isolated browser + real WebAudio graph. All HTTP is fulfilled locally; no field commands.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-alert-sound-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  args:['--autoplay-policy=document-user-activation-required']});
 try{
  const context=await browser.newContext(),page=await context.newPage(),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>{
   const r=route.request(),u=new URL(r.url());if(r.method()!=='GET')writes.push(r.url());
   if(r.method()==='GET'&&u.origin==='https://localhost:8080'&&
    (u.pathname==='/unirf-app.html'||u.pathname==='/DATYlogo.png'||/^\/src\/.*\.(css|js|png)$/.test(u.pathname)))
    return route.fulfill({path:path.join(root,u.pathname)});
   return route.fulfill({json:{status:'ok',success:true,devices:[],events:[],projects:[],project:{id:'default'},ip:'127.0.0.1'}});
  });
  await context.addInitScript(()=>{
   window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};
   window.WebSocket=class extends EventTarget{close(){}send(){throw Error('No real sockets');}};
   const NativeAudio=window.AudioContext;window.soundGraphs=[];window.soundStarts=[];
   window.AudioContext=class extends NativeAudio{
    constructor(){super();soundGraphs.push(this);}
    createOscillator(){const osc=super.createOscillator(),start=osc.start.bind(osc),frequencies=[];
     const setFrequency=osc.frequency.setValueAtTime.bind(osc.frequency);
     osc.frequency.setValueAtTime=(value,time)=>{frequencies.push(value);return setFrequency(value,time);};
     // AudioParam.value may still be its default before the first render quantum;
     // inspect the scheduled production automation, not that stale initial value.
     osc.start=(...args)=>{soundStarts.push({frequency:frequencies[0],time:this.currentTime});return start(...args);};return osc;}
   };
  });
  await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
  await page.evaluate(()=>{
   switchPanel('settings');
   window.setFixture=(values={})=>{
    DEVICES.splice(0,DEVICES.length,{id:'fixture_ch1',_fasheId:'fixture_ch1',receiver_id:'fixture',
     receiver_ip:'192.0.2.1',channel_number:1,ch:'CH1',brand:'DATYaudio',model:'Fixture',
     _online:true,status:'online',freq:641000,rf:-50,batt:90,afDbfs:-20,...values});
    evaluateRealtimeAlerts(DEVICES);
   };
   setFixture({rf:-95});
  });
  assert.equal(await page.evaluate(()=>soundStarts.length),0,'No playback before user gesture');
  assert.match(await page.locator('#soundAlertStatus').textContent(),/待启用/);
  // A trusted ordinary page click unlocks the pending CURRENT alert, without auth.
  await page.locator('#pageTitle').click();
  await page.waitForFunction(()=>soundStarts.length===1);
  assert.equal(await page.evaluate(()=>soundGraphs[0].state),'running');
  await page.evaluate(()=>{for(let i=0;i<30;i++)setFixture({rf:-96-i%3});});
  assert.equal(await page.evaluate(()=>soundStarts.length),1);
  await page.waitForFunction(()=>soundStarts.length===2,{},{timeout:5000});
  assert.ok(await page.evaluate(()=>soundStarts[1].time-soundStarts[0].time>=1.8),'RF repeats on a 2-second cadence');
  await page.evaluate(()=>setFixture({afDbfs:0}));
  await page.waitForFunction(()=>soundStarts.length===3,{},{timeout:5000});
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,2200)));
  assert.equal(await page.evaluate(()=>soundStarts.length),3,'Sustained AF alone must stay edge-only');
  await page.evaluate(()=>setFixture({batt:10,afDbfs:0}));
  await page.waitForFunction(()=>soundStarts.length===4,{},{timeout:5000});
  await page.waitForFunction(()=>soundStarts.length===5,{},{timeout:5000});
  assert.deepEqual(await page.evaluate(()=>soundStarts.map(s=>s.frequency)),[660,660,880,660,660],
   'Battery keeps repeating warning tone, not sustained AF critical tone');
  await page.locator('#soundAlertControls .toggle').click();
  assert.equal(await page.locator('#soundAlertEnabled').isChecked(),false);
  assert.equal(await page.locator('#soundAlertTest').isDisabled(),true);
  await page.evaluate(()=>{setFixture();setFixture({batt:10,afDbfs:0});});
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,2200)));
  assert.equal(await page.evaluate(()=>soundStarts.length),5);
  assert.equal(await page.locator('#alertList .alert-item').count(),2,'Visual alerts stay active when sound is off');
  await page.reload({waitUntil:'networkidle'});
  assert.equal(await page.locator('#soundAlertEnabled').isChecked(),false,'Preference survives reload');
  await page.evaluate(()=>switchPanel('settings'));
  await page.locator('#soundAlertControls .toggle').click();
  await page.locator('#soundAlertTest').click();
  await page.waitForFunction(()=>soundStarts.length===1);
  assert.equal(await page.evaluate(()=>ALERTS.length),0,'Preview must not create alerts');
  await page.evaluate(()=>soundGraphs[0].suspend());
  await page.waitForFunction(()=>document.getElementById('soundAlertStatus').textContent.includes('待启用'));
  await page.locator('#soundAlertTest').click();
  await page.waitForFunction(()=>soundStarts.length===2&&soundGraphs[0].state==='running');
  // Render the actual production oscillator/envelope through OfflineAudioContext.
  const waveform=await page.evaluate(async()=>{
   const offline=new OfflineAudioContext(1,48000,48000);
   const factory=DatyAlertSoundFactory.createBrowserOutput({AudioContext:class{
    constructor(){return {state:'running',currentTime:0,destination:offline.destination,
     createOscillator:()=>offline.createOscillator(),createGain:()=>offline.createGain()};}
   }});
   await factory.unlock();if(!factory.play({level:'crit'}))throw Error('Not scheduled');
   const samples=(await offline.startRendering()).getChannelData(0);
   const peak=(from,to)=>samples.subarray(from,to).reduce((a,b)=>Math.max(a,Math.abs(b)),0);
   return {first:peak(1000,5000),gap:peak(8500,10000),second:peak(12000,15500),after:peak(21000,48000)};
  });
  assert.ok(waveform.first>0.07&&waveform.first<0.081);assert.ok(waveform.second>0.07&&waveform.second<0.081);
  assert.ok(waveform.gap<0.0001);assert.equal(waveform.after,0);
  // Optional file-level pre-change baseline: other settings retain their geometry.
  let baselinePage=null;
  if(process.env.SOUND_UI_BASELINE){
   baselinePage=await context.newPage();
   await baselinePage.route('**/*',route=>{
    const u=new URL(route.request().url()),relative=u.pathname.replace(/^\//,'');
    if(u.origin==='https://localhost:8080'&&(relative==='unirf-app.html'||/^src\/.*\.(js|css|png)$/.test(relative))){
     const archived=path.join(process.env.SOUND_UI_BASELINE,relative);
     if(fs.existsSync(archived))return route.fulfill({path:archived});
    }
    return route.fallback();
   });
   await baselinePage.goto('https://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
   await baselinePage.evaluate(()=>switchPanel('settings'));
  }
  const unchangedGeometry=()=>{
   const card=document.getElementById('rfThreshInput').closest('.card');
   const automatic=card.querySelector('.card-title').nextElementSibling.lastElementChild;
   return [...document.querySelectorAll('#rfThreshInput,#battThreshInput,#afThreshInput,.settings-grid>.card'),automatic]
    .map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height];});
  };
  for(const [width,height]of[[1920,1080],[1366,768],[1280,720],[1024,768],[1024,600]]){
   await page.setViewportSize({width,height});
   if(baselinePage){
    await baselinePage.setViewportSize({width,height});
    assert.deepEqual(await page.evaluate(unchangedGeometry),await baselinePage.evaluate(unchangedGeometry),'Other settings must not move');
   }
   const layout=await page.evaluate(()=>{
    const row=document.getElementById('soundAlertControls').parentElement,bounds=row.getBoundingClientRect();
    const toggle=document.querySelector('#soundAlertControls .toggle').getBoundingClientRect();
    const button=document.getElementById('soundAlertTest').getBoundingClientRect();
    return {overflow:['html','body','.content','#panel-settings'].filter(s=>{
     const e=document.querySelector(s);return e.scrollHeight>e.clientHeight+1||e.scrollWidth>e.clientWidth+1;}),
     clipped:toggle.right>bounds.right+1||button.left<bounds.left-1||toggle.bottom>innerHeight||button.bottom>innerHeight};
   });
   assert.deepEqual(layout.overflow,[]);assert.equal(layout.clipped,false);
   await page.screenshot({path:path.join(output,`settings-${width}-${height}.png`)});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  console.log('PASS: RF/battery repeat, AF edge-only, mixed severity, autoplay, audio graph, toggle/reload, preview, five fixed-window layouts.');
  console.log(JSON.stringify({waveform,screenshots:output}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
