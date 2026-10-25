// Production HTTPS page + unmodified FAshe identity/message handlers in isolated VMs.
// All HTTP is fulfilled/aborted and all SSE/WS are replaced before page scripts run.
// No real service, credential, pairing, receiver, or persistent browser profile is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {chromium} = require('playwright');
const root = path.join(__dirname, '..');
const pageOrigin = 'https://localhost:8080';
const bridgeOrigin = 'https://127.0.0.1:8802';
const scopes = ['device.control', 'project.write', 'timeline.write', 'discovery.scan'];
const source = fs.readFileSync(path.join(root, '../FAshe/index.html'), 'utf8');

function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'Production FAshe handler boundaries must exist.');
  return source.slice(first, last);
}

const capabilities = {
  adapter: 'fashe-mqtt', write_frequency: true, read_frequency: true, read_only: false, mute: true,
  frequency_control: {scope: 'fashe-protocol', min_khz: 400000, max_khz: 900000, step_khz: 1,
    origin_khz: 0, ack_mode: 'command-id', brand_binding: 'expected-brand-v1'}
};

function receiver(number, frequencies) {
  const ip = `192.0.2.${number}`, mac = `02:00:00:00:00:0${number}`;
  const rid = 'FAshe-MAC-' + mac.replaceAll(':', ''), reports = [], cards = [];
  const devices = frequencies.map((frequency, i) => ({id: i + 1, channel: i + 1,
    name: `Receiver ${number} CH${i + 1}`, brand: 'DATYaudio', model: 'DATY-X1',
    frequency, muted: false, rfLevel: -50, afLevel: -12, battery: 90}));
  const context = vm.createContext({console: {log() {}}, devices, performance, messageCount: 0,
    groupMapping: {}, GROUP_NUMBER: 9, getReceiverIP: () => ip,
    getReceiverClientId: () => `FAshe-${ip}`, getLocalMacAddress: () => mac, masterNowMs: Date.now,
    MQTT_TOPIC_RECEIVE: 'down', MQTT_TOPIC_SEND: 'up', MQTT_TOPIC_CLOCK_SYNC: 'clock',
    mqttClient: {connected: true, publish: (topic, body) => reports.push({topic, body: JSON.parse(body)})},
    DATYaudioProfile: {clampAfDbfs: value => Math.max(-40, Math.min(0, value))},
    scheduleRealtimeStats() {}, log() {},
    updateDeviceMeters: list => cards.push(...list.map(d => ({id: d.id, frequency: d.frequency, muted: d.muted}))),
    document: {getElementById() { throw Error('Unexpected receiver DOM before ACK'); }}
  });
  vm.runInContext(section('    function parseChannelNumber(', '    // MQTT 连接 ID'), context);
  vm.runInContext(section('    function sendDeviceStatus(', '    // 发送指令到服务器（保留兼容）'), context);
  context.mqttClient.on = (_name, handler) => { context.handle = handler; };
  vm.runInContext(section("        mqttClient.on('message', function(topic, message) {", "        mqttClient.on('error'"), context);
  return {context, devices, reports, cards, rid, ip, mac,
    snapshot: () => devices.map(d => ({id: `${rid}_ch${d.channel}`, receiver_id: rid, receiver_ip: ip,
      ip, receiver_mac: mac, channel_number: d.channel, channel: d.channel, ch: `CH${d.channel}`,
      brand: d.brand, model: d.model, name: d.name, freq: Math.round(d.frequency * 1000), muted: d.muted,
      _online: true, status: 'online', _source: `${rid}:mqtt:isolated-session`,
      rf: -50, af_dbfs: -12, batt: 90, capabilities: structuredClone(capabilities)}))};
}

