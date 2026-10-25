'use strict';
// Complete production settings page, isolated transports and browser storage.
// Compare the five existing cards against the reviewed pre-B1/B2 snapshot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.join(__dirname, '..');
const baselineRoot = process.env.PLUGIN_STATUS_BASELINE;
if (!baselineRoot) throw new Error('Set PLUGIN_STATUS_BASELINE to an explicitly supplied historical baseline.');
const brands = ['Rode Wireless Protocol', 'Mipro ACT Protocol', 'Lectrosonics Protocol',
  'Sony UWP Protocol', 'Behringer ULTRALINK'];
const source = fs.readFileSync(path.join(root, 'src/modules/discovery.js'), 'utf8');
const oldSource = fs.readFileSync(path.join(baselineRoot, 'src/modules/discovery.js'), 'utf8');
// B3 explicitly migrates transport/host calls, covered by discovery-host and
// host-runtime replay. Retain byte-for-byte protection of identity/data/settings;
// this B2 regression still compares original plugin card geometry below.
for (const [start,end] of [
  ['function _rawDeviceFrequencyKHz(', 'async function scanForReceivers('],
  ['function _markServerDevicesOffline(', 'function _onServerDisconnected('],
  ['function _onServerData(', 'function _startHeartbeat('],
  ['function saveSettings(', 'function importPlugin('],
]) {
  const section = value => {const a=value.indexOf(start),b=value.indexOf(end,a);assert.ok(a>=0&&b>a);return value.slice(a,b);};
  assert.equal(section(source),section(oldSource),'Preserve identity/telemetry/settings: '+start);
}

