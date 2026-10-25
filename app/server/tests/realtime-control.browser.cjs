// Real Edge DOM, production modules, isolated SSE/HTTP fixtures. No live commands.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const context=await browser.newContext({viewport:{width:1366,height:768}}), errors=[], commands=[];
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  try {
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(request.method()==='GET' && url.origin==='https://127.0.0.1:8080' &&
         (url.pathname==='/unirf-app.html'||/^\/src\/.*\.(css|js)$/.test(url.pathname))) {
        return route.fulfill({path:path.join(root,decodeURIComponent(url.pathname))});
      }
      if(url.pathname==='/api/auth/status')throw Error('Removed authorization API requested');
      if(url.pathname==='/api/command') {
        assert.equal(url.protocol,'https:');assert.equal(request.headers().authorization,undefined);
        const cmd=JSON.parse(request.postData());commands.push(cmd);
        const id='isolated-'+commands.length;
        const slowResponse=commands.length===1;
        if(slowResponse) {
          const busy=await page.locator('#deviceGridChannels [data-role="mute-button"]').first().evaluate(el=>({disabled:el.disabled,label:el.textContent}));
          assert.equal(busy.disabled,true);assert.match(busy.label,/静音中/);
        }
        // Execute and push genuine fixture state BEFORE completing the POST response.
        await page.evaluate(({cmd,id})=>{
          const d=window.fixture.find(d=>d.id===cmd.device_id);
          if(!d || d.channel_number!==cmd.channel_number) throw Error('wrong command route');
          d.muted=cmd.command==='mute';
          testSse.dispatchEvent(new MessageEvent('device_update',{data:JSON.stringify({devices:[d]})}));
          testSse.dispatchEvent(new MessageEvent('command_update',{data:JSON.stringify({data:{command_id:id,status:'acknowledged',
            device_id:d.id,actual_value:d.muted,command:cmd.command,client_request_id:cmd.client_request_id}})}));
        },{cmd,id});
        // 真正的回归条件：POST 正文尚未完成，按钮必须已经因真实 ACK 解锁。
        if(slowResponse) await new Promise(resolve=>setTimeout(resolve,1200));
        try {return await route.fulfill({json:{success:true,command_id:id}});}
        catch(error) {if(!request.failure()) throw error;} // 已确认请求主动取消迟到的 POST
      }
      return route.fulfill({json:{status:'ok',success:true,devices:[],projects:[],events:[],ip:'127.0.0.1',project:{id:'default'}}});
    });
    await context.addInitScript(()=>{
      window.setInterval=()=>0;
      window.EventSource=class extends EventTarget {
        readyState=1; constructor(){super();window.testSse=this;} close(){this.readyState=2;}
      };
      window.WebSocket=class extends EventTarget {close(){} send(){throw Error('Live sockets are forbidden');}};
    });
    await page.goto('https://127.0.0.1:8080/unirf-app.html');
    await page.waitForFunction(()=>!!window.testSse);
    assert.equal(await page.locator('#datyAccessButton,#datyAccessDialog').count(),0);
    await page.evaluate(()=>{window.notify=()=>{};window.persistPlanningProject=async()=>{};});
    for(const count of [1,2,4,8,32,50,64]) {
      await page.evaluate(count=>{
        window.fixture=Array.from({length:count},(_,i)=>({id:`receiver-a_ch${i+1}`,receiver_id:'receiver-a',receiver_ip:'127.0.0.2',
          receiver_mac:'02:00:00:00:00:01',channel_number:i+1,channel:i+1,brand:'DATYaudio',model:'RF PRO',group:9,
          freq:641000+i*250,af_dbfs:-12,rf:-50,batt:90,muted:false,status:'online',_online:true}));
        fixture.push({...fixture[0],id:'receiver-b_ch1',receiver_id:'receiver-b',receiver_ip:'127.0.0.3',receiver_mac:'02:00:00:00:00:02'});
        testSse.dispatchEvent(new MessageEvent('device_list',{data:JSON.stringify({devices:fixture})}));
        switchPanel('channels');
      },count);
      await page.waitForFunction(n=>document.querySelectorAll('#deviceGridChannels .device-card').length===Math.min(50,n),count+1);
      const otherKey=await page.evaluate(()=>getChannelCardKey(DEVICES.find(d=>d._fasheId==='receiver-b_ch1')));
      const target=page.locator('#deviceGridChannels .device-card').first();
      const clickedAt=performance.now();
      await target.locator('[data-role="mute-button"]').click();
      await page.waitForFunction(()=>!window.__DATY_MUTE_COMMANDS_IN_FLIGHT?.size);
      if(count===1) assert.ok(performance.now()-clickedAt<1000,'unlock must not wait for the delayed POST');
      assert.equal(await target.locator('[data-role="mute-button"]').isDisabled(),false);
      assert.match(await target.locator('[data-role="mute-button"]').textContent(),/取消静音/);
      assert.equal(await page.locator(`#deviceGridChannels [data-device-key="${otherKey}"]`).evaluate(el=>el.classList.contains('muted')),false);
      await target.locator('[data-role="mute-button"]').click();
      await page.waitForFunction(()=>!window.__DATY_MUTE_COMMANDS_IN_FLIGHT?.size);
      assert.equal(await target.evaluate(el=>el.classList.contains('muted')),false);
    }
    // Second page uses receiver + CH, never the row/card position (CH50 here, not CH1).
    await page.click('#channelCardsNextPage');
    const pageTwoTarget=await page.locator('#deviceGridChannels .device-card').first().getAttribute('data-device-key');
    const target=page.locator(`#deviceGridChannels [data-device-key="${pageTwoTarget}"]`);
    for (const expected of [true,false]) {
      await target.locator('[data-role="mute-button"]').click();
      await page.waitForFunction(()=>!window.__DATY_MUTE_COMMANDS_IN_FLIGHT?.size);
      assert.equal(await target.evaluate(el=>el.classList.contains('muted')),expected);
      assert.equal(commands.at(-1).device_id,'receiver-a_ch50');
      assert.equal(commands.at(-1).channel_number,50);
      assert.equal(await page.evaluate(()=>fixture[0].muted),false);
      assert.equal(await page.evaluate(()=>fixture.at(-1).muted),false);
      assert.match(await page.locator('#channelCardsPageInfo').textContent(),/第 2\/2 页/);
    }
    await page.click('#channelCardsFirstPage');
    const patch=await page.evaluate(async()=>{
      const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const send=()=>testSse.dispatchEvent(new MessageEvent('device_update',{data:JSON.stringify({devices:[fixture[0]]})}));
      send();await settle();send();await settle();
      const cards=[...document.querySelectorAll('#deviceGridChannels .device-card')];
      let mutations=0;const observer=new MutationObserver(records=>mutations+=records.length);
      observer.observe(cards[1],{subtree:true,attributes:true,childList:true,characterData:true});
      const started=performance.now();fixture[0].af_dbfs=0;send();await settle();
      const elapsed=performance.now()-started;
      observer.disconnect();
      fixture[0].rf=-90;send();fixture[0].rf=-50;send();await settle();
      switchPanel('dashboard'); const online=document.getElementById('statOnlineCount').textContent;
      switchPanel('channels');
      return {sameNode:cards[0]===document.querySelector('#deviceGridChannels .device-card'),mutations,online,elapsed,
        af:cards[0].querySelector('[data-meter-value="af"]').textContent,
        transition:getComputedStyle(cards[0].querySelector('[data-meter-fill="rf"]')).transitionDuration};
    });
    assert.equal(patch.sameNode,true);assert.equal(patch.mutations,0);assert.equal(patch.online,'2');
    assert.equal(patch.af,'0.0 dBFS');assert.equal(patch.transition,'0s');
    assert.equal(commands.length,16);assert.deepEqual(errors,[]);
    console.log('PASS: 1/2/4/8/32/50/64CH, same-CH receiver isolation, mute/unmute via buttons + ACK-before-POST, in-place cards, AF 0 dBFS, hidden panel re-entry.');
    console.log(JSON.stringify(patch));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
