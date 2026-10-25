// node --test tests/protocol-status.test.cjs
// Isolated protocol card rendering; no device connections or commands.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'unirf-app.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/styles/main.css'), 'utf8');
const cardMarkup = [...html.matchAll(/<article class="card protocol-card"[\s\S]*?<\/article>/g)].map(match => match[0]);

function harness(devices = [], extra = []) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], {textContent:'', style:{}, dataset:{}}]));
  const cards = cardMarkup.map(markup => ({dataset:{
    protocolBrand:markup.match(/data-protocol-brand="([^"]+)"/)[1],
    protocolPrefix:markup.match(/data-protocol-prefix="([^"]+)"/)[1]
  }})).concat(extra.map(item => ({dataset:item})));
  for (const card of cards) for (const suffix of ['Connections', 'Status', 'Latency', 'Hint', 'Progress']) {
    const id = card.dataset.protocolPrefix + suffix;
    if (!elements.has(id)) elements.set(id, {textContent:'', style:{}, dataset:{}});
  }
  const context = vm.createContext({
    document:{readyState:'loading', addEventListener() {}, getElementById:id => elements.get(id),
      querySelectorAll:selector => { assert.equal(selector, '#devProto [data-protocol-brand][data-protocol-prefix]'); return cards; }},
    localStorage:{getItem:() => null}, performance:{now:() => 1000}, console
  });
  context.window = context;
  vm.runInContext('let DEVICES = [];', context);
  for (const module of ['dashboard', 'render']) vm.runInContext(fs.readFileSync(path.join(root, 'src/modules', module + '.js'), 'utf8'), context);
  return {context, elements, cards, text:id => elements.get(id).textContent,
    render(next = devices) { context.nextDevices = next; vm.runInContext('DEVICES = nextDevices; renderProtocolStatus();', context); }};
}
const device = (ip, ch, brand = 'DATYaudio', extra = {}) => ({
  id:`FAshe-${ip}_ch${ch}`, _fasheId:`FAshe-${ip}_ch${ch}`, receiver_ip:ip,
  channel_number:ch, brand, _online:true, status:'online', ...extra
});

test('DATY is first; original three brands and protocol fields are preserved', () => {
  const h = harness();
  assert.deepEqual(h.cards.map(card => card.dataset.protocolBrand), ['DATYaudio', 'AMSaudio', 'Shure', 'Sennheiser']);
  assert.match(cardMarkup[0], /MQTT \/ WS/);
  assert.match(cardMarkup[0], /HTTP \/ SSE/);
  assert.match(cardMarkup[1], /TCP 私有/);
  assert.match(cardMarkup[2], /TCP :2202/);
  assert.match(cardMarkup[2], /只读适配器/);
  assert.match(cardMarkup[3], /WS :45/);
  for (const markup of cardMarkup) {
    for (const section of ['head', 'count', 'details', 'footer', 'hint']) assert.ok(markup.includes('protocol-card-' + section));
    const expectedDetails = markup.includes('data-protocol-brand="Shure"') ? 7 : 3;
    assert.equal((markup.match(/<dt>/g) || []).length, expectedDetails);
    assert.doesNotMatch(markup, /style="[^"]*(?:height|width|margin-top):/);
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  for (const id of ids.filter(id => id.startsWith('proto'))) assert.equal(ids.filter(other => other === id).length, 1);
});

test('shared six-column layout keeps current and future cards equal without stretching empty slots', () => {
  assert.match(css, /\.protocol-grid\{[^}]*grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(css, /\.protocol-grid\{[^}]*grid-auto-rows:1fr/);
  const rule = css.match(/\.protocol-grid>\.protocol-card\{([^}]+)\}/)[1];
  for (const setting of ['margin:0', 'width:100%', 'min-width:0', 'height:100%']) assert.ok(rule.includes(setting));
  assert.match(css, /@container \(max-width:979px\).*repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /@container \(max-width:620px\).*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@container \(max-width:360px\).*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /\.protocol-card-head\{[^}]*flex-direction:column/);
  assert.doesNotMatch(css.match(/\.protocol-grid\{([^}]+)\}/)[1], /auto-fit/);
});