async function harness(browser, statusMode = 'local-development') {
  const receivers = [receiver(1, [641, 645]), receiver(2, [655])];
  const commands = [], requests = [], errors = [], dialogs = [], routeErrors = [];
  const context = await browser.newContext({viewport: {width: 1366, height: 768}, serviceWorkers: 'block'});
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  const state = {statusMode, nextAck: 'normal', nextGate: null, authReads: 0, commandQueries: 0};
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({url: request.url(), method: request.method(), headers: request.headers()});
    try {
      assert.notEqual(url.port, '18080', 'The removed gateway must never be requested.');
      if (request.method() === 'GET' && url.origin === pageOrigin &&
          (url.pathname === '/unirf-app.html' || /^\/src\/.*\.(css|js|svg)$/.test(url.pathname))) {
        const file = path.resolve(root, '.' + url.pathname);
        assert.ok(file.startsWith(root + path.sep), 'Only project static fixtures are readable.');
        return await route.fulfill({path: file});
      }
      if (url.pathname === '/api/auth/status') {
        state.authReads++;
        assert.equal(url.origin, bridgeOrigin);
        assert.equal(request.method(), 'GET');
        assert.equal(request.headers().authorization, undefined, 'Local development must not synthesize a Bearer key.');
        assert.equal(request.headers()['x-daty-local-development'], '1');
        if (state.statusMode === 'unavailable') return await route.abort('failed');
        const authenticated = state.statusMode === 'local-development';
        return await route.fulfill({json: {success: true, auth: {protocol: 'daty-access-v1', configured: true,
          authenticated, mode: authenticated ? 'local-development' : 'read-only',
          principal: authenticated ? {id: 'local-development', name: '本机开发', role: 'operator'} : null,
          permissions: authenticated ? scopes : []}}});
      }
      if (url.pathname === '/api/command') {
        assert.equal(url.origin, bridgeOrigin);
        assert.equal(request.method(), 'POST');
        assert.equal(request.headers().authorization, undefined);
        assert.equal(request.headers()['x-daty-local-development'], '1');
        assert.equal(state.statusMode, 'local-development', 'Only server-confirmed local sessions may send controls.');
        const command = JSON.parse(request.postData());
        assert.ok(['mute', 'unmute', 'set_freq'].includes(command.command));
        assert.ok(command.client_request_id);
        commands.push(command);
        const commandId = `isolated-command-${commands.length}`;
        const before = receivers.map(receiver => receiver.reports.length);
        receivers.forEach(receiver => receiver.context.handle('down', JSON.stringify({...command, command_id: commandId})));
        const changed = receivers.filter((receiver, i) => receiver.reports.length > before[i]);
        assert.equal(changed.length, 1, 'Only the addressed receiver/CH may execute and ACK.');
        const target = changed[0], report = target.reports.at(-1).body;
        assert.equal(report.command_id, commandId);
        assert.equal(report.channel_number, command.channel_number);
        assert.equal(target.cards.at(-1).id, command.channel_number);
        assert.equal(target.reports.at(-1).topic, 'up');
        const device = target.snapshot().find(device => device.channel_number === command.channel_number);
        const actual = command.command === 'set_freq' ? report.freq_mhz : report.muted;
        assert.equal(actual, command.value, 'ACK values must come from the unmodified receiver handler.');
        if (command.command === 'set_freq') assert.equal(command.expected_brand, 'datyaudio');
        const ack = {command_id: commandId, client_request_id: command.client_request_id, device_id: device.id,
          command: command.command, actual_value: actual, status: 'acknowledged', brand: device.brand,
          expected_brand: command.expected_brand};
        const behavior = state.nextAck, gate = state.nextGate;
        state.nextAck = 'normal'; state.nextGate = null;
        if (behavior === 'wrong-value') ack.actual_value += 0.25;
        if (behavior === 'wrong-target') ack.device_id = receivers.find(receiver => receiver !== target).snapshot()[0].id;
        if (behavior === 'disconnect') { device._online = false; device.status = 'offline'; }
        if (gate) await gate;
        await page.evaluate(({device, ack}) => {
          testSse.dispatchEvent(new MessageEvent('device_update', {data: JSON.stringify({devices: [device]})}));
          testSse.dispatchEvent(new MessageEvent('command_update', {data: JSON.stringify({data: ack})}));
        }, {device, ack});
        // SSE must be able to finish without waiting for the HTTP body.
        await new Promise(resolve => setTimeout(resolve, 40));
        try { return await route.fulfill({json: {success: true, command_id: commandId, command_record: ack}}); }
        catch (error) { if (!request.failure()) throw error; return; }
      }
      if (url.pathname === '/api/devices') return await route.fulfill({json: {success: true,
        devices: receivers.flatMap(receiver => receiver.snapshot())}});
      if (url.pathname.startsWith('/api/commands/')) state.commandQueries++;
      if (request.method() !== 'GET' && request.method() !== 'HEAD' && request.method() !== 'OPTIONS' &&
          [bridgeOrigin, 'https://127.0.0.1:8765'].includes(url.origin)) {
        assert.equal(request.headers().authorization, undefined);
        assert.equal(request.headers()['x-daty-local-development'], '1');
      }
      // Unknown URLs are also fulfilled; there is deliberately no route.continue().
      return await route.fulfill({json: {status: 'ok', success: true, devices: [], projects: [], events: [],
        ip: '127.0.0.1', project: {id: 'isolated', name: 'Isolated local development'}}});
    } catch (error) {
      routeErrors.push(error.message);
      console.error('Isolated route rejected:', request.method(), url.pathname, error.message);
      await route.abort('failed').catch(() => {});
    }
  });
  if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => socket.close());
  await context.addInitScript(() => {
    window.setInterval = () => 0;
    window.EventSource = class extends EventTarget {
      readyState = 1;
      constructor() { super(); window.testSse = this; }
      close() { this.readyState = 2; }
    };
    window.WebSocket = class extends EventTarget { close() {} send() { throw Error('No live sockets'); } };
  });
  await page.goto(pageOrigin + '/unirf-app.html');
  await page.waitForFunction(() => !!window.testSse && !!window.DatyAccess);
  await page.evaluate(snapshot => {
    deviceServiceManager.stopDiscovery(); deviceServiceManager.startDiscovery = () => {};
    window.testNotifications = []; window.notify = (...args) => testNotifications.push(args);
    testSse.dispatchEvent(new MessageEvent('device_list', {data: JSON.stringify({devices: snapshot})}));
    switchPanel('channels');
  }, receivers.flatMap(receiver => receiver.snapshot()));
  return {context, page, state, receivers, commands, requests,
    gateNextAck() { let release; state.nextGate = new Promise(resolve => { release = resolve; }); return release; },
    assertClean() { assert.deepEqual(routeErrors, []); assert.deepEqual(errors, []); assert.deepEqual(dialogs, []); }};
}

