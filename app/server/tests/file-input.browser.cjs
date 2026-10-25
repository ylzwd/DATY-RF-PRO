'use strict';
// Production page and real browser FileReader/file chooser, all transports isolated.
// No live services, real receiver commands, user files or production storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.join(__dirname, '..');
const scan = fs.readFileSync(path.join(__dirname, 'fixtures/scan-reference-mhz.csv'));
const badScan = fs.readFileSync(path.join(__dirname, 'fixtures/scan-invalid-empty.csv'));
const scanButton = 'button[onclick="importScan(\'扫描 CSV\')"]';
const profileButton = 'button[onclick="importEquipmentProfile()"]';
const csvCard = '[onclick="importFile(\'CSV\')"]';
const historyKey = 'daty_planning_history_v1';

(async () => {
  const browser = await chromium.launch({headless:true,
    executablePath:process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  try {
    const context = await browser.newContext({viewport:{width:1366, height:768}});
    const page = await context.newPage(), errors = [], commands = [], dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => {dialogs.push(dialog.message());await dialog.dismiss();});
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === 'GET' && url.origin === 'https://127.0.0.1:8080' &&
          (url.pathname === '/unirf-app.html' || url.pathname === '/DATYlogo.png' ||
           /^\/src\/.*\.(css|js|png)$/.test(url.pathname))) {
        return route.fulfill({path:path.join(root, url.pathname)});
      }
      if (request.method() !== 'GET' && request.method() !== 'HEAD') {
        commands.push({path:url.pathname, method:request.method()});
      }
      if (url.pathname === '/api/auth/status') {
        return route.fulfill({json:{authenticated:false, mode:'read-only', permissions:[]}});
      }
      return route.fulfill({json:{status:'ok', success:true, devices:[], projects:[], events:[],
        ip:'127.0.0.1', project:{id:'default', name:'默认项目', data:{}}}});
    });
    await context.addInitScript(() => {
      window.setInterval = () => 0;
      window.EventSource = class extends EventTarget {close() {}};
      window.WebSocket = class extends EventTarget {close() {} send() {throw Error('Network forbidden');}};
    });
    await page.goto('https://127.0.0.1:8080/unirf-app.html', {waitUntil:'networkidle'});
    await page.evaluate(() => {
      window.persistPlanningProject = async () => {};
      DEVICES.splice(0, DEVICES.length, {id:1, _fasheId:'fixture-receiver_ch1', receiver_id:'fixture-receiver',
        receiver_ip:'192.0.2.102', ip:'192.0.2.102', receiver_mac:'02:00:00:00:00:01',
        channel_number:1, ch:'CH1', brand:'DATYaudio', model:'DATY-X1', name:'隔离测试',
        freq:600000, planned:0, rf:-65, afDbfs:-12, batt:80, muted:false, _source:'manual'});
      window.fileTestNotices = [];
      const originalNotify = window.notify;
      window.notify = function (...args) {fileTestNotices.push(args);return originalNotify.apply(this, args);};
      switchPanel('data');
      switchTab('dataImport', document.querySelector('[onclick="switchTab(\'dataImport\',this)"]'));
    });

    const cardGeometry = () => page.evaluate(() => [...document.querySelectorAll('#dataImport .data-import-style-card')].map(node => {
      const r = node.getBoundingClientRect(), title = node.querySelector('.data-import-style-title');
      return {x:r.x, y:r.y, width:r.width, height:r.height, title:title.textContent,
        fontSize:getComputedStyle(title).fontSize, fontWeight:getComputedStyle(title).fontWeight};
    }));
    const cardsBefore = await cardGeometry();
    assert.equal(cardsBefore.length, 6);
    const telemetry = () => page.evaluate(() => JSON.stringify(DEVICES.map(({planned, ...device}) => device)));
    const telemetryBefore = await telemetry();
    const snapshot = () => page.evaluate(key => JSON.stringify({scan:getCurrentScanPoints(),
      profiles:localStorage.getItem(DatyEquipmentProfiles.STORAGE_KEY), history:localStorage.getItem(key),
      plan:window.DATY_LAST_COORDINATION, devices:DEVICES,
      constraints:DatyPlanningConstraints.captureConstraintFields()}), historyKey);
    const noticeIndex = () => page.evaluate(() => fileTestNotices.length);
    async function waitNotice(index, title) {
      await page.waitForFunction(({index, title}) => fileTestNotices.slice(index).some(entry => entry[1] === title), {index, title});
    }
    async function startChooser(action) {
      const chooser = page.waitForEvent('filechooser');
      await action();
      return chooser;
    }
    async function upload(action, name, buffer, mimeType) {
      const chooser = await startChooser(action);
      await chooser.setFiles({name, mimeType, buffer});
    }
    async function assertNoInput() {
      await page.waitForFunction(() => document.querySelectorAll('input[type="file"]').length === 0);
    }

    // Data-management CSV card retains the original action and CSV units/parser.
    let index = await noticeIndex();
    await upload(() => page.click(csvCard), 'fixture.csv', scan, 'text/csv');
    await waitNotice(index, '真实扫描已导入');
    await assertNoInput();
    const points = await page.evaluate(() => getCurrentScanPoints());
    assert.equal(points.length, 21);
    assert.deepEqual(points[0], {frequencyKHz:600000, levelDbm:-100});
    assert.deepEqual(await cardGeometry(), cardsBefore, 'File import must not alter the six existing card styles or geometry.');

    // Original scan-page button; corrupt CSV cannot replace previously loaded points.
    await page.evaluate(() => switchPanel('spectrum'));
    let before = await snapshot();
    index = await noticeIndex();
    await upload(() => page.click(scanButton), 'bad.csv', badScan, 'text/csv');
    await waitNotice(index, '扫描导入失败');
    await assertNoInput();
    assert.equal(await snapshot(), before);

    // OS-dialog cancellation has no Playwright dismiss API. Dispatch the browser's
    // standard input cancel event, without calling any production import callback.
    const chooser = await startChooser(() => page.click(scanButton));
    await chooser.element().evaluate(input => input.dispatchEvent(new Event('cancel')));
    await assertNoInput();
    assert.equal(await snapshot(), before);

    // A real JSON profile passes the unchanged atomic Profile validator/store.
    await page.evaluate(() => switchPanel('planner'));
    const profile = await page.evaluate(() => {
      const result = JSON.parse(JSON.stringify(DatyEquipmentProfiles.resolveEquipmentProfile({brand:'DATYaudio'})));
      result.id = 'file-input-browser-fixture';
      return result;
    });
    index = await noticeIndex();
    await upload(() => page.click(profileButton), 'profile.json', Buffer.from(JSON.stringify(profile)), 'application/json');
    await page.locator('#datyConfirmDialog').waitFor();
    await page.click('#datyConfirmAccept');
    await waitNotice(index, 'Profile 已导入');
    await assertNoInput();
    assert.ok(await page.evaluate(id => localStorage.getItem(DatyEquipmentProfiles.STORAGE_KEY).includes(id), profile.id));
    before = await snapshot();
    index = await noticeIndex();
    await upload(() => page.click(profileButton), 'bad-profile.json', Buffer.from(JSON.stringify([profile, {id:'broken'}])), 'application/json');
    await waitNotice(index, 'Profile 导入失败');
    await assertNoInput();
    assert.equal(await snapshot(), before, 'Failed Profile batch must leave all current business state intact.');

    // History has no separate file-import button: loadHistory's existing missing-
    // record fallback is its production file entry. Do not invent a new UI control.
    await page.evaluate(() => switchPanel('data'));
    const saved = await page.evaluate(() => ({type:'daty_rf_planning', version:'1.0.3',
      id:'file-history-fixture', projectId:'default', projectName:'默认项目', name:'隔离文件导入',
      devices:DEVICES.map(device => ({...device, planned:601000, muted:true, freq:699000, rf:-99})),
      constraints:{excludedRanges:[], lockedAssignments:[], knownCarriers:[], backupCount:0}}));
    index = await noticeIndex();
    await upload(() => page.evaluate(() => {loadHistory('__file_fixture_not_in_history__');}),
      'guihua_fixture.json', Buffer.from(JSON.stringify(saved)), 'application/json');
    await waitNotice(index, '方案已加载');
    await assertNoInput();
    assert.equal(await page.evaluate(() => DEVICES[0].planned), 601000);
    assert.equal(await telemetry(), telemetryBefore, 'History file restores only planned values, never receiver telemetry or mute state.');
    const history = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), historyKey);
    assert.equal(history.currentRecordId, saved.id);
    assert.equal(history.records[0].constraints.backupCount, 0);
    before = await snapshot();
    index = await noticeIndex();
    await upload(() => page.evaluate(() => {loadHistory('__file_fixture_invalid__');}),
      'broken.json', Buffer.from('{broken-json'), 'application/json');
    await page.waitForFunction(index => fileTestNotices.slice(index).some(entry => /失败|格式错误/.test(entry[1])), index);
    await assertNoInput();
    assert.equal(await snapshot(), before);

    const historyChooser = await startChooser(() => page.evaluate(() => {loadHistory('__file_fixture_cancel__');}));
    await historyChooser.element().evaluate(input => input.dispatchEvent(new Event('cancel')));
    await assertNoInput();
    assert.equal(await snapshot(), before);
    await page.evaluate(() => switchTab('dataImport', document.querySelector('[onclick="switchTab(\'dataImport\',this)"]')));
    assert.deepEqual(await cardGeometry(), cardsBefore);

    // A second complete production page starts with an injected native platform.
    // Its file host deliberately ignores AbortSignal, exposing stale-result races.
    const nativePage = await context.newPage();
    nativePage.on('pageerror', error => errors.push(error.message));
    await nativePage.addInitScript(() => {
      const values = new Map();
      window.nativeFileCalls = [];
      window.nativeFileOps = [];
      window.nativeReaderCalls = 0;
      window.FileReader = class {constructor() {nativeReaderCalls++;throw Error('Native file host must not use FileReader');}};
      window.DatyPlatform = {VERSION:'1.0.0', kind:'native-file-fixture',
        request(url, init) {return fetch(url, init);},
        openEventStream() {return new EventSource('https://127.0.0.1:8802/events');},
        storage:{getItem(key) {return values.get(key) ?? null;},
          setItem(key, value) {values.set(key, String(value));}, removeItem(key) {values.delete(key);}},
        downloadText() {throw Error('File input must not export');}};
      window.DatyHostRuntime = {VERSION:'daty-host-runtime-v1',
        setTimeout:(fn, ms) => window.setTimeout(fn, ms), clearTimeout:id => window.clearTimeout(id),
        setInterval:(fn, ms) => window.setInterval(fn, ms), clearInterval:id => window.clearInterval(id),
        nowEpochMs:() => Date.now(), nowMonotonicMs:() => performance.now()};
      window.DatyHostMessages = {VERSION:'daty-host-messages-v1', confirm:() => false, alert() {},
        notify(icon, title, message) {
          document.getElementById('notifIcon').textContent=icon;
          document.getElementById('notifTitle').textContent=title;
          document.getElementById('notifMsg').textContent=message;
          document.getElementById('notif').classList.add('show');
        }};
      window.DatyDialogs = {VERSION:'daty-dialogs-v1', confirm:async () => false, cancelActive() {}};
      window.nativeFilePort = window.DatyTextFiles = {VERSION:'daty-text-file-v1', openText(options) {
        const bound = this === nativeFilePort;
        return new Promise((resolve, reject) => nativeFileCalls.push({options, bound, resolve, reject}));
      }};
    });
    await nativePage.goto('https://127.0.0.1:8080/unirf-app.html', {waitUntil:'networkidle'});
    const nativeScan = () => nativePage.evaluate(() => JSON.stringify(getCurrentScanPoints()));
    const startNativeScan = () => nativePage.evaluate(() => {
      const index = nativeFileOps.length;
      nativeFileOps.push(importScan('CSV'));
      return index;
    });
    async function resolveNative(index, frequency) {
      return nativePage.evaluate(async ({index, frequency}) => {
        const text = `Frequency (MHz),Level (dBm)\n${frequency.toFixed(3)},-100\n${(frequency + 0.25).toFixed(3)},-90`;
        nativeFileCalls[index].resolve({status:'completed', name:'native.csv', text, sizeBytes:new TextEncoder().encode(text).length});
        return await nativeFileOps[index];
      }, {index, frequency});
    }
    async function flushNative() {
      await nativePage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }

    let operation = await startNativeScan();
    await nativePage.evaluate(() => DatyTextFileFactory.cancelPending(window));
    assert.equal(await nativePage.evaluate(index => nativeFileOps[index], operation), false);
    await resolveNative(operation, 641);
    await flushNative();
    assert.equal(await nativeScan(), '[]', 'A host completion after explicit cancellation cannot commit.');

    const oldOperation = await startNativeScan(), newOperation = await startNativeScan();
    assert.equal(await resolveNative(newOperation, 642), true);
    let latestScan = await nativeScan();
    assert.equal(await resolveNative(oldOperation, 640), false);
    await flushNative();
    assert.equal(await nativeScan(), latestScan, 'An older native request must not overwrite the newer completed scan.');

    const firstPending = await startNativeScan(), secondPending = await startNativeScan();
    assert.equal(await resolveNative(firstPending, 640), false);
    assert.equal(await nativeScan(), latestScan, 'An older completion cannot commit while the newer file is still pending.');
    assert.equal(await resolveNative(secondPending, 642.25), true);
    latestScan = await nativeScan();

    operation = await startNativeScan();
    await nativePage.evaluate(() => {
      const field = document.getElementById('plannerBackupCount');
      field.value = '2'; field.dispatchEvent(new Event('input', {bubbles:true}));
    });
    assert.equal(await resolveNative(operation, 643), false);
    await flushNative();
    assert.equal(await nativeScan(), latestScan, 'Constraint invalidation cancels pending file results.');

    operation = await startNativeScan();
    await nativePage.evaluate(() => {window.DatyPlatform = {...DatyPlatform, kind:'native-switched-fixture'};});
    assert.equal(await resolveNative(operation, 644), false);
    assert.equal(await nativeScan(), latestScan, 'Changing platform while a host reads prevents stale commit.');

    operation = await startNativeScan();
    await nativePage.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    assert.equal(await resolveNative(operation, 645), false);
    await flushNative();
    assert.equal(await nativeScan(), latestScan, 'Native page teardown cannot accept late file results.');
    assert.equal(await nativePage.evaluate(() => nativeFileCalls.every(call => call.bound)), true,
      'The optional file port preserves its native receiver binding.');

    await nativePage.evaluate(() => {window.DatyTextFiles = undefined;});
    assert.equal(await nativePage.evaluate(() => importScan('CSV')), false);
    assert.match(await nativePage.textContent('#notifTitle'), /失败/);
    assert.equal(await nativeScan(), latestScan);
    await nativePage.evaluate(() => {
      window.DatyTextFiles = {VERSION:'daty-text-file-v1', openText() {throw Error('synchronous fixture host failure');}};
    });
    assert.equal(await nativePage.evaluate(() => importScan('CSV')), false);
    assert.match(await nativePage.textContent('#notifTitle'), /失败/);
    assert.equal(await nativeScan(), latestScan);
    assert.equal(await nativePage.evaluate(() => nativeReaderCalls), 0);
    assert.equal(await nativePage.locator('input[type="file"]').count(), 0);
    const currentAfterExit = await nativePage.evaluate(async () => {
      window.DatyTextFiles = {VERSION:'daty-text-file-v1', openText() {
        return Promise.resolve({status:'completed', name:'completed.txt', text:'fixture', sizeBytes:7});
      }};
      const pending = DatyTextFileFactory.openLatest(window, {accept:'.txt', maxBytes:64});
      pending.then(() => window.dispatchEvent(new Event('pagehide')));
      const result = await pending;
      return result.status === 'completed' && result.isCurrent();
    });
    assert.equal(currentAfterExit, false, 'Page teardown between Promise completion and caller commit must invalidate the auxiliary current check.');
    await nativePage.close();
    assert.deepEqual(commands, [], 'File operations must not issue any device or other server write request.');
    assert.deepEqual(dialogs, [], 'No browser alert/confirm replaces existing application UI.');
    assert.deepEqual(errors, []);
    console.log('PASS: production CSV/Profile/history real files; corrupt/cancelled inputs preserve state; DOM cleanup, telemetry and six-card geometry unchanged; full-page native cancellation, superseding, invalidation, platform switch, teardown and synchronous failure never fall back to FileReader; zero external writes.');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error);process.exitCode = 1;});
