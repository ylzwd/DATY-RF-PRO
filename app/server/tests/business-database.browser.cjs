'use strict';
// Original page + exact reviewed patches + real file chooser. All HTTP mocked,
// no real origin profile, certificate, service, receiver or command is touched.
const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require('playwright');
const {fixture}=require('./business-db-fixture.cjs');
const candidate=require('../scripts/unified-candidate.cjs').prepare();
const origin='https://127.0.0.1:8080',scopes=['device.control','project.write','timeline.write','discovery.scan'];
async function pageFixture(browser,legacy=null,seed=null){
  const h=fixture(),errors=[],violations=[],served=new Set();
  h.put('settings','alert_thresholds',{rfWeakDbm:-70,batteryLowPercent:15,afOverloadDbfs:-2});
  h.put('settings','alert_sound',{enabled:false});h.put('settings','auto_frequency',{enabled:false});
  h.put('preferences','view:local-development',{specStartFreq:'640.000',specEndFreq:'690.000'});
  if(seed)seed(h);
  const context=await browser.newContext({viewport:{width:1366,height:768},serviceWorkers:'block'}),page=await context.newPage();
  page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    try{
      if(url.origin===origin&&request.method()==='GET'&&candidate.files.has(url.pathname.slice(1))){
        const name=url.pathname.slice(1);served.add(name);return await route.fulfill({body:candidate.files.get(name),contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'}[path.extname(name)]||'application/octet-stream'});
      }
      if(url.pathname==='/api/auth/status')return await route.fulfill({json:{success:true,auth:{protocol:'daty-access-v1',configured:true,authenticated:true,mode:'local-development',principal:{id:'local-development',name:'fixture local',role:'operator'},permissions:scopes}}});
      if(url.pathname.startsWith('/api/database/')){
        assert.equal(url.origin,'https://127.0.0.1:8802');assert.equal(request.headers()['x-daty-local-development'],'1');
        if(h.state.databaseUnavailable&&(h.state.databaseUnavailable==='all'||request.method()==='POST'))return await route.fulfill({status:503,json:{success:false,protocol:'daty-business-db-v1',code:'DATABASE_UNAVAILABLE'}});
        const response=await h.handle(request.url(),{method:request.method(),body:request.postData()});return await route.fulfill({status:response.status,json:await response.json()});
      }
      if(request.method()!=='GET'&&request.method()!=='HEAD'&&request.method()!=='OPTIONS')throw Error('Unexpected mutation: '+url.pathname);
      if(url.pathname.startsWith('/api/projects/'))return await route.fulfill({status:404,json:{success:false,revision_protocol:'daty-project-revision-v1'}});
      return await route.fulfill({json:{success:true,status:'ok',devices:[],projects:[],events:[],ip:'127.0.0.1'}});
    }catch(error){if(error.message==='fixture commit reply lost')return h.state.dropReplyBody?route.fulfill({body:'{',contentType:'application/json'}):route.abort('failed');violations.push(error.message);return route.abort('blockedbyclient');}
  });
  if(context.routeWebSocket)await context.routeWebSocket('**/*',socket=>socket.close());
  await context.addInitScript(values=>{
    window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};window.WebSocket=class extends EventTarget{close(){}send(){throw Error('No real sockets');}};
    if(values)for(const [key,value]of Object.entries(values))localStorage.setItem(key,JSON.stringify(value));
  },legacy);
  await page.goto(origin+'/unirf-app.html',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.DatyBusinessDatabase&&DatyAccess.snapshot().authenticated);
  await page.evaluate(async()=>{await DatyBusinessDatabase.hydrate();window.businessNotices=[];const original=notify;window.notify=(...args)=>{businessNotices.push(args);return original(...args);};deviceServiceManager.stopDiscovery();});
  return {...h,page,context,errors,violations,served};
}
const posts=h=>h.requests.filter(item=>item.options.method==='POST');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.EDGE_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  try{
    const h=await pageFixture(browser),p=h.page;
    assert.equal(posts(h).length,0,'Startup must not import or save');
    assert.equal(await p.evaluate(()=>getAlertThresholdSettings().rfWeakDbm),-70);
    assert.equal(await p.inputValue('#specStart'),'640.000');assert.equal(await p.isChecked('#soundAlertEnabled'),false);
    await p.evaluate(()=>{switchPanel('settings');document.getElementById('rfThreshInput').value='-65';document.getElementById('rfThreshInput').dispatchEvent(new Event('input',{bubbles:true}));});
    await p.click('[onclick="saveSettings()"]');await p.waitForFunction(()=>businessNotices.some(row=>row[1]==='设置已保存'));
    assert.equal(h.resources.get('["settings","alert_thresholds"]').value.rfWeakDbm,-65);
    assert.equal(await p.evaluate(()=>getAlertThresholdSettings().rfWeakDbm),-65);
    h.state.rejectNext='RESOURCE_REVISION_CONFLICT';await p.evaluate(()=>{businessNotices.length=0;document.getElementById('rfThreshInput').value='-60';});
    await p.click('[onclick="saveSettings()"]');await p.waitForFunction(()=>businessNotices.some(row=>row[1]==='阈值设置未保存到数据库'));
    assert.equal(await p.evaluate(()=>getAlertThresholdSettings().rfWeakDbm),-65);assert.equal(await p.evaluate(()=>businessNotices.some(row=>row[1]==='设置已保存')),false);
    await p.locator('#soundAlertEnabled').locator('..').click();await p.waitForFunction(()=>document.getElementById('soundAlertStatus').textContent.includes('已保存到服务器'));
    assert.equal(h.resources.get('["settings","alert_sound"]').value.enabled,true);
    await p.locator('#autoFrequencyEnabled').locator('..').click();await p.waitForFunction(()=>document.getElementById('autoFrequencyStatus').textContent.includes('已保存到服务器'));
    assert.equal(h.resources.get('["settings","auto_frequency"]').value.enabled,true);

    await p.evaluate(()=>{
      DEVICES.splice(0,DEVICES.length,{id:77,_fasheId:'fixture-receiver_ch3',receiver_id:'fixture-receiver',channel:3,channel_number:3,ch:'CH3',
        brand:'DATYaudio',model:'fixture',name:'Reported receiver name',freq:641500,rf:-60,afDbfs:-12,batt:90,muted:false,_online:true,status:'online',_source:'mqtt'});
      switchPanel('devices');renderDevTable();
    });
    const deviceBefore=await p.evaluate(()=>JSON.stringify(DEVICES));assert.equal(await p.evaluate(()=>saveDeviceName(77,'演唱者')),true);
    assert.equal(await p.evaluate(()=>JSON.stringify(DEVICES)),deviceBefore,'Aliases cannot rewrite receiver telemetry or identity');
    assert.match(await p.locator('#devTableBody').textContent(),/演唱者/);
    await p.evaluate(()=>{DEVICES[0].name='new reported name';renderDevTable();});assert.match(await p.locator('#devTableBody').textContent(),/演唱者/);
    await p.locator('#devTableBody .dev-name-cell').dblclick();await p.locator('.edit-name-input').fill('尚未确认的新别名');
    await p.evaluate(()=>{DEVICES[0].freq+=250;renderDevTable();});assert.equal(await p.locator('.edit-name-input').inputValue(),'尚未确认的新别名');
    const reportedBefore=await p.evaluate(()=>JSON.stringify(DEVICES));h.state.rejectNext='RESOURCE_REVISION_CONFLICT';await p.keyboard.press('Enter');
    await p.waitForFunction(()=>businessNotices.some(row=>row[1]==='名称未保存到数据库'));
    assert.equal(await p.locator('.edit-name-input').inputValue(),'尚未确认的新别名');assert.equal(await p.evaluate(()=>JSON.stringify(DEVICES)),reportedBefore);
    await p.evaluate(()=>DatyBusinessDatabase.repository.load('device_overrides',JSON.stringify(['fixture-receiver',3])));
    await p.locator('.edit-name-input').focus();await p.keyboard.press('Enter');await p.waitForFunction(()=>!document.querySelector('.edit-name-input'));
    assert.match(await p.locator('#devTableBody').textContent(),/尚未确认的新别名/);assert.equal(await p.evaluate(()=>JSON.stringify(DEVICES)),reportedBefore);

    await p.evaluate(()=>showAddDeviceModal());await p.fill('#addDev_name','人工登记');await p.selectOption('#addDev_brand','DATYaudio');await p.fill('#addDev_model','手工型号');
    await p.fill('#addDev_ch','CH9');await p.fill('#addDev_ip','192.0.2.111');await p.fill('#addDev_freq','642.000');
    await p.locator('#addDeviceModal').getByRole('button',{name:'添加设备',exact:true}).click();await p.waitForFunction(()=>!document.getElementById('addDeviceModal'));
    const manual=await p.evaluate(()=>DEVICES.find(d=>d._source==='manual'));assert.equal(manual.name,'人工登记');assert.equal(manual._online,false);assert.equal(manual.rf,null);assert.equal(manual.afDbfs,null);assert.equal(manual.batt,null);assert.equal(manual.receiver_id,undefined);
    const manualKey=JSON.stringify(['manual_devices',JSON.stringify(['number',manual.id])]);assert.equal(h.resources.get(manualKey).value.configuredChannelNumber,9);assert.equal(h.resources.get(manualKey).value.configuredIp,'192.0.2.111');
    h.state.rejectNext='RESOURCE_REVISION_CONFLICT';assert.equal(await p.evaluate(id=>saveDeviceName(id,'冲突名称'),manual.id),false);assert.equal(await p.evaluate(id=>DEVICES.find(d=>d.id===id).name,manual.id),'人工登记');
    await p.evaluate(id=>DatyBusinessDatabase.repository.load('manual_devices',JSON.stringify(['number',id])),manual.id);
    assert.equal(await p.evaluate(id=>saveDeviceName(id,'人工新名称'),manual.id),true);assert.equal(h.resources.get(manualKey).value.name,'人工新名称');
    const beforeRealtimeEdit=posts(h).length;await p.evaluate(()=>showAddDeviceModal(DEVICES.find(d=>d.id===77)));await p.fill('#addDev_name','不能改遥测');
    await p.locator('#addDeviceModal').getByRole('button',{name:'保存修改',exact:true}).click();assert.equal(posts(h).length,beforeRealtimeEdit);assert.equal(await p.evaluate(()=>DEVICES.find(d=>d.id===77).name),'new reported name');
    await p.locator('#addDeviceModal').getByRole('button',{name:'取消',exact:true}).click();
    await p.evaluate(id=>{void deleteDev(id);},manual.id);await p.locator('dialog[open]').getByRole('button',{name:'确认删除',exact:true}).click();
    await p.waitForFunction(id=>!DEVICES.some(d=>d.id===id),manual.id);assert.equal(h.resources.get(manualKey).deleted,true);

    await p.evaluate(()=>{switchPanel('spectrum');DatyRfSimulationView.openSettings();});const originalSimulation=await p.evaluate(()=>DatyRfSimulationView.getOptions().peakWidthKHz);
    await p.fill('#simPeakWidth','333');h.state.rejectNext='RESOURCE_REVISION_CONFLICT';await p.click('#applyRfSimulationSettings');
    await p.waitForFunction(()=>businessNotices.some(row=>row[1]==='仿真设置未保存到数据库'));assert.equal(await p.evaluate(()=>DatyRfSimulationView.getOptions().peakWidthKHz),originalSimulation);assert.equal(await p.locator('#rfSimulationSettings').count(),1);
    await p.evaluate(()=>DatyBusinessDatabase.repository.load('simulation_settings','default'));await p.click('#applyRfSimulationSettings');await p.waitForFunction(()=>!document.getElementById('rfSimulationSettings'));
    assert.equal(h.resources.get('["simulation_settings","default"]').value.options.peakWidthKHz,333);assert.equal(await p.evaluate(()=>DatyRfSimulationView.getOptions().peakWidthKHz),333);
    assert.equal(await p.evaluate(()=>getCurrentScanPoints().length),0,'Simulation does not become a real scan');
    await p.evaluate(()=>{DEVICES.push(...Array.from({length:60},(_,i)=>({id:1000+i,_fasheId:'paging_'+i,receiver_id:'paging',channel_number:i+1,ch:'CH'+(i+1),brand:'DATYaudio',freq:641000+i*250,_online:true,status:'online'})));switchPanel('channels');});
    await p.click('#channelCardsNextPage');await p.waitForFunction(()=>DatyBusinessDatabase.repository.cached('preferences','view:local-development')?.value.channelPage===2);
    assert.equal(h.resources.get('["preferences","view:local-development"]').value.channelPage,2);assert.equal(h.resources.get('["preferences","view:local-development"]').value.specStartFreq,'640.000');
    const paginationPosts=posts(h).length;await p.evaluate(()=>forceRefreshAllPanels({realtime:true}));assert.equal(posts(h).length,paginationPosts,'Telemetry repaint cannot save page preferences');

    await p.evaluate(()=>switchPanel('spectrum'));const scan='Frequency (MHz),Level (dBm)\n642.000,-90\n642.250,-80';
    let chooserPromise=p.waitForEvent('filechooser');await p.click('button[onclick="importScan(\'扫描 CSV\')"]');let chooser=await chooserPromise;
    await chooser.setFiles({name:'db-real.csv',mimeType:'text/csv',buffer:Buffer.from(scan)});
    await p.waitForFunction(()=>businessNotices.some(row=>row[1]==='真实扫描已导入')).catch(async error=>{console.error('Isolated scan diagnostic',await p.evaluate(()=>({notices:businessNotices,scan:DatyBusinessDatabase.client.snapshot('scans','current:default'),takeovers:DatyBusinessDatabase.takeoverState()})));throw error;});
    const currentScan=h.resources.get('["scan_current","default"]').value.scanId,savedScan=h.resources.get(JSON.stringify(['scans',currentScan]));assert.equal(savedScan.value.original.text,scan);assert.equal(savedScan.value.points[0].frequencyKHz,642000);
    assert.equal(await p.evaluate(()=>getCurrentScanPoints()[0].frequencyKHz),642000);
    assert.equal(await p.evaluate(()=>DatyBusinessDatabase.appliedSources().scan.id),currentScan);assert.equal(await p.evaluate(()=>DatyBusinessDatabase.appliedSources().scope.projectId),'default');
    await p.evaluate(()=>switchPanel('planner'));const profile=await p.evaluate(()=>{const value=JSON.parse(JSON.stringify(DatyEquipmentProfiles.resolveEquipmentProfile({brand:'DATYaudio'})));value.id='database-profile-browser-fixture';return value;});
    chooserPromise=p.waitForEvent('filechooser');await p.click('button[onclick="importEquipmentProfile()"]');chooser=await chooserPromise;
    await chooser.setFiles({name:'db-profile.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify([profile]))});
    await p.waitForFunction(()=>businessNotices.some(row=>row[1]==='Profile 已导入'));
    assert.equal(h.resources.get('["profiles","database-profile-browser-fixture"]').value.id,profile.id);
    assert(posts(h).some(item=>item.url.endsWith('/api/database/batch')));
    const thresholdReads=h.requests.filter(item=>item.url.endsWith('/settings/alert_thresholds')).length;
    await p.evaluate(()=>DatyBusinessDatabase.hydrate());
    assert.equal(await p.inputValue('#rfThreshInput'),'-60','Unsubmitted edits survive later hydration');
    assert.equal(h.requests.filter(item=>item.url.endsWith('/settings/alert_thresholds')).length,thresholdReads,'Dirty fields must not silently acquire a newer write baseline');
    assert.deepEqual(h.errors,[]);assert.deepEqual(h.violations,[]);assert.equal(h.served.has('src/app/business-database.js'),true);
    await h.context.close();

    const old={rfWeakDbm:-85,batteryLowPercent:20,afOverloadDbfs:-3};
    const conflict=await pageFixture(browser,{daty_alert_thresholds_v1:old,daty_alert_sound_v1:{enabled:true},daty_equipment_profiles_v2:[profile]}),q=conflict.page;
    assert.equal(await q.evaluate(()=>getAlertThresholdSettings().rfWeakDbm),-85);assert.equal(await q.evaluate(()=>JSON.parse(localStorage.getItem('daty_alert_thresholds_v1')).rfWeakDbm),-85);
    assert.equal(await q.evaluate(()=>DatyBusinessDatabase.takeoverState().thresholds.status),'migration-conflict');assert.equal(posts(conflict).length,0);
    assert.equal(await q.isChecked('#soundAlertEnabled'),true);assert.equal(await q.evaluate(()=>DatyBusinessDatabase.takeoverState().profiles.status),'migration-conflict');
    assert.equal(await q.evaluate(()=>JSON.parse(localStorage.getItem('daty_equipment_profiles_v2'))[0].id),profile.id);
    await q.evaluate(()=>switchPanel('settings'));await q.click('[onclick="saveSettings()"]');
    const dialog=q.locator('dialog[open]');await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(posts(conflict).length,0);
    await q.click('[onclick="saveSettings()"]');await q.locator('dialog[open]').getByRole('button',{name:'确认本次保存',exact:true}).click();
    await q.waitForFunction(()=>businessNotices.some(row=>row[1]==='设置已保存'));assert.equal(conflict.resources.get('["settings","alert_thresholds"]').value.rfWeakDbm,-85);
    assert.deepEqual(conflict.errors,[]);assert.deepEqual(conflict.violations,[]);await conflict.context.close();
    const unavailable=await pageFixture(browser),u=unavailable.page;await u.evaluate(()=>{
      DEVICES.push({id:1,_fasheId:'offline-api_ch1',receiver_id:'offline-api',channel_number:1,ch:'CH1',name:'真实上报名称',brand:'DATYaudio',freq:641000,_online:true,status:'online'});switchPanel('devices');
    });await u.locator('#devTableBody .dev-name-cell').dblclick();await u.locator('.edit-name-input').fill('数据库不可用草稿');unavailable.state.databaseUnavailable='all';await u.keyboard.press('Enter');
    await u.waitForFunction(()=>businessNotices.some(row=>row[1]==='名称未保存到数据库'));assert.equal(await u.locator('.edit-name-input').inputValue(),'数据库不可用草稿');assert.equal(await u.evaluate(()=>DEVICES[0].name),'真实上报名称');assert.equal(posts(unavailable).length,0);
    assert.deepEqual(unavailable.errors,[]);assert.deepEqual(unavailable.violations,[]);await unavailable.context.close();
    const restored=await pageFixture(browser,null,f=>{
      f.put('simulation_settings','default',h.resources.get('["simulation_settings","default"]').value);
      f.put('preferences','view:local-development',{specStartFreq:'640.000',specEndFreq:'690.000',devicePage:2,channelPage:2});
      for(let id=1;id<=61;id++){const key=JSON.stringify(['number',id]);f.put('manual_devices',key,{id:key,source:'manual',brand:'DATYaudio',model:'登记型号',name:'登记'+id,configuredChannelNumber:id,configuredIp:'192.0.2.111',configuredFrequencyKHz:641000+id*250});}
    }),v=restored.page;
    assert.equal(posts(restored).length,0);assert.equal(await v.evaluate(()=>DEVICES.length),61);
    assert.equal(await v.evaluate(()=>DEVICES.every(d=>d.status==='offline'&&d._online===false&&d.rf===null&&d.afDbfs===null&&d.batt===null&&!d.receiver_id)),true);
    assert.equal(await v.evaluate(()=>DatyRfSimulationView.getOptions().peakWidthKHz),333);
    await v.evaluate(()=>switchPanel('devices'));assert.match(await v.locator('#deviceTablePageInfo').textContent(),/第 2\/4 页/);
    await v.evaluate(()=>switchPanel('channels'));assert.match(await v.locator('#channelCardsPageInfo').textContent(),/第 2\/2 页/);
    assert.equal(posts(restored).length,0,'Hydrating DB preferences/manual records cannot write them back');
    for(const [width,height]of [[1920,1080],[1366,768],[1280,720],[1024,768],[1024,600]]){
      await v.setViewportSize({width,height});
      for(const [panel,selector,count]of [['devices','#devTableBody tr[data-device-key]',20],['channels','#deviceGridChannels .device-card',50]]){
        await v.evaluate(name=>{DatyApplyDevicePagePreferences({devicePage:1,channelPage:1});switchPanel(name);},panel);
        const layout=await v.evaluate(({selector,panel})=>{
          const content=document.querySelector('.content'),items=[...document.querySelectorAll(selector)];
          const overflow=['html','body','.main','.content','#panel-'+panel].filter(selector=>{const box=document.querySelector(selector);return box.scrollWidth>box.clientWidth+1||box.scrollHeight>box.clientHeight+1;});
          const clipped=items.flatMap(item=>[...item.querySelectorAll('.btn')].filter(button=>{const a=item.getBoundingClientRect(),b=button.getBoundingClientRect();return b.width&&b.height&&(b.bottom>a.bottom+1||b.top<a.top-1||b.left<a.left-1||b.right>a.right+1);}));
          return {count:items.length,overflow,clipped:clipped.length,overflowY:getComputedStyle(content).overflowY};
        },{selector,panel});assert.equal(layout.count,count);assert.deepEqual(layout.overflow,[]);assert.equal(layout.clipped,0);assert.equal(layout.overflowY,'hidden');
      }
    }
    assert.equal(posts(restored).length,0);assert.deepEqual(restored.errors,[]);assert.deepEqual(restored.violations,[]);await restored.context.close();
    const review=await pageFixture(browser),w=review.page;await w.evaluate(()=>switchPanel('settings'));await w.fill('#rfThreshInput','-68');review.state.dropReply=true;
    await w.click('[onclick="saveSettings()"]');await w.waitForFunction(()=>!DatyAccess.snapshot().authenticated);
    await w.evaluate(async()=>{await DatyAccess.resume();await DatyBusinessDatabase.hydrate();});
    assert.equal(posts(review).length,1);assert.equal(await w.evaluate(()=>getAlertThresholdSettings().rfWeakDbm),-70);assert.equal(review.resources.get('["settings","alert_thresholds"]').value.rfWeakDbm,-68);
    await w.click('[onclick="saveSettings()"]');await w.locator('dialog[open]').getByRole('button',{name:'取消',exact:true}).click();assert.equal(posts(review).length,1);
    await w.click('[onclick="saveSettings()"]');await w.locator('dialog[open]').getByRole('button',{name:'只读核对',exact:true}).click();
    await w.waitForFunction(()=>businessNotices.some(row=>row[1]==='数据库核对完成'));assert.equal(posts(review).length,1,'Same Save button only reconciles, never replays POST');assert.equal(await w.inputValue('#rfThreshInput'),'-68');assert.equal(await w.evaluate(()=>getAlertThresholdSettings().rfWeakDbm),-70);
    await w.click('[onclick="saveSettings()"]');await w.waitForFunction(()=>getAlertThresholdSettings().rfWeakDbm===-68);assert.equal(posts(review).length,2);
    const chooseProfile=async()=>{const picked=w.waitForEvent('filechooser');await w.click('button[onclick="importEquipmentProfile()"]');await (await picked).setFiles({name:'unknown-profile.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify([profile]))});};
    await w.evaluate(()=>{businessNotices.length=0;switchPanel('planner');});review.state.dropReply=true;review.state.dropReplyBody=true;await chooseProfile();await w.waitForFunction(()=>businessNotices.some(row=>row[1]==='Profile保存待核对'));
    assert.equal(posts(review).length,3);await chooseProfile();await w.locator('dialog[open]').getByRole('button',{name:'只读核对',exact:true}).click();await w.waitForFunction(()=>businessNotices.some(row=>row[1]==='数据库核对完成'));assert.equal(posts(review).length,3,'Profile batch is only queried, not resent');
    assert.equal(await w.evaluate(()=>JSON.parse(localStorage.getItem('daty_equipment_profiles_v2')||'[]').length),0,'Receipt recovery does not silently overwrite the origin cache');
    await chooseProfile();await w.waitForFunction(()=>businessNotices.some(row=>row[1]==='Profile 已导入'));assert.equal(posts(review).length,4);
    await w.evaluate(()=>{businessNotices.length=0;switchPanel('spectrum');});
    const unknownScanText='Frequency (MHz),Level (dBm)\n643.000,-95\n643.250,-80';
    const chooseScan=async()=>{const picked=w.waitForEvent('filechooser');await w.click('button[onclick="importScan(\'扫描 CSV\')"]');await (await picked).setFiles({name:'unknown-scan.csv',mimeType:'text/csv',buffer:Buffer.from(unknownScanText)});};
    review.state.dropReply=true;await chooseScan();await w.waitForFunction(()=>businessNotices.some(row=>row[1]==='真实扫描保存待核对'));assert.equal(posts(review).length,5);
    const unknownScanId=review.resources.get('["scan_current","default"]').value.scanId;
    assert.equal(await w.evaluate(()=>DatyBusinessDatabase.appliedSources().scan),null,'An unconfirmed DB scan is not an applied planning source');
    await chooseScan();await w.locator('dialog[open]').getByRole('button',{name:'只读核对',exact:true}).click();await w.waitForFunction(()=>businessNotices.some(row=>row[1]==='数据库核对完成'));assert.equal(posts(review).length,5);
    assert.equal(await w.evaluate(()=>getCurrentScanPoints().length),0);assert.equal(await w.evaluate(()=>DatyBusinessDatabase.appliedSources().scan),null,'Read-only recovery cannot claim a scan was displayed');
    await chooseScan();await w.waitForFunction(()=>businessNotices.some(row=>row[1]==='真实扫描已导入'));assert.equal(posts(review).length,6);
    const confirmedScanId=review.resources.get('["scan_current","default"]').value.scanId;assert.notEqual(unknownScanId,confirmedScanId);assert.equal(review.resources.get(JSON.stringify(['scans',unknownScanId])).value.original.text,unknownScanText);
    assert.equal(await w.evaluate(()=>DatyBusinessDatabase.appliedSources().scan.id),confirmedScanId);
    await w.evaluate(()=>clearImportedScan());assert.equal(await w.evaluate(()=>DatyBusinessDatabase.appliedSources().scan),null,'Cleared scan cannot be supplied as a planning source');
    assert.equal(review.resources.get('["scan_current","default"]').deleted,true);assert.equal(review.resources.get(JSON.stringify(['scans',confirmedScanId])).deleted,false,'Clear retains the original scan');
    assert.deepEqual(review.errors,[]);assert.deepEqual(review.violations,[]);await review.context.close();
    console.log('Candidate original-page DB: settings, aliases focus/409/503, offline manual create/name/delete, separate simulation, pagination, CSV/Profile, original Save scalar+batch receipt-only recovery and zero device control passed.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