test('eight channels on one receiver count as one DATY receiver, not eight devices', () => {
  const h = harness(Array.from({length:8}, (_, i) => device('192.0.2.102', i + 1)));
  h.render();
  assert.equal(h.text('protoDatyConnections'), '1 台');
  assert.equal(h.text('protoDatyStatus'), '在线');
  assert.equal(h.elements.get('protoDatyStatus').dataset.online, 'true');
  assert.equal(h.elements.get('protoDatyProgress').style.width, '100%');
  for (const prefix of ['protoAms', 'protoShure', 'protoSenn']) assert.equal(h.text(prefix + 'Connections'), '0 台');
});

test('brand aliases, MAC identity, and different receivers with the same CH remain correct', () => {
  const h = harness([
    device('192.0.2.102', 1, 'DATY'), device('192.0.2.102', 2, 'daty audio'),
    device('192.0.2.103', 1, 'DATYaudio'),
    device('192.0.2.104', 1, 'AMSaudio', {receiver_mac:'AA:BB:CC:DD:EE:01'}),
    device('192.0.2.105', 2, 'AMSaudio', {receiver_mac:'AA:BB:CC:DD:EE:01'}),
    device('192.0.2.106', 1, 'shure'), device('192.0.2.107', 1, 'Senn')
  ]);
  h.render();
  assert.equal(h.text('protoDatyConnections'), '2 台');
  for (const prefix of ['protoAms', 'protoShure', 'protoSenn']) assert.equal(h.text(prefix + 'Connections'), '1 台');
  assert.match(h.text('protoShureHint'), /只读/);
});

test('offline flags and disconnection immediately clear online count and indicator', () => {
  const h = harness([device('192.0.2.102', 1)]); h.render();
  for (const state of [{_online:false}, {_online:'false'}, {status:'offline'}, {_online:0}]) {
    h.render([device('192.0.2.102', 1, 'DATYaudio', state)]);
    assert.equal(h.text('protoDatyConnections'), '0 台');
    assert.equal(h.text('protoDatyStatus'), '未连接');
    assert.equal(h.elements.get('protoDatyStatus').dataset.online, 'false');
    assert.equal(h.elements.get('protoDatyProgress').style.width, '0%');
  }
  h.render([]); assert.match(h.text('protoDatyHint'), /未发现在线/);
});

test('latency, packet loss, exclusive and event state are never fabricated', () => {
  const h = harness(['DATYaudio', 'AMSaudio', 'Shure', 'Sennheiser'].map((brand, i) => device('192.169.0.' + (102 + i), 1, brand)));
  h.render();
  for (const prefix of ['protoDaty', 'protoAms', 'protoShure', 'protoSenn']) assert.equal(h.text(prefix + 'Latency'), '—');
  assert.equal(h.text('protoAmsLoss'), '—');
  assert.equal(h.text('protoShureExclusive'), '状态未知');
  assert.equal(h.text('protoSennEvents'), '状态未知');
});

test('future brand cards automatically use the shared status renderer and safe text values', () => {
  const h = harness([device('192.0.2.108', 1, 'FutureAudio')], [{protocolBrand:'FutureAudio', protocolPrefix:'protoFuture'}]);
  h.render();
  assert.equal(h.text('protoFutureConnections'), '1 台');
  assert.equal(h.text('protoFutureStatus'), '在线');
  assert.equal(h.text('protoFutureLatency'), '—');
  h.render([]); assert.equal(h.text('protoFutureConnections'), '0 台');
});

function heartbeat(rtt, extra = {}) {
  return {source:'server_clock_ack', status:'measured', rtt_ms:rtt, age_ms:0, max_age_ms:20000, _receivedAt:1000, ...extra};
}

test('real RTT displays by brand, deduplicates channels and shows maximum and coverage', () => {
  const h = harness([
    device('192.0.2.102', 1, 'DATYaudio', {heartbeat:heartbeat(12.3)}),
    device('192.0.2.102', 2, 'DATYaudio', {heartbeat:heartbeat(200, {age_ms:1000})}),
    device('192.0.2.103', 1, 'DATYaudio', {heartbeat:heartbeat(30)}),
    device('192.0.2.104', 1, 'DATYaudio'),
    device('192.0.2.105', 1, 'AMSaudio', {heartbeat:heartbeat(5)})
  ]);
  h.render();
  assert.equal(h.text('protoDatyLatency'), '30.0 ms');
  assert.match(h.elements.get('protoDatyLatency').title, /平均 21.1 ms/);
  assert.match(h.text('protoDatyHint'), /RTT 已测 2\/3 台（显示最大值）/);
  assert.equal(h.text('protoAmsLatency'), '5.0 ms');
  assert.equal(h.text('protoShureLatency'), '—');
});