async function plan(h) {
  const {page, receivers} = h;
  await page.evaluate(() => switchPanel('planner'));
  await page.fill('#plannerRangeStart', '640.000'); await page.fill('#plannerRangeEnd', '690.000');
  await page.getByRole('button', {name: '安全参数', exact: true}).click();
  await page.fill('#plannerStepKHz', '25'); await page.fill('#plannerMinSpacingKHz', '500');
  await page.selectOption('#plannerImdPolicy', 'third-fifth');
  await page.locator('#plannerSafetyDialog').getByRole('button', {name: '关闭 ×'}).click();
  await page.click('.planner-run-button');
  await page.waitForFunction(() => DATY_LAST_COORDINATION?.search.complete);
  const ids = await page.evaluate(() => Object.fromEntries(DEVICES.map(device => [device._fasheId, device.id])));
  for (const [rid, channel, value] of [[receivers[0].rid, 1, '642.000'], [receivers[0].rid, 2, '647.000'], [receivers[1].rid, 1, '658.000']]) {
    await page.fill('#fi_' + ids[`${rid}_ch${channel}`], value); await page.locator('#plannerPageInfo').click();
  }
  await page.click('#plannerConstraintsTab'); await page.fill('#plannerBackupCount', '0');
  await page.click('.planner-run-button');
  await page.waitForFunction(() => DATY_LAST_COORDINATION?.search.complete);
  assert.deepEqual(await page.evaluate(() => DATY_LAST_COORDINATION.options.imdOrders), [3, 5]);
  assert.ok(await page.evaluate(() => DATY_LAST_COORDINATION.assignments.every(item => item.frequencyKHz % 250 === 0)));
  return ids;
}

