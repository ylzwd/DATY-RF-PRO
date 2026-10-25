// Shared progress view in isolated Edge: fixtures supply already-validated ACK counts.
// No production device, Bridge, project database or socket is accessed by this test.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require('playwright'),root=path.join(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.EDGE_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 const context=await browser.newContext({viewport:{width:1366,height:768}}),requests=[],nativeDialogs=[],errors=[];
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-deploy-progress-'));
 try{
  await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',async dialog=>{nativeDialogs.push(dialog.message());await dialog.dismiss();});
  await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Isolated deployment progress</title></head><body><main><button id="fixtureOpener">下发</button><button id="fixtureOutside">其他功能</button></main></body></html>');
  for(const name of ['main.css','deploy-progress.css'])await page.addStyleTag({content:fs.readFileSync(path.join(root,'src/styles',name),'utf8').replace(/^\uFEFF/,'')});
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'src/modules/deploy-progress.js'),'utf8')});
  const options=count=>({title:count===1?'单通道下发 · 等待接收机确认':'全部下发 · 等待接收机确认',rows:Array.from({length:count},(_,i)=>({
   id:'receiver-channel-'+i,brand:'DATYaudio',receiver:'192.0.2.'+(1+Math.floor(i/8)),channel:'CH'+(i%8+1),frequency:(641+i*.25).toFixed(3)+' MHz'}))});
  const snapshot=(count,values={})=>({phase:'running',total:count,acknowledged:0,skipped:0,failed:0,remaining:count,rows:[],...values});
  async function open(opts){await page.focus('#fixtureOpener');await page.evaluate(opts=>{
   window.fixtureStops=0;window.fixtureHandle=DatyDeployProgress.open({...opts,onStop:()=>window.fixtureStops++});
  },opts);await page.locator('#datyProgressDialog').waitFor({state:'visible'});}
  async function update(value){await page.evaluate(value=>fixtureHandle.update(value),value);}
  async function bar(){return page.$eval('#datyProgressBar',bar=>({value:bar.value,max:bar.max}));}
  async function close(){await page.click('#datyProgressClose');assert.equal(await page.locator('#datyProgressDialog').count(),0);assert.equal(await page.evaluate(()=>document.activeElement?.id),'fixtureOpener');}

  // A single channel is never "almost done" based on elapsed time or HTTP publishing.
  await open(options(1));assert.deepEqual(await bar(),{value:0,max:1});
  assert.equal(await page.getAttribute('#datyProgressDialog','aria-labelledby'),'datyProgressTitle');
  assert.equal(await page.locator('#datyProgressClose').isVisible(),false);
  assert.equal(await page.locator('#datyProgressDismiss').isDisabled(),true);
  for(const invalid of [snapshot(1,{phase:'success',remaining:0}),snapshot(1,{phase:'success',skipped:1,remaining:0}),snapshot(1,{acknowledged:1,remaining:1}),snapshot(1,{acknowledged:-1,remaining:2})]){
   assert.equal(await page.evaluate(value=>{try{fixtureHandle.update(value);return false;}catch(_){return true;}},invalid),true,'Invalid counts or success without a device ACK must be rejected.');
   assert.deepEqual(await bar(),{value:0,max:1});assert.doesNotMatch(await page.textContent('#datyProgressTitle'),/成功/);
  }
  await update(snapshot(1,{currentLabel:'DATYaudio · CH1 · 192.0.2.1',message:'指令已发送，等待接收机确认',rows:[{id:'receiver-channel-0',state:'sending',text:'等待设备 ACK'}]}));
  await page.waitForTimeout(180);assert.deepEqual(await bar(),{value:0,max:1});
  await page.keyboard.press('Escape');await page.evaluate(()=>fixtureHandle.close());
  assert.equal(await page.locator('#datyProgressDialog').isVisible(),true,'Neither Escape nor host close may hide a pending command.');
  assert.equal(await page.evaluate(()=>{try{DatyDeployProgress.open({rows:[{id:'other'}]});return false;}catch(_){return true;}}),true,'A second progress window cannot replace an active operation.');
  for(const key of ['Tab','Shift+Tab'])for(let i=0;i<6;i++){await page.keyboard.press(key);assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('#datyProgressDialog')),true);}
  await update(snapshot(1,{phase:'success',acknowledged:1,remaining:0,rows:[{id:'receiver-channel-0',state:'acknowledged',text:'接收机已确认 641.000 MHz'}]}));
  assert.deepEqual(await bar(),{value:1,max:1});assert.match(await page.textContent('#datyProgressTitle'),/下发成功/);
  assert.match(await page.textContent('#datyProgressRows'),/接收机已确认 641\.000 MHz/);
  assert.equal(await page.locator('#datyProgressStop').isVisible(),false);
  await update(snapshot(1));assert.match(await page.textContent('#datyProgressTitle'),/成功/,'Late running updates cannot erase the final receiver result.');
  await page.screenshot({path:path.join(output,'single-ack-success.png')});await close();

  // Partial ACK and unchanged skips advance the batch honestly; failures never count as ACK.
  await open(options(4));
  await update(snapshot(4,{acknowledged:1,skipped:1,remaining:2,rows:[{id:'receiver-channel-0',state:'acknowledged'},{id:'receiver-channel-1',state:'unchanged'},{id:'receiver-channel-2',state:'sending'}]}));
  assert.deepEqual(await bar(),{value:2,max:4});assert.equal(await page.textContent('#datyProgressValue'),'50%');
  await update(snapshot(4,{phase:'failed',acknowledged:1,skipped:1,failed:1,remaining:1,message:'ACK 的频率与目标不匹配；后续通道已停止',rows:[{id:'receiver-channel-2',state:'failed',text:'设备确认的频率不匹配'},{id:'receiver-channel-3',state:'not-sent'}]}));
  assert.deepEqual(await bar(),{value:2,max:4});assert.match(await page.textContent('#datyProgressTitle'),/下发失败/);
  assert.doesNotMatch(await page.textContent('#datyProgressTitle'),/成功/);assert.match(await page.textContent('#datyProgressRows'),/频率不匹配/);
  await page.screenshot({path:path.join(output,'batch-ack-mismatch-failure.png')});await close();

  // Stop affects subsequent commands only: keep the in-flight ACK visible and count it normally.
  await open(options(4));await page.click('#datyProgressStop');
  assert.equal(await page.evaluate(()=>fixtureStops),1);assert.equal(await page.locator('#datyProgressStop').isDisabled(),true);
  await page.$eval('#datyProgressStop',button=>button.click());assert.equal(await page.evaluate(()=>fixtureStops),1);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#datyProgressDialog').isVisible(),true);
  await update(snapshot(4,{phase:'stopped',acknowledged:1,remaining:3,message:'当前接收机已确认；其余 3 个通道未发送'}));
  assert.deepEqual(await bar(),{value:1,max:4});assert.match(await page.textContent('#datyProgressTitle'),/已停止/);await close();

  // All unchanged is explicitly "not sent", never "receiver ACK success".
  await open(options(4));await update(snapshot(4,{phase:'unchanged',skipped:4,remaining:0}));
  assert.deepEqual(await bar(),{value:4,max:4});assert.match(await page.textContent('#datyProgressTitle'),/无需下发/);
  assert.doesNotMatch(await page.textContent('#datyProgressTitle'),/成功/);assert.match(await page.textContent('#datyProgressMessage'),/未发送指令/);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#datyProgressDialog').count(),0);

  // A before-send setup failure releases the modal honestly with no completed receiver rows.
  await open(options(4));await page.evaluate(()=>fixtureHandle.failBeforeSend('下发前目标已离线，本次未发送'));
  assert.deepEqual(await bar(),{value:0,max:4});assert.match(await page.textContent('#datyProgressTitle'),/下发失败/);
  assert.match(await page.textContent('#datyProgressMessage'),/本次未发送/);await close();

  // Receiver-supplied labels and error messages must be text, not markup.
  const payload='<img src=x onerror="window.fixtureInjected=true">',unsafe=options(1);unsafe.title=payload;
  for(const field of ['brand','receiver','channel','frequency'])unsafe.rows[0][field]=payload;
  await open(unsafe);await update(snapshot(1,{message:payload,currentLabel:payload,rows:[{id:'receiver-channel-0',state:'sending',text:payload}]}));
  for(const id of ['datyProgressTitle','datyProgressMessage','datyProgressRows','datyProgressCurrent'])assert.ok((await page.textContent('#'+id)).includes(payload));
  assert.equal(await page.locator('#datyProgressDialog img, #datyProgressDialog script').count(),0);assert.equal(await page.evaluate(()=>!!window.fixtureInjected),false);
  await update(snapshot(1,{phase:'failed',failed:1,remaining:0,message:payload}));await close();

  // Long batches scroll only the inner list, keeping the meter and stop/close actions visible.
  for(const [width,height]of [[1920,1080],[1366,768],[1024,600]]){
   await page.setViewportSize({width,height});
   for(const count of [1,4,50,64]){
    await open(options(count));assert.equal(await page.locator('#datyProgressRows tr').count(),count);
    const measure=()=>page.locator('#datyProgressDialog').evaluate(dialog=>{
     const inside=element=>{const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=-1&&r.top>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;};
     const action=document.getElementById(dialog.dataset.phase==='running'?'datyProgressStop':'datyProgressClose');
     const scrollable=[...dialog.querySelectorAll('*')].filter(element=>/auto|scroll/.test(getComputedStyle(element).overflowY)&&element.scrollHeight>element.clientHeight+1);
     return {bounded:inside(dialog),actions:inside(action)&&inside(document.getElementById('datyProgressTitle'))&&inside(document.getElementById('datyProgressBar')),
      pageOverflow:document.documentElement.scrollHeight>innerHeight+1||document.documentElement.scrollWidth>innerWidth+1,horizontalOverflow:dialog.scrollWidth>dialog.clientWidth+1,scrollable:scrollable.length};
    });
    for(const phase of ['running','success']){
     if(phase==='success')await update(snapshot(count,{phase,acknowledged:count,remaining:0,rows:options(count).rows.map(row=>({id:row.id,state:'acknowledged',text:'接收机已确认 '+row.frequency}))}));
     const result=await measure(),label=`${width}x${height}/${count}/${phase}`;
     assert.equal(result.bounded,true,label+': bounded modal');assert.equal(result.actions,true,label+': title/meter/actions visible');
     assert.equal(result.pageOverflow,false,label+': no page scrollbar');assert.equal(result.horizontalOverflow,false,label+': no horizontal clipping');
     if(count>=50)assert.ok(result.scrollable>=1,label+': long rows scroll internally');
     if(count===64&&(width===1024||width===1920))await page.screenshot({path:path.join(output,`${width}-64-${phase}.png`)});
    }
    if(count>=50){
     const lastVisible=await page.locator('#datyProgressRows').evaluate(rows=>{const region=rows.closest('.daty-progress-table-wrap');region.scrollTop=region.scrollHeight;const last=rows.lastElementChild.getBoundingClientRect(),bounds=region.getBoundingClientRect();return last.top>=bounds.top-1&&last.bottom<=bounds.bottom+1;});
     assert.equal(lastVisible,true,'The last receiver row remains reachable.');
    }
    await close();
   }
  }
  assert.deepEqual(requests,[]);assert.deepEqual(nativeDialogs,[]);assert.deepEqual(errors,[]);
  console.log('PASS: receiver-ACK-only progress, waiting/success/failure/stopped/unchanged phases, stop-once and in-flight protection, modal focus and safe text, 1/4/50/64-channel bounded layouts at three sizes; zero network/control requests. '+output);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
