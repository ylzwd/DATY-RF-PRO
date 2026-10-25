// Synthetic browser fixtures only. All APIs/sockets are isolated; never controls receivers or saves a live project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {chromium} = require('playwright');
const root = path.join(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'daty-rf-simulation-'));
const YELLOW = '#fbbf24', GREEN = '#10b981', PURPLE = '#6366f1';

async function fixture(page, count=4, range=['640.000','643.000']) {
  await page.evaluate(({count,range})=>{
    DEVICES.splice(0,DEVICES.length,...Array.from({length:count},(_,i)=>({
      id:i+1,_fasheId:`fixture_receiver_ch${i+1}`,receiver_ip:'192.0.2.1',
      channel_number:i+1,brand:'DATYaudio',model:'DATY-X1',freq:641000+i*250,
      rf:[-35,-40,-65,-45][i%4],af:-20,muted:false,_online:true,status:'online',
    })));
    document.getElementById('specStart').value=range[0];
    document.getElementById('specEnd').value=range[1];
    document.getElementById('specDeviceEnvelope').checked=true;
    document.getElementById('specCurveMode').value='simulation';
    updateRangeDisplay(false);drawSpectrum();
  },{count,range});
}
const paint = page=>page.evaluate(()=>window.spectrumPaint);
const yellow = paints=>paints.filter(p=>p.op==='stroke'&&p.color===YELLOW);
const circles = paints=>paints.filter(p=>p.op==='fill'&&p.color===GREEN&&p.path.some(v=>v[0]==='arc'));
const scanLine = paints=>paints.filter(p=>p.op==='stroke'&&p.color===PURPLE);
const rangeFills = paints=>paints.filter(p=>p.op==='fillRect'&&/^rgba\((245, 158, 11|96, 165, 250),/.test(p.color));
const simulation = page=>page.evaluate(()=>{
  const start=Number(document.getElementById('specStart').value),end=Number(document.getElementById('specEnd').value);
  return window.DatyRfSimulationView.get(DEVICES,start,end);
});

async function noOverflow(page,label) {
  const layout=await page.evaluate(()=>['html','body','.main','.content','#panel-spectrum'].map(selector=>{
    const el=document.querySelector(selector),b=el.getBoundingClientRect();
    return {selector,sw:el.scrollWidth,cw:el.clientWidth,sh:el.scrollHeight,ch:el.clientHeight,
      right:b.right,bottom:b.bottom,w:innerWidth,h:innerHeight};
  }));
  if(layout.some(e=>e.sw>e.cw+2||e.sh>e.ch+2||e.right>e.w+2||e.bottom>e.h+2)) {
    const file=path.join(output,'overflow-'+label.replace(/[^a-z0-9_-]/gi,'-')+'.png');
    await page.screenshot({path:file});
    const details=await page.locator('#panel-spectrum').evaluate(el=>[el,...el.children].map(node=>{
      const r=node.getBoundingClientRect();return {tag:node.tagName,className:node.className,id:node.id,
        top:r.top,bottom:r.bottom,height:r.height,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight};
    }));
    console.error(JSON.stringify({layoutFailure:label,screenshot:file,details}));
  }
  for(const e of layout) {
    assert.ok(e.sw<=e.cw+2,`${label}: horizontal overflow ${JSON.stringify(e)}`);
    assert.ok(e.sh<=e.ch+2,`${label}: vertical overflow ${JSON.stringify(e)}`);
    assert.ok(e.right<=e.w+2&&e.bottom<=e.h+2,`${label}: outside viewport ${JSON.stringify(e)}`);
  }
}
async function settings(page,values={},apply=true) {
  await page.getByRole('button',{name:'仿真设置',exact:true}).click();
  const dialog=page.locator('#rfSimulationSettings');
  await dialog.waitFor({state:'visible'});
  for(const [key,value] of Object.entries(values)) {
    if(key==='simImdMode')await dialog.locator('#'+key).selectOption(String(value));
    else await dialog.locator('#'+key).fill(String(value));
  }
  if(apply) {
    await dialog.locator('#applyRfSimulationSettings').click();
    await dialog.waitFor({state:'hidden'});
  }
  return dialog;
}

(async()=>{
  const browser=await chromium.launch({headless:true,
    executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  try {
    for(const scenario of [{width:1366,height:768,dpr:1},{width:1024,height:600,dpr:1},{width:1366,height:768,dpr:2}]) {
      const context=await browser.newContext({viewport:{width:scenario.width,height:scenario.height},deviceScaleFactor:scenario.dpr});
      const page=await context.newPage(),errors=[],controls=[],mutations=[];
      page.on('pageerror',e=>errors.push(e.message));
      await context.route('**/*',route=>{
        const r=route.request(),u=new URL(r.url());
        if(u.pathname==='/api/command')controls.push(r.postData());
        if(!['GET','HEAD'].includes(r.method()))mutations.push({path:u.pathname,method:r.method()});
        if(r.method()==='GET'&&u.origin==='https://localhost:8080'
          &&(u.pathname==='/unirf-app.html'||u.pathname==='/DATYlogo.png'||/^\/src\/.*\.(css|js|png)$/.test(u.pathname)))
          return route.fulfill({path:path.join(root,u.pathname)});
        return route.fulfill({json:{status:'ok',success:true,devices:[],projects:[],events:[],ip:'127.0.0.1',project:{id:'isolated-rf-simulation'}}});
      });
      await context.addInitScript(()=>{
        window.setInterval=()=>0;
        window.EventSource=class extends EventTarget{close(){}};
        window.WebSocket=class extends EventTarget{close(){}send(){throw Error('Receiver controls forbidden');}};
        window.spectrumPaint=[];
        const paths=new WeakMap();
        for(const name of ['beginPath','moveTo','lineTo','arc','closePath','clearRect','stroke','fill','fillRect','strokeRect']) {
          const original=CanvasRenderingContext2D.prototype[name];
          CanvasRenderingContext2D.prototype[name]=function(...args){
            if(this.canvas.id==='spectrumCanvas') {
              if(name==='clearRect')window.spectrumPaint=[];
              else if(name==='beginPath')paths.set(this,[]);
              else if(['moveTo','lineTo','arc','closePath'].includes(name)) {
                if(!paths.has(this))paths.set(this,[]);paths.get(this).push([name,...args]);
              } else window.spectrumPaint.push({op:name,color:String(name.startsWith('stroke')?this.strokeStyle:this.fillStyle),
                args:[...args],path:(paths.get(this)||[]).map(v=>[...v])});
            }
            return original.apply(this,args);
          };
        }
      });
      await page.goto('https://localhost:8080/unirf-app.html');
      await page.evaluate(()=>{
        window.notify=()=>{};
        window.getFasheRealtimeStatus=()=>({connected:true,lastUpdateAt:Date.UTC(2026,8,10,12)});
        switchPanel('spectrum');
      });
      await page.locator('#specCurveMode').waitFor({state:'visible'});
      assert.equal(await page.locator('#specCurveMode').inputValue(),'simulation');
      const startMutations=mutations.length;

      for(const count of [4,50]) {
        await fixture(page,count);
        await page.getByRole('button',{name:'⤢ 适配设备',exact:true}).click();
        const paintings=await paint(page),model=await simulation(page);
        assert.equal(yellow(paintings).length,1,'one yellow simulation curve');
        assert.ok(model.points.length>count*5,'curve includes sampled spectrum');
        assert.equal(circles(paintings).length,count,'all green receiver markers remain');
        assert.equal(scanLine(paintings).length,0,'simulation does not fabricate a scan layer');
        assert.deepEqual(await page.evaluate(()=>getCurrentScanPoints()),[]);
        assert.ok(model.ranges.length>0,'carrier threshold zones are calculated');
        assert.ok(model.guardRanges.length>0,'Profile coordination guards are calculated');
        assert.equal(rangeFills(paintings).length,model.possibleRanges.length+model.ranges.length+model.guardRanges.length,'all possible/smooth/Profile spans are actually painted');
        assert.match(await page.locator('#panel-spectrum').innerText(),/仿真/);
        assert.match(await page.locator('#panel-spectrum').innerText(),/假设.*需扫描校准|非实测|不代表实测|情景假设.*不能预测实际互调功率/);
        const first=yellow(paintings);
        await page.evaluate(()=>drawSpectrum());
        assert.deepEqual(yellow(await paint(page)),first,'fixed inputs do not animate artificial flicker');
        await noOverflow(page,`${scenario.width}/${scenario.dpr}/${count}ch`);
        await page.locator('#panel-spectrum').screenshot({path:path.join(output,`${scenario.width}-${count}ch-dpr${scenario.dpr}.png`)});
      }

      // Parameter changes are applied only on confirmation and are independent from coordination/scan data.
      await fixture(page,2,['640.000','642.000']);
      await page.locator('#panel-spectrum').screenshot({path:path.join(output,`${scenario.width}-2ch-visible-imd-dpr${scenario.dpr}.png`)});
      const hover=await page.evaluate(()=>{
        const canvas=document.getElementById('spectrumCanvas'),b=canvas.getBoundingClientRect(),state=spectrumPointHoverStates.get(canvas);
        const point=state.simulation.result.points.find(p=>p.frequencyKHz===640750);
        return {x:b.x+b.width*.375,y:b.y+(1-_scanDbmToNormalized(point.levelDbm)*.9)*b.height,
          guardY:b.bottom-2,greenX:b.x+b.width*.5,greenY:b.y+(1-_scanDbmToNormalized(-35)*.9)*b.height};
      });
      await page.mouse.move(hover.x,hover.y);
      await page.locator('#spectrumPointTooltip').waitFor({state:'visible'});
      assert.match(await page.locator('#spectrumPointTooltip').innerText(),/仿真 640\.750 MHz.*≈.*dBm/s);
      assert.match(await page.locator('#spectrumPointTooltip').innerText(),/超阈范围.*MHz.*(?:建议|保守)避让/s);
      await page.mouse.move(hover.x,hover.guardY);
      assert.match(await page.locator('#spectrumPointTooltip').innerText(),/(?:建议|保守)避让/,'bottom band has range hover');
      await page.mouse.move(hover.greenX,hover.greenY);
      assert.equal(await page.locator('#spectrumPointTooltip').innerText(),'CH1 · 641.000 MHz','real green marker wins over simulation');
      await page.mouse.move(0,0);
      await page.evaluate(()=>{window.rfSimulationInvalidations=[];window.invalidateCoordination=reason=>window.rfSimulationInvalidations.push(reason);});
      const devicesBefore=await page.evaluate(()=>JSON.stringify(DEVICES));
      const defaults=await simulation(page);
      let dialog=await settings(page,{},false);
      for(const [id,value] of Object.entries({simPeakWidth:'100',simFloor:'-88',simRipple:'2',simTextureStep:'5',simThreshold:'-75',simSuppression:'30',simImdMode:'3-full'}))
        assert.equal(await dialog.locator('#'+id).inputValue(),value,`documented default ${id}`);
      await dialog.locator('#simPeakWidth').fill('180');
      await dialog.getByRole('button',{name:'取消',exact:true}).click();

      dialog=await settings(page,{simFloor:'-70'},false);
      await dialog.locator('#applyRfSimulationSettings').click();
      assert.equal(await dialog.isVisible(),true,'noise floor above threshold is invalid');
      assert.match(await dialog.locator('#rfSimulationSettingsError').innerText(),/阈值/);
      assert.deepEqual(await simulation(page),defaults,'invalid combined assumptions cannot replace accepted settings');
      await dialog.getByRole('button',{name:'取消',exact:true}).click();
      assert.deepEqual(await simulation(page),defaults,'cancel does not change simulation');

      dialog=await settings(page,{simPeakWidth:'-1'},false);
      await dialog.locator('#applyRfSimulationSettings').click();
      assert.equal(await dialog.isVisible(),true,'invalid peak width keeps settings open');
      assert.ok(await dialog.evaluate(el=>el.querySelector(':invalid')!==null||!!el.querySelector('[role="alert"]')?.textContent?.trim()),'invalid input exposes validation feedback');
      assert.deepEqual(await simulation(page),defaults,'invalid settings cannot enter model');
      await dialog.getByRole('button',{name:'取消',exact:true}).click();

      await settings(page,{simImdMode:'off'});
      const off=await simulation(page);
      assert.equal(off.products.length,0,'off hides all IMD predictions');
      await settings(page,{simImdMode:'3'});
      const third=await simulation(page);
      assert.ok(third.products.length>0,'third-order predictions exist');
      assert.notDeepEqual(third.points,off.points,'visible IMD products affect simulation');
      await settings(page,{simImdMode:'3+5'});
      const fifth=await simulation(page);
      assert.ok(fifth.products.length>third.products.length,'fifth order adds candidates');
      await settings(page,{simSuppression:'50'});
      const suppressed=await simulation(page);
      assert.notDeepEqual(suppressed.points,fifth.points,'suppression adjusts predicted IMD levels');

      await settings(page,{simImdMode:'off',simSuppression:'30',simPeakWidth:'100'});
      const narrow=await simulation(page);
      await settings(page,{simPeakWidth:'180'});
      const broad=await simulation(page);
      assert.notDeepEqual(broad.ranges,narrow.ranges,'spectral width changes threshold spans');
      assert.deepEqual(broad.guardRanges,narrow.guardRanges,'bandwidth never redefines brand minimum spacing');
      await settings(page,{simThreshold:'-55'});
      assert.notDeepEqual((await simulation(page)).ranges,broad.ranges,'threshold changes calculated spans');
      await settings(page,{simPeakWidth:'100',simThreshold:'-75',simImdMode:'3-full'});
      assert.deepEqual(await simulation(page),defaults,'restoring settings reproduces identical model');
      await settings(page,{simFloor:'-92'});
      assert.notDeepEqual((await simulation(page)).points,defaults.points,'floor setting changes inter-peak noise');
      await settings(page,{simFloor:'-88'});
      assert.equal(await page.evaluate(()=>JSON.stringify(DEVICES)),devicesBefore,'settings never mutate receiver telemetry');

      // Details remain a readable MHz result, never an instruction sent to a receiver.
      await page.getByRole('button',{name:'范围明细',exact:true}).click();
      const ranges=page.locator('#rfSimulationRanges');
      await ranges.waitFor({state:'visible'});
      assert.match(await ranges.innerText(),/MHz/);
      assert.match(await ranges.innerText(),/641\./);
      assert.match(await ranges.innerText(),/IMD|互调/);
      await ranges.screenshot({path:path.join(output,`${scenario.width}-2ch-ranges-dpr${scenario.dpr}.png`)});
      await page.keyboard.press('Escape');
      await ranges.waitFor({state:'hidden'});

      // Three distinct source frequencies produce extra third-order products that two-tone cannot predict.
      await fixture(page,3,['636.000','646.000']);
      await page.evaluate(()=>{
        DEVICES.forEach((d,i)=>{d.freq=[640000,641000,644000][i];d.rf=-35;});
        drawSpectrum();
      });
      await settings(page,{simImdMode:'3'});
      const twoTone=await simulation(page);
      for(const frequencyKHz of [637000,643000,645000])
        assert.equal(twoTone.products.some(p=>p.frequencyKHz===frequencyKHz),false,'independent two-tone fixture excludes '+frequencyKHz);
      await settings(page,{simImdMode:'3-full'});
      const threeTone=await simulation(page);
      assert.equal(threeTone.options.includeThreeTone,true);
      for(const frequencyKHz of [637000,643000,645000]) {
        const product=threeTone.products.find(p=>p.frequencyKHz===frequencyKHz&&p.kind==='three-tone');
        assert.ok(product,'three-tone candidate '+frequencyKHz);
        assert.deepEqual(product.sourceFrequenciesKHz,[640000,641000,644000]);
        assert.equal(product.order,3);
      }
      await page.getByRole('button',{name:'范围明细',exact:true}).click();
      const threeRanges=page.locator('#rfSimulationRanges');
      await threeRanges.waitFor({state:'visible'});
      const threeText=await threeRanges.innerText();
      for(const pattern of [/双频/,/三频/,/来源/,/637\.000/,/643\.000/,/645\.000/,/640\.000/,/641\.000/,/644\.000/])
        assert.match(threeText,pattern,'range details expose actual IMD family and source frequencies');
      const sourceRows=threeRanges.locator('.rf-simulation-table-wrap').last().locator('tbody tr');
      for(const frequency of ['637.000','643.000','645.000']) {
        const row=sourceRows.filter({hasText:frequency});
        assert.equal(await row.count(),1,'unique three-tone detail for '+frequency);
        assert.match(await row.innerText(),/3阶.*三频.*640\.000.*641\.000.*644\.000/s,'source row belongs to the correct IMD candidate');
      }
      await threeRanges.screenshot({path:path.join(output,`${scenario.width}-3tone-ranges-dpr${scenario.dpr}.png`)});
      await threeRanges.getByRole('heading',{name:/互调候选频点/}).scrollIntoViewIfNeeded();
      await threeRanges.screenshot({path:path.join(output,`${scenario.width}-3tone-sources-dpr${scenario.dpr}.png`)});
      await page.keyboard.press('Escape');
      await settings(page,{simImdMode:'3-full+5'});
      const fullFifth=await simulation(page);
      assert.equal(fullFifth.options.includeThreeTone,true);
      assert.ok(fullFifth.products.some(p=>p.order===5));
      assert.ok(fullFifth.products.some(p=>p.kind==='three-tone'));
      await settings(page,{simImdMode:'3-full'});

      // Texture density is a frequency-domain assumption, independent of spacing/threshold boundaries.
      const fineTexture=await simulation(page);
      await settings(page,{simTextureStep:'25'});
      const coarseTexture=await simulation(page);
      assert.equal(coarseTexture.options.textureStepKHz,25);
      assert.notDeepEqual(coarseTexture.points,fineTexture.points,'texture scale changes repeatable serration');
      assert.deepEqual(coarseTexture.guardRanges,fineTexture.guardRanges,'texture density does not change Profile guards');
      assert.deepEqual(coarseTexture.ranges,fineTexture.ranges,'texture scale does not move smooth threshold boundaries');
      const coarsePaint=yellow(await paint(page));
      await page.evaluate(()=>drawSpectrum());
      assert.deepEqual(yellow(await paint(page)),coarsePaint,'new texture scale does not animate on redraw');
      assert.ok(coarseTexture.possibleRanges.length>0,'possible threshold region remains exposed');
      dialog=await settings(page,{simTextureStep:'0'},false);
      await dialog.locator('#applyRfSimulationSettings').click();
      assert.equal(await dialog.isVisible(),true,'zero texture scale is rejected');
      await dialog.getByRole('button',{name:'取消',exact:true}).click();
      assert.deepEqual(await simulation(page),coarseTexture,'invalid texture scale preserves last accepted model');
      await settings(page,{simTextureStep:'5'});

      // Missing RF does not erase known carriers/IMD locations, and must never become 0 dBm peaks.
      await page.evaluate(()=>{DEVICES.forEach(d=>{d.rf=null;});drawSpectrum();});
      const unknownRf=await simulation(page);
      assert.equal(unknownRf.stats.missingRfCount,3);
      assert.equal(unknownRf.points.length,0);
      assert.equal(yellow(await paint(page)).length,0,'unknown RF cannot fabricate a yellow spectrum');
      assert.ok(unknownRf.guardRanges.length>0,'known frequency locations retain coordination guards');
      for(const frequencyKHz of [637000,643000,645000]) {
        const product=unknownRf.products.find(p=>p.frequencyKHz===frequencyKHz&&p.kind==='three-tone');
        assert.ok(product);assert.equal(product.peakDbm,null);
      }
      await page.getByRole('button',{name:'范围明细',exact:true}).click();
      const unknownRanges=page.locator('#rfSimulationRanges');
      await unknownRanges.waitFor({state:'visible'});
      const unknownText=await unknownRanges.innerText();
      assert.match(unknownText,/未知/,'missing levels are labelled unknown');
      assert.match(unknownText,/637\.000/,'unknown strength retains mathematical candidate');
      await page.keyboard.press('Escape');

      // A mixed-brand scene applies its most conservative Profile guard to every source.
      await page.evaluate(()=>{
        DEVICES.forEach(d=>{d.rf=-35;});
        DEVICES[2].brand='Shure';DEVICES[2].model='ULX-D';DEVICES[2].equipmentModeId='robust';
        drawSpectrum();
      });
      const mixed=await simulation(page);
      assert.equal(mixed.guardPolicy.kind,'scene-conservative');
      assert.equal(mixed.guardPolicy.channelSpacingKHz,500);
      assert.equal(mixed.guardPolicy.intermodSpacingKHz,350);
      await page.getByRole('button',{name:'范围明细',exact:true}).click();
      const mixedRanges=page.locator('#rfSimulationRanges');
      await mixedRanges.waitFor({state:'visible'});
      assert.match(await mixedRanges.innerText(),/全场.*(保守|最大)/,'mixed-brand guard policy is visible');
      assert.match(await mixedRanges.innerText(),/500.*kHz|0\.500.*MHz/);
      await noOverflow(page,`${scenario.width}/${scenario.dpr}/mixed-details`);
      await page.keyboard.press('Escape');
      await fixture(page,2,['640.000','642.000']);

      // Source-level texture is frequency anchored; zooming cannot change the value at an existing sample.
      const wide=await simulation(page);
      await page.evaluate(()=>{document.getElementById('specStart').value='640.500';document.getElementById('specEnd').value='641.700';updateRangeDisplay(false);drawSpectrum();});
      const zoomed=await simulation(page),wideLevels=new Map(wide.points.map(p=>[p.frequencyKHz,p.levelDbm]));
      const shared=zoomed.points.filter(p=>wideLevels.has(p.frequencyKHz));
      assert.ok(shared.length>=2,'zoom shares carrier/frequency-grid samples');
      for(const p of shared)assert.ok(Math.abs(p.levelDbm-wideLevels.get(p.frequencyKHz))<1e-7,'zoom must not regenerate source-level noise');

      // Receiver telemetry updates frequency/RF promptly; AF/mute are unrelated to the RF simulation.
      await fixture(page,2,['640.000','642.000']);
      const initial=await simulation(page);
      await page.evaluate(()=>{window.rfSimulationCached=DatyRfSimulationView.get(DEVICES,640,642);});
      await page.evaluate(()=>{DEVICES[0].muted=true;DEVICES[0].status='muted';DEVICES[0].af=-40;forceRefreshAllPanels({realtime:true,alertsEvaluated:true});});
      assert.deepEqual(await simulation(page),initial,'audio state cannot modify RF curve');
      assert.equal(await page.evaluate(()=>DatyRfSimulationView.get(DEVICES,640,642)===window.rfSimulationCached),true,'AF/mute reuse computed model');
      await page.evaluate(()=>{DEVICES[0].freq=641500;forceRefreshAllPanels({realtime:true,alertsEvaluated:true});});
      const moved=await simulation(page);
      assert.notDeepEqual(moved.points,initial.points,'frequency telemetry recomputes curve');
      await page.evaluate(()=>{DEVICES[0].rf=-70;forceRefreshAllPanels({realtime:true,alertsEvaluated:true});});
      assert.notDeepEqual((await simulation(page)).points,moved.points,'RF telemetry recomputes curve height');
      await page.evaluate(()=>{DEVICES.forEach(d=>d._online=false);drawSpectrum();});
      assert.equal(yellow(await paint(page)).length,0,'no synthetic noise is painted without valid live RF');

      // A real imported scan keeps its own data and purple rendering when changing simulation presentation.
      await fixture(page,4,['640.000','643.000']);
      assert.deepEqual(await page.evaluate(()=>window.rfSimulationInvalidations),[],'simulation parameters never invalidate coordination');
      await page.evaluate(()=>setImportedScanPoints(Array.from({length:121},(_,i)=>({frequencyKHz:640000+i*25,levelDbm:-80+Math.sin(i*.31)*2})),'隔离合成 CSV'));
      await page.evaluate(()=>{window.rfSimulationInvalidations=[];});
      const scanBefore=await page.evaluate(()=>JSON.stringify(getCurrentScanPoints()));
      const csvPaint=scanLine(await paint(page));
      assert.equal(csvPaint.length,1);
      await page.locator('#specDeviceEnvelope').uncheck();
      assert.equal(yellow(await paint(page)).length,0);
      assert.equal(rangeFills(await paint(page)).length,0,'hidden yellow view also hides simulated regions');
      await page.getByRole('button',{name:'范围明细',exact:true}).click();
      assert.equal(await page.locator('#rfSimulationRanges').count(),0,'hidden mode cannot expose stale simulation ranges');
      assert.deepEqual(scanLine(await paint(page)),csvPaint);
      assert.equal(circles(await paint(page)).length,4);
      await page.locator('#specDeviceEnvelope').check();
      await page.locator('#specCurveMode').selectOption('envelope');
      assert.equal(yellow(await paint(page)).length,1,'previous smooth view remains available');
      assert.equal(rangeFills(await paint(page)).length,0,'smooth illustration mode cannot display simulation-specific regions');
      await page.getByRole('button',{name:'范围明细',exact:true}).click();
      assert.equal(await page.locator('#rfSimulationRanges').count(),0,'smooth mode cannot expose stale simulation ranges');
      assert.deepEqual(scanLine(await paint(page)),csvPaint);
      await page.locator('#specCurveMode').selectOption('simulation');
      assert.equal(yellow(await paint(page)).length,1);
      assert.equal(await page.evaluate(()=>JSON.stringify(getCurrentScanPoints())),scanBefore);
      await settings(page,{simRipple:'0'});
      const smooth=await simulation(page);
      await settings(page,{simRipple:'2'});
      assert.notDeepEqual((await simulation(page)).points,smooth.points,'ripple parameter controls reproducible jagged texture');
      assert.equal(await page.evaluate(()=>JSON.stringify(getCurrentScanPoints())),scanBefore);
      assert.deepEqual(await page.evaluate(()=>window.rfSimulationInvalidations),[],'visual settings do not invalidate coordination');
      await noOverflow(page,`${scenario.width}/${scenario.dpr}/csv`);
      assert.equal(mutations.length,startMutations,'no backend/project write from simulation');
      assert.deepEqual(controls,[]);
      assert.deepEqual(errors,[]);
      console.log(JSON.stringify({...scenario,assertions:'PASS',screenshots:output,fixtureBytes:devicesBefore.length}));
      await context.close();
    }
    console.log('PASS: isolated RF simulation settings/ranges/IMD/texture/zoom/telemetry/scan separation/layout/DPR. Screenshots: '+output);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
