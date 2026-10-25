// Production files, isolated fixtures: never send commands to the live receiver.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-pages20-50-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 try {
  const context=await browser.newContext(),page=await context.newPage(),errors=[],controls=[],projectWrites=[];
  let failProjectWrites=false;
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>{
   const r=route.request(),u=new URL(r.url());
   if(r.method()==='GET'&&u.origin==='https://localhost:8080'&&(u.pathname==='/unirf-app.html'||u.pathname==='/DATYlogo.png'||/^\/src\/.*\.(css|js)$/.test(u.pathname)))return route.fulfill({path:path.join(root,u.pathname)});
   if(u.pathname==='/api/command')controls.push(r.postData());
   if(r.method()==='POST'&&u.pathname==='/api/projects'){
    projectWrites.push(JSON.parse(r.postData()));
    if(failProjectWrites)return route.fulfill({status:503,json:{success:false,error:'isolated save failure'}});
   }
   return route.fulfill({json:{success:true,status:'ok',devices:[],events:[],projects:[],project:{id:'default'},ip:'127.0.0.1'}});
  });
  await context.addInitScript(()=>{window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};window.WebSocket=class extends EventTarget{close(){}send(){throw Error('Real socket forbidden');}};});
  await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
  await page.evaluate(()=>{
   window.notify=()=>{};window.editTargets=[];window.originalEditDevice=window.editDevice;window.editDevice=id=>editTargets.push(id);
   window.fixture=n=>{
    DEVICES.splice(0,DEVICES.length,...Array.from({length:n},(_,i)=>({id:i+1,_fasheId:`receiver-${i%2}_ch${Math.floor(i/2)+1}`,
     receiver_mac:`02:00:00:00:00:0${i%2+1}`,receiver_ip:`192.169.0.${102+i%2}`,ip:`192.169.0.${102+i%2}`,channel_number:Math.floor(i/2)+1,
     ch:`CH${Math.floor(i/2)+1}`,group:9,group_number:i%2?10:2,group_source:'server-fifo-v1',brand:i%3===0?'AMSaudio':'DATYaudio',model:'DATY-X1',name:`频道 ${i} <>&" `+'完整名称'.repeat(i===0?40:1),
     freq:641000+i*25,rf:-50,af_dbfs:-10,batt:90,muted:i%5===0,_online:true,status:'online'})).reverse());
    const notes=['鼓手','主唱','吉他手 / '+ '完整使用分类'.repeat(12)];
    const locks=DEVICES.filter(d=>d.id<=3).sort((a,b)=>a.id-b.id).map(d=>`${d._fasheId}=${DatyFrequency.formatFrequencyMHz(d.freq)} ${notes[d.id-1]}`).join('\n');
    deviceTableView.page=1;channelCardsView.page=1;
    DatyPlanningConstraints.restoreSnapshot({constraintFields:{plannerLockedAssignments:locks}});
    renderDevTable();filterDevicesChannels();
   };
  });
  async function check(panel,count){
   const result=await page.evaluate(panel=>{
    const content=document.querySelector('.content');
    const selectors=panel==='devices'?['html','body','.main','.content','#panel-devices','#devOnline','#deviceTableViewport']:['html','body','.main','.content','#panel-channels','#channelCardsViewport','#deviceGridChannels'];
    const overflow=selectors.map(s=>{const e=document.querySelector(s);return {s,client:[e.clientWidth,e.clientHeight],scroll:[e.scrollWidth,e.scrollHeight]};}).filter(e=>e.scroll[0]>e.client[0]+1||e.scroll[1]>e.client[1]+1);
    const items=[...document.querySelectorAll(panel==='devices'?'#devTableBody tr[data-device-key]':'#deviceGridChannels .device-card')];
    const clipped=items.flatMap(item=>[...item.querySelectorAll(panel==='devices'?'.btn':'.dc-head,.dc-freq,.meter-row,.dc-footer,.dc-actions .btn')].filter(e=>{
     const a=item.getBoundingClientRect(),b=e.getBoundingClientRect();return b.width&&b.height&&(b.bottom>a.bottom+1||b.top<a.top-1||b.right>a.right+1||b.left<a.left-1);
    }).map(e=>e.className));
    if(panel==='devices') for(const row of items) {
     for(const cell of row.querySelectorAll('.device-group-cell,td:nth-child(2),td:nth-child(5),td:nth-child(7),td:nth-child(8)')) {
      if(cell.scrollWidth>cell.clientWidth+1)clipped.push('table-cell: '+cell.textContent);
     }
    }
    const groups=panel==='devices'?items.map(row=>{
     const d=DEVICES.find(d=>getChannelCardKey(d)===row.dataset.deviceKey);
     return {actual:row.children[0].textContent,expected:`GROUP${d.group_number}`,channel:row.children[1].textContent,expectedChannel:d.ch,
      ip:row.children[4].textContent,expectedIp:d.receiver_ip,status:row.children[7].textContent,statusColor:getComputedStyle(row.children[7]).color};
    }):[];
    const titleStyles=panel==='channels'?items.map(item=>{
     const title=getComputedStyle(item.querySelector('.dc-name')),group=getComputedStyle(item.querySelector('.dc-ch'));
     return {size:title.fontSize,groupSize:group.fontSize,color:title.color,cardColor:getComputedStyle(item).color,weight:title.fontWeight,family:title.fontFamily,groupFamily:group.fontFamily};
    }):[];
    return {overflow,clipped,count:items.length,rowHeight:items[0]?.getBoundingClientRect().height,overflowY:getComputedStyle(content).overflowY,titleStyles,groups};
   },panel);
   console.log(JSON.stringify({size:page.viewportSize(),panel,...result,titleStyles:result.titleStyles.slice(0,1),groups:result.groups.slice(0,2)}));
   assert.deepEqual(result.overflow,[]);assert.deepEqual(result.clipped,[]);assert.equal(result.count,count);assert.equal(result.overflowY,'hidden');
   for(const g of result.groups){assert.equal(g.actual,g.expected);assert.equal(g.channel,g.expectedChannel);assert.equal(g.ip,g.expectedIp);assert.equal(g.status,'在线');assert.equal(g.statusColor,'rgb(110, 231, 183)');}
   for(const style of result.titleStyles){
    assert.equal(style.size,style.groupSize,'Brand/model font size must match the group line at every viewport.');
    assert.equal(style.color,style.cardColor,'Keep the original title color, not the muted group color.');
    assert.equal(style.weight,'600','Do not change existing title weight.');assert.equal(style.family,style.groupFamily);
   }
  }
  for(const [width,height]of[[1920,1080],[1366,768],[1280,720],[1024,768],[1024,600]]){
   await page.setViewportSize({width,height});
   for(const [panel,size,prefix]of[['devices',20,'deviceTable'],['channels',50,'channelCards']]){
    await page.evaluate(panel=>{fixture(205);switchPanel(panel);},panel);
   const before=await page.evaluate(()=>JSON.stringify(DEVICES));await check(panel,size);
    await page.screenshot({path:path.join(output,`${width}x${height}-${panel}.png`)});
    const keys=[];for(let p=0;p<Math.ceil(205/size);p++){
     keys.push(...await page.locator(panel==='devices'?'#devTableBody tr[data-device-key]':'#deviceGridChannels .device-card').evaluateAll(items=>items.map(e=>e.dataset.deviceKey)));
     if(p+1<Math.ceil(205/size))await page.click('#'+prefix+'NextPage');
    }
    assert.equal(new Set(keys).size,205);assert.equal(await page.evaluate(()=>JSON.stringify(DEVICES)),before);
    await page.evaluate(()=>{DEVICES.splice(1);renderDevTable();filterDevicesChannels();});await check(panel,1);
   assert.match(await page.locator('#'+prefix+'PageInfo').textContent(),/第 1\/1 页/);
    await page.evaluate(()=>fixture(0));await check(panel,0);
   }
  }
  await page.evaluate(()=>{fixture(101);switchPanel('devices');});await page.click('#deviceTableNextPage');
  const expected=await page.evaluate(()=>deviceViewPage(sortDeviceView(DEVICES,'ch',true),20,2).devices[0].id);
  await page.locator('#devTableBody [data-action="editDevice"]').first().click();assert.equal(await page.evaluate(()=>editTargets.at(-1)),expected);
  const originalName=await page.evaluate(id=>DEVICES.find(d=>d.id===id).name,expected);
  await page.locator('#devTableBody .device-usage-cell').first().dblclick();
  assert.equal(await page.locator('.edit-name-input').count(),0,'usage is read-only, not a device-name editor');
  await page.evaluate(id=>{window.groupRowBefore=document.querySelector('#devTableBody tr');const d=DEVICES.find(d=>d.id===id);d.freq+=25;renderDevTable();},expected);
  assert.equal(await page.evaluate(()=>groupRowBefore===document.querySelector('#devTableBody tr')),true,'telemetry preserves the existing row');
  await page.evaluate(id=>{DEVICES.find(d=>d.id===id).group_number=64;renderDevTable();},expected);
  assert.equal(await page.locator(`.device-usage-cell[data-id="${expected}"]`).count(),0,'regrouped channel moves out of this page');
  await page.click('#deviceTableLastPage');
  assert.equal(await page.locator('.device-group-cell').last().textContent(),'GROUP64');
  assert.equal(await page.locator('#devTableBody .device-usage-cell').last().getAttribute('data-id'),String(expected));
  assert.equal(await page.evaluate(id=>DEVICES.find(d=>d.id===id).name,expected),originalName);
  await page.evaluate(()=>switchPanel('channels'));await page.click('#channelCardsNextPage');
  await page.evaluate(()=>forceRefreshAllPanels({realtime:true}));assert.match(await page.locator('#channelCardsPageInfo').textContent(),/第 2\/3 页/);
  await page.selectOption('#filterBrandChannels','AMSaudio');assert.match(await page.locator('#channelCardsPageInfo').textContent(),/第 1\/1 页/);
  await page.selectOption('#sortChannels','freq');assert.equal(await page.locator('#filterBrandChannels').inputValue(),'AMSaudio');
  await page.evaluate(()=>switchPanel('devices'));await page.getByText('协议状态',{exact:true}).click();
  assert.equal(await page.locator('.content').evaluate(e=>e.classList.contains('device-table-view')||e.classList.contains('channel-cards-view')),false);
  await page.locator('#tabOnlineCount').click();
  await page.evaluate(()=>{fixture(21);goDeviceTablePage(2);deviceViewPage(sortDeviceView(DEVICES,'ch',true),20,2).devices[0].id='receiver " quoted-id';renderDevTable();});
  await page.locator('#devTableBody [data-action="editDevice"]').first().click();
  assert.equal(await page.evaluate(()=>editTargets.at(-1)),'receiver " quoted-id');
  await page.evaluate(()=>{
   fixture(4);switchPanel('devices');
   const byId=DEVICES.slice().sort((a,b)=>a.id-b.id);
   byId[0].group_number='2';byId[1].group_number=null;byId[2].group_number=true;
   delete byId[3].group_source;byId[3].group_number=1;getReceiverGroupNumber(byId[3]);renderDevTable();
  });
  const untrusted=await page.locator('#devTableBody tr').evaluateAll(rows=>rows.map(row=>({id:row.querySelector('.device-usage-cell').dataset.id,group:row.children[0].textContent})));
  assert.deepEqual(untrusted.sort((a,b)=>Number(a.id)-Number(b.id)),[{id:'1',group:'GROUP2'},{id:'2',group:'—'},{id:'3',group:'—'},{id:'4',group:'—'}]);
  assert.deepEqual(await page.locator('#deviceTable th').allTextContents(),['编组','通道','使用分类','品牌/型号','IP地址','协议','频率','连接状态','操作']);
  // Same CH on two receivers must show independent lock notes; edits/removal/history
  // refresh this table immediately, without a telemetry tick or a device-name write.
  await page.evaluate(()=>{fixture(4);switchPanel('devices');});
  const usages=()=>page.locator('#devTableBody .device-usage-cell').evaluateAll(cells=>Object.fromEntries(cells.map(cell=>[cell.dataset.id,cell.textContent])));
  const deviceNames=await page.evaluate(()=>DEVICES.map(d=>[d.id,d.name]));
  assert.equal((await usages())['1'],'鼓手');assert.equal((await usages())['2'],'主唱');assert.equal((await usages())['4'],'—');
  const editNote=value=>page.evaluate(value=>{
   const select=document.getElementById('plannerLockChannel');select.value='lock:0';select.dispatchEvent(new Event('change'));
   const input=document.getElementById('plannerLockNote');input.value=value;input.dispatchEvent(new Event('input'));document.getElementById('plannerConfirmLock').click();
  },value);
  await editNote('鼓手 / 返听');assert.equal((await usages())['1'],'鼓手 / 返听');assert.equal((await usages())['2'],'主唱');
  const lockedBefore=await page.evaluate(()=>DatyPlanningConstraints.readConstraintFields().lockedAssignments.find(l=>l.deviceId===1).frequencyKHz);
  await page.evaluate(()=>{DEVICES.find(d=>d.id===1).freq+=5000;renderDevTable();});
  assert.equal((await usages())['1'],'鼓手 / 返听');
  assert.equal(await page.evaluate(()=>DatyPlanningConstraints.readConstraintFields().lockedAssignments.find(l=>l.deviceId===1).frequencyKHz),lockedBefore);
  await editNote('<img src=x onerror=alert(1)> & 鼓手');
  assert.equal((await usages())['1'],'<img src=x onerror=alert(1)> & 鼓手');
  assert.equal(await page.locator('#devTableBody .device-usage-cell img').count(),0);
  assert.equal(await page.locator('.device-usage-cell[data-id="1"]').getAttribute('title'),'<img src=x onerror=alert(1)> & 鼓手');
  await editNote('');assert.equal((await usages())['1'],'—');
  await editNote('手动指定频率');assert.equal((await usages())['1'],'—');
  await editNote('鼓手');
  await page.evaluate(()=>document.getElementById('plannerRemoveLock').click());
  assert.equal((await usages())['1'],'—');assert.equal((await usages())['2'],'主唱');
  const restoreRaw=raw=>page.evaluate(raw=>DatyPlanningConstraints.restoreSnapshot({constraintFields:{plannerLockedAssignments:raw}}),raw);
  await restoreRaw('receiver-0_ch1=641.000 鼓手\nreceiver-0_ch1=642.000 错误重复\nreceiver-1_ch1=643.000 主唱');
  assert.equal((await usages())['1'],'—');assert.equal((await usages())['2'],'主唱');
  await restoreRaw('CH1=641.000 不能猜接收机');assert.equal((await usages())['1'],'—');assert.equal((await usages())['2'],'—');
  await restoreRaw('receiver-0_ch1=641.000 鼓手\nreceiver-1_ch1=643.000 主唱');
  await page.evaluate(()=>{
   const record={devices:DEVICES.map(d=>({...d})),constraints:DatyPlanningConstraints.readConstraintFields()};
   for(const d of DEVICES)d.id+=100;
   DatyPlanningConstraints.restoreSnapshot(record);
  });
  assert.equal((await usages())['101'],'鼓手');assert.equal((await usages())['102'],'主唱');
  assert.deepEqual(await page.evaluate(()=>DEVICES.map(d=>[d.id-100,d.name])),deviceNames);
  await restoreRaw('');assert.ok(Object.values(await usages()).every(value=>value==='—'));
  // Open the production editor via its actual table button, not the earlier routing stub.
  await page.evaluate(()=>{window.editDevice=window.originalEditDevice;fixture(4);switchPanel('devices');});
  const openDrummer=()=>page.locator('#devTableBody tr').filter({hasText:'鼓手'}).getByRole('button',{name:'编辑',exact:true}).click();
  for(const [width,height] of [[1920,1080],[1366,768],[1280,720],[1024,768],[1024,600]]) {
   await page.setViewportSize({width,height});await openDrummer();
   assert.equal(await page.locator('#addDeviceModal label').first().textContent(),'使用分类');
   assert.equal(await page.locator('#addDev_name').inputValue(),'鼓手');
   const bounds=await page.locator('#addDeviceModal > div').boundingBox();
   assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=width&&bounds.y+bounds.height<=height,'editor stays in viewport');
   await page.screenshot({path:path.join(output,`${width}x${height}-usage-editor.png`)});
   await page.locator('#addDev_name').fill('取消的备注');await page.locator('#addDeviceModal').getByRole('button',{name:'取消',exact:true}).click();
   assert.equal((await usages())['1'],'鼓手');
  }
  assert.equal(projectWrites.length,0,'cancel does not save');
  await openDrummer();await page.locator('#addDev_name').fill('鼓手 / 返听');
  await page.evaluate(()=>{const d=DEVICES.find(d=>d.id===1);d.freq+=5000;d.batt=45;});
  const beforeEdit=await page.evaluate(()=>JSON.stringify(DEVICES.map(({planned,...d})=>d)));
  await page.click('#addDev_save');await page.locator('#addDeviceModal').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>JSON.stringify(DEVICES.map(({planned,...d})=>d))),beforeEdit,'usage-only save preserves telemetry/device fields while invalidating the old plan');
  assert.equal((await usages())['1'],'鼓手 / 返听');assert.equal((await usages())['2'],'主唱');
  assert.equal(projectWrites.length,1);assert.equal(projectWrites[0].data.constraints.lockedAssignments.find(l=>l.deviceId===1).reason,'鼓手 / 返听');
  assert.equal(projectWrites[0].data.constraints.lockedAssignments.find(l=>l.deviceId===1).frequencyKHz,641000);
  await page.evaluate(()=>DatyPlanningConstraints.restoreSnapshot(getCurrentPlanningRecord()));
  await openDrummer();assert.equal(await page.locator('#addDev_name').inputValue(),'鼓手 / 返听');
  await page.locator('#addDev_name').fill('鼓手新分类');failProjectWrites=true;await page.click('#addDev_save');
  await page.waitForFunction(()=>document.getElementById('plannerConstraintSaveStatus').textContent.includes('服务器未同步'));
  assert.equal(await page.locator('#addDeviceModal').count(),1);assert.equal(await page.locator('#addDev_save').isEnabled(),true);
  failProjectWrites=false;await page.click('#addDev_save');await page.locator('#addDeviceModal').waitFor({state:'detached'});
  assert.equal(projectWrites.at(-1).data.constraints.lockedAssignments.find(l=>l.deviceId===1).reason,'鼓手新分类');
  await page.evaluate(()=>editDevice(2));await page.fill('#addDev_name','主唱 / 新分类');await page.fill('#addDev_ch','CH99');
  const beforeCombined=await page.evaluate(()=>JSON.stringify(DEVICES));await page.click('#addDev_save');
  assert.equal(await page.locator('#addDeviceModal').count(),1);assert.equal((await usages())['2'],'主唱');
  assert.equal(await page.evaluate(()=>JSON.stringify(DEVICES)),beforeCombined,'reject simultaneous lock-note and channel identity changes before mutation');
  await page.fill('#addDev_ch','CH1');await page.fill('#addDev_model','DATY-X2');await page.click('#addDev_save');
  await page.locator('#addDeviceModal').waitFor({state:'detached'});
  assert.equal((await usages())['2'],'主唱 / 新分类');assert.equal(await page.evaluate(()=>DEVICES.find(d=>d.id===2).model),'DATY-X2');
  // Quoted string IDs bind by closure; HTML-like notes are plain input values.
  await page.evaluate(()=>{fixture(4);DEVICES.find(d=>d.id===1).id='receiver " quoted-id';renderDevTable();});
  await openDrummer();await page.locator('#addDev_name').fill('鼓手 " <img src=x onerror=alert(1)>');
  await page.click('#addDev_save');await page.locator('#addDeviceModal').waitFor({state:'detached'});
  await openDrummer();assert.equal(await page.locator('#addDev_name').inputValue(),'鼓手 " <img src=x onerror=alert(1)>');
  assert.equal(await page.locator('#addDeviceModal img').count(),0);
  await page.locator('#addDev_name').fill('');await page.click('#addDev_save');await page.locator('#addDeviceModal').waitFor({state:'detached'});
  assert.equal((await usages())['receiver " quoted-id'],'—');
  assert.equal(await page.evaluate(()=>DatyPlanningConstraints.readConstraintFields().lockedAssignments.length),3,'clearing usage retains frequency lock');
  await page.evaluate(()=>editDevice(4));assert.equal(await page.locator('#addDev_name').isDisabled(),true);
  assert.match(await page.locator('#addDev_name').getAttribute('placeholder'),/请先在频率规划/);await page.click('#addDev_save');
  await page.locator('#addDeviceModal').waitFor({state:'detached'});
  // Existing manual-device registration still takes a device name.
  await page.evaluate(()=>showAddDeviceModal());assert.equal(await page.locator('#addDeviceModal label').first().textContent(),'设备名称');
  await page.fill('#addDev_name','人工登记');await page.fill('#addDev_ch','CH99');await page.fill('#addDev_freq','645.000');await page.click('#addDev_save');
  await page.locator('#addDeviceModal').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>DEVICES.find(d=>d.name==='人工登记')._online),false);
  assert.deepEqual(errors,[]);assert.deepEqual(controls,[]);console.log('PASS: 20-row table + 50 channel cards, all records, page stability, filters, edit identity. Screenshots: '+output);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
