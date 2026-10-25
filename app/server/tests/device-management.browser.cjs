// Production UI in isolated Edge: all APIs mocked, no real controls, edits or cache deletion.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-device50-'));
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  try{
    const context=await browser.newContext(),page=await context.newPage(),errors=[],controls=[];
    page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/*',route=>{
      const r=route.request(),u=new URL(r.url());
      if(r.method()==='GET'&&u.origin==='https://localhost:8080'&&(u.pathname==='/unirf-app.html'||/^\/src\/.*\.(css|js)$/.test(u.pathname)))
        return route.fulfill({path:path.join(root,u.pathname)});
      if(u.pathname==='/api/command')controls.push(r.postData());
      return route.fulfill({json:{success:true,status:'ok',devices:[],events:[],projects:[],project:{id:'default'},ip:'127.0.0.1'}});
    });
    await context.addInitScript(()=>{
      window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};
      window.WebSocket=class extends EventTarget{close(){}send(){throw Error('Real socket forbidden');}};
    });
    await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
    await page.evaluate(()=>{
      window.fixture=n=>{
        DEVICES.splice(0,DEVICES.length,...Array.from({length:n},(_,i)=>({id:i%2===0?`id " ${i}`:i+1,
          _fasheId:`receiver-${i%2}_ch${Math.floor(i/2)+1}`,receiver_mac:`02:00:00:00:00:0${i%2+1}`,
          receiver_ip:`192.0.2.${i%2+1}`,ip:`192.0.2.${i%2+1}`,channel_number:Math.floor(i/2)+1,
          brand:'DATYaudio',model:'DATY-X1',name:`频道 ${i} <>&" `+'完整名称'.repeat(i===0?70:1),
          freq:641000+i*25,rf:-50,af_dbfs:0,batt:90,muted:false,_online:true,status:'online'})).reverse());
        goManagedDevicePage(1);renderDevTable();
      };
      window.editTargets=[];window.editDevice=id=>editTargets.push(id);
      fixture(0);switchPanel('devices');
    });
    async function check(label,count){
      const layout=await page.evaluate(()=>{
        const grid=document.getElementById('devTableBody'),bounds=grid.getBoundingClientRect();
        const overflow=['.content','#panel-devices','#devOnline','#managedDeviceViewport','#devTableBody'].map(s=>{
          const e=document.querySelector(s);return {selector:s,client:[e.clientWidth,e.clientHeight],scroll:[e.scrollWidth,e.scrollHeight]};
        }).filter(e=>e.scroll[0]>e.client[0]+1||e.scroll[1]>e.client[1]+1);
        const cards=[...grid.querySelectorAll('.managed-device-card')];
        const clipped=cards.flatMap(card=>{
          const r=card.getBoundingClientRect();
          if(r.bottom>bounds.bottom+1||r.right>bounds.right+1)return ['card'];
          return [...card.children].filter(e=>e.getClientRects().length).filter(e=>{const t=e.getBoundingClientRect();return t.bottom>r.bottom-1||t.top<r.top;}).map(e=>e.className);
        });
        const frequencies=cards.filter(card=>{const f=card.querySelector('.managed-device-frequency');return f.scrollWidth>f.clientWidth+1||(f.textContent.match(/MHz/g)||[]).length!==1;}).length;
        const truncatedChannels=cards.filter(card=>{const ch=card.querySelector('.managed-device-channel');return ch.scrollWidth>ch.clientWidth+1;}).length;
        return {overflow,clipped,frequencies,truncatedChannels,count:cards.length,height:cards[0]?.getBoundingClientRect().height,
          columns:getComputedStyle(grid).gridTemplateColumns,mainOverflow:getComputedStyle(document.querySelector('.content')).overflowY};
      });
      assert.deepEqual(layout.overflow,[],label+JSON.stringify(layout));assert.deepEqual(layout.clipped,[],label+JSON.stringify(layout));
      assert.equal(layout.frequencies,0,label);assert.equal(layout.truncatedChannels,0,label);assert.equal(layout.count,count,label);assert.equal(layout.mainOverflow,'hidden');return layout;
    }
    for(const [width,height]of[[1920,1080],[1366,768],[1280,720],[1024,768],[1024,600]]){
      await page.setViewportSize({width,height});await page.evaluate(()=>fixture(0));await check(`${width}x${height} empty`,0);
      await page.evaluate(()=>fixture(205));const before=await page.evaluate(()=>JSON.stringify(DEVICES));
      const first=await check(`${width}x${height} page1`,50);
      await page.screenshot({path:path.join(output,`${width}x${height}.png`)});
      const expected=await page.evaluate(()=>getManagedDevicePage(DEVICES,2).devices[0].id);
      await page.click('#managedDeviceNextPage');await check(`${width}x${height} page2`,50);
      await page.locator('.managed-device-card').first().click();
      assert.equal(await page.locator('#managedDeviceDialog').evaluate(e=>e.open),true);
      await page.click('#managedDeviceEdit');assert.equal(await page.evaluate(()=>editTargets.at(-1)),expected);
      const ids=[];await page.click('#managedDeviceFirstPage');
      for(let p=1;p<=5;p++){
        await check(`${width}x${height} page${p}`,p===5?5:50);
        ids.push(...await page.locator('.managed-device-card').evaluateAll(cards=>cards.map(c=>c.dataset.deviceKey)));
        if(p<5)await page.click('#managedDeviceNextPage');
      }
      assert.equal(new Set(ids).size,205);assert.equal(await page.evaluate(()=>JSON.stringify(DEVICES)),before);
      await page.evaluate(()=>{DEVICES.splice(1);renderDevTable();});await check(`${width}x${height} shrink`,1);
      assert.match(await page.locator('#managedDevicePageInfo').textContent(),/第 1\/1 页/);
      await page.getByText('协议状态',{exact:true}).click();
      assert.equal(await page.locator('.content').evaluate(e=>e.classList.contains('device-management-view')),false);
      await page.locator('#tabOnlineCount').click();await check(`${width}x${height} return`,1);
      console.log(JSON.stringify({viewport:[width,height],...first}));
    }
    await page.evaluate(()=>fixture(51));await page.click('#managedDeviceNextPage');
    const identity=await page.locator('.managed-device-card').first().getAttribute('data-device-key');
    await page.locator('.managed-device-card').first().click();
    await page.evaluate(()=>{const d=DEVICES.find(d=>getChannelCardKey(d)===managedDeviceDetailKey);d.freq=680125;renderDevTable();});
    assert.match(await page.locator('#managedDeviceDetailFields').textContent(),/680.125/);
    assert.equal(await page.locator('#managedDeviceDisconnect').isDisabled(),true);
    await page.keyboard.press('Escape');
    const mutation=await page.evaluate(async()=>{
      const card=document.querySelector('.managed-device-card');let n=0;
      const observer=new MutationObserver(r=>n+=r.length);observer.observe(card,{subtree:true,attributes:true,childList:true,characterData:true});
      renderDevTable();await Promise.resolve();observer.disconnect();return {same:card===document.querySelector('.managed-device-card'),n};
    });
    assert.deepEqual(mutation,{same:true,n:0});
    assert.equal(await page.locator('.managed-device-card').first().getAttribute('data-device-key'),identity);
    await page.evaluate(()=>switchPanel('channels'));
    assert.equal(await page.locator('.content').evaluate(e=>e.classList.contains('device-management-view')),false);
    assert.deepEqual(errors,[]);assert.deepEqual(controls,[]);console.log('PASS: device-management 50/page, layout, identity, detail, live patch, no controls. Screenshots: '+output);
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
