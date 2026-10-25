// Isolated synthetic fixtures only: never connects to real APIs/receivers or imports into a user project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {chromium} = require('playwright');
const root = path.join(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'daty-spectrum-envelope-'));
const YELLOW = '#fbbf24', GREEN = '#10b981', PURPLE = '#6366f1';

async function fixture(page, count = 4, range = ['640.000', '643.000']) {
  await page.evaluate(({count, range}) => {
    DEVICES.splice(0, DEVICES.length, ...Array.from({length:count}, (_, i) => ({
      id:i+1, _fasheId:`fixture_receiver_ch${i+1}`, receiver_ip:'192.0.2.1',
      channel_number:i+1, brand:'DATYaudio', model:'DATY-X1', freq:641000+i*250,
      rf:[-40,-55,-65,-45][i%4], muted:false, _online:true, status:'online',
    })));
    document.getElementById('specStart').value = range[0];
    document.getElementById('specEnd').value = range[1];
    document.getElementById('specDeviceEnvelope').checked = true;
    document.getElementById('specCurveMode').value = 'envelope';
    updateRangeDisplay(false);
    drawSpectrum();
  }, {count,range});
}

async function paint(page) {
  return page.evaluate(() => window.spectrumPaint);
}
function envelope(paints) {
  return paints.filter(p => p.op === 'stroke' && p.color === YELLOW);
}
function circles(paints, color = GREEN) {
  return paints.filter(p => p.op === 'fill' && p.color === color && p.path.some(v => v[0] === 'arc'));
}
async function noOverflow(page, label) {
  const layout = await page.evaluate(() => {
    const selectors = ['html','body','.main','.content','#panel-spectrum'];
    return selectors.flatMap(selector => {
      const el = document.querySelector(selector);
      if (!el) return [];
      const bounds = el.getBoundingClientRect(), css = getComputedStyle(el);
      return [{selector, sw:el.scrollWidth, cw:el.clientWidth, sh:el.scrollHeight,
        ch:el.clientHeight, right:bounds.right, bottom:bounds.bottom,
        overflowY:css.overflowY, width:innerWidth, height:innerHeight}];
    });
  });
  for (const el of layout) {
    assert.ok(el.sw <= el.cw + 2, `${label}: ${el.selector} horizontal overflow ${JSON.stringify(el)}`);
    assert.ok(el.sh <= el.ch + 2, `${label}: ${el.selector} vertical overflow ${JSON.stringify(el)}`);
    assert.ok(el.right <= el.width + 2 && el.bottom <= el.height + 2,
      `${label}: ${el.selector} outside viewport ${JSON.stringify(el)}`);
  }
}

