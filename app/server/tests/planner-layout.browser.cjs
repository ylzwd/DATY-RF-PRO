// Isolated Edge layout test. Static files and APIs are fixtures; no production requests.
// NODE_PATH must point to a runtime containing playwright. No live device controls.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.join(__dirname, '..');

(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const context = await browser.newContext();
  const commands = [], errors = [], screenshots = fs.mkdtempSync(path.join(os.tmpdir(), 'daty-planner-layout-'));
  try {
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() === 'GET' && url.origin === 'https://localhost:8080' &&
          (url.pathname === '/unirf-app.html' || url.pathname === '/DATYlogo.png' || /^\/src\/.*\.(css|js)$/.test(url.pathname))) {
        return route.fulfill({path:path.join(root,decodeURIComponent(url.pathname))});
      }
      if (url.pathname === '/api/command') commands.push(req.postData());
      return route.fulfill({status:200, contentType:'application/json', body:JSON.stringify({success:true,devices:[],projects:[],events:[],ip:'127.0.0.1',project:{id:'test-project',name:'Isolated layout test'}})});
    });
    await context.addInitScript(() => {
      window.setInterval = () => 0; // Disable telemetry polling in this isolated layout fixture.
      window.EventSource = class extends EventTarget {close() {} static CLOSED = 2;};
      window.WebSocket = class extends EventTarget {close() {} send() {throw Error('No sockets allowed in layout test');}};
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://localhost:8080/unirf-app.html', {waitUntil:'networkidle'});
    await page.evaluate(() => {
      // Project saves stay inside the test browser, not the server/user project.
      window.persistPlanningProject = async () => {};
      window.notify = () => {};
      window.fixtureDevices = count => {
        DATY_STATE.devices.splice(0, DATY_STATE.devices.length, ...Array.from({length:count}, (_,i) => ({
          id:i+1, ch:`CH${i+1}`, channel_number:i+1, group_source:'server-fifo-v1', group_number:i<16?10:2, brand:'DATYaudio', model:'DATY-X1',
          name:`测试接收机 CH${i+1}`, freq:[641000,642000,644000][i] || 650000+i*500,
          planned:0, _source:'manual', _online:true, rf:-50, afDbfs:-12, batt:90
        })).reverse());
        resetPlannerTablePage(); renderFreqTable(false);
      };
      fixtureDevices(0);
      switchPanel('planner');
    });
    // Only planning controls are editable; spectrum uses a padded display-state range.
    async function assertLinked(start,end) {
      const state=await page.evaluate(()=>({values:['plannerRangeStart','plannerRangeEnd','specStart','specEnd'].map(id=>document.getElementById(id).value),
        options:DatyPlanningConstraints.getOptions(),axis:getSpectrumRangeMHz()}));
      const view=[Number(start)-10,Number(end)+10];
      assert.deepEqual(state.values,[start,end,...view.map(n=>n.toFixed(3))]);
      assert.deepEqual(state.axis,view);
      assert.deepEqual([state.options.rangeStartKHz,state.options.rangeEndKHz],[Math.round(Number(start)*1000),Math.round(Number(end)*1000)]);
    }
    await assertLinked('614.250','638.000');
    await page.fill('#plannerRangeStart','640.000');await page.fill('#plannerRangeEnd','690.000');
    await assertLinked('640.000','690.000');
    await page.screenshot({path:path.join(screenshots,'margin-planner.png')});
    await page.evaluate(()=>switchPanel('spectrum'));
    assert.equal(await page.locator('#specStart').isVisible(),false);assert.equal(await page.locator('#specEnd').isVisible(),false);
    const paddedAxis=await page.locator('#freqAxis').innerText();
    assert.ok(paddedAxis.startsWith('630 MHz') && paddedAxis.trim().endsWith('700 MHz'));
    await page.screenshot({path:path.join(screenshots,'margin-spectrum.png')});
    await page.evaluate(()=>switchPanel('planner'));await page.fill('#plannerRangeStart','640.125');await page.fill('#plannerRangeEnd','690.375');
    await assertLinked('640.125','690.375');
    await page.fill('#plannerRangeEnd','');assert.equal(await page.getAttribute('#plannerRangeEnd','aria-invalid'),'true');
    assert.deepEqual(await page.evaluate(()=>getSpectrumRangeMHz()),[630.125,700.375]);
    await page.fill('#plannerRangeEnd','690.375');await assertLinked('640.125','690.375');
    await page.selectOption('#plannerRange','640000:690000');
    await page.evaluate(()=>{fixtureDevices(3);for(const d of DEVICES)Object.assign(d,{_source:'192.0.2.102:mqtt',_fasheId:`fixture-rx_ch${d.channel_number}`,ip:'192.0.2.102',receiver_id:'fixture-rx'});});
    await page.click('.planner-run-button');
    assert.deepEqual(await page.evaluate(()=>[DATY_LAST_COORDINATION.options.rangeStartKHz,DATY_LAST_COORDINATION.options.rangeEndKHz]),[640000,690000]);
    await page.evaluate(()=>{window.marginPlanBeforeZoom=DATY_LAST_COORDINATION;switchPanel('spectrum');});
    await page.getByRole('button',{name:'⤢ 适配设备',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>getSpectrumRangeMHz()),[640.25,644.75]);
    assert.equal(await page.evaluate(()=>DATY_LAST_COORDINATION===marginPlanBeforeZoom),true);
    await page.getByRole('button',{name:'↩ 恢复范围',exact:true}).click();await assertLinked('640.000','690.000');
    assert.equal(await page.evaluate(()=>DATY_LAST_COORDINATION===marginPlanBeforeZoom),true);
    await page.evaluate(()=>switchPanel('planner'));await page.fill('#plannerRangeStart','641.125');
    assert.equal(await page.evaluate(()=>DATY_LAST_COORDINATION),null,'actual planning edits invalidate deployment');
    assert.match(await page.evaluate(()=>{try{DatyPlanningDeployment.preflight();return '';}catch(error){return error.message;}}),/没有有效的本次规划/);
    await page.selectOption('#plannerRange','640000:690000');await assertLinked('640.000','690.000');
    await page.evaluate(()=>fixtureDevices(0));
    async function settled() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
    async function checkLayout(label) {
      await settled();
      const result = await page.evaluate(() => {
        const selectors = ['.content','#panel-planner','.planner-control-card','.planner-result-card','#planResultContent',
          '.planner-table-card','#plannerTableViewport','.planner-control-pane:not([hidden])'];
        const overflow = selectors.map(selector => {
          const e = document.querySelector(selector);
          return {selector,client:[e.clientWidth,e.clientHeight],scroll:[e.scrollWidth,e.scrollHeight]};
        }).filter(e => e.scroll[0] > e.client[0]+1 || e.scroll[1] > e.client[1]+1);
        // Actual GROUP and frequency values must remain fully readable with the new column.
        for (const cell of document.querySelectorAll('#freqTableBody .planner-group-cell,#freqTableBody td:nth-child(5),#freqTableBody .planner-locked-cell')) {
          if (cell.scrollWidth > cell.clientWidth+1) overflow.push({selector:'frequency-cell',text:cell.textContent});
        }
        const panel = document.getElementById('panel-planner').getBoundingClientRect();
        const controls = [...document.querySelectorAll('#panel-planner button,#panel-planner select,#panel-planner textarea,#panel-planner input')]
          .filter(e => e.getClientRects().length && !e.closest('dialog')).map(e => ({id:e.id || e.textContent,rect:e.getBoundingClientRect()}))
          .filter(({rect:r}) => r.bottom > panel.bottom+1 || r.right > panel.right+1 || r.top < panel.top-1);
        return {overflow,controls,pageInfo:document.getElementById('plannerPageInfo').textContent,
          contentOverflow:getComputedStyle(document.querySelector('.content')).overflowY};
      });
      if(result.overflow.length){
        await page.screenshot({path:path.join(screenshots,'overflow.png')});
        console.log('Overflow screenshot: '+screenshots);
        console.log(await page.locator('#plannerConstraints').evaluate(e=>[...e.querySelectorAll(':scope > *, .planner-constraint-grid > *')].map(x=>({class:x.className,height:x.clientHeight,scroll:x.scrollHeight,text:x.textContent.slice(0,45)}))));
      }
      assert.deepEqual(result.overflow, [], label + ' overflow: ' + JSON.stringify(result));
      assert.deepEqual(result.controls, [], label + ' clipped controls');
      assert.equal(result.contentOverflow, 'hidden');
      console.log(label + ': ' + result.pageInfo);
    }
    for (const [width,height] of [[1920,1080],[1366,768],[1280,720],[1024,768],[1024,600]]) {
      await page.setViewportSize({width,height});
      await page.evaluate(() => {fixtureDevices(0);switchPlannerControlTab('basic');});
      await checkLayout(`${width}x${height} empty/basic`);
      await page.getByRole('button',{name:'安全参数',exact:true}).click();
      const safety=await page.locator('#plannerSafetyDialog').evaluate(e=>{
        const r=e.getBoundingClientRect();return {inside:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,
          policy:!!e.querySelector('#plannerImdPolicy'),rootOverflow:document.documentElement.scrollHeight>innerHeight+1};
      });
      assert.deepEqual(safety,{inside:true,policy:true,rootOverflow:false});
      await page.keyboard.press('Escape');
      await page.click('#plannerConstraintsTab');
      await page.fill('#plannerExcludedRanges', '660.000-661.000 电视');
      await page.fill('#plannerKnownCarriers', '670.000,250,对讲');
      await page.fill('#plannerBackupCount', '0');
      await checkLayout(`${width}x${height} constraints`);
      await page.click('#plannerBasicTab');
      assert.equal(await page.inputValue('#plannerExcludedRanges'), '660.000-661.000 电视');
      await page.evaluate(() => fixtureDevices(3));
      await page.selectOption('#plannerRange', '640000:690000');
      await page.click('#plannerConstraintsTab');
      await page.evaluate(()=>{const e=document.getElementById('plannerLockedAssignments');e.value='';e.dispatchEvent(new Event('input'));});
      await page.selectOption('#plannerLockChannel','device:1');await page.fill('#plannerLockNote','主持人');await page.click('#plannerConfirmLock');
      await page.selectOption('#plannerLockChannel','device:2');await page.fill('#plannerLockNote','嘉宾');await page.click('#plannerConfirmLock');
      const visibleLocks = await page.locator('.planner-locked-cell > span:first-child').allTextContents();
      assert.deepEqual(visibleLocks, ['641.000 MHz','642.000 MHz','—'].slice(0,visibleLocks.length));
      await checkLayout(`${width}x${height} live lock values`);
      await page.click('#plannerBasicTab');
      await page.click('.planner-run-button');
      assert.equal(await page.evaluate(() => DATY_LAST_COORDINATION?.retention.retainedCount), 2);
      assert.deepEqual(await page.evaluate(() => DATY_LAST_COORDINATION.assignments.slice().sort((a,b)=>a.deviceId-b.deviceId).map(a=>a.frequencyKHz)),[641000,642000,642250]);
      assert.match(await page.textContent('#planResultContent'), /未导入真实扫描/);
      await checkLayout(`${width}x${height} planned`);
      await page.getByRole('button', {name:'详情 / 限制'}).click();
      assert.equal(await page.locator('#plannerResultDialog').evaluate(e=>e.open),true);
      assert.match(await page.textContent('#plannerDetailContent'), /不等同 WWB6/);
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        document.getElementById('plannerExcludedRanges').value='640.000-690.000 测试全段排除';
        runPlanning();
      });
      assert.match(await page.textContent('#planResultContent'), /方案未完整通过/);
      await checkLayout(`${width}x${height} incomplete plan`);
      await page.evaluate(() => {
        document.getElementById('plannerExcludedRanges').value='660.000-661.000 电视';
        invalidateCoordination('测试长错误详情：' + '设备身份缺失，请核查接收机 IP 和通道号。'.repeat(30));
      });
      assert.ok((await page.textContent('#plannerDetailContent')).length > 500);
      await checkLayout(`${width}x${height} invalidated/long error`);
      await page.evaluate(() => fixtureDevices(32));
      const ids = [];
      do {
        await checkLayout(`${width}x${height} 32CH`);
        const pageIds=await page.locator('#freqTableBody input').evaluateAll(nodes=>nodes.map(e=>Number(e.id.slice(3))));
        assert.deepEqual(await page.locator('.planner-group-cell').allTextContents(),pageIds.map(id=>id>16?'GROUP2':'GROUP10'));
        ids.push(...pageIds);
        if (await page.isDisabled('#plannerNextPage')) break;
        await page.click('#plannerNextPage');
      } while (ids.length < 40);
      assert.deepEqual(ids, [...Array.from({length:16},(_,i)=>i+17),...Array.from({length:16},(_,i)=>i+1)]);
      assert.match(await page.locator('.planner-table-card .section-title').textContent(),/📋 频率分配表\s*（GROUP 升序）/);
      await page.evaluate(() => {fixtureDevices(3);runPlanning();});
      await page.screenshot({path:path.join(screenshots, `${width}x${height}.png`)});
      await assertLinked('640.000','690.000');
      await page.evaluate(()=>switchPanel('spectrum'));
      assert.equal(await page.locator('#specStart').isVisible(),false);assert.equal(await page.locator('#specEnd').isVisible(),false);
      assert.match(await page.locator('#freqAxis').innerText(),/630 MHz[\s\S]*700 MHz/);
      await page.screenshot({path:path.join(screenshots, `spectrum-${width}x${height}.png`)});
      await page.evaluate(()=>switchPanel('planner'));
    }
    await page.setViewportSize({width:1366,height:768});
    await page.evaluate(() => {
      fixtureDevices(4);
      for(const d of DEVICES){d.group_number={1:10,2:2,3:1,4:2}[d.id];d.channel_number={1:1,2:10,3:1,4:2}[d.id];d.ch='CH'+d.channel_number;d.freq={1:640000,2:645000,3:685000,4:670000}[d.id];}
      const locks=document.getElementById('plannerLockedAssignments');locks.value='';locks.dispatchEvent(new Event('input'));
      renderFreqTable(false);
    });
    await page.click('.planner-run-button');
    assert.equal(await page.evaluate(()=>DATY_LAST_COORDINATION.search.complete),true);
    assert.deepEqual(await page.locator('.planner-group-cell').allTextContents(),['GROUP1','GROUP2','GROUP2','GROUP10']);
    assert.deepEqual(await page.locator('#freqTableBody input').evaluateAll(nodes=>nodes.map(e=>e.value)),['640.000','640.250','640.750','641.750']);
    await page.screenshot({path:path.join(screenshots,'planning-group-order.png')});
    await page.evaluate(() => switchPanel('devices'));
    assert.equal(await page.locator('.content').evaluate(e=>e.classList.contains('planner-view')),false);
    await page.evaluate(() => switchPanel('settings'));
    assert.equal(await page.locator('.content').evaluate(e=>e.classList.contains('settings-view')),true);
    assert.deepEqual(commands, [], 'No control endpoint may be called');
    assert.deepEqual(errors, [], 'No page script errors');
    console.log('PASS: layout, numeric GROUP/CH pagination, real planning, details, constraints, navigation; screenshots: ' + screenshots);
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
