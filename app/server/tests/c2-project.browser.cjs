'use strict';
// Complete candidate HTML in fresh contexts; shared in-memory CAS fixtures only.
// All requests are fulfilled/aborted, sockets are stubbed, never a live receiver.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),candidate=require('../scripts/c2-candidate.cjs');
const ROOT=candidate.ROOT,files=candidate.prepare().files,ORIGIN='https://localhost:8080';
const PROTOCOL='daty-project-revision-v1',KEY='daty_planning_history_v1',copy=v=>JSON.parse(JSON.stringify(v));
const record=(id,backup=1)=>({id,type:'daty_rf_planning',projectId:'default',projectName:'默认项目',name:id,
  timestamp:1000,devices:[],options:{backupCount:backup},constraints:{backupCount:backup}});
const project=(selected=null,records=[])=>({id:'default',name:'默认项目',revision:1,revision_protocol:PROTOCOL,devices:[],
  data:{planningHistory:records,deletedRecordIds:[],currentPlanningRecordId:selected?.id||null,
    ...(selected?{constraints:selected.options}:{}),future:{preserved:true}}});
function server(remote=project()) {return {project:copy(remote),calls:[],errors:[],gate:null,loseNext:false,runFails:false};}
async function harness(browser,state,{local=null,original=false}={}){
  const context=await browser.newContext({viewport:{width:1366,height:768},serviceWorkers:'block'});
  context.setDefaultTimeout(12000);const page=await context.newPage(),errors=[],controls=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>dialog.type()==='confirm'?dialog.accept():dialog.dismiss());
  await context.route('**/*',async route=>{
    const request=route.request(),u=new URL(request.url()),method=request.method();
    const json=(value,status=200)=>route.fulfill({status,json:value});
    try{
      const name=u.pathname.slice(1);
      if(method==='GET'&&u.origin===ORIGIN&&files.has(name)){
        const body=original?fs.readFileSync(path.join(ROOT,name)):files.get(name);
        return await route.fulfill({body,contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'image/png'});
      }
      if(u.pathname==='/api/auth/status')return await json({success:true,auth:{protocol:'daty-access-v1',configured:true,
        authenticated:true,mode:'local-development',principal:{id:'local-development',name:'本机开发',role:'operator'},
        permissions:['device.control','project.write','timeline.write','discovery.scan']}});
      if(u.pathname==='/api/command') {controls.push(request.postData());throw Error('Project sync cannot send device commands');}
      if(u.pathname.startsWith('/api/projects')||u.pathname==='/api/coordination-runs'){
        const call={path:u.pathname,method,body:request.postData()?JSON.parse(request.postData()):null};state.calls.push(call);
        assert.equal(u.origin,'https://127.0.0.1:8802');
        if(method==='GET'&&u.pathname==='/api/projects/default'){
          const snapshot=copy(state.project);
          if(state.gate)await new Promise(resolve=>{state.gate.push(resolve);if(state.gate.length===2){const ready=state.gate;state.gate=null;ready.forEach(fn=>fn());}});
          return await json({success:true,project:snapshot,revision_protocol:PROTOCOL});
        }
        if(method==='POST'&&u.pathname==='/api/projects'){
          assert.equal(request.headers()['x-daty-local-development'],'1');
          const body=call.body;
          if(body.expected_revision!==state.project.revision)return await json({success:false,code:'PROJECT_REVISION_CONFLICT',revision_protocol:PROTOCOL},409);
          state.project={...copy(body),revision:state.project.revision+1,revision_protocol:PROTOCOL};delete state.project.expected_revision;
          if(state.loseNext){state.loseNext=false;return await route.abort('failed');}
          return await json({success:true,project_id:body.id,revision:state.project.revision,revision_protocol:PROTOCOL});
        }
        if(method==='POST'&&u.pathname==='/api/coordination-runs')return await json(state.runFails?{success:false}:{success:true,run_id:'fixture-run'},state.runFails?500:200);
        throw Error('Unexpected project endpoint '+method+' '+u.pathname);
      }
      if(method!=='GET')throw Error('Unexpected write '+method+' '+u.pathname);
      return await json({success:true,status:'ok',devices:[],events:[],projects:[],ip:'127.0.0.1',count:0});
    }catch(error){state.errors.push(error.message);await route.abort().catch(()=>{});}
  });
  await context.addInitScript(({local,KEY})=>{
    window.setInterval=()=>0;
    window.EventSource=class extends EventTarget{close(){}};
    window.WebSocket=class extends EventTarget{close(){}send(){throw Error('No real sockets');}};
    if(local)localStorage.setItem(KEY,JSON.stringify({project:{id:'default',name:'默认项目'},currentRecordId:local.id,records:[local],deletedRecordIds:[]}));
  },{local,KEY});
  await page.goto(ORIGIN+'/unirf-app.html',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>DatyAccess.snapshot().mode==='local-development');
  if(!original)await page.waitForFunction(()=>DatyPlanningProjectStorage.snapshot().loaded&&!DatyPlanningProjectStorage.snapshot().pending);
  await page.evaluate(()=>{switchPanel('planner');switchPlannerControlTab('constraints');});
  return {page,context,errors,controls,history:()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'{}'),KEY),
    snapshot:()=>page.evaluate(()=>DatyPlanningProjectStorage.snapshot()),
    click:()=>page.click('#savePlannerConstraints'),
    done:()=>page.waitForFunction(()=>!document.getElementById('savePlannerConstraints').disabled),
    status:()=>page.textContent('#plannerConstraintSaveStatus')};
}
const posts=state=>state.calls.filter(call=>call.method==='POST');
async function main(){
  const browser=await chromium.launch({headless:true,executablePath:process.env.EDGE_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const all=[];
  try{
    // Two genuine isolated pages establish the same revision before competing.
    const shared=server(),a=await harness(browser,shared),b=await harness(browser,shared);all.push(a,b);
    await a.page.fill('#plannerBackupCount','0');await b.page.fill('#plannerBackupCount','2');shared.gate=[];
    await Promise.all([a.click(),b.click()]);await Promise.all([a.done(),b.done()]);
    const statuses=await Promise.all([a.snapshot(),b.snapshot()]);
    assert.deepEqual(statuses.map(s=>s.status).sort(),['conflict','saved']);assert.equal(posts(shared).length,2);
    assert.equal((await a.history()).records.length,1);assert.equal((await b.history()).records.length,1);
    const loser=statuses[0].status==='conflict'?a:b;
    assert.match(await loser.status(),/冲突/);assert.doesNotMatch(await loser.status(),/已保存到当前项目/);
    await loser.click();await loser.page.locator('#datyConfirmDialog').waitFor({state:'visible'});
    const conflictRead=shared.calls.length;
    await loser.page.click('#datyConfirmAccept');await loser.done();
    assert.deepEqual(shared.calls.slice(conflictRead).map(r=>r.method),['GET']);
    assert.match(await loser.status(),/再次主动保存/);assert.equal(posts(shared).length,2);
    await loser.click();await loser.page.locator('#datyConfirmDialog').waitFor({state:'visible'});
    await loser.page.click('#datyConfirmAccept');await loser.done();
    assert.equal((await loser.snapshot()).status,'saved');assert.equal(posts(shared).length,3);
    for(const h of [a,b])for(const r of (await h.history()).records)assert.ok(shared.project.data.planningHistory.some(s=>s.id===r.id));
    console.log('PASS candidate two-page CAS: one confirmed, one conflict, both local histories retained');

    // Existing local input must not silently inherit a different remote baseline.
    const local=record('cached-local',0),remote=record('other-client',2),divergent=server(project(remote,[remote]));
    const c=await harness(browser,divergent,{local});all.push(c);
    assert.equal((await c.history()).currentRecordId,local.id);assert.equal(await c.page.inputValue('#plannerBackupCount'),'0');
    assert.equal((await c.snapshot()).reviewRequired,true);assert.equal(posts(divergent).length,0);
    await c.click();await c.page.locator('#datyConfirmDialog').waitFor({state:'visible'});
    await c.page.click('#datyConfirmCancel');await c.done();assert.equal(posts(divergent).length,0);
    assert.match(await c.status(),/取消/);
    await c.click();await c.page.locator('#datyConfirmDialog').waitFor({state:'visible'});
    await c.page.click('#datyConfirmAccept');await c.done();
    assert.equal(posts(divergent).length,1);assert.equal(divergent.project.data.future.preserved,true);
    for(const id of [local.id,remote.id])assert.ok(divergent.project.data.planningHistory.some(r=>r.id===id));
    // Actual unchanged delete button/confirmation calls the new project hook.
    await c.page.evaluate(()=>switchPanel('data'));
    const row=c.page.locator('#historyBody tr').filter({has:c.page.locator('button[onclick*=deleteHistoryById]')}).last();
    await row.locator('button[onclick*=deleteHistoryById]').click();
    await c.page.waitForFunction(()=>!DatyPlanningProjectStorage.snapshot().busy);
    assert.ok(divergent.project.data.deletedRecordIds.includes(local.id));
    assert.ok(!divergent.project.data.planningHistory.some(r=>r.id===local.id));
    console.log('PASS candidate cached-baseline review: cancel no POST, accept preserves history; real history delete uses CAS');

    const uncertain=server(),u=await harness(browser,uncertain);all.push(u);uncertain.loseNext=true;
    await u.click();await u.done();assert.equal((await u.snapshot()).status,'unknown');assert.equal(posts(uncertain).length,1);
    await u.click();await u.page.locator('#datyConfirmDialog').waitFor({state:'visible'});
    const before=uncertain.calls.length;await u.page.click('#datyConfirmCancel');await u.done();
    assert.equal(uncertain.calls.length,before);assert.equal(posts(uncertain).length,1);
    await u.click();await u.page.locator('#datyConfirmDialog').waitFor({state:'visible'});
    const readStart=uncertain.calls.length;await u.page.click('#datyConfirmAccept');await u.done();
    assert.deepEqual(uncertain.calls.slice(readStart).map(r=>r.method),['GET']);assert.equal(posts(uncertain).length,1);
    assert.equal((await u.snapshot()).unknown,null);assert.match(await u.status(),/上一笔|已确认/);
    assert.notEqual((await u.history()).currentRecordId,uncertain.project.data.currentPlanningRecordId,'This click kept its newer local record without posting it');
    console.log('PASS candidate lost response: explicit GET-only reconciliation is reachable from the original Save button');

    // Run logging is a separate transaction. Expose its real partial error through
    // the existing status port without running or replacing the planning engine.
    const partialState=server(),partial=await harness(browser,partialState);all.push(partial);partialState.runFails=true;
    const partialResult=await partial.page.evaluate(async()=>{
      const run={assignments:[],analysis:{conflicts:[]}},r=savePlanningResult([],run,{backupCount:0});
      try{await persistPlanningProject(r,run);return {unexpected:true};}
      catch(error){setPlanningSaveStatus(error.message);return {status:error.syncStatus,projectSaved:error.projectSaved,runStatus:error.runStatus};}
    });
    assert.deepEqual(partialResult,{status:'partial',projectSaved:true,runStatus:'unknown'});
    assert.match(await partial.status(),/项目已保存/);assert.equal(posts(partialState).length,2);
    await partial.click();await partial.page.locator('#datyConfirmDialog').waitFor({state:'visible'});
    await partial.page.click('#datyConfirmAccept');await partial.done();
    assert.equal(posts(partialState).length,2);assert.notEqual((await partial.snapshot()).unknown,null);
    assert.match(await partial.status(),/仍无法只读确认/);
    console.log('PASS candidate partial project/run result remains explicit and cannot replay the run');
    for(const h of [loser,u,partial])for(const [width,height]of [[1366,768],[1024,600]]){
      await h.page.setViewportSize({width,height});
      const bounded=await h.page.evaluate(()=>{
        const button=document.getElementById('savePlannerConstraints').getBoundingClientRect();
        return button.top>=0&&button.bottom<=innerHeight&&button.left>=0&&button.right<=innerWidth
          &&document.documentElement.scrollHeight<=innerHeight+1;
      });
      assert.equal(bounded,true,'Actual conflict/unknown/partial status must keep Save reachable without page overflow');
    }

    // No CSS/template changes: compare fixed planning controls in both HTMLs.
    const layoutServer=server(),old=await harness(browser,layoutServer,{original:true}),fresh=await harness(browser,server());all.push(old,fresh);
    async function geometry(page){return page.evaluate(()=>{
      const selectors=['.main','.content','#panel-planner','#plannerConstraints','#savePlannerConstraints','#plannerTableViewport'];
      return selectors.map(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect(),s=getComputedStyle(e);
        return {selector,x:r.x,y:r.y,w:r.width,h:r.height,font:s.font,fontSize:s.fontSize,color:s.color,overflowY:s.overflowY};});
    });}
    for(const [width,height] of [[1920,1080],[1366,768],[1024,600]]){
      for(const h of [old,fresh]){
        await h.page.setViewportSize({width,height});
        await h.page.evaluate(()=>{document.getElementById('plannerConstraintSaveStatus').textContent='相同状态对照';});
      }
      assert.deepEqual(await geometry(fresh.page),await geometry(old.page));
      assert.equal(await fresh.page.evaluate(()=>document.documentElement.scrollHeight>innerHeight+1),false);
    }
    for(const h of all){assert.deepEqual(h.errors,[]);assert.deepEqual(h.controls,[]);}
    for(const state of [shared,divergent,uncertain,partialState,layoutServer])assert.deepEqual(state.errors,[]);
    console.log('PASS candidate full-page bootstrap and 3-size unchanged planning geometry; live commands 0');
  }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