test('zero RTT is valid, invalid or expired samples and offline devices are not displayed', () => {
  const h = harness();
  for (const raw of [null, false, -1, NaN, Infinity, '12']) {
    h.render([device('192.0.2.102', 1, 'DATYaudio', {heartbeat:heartbeat(raw)})]);
    assert.equal(h.text('protoDatyLatency'), '—');
  }
  h.render([device('192.0.2.102', 1, 'DATYaudio', {heartbeat:heartbeat(0)})]);
  assert.equal(h.text('protoDatyLatency'), '0.0 ms');
  h.context.performance.now = () => 21001;
  h.render([device('192.0.2.102', 1, 'DATYaudio', {heartbeat:heartbeat(0)})]);
  assert.equal(h.text('protoDatyLatency'), '—');
  assert.match(h.text('protoDatyHint'), /已过期/);
  h.context.performance.now = () => 1000;
  h.render([device('192.0.2.102', 1, 'DATYaudio', {heartbeat:heartbeat(10), _online:false})]);
  assert.equal(h.text('protoDatyLatency'), '—');
  assert.equal(h.elements.get('protoDatyLatency').title, '未连接接收机');
});

test('normalizer anchors server sample age to browser monotonic time and clears missing samples', () => {
  const h = harness();
  const normalized = h.context.normalizeReceiverHeartbeat(heartbeat(5, {age_ms:19000, _receivedAt:-100}));
  assert.equal(normalized._receivedAt, 1000);
  h.context.performance.now = () => 2001;
  h.render([device('192.0.2.102', 1, 'DATYaudio', {heartbeat:normalized})]);
  assert.equal(h.text('protoDatyLatency'), '—');
  assert.equal(h.context.normalizeReceiverHeartbeat(null), null);
  assert.equal(h.context.normalizeReceiverHeartbeat({source:'browser_health', rtt_ms:2}), null);
});

test('SSE list and incremental ACK snapshots carry RTT through production device mapping', () => {
  const h = harness();
  for (const module of ['frequency', 'discovery', 'fashe']) vm.runInContext(fs.readFileSync(path.join(root, 'src/modules', module + '.js'), 'utf8'), h.context);
  h.context._fasheUpdateUI = h.context.renderProtocolStatus;
  h.context._rebuildReceiversFromDevices = () => {};
  h.context.notify = () => {};
  const raw = device('192.0.2.102', 1, 'DATYaudio', {heartbeat:heartbeat(17.4), freq:620000});
  h.context._fasheHandleDeviceList([raw]);
  assert.equal(h.text('protoDatyLatency'), '17.4 ms');
  h.context._fasheHandleDeviceUpdate([{...raw, heartbeat:heartbeat(8)}]);
  assert.equal(h.text('protoDatyLatency'), '8.0 ms');
  h.context._fasheHandleDeviceUpdate([{...raw, heartbeat:heartbeat(null, {status:'stale'})}]);
  assert.equal(h.text('protoDatyLatency'), '—');
});

test('server HTTP snapshot mapping preserves RTT and clears it for older servers without measurements', () => {
  const h = harness();
  for (const module of ['frequency', 'discovery', 'fashe']) vm.runInContext(fs.readFileSync(path.join(root, 'src/modules', module + '.js'), 'utf8'), h.context);
  h.context.forceRefreshAllPanels = h.context.renderProtocolStatus;
  const raw = device('192.0.2.102', 1, 'DATYaudio', {heartbeat:heartbeat(20), freq:620000});
  h.context._onServerData({type:'device_list', devices:[raw]});
  assert.equal(h.text('protoDatyLatency'), '20.0 ms');
  delete raw.heartbeat;
  h.context._onServerData({type:'device_list', devices:[raw]});
  assert.equal(h.text('protoDatyLatency'), '—');
});
