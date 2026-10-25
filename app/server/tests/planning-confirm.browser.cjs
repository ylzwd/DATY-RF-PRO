// Real shared app-dialog module and stylesheet in isolated Edge. No API or socket
// reaches a server: all confirmations are local fixtures, never device controls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.join(__dirname, '..');

(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const context = await browser.newContext({viewport:{width:1366,height:768}});
  const unexpectedRequests = [], nativeDialogs = [], errors = [];
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'daty-planning-confirm-'));
  try {
    await context.route('**/*', route => {unexpectedRequests.push(route.request().url());return route.abort();});
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', async dialog => {nativeDialogs.push(dialog.message());await dialog.dismiss();});
    await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Isolated confirmation</title></head><body><main><button id="fixtureOpener" type="button">全部下发</button><button id="fixtureOutside" type="button">其他功能</button></main></body></html>');
    // External CSS decoding removes its UTF-8 BOM; emulate that for inline fixture injection.
    await page.addStyleTag({content:fs.readFileSync(path.join(root, 'src/styles/main.css'), 'utf8').replace(/^\uFEFF/, '')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root, 'src/modules/dialogs.js'), 'utf8')});
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg2').trim()), '#111520');

    const options = count => ({
      title:count === 1 ? '确认单通道下发' : '确认全部下发',
      message:`请核对 ${count} 个目标通道，确认后才会向对应接收机发送频率。`,
      rows:Array.from({length:count}, (_, i) => ({brand:'DATYaudio', receiver:'192.0.2.' + (1 + Math.floor(i / 8)), channel:`CH${i % 8 + 1}`,
        currentFrequency:(641 + i * .25).toFixed(3) + ' MHz', plannedFrequency:(660 + i * .25).toFixed(3) + ' MHz', note:i === 0 ? '主持人' : ''})),
      warnings:['未导入真实扫描：仅通过数学约束，不能确认现场无干扰。', '按 CH 逐个发送并等待设备 ACK；失败停止后续，已执行的频率不自动回退。'],
      confirmLabel:count === 1 ? '确认下发' : '确认全部下发', cancelLabel:'取消'
    });
    async function open(opts) {
      await page.focus('#fixtureOpener');
      await page.evaluate(opts => {
        window.fixtureResult = 'pending';
        window.fixturePromise = DatyDialogs.confirm(opts).then(result => {window.fixtureResult = result;});
      }, opts);
      await page.locator('#datyConfirmDialog').waitFor({state:'visible'});
      await page.waitForFunction(() => document.activeElement?.id === 'datyConfirmCancel');
    }
    async function closed(expected) {
      await page.waitForFunction(() => window.fixtureResult !== 'pending');
      assert.equal(await page.evaluate(() => window.fixtureResult), expected);
      assert.equal(await page.locator('#datyConfirmDialog').isVisible(), false);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'fixtureOpener', 'Closing restores keyboard focus to the caller.');
    }

    // Safe default, keyboard accessibility and all cancel paths.
    for (const action of ['Escape', 'Enter', 'button', 'close']) {
      await open(options(1));
      assert.equal(await page.getAttribute('#datyConfirmDialog', 'aria-labelledby'), 'datyConfirmTitle');
      assert.match(await page.textContent('#datyConfirmTitle'), /单通道/);
      assert.equal(await page.textContent('#datyConfirmAccept'), '确认下发');
      if (action === 'button') await page.click('#datyConfirmCancel');
      else if (action === 'close') await page.click('#datyConfirmClose');
      else await page.keyboard.press(action);
      await closed(false);
    }
    await open(options(4));
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#datyConfirmDialog')), true, 'Modal keyboard focus must stay inside the dialog.');
    }
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#datyConfirmDialog')), true, 'Reverse keyboard focus must stay inside the dialog.');
    }
    await page.click('#datyConfirmAccept');
    await closed(true);

    // One active confirmation: a second request must not replace the first or auto-approve.
    await open(options(1));
    const second = await page.evaluate(() => DatyDialogs.confirm({title:'Must not replace first',confirmLabel:'Unexpected'}));
    assert.equal(second, false);
    assert.match(await page.textContent('#datyConfirmTitle'), /单通道/);
    assert.equal(await page.evaluate(() => fixtureResult), 'pending');
    assert.equal(await page.locator('#datyConfirmDialog').count(), 1);
    await page.keyboard.press('Escape');
    await closed(false);

    // Text values from devices and custom notes are displayed literally, not as HTML.
    const payload = '<img src=x onerror="window.fixtureInjected=true">';
    const escaped = options(1);
    escaped.title = payload;
    escaped.message = payload;
    escaped.rows[0] = Object.fromEntries(['brand','receiver','channel','currentFrequency','plannedFrequency','note'].map(key => [key,payload]));
    escaped.warnings = [payload];
    await open(escaped);
    for (const id of ['datyConfirmTitle', 'datyConfirmMessage', 'datyConfirmRows', 'datyConfirmWarnings']) assert.ok((await page.textContent('#' + id)).includes(payload));
    assert.equal(await page.locator('#datyConfirmDialog img, #datyConfirmDialog script').count(), 0);
    assert.equal(await page.evaluate(() => !!window.fixtureInjected), false);
    await page.click('#datyConfirmCancel');
    await closed(false);

    // Large batches use bounded inner scrolling, keeping title/actions in the viewport.
    for (const [width,height] of [[1920,1080],[1366,768],[1024,600]]) {
      await page.setViewportSize({width,height});
      for (const count of [1,4,50,64]) {
        await open(options(count));
        assert.equal(await page.locator('#datyConfirmRows tr').count(), count);
        const layout = await page.locator('#datyConfirmDialog').evaluate(dialog => {
          const inside = e => {const r=e.getBoundingClientRect();return r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth+1 && r.bottom <= innerHeight+1;};
          const scrollable = [...dialog.querySelectorAll('*')].filter(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight+1);
          return {bounded:inside(dialog), actionsVisible:['datyConfirmAccept','datyConfirmCancel','datyConfirmClose','datyConfirmTitle'].every(id => inside(document.getElementById(id))),
            documentOverflow:document.documentElement.scrollHeight > innerHeight+1 || document.documentElement.scrollWidth > innerWidth+1,
            horizontalOverflow:dialog.scrollWidth > dialog.clientWidth+1, internalScrollable:scrollable.length};
        });
        assert.equal(layout.bounded, true, `${width}x${height}/${count}: dialog must stay in the viewport`);
        assert.equal(layout.actionsVisible, true, `${width}x${height}/${count}: title and actions must remain visible`);
        assert.equal(layout.documentOverflow, false, `${width}x${height}/${count}: no page scrollbar`);
        assert.equal(layout.horizontalOverflow, false, `${width}x${height}/${count}: no dialog horizontal clipping`);
        if (count >= 50) assert.ok(layout.internalScrollable >= 1, `${count}: long target preview should scroll internally`);
        if (count === 64 && (width === 1024 || width === 1920)) await page.screenshot({path:path.join(output,`${width}-64-confirm.png`)});
        if (count >= 50) {
          const lastVisible = await page.locator('#datyConfirmRows').evaluate(rows => {
            const region = rows.closest('.daty-confirm-table-wrap');
            region.scrollTop = region.scrollHeight;
            const last = rows.lastElementChild.getBoundingClientRect(), bounds = region.getBoundingClientRect();
            return last.top >= bounds.top-1 && last.bottom <= bounds.bottom+1;
          });
          assert.equal(lastVisible, true, `${count}: internal scrolling must expose the last channel`);
        }
        await page.keyboard.press('Escape');
        await closed(false);
      }
    }
    assert.deepEqual(unexpectedRequests, []);
    assert.deepEqual(nativeDialogs, []);
    assert.deepEqual(errors, []);
    console.log('PASS: app confirmation cancel/ESC/safe Enter, focus trap/restore, single-flight, escaped device text, 1/4/50/64-row bounded layout at three sizes; zero native browser dialogs and zero network/control requests. ' + output);
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error);process.exitCode = 1;});
