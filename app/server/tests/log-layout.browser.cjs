// Isolated Edge, static GETs only. Synthetic archive/Timeline live only in this test context.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const context=await browser.newContext(),errors=[],writes=[],dialogs=[];
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'daty-log20-'));
  let timelineReads=0;
  try {
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(request.method()==='GET' && url.origin==='https://localhost:8080' &&
        (url.pathname==='/unirf-app.html'||url.pathname==='/DATYlogo.png'||/^\/src\/.*\.(js|css|png|svg)$/.test(url.pathname))){
        return route.fulfill({path:path.join(root,decodeURIComponent(url.pathname))});
      }
      if(request.method()!=='GET')writes.push(request.url());
      if(url.pathname==='/api/timeline')timelineReads++;
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,devices:[],projects:[],ip:'127.0.0.1',
        events:Array.from({length:200},(_,i)=>({ts:1780000000+i,event_type:'device_state_received',device_id:`FAshe-test_ch${i+1}`,summary:`审计#${i}`,details:{message:'长期保留的完整事件信息'.repeat(20)}}))})});
    });
    await context.addInitScript(()=>{
      window.setInterval=()=>0;
      window.EventSource=class extends EventTarget{close(){}};
      window.WebSocket=class extends EventTarget{close(){}send(){throw Error('No live sockets');}};
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    page.on('dialog',async dialog=>{dialogs.push(dialog.type());await dialog.dismiss();});
    await page.goto('https://localhost:8080/unirf-app.html',{waitUntil:'networkidle'});
    await page.evaluate(()=>{
      // Layout-only database port. SQL/receipt correctness is exercised by the
      // separate real HTTPS/SQLite integration; these rows never leave this tab.
      window.notices=[];window.notify=(...args)=>notices.push(args);
      window.DatyDatabaseConnection={snapshot:()=>({origin:'https://127.0.0.1:8802',revision:1,source:{id:'layout-fixture'},status:{epoch:'layout-fixture'}}),request:(...args)=>DatyPlatform.request(...args),subscribe:()=>()=>{}};
      window.DatyAlertDatabase={status:()=>({loaded:true,warning:'',pending:null}),load:async()=>({success:true}),
        records:()=>JSON.parse(localStorage.getItem('daty_db_alerts')||'[]'),
        async clearAll(){const count=this.records().length;localStorage.removeItem('daty_db_alerts');return count;},
        async flush(rows){const records=new Map(this.records().map(item=>[item.archiveId,item]));for(const row of rows)records.set(row.archiveId,{...row});localStorage.setItem('daty_db_alerts',JSON.stringify([...records.values()]));return {success:true,changed:rows.length,count:records.size,readBackConfirmed:true,confirmed:rows.map(row=>({id:row.archiveId,snapshot:row}))};}};
      switchPanel('data');
    });
    const tab=name=>page.locator('#panel-data > .tabs .tab').filter({hasText:name});
    await tab('告警日志').click();
    async function check(label,kind='log'){
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const layout=await page.evaluate(kind=>{
        const history=kind==='history',panel=history?'#dataHistory':'#dataLog',table=history?'#historyTableViewport':'#logTableViewport',body=history?'#historyBody':'#logBody';
        const overflow=['.content','#panel-data',panel,table].map(selector=>{
          const e=document.querySelector(selector);return{selector,client:[e.clientWidth,e.clientHeight],scroll:[e.scrollWidth,e.scrollHeight]};
        }).filter(e=>e.scroll[0]>e.client[0]+1||e.scroll[1]>e.client[1]+1);
        const viewport=document.querySelector(table).getBoundingClientRect();
        const rows=[...document.querySelectorAll(body+' tr')].map(e=>e.getBoundingClientRect());
        const bounds=document.querySelector(panel).getBoundingClientRect();
        const clipped=[...document.querySelectorAll(panel+' button')].filter(e=>e.getClientRects().length).filter(e=>{
          const r=e.getBoundingClientRect(),cell=e.closest('td')?.getBoundingClientRect();
          return r.bottom>bounds.bottom+1 || r.right>bounds.right+1 || (cell && (r.bottom>cell.bottom+1 || r.right>cell.right+1));
        }).map(e=>e.textContent);
        return{overflow,clipped,rows:rows.length,lastBottom:rows.at(-1)?.bottom,tableBottom:viewport.bottom,
          rowHeight:rows[0]?.height,mainOverflow:getComputedStyle(document.querySelector('.content')).overflowY};
      },kind);
      const allowed=kind==='history'?'#historyTableViewport':'#logTableViewport';
      assert.deepEqual(layout.overflow.filter(item=>item.selector!==allowed||item.scroll[0]>item.client[0]+1),[],label+': '+JSON.stringify(layout));
      assert.deepEqual(layout.clipped,[],label);
      // r19 adds filters; short windows keep readable rows in an internal scroll region.
      if(layout.lastBottom>layout.tableBottom+1){
        const reachable=await page.locator(allowed).evaluate(e=>{e.scrollTop=e.scrollHeight;const last=e.querySelector('tbody tr:last-child').getBoundingClientRect();const visible=last.bottom<=e.getBoundingClientRect().bottom+1;e.scrollTop=0;return visible;});
        assert.ok(reachable,label+': last row must be reachable by scrolling');
      }
      assert.equal(layout.mainOverflow,'hidden');
      return layout;
    }
    for(const [width,height]of[[1920,1080],[1366,768],[1280,720],[1024,768],[1024,600]]){
      await page.setViewportSize({width,height});
      await page.evaluate(()=>{localStorage.setItem('daty_db_alerts','[]');showAlertArchive();});
      await check(`${width}x${height} empty`);
      await page.screenshot({path:path.join(output,`empty-${width}x${height}.png`)});
      await page.evaluate(()=>{
        const records=Array.from({length:205},(_,i)=>({archiveId:`test-${i}`,ts:1780000000000+i,
          level:['warn','crit','info'][i%3],deviceId:`DATYaudio 接收机 #${i} CH${i+1}`,receiverIP:'192.0.2.102',
          msg:`告警#${i}|RF 弱信号，阈值 -90 dBm；完整测试消息含 <>&" `+'检查天线和接收距离。'.repeat(30),
          archiveState:i%2?'active':'ended',endedAt:1780000000000+i+5000}));
        localStorage.setItem('daty_db_alerts',JSON.stringify(records));showAlertArchive();
      });
      const before=await page.evaluate(()=>localStorage.getItem('daty_db_alerts'));
      const first=await check(`${width}x${height} 20 rows`);assert.equal(first.rows,20);
      assert.ok((await page.locator('#logBody tr:first-child td:nth-child(4)').getAttribute('title')).length>200);
      await page.screenshot({path:path.join(output,`${width}x${height}.png`)});
      const ids=[];
      for(let p=0;p<11;p++){
        await check(`${width}x${height} page ${p+1}`);
        ids.push(...await page.locator('#logBody tr td:nth-child(4)').evaluateAll(cells=>cells.map(e=>Number(e.textContent.match(/^告警#(\d+)\|/)[1]))));
        if(await page.isDisabled('#logNextPage'))break;
        await page.click('#logNextPage');
      }
      assert.deepEqual(ids,Array.from({length:205},(_,i)=>204-i));
      assert.equal(await page.evaluate(()=>localStorage.getItem('daty_db_alerts')),before);
      assert.equal(await page.locator('#logArchiveView').getAttribute('aria-pressed'),'true');
      await page.getByRole('button',{name:'🕒 服务端 Timeline',exact:true}).click();
      assert.equal(await page.locator('#logTimelineView').getAttribute('aria-pressed'),'true');
      assert.equal(await page.isDisabled('#logSaveNow'),true);assert.equal(await page.isDisabled('#logClearStorage'),true);
      await page.waitForFunction(()=>document.getElementById('logCount').textContent==='200');
      assert.equal((await check(`${width}x${height} Timeline`)).rows,20);
      await page.screenshot({path:path.join(output,`timeline-${width}x${height}.png`)});
      const reads=timelineReads;await page.click('#logNextPage');
      assert.match(await page.locator('#logBody tr:first-child td:nth-child(4)').textContent(),/审计#20/);
      assert.equal(timelineReads,reads,'Timeline paging uses the loaded snapshot');
      await page.getByRole('button',{name:'🧹 清空当前',exact:true}).click();await check(`${width}x${height} clear display`);
      assert.equal(await page.evaluate(()=>localStorage.getItem('daty_db_alerts')),before);
      assert.equal(await page.locator('#logArchiveView').getAttribute('aria-pressed'),'false');
      assert.equal(await page.locator('#logTimelineView').getAttribute('aria-pressed'),'false');
      await page.getByRole('button',{name:'📋 告警记录',exact:true}).click();
      assert.equal(await page.isDisabled('#logSaveNow'),false);assert.equal(await page.isDisabled('#logClearStorage'),false);
      assert.equal((await check(`${width}x${height} archive restored`)).rows,20);
      await page.click('#logClearStorage');
      assert.equal(await page.locator('#datyConfirmTitle').textContent(),'清空告警存储');
      assert.match(await page.locator('#datyConfirmDetails').textContent(),/205 条/);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'datyConfirmCancel');
      const box=await page.locator('#datyConfirmDialog').boundingBox();
      assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height);
      await page.screenshot({path:path.join(output,`clear-storage-${width}x${height}.png`)});
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!_alertArchiveClearPending);
      assert.equal(await page.evaluate(()=>localStorage.getItem('daty_db_alerts')),before);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'logClearStorage');
      await page.locator('#dataLogTab').focus();await page.keyboard.press('Home');
      assert.equal(await page.locator('#dataHistoryTab').getAttribute('aria-selected'),'true');
      await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>document.activeElement.id),'dataImportTab');
      await page.keyboard.press('End');assert.equal(await page.locator('#dataServerTab').getAttribute('aria-selected'),'true');
      await tab('规划历史').click();assert.equal(await page.locator('.content').evaluate(e=>e.classList.contains('alert-log-view')),false);
      await page.evaluate(()=>{HISTORY.splice(0);renderHistory();});await check(`${width}x${height} history empty`,'history');
      await page.evaluate(()=>{
        HISTORY.splice(0,HISTORY.length,...Array.from({length:205},(_,i)=>({id:`history-${i}`,type:'daty_rf_planning',devices:[],
          name:`规划#${i}|`+'演出项目完整规划名称 <A> '.repeat(20),time:'2026/9/11 12:34:56',channels:8,algo:'确定性全局约束算法',
          constraints:{excludedRanges:[],lockedAssignments:[],knownCarriers:[],backupCount:0},imdMargin:'250 kHz'})));
        currentPlanningRecordId='history-0';persistPlanningHistoryState();
        setPlanningSaveStatus('已保存到当前项目；完整状态说明'+'测试完整状态文字'.repeat(30));renderHistory();
      });
      const historyBefore=await page.evaluate(()=>localStorage.getItem('daty_planning_history_v1'));
      const historyFirst=await check(`${width}x${height} history 20 rows`,'history');assert.equal(historyFirst.rows,20);
      assert.equal(await page.locator('#planningHistoryProject').evaluate(e=>e.scrollWidth<=e.clientWidth),true,'long save-status text must not squeeze out the project label');
      assert.ok((await page.locator('#historyBody tr:first-child td:nth-child(2)').getAttribute('title')).length>200);
      await page.screenshot({path:path.join(output,`history-${width}x${height}.png`)});
      const historyIds=[];
      for(let p=0;p<11;p++){
        await check(`${width}x${height} history page ${p+1}`,'history');
        historyIds.push(...await page.locator('#historyBody .history-name-text').evaluateAll(cells=>cells.map(e=>Number(e.textContent.match(/^规划#(\d+)\|/)[1]))));
        if(await page.isDisabled('#historyNextPage'))break;
        await page.click('#historyNextPage');
      }
      assert.deepEqual(historyIds,Array.from({length:205},(_,i)=>i));
      assert.equal(await page.evaluate(()=>localStorage.getItem('daty_planning_history_v1')),historyBefore);
      assert.match(await page.textContent('#historyPageInfo'),/第 11\/11 页 · 每页 20 条/);
      console.log(`${width}x${height}: history 20 rows at ${historyFirst.rowHeight.toFixed(2)}px, all 205 records accessible with visible action buttons`);
      await tab('数据导入').click();assert.equal(await page.locator('.content').evaluate(e=>getComputedStyle(e).overflowY),'auto');
      await tab('告警日志').click();await page.evaluate(()=>switchPanel('planner'));
      assert.equal(await page.locator('.content').evaluate(e=>e.classList.contains('alert-log-view')),false);
      await page.evaluate(()=>switchPanel('data'));await check(`${width}x${height} navigate back`);
      console.log(`${width}x${height}: 20 rows, ${first.rowHeight.toFixed(2)}px/row, 205 records paged without loss; no vertical overflow`);
    }
    // All data below are synthetic and confined to this temporary browser context.
    await page.evaluate(()=>{
      ALERTS.splice(0,ALERTS.length,{id:'fixture',archiveId:'fixture',ts:1780000000000,msg:'真实业务逻辑的隔离测试',level:'warn'});
      localStorage.setItem('daty_db_alerts',JSON.stringify([{id:'saved',msg:'归档测试'}]));
      queueAlertForArchive(ALERTS[0]);showAlertArchive();
    });
    const keep=await page.evaluate(()=>({pending:localStorage.getItem('daty_pending_alerts_v1'),alerts:JSON.stringify(ALERTS)}));
    await page.click('#logClearStorage');await page.click('#datyConfirmAccept');
    await page.waitForFunction(()=>!_alertArchiveClearPending);
    assert.equal(await page.evaluate(()=>localStorage.getItem('daty_db_alerts')),null);
    assert.deepEqual(await page.evaluate(()=>({pending:localStorage.getItem('daty_pending_alerts_v1'),alerts:JSON.stringify(ALERTS)})),keep);
    await page.click('#logSaveNow');await page.waitForFunction(()=>document.getElementById('logCount').textContent==='1');
    await page.click('#logSaveNow');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('daty_db_alerts')).length),1);
    const saved=await page.evaluate(()=>localStorage.getItem('daty_db_alerts'));
    await page.click('#logClearStorage');
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
    await page.waitForFunction(()=>!_alertArchiveClearPending);
    assert.equal(await page.evaluate(()=>localStorage.getItem('daty_db_alerts')),saved);
    assert.equal(await page.locator('#datyConfirmDialog').count(),0);
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);assert.deepEqual(dialogs,[]);

    console.log('PASS: desktop data tabs/log controls, app clear confirmation, 20-row history/archive/Timeline, content preservation, keyboard navigation; screenshots: '+output);
  }finally{await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