(async () => {
  const browser = await chromium.launch({headless:true,
    executablePath:process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  try {
    const context = await browser.newContext(), errors = [], writes = [], choosers = [], dialogs = [];
    await context.addInitScript(() => {
      window.setInterval = () => 0;
      window.EventSource = class extends EventTarget {close() {}};
      window.WebSocket = class extends EventTarget {close() {} send() {throw Error('External transport forbidden');}};
    });
    await context.route('**/*', route => route.abort());
    async function fixture(sourceRoot) {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('filechooser', chooser => {choosers.push(sourceRoot);void chooser.setFiles([]);});
      page.on('dialog', async dialog => {dialogs.push(dialog.message());await dialog.dismiss();});
      await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() === 'GET' && url.origin === 'https://127.0.0.1:8080' &&
            (url.pathname === '/unirf-app.html' || url.pathname === '/DATYlogo.png' ||
             /^\/src\/.*\.(css|js|png)$/.test(url.pathname))) {
          const archived = path.join(sourceRoot, url.pathname);
          return route.fulfill({path:fs.existsSync(archived) ? archived : path.join(root, url.pathname)});
        }
        if (request.method() !== 'GET' && request.method() !== 'HEAD') {
          writes.push({path:url.pathname, method:request.method()});
        }
        if (url.pathname === '/api/auth/status') {
          return route.fulfill({json:{authenticated:false, mode:'read-only', permissions:[]}});
        }
        return route.fulfill({json:{status:'ok', success:true, devices:[], projects:[], events:[],
          ip:'127.0.0.1', project:{id:'default', name:'默认项目', data:{}}}});
      });
      await page.goto('https://127.0.0.1:8080/unirf-app.html', {waitUntil:'networkidle'});
      await page.evaluate(() => {
        switchPanel('settings');
        window.pluginTestNotices = [];
        const original = window.notify;
        window.notify = function (...args) {pluginTestNotices.push(args);return original.apply(this, args);};
      });
      return page;
    }
    const baseline = await fixture(baselineRoot), page = await fixture(root);
    const geometry = target => target.evaluate(() => {
      const box = node => {const r = node.getBoundingClientRect();return {x:r.x, y:r.y, width:r.width, height:r.height};};
      const style = node => {const s = getComputedStyle(node);return Object.fromEntries(
        ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'paddingTop',
          'paddingBottom', 'paddingLeft', 'paddingRight', 'borderRadius', 'display'].map(key => [key, s[key]]));};
      return {cards:[...document.querySelectorAll('#panel-settings .plugin-card')].map(node => ({
        box:box(node), style:style(node), html:node.outerHTML,
        children:[...node.querySelectorAll('.plugin-name,.plugin-models,.plugin-status')]
          .map(child => ({box:box(child), style:style(child), text:child.textContent.trim()}))})),
      panel:box(document.getElementById('panel-settings')),
      contentOverflow:getComputedStyle(document.querySelector('.content')).overflowY,
      buttons:[...document.querySelectorAll('[onclick="importPlugin()"],[onclick="importPluginCloud()"]')]
        .map(node => ({html:node.outerHTML, box:box(node), style:style(node)}))};
    });
    for (const [width, height] of [[1366, 768], [1024, 600]]) {
      await baseline.setViewportSize({width, height});
      await page.setViewportSize({width, height});
      for (const target of [baseline, page]) {
        await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      const expected = await geometry(baseline), actual = await geometry(page);
      assert.equal(actual.cards.length, 5);
      assert.deepEqual(actual, expected, `Existing settings cards/buttons/layout changed at ${width}x${height}.`);
      assert.equal(actual.contentOverflow, 'hidden');
      assert.equal(new Set(actual.cards.map(card => card.box.height)).size, 1);
      assert.equal(actual.cards.every(card => card.children[2].text === '开发中'), true);
    }

    const currentGeometry = await geometry(page);
    const inputsBefore = await page.locator('input[type="file"]').count();
    const storageBefore = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
    await page.click('button[onclick="importPlugin()"]');
    assert.equal(await page.textContent('#notifTitle'), '插件导入尚未接入');
    assert.equal(await page.locator('input[type="file"]').count(), inputsBefore);
    assert.deepEqual(choosers, []);
    for (let index = 0; index < brands.length; index++) {
      await page.click('button[onclick="importPluginCloud()"]');
      const modal = page.locator('#cloudPluginModal');
      await modal.waitFor({state:'visible'});
      const entries = modal.locator('[onclick^="downloadPlugin("]');
      assert.equal(await entries.count(), 5);
      assert.deepEqual((await entries.allTextContents()).map(text => text.trim()), Array(5).fill('开发中'));
      const text = await modal.textContent();
      for (const brand of brands) assert.ok(text.includes(brand));
      assert.equal((text.match(/待发布/g) || []).length, 5);
      assert.match(text, /规划预览.*尚未接入真实插件库/);
      assert.doesNotMatch(text, /已收录 24|⬇ 下载|👑 高级|🧪 测试|v\d+\.\d+/);
      await entries.nth(index).click();
      assert.equal(await modal.count(), 0);
      assert.equal(await page.textContent('#notifTitle'), '插件下载尚未接入');
      const messages = await page.evaluate(() => pluginTestNotices);
      assert.ok(messages.at(-1)[2].includes(brands[index]));
      assert.match(messages.at(-1)[2], /未下载、未安装/);
    }
    // Outlast both old fake-completion timers to prove no delayed success remains.
    await page.waitForTimeout(2100);
    // Unchanged startup discovery may report its own status during this page test.
    // Keep it running, but scope completion assertions to the plugin operations.
    const notices = (await page.evaluate(() => pluginTestNotices)).filter(entry =>
      /插件/.test(entry[1] + entry[2]) || brands.some(brand => entry[2].includes(brand)));
    assert.equal(notices.length, 6, JSON.stringify(notices));
    for (const notice of notices) assert.doesNotMatch(notice[1], /成功|完成|正在解析|正在.*下载/);
    assert.equal(await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage)))), storageBefore);
    assert.equal(await page.locator('input[type="file"]').count(), inputsBefore);
    assert.deepEqual(await geometry(page), currentGeometry);
    assert.deepEqual(choosers, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
    console.log('PASS: production plugin import/cloud actions never choose files, install, download, write or report fake success; five planned market entries stay development-only; settings five-card/button geometry and styles match snapshot at 1366x768 and 1024x600; identity/telemetry/settings sections unchanged; B3 transport covered separately.');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error);process.exitCode = 1;});