async function resetActual(h) {
  [641, 645, 655].forEach((frequency, i) => { h.receivers.flatMap(receiver => receiver.devices)[i].frequency = frequency; });
  await h.page.evaluate(snapshot => {
    testSse.dispatchEvent(new MessageEvent('device_list', {data: JSON.stringify({devices: snapshot})}));
  }, h.receivers.flatMap(receiver => receiver.snapshot()));
  await h.page.click('.planner-run-button');
  await h.page.waitForFunction(() => DATY_LAST_COORDINATION?.search.complete);
}

(async () => {
  const browser = await chromium.launch({headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  try {
    const h = await harness(browser), {page, state, receivers, commands} = h;
    await page.waitForFunction(() => DatyAccess.snapshot().authenticated);
    assert.equal(await page.evaluate(() => DatyAccess.snapshot().mode), 'local-development');
    assert.deepEqual(await page.evaluate(() => DatyAccess.snapshot().permissions), scopes);
    assert.equal(await page.inputValue('#datyAccessKey'), '');
    assert.equal(await page.locator('#datyAccessDialog').isVisible(), false);
    assert.equal(commands.length, 0, 'Automatic readiness must not replay a control.');
    const authReadsBeforeMute = state.authReads;
    const firstKey = await page.evaluate(id => getChannelCardKey(DEVICES.find(device => device._fasheId === id)), `${receivers[0].rid}_ch1`);
    const firstChannel = page.locator(`#deviceGridChannels [data-device-key="${firstKey}"]`);
    await firstChannel.locator('[data-role="mute-button"]').click();
    await page.waitForFunction(() => window.getMuteControlDiagnostics().at(-1)?.state === 'acknowledged');
    assert.equal(receivers[0].devices[0].muted, true);
    assert.equal(receivers[0].devices[1].muted, false); assert.equal(receivers[1].devices[0].muted, false);
    assert.match(await firstChannel.locator('[data-role="mute-button"]').textContent(), /取消静音/);
    await firstChannel.locator('[data-role="mute-button"]').click();
    await page.waitForFunction(() => window.getMuteControlDiagnostics().at(-1)?.command === 'unmute' &&
      window.getMuteControlDiagnostics().at(-1)?.state === 'acknowledged').catch(async error => {
      console.error('Mute diagnostics:', await page.evaluate(() => ({diagnostics: getMuteControlDiagnostics(),
        notifications: testNotifications, devices: DEVICES.map(device => ({id: device._fasheId, muted: device.muted}))})),
      'commands:', commands);
      throw error;
    });
    assert.equal(receivers.every(receiver => receiver.devices.every(device => !device.muted)), true);
    assert.equal(state.authReads, authReadsBeforeMute, 'Ready mute/unmute must not introduce extra authorization GETs.');
    assert.equal(state.commandQueries, 0, 'A correlated pushed ACK must avoid a command status GET.');
    assert.deepEqual(commands.map(command => command.command), ['mute', 'unmute']);

    // Unknown receiver packets must not act on the other same-numbered CH.
    const beforeWrongTarget = receivers.map(receiver => receiver.reports.length);
    const wrongTarget = {...commands[0], receiver_id: 'FAshe-MAC-020000000099',
      receiver_ip: '192.0.2.99', receiver_mac: '02:00:00:00:00:99', device_id: 'FAshe-MAC-020000000099_ch1'};
    for (const receiver of receivers) receiver.context.handle('down', JSON.stringify(wrongTarget));
    assert.deepEqual(receivers.map(receiver => receiver.reports.length), beforeWrongTarget);
    assert.equal(receivers.every(receiver => receiver.devices.every(device => !device.muted)), true);

    const ids = await plan(h), otherId = ids[`${receivers[1].rid}_ch1`];
    const single = () => page.locator(`#fi_${otherId}`).locator('xpath=ancestor::tr').getByRole('button', {name: '下发', exact: true}).click();
    await single(); await page.locator('#datyConfirmDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#datyConfirmRows tr').count(), 1);
    assert.match(await page.textContent('#datyConfirmRows'), /192\.0\.2\.2/);
    assert.match(await page.textContent('#datyConfirmRows'), /655\.000/);
    assert.match(await page.textContent('#datyConfirmRows'), /658\.000/);
    assert.equal(commands.length, 2);
    await page.click('#datyConfirmCancel'); await page.waitForFunction(() => !DatyPlanningDeployment.isBusy());
    assert.equal(commands.length, 2, 'Single cancellation must send zero commands.');
    assert.equal(await page.locator('#datyProgressDialog').isVisible(), false);

    await single();
    const releaseSingle = h.gateNextAck(), singleRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/command');
    await page.click('#datyConfirmAccept'); await singleRequest;
    await page.locator('#datyProgressDialog').waitFor({state: 'visible'});
    assert.equal(await page.$eval('#datyProgressBar', bar => bar.value), 0);
    assert.equal(await page.evaluate(id => DEVICES.find(device => device.id === id).freq, otherId), 655000);
    assert.doesNotMatch(await page.textContent('#datyProgressTitle'), /成功/);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#datyProgressDialog').isVisible(), true);
    releaseSingle(); await page.waitForFunction(() => !DatyPlanningDeployment.isBusy());
    assert.equal(commands.length, 3); assert.match(await page.textContent('#datyProgressTitle'), /下发成功/);
    assert.equal(await page.$eval('#datyProgressBar', bar => bar.value), 1);
    await page.click('#datyProgressClose');

    await page.setViewportSize({width: 1024, height: 600}); await page.click('#plannerPushAll');
    await page.locator('#datyConfirmDialog').waitFor({state: 'visible'});
    assert.equal(await page.locator('#datyConfirmRows tr').count(), 3);
    assert.match(await page.textContent('#datyConfirmWarnings'), /扫描/);
    await page.click('#datyConfirmCancel'); await page.waitForFunction(() => !DatyPlanningDeployment.isBusy());
    assert.equal(commands.length, 3, 'Batch cancellation must send zero commands.');
    await page.click('#plannerPushAll');
    const releaseFirst = h.gateNextAck(), firstRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/command');
    await page.click('#datyConfirmAccept'); await firstRequest;
    assert.equal(await page.$eval('#datyProgressBar', bar => bar.value), 0);
    const releaseSecond = h.gateNextAck(), secondRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/command');
    releaseFirst(); await secondRequest;
    assert.equal(await page.$eval('#datyProgressBar', bar => bar.value), 2);
    assert.doesNotMatch(await page.textContent('#datyProgressTitle'), /成功/);
    releaseSecond(); await page.waitForFunction(() => !DatyPlanningDeployment.isBusy());
    assert.equal(commands.length, 5);
    assert.deepEqual(receivers.flatMap(receiver => receiver.devices.map(device => device.frequency)), [642, 647, 658]);
    assert.match(await page.textContent('#plannerDeployStatus'), /设备 ACK 2.*原频一致 1.*失败 0/);
    assert.equal(await page.$eval('#datyProgressBar', bar => bar.value), 3);
    await page.click('#datyProgressClose');
    await page.click('#plannerPushAll'); await page.click('#datyConfirmAccept');
    await page.waitForFunction(() => !DatyPlanningDeployment.isBusy());
    assert.equal(commands.length, 5); assert.match(await page.textContent('#datyProgressTitle'), /无需下发/);
    assert.doesNotMatch(await page.textContent('#datyProgressTitle'), /成功/);
    await page.click('#datyProgressClose');

    await page.setViewportSize({width: 1366, height: 768});
    await resetActual(h); state.nextAck = 'wrong-value';
    await page.click('#plannerPushAll'); await page.click('#datyConfirmAccept');
    await page.waitForFunction(() => !DatyPlanningDeployment.isBusy());
    assert.equal(commands.length, 6, 'A wrong ACK must stop the batch with no retry or later channel send.');
    assert.match(await page.textContent('#datyProgressTitle'), /下发失败/);
    assert.match(await page.textContent('#datyProgressRows'), /频率不匹配/);
    assert.match(await page.textContent('#plannerDeployStatus'), /设备 ACK 0.*失败 1.*未发送 2/);
    assert.equal(await page.$eval('#datyProgressBar', bar => bar.value), 0);
    assert.deepEqual(receivers.flatMap(receiver => receiver.devices.map(device => device.frequency)), [642, 645, 655]);
    await page.click('#datyProgressClose');

    await resetActual(h); state.nextAck = 'wrong-target'; await single(); await page.click('#datyConfirmAccept');
    await page.waitForFunction(() => !DatyPlanningDeployment.isBusy());
    assert.equal(commands.length, 7); assert.match(await page.textContent('#datyProgressTitle'), /下发失败/);
    assert.match(await page.textContent('#datyProgressRows'), /目标或命令不匹配/);
    assert.equal(await page.$eval('#datyProgressBar', bar => bar.value), 0);
    assert.equal(receivers[0].devices[0].frequency, 641, 'The receiver falsely named by a corrupted ACK must remain unchanged.');
    await page.click('#datyProgressClose');

    await resetActual(h);
    await page.evaluate(id => { DEVICES.find(device => device.id === id).capabilities.write_frequency = false; }, otherId);
    const unsupported = await page.evaluate(id => DatyPlanningDeployment.pushOne(id), otherId);
    assert.equal(unsupported.ok, false); assert.match(unsupported.error, /能力|只读/);
    assert.equal(commands.length, 7); assert.equal(await page.locator('#datyProgressDialog').isVisible(), false);
    await resetActual(h);
    await page.evaluate(id => { const device = DEVICES.find(device => device.id === id); device._online = false; device.status = 'offline'; }, otherId);
    const offline = await page.evaluate(id => DatyPlanningDeployment.pushOne(id), otherId);
    assert.equal(offline.ok, false); assert.match(offline.error, /离线|在线状态/); assert.equal(commands.length, 7);
    await resetActual(h); state.nextAck = 'disconnect'; await single(); await page.click('#datyConfirmAccept');
    await page.waitForFunction(() => !DatyPlanningDeployment.isBusy());
    assert.equal(commands.length, 8); assert.match(await page.textContent('#datyProgressTitle'), /下发失败/);
    assert.match(await page.textContent('#datyProgressRows'), /离线|会话/);
    assert.equal(await page.$eval('#datyProgressBar', bar => bar.value), 0);
    h.assertClean(); await h.context.close();

    for (const mode of ['read-only', 'unavailable']) {
      const denied = await harness(browser, mode);
      // Explicit refresh waits for either the server denial or the intercepted transport error.
      await denied.page.evaluate(() => DatyAccess.refresh().catch(() => null));
      assert.equal(await denied.page.evaluate(() => DatyAccess.snapshot().authenticated), false);
      const result = await denied.page.evaluate(async origin => {
        const response = await DatyAccess.request(origin + '/api/command', {method: 'POST',
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({command: 'mute'})});
        return {status: response.status, body: await response.json()};
      }, bridgeOrigin);
      assert.equal(result.status, 401); assert.equal(result.body.accepted, false);
      assert.equal(denied.commands.length, 0, 'Lack of server confirmation must never become local success.');
      denied.assertClean(); await denied.context.close();
    }
    console.log('PASS: original HTTPS page automatically confirms local development without a key; CH1 mute/unmute use exact unmodified FAshe ACK with no extra GET; original single/all confirmation, cancellation, ACK progress and unchanged skips; wrong value/target, missing capability and disconnect fail without retry or later sends; server denial/unavailability keeps controls blocked. All HTTP/WS/SSE isolated.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
