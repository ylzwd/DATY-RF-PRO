// Optional isolated Edge UI test. All transports are replaced before mounting;
// no live Bridge, receiver, project DB or production account is accessed.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.join(__dirname, '..');
(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const context = await browser.newContext({viewport: {width: 1366, height: 768}});
  const externalRequests = [], nativeDialogs = [], errors = [];
  try {
    await context.route('**/*', route => { externalRequests.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { nativeDialogs.push(dialog.message()); await dialog.dismiss(); });
    const html = fs.readFileSync(path.join(root, 'unirf-app.html'), 'utf8')
      .replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '').replace(/<img\b[^>]*>/gi, '');
    await page.setContent(html);
    for (const name of ['main.css', 'access.css']) await page.addStyleTag({content: fs.readFileSync(path.join(root, 'src/styles', name), 'utf8')});
    for (const name of ['access-client.js', 'browser-platform.js']) await page.addScriptTag({content: fs.readFileSync(path.join(root, 'src/platform', name), 'utf8')});
    await page.evaluate(() => {
      globalThis.fixtureOrigin = 'https://127.0.0.1:8802'; globalThis.fixtureCalls = []; globalThis.fixtureDenied = false;
      globalThis.fetch = async (url, init) => {
        fixtureCalls.push({url: String(url), method: init?.method || 'GET', redirect: init?.redirect, authorization: init?.headers?.authorization});
        if (String(url).endsWith('/api/auth/status')) {
          const authorized = !!init?.headers?.authorization;
          return new Response(JSON.stringify({success: true, auth: {protocol: 'daty-access-v1', configured: true, authenticated: authorized,
            principal: authorized ? {id: 'ui-fixture', name: '测试操作员', role: 'operator'} : null,
            permissions: authorized ? ['device.control', 'project.write', 'timeline.write', 'discovery.scan'] : [], mode: authorized ? 'authorized' : 'read-only'}}), {status: 200});
        }
        return new Response(JSON.stringify({success: !fixtureDenied}), {status: fixtureDenied ? 401 : 200});
      };
      DatyAccessFactory.mountBrowserUI(globalThis, {getBridgeUrl: () => fixtureOrigin});
    });
    assert.match(await page.textContent('#datyAccessButton'), /只读/);
    assert.equal((await page.evaluate(() => fixtureCalls)).length, 1);
    await page.click('#datyAccessButton');
    assert.equal(await page.locator('#datyAccessDialog').isVisible(), true);
    assert.equal(await page.getAttribute('#datyAccessKey', 'type'), 'password');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'datyAccessKey');
    await page.fill('#datyAccessKey', 'daty_fixture_not_real_key'); await page.click('#datyAccessSubmit');
    await page.waitForFunction(() => document.getElementById('datyAccessMessage').textContent.includes('授权成功'));
    assert.match(await page.textContent('#datyAccessButton'), /已授权 · 测试操作员/);
    assert.equal(await page.inputValue('#datyAccessKey'), '');
    assert.equal(await page.locator('#datyAccessLogout').isVisible(), true);
    assert.equal(await page.evaluate(() => JSON.stringify(DatyAccess.snapshot()).includes('not_real_key')), false);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('body *')].some(element => !element.children.length && element.textContent.includes('not_real_key'))), false);

    // Fit application dialog and authorization button without growing the page.
    for (const [width, height] of [[1920,1080], [1366,768], [1024,600]]) {
      await page.setViewportSize({width, height});
      const bounds = await page.evaluate(() => {
        const within = element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; };
        return {dialog: within(document.getElementById('datyAccessDialog')), action: within(document.getElementById('datyAccessSubmit')),
          pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1};
      });
      assert.deepEqual(bounds, {dialog: true, action: true, pageOverflow: false});
    }
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#datyAccessDialog').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'datyAccessButton');
    await page.evaluate(() => DatyPlatform.request(fixtureOrigin + '/api/command', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{"muted":false}'}));
    assert.equal(await page.evaluate(() => fixtureCalls.at(-1).authorization), 'Bearer daty_fixture_not_real_key');
    await page.click('#datyAccessButton'); await page.click('#datyAccessLogout');
    assert.match(await page.textContent('#datyAccessButton'), /只读/);
    assert.match(await page.textContent('#datyAccessMessage'), /实时监测保持运行/);
    const deniedAfterLogout = await page.evaluate(async () => {
      const count = fixtureCalls.length;
      const response = await DatyPlatform.request(fixtureOrigin + '/api/command', {method: 'POST'});
      return {status: response.status, body: await response.json(), calls: fixtureCalls.length - count};
    });
    assert.equal(deniedAfterLogout.status, 401); assert.equal(deniedAfterLogout.body.accepted, false);
    assert.equal(deniedAfterLogout.body.local, true); assert.equal(deniedAfterLogout.calls, 0);
    await page.fill('#datyAccessKey', 'daty_fixture_not_real_key'); await page.click('#datyAccessSubmit');
    await page.waitForFunction(() => DatyAccess.snapshot().authenticated);
    await page.evaluate(() => { fixtureDenied = true; return DatyPlatform.request(fixtureOrigin + '/api/command', {method: 'POST'}); });
    assert.match(await page.textContent('#datyAccessButton'), /只读/);
    assert.equal(await page.evaluate(() => fixtureCalls.filter(call => call.method === 'POST').length), 2);
    // Certificate rejection must stay a failed authorization, without retrying
    // plain HTTP or persisting a credential. This is a mocked TLS failure, not
    // a claim that a production certificate trust chain has been installed.
    await page.evaluate(() => {
      globalThis.fixtureTlsCalls=[];
      globalThis.fetch=async(url,init)=>{fixtureTlsCalls.push({url:String(url),redirect:init?.redirect});throw new TypeError('TLS certificate authority invalid');};
    });
    await page.fill('#datyAccessKey', 'daty_fixture_tls_failure'); await page.click('#datyAccessSubmit');
    await page.waitForFunction(()=>document.getElementById('datyAccessMessage').textContent.includes('certificate'));
    assert.equal(await page.evaluate(()=>DatyAccess.snapshot().authenticated),false);
    assert.deepEqual(await page.evaluate(()=>fixtureTlsCalls),[{url:'https://127.0.0.1:8802/api/auth/status',redirect:'error'}]);
    assert.equal(await page.inputValue('#datyAccessKey'),'');

    const localPage = await context.newPage();
    localPage.on('pageerror', error => errors.push(error.message));
    localPage.on('dialog', async dialog => { nativeDialogs.push(dialog.message()); await dialog.dismiss(); });
    await localPage.setContent(html);
    for (const name of ['main.css', 'access.css']) await localPage.addStyleTag({content: fs.readFileSync(path.join(root, 'src/styles', name), 'utf8')});
    for (const name of ['access-client.js', 'browser-platform.js']) await localPage.addScriptTag({content: fs.readFileSync(path.join(root, 'src/platform', name), 'utf8')});
    await localPage.evaluate(() => {
      globalThis.fixtureOrigin = 'https://127.0.0.1:8802'; globalThis.fixtureCalls = [];
      globalThis.fixtureDenied = false; globalThis.fixtureHoldStatus = false; globalThis.fixtureOffline = false;
      globalThis.fetch = async (url, init) => {
        fixtureCalls.push({url: String(url), method: init?.method || 'GET', headers: init?.headers});
        if (fixtureOffline) throw new TypeError('TLS connection unavailable');
        if (String(url).endsWith('/api/auth/status')) {
          const local = String(url).startsWith('https://127.0.0.1:8802/');
          const result = new Response(JSON.stringify({success: true, auth: {protocol: 'daty-access-v1', configured: true,
            authenticated: local, principal: local ? {id: 'local-development', name: '本机开发', role: 'operator'} : null,
            permissions: local ? ['device.control', 'project.write', 'timeline.write', 'discovery.scan'] : [],
            mode: local ? 'local-development' : 'read-only'}}), {status: 200});
          if (fixtureHoldStatus) return new Promise(resolve => { globalThis.fixtureReleaseStatus = () => resolve(result); });
          return result;
        }
        return new Response(JSON.stringify({success: !fixtureDenied}), {status: fixtureDenied ? 401 : 200});
      };
      DatyAccessFactory.mountBrowserUI(globalThis, {getBridgeUrl: () => fixtureOrigin});
    });
    await localPage.waitForFunction(() => DatyAccess.snapshot().mode === 'local-development');
    assert.equal(await localPage.locator('#datyAccessDialog').isVisible(), false, 'Auto detection does not open a modal.');
    assert.equal(await localPage.textContent('#datyAccessButton'), '本机开发 · 可控制');
    assert.equal(await localPage.evaluate(() => fixtureCalls.length), 1);
    await localPage.click('#datyAccessButton');
    assert.equal(await localPage.locator('#datyAccessKey').isVisible(), false);
    assert.equal(await localPage.locator('label[for="datyAccessKey"]').isVisible(), false);
    assert.equal(await localPage.locator('.daty-access-note:not(#datyAccessHelp)').isVisible(), false);
    assert.equal(await localPage.evaluate(() => document.activeElement.id), 'datyAccessSubmit');
    assert.match(await localPage.textContent('#datyAccessHelp'), /无需输入密钥/);
    for (const [width, height] of [[1920,1080], [1366,768], [1024,600]]) {
      await localPage.setViewportSize({width, height});
      assert.deepEqual(await localPage.evaluate(() => {
        const within = id => { const r = document.getElementById(id).getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; };
        return {dialog: within('datyAccessDialog'), submit: within('datyAccessSubmit'), logout: within('datyAccessLogout'),
          overflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1};
      }), {dialog: true, submit: true, logout: true, overflow: false});
    }
    await localPage.click('#datyAccessLogout');
    assert.equal(await localPage.textContent('#datyAccessButton'), '本机开发 · 已暂停');
    const paused = await localPage.evaluate(async () => {
      const before = fixtureCalls.length; await DatyAccess.refresh();
      const denied = await DatyPlatform.request(fixtureOrigin + '/api/command', {method: 'POST'});
      return {calls: fixtureCalls.length - before, authenticated: DatyAccess.snapshot().authenticated, status: denied.status};
    });
    assert.deepEqual(paused, {calls: 0, authenticated: false, status: 401});
    await localPage.click('#datyAccessSubmit');
    await localPage.waitForFunction(() => DatyAccess.snapshot().mode === 'local-development');
    assert.equal(await localPage.evaluate(() => fixtureCalls.filter(call => call.method === 'POST').length), 0);
    assert.match(await localPage.textContent('#datyAccessMessage'), /本机开发已就绪/);

    // Editing the field pauses the old target; only committing a different actual
    // Bridge can trigger its own automatic, read-only authorization probe.
    const beforeEdit = await localPage.evaluate(() => fixtureCalls.length);
    await localPage.evaluate(() => {
      const field = document.getElementById('fasheApiUrl'); field.value = 'https://remote.test:8802';
      field.dispatchEvent(new Event('change')); return DatyAccess.refresh();
    });
    assert.equal(await localPage.evaluate(() => fixtureCalls.length), beforeEdit);
    assert.equal(await localPage.evaluate(() => DatyAccess.snapshot().authenticated), false);
    await localPage.evaluate(() => { fixtureOrigin = 'https://remote.test:8802'; return DatyPlatform.request(fixtureOrigin + '/health'); });
    await localPage.waitForFunction(() => fixtureCalls.some(call => call.url === 'https://remote.test:8802/api/auth/status'));
    assert.equal(await localPage.evaluate(() => DatyAccess.snapshot().authenticated), false);
    assert.equal(await localPage.locator('#datyAccessKey').isVisible(), true);
    assert.equal(await localPage.locator('.daty-access-note:not(#datyAccessHelp)').isVisible(), true);
    assert.match(await localPage.textContent('#datyAccessHelp'), /请向管理员获取/);
    assert.equal(await localPage.evaluate(() => fixtureCalls.find(call => call.url === 'https://remote.test:8802/api/auth/status').headers['x-daty-local-development']), undefined);
    await localPage.evaluate(() => { fixtureOrigin = 'https://127.0.0.1:8802'; return DatyPlatform.request(fixtureOrigin + '/api/devices'); });
    await localPage.waitForFunction(() => DatyAccess.snapshot().mode === 'local-development');
    assert.equal(await localPage.evaluate(() => fixtureCalls.filter(call => call.url === 'https://127.0.0.1:8802/api/auth/status').length), 3);

    await localPage.evaluate(() => { fixtureDenied = true; return DatyPlatform.request(fixtureOrigin + '/api/command', {method: 'POST'}); });
    assert.equal(await localPage.textContent('#datyAccessButton'), '本机开发 · 已暂停');
    await localPage.evaluate(() => { fixtureDenied = false; return DatyAccess.refresh(); });
    assert.equal(await localPage.evaluate(() => DatyAccess.snapshot().authenticated), false);
    await localPage.click('#datyAccessSubmit');
    await localPage.waitForFunction(() => DatyAccess.snapshot().authenticated);
    await localPage.evaluate(async () => { fixtureOffline = true; try { await DatyAccess.verifyPermission('device.control'); } catch (_) {} fixtureOffline = false; });
    assert.equal(await localPage.evaluate(() => DatyAccess.snapshot().authenticated), false);
    assert.equal(await localPage.textContent('#datyAccessButton'), '本机开发 · 已暂停');

    await localPage.evaluate(() => { fixtureHoldStatus = true; });
    await localPage.click('#datyAccessSubmit');
    await localPage.waitForFunction(() => typeof fixtureReleaseStatus === 'function');
    await localPage.click('#datyAccessClose');
    await localPage.evaluate(() => { fixtureHoldStatus = false; fixtureReleaseStatus(); });
    await localPage.waitForFunction(() => DatyAccess.snapshot().paused);
    assert.equal(await localPage.evaluate(() => DatyAccess.snapshot().authenticated), false);
    assert.equal(await localPage.locator('#datyAccessDialog').isVisible(), false);
    assert.equal(await localPage.evaluate(() => fixtureCalls.filter(call => call.method === 'POST').length), 1, 'No cancelled or rejected control is replayed.');
    assert.equal(await localPage.evaluate(() => fixtureCalls.some(call => call.headers?.authorization)), false);
    assert.equal(await localPage.evaluate(() => fixtureCalls.filter(call => call.url.endsWith('/api/auth/status') && call.url.startsWith('https://127.0.0.1:8802/')).every(call => call.headers['x-daty-local-development'] === '1')), true);
    assert.deepEqual(externalRequests, []); assert.deepEqual(nativeDialogs, []); assert.deepEqual(errors, []);
    process.stdout.write('PASS isolated access UI: remote Bearer + automatic local status, no-key pause/resume, target edits/switches, 401/offline/cancelled late status, scoped marker/no replay, 3 viewport sizes; no live network.\n');
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
