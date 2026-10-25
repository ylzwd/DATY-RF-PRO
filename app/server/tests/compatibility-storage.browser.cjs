'use strict';
// Real temporary TLS/SQLite, production page modules. All receiver controls blocked.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),https=require('node:https');
const {spawn,execFileSync}=require('node:child_process'),readline=require('node:readline'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-compatibility-'));
const python='C:\\ProgramData\\DATY RF PRO\\runtime\\python\\python.exe';
(async()=>{
  const child=spawn(python,['-B',path.join(__dirname,'server-storage-fixture.py'),'--stdio-fixture'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  let stderr='',readyResolve,readyReject;const ready=new Promise((a,b)=>{readyResolve=a;readyReject=b;}),pending=new Map();let serial=0;
  child.stderr.on('data',data=>stderr+=data);child.on('exit',code=>{if(code)readyReject(Error(stderr||'Fixture exited '+code));});
  readline.createInterface({input:child.stdout}).on('line',line=>{try{const value=JSON.parse(line);if(value.event==='ready')readyResolve(value);else if(pending.has(value.id)){pending.get(value.id)(value.result);pending.delete(value.id);}}catch(_){}});
  const fixture=await ready,agent=new https.Agent({ca:fixture.ca});
  const command=name=>new Promise(resolve=>{const id=++serial;pending.set(id,resolve);child.stdin.write(JSON.stringify({id,command:name})+'\n');});
  const request=(route,method='GET',body)=>new Promise((resolve,reject)=>{
    const req=https.request(fixture.origin+route,{agent,method,headers:{'Content-Type':'application/json',Origin:'https://localhost:8080',...(body?{'Content-Length':Buffer.byteLength(body)}:{})}},response=>{
      const data=[];response.on('data',b=>data.push(b));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(data)}));
    });req.on('error',reject);if(body)req.write(body);req.end();
  });
  const json=async route=>{const result=await request(route);assert.equal(result.status,200,result.body.toString());return JSON.parse(result.body);};
  const errors=[],requests=[],failures=[],records=[];let browser;
  try{
    await command('seed-receiver');browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
    const context=await browser.newContext({acceptDownloads:true});
    await context.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();setTimeout(()=>this.onopen?.(),0);}close(){}};});
    await context.route('**/*',async route=>{
      const q=route.request(),u=new URL(q.url());
      if(u.pathname==='/api/updates')return route.fulfill({status:200,contentType:'text/event-stream',body:''});
      if(q.method()==='GET'&&(u.pathname==='/unirf-app.html'||u.pathname==='/DATYlogo.png'||u.pathname.startsWith('/src/'))){const file=path.join(root,u.pathname);if(fs.existsSync(file))return route.fulfill({path:file});}
      if(u.pathname.startsWith('/api/')||u.pathname==='/health'){
        assert.ok(!u.pathname.startsWith('/api/command'),'No device commands');
        const result=await request(u.pathname+u.search,q.method(),q.postData());requests.push({path:u.pathname,method:q.method(),status:result.status});
        if(result.status>=400)failures.push({path:u.pathname,status:result.status,body:result.body.toString().slice(0,400)});
        return route.fulfill({status:result.status,headers:result.headers,body:result.body});
      }
      return route.fulfill({status:404,json:{success:false}});
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{errors.push('System dialog: '+d.message());void d.dismiss();});
    const boot=async()=>{await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>globalThis.DatyServerStorage?.ready,null,{timeout:30000});};
    const attach=async()=>{await command('seed-receiver');const devices=(await json('/api/devices')).devices.map(d=>({...d,group_number:1,group_source:'server-fifo-v1'}));await page.evaluate(devices=>{_fasheHandleDeviceList(devices);switchPanel('planner');},devices);};
    const waitDraft=async level=>{
      for(let i=0;i<100;i++){const d=(await json('/api/database/draft?project_id=default')).draft;if(d?.value?.payload?.fields?.plannerCompatibility===level)return d;await new Promise(resolve=>setTimeout(resolve,50));}
      throw Error('Draft not committed: '+level);
    };
    await boot();await attach();
    await page.selectOption('#plannerRange','custom');await page.fill('#plannerRangeStart','640');await page.fill('#plannerRangeEnd','690');
    await page.click('#plannerConstraintsTab');await page.fill('#plannerBackupCount','0');await page.click('#plannerBasicTab');
    for(const [level,label,spacing,imd,threshold]of [['robust','保守',250,150,-75],['standard','标准',250,250,-78],['more-frequencies','紧凑',250,0,-72]]){
      await page.selectOption('#plannerCompatibility',level);await waitDraft(level);
      await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>DatyServerStorage.ready);
      assert.equal(await page.inputValue('#plannerCompatibility'),level);await attach();
      await page.locator('[data-planner-action="plan"]').click();
      await page.waitForFunction(()=>!!DATY_LAST_COORDINATION);
      await page.waitForFunction(()=>/已保存到当前项目/.test(document.getElementById('plannerConstraintSaveStatus').textContent),null,{timeout:15000});
      const record=await page.evaluate(()=>getCurrentPlanningRecord());records.push(record);
      const run=(await json('/api/database/resources/planning_runs/'+encodeURIComponent(record.id))).resource.value;
      const history=(await json('/api/database/resources/planning_records/'+encodeURIComponent(record.id))).resource.value;
      assert.equal(run.input.options.compatibilityLevel,level);assert.equal(history.constraintFields.plannerCompatibility,level);
      assert.deepEqual(history.coordination.compatibility,run.result.compatibility);
      assert.equal(run.result.compatibility.level,level);assert.equal(run.result.compatibility.label,label);
      for(const row of run.result.compatibility.devices)assert.deepEqual([row.channelSpacingKHz,row.intermodSpacingKHz,row.scanThresholdDbm],[spacing,imd,threshold]);
      assert.equal(run.result.search.complete,true);assert.match(await page.locator('#planResultContent').innerText(),new RegExp(label));
      const guard=imd===0?'无':`${imd} kHz`;
      assert.ok((await page.locator('#planResultContent').innerText()).includes(`互调保护 ${guard}`));
      assert.ok((await page.locator('#plannerCompatibilityHint').textContent()).includes(`互调保护 ${guard}`));
      assert.equal(run.result.frequencyPool,undefined);assert.equal(run.result.assignments.length,2);
      assert.equal(run.input.options.minimumFrequencyCount,0);assert.equal(run.input.options.frequencyDistribution,'spread-range');
      assert.deepEqual(history.coordination.distribution,run.result.distribution);
      assert.equal(run.result.distribution.targetCount,2);assert.equal(run.result.distribution.enabled,true);
      assert.deepEqual(run.result.assignments.map(a=>a.frequencyKHz).sort((a,b)=>a-b),[640000,690000]);
      const report=await page.evaluate(()=>DatyCoordinationReport.buildText(DATY_LAST_COORDINATION,DEVICES));
      assert.match(report,/兼容级别有效参数/);assert.ok(report.includes(`"scanThresholdDbm": ${threshold}`));assert.ok(report.includes(`"intermodSpacingKHz": ${imd}`));assert.ok(report.includes(label));
      assert.equal(await page.evaluate(()=>DatyPlanningDeployment.preflight().length),2);
      if(level==='more-frequencies'){
        assert.ok(report.includes('按 2 个实际通道分散于设定范围'));assert.ok(!report.includes('预留频点 (kHz):'));
        const csvDownload=page.waitForEvent('download');await page.click('#plannerExportPlan');await page.locator('#datyConfirmDialog').waitFor();await page.click('#datyConfirmAccept');
        const csv=fs.readFileSync(await (await csvDownload).path(),'utf8');assert.equal(csv.split('\r\n').length,3);assert.equal((csv.match(/未绑定设备/g)||[]).length,0);assert.ok(csv.includes('640.000'));assert.ok(csv.includes('690.000'));
      }
      if(level==='more-frequencies')for(const [width,height]of [[1920,1080],[1366,768],[1024,600]]){
        await page.setViewportSize({width,height});await page.screenshot({path:path.join(output,`planned-${width}x${height}.png`)});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        assert.ok(await page.evaluate(()=>document.querySelector('.planner-result-notice').getBoundingClientRect().bottom<=document.getElementById('planResult').getBoundingClientRect().bottom),'Result warning must stay inside its card');
      }
      if(level==='more-frequencies'){
        await page.locator('[data-planner-action="details"]').click();await page.screenshot({path:path.join(output,'range-details-1024x600.png')});
        assert.ok((await page.locator('#plannerDetailContent').innerText()).includes('按本次 2 个实际通道'));await page.keyboard.press('Escape');
      }
    }
    // Changing level invalidates a previously deployable plan immediately.
    await page.selectOption('#plannerCompatibility','robust');
    assert.equal(await page.evaluate(()=>DATY_LAST_COORDINATION),null);
    assert.equal(await page.evaluate(()=>{try{DatyPlanningDeployment.preflight();return false;}catch(_){return true;}}),true);
    await waitDraft('robust');
    // Explicit history load and JSON export retain the original selected level and evidence.
    const compact=records.at(-1);
    await page.evaluate(()=>switchPanel('data'));await page.evaluate(id=>{void loadHistory(id);},compact.id);
    await page.locator('#datyConfirmDialog').waitFor();await page.click('#datyConfirmAccept');
    await page.waitForFunction(()=>document.getElementById('plannerCompatibility').value==='more-frequencies');
    await page.evaluate(()=>switchPanel('data'));
    const downloadPromise=page.waitForEvent('download');await page.evaluate(id=>{void exportHistory(id);},compact.id);
    await page.locator('#datyConfirmDialog').waitFor();await page.click('#datyConfirmAccept');
    const downloaded=JSON.parse(fs.readFileSync(await (await downloadPromise).path(),'utf8'));
    assert.equal(downloaded.options.compatibilityLevel,'more-frequencies');assert.deepEqual(downloaded.coordination.compatibility,compact.coordination.compatibility);
    assert.equal(downloaded.coordination.frequencyPool,undefined);assert.deepEqual(downloaded.coordination.distribution,compact.coordination.distribution);
    // New context has no prior browser cache: server draft remains authoritative.
    const clean=await browser.newContext();await clean.route('**/*',async route=>{
      const q=route.request(),u=new URL(q.url());
      if(u.pathname==='/api/updates')return route.fulfill({status:200,contentType:'text/event-stream',body:''});
      if(q.method()==='GET'&&(u.pathname==='/unirf-app.html'||u.pathname==='/DATYlogo.png'||u.pathname.startsWith('/src/'))){const file=path.join(root,u.pathname);if(fs.existsSync(file))return route.fulfill({path:file});}
      if(u.pathname.startsWith('/api/')||u.pathname==='/health'){assert.ok(!u.pathname.startsWith('/api/command'));const r=await request(u.pathname+u.search,q.method(),q.postData());return route.fulfill({status:r.status,headers:r.headers,body:r.body});}
      return route.fulfill({status:404,json:{success:false}});
    });
    await clean.addInitScript(()=>{window.EventSource=class{constructor(){setTimeout(()=>this.onopen?.(),0);}close(){}};});
    const fresh=await clean.newPage();await fresh.goto('https://localhost:8080/unirf-app.html');await fresh.waitForFunction(()=>globalThis.DatyServerStorage?.ready,null,{timeout:30000});
    const actualDraft=(await json('/api/database/draft?project_id=default')).draft.value.payload.fields.plannerCompatibility;
    assert.equal(await fresh.inputValue('#plannerCompatibility'),actualDraft);await clean.close();
    await attach();await page.evaluate(()=>DatyPlanningConstraints.updateConstraintFeedback());
    for(const [width,height]of [[1920,1080],[1366,768],[1024,600]]){
      await page.setViewportSize({width,height});await page.screenshot({path:path.join(output,`${width}x${height}.png`)});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.ok(await page.locator('#plannerCompatibility').isVisible());assert.match(await page.locator('#plannerCompatibilityHint').textContent(),/通道保护/);
    }
    const stats=await command('stats');assert.equal(stats.tables.db_planning_runs,3);assert.equal(stats.tables.biz_planning_records,3);assert.equal(stats.foreignKeys,0);assert.equal(stats.commands,0);assert.deepEqual(errors,[]);
    // Independently inspect committed SQL rows in read-only mode, not browser mirrors.
    const sql=JSON.parse(execFileSync(python,['-c',"import sqlite3,json,sys; from pathlib import Path; c=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True); rows=c.execute('SELECT input_json,result_json FROM db_planning_runs').fetchall(); print(json.dumps([{'level':json.loads(a)['options']['compatibilityLevel'],'effective':json.loads(b)['compatibility'],'distribution':json.loads(b).get('distribution'),'pool':json.loads(b).get('frequencyPool')} for a,b in rows]))",path.join(fixture.temporary,'fixture.sqlite3')],{encoding:'utf8',windowsHide:true}));
    assert.deepEqual(sql.map(r=>r.level).sort(),['more-frequencies','robust','standard']);
    assert.ok(sql.every(row=>row.pool===null));assert.deepEqual(sql.find(row=>row.level==='more-frequencies').distribution,compact.coordination.distribution);
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({fixture:fixture.temporary,stats,sql,records,requests,failures,errors},null,2));
    console.log('PASS: three compatibility levels, real HTTPS/SQLite drafts/history/runs, reload and clean context, effective parameters, export, invalidation, three viewports; zero device controls. '+output);
  }catch(error){fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({errors,failures,requests,stderr},null,2));console.error('Evidence: '+output);throw error;}
  finally{await browser?.close();child.stdin.write(JSON.stringify({command:'shutdown'})+'\n');child.stdin.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