(async () => {
  const browser = await chromium.launch({headless:true,
    executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  try {
    for (const scenario of [{width:1920,height:1080,dpr:1},{width:1366,height:768,dpr:1},{width:1024,height:768,dpr:1},{width:1024,height:600,dpr:1},{width:1366,height:768,dpr:2}]) {
      const context = await browser.newContext({viewport:{width:scenario.width,height:scenario.height},deviceScaleFactor:scenario.dpr});
      const page = await context.newPage(), errors = [], controls = [], mutations = [];
      page.on('pageerror', e => errors.push(e.message));
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname === '/api/command') controls.push(request.postData());
        if (!['GET','HEAD'].includes(request.method())) mutations.push({path:url.pathname,method:request.method()});
        if (request.method() === 'GET' && url.origin === 'https://localhost:8080'
          && (url.pathname === '/unirf-app.html' || /^\/src\/.*\.(css|js)$/.test(url.pathname))) {
          return route.fulfill({path:path.join(root,url.pathname)});
        }
        return route.fulfill({json:{status:'ok',success:true,devices:[],projects:[],events:[],
          ip:'127.0.0.1',project:{id:'isolated-spectrum-fixture'}}});
      });
      await context.addInitScript(() => {
        window.setInterval = () => 0;
        window.EventSource = class extends EventTarget {close(){}};
        window.WebSocket = class extends EventTarget {close(){} send(){throw Error('Receiver controls forbidden');}};
        window.spectrumPaint = [];
        const paths = new WeakMap();
        for (const name of ['beginPath','moveTo','lineTo','arc','closePath','clearRect','stroke','fill','fillRect','strokeRect']) {
          const original = CanvasRenderingContext2D.prototype[name];
          CanvasRenderingContext2D.prototype[name] = function(...args) {
            if (this.canvas.id === 'spectrumCanvas') {
              if (name === 'clearRect') window.spectrumPaint = [];
              else if (name === 'beginPath') paths.set(this,[]);
              else if (['moveTo','lineTo','arc','closePath'].includes(name)) {
                if (!paths.has(this)) paths.set(this,[]);
                paths.get(this).push([name,...args]);
              } else window.spectrumPaint.push({op:name,
                color:String(name.startsWith('stroke') ? this.strokeStyle : this.fillStyle),
                path:(paths.get(this)||[]).map(item=>[...item])});
            }
            return original.apply(this,args);
          };
        }
      });
      await page.goto('https://localhost:8080/unirf-app.html');
      await page.evaluate(() => {
        window.notify = () => {};
        window.getFasheRealtimeStatus = () => ({connected:true,lastUpdateAt:Date.UTC(2026,8,10,12,0,0)});
        switchPanel('spectrum');
      });
      const toggle = page.locator('#specDeviceEnvelope');
      await toggle.waitFor({state:'visible'});
      assert.equal(await toggle.isChecked(),true,'RF envelope enabled initially');
      const startMutations = mutations.length;

      for (const count of [4,50]) {
        await fixture(page,count);
        await page.getByRole('button',{name:'⤢ 适配设备',exact:true}).click();
        const current = await paint(page), trace = envelope(current);
        assert.equal(trace.length,1,'one yellow envelope is painted');
        assert.ok(trace[0].path.length>count*12,'continuous full-span sampled trace');
        assert.equal(circles(current).length,count,'all valid green device points remain');
        assert.equal(current.filter(p=>p.op==='stroke' && /^(#10b981|rgba\(16, 185, 129,)/.test(p.color)).length,count,'all green stems remain');
        assert.equal(current.filter(p=>p.op==='stroke' && p.color===PURPLE).length,0,'no fabricated scan');
        assert.deepEqual(await page.evaluate(()=>getCurrentScanPoints()),[],'envelope is not scan input');
        const plot = await page.locator('#spectrumCanvas').boundingBox();
        const positions = circles(current).map(p=>p.path.find(v=>v[0]==='arc')[1]);
        positions.forEach((x,i) => assert.ok(Math.abs(x-(i+.5)*Math.round(plot.width)/count)<1.1,
          `fit places CH${i+1} at its frequency on equally spaced axis`));
        assert.match(await page.locator('#deviceEnvelopeState').innerText(),/示意|非实测/);
        const visibleText = await page.locator('#panel-spectrum').innerText();
        assert.match(visibleText,/峰宽|带宽/); assert.match(visibleText,/[-−]90/);
        assert.match(visibleText,/噪底/); assert.match(visibleText,/规划/);
        await noOverflow(page,`${scenario.width}/${scenario.dpr}/${count}`);
        await page.locator('#panel-spectrum').screenshot({path:path.join(output,
          `${scenario.width}-${count}ch-dpr${scenario.dpr}-device-envelope.png`)});
      }

      // Real-time frequency/RF changes move only their visible depiction; mute is audio-only.
      await fixture(page,1,['640.000','642.000']);
      const initial = envelope(await paint(page));
      await page.evaluate(()=>{DEVICES[0].muted=true;DEVICES[0].status='muted';drawSpectrum();});
      assert.deepEqual(envelope(await paint(page)),initial,'mute cannot alter RF envelope');
      await page.evaluate(()=>{DEVICES[0].freq=641500;forceRefreshAllPanels({realtime:true,alertsEvaluated:true});});
      const moved = envelope(await paint(page));
      assert.notDeepEqual(moved,initial,'frequency telemetry moves yellow peak');
      let deviceCircle = circles(await paint(page))[0].path.find(v=>v[0]==='arc');
      let plot = await page.locator('#spectrumCanvas').boundingBox();
      assert.ok(Math.abs(deviceCircle[1] - Math.round(plot.width)*.75)<1);
      await page.evaluate(()=>{DEVICES[0].rf=-70;forceRefreshAllPanels({realtime:true,alertsEvaluated:true});});
      assert.notDeepEqual(envelope(await paint(page)),moved,'RF telemetry updates yellow amplitude');
      deviceCircle = circles(await paint(page))[0].path.find(v=>v[0]==='arc');
      assert.ok(Math.abs(deviceCircle[2]-Math.round(plot.height)*.7)<1);

      // Duplicate frequency combines by max, does not pretend receiver RSSIs are additive powers.
      const oneDevice = envelope(await paint(page));
      await page.evaluate(()=>{DEVICES.push({...DEVICES[0],id:2,_fasheId:'fixture_receiver_ch2',channel_number:2,rf:-80});drawSpectrum();});
      assert.deepEqual(envelope(await paint(page)),oneDevice,'lower co-channel RSSI must not raise peak');
      assert.equal(circles(await paint(page)).length,2,'co-channel device markers remain individually rendered');
      await page.evaluate(()=>{DEVICES[1].rf=-35;drawSpectrum();});
      assert.notDeepEqual(envelope(await paint(page)),oneDevice,'stronger co-channel RSSI raises peak');
      await page.evaluate(()=>{DEVICES[0]._online=false;DEVICES[1]._online=false;drawSpectrum();});
      assert.equal(envelope(await paint(page)).length,0,'no yellow waveform with only offline devices');
      assert.equal(circles(await paint(page)).length,0);

      // Unknown RF has no invented -90 peak; marker remains known-frequency/gray/unknown tooltip.
      await fixture(page,1,['640.000','642.000']);
      for (const rf of [null,'',true,-151,21]) {
        await page.evaluate(rf=>{DEVICES[0].rf=rf;drawSpectrum();},rf);
        assert.equal(envelope(await paint(page)).length,0,'invalid RF contributes no envelope');
        assert.equal(circles(await paint(page)).length,0,'invalid RF is not painted green');
      }
      const unknown = (await paint(page)).filter(p=>p.op==='fill'&&p.path.some(v=>v[0]==='arc'));
      assert.equal(unknown.length,1,'valid frequency with unknown RF remains available');
      plot = await page.locator('#spectrumCanvas').boundingBox();
      await page.mouse.move(plot.x+plot.width/2,plot.y+plot.height-2);
      await page.locator('#spectrumPointTooltip').waitFor({state:'visible'});
      assert.match(await page.locator('#spectrumPointTooltip').innerText(),/CH1.*641\.000 MHz.*RF.*未知/);

      // Visual option must never invalidate or mutate imported scans, devices, or coordination state.
      await fixture(page,4,['640.000','643.000']);
      await page.evaluate(()=>{
        const synthetic = Array.from({length:181},(_,i)=>({frequencyKHz:640000+i*25,
          levelDbm:-78+Math.sin(i*.31)*2+28*Math.exp(-(((i-56)/8)**2))}));
        setImportedScanPoints(synthetic,'合成 CSV（隔离测试，非现场数据）');
      });
      const scanBefore = await page.evaluate(()=>JSON.stringify(getCurrentScanPoints()));
      const devicesBefore = await page.evaluate(()=>JSON.stringify(DEVICES));
      await page.evaluate(()=>{window.spectrumTestInvalidations=[];window.invalidateCoordination=(reason)=>window.spectrumTestInvalidations.push(reason);});
      const combined = await paint(page);
      assert.equal(envelope(combined).length,1);
      assert.equal(combined.filter(p=>p.op==='stroke'&&p.color===PURPLE).length,1,'real imported series independent');
      const csvPaint = combined.filter(p=>p.op==='stroke'&&p.color===PURPLE);
      await toggle.uncheck();
      assert.equal(envelope(await paint(page)).length,0,'toggle removes only yellow layer');
      assert.deepEqual((await paint(page)).filter(p=>p.op==='stroke'&&p.color===PURPLE),csvPaint);
      assert.equal(circles(await paint(page)).length,4);
      await toggle.check();
      assert.equal(envelope(await paint(page)).length,1);
      assert.equal(await page.evaluate(()=>JSON.stringify(getCurrentScanPoints())),scanBefore);
      assert.equal(await page.evaluate(()=>JSON.stringify(DEVICES)),devicesBefore);
      assert.deepEqual(await page.evaluate(()=>window.spectrumTestInvalidations),[]);
      assert.match(await page.locator('#scanDataState').innerText(),/181/);
      await page.mouse.move(0,0);
      await noOverflow(page,`${scenario.width}/${scenario.dpr}/csv`);
      await page.locator('#panel-spectrum').screenshot({path:path.join(output,
        `${scenario.width}-4ch-dpr${scenario.dpr}-synthetic-csv-and-envelope.png`)});

      // Manual range retains a real frequency mapping and filters out-of-range centers.
      await page.evaluate(()=>{
        document.getElementById('specStart').value='641.200';
        document.getElementById('specEnd').value='641.550';
        updateRangeDisplay(false);drawSpectrum();
      });
      assert.equal(circles(await paint(page)).length,2);
      assert.equal(envelope(await paint(page)).length,1);
      assert.equal(await page.evaluate(()=>JSON.stringify(getCurrentScanPoints())),scanBefore);
      assert.equal(await page.evaluate(()=>JSON.stringify(DEVICES)),devicesBefore);
      assert.deepEqual(errors,[]);
      assert.deepEqual(controls,[]);
      assert.equal(mutations.length,startMutations,'no backend/project write from presentation changes');
      console.log(JSON.stringify({...scenario,assertions:'PASS',screenshots:output}));
      await context.close();
    }
    console.log('PASS: isolated envelope paint/telemetry/mute/offline/unknown/co-channel/CSV separation/toggle/range/layout/DPR. Screenshots: '+output);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
