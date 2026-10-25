'use strict';
// Actual reviewed unified HTML/module bytes. Shared CAS server is memory only;
// every HTTP is mocked/aborted, no SQL migration, receiver, socket or deployment.
const assert=require('node:assert/strict'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {chromium}=require('playwright'),{fixture,clone}=require('./business-db-fixture.cjs');
const candidate=require('../scripts/unified-candidate.cjs').prepare(),ORIGIN='https://localhost:8080';
const KEY='daty_planning_history_v1',scopes=['device.control','project.write','timeline.write','discovery.scan'];
const record=(id,backup=1)=>({id,type:'daty_rf_planning',projectId:'default',projectName:'默认项目',name:id,timestamp:1000,
  devices:[],options:{backupCount:backup},constraints:{backupCount:backup}});
function server(){const h=fixture();h.hook=null;h.legacy=null;h.errors=[];
  h.get=(kind,id='default')=>h.resources.get(JSON.stringify([kind,id]));
  h.posts=()=>h.requests.filter(item=>item.options.method==='POST');
  h.seed=(selected=null,extra={})=>{
    h.put('project_metadata','default',{id:'default',name:'默认项目',data:{future:{retained:true}}});
    h.put('planning_current','default',{projectId:'default',currentRecordId:selected?.id||null,deletedRecordIds:[],devices:[],
      ...(selected?{constraints:selected.options}:{}),...extra});
    if(selected)h.put('planning_records',selected.id,selected);
  };return h;
}
async function harness(browser,state,{local=null,expectLoad=true}={}){
  const context=await browser.newContext({viewport:{width:1366,height:768},serviceWorkers:'block'}),page=await context.newPage(),errors=[],controls=[],served=new Set();
  page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),method=request.method();
    try{
      const name=url.pathname.slice(1);
      if(method==='GET'&&url.origin===ORIGIN&&candidate.files.has(name)){served.add(name);return await route.fulfill({body:candidate.files.get(name),contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[path.extname(name)]||'application/octet-stream'});}
      if(url.pathname==='/api/auth/status')return await route.fulfill({json:{success:true,auth:{protocol:'daty-access-v1',configured:true,authenticated:true,mode:'local-development',principal:{id:'local-development',name:'fixture local',role:'operator'},permissions:scopes}}});
      if(url.pathname.startsWith('/api/database/')){
        assert.equal(url.origin,'https://127.0.0.1:8802');assert.equal(request.headers()['x-daty-local-development'],'1');
        if(state.hook)await state.hook(url,request);
        const reply=await state.handle(request.url(),{method,body:request.postData()});return await route.fulfill({status:reply.status,json:await reply.json()});
      }
      if(url.pathname==='/api/command'){controls.push(request.postData());throw Error('Planning DB cannot send device commands');}
      if(method==='GET'&&url.pathname==='/api/projects/default')return await route.fulfill({status:state.legacy?200:404,json:state.legacy?{success:true,project:state.legacy}:{success:false}});
      if(!['GET','HEAD','OPTIONS'].includes(method))throw Error('Unexpected mutation: '+url.pathname);
      return await route.fulfill({json:{success:true,status:'ok',devices:[],events:[],projects:[],count:0,ip:'127.0.0.1'}});
    }catch(error){if(error.message==='fixture commit reply lost')return route.abort('failed');state.errors.push(error.message);return route.abort('blockedbyclient');}
  });
  if(context.routeWebSocket)await context.routeWebSocket('**/*',socket=>socket.close());
  await context.addInitScript(({local,KEY})=>{
    window.setInterval=()=>0;window.EventSource=class extends EventTarget{close(){}};window.WebSocket=class extends EventTarget{close(){}send(){throw Error('No sockets');}};
    if(local)localStorage.setItem(KEY,JSON.stringify({project:{id:'default',name:'默认项目'},currentRecordId:local.id,records:[local],deletedRecordIds:[]}));
  },{local,KEY});
  await page.goto(ORIGIN+'/unirf-app.html',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>DatyAccess.snapshot().authenticated&&window.DatyPlanningProjectStorage&&DatyPlanningProjectStorage.snapshot().started);
  if(expectLoad)await page.waitForFunction(()=>DatyPlanningProjectStorage.snapshot().loaded&&!DatyPlanningProjectStorage.snapshot().pending);
  await page.evaluate(()=>{switchPanel('planner');switchPlannerControlTab('constraints');deviceServiceManager.stopDiscovery();});
  return {context,page,errors,controls,served,snapshot:()=>page.evaluate(()=>DatyPlanningProjectStorage.snapshot()),
    history:()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'{}'),KEY),click:()=>page.click('#savePlannerConstraints'),
    done:()=>page.waitForFunction(()=>!document.getElementById('savePlannerConstraints').disabled),status:()=>page.textContent('#plannerConstraintSaveStatus')};
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.EDGE_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'}),all=[];
  try{
    const empty=server(),a=await harness(browser,empty);all.push(a);assert.equal(empty.posts().length,0);
    await a.page.fill('#plannerBackupCount','2');await a.click();await a.done();
    assert.equal((await a.snapshot()).status,'saved');assert.equal(empty.posts().length,1);
    const writes=JSON.parse(empty.posts()[0].options.body).writes;
    assert.deepEqual(writes.map(item=>item.kind),['project_metadata','planning_records','planning_current']);
    assert.equal(empty.get('planning_current').value.constraints.backupCount,2);assert.equal(empty.get('planning_records',writes[1].id).value.projectId,'default');
    const initial=empty.get('planning_current').value.currentRecordId;
    const runResult=await a.page.evaluate(async()=>{const run={assignments:[],analysis:{conflicts:[]}},r=savePlanningResult([],run,{backupCount:0});return persistPlanningProject(r,run);});
    assert.equal(runResult.status,'saved');assert.equal(runResult.runStatus,'saved');assert.equal(empty.posts().length,2);
    assert.deepEqual(JSON.parse(empty.posts()[1].options.body).writes.map(item=>item.kind),['project_metadata','planning_records','planning_current','planning_runs']);
    assert.notEqual(empty.get('planning_current').value.currentRecordId,initial);
    const python=process.env.DATY_TEST_PYTHON||path.resolve(__dirname,'../../tools/python/python.exe');
    const sql=JSON.parse(execFileSync(python,[path.join(__dirname,'validate_unified_browser_transactions.py')],
      {encoding:'utf8',input:JSON.stringify(empty.posts().map(item=>JSON.parse(item.options.body))),env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'}}));
    assert.equal(sql.status,'real-sqlite-browser-batches-passed');assert.equal(sql.batches,2);
    console.log('PASS unified original Save and run: normalized metadata/history/current/run share one exact atomic batch');

    const constraints=server();constraints.seed(null,{constraints:{backupCount:0,minChannelSpacingKHz:250},devices:[{id:'historical-receiver/CH8',_fasheId:'historical_ch8',freq:641250}]});
    const c=await harness(browser,constraints);all.push(c);
    if(await c.page.inputValue('#plannerBackupCount')!=='0')console.error('Constraint restore diagnostic',await c.snapshot(),await c.status(),await c.page.evaluate(()=>({history:HISTORY,fields:DatyPlanningConstraints.captureConstraintFields(),restoreType:typeof restorePlanningProjectFromServer})),c.errors);
    assert.equal(await c.page.inputValue('#plannerBackupCount'),'0');assert.equal(await c.page.inputValue('#plannerMinSpacingKHz'),'250');
    assert.equal(await c.page.evaluate(()=>HISTORY.length),0);assert.equal(await c.page.evaluate(()=>DEVICES.length),0);assert.equal(constraints.posts().length,0);
    console.log('PASS normalized constraints-only import restores form, not fake history or live receiver targets');

    const legacy=server();legacy.legacy={id:'default',name:'旧项目',data:{constraints:{backupCount:2}},devices:[]};
    const old=await harness(browser,legacy,{expectLoad:false});all.push(old);
    await old.page.waitForFunction(()=>DatyPlanningProjectStorage.snapshot().status==='unsupported');
    assert.match(await old.status(),/显式导入|尚未.*导入/);assert.equal(legacy.posts().length,0);
    console.log('PASS legacy data requires explicit import and exposes useful migration diagnostic');

    const shared=server();shared.seed();const left=await harness(browser,shared),right=await harness(browser,shared);all.push(left,right);
    await left.page.fill('#plannerBackupCount','0');await right.page.fill('#plannerBackupCount','3');
    let waiting=[];shared.hook=async url=>{if(url.pathname==='/api/database/batch')await new Promise(resolve=>{waiting.push(resolve);if(waiting.length===2){shared.hook=null;waiting.forEach(fn=>fn());}});};
    await Promise.all([left.click(),right.click()]);await Promise.all([left.done(),right.done()]);
    const statuses=await Promise.all([left.snapshot(),right.snapshot()]);assert.deepEqual(statuses.map(item=>item.status).sort(),['conflict','saved']);assert.equal(shared.posts().length,2);
    assert.equal((await left.history()).records.length,1);assert.equal((await right.history()).records.length,1);
    const loser=statuses[0].status==='conflict'?left:right;
    await loser.click();await loser.page.locator('#datyConfirmDialog').waitFor({state:'visible'});await loser.page.click('#datyConfirmAccept');await loser.done();
    assert.equal(shared.posts().length,2);assert.match(await loser.status(),/再次主动保存/);
    await loser.click();await loser.page.locator('#datyConfirmDialog').waitFor({state:'visible'});await loser.page.click('#datyConfirmAccept');await loser.done();
    assert.equal((await loser.snapshot()).status,'saved');assert.equal(shared.posts().length,3);
    console.log('PASS genuine two-page CAS conflict, local history retained, explicit GET review then explicit subsequent save');

    const lost=server();const u=await harness(browser,lost);all.push(u);lost.state.dropReply=true;await u.click();await u.done();
    // Existing access-client intentionally revokes local confirmation after a
    // network error. Do not weaken it: re-confirm the same public principal by
    // GET, then recover the durable uncertain batch without replay.
    if((await u.snapshot()).status==='unauthorized')await u.page.evaluate(()=>DatyAccess.resume());
    if((await u.snapshot()).status!=='unknown')console.error('Unknown restore diagnostic',await u.snapshot(),await u.page.evaluate(()=>DatyAccess.snapshot()),lost.posts().length);
    assert.equal((await u.snapshot()).status,'unknown');assert.equal(lost.posts().length,1);
    await u.click();await u.page.locator('#datyConfirmDialog').waitFor({state:'visible'});await u.page.click('#datyConfirmCancel');await u.done();assert.equal(lost.posts().length,1);
    await u.click();await u.page.locator('#datyConfirmDialog').waitFor({state:'visible'});await u.page.click('#datyConfirmAccept');await u.done();
    assert.equal(lost.posts().length,1);assert.equal((await u.snapshot()).unknown,null);assert.match(await u.status(),/再次主动保存|本次本机规划尚未同步/);
    assert.notEqual((await u.history()).currentRecordId,lost.get('planning_current').value.currentRecordId);
    console.log('PASS actual Save confirmation routes lost reply through exact operation GET, without replay or false latest-local success');

    const latest=server();const late=await harness(browser,latest);all.push(late);latest.seed(null,{constraints:{backupCount:2}});
    let release,entered;const gate=new Promise(resolve=>entered=resolve);latest.hook=async url=>{if(url.pathname.includes('/project_metadata/')){latest.hook=null;entered();await new Promise(resolve=>release=resolve);}};
    const restoring=late.page.evaluate(()=>{DatyPlanningProjectStorage.invalidate();return restorePlanningProjectFromServer();});await gate;
    await late.page.fill('#plannerBackupCount','7');release();assert.equal(await restoring,false);assert.equal(await late.page.inputValue('#plannerBackupCount'),'7');assert.equal(latest.posts().length,0);
    console.log('PASS pending restore cannot overwrite raw form edits made after original snapshot');

    const provenanceState=server(),v=await harness(browser,provenanceState);all.push(v);
    const csv=Array.from({length:21},(_,index)=>(640+index/10).toFixed(3)+',-100').join('\n');
    assert.equal(await v.page.evaluate(text=>DatyBusinessDatabase.saveImportedScan({name:'scan-before.csv',text:'Frequency (MHz),Level (dBm)\n'+text,isCurrent:()=>true}),csv),true);
    const scanBefore=provenanceState.get('scan_current').value.scanId;
    let releaseRun,runEntered;const runGate=new Promise(resolve=>runEntered=resolve);
    provenanceState.hook=async url=>{if(url.pathname.includes('/project_metadata/')){provenanceState.hook=null;runEntered();await new Promise(resolve=>releaseRun=resolve);}};
    await v.page.evaluate(()=>{
      DEVICES.splice(0,DEVICES.length,{id:1,name:'Fixture offline planning',brand:'DATYaudio',model:'Generic',ch:'CH1',channel:1,freq:641000,_source:'manual'});
      document.getElementById('plannerRange').value='custom';document.getElementById('plannerRangeStart').value='640.000';document.getElementById('plannerRangeEnd').value='642.000';document.getElementById('plannerBackupCount').value='0';
      runPlanning();
    });
    let gateTimer;
    try{await Promise.race([runGate,new Promise((_,reject)=>{gateTimer=setTimeout(()=>reject(Error('Original solver did not reach project sync')),12000);})]);}
    finally{clearTimeout(gateTimer);}
    const importing=v.page.evaluate(text=>DatyBusinessDatabase.saveImportedScan({name:'scan-after.csv',text:'Frequency (MHz),Level (dBm)\n'+text,isCurrent:()=>true}),csv);
    // A previous confirmed batch can require its explicit baseline-only review;
    // accept that original app dialog, then explicitly make the new import.
    const needsReview=await v.page.locator('dialog[open]').waitFor({state:'visible',timeout:1500}).then(()=>true,()=>false);
    if(needsReview){await v.page.locator('dialog[open]').getByRole('button',{name:'只读核对',exact:true}).click();assert.equal(await importing,false);
      assert.equal(await v.page.evaluate(text=>DatyBusinessDatabase.saveImportedScan({name:'scan-after.csv',text:'Frequency (MHz),Level (dBm)\n'+text,isCurrent:()=>true}),csv),true);
    }else assert.equal(await importing,true);
    const scanAfter=provenanceState.get('scan_current').value.scanId;assert.notEqual(scanAfter,scanBefore);releaseRun();
    await v.page.waitForFunction(()=>!DatyPlanningProjectStorage.snapshot().busy);
    assert.equal((await v.snapshot()).status,'saved');
    const selectedRun=provenanceState.get('planning_current').value.currentRecordId,provenRun=provenanceState.get('planning_runs',selectedRun).value;
    assert.equal(provenRun.inputVerification,'computed-inputs-linked');assert.equal(provenRun.scanId,scanBefore);assert.equal(provenRun.profileRefs.length,1);
    const profileProof=provenanceState.get('profiles',provenRun.profileRefs[0].id);
    assert.equal(profileProof.revision,1);assert.equal(profileProof.value.source,'planning-snapshot');assert.equal(profileProof.value.originalProfileId,provenRun.result.profileSnapshots[0].profile.id);
    const linkedSql=JSON.parse(execFileSync(python,[path.join(__dirname,'validate_unified_browser_transactions.py')],
      {encoding:'utf8',input:JSON.stringify(provenanceState.posts().map(item=>JSON.parse(item.options.body))),env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'}}));
    assert.equal(linkedSql.status,'real-sqlite-browser-batches-passed');assert.equal(linkedSql.batches,3);
    console.log('PASS actual global solver binds the scan used before computation and immutable Profile snapshots despite later scan import; all batches verified by real SQLite');

    for(const h of all){assert.deepEqual(h.errors,[]);assert.deepEqual(h.controls,[]);assert(h.served.has('src/platform/unified-project-sync.js'));}
    for(const h of [empty,constraints,legacy,shared,lost,latest,provenanceState])assert.deepEqual(h.errors,[]);
    console.log(JSON.stringify({status:'unified-planning-browser-passed',scenarios:8,deployed:false,liveControlWrites:0}));
  }finally{for(const h of all)await h.context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
