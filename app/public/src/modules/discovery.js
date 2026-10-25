// ============================================================
// discovery.js — 局域网服务器发现、WSS/HTTPS连接管理（不允许明文回退）
// ============================================================

async function _discoveryRequest(url, options) {
  const platform = globalThis.DatyPlatform;
  if (platform !== undefined) {
    if (!platform || typeof platform.request !== 'function') throw new Error('DatyPlatform.request unavailable');
    return platform.request(url, options);
  }
  return globalThis.fetch(url, options);
}

function _discoveryRuntime(method, ...args) {
  if (globalThis.DatyHostFactory) return globalThis.DatyHostFactory.invokeRuntime(globalThis, method, ...args);
  // Legacy standalone browser fixtures only. Explicit native hosts must provide the port.
  if (globalThis.DatyPlatform !== undefined && globalThis.DatyPlatform?.kind !== 'browser') throw new Error('DatyHostRuntime unavailable');
  if (method === 'nowEpochMs') return Date.now();
  if (method === 'nowMonotonicMs') return globalThis.performance.now();
  return globalThis[method](...args);
}

let _serverGeneration = 0;
let _serverRetryTimer = null;
let _serverWsTimer = null;
function _isCurrentServer(server, generation) {
  return generation === _serverGeneration && _connectedServer?.ip === server.ip;
}
function _clearServerTransport() {
  // Invalidate before close: a synchronous onclose cannot restart a cancelled connection.
  _serverGeneration++;
  for (const timer of [_heartbeatTimer, _httpPollTimer]) {
    if (timer !== null) _discoveryRuntime('clearInterval', timer);
  }
  for (const timer of [_serverRetryTimer, _serverWsTimer]) {
    if (timer !== null) _discoveryRuntime('clearTimeout', timer);
  }
  _heartbeatTimer = _httpPollTimer = _serverRetryTimer = _serverWsTimer = null;
  const ws = _datyWS;
  _datyWS = null;
  if (ws) { try { ws.close(); } catch (_) {} }
}

function _rawDeviceFrequencyKHz(device) {
  return DatyFrequency.frequencyFromPayload(device);
}

function _rawDeviceAf(device) {
  // 桥接器/旧服务器可能使用多种字段名；显式 dBFS 字段优先于旧版百分比 af。
  const explicitFields = ['afDbfs', 'af_dbfs', 'afLevel', 'af_level'];
  let dbfs;
  let explicitPresent = false;
  for (const field of explicitFields) {
    if (!Object.prototype.hasOwnProperty.call(device, field)) continue;
    explicitPresent = true;
    const raw = device[field];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = _readFiniteTelemetry(raw);
    if (value !== null && value >= -40 && value <= 0) { dbfs = value; break; }
  }
  if (dbfs === undefined && explicitPresent) return { dbfs: -40, percent: 0, available: false };
  if (dbfs === undefined) {
    const rawAf = device.af;
    const af = _readFiniteTelemetry(rawAf);
    if (Number.isFinite(af)) {
      // 直传的负值 af 为 dBFS；正值兼容旧版 0～100 百分比。
      // 带实时来源标记的 af=0 按协议解释为 0 dBFS（满量程），而不是旧百分比 0%。
      const realtime = !!(device.id || device._fasheId || device._source || device.receiver_id || device.receiverId || device.afUnit === 'dBFS' || device.af_unit === 'dBFS');
      if (realtime && af > 0) {
        // 实时协议中的 af 已固定为 dBFS；正值不是可转换的百分比。
        dbfs = NaN;
      } else {
        dbfs = af < 0 || (realtime && af === 0) ? af : -40 + Math.max(0, Math.min(100, af)) * 0.4;
      }
    }
  }
  const available = Number.isFinite(dbfs);
  // AF 协议合法范围为 -40～0 dBFS；越界值视为未知，不参与告警比较。
  if (available && (dbfs < -40 || dbfs > 0)) return { dbfs: -40, percent: 0, available: false };
  if (!available) dbfs = -40;
  dbfs = Math.max(-40, Math.min(0, dbfs));
  return { dbfs, percent: Math.round((dbfs + 40) / 40 * 100), available };
}

// ══════════════════════════════════════════════════════════════════
// DATY RF PRO 局域网服务器自动发现 & 连接管理
// 架构: ip-service.py /api/discover → 轮询进度 → 展示服务器列表 → 建立连接
// ══════════════════════════════════════════════════════════════════

const DATY_WS_PORT       = 8801;   // DATY RF PRO WebSocket API 端口
const DATY_TCP_PORT      = 8800;   // AMSaudio TCP 协议端口
const MQTT_HTTP_PORT     = 8802;   // mqtt-bridge HTTP API 端口

let _datyWS        = null;         // 当前 WebSocket 连接
let _connectedServer     = null;       // 已连接的服务器信息
let _serverTransportConfirmed = false; // Discovery / connection intent is not a successful TLS handshake.
let _heartbeatTimer      = null;       // 心跳计时器
let _discoveredReceivers = [];         // 扫描发现的接收机列表（含通道卡片）

// 记录每台已连接服务器最近一次“全量设备快照”包含的通道。
// 空快照到达时据此只处理该服务器管理的设备，不影响其它来源或手工设备。
const _serverSnapshotDevices = new Map();

function _normalizeServerIdentity(value) {
  if (value === null || value === undefined) return '';
  let text = String(value).trim().toLowerCase();
  if (!text) return '';
  text = text.replace(/^[a-z][a-z\d+.-]*:\/\//, '').split('/')[0];
  // 常见 host:port / IPv4:port 形式统一到 host；IPv6 用方括号时保留其地址。
  if (!text.startsWith('[')) {
    const parts = text.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) text = parts[0];
  } else {
    text = text.replace(/^\[|\]$/g, '');
  }
  return text;
}

function _serverSnapshotIdentity(data) {
  const values = [];
  const add = value => {
    if (value === null || value === undefined) return;
    if (typeof value === 'object') {
      add(value.ip || value.host || value.address || value.server_ip || value.serverIp);
    } else {
      const normalized = _normalizeServerIdentity(value);
      if (normalized && !values.includes(normalized)) values.push(normalized);
    }
  };
  add(data?.server_ip);
  add(data?.serverIp);
  // 连接对象是最可靠的归属；消息中的 source 有时只是 "ws"/"sse" 等传输标签。
  add(_connectedServer?.ip);
  add(data?.server);
  add(data?.source);
  add(data?._source);
  add(data?.ip);
  add(data?.receiver_ip);
  return values[0] || '';
}

function _serverDeviceKey(device) {
  const fasheId = String(device?._fasheId ?? '').trim();
  if (fasheId) return `fashe:${fasheId}`;
  const id = String(device?.id ?? '').trim();
  return id ? `id:${id}` : '';
}

function _deviceMatchesServerIdentity(device, owner) {
  if (!device || !owner) return false;
  const candidates = [
    device._serverOwner, device._source, device.ip, device.receiverId,
    device.receiver_id, device.serverIp, device.server_ip,
  ];
  return candidates.some(value => {
    const normalized = _normalizeServerIdentity(value);
    return normalized && (normalized === owner || normalized.startsWith(`${owner}:`) || owner.startsWith(`${normalized}:`));
  });
}

function _markServerSnapshotOffline(owner) {
  if (!owner) return false;
  const tracked = _serverSnapshotDevices.get(owner);
  // 处理一次后清除快照索引；重复空轮询不会反复重绘，下一次非空快照会重新建立索引。
  _serverSnapshotDevices.delete(owner);
  let changed = false;
  DEVICES.forEach(device => {
    const key = _serverDeviceKey(device);
    const hasExplicitOwner = [device?._serverOwner, device?._source, device?.ip, device?.receiverId, device?.receiver_id, device?.serverIp, device?.server_ip]
      .some(value => _normalizeServerIdentity(value));
    const belongs = (tracked && key && tracked.has(key) && (!hasExplicitOwner || _deviceMatchesServerIdentity(device, owner)))
      || _deviceMatchesServerIdentity(device, owner);
    if (!belongs) return;
    if (device._online !== false || String(device.status || '').toLowerCase() !== 'offline') {
      device._online = false;
      device.status = 'offline';
      changed = true;
    }
  });
  return changed;
}

function _isFullServerSnapshot(data) {
  if (data?.full_snapshot === false || data?.fullSnapshot === false || data?.partial === true || data?.incremental === true) return false;
  const type = String(data?.type || data?.event || data?.message_type || '').toLowerCase();
  return !['device_delta', 'devices_delta', 'telemetry_delta', 'incremental_update', 'patch'].includes(type);
}

/** 删除上一次全量快照中已不存在的服务器通道，避免通道卡/告警残留。 */
function _reconcileServerSnapshot(owner, currentKeys) {
  if (!owner || !(currentKeys instanceof Set)) return 0;
  const previous = _serverSnapshotDevices.get(owner);
  if (!(previous instanceof Set) || previous.size === 0) return 0;
  const staleKeys = new Set([...previous].filter(key => !currentKeys.has(key)));
  if (staleKeys.size === 0) return 0;
  const kept = [];
  let removed = 0;
  DEVICES.forEach(device => {
    const key = _serverDeviceKey(device);
    const explicitOwner = _normalizeServerIdentity(device?._serverOwner);
    const serverManaged = device?._serverManaged === true || device?._serverOwner !== undefined;
    const ownedBySnapshot = explicitOwner
      ? explicitOwner === owner
      : (serverManaged ? _deviceMatchesServerIdentity(device, owner) : (!device?._source && _deviceMatchesServerIdentity(device, owner)));
    if (key && staleKeys.has(key) && ownedBySnapshot) {
      removed += 1;
    } else {
      kept.push(device);
    }
  });
  if (removed > 0) {
    DEVICES.splice(0, DEVICES.length, ...kept);
  }
  return removed;
}

// ── 扫描接收机 ────────────────────────────────────────────────────────
let _receiverScanBusy = false;
let _receiverCardScope = '';
let _receiverCards = [];
let _receiverCardRevision = 0;
let _receiverCardMarkup = null;
let _receiverCardLiveScope = '';

function _receiverCardBase() {
  const selected = typeof _fasheApiUrl === 'string' ? _fasheApiUrl : '';
  return selected || globalThis.DatyPlatformFactory.serviceOrigin('bridge', globalThis.location?.hostname);
}

// Discovery stores the Shure MAC in settings; live channels expose receiver_mac.
// Normalize this view only: do not rewrite device IDs, GROUPs or control targets.
function _normalizeReceiverCard(receiver) {
  const channels = Array.isArray(receiver.channels) ? receiver.channels : [];
  const values = [receiver, receiver.settings || {}, ...channels];
  const macs = new Set(values.flatMap(value => [value.receiver_mac, value.receiverMac, value.mac_address, value.mac])
    .map(value => String(value || '').replace(/[:-]/g, '').toLowerCase())
    .filter(value => /^[0-9a-f]{12}$/.test(value)));
  const card = {...receiver, channels};
  if (macs.size === 1) card.receiver_mac = [...macs][0].match(/../g).join(':');
  card._identityConflict = macs.size > 1;
  return card;
}

function _receiverCardSource(receiver) {
  const base = receiver.http_base || _receiverCardBase();
  try { return new URL(base).href.replace(/\/$/, ''); } catch (_) { return base; }
}

function _receiverCardsMatch(a, b) {
  if (_receiverCardSource(a) !== _receiverCardSource(b) || a._identityConflict || b._identityConflict) return false;
  if (a.receiver_mac && b.receiver_mac) return a.receiver_mac === b.receiver_mac;
  const id = r => String(r.receiver_id || r.receiverId || '').trim().toLowerCase();
  // An endpoint alone cannot join a known chassis to another/unknown chassis.
  if (id(a) && id(b)) return id(a) === id(b);
  if (a.receiver_mac || b.receiver_mac) return false;
  return !!_serverReceiverKey(a) && _serverReceiverKey(a) === _serverReceiverKey(b);
}

function _coalesceReceiverCards(receivers) {
  const entries = receivers.map((card, order) => ({card:_normalizeReceiverCard(card), order}));
  // Resolve strong identities first, so an ambiguous ID-only result cannot bridge two MACs.
  entries.sort((a,b) => Number(!!b.card.receiver_mac) - Number(!!a.card.receiver_mac));
  const groups = [];
  for (const entry of entries) {
    const matches = groups.filter(g => _receiverCardsMatch(g.card, entry.card));
    if (matches.length !== 1) { groups.push(entry); continue; }
    const group = matches[0], channels = [...group.card.channels];
    for (const channel of entry.card.channels) {
      const key = _serverChannelKey(channel.channel_number ?? channel.channel_no ?? channel.channel ?? channel.ch ?? channel.channel_key);
      if (key && !channels.some(d => _serverChannelKey(d.channel_number ?? d.channel_no ?? d.channel ?? d.ch ?? d.channel_key) === key)) channels.push(channel);
    }
    group.card = _normalizeReceiverCard({...entry.card, ...group.card, channels});
    group.order = Math.min(group.order, entry.order);
  }
  return groups.sort((a,b) => a.order-b.order).map(entry => entry.card);
}

function _receiverControlSummary(receiver) {
  const channels = receiver.channels || [];
  const online = channels.filter(d => d._online !== false && d.status !== 'offline' &&
    (typeof _deviceConnectionIsOnline === 'function' ? _deviceConnectionIsOnline(d) : d._online === true || d.status === 'online'));
  if (receiver._displayOffline || (channels.length && !online.length)) {
    return {label:'离线', detail:'上次数据 · 恢复在线后重新确认控制能力', readOnly:true};
  }
  if (!online.length || receiver._identityConflict) return {label:'能力待确认', detail:'等待服务器确认在线身份与通道能力', readOnly:true};
  const supports = (d, key) => d.capabilities?.read_only !== true && d.capabilities?.[key] === true;
  const fresh = (d, field) => !(d.shure?.stale_fields || []).includes(field);
  const mute = online.filter(d => supports(d,'mute') && fresh(d,'muted'));
  const frequency = online.filter(d => supports(d,'write_frequency') && fresh(d,'frequency_khz'));
  const controllable = online.filter(d => mute.includes(d) || frequency.includes(d));
  if (controllable.length) return {
    label:controllable.length === channels.length ? '可控' : '部分通道可控',
    detail:[frequency.length ? '调频' : '', mute.length ? '输出静音' : ''].filter(Boolean).join(' / ') + ' · 下发后回读确认', readOnly:false,
  };
  if (online.some(d => supports(d,'mute') || supports(d,'write_frequency'))) return {label:'状态待更新', detail:'控制状态已过期 · 等待实时回读', readOnly:true};
  if (online.some(d => !d.capabilities || !('read_only' in d.capabilities || 'mute' in d.capabilities || 'write_frequency' in d.capabilities)))
    return {label:'能力待确认', detail:'等待服务器上报通道控制能力', readOnly:true};
  return {label:'只读', detail:'当前通道仅支持监测', readOnly:true};
}

// View-only last confirmed cards. These never become planner/control targets or browser persistence.
function _rememberReceiverCards(receivers, {missingOffline = true, preferCurrentChannels = false, source = _receiverCardBase()} = {}) {
  const scope = _receiverCardBase();
  if (scope !== _receiverCardScope) { _receiverCards = []; _receiverCardScope = scope; }
  const previous = _coalesceReceiverCards(_receiverCards);
  const incoming = _coalesceReceiverCards(receivers);
  const next = incoming.map(r => {
    const matches = previous.filter(old => _receiverCardsMatch(old, r));
    const old = matches.length === 1 && incoming.filter(item => _receiverCardsMatch(matches[0], item)).length === 1 ? matches[0] : null;
    if (old) previous.splice(previous.indexOf(old), 1);
    const keepCurrent = preferCurrentChannels && old;
    const channels = (keepCurrent ? old.channels : r.channels).map(d => ({...d}));
    return _normalizeReceiverCard({...old, ...r, channels, _displayOffline: (keepCurrent ? old._displayOffline : r._displayOffline) === true ||
      (channels.length > 0 && channels.every(d => d._online === false || d.status === 'offline'))});
  });
  for (const r of previous) next.push(missingOffline && (!source || _receiverCardSource(r) === _receiverCardSource({http_base:source})) ? {...r, _displayOffline: true,
    channels: r.channels.map(d => ({...d, _online:false, status:'offline'}))} : r);
  if (typeof getPlannerReceiverGroupNumber === 'function') {
    const group = r => Math.min(...r.channels.map(d => getPlannerReceiverGroupNumber(d) ?? Infinity));
    next.sort((a,b) => group(a) - group(b) || 0);
  }
  _receiverCards = next;
  _receiverCardRevision++;
  const list = document.getElementById('discoveredReceivers'), empty = document.getElementById('recvEmpty');
  if (list) list.style.display = next.length ? '' : 'none';
  if (empty) empty.style.display = next.length ? 'none' : '';
  _renderReceiverList(next);
}

function _refreshReceiverCardsFromLiveState() {
  if (typeof DEVICES === 'undefined') return;
  // Until the new connection supplies its full snapshot, DEVICES may still
  // contain channels belonging to the previous server. Do not relabel those.
  if (_receiverCardLiveScope !== _receiverCardBase()) {
    _rememberReceiverCards([], {missingOffline:false}); return;
  }
  _rememberReceiverCards(_groupReceiversFromDevices(DEVICES.filter(d => d._fasheId && !d._serverManaged)));
}

async function _shureDiscoveryJson(baseUrl, action, isCurrent, method = 'GET') {
  if (!isCurrent()) throw new Error('服务器已切换，旧扫描结果已忽略');
  const controller = new AbortController();
  const timer = _discoveryRuntime('setTimeout', () => controller.abort(), 5000);
  try {
    const intent=method==='POST'?await globalThis.DatyMqttDiscoveryIntent(baseUrl,action):null;
    if(!isCurrent())throw new Error('服务器已切换，旧扫描请求已取消');
    const response = await _discoveryRequest(baseUrl + '/api/discovery/shure/' + action, {
      method, redirect: 'error', signal: controller.signal,
      ...(method === 'POST' ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(intent)} : {}),
    });
    if (action === 'status' && response.status === 404) return null;
    if (!response.ok) throw new Error(`舒尔扫描请求失败 (${response.status})`);
    const data = await response.json();
    if (!isCurrent()) throw new Error('服务器已切换，旧扫描结果已忽略');
    if (!data.success || data.protocol !== 'daty-shure-discovery-v1') throw new Error('服务器未返回有效的舒尔扫描状态');
    return data;
  } finally { _discoveryRuntime('clearTimeout', timer); }
}

async function _scanShureReceivers(baseUrl, isCurrent, onProgress) {
  let state = await _shureDiscoveryJson(baseUrl, 'status', isCurrent);
  if (!state) return '此服务器尚未启用舒尔主动发现';
  if (!state.enabled) return '舒尔主动发现已关闭';
  // Never retry a POST with an uncertain result; subsequent requests only read status.
  state = await _shureDiscoveryJson(baseUrl, 'scan', isCurrent, 'POST');
  const started = _discoveryRuntime('nowMonotonicMs');
  for (let attempt = 0; state.scanning && attempt < 35; attempt++) {
    onProgress(`正在扫描舒尔接收机 ${state.scanned}/${state.targets || '…'}`);
    if (_discoveryRuntime('nowMonotonicMs') - started >= 35000) break;
    await new Promise(resolve => _discoveryRuntime('setTimeout', resolve, 1000));
    state = await _shureDiscoveryJson(baseUrl, 'status', isCurrent);
    if (!state) throw new Error('舒尔扫描服务已改变');
  }
  const scopes = (state.scopes || []).map(s => s.scan_network).join('、');
  const outcome = state.error || (state.cancelled ? '扫描已取消' : state.scanning ? '扫描仍在服务器后台进行' : `舒尔扫描完成，当前发现 ${state.count} 台`);
  return outcome + (scopes ? `；范围 ${scopes}` : '') +
    ((state.scopes || []).some(s => s.limited_to_24) ? '（当前 /24，未覆盖整个子网）' : '');
}

async function scanForReceivers({passive = false, quiet = false} = {}) {
  if (_receiverScanBusy) return;
  _receiverScanBusy = true;
  const cardsAtStart = _receiverCardRevision;
  const generation = _serverGeneration;
  const sourceAtStart = typeof _fasheApiUrl === 'string' ? _fasheApiUrl : '';
  const isCurrent = () => generation === _serverGeneration && sourceAtStart === (typeof _fasheApiUrl === 'string' ? _fasheApiUrl : '');
  const btn    = document.getElementById('btnRecvScan');
  const dot    = document.getElementById('recvScanDot');
  const status = document.getElementById('recvScanStatusText');
  const hint   = document.getElementById('recvScanHint');
  const list   = document.getElementById('discoveredReceivers');
  const empty  = document.getElementById('recvEmpty');

  try {
  if (btn) btn.disabled = true;
  if (btn) btn.textContent = '⏳ 查询中...';
  if (dot) dot.className = 'dot dot-amber';
  if (status) status.textContent = '正在查询...';
  if (hint) hint.style.display = 'none';
  // Keep the last confirmed cards visible while refreshing; a scan is not a disconnect.
  if (empty) empty.style.display = 'none';

  // 尝试从已连接的服务器获取接收机列表
  const sources = [];

  // 优先：使用当前 FAshe API 地址（即 mqtt-bridge 地址）
  if (_fasheApiUrl) {
    sources.push(globalThis.DatyPlatformFactory.normalizeBridgeUrl(_fasheApiUrl));
  }

  // 次选：使用已连接的服务器
  if (_connectedServer && _connectedServer.ip) {
    const url = globalThis.DatyPlatformFactory.serviceOrigin('bridge', _connectedServer.ip);
    if (!sources.includes(url)) sources.push(url);
  }

  // 最终备选：使用默认地址
  if (sources.length === 0) {
    sources.push(globalThis.DatyPlatformFactory.serviceOrigin('bridge', globalThis.location?.hostname));
  }

  const allReceivers = [];
  const scanNotes = [];
  const t0 = _discoveryRuntime('nowMonotonicMs');

  for (const baseUrl of sources) {
    try {
      try {
        if (!passive) scanNotes.push(await _scanShureReceivers(baseUrl, isCurrent, text => {
          if (isCurrent() && status) status.textContent = text;
        }));
      } catch (error) { scanNotes.push(error.message || '舒尔扫描未完成'); }
      if (!isCurrent()) return;
      const controller = new AbortController();
      const timer = _discoveryRuntime('setTimeout', () => controller.abort(), 5000);

      // 并行请求 stats（clients）和 devices（通道卡片数据）
      let statsResp, devResp;
      try {
        [statsResp, devResp] = await Promise.all([
          _discoveryRequest(baseUrl + '/api/stats', { redirect: 'error', signal: controller.signal }),
          _discoveryRequest(baseUrl + '/api/devices', { redirect: 'error', signal: controller.signal }),
        ]);
      } finally { _discoveryRuntime('clearTimeout', timer); }

      if (!statsResp.ok || !devResp.ok) throw new Error('读取接收机列表失败');
      const statsData = await statsResp.json();
      const devData   = await devResp.json();
      if (!isCurrent()) return;
      if (statsData.success !== true || devData.success !== true || !Array.isArray(devData.devices)) throw new Error('接收机快照格式无效');

      // 构建设备“接收机身份 -> 通道列表”映射。_source 是随机 MQTT
      // 会话，不能作为接收机身份；优先使用 MAC，再用 IP/receiver_id。
      const devicesByReceiver = new Map();
      const receiverAliasIndex = new Map();
      if (devData.success && devData.devices) {
        for (const d of devData.devices) {
          const key = _serverReceiverKey(d) || _normalizeServerIdentity(d.receiver_ip || d.ip);
          if (!key) continue;
          if (!devicesByReceiver.has(key)) devicesByReceiver.set(key, []);
          const list = devicesByReceiver.get(key);
          const channelKey = _serverChannelKey(d.channel_number ?? d.channel_no ?? d.channel ?? d.ch ?? d.channel_key);
          if (channelKey && !list.some(item => _serverChannelKey(item.channel_number ?? item.channel_no ?? item.channel ?? item.ch ?? item.channel_key) === channelKey)) {
            list.push(d);
          }
          if (typeof getReceiverIdentityAliases === 'function') {
            getReceiverIdentityAliases(d).forEach(alias => receiverAliasIndex.set(alias, key));
          }
          receiverAliasIndex.set(key, key);
        }
      }

      // 构建 Broker 在线 client IP 集合（双重验证）
      const brokerOnlineIPs = new Set();
      if (statsData.broker && statsData.broker.client_list) {
        for (const bc of statsData.broker.client_list) {
          const bcIP = String(bc.addr || '').match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0] || '';
          if (bcIP) brokerOnlineIPs.add(bcIP);
        }
      }

      const receiversByKey = new Map();
      if (statsData.success && statsData.clients) {
        for (const c of statsData.clients) {
          // 后端已做 TTL 过期清理，前端再交叉验证 Broker 实际连接状态
          const clientAddr = c.addr || '';
          const realIP = [c.receiver_ip, c.receiverIp, c.ip, clientAddr]
            .map(value => String(value || '').match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0] || '')
            .find(Boolean) || '';
          if (!realIP) continue;
          // 如果 Broker 有在线客户端列表，且该 IP 不在其中，则跳过
          if (brokerOnlineIPs.size > 0 && !brokerOnlineIPs.has(realIP)) continue;
          const clientIdentity = {receiver_id: c.receiver_id, receiver_mac: c.receiver_mac || c.mac_address, receiver_ip: realIP, ip: realIP};
          const clientAliases = typeof getReceiverIdentityAliases === 'function'
            ? getReceiverIdentityAliases(clientIdentity) : new Set([`ip:${realIP}`]);
          const receiverCandidates = [
            _serverReceiverKey(clientIdentity), ...clientAliases,
          ].filter(Boolean);
          let receiverKey = receiverCandidates.map(value => receiverAliasIndex.get(value) || value)
            .find(key => devicesByReceiver.has(key));
          let channels = receiverKey ? devicesByReceiver.get(receiverKey) : [];
          if (channels.length === 0) {
            // 兼容旧快照中 receiver_id 尚未公开的情况，按纯 IP 过滤。
            channels = [...devData.devices || []].filter(d =>
              String(d.receiver_ip || d.ip || '') === String(realIP)
              && !!_serverChannelKey(d.channel_number ?? d.channel_no ?? d.channel ?? d.ch ?? d.channel_key));
          }
          receiverKey = receiverKey || _serverReceiverKey(clientIdentity) || `ip:${realIP}`;
          if (!receiversByKey.has(receiverKey)) receiversByKey.set(receiverKey, {
            ip:            realIP,
            receiver_id:  c.receiver_id || '',
            receiver_mac: c.receiver_mac || c.mac_address || '',
            connected_at:  c.connected_at || '',
            message_count: c.message_count || 0,
            source:        clientAddr,
            server_ip:     new URL(baseUrl).hostname,
            channels:      channels,
            http_base:     baseUrl,
          });
          else {
            const current = receiversByKey.get(receiverKey);
            const merged = [...current.channels];
            channels.forEach(channel => {
              const channelKey = _serverChannelKey(channel.channel_number ?? channel.channel_no ?? channel.channel ?? channel.ch ?? channel.channel_key);
              if (channelKey && !merged.some(item => _serverChannelKey(item.channel_number ?? item.channel_no ?? item.channel ?? item.ch ?? item.channel_key) === channelKey)) merged.push(channel);
            });
            current.channels = merged;
            if (!current.receiver_id && c.receiver_id) current.receiver_id = c.receiver_id;
            if (!current.receiver_mac && (c.receiver_mac || c.mac_address)) current.receiver_mac = c.receiver_mac || c.mac_address;
          }
        }
      }
      for (const r of statsData.external_receivers || []) {
        if (r.discovered_via !== 'shure-scp' || !r.receiver_id || !r.ip) continue;
        // External receivers have no MQTT client; use actual Bridge channels only.
        const channels = (devData.devices || []).filter(d => d.receiver_id === r.receiver_id && d._online === true);
        receiversByKey.set(`shure:${r.receiver_id}`, {
          ...r, id: r.receiver_id, channels, http_base: baseUrl,
          server_ip: new URL(baseUrl).hostname,
        });
      }
      // A just-registered or offline channel may have no current MQTT client entry.
      // Recover it from the actual server snapshot, never from local history/manual devices.
      for (const r of _groupReceiversFromDevices(devData.devices || [], baseUrl)) {
        if (![...receiversByKey.values()].some(existing => _receiverCardsMatch(_normalizeReceiverCard(existing), _normalizeReceiverCard(r)))) {
          receiversByKey.set(_serverReceiverKey(r), r);
        }
      }
      allReceivers.push(...receiversByKey.values());
    } catch(e) {
      scanNotes.push('接收机列表读取失败：' + new URL(baseUrl).hostname);
    }
  }
  if (!isCurrent()) return;

  // Same-source discovery and live identities share one card; never collapse different servers/MACs.
  const uniqueReceivers = _coalesceReceiverCards(allReceivers);
  allReceivers.length = 0;
  allReceivers.push(...uniqueReceivers);

  const elapsed = ((_discoveryRuntime('nowMonotonicMs') - t0) / 1000).toFixed(1);
  if (btn) { btn.disabled = false; btn.textContent = '🔍 扫描接收机'; }

  if (allReceivers.length > 0) {
    if (dot) dot.className = 'dot dot-green';
    const totalCh = allReceivers.reduce((s, r) => s + r.channels.length, 0);
    if (status) status.textContent = `发现 ${allReceivers.length} 台接收机，${totalCh} 个通道，耗时 ${elapsed}s`;
    if (list) list.style.display = '';
    _rememberReceiverCards(allReceivers, {preferCurrentChannels:_receiverCardRevision!==cardsAtStart,
      missingOffline:_receiverCardRevision===cardsAtStart, source:null});
    if (!quiet) notify('🎤', '发现接收机', `共发现 ${allReceivers.length} 台接收机，${totalCh} 个通道`);

    // 存储并更新频率规划的目标通道数
    _discoveredReceivers = allReceivers;
    _updateTargetChannelSelect(totalCh, allReceivers.length);
  } else {
    _discoveredReceivers = [];
    _updateTargetChannelSelect(0, 0);
    if (dot) dot.className = 'dot dot-amber';
    if (status) status.textContent = `未发现接收机，耗时 ${elapsed}s`;
    _rememberReceiverCards([], {missingOffline:_receiverCardRevision===cardsAtStart, source:null});
  }
  if (hint && scanNotes.length) {
    hint.textContent = [...new Set(scanNotes)].join('；');
    hint.style.display = '';
  }
  } catch (error) {
    if (isCurrent() && status) status.textContent = error.message || '扫描未完成';
  } finally {
    _receiverScanBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '🔍 扫描接收机'; }
  }
}

// ── 切换面板时刷新频率规划的目标通道数 ─────────────────────────────────
function _refreshPlannerChannelSelect() {
  // 优先用已发现的接收机列表，否则从当前 DEVICES 聚合
  if (_discoveredReceivers.length > 0) {
    const totalCh = _discoveredReceivers.reduce((s, r) => s + r.channels.length, 0);
    _updateTargetChannelSelect(totalCh, _discoveredReceivers.length);
  } else if (DEVICES.length > 0) {
    _rebuildReceiversFromDevices(DEVICES);
  }
}

// ── 从 DEVICES 按 IP 聚合重建接收机列表（FAshe 实时推送时用）───────────
function _groupReceiversFromDevices(devices, base = _receiverCardBase()) {
  if (!Array.isArray(devices)) return [];
  // 按接收机稳定身份聚合（MAC 优先，IP 作为别名）；绝不按 Group/CH 聚合。
  const recvMap = new Map();
  devices.forEach(d => {
    // 没有可验证的 IP/MAC/receiver_id 时不能造一个共享的
    // ``unknown`` 接收机，否则多个无身份通道会被错误并入同一台机器。
    const receiverKey = _serverReceiverKey(d) || d.receiver_ip || d.ip || '';
    const channelKey = _serverChannelKey(d.channel_number ?? d.channel_no ?? d.channel ?? d.ch ?? d.channel_key);
    if (!receiverKey || !channelKey) return;
    const ip = d.receiver_ip || d.ip || '';
    const mac = d.receiver_mac || d.mac_address || d.mac || '';
    if (!recvMap.has(receiverKey)) {
      const shure = ['shure-scp','shure-scp-readonly'].includes(d.capabilities?.adapter) || d._source === 'shure-scp';
      recvMap.set(receiverKey, { id: receiverKey, receiver_id: d.receiver_id || d.receiverId || receiverKey, ip, mac, channels: [],
        http_base:base, server_ip:new URL(base).hostname, ...(shure ? {discovered_via:'shure-scp'} : {}) });
    }
    const channels = recvMap.get(receiverKey).channels;
    if (!channels.some(item => _serverChannelKey(item.channel_number ?? item.channel_no ?? item.channel ?? item.ch ?? item.channel_key) === channelKey)) channels.push(d);
  });

  return Array.from(recvMap.values());
}

function _rebuildReceiversFromDevices(devices, {renderCards = false} = {}) {
  _discoveredReceivers = _groupReceiversFromDevices(devices);
  const totalCh = _discoveredReceivers.reduce((s, r) => s + r.channels.length, 0);
  _updateTargetChannelSelect(totalCh, _discoveredReceivers.length);
  if (renderCards) {
    _receiverCardLiveScope = _receiverCardBase();
    _rememberReceiverCards(_discoveredReceivers);
  }
}

// ── 更新频率规划的「目标通道数」下拉框 ─────────────────────────────────
// totalCh: 当前在线接收机的总通道卡数量
// recvCount: 在线接收机（网卡）数量
function _updateTargetChannelSelect(totalCh, recvCount) {
  if (window.DatyPlanningDeployment) { window.DatyPlanningDeployment.refreshControls(); return; }
  const sel = document.getElementById('targetChannelSelect');
  const hint = document.getElementById('targetChannelHint');
  if (!sel) return;

  // 当前总通道卡数就是基准值
  const base = totalCh || 0;
  sel.innerHTML = '';

  if (base === 0) {
    sel.innerHTML = '<option value="">请先扫描接收机</option>';
    if (hint) hint.textContent = '基于在线接收机的总通道卡数量';
    return;
  }

  // 选项：当前总通道数 → 50，步进策略：
  //   ≤8:  步进 1（1, 2, 3, 4, ...）
  //   ≤20: 步进 2
  //   >20: 步进 4
  const step = base <= 8 ? 1 : base <= 20 ? 2 : 4;
  const maxCh = 50;

  // 从当前总通道数开始（标记为推荐/当前）
  let opt = document.createElement('option');
  opt.value = base;
  opt.textContent = `${base}（当前 ${recvCount} 台接收机）`;
  opt.selected = true;
  sel.appendChild(opt);

  // 大于当前通道数的选项
  for (let ch = base + step; ch <= maxCh; ch += step) {
    const last = ch + step > maxCh ? Math.min(ch + step - 1, maxCh) : null;
    opt = document.createElement('option');
    opt.value = ch;
    // 如果是连续范围的最后一个，显示范围
    const displayVal = last ? `${ch - step + 1}–${last}` : ch;
    opt.textContent = ch;
    sel.appendChild(opt);
  }

  // 确保 50 一定有
  if (sel.querySelector(`option[value="${maxCh}"]`) === null) {
    opt = document.createElement('option');
    opt.value = maxCh;
    opt.textContent = maxCh;
    sel.appendChild(opt);
  }

  if (hint) {
    const recvDetail = _discoveredReceivers.map(r => `${r.ip}: ${r.channels.length}通道`).join('、');
    hint.textContent = `${recvCount} 台接收机，共 ${base} 通道卡 → ${recvDetail || '—'}`;
  }
}

// ── 渲染接收机列表（含通道卡片） ─────────────────────────────────────
function _renderReceiverList(receivers) {
  const list    = document.getElementById('receiverList');
  const countEl = document.getElementById('receiverCount');
  if (!list) return;

  if (countEl) countEl.textContent = receivers.length;

  const html = receivers.map((receiver, idx) => {
    const r = _normalizeReceiverCard(receiver);
    const control = _receiverControlSummary(r);
    const shure = r.discovered_via === 'shure-scp';
    const products = r.channels.length ? r.channels.map(d => ({brand: d.brand ?? r.brand, model: d.model ?? r.model})) : [r];
    const productName = typeof formatReceiverProductSummary === 'function'
      ? formatReceiverProductSummary(products) : products.map(d => `${d.brand || '未知品牌'} ${d.model || '未知型号'}`).filter((v,i,a)=>a.indexOf(v)===i).join(' / ');
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const connTime = r.connected_at
      ? new Date(r.connected_at).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',second:'2-digit'})
      : '--';

    // 品牌颜色映射
    const brandColors = {
      'AMSaudio':   { bg: '#f59e0b22', border: '#f59e0b', text: '#fcd34d' },
      'Shure':      { bg: '#6366f122', border: '#6366f1', text: '#a5b4fc' },
      'Sennheiser': { bg: '#22d3ee22', border: '#22d3ee', text: '#67e8f9' },
    };

    // 通道卡片
    let channelsHtml = '';
    if (r.channels.length > 0) {
      const ordered = typeof sortDeviceView === 'function' ? sortDeviceView(r.channels, 'ch', true) : r.channels;
      const chCards = ordered.map(d => {
        const bc = brandColors[d.brand] || { bg: 'var(--bg2)', border: 'var(--border)', text: 'var(--text)' };
        const frequencyKHz = _rawDeviceFrequencyKHz(d);
        const freqMHz = frequencyKHz === null ? '--' : DatyFrequency.formatFrequencyMHz(frequencyKHz) + ' MHz';
        // bridge 的公开字段是 rf/batt；同时兼容 FAshe 原始 rfLevel/battery。
        const rfValue = _readFiniteTelemetry(d.rfLevel, d.rf);
        const batteryValue = _readFiniteTelemetry(d.battery, d.batt);
        const rfText  = rfValue === null ? '--' : `${rfValue.toFixed(1)} dBm`;
        const vendor = typeof getShureTelemetry === 'function' ? getShureTelemetry(d) : null;
        const batteryMeter = vendor ? getBatteryMeter(d) : null;
        const audioMeter = vendor ? getAfMeter(d) : null;
        const batText = batteryMeter ? batteryMeter.label : batteryValue === null ? '--' : `${batteryValue.toFixed(0)}%`;
        const batteryThreshold = typeof getAlertThresholdSettings === 'function'
          ? getAlertThresholdSettings().batteryLowPercent : 20;
        const batteryCaution = Math.min(100, batteryThreshold + 20);
        const batColor = batteryValue === null ? 'var(--muted)'
          : batteryValue <= batteryThreshold ? '#ef4444'
            : batteryValue <= batteryCaution ? '#f59e0b' : '#22c55e';
        const muted = typeof normalizeMutedValue === 'function'
          ? normalizeMutedValue(d.muted)
          : (d.muted === true || d.muted === 1 || String(d.muted ?? '').trim().toLowerCase() === 'true');
        const mutedTag = muted ? '<span style="font-size:9px;background:#ef444433;color:#f87171;padding:1px 4px;border-radius:3px;margin-left:4px;">MUTE</span>' : '';
        const onlineDot = (typeof _deviceConnectionIsOnline === 'function'
          ? _deviceConnectionIsOnline(d)
          : (d._online !== false && String(d.status || '').trim().toLowerCase() !== 'offline'))
          ? '<div style="width:6px;height:6px;border-radius:50%;background:#22c55e;flex-shrink:0;box-shadow:0 0 4px #22c55e;"></div>'
          : '<div style="width:6px;height:6px;border-radius:50%;background:#ef4444;flex-shrink:0;"></div>';

        return `
          <div style="background:${bc.bg};border:1px solid ${bc.border}33;border-radius:6px;padding:8px 10px;display:flex;align-items:center;gap:8px;">
            ${onlineDot}
            <div style="flex:1;min-width:0;">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
                <span style="font-weight:600;font-size:12px;color:${bc.text};">${esc(d.name || d.id)}</span>
                <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:${bc.border}22;color:${bc.text};font-weight:600;">${esc(d.brand || '--')}</span>
                ${mutedTag}
              </div>
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span style="font-size:10px;color:var(--muted);">${esc(typeof formatChannelDisplay === 'function' ? formatChannelDisplay(d) : `CH ${d.channel || d.ch || '--'}`)}</span>
                <span style="font-size:10px;color:var(--dim);">|</span>
                <span style="font-size:10px;color:var(--muted);">${freqMHz}</span>
                <span style="font-size:10px;color:var(--dim);">|</span>
                <span style="font-size:10px;color:var(--muted);">RF ${rfText}</span>
                <span style="font-size:10px;color:var(--dim);">|</span>
                <span style="font-size:10px;color:${batColor};" title="${esc(batteryMeter?.title || '')}">${batText}</span>
                ${vendor ? `<span style="font-size:10px;color:var(--muted);">AF ${audioMeter.available ? audioMeter.dbfs.toFixed(1) + ' dBFS' : '—'}</span><span style="font-size:10px;color:var(--muted);">${esc(getShureStatusText(d))}</span>` : ''}
              </div>
            </div>
          </div>`;
      }).join('');

      channelsHtml = `
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
          <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">通道卡片 (${r.channels.length})</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:6px;">
            ${chCards}
          </div>
        </div>`;
    } else {
      channelsHtml = `
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:11px;color:var(--dim);">
          暂无通道数据 — 接收机可能尚未发送设备列表
        </div>`;
    }

    return `
    <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px 14px;">
      <!-- 接收机头部 -->
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:10px;height:10px;border-radius:50%;background:${r._displayOffline ? '#ef4444' : '#22d3ee'};flex-shrink:0;box-shadow:0 0 8px ${r._displayOffline ? '#ef4444' : '#22d3ee'};"></div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
            <span style="font-weight:700;font-size:13px;" title="${esc(products.map(d => typeof formatBrandModelDisplay === 'function' ? formatBrandModelDisplay(d) : `${d.brand || '未知品牌'} ${d.model || '未知型号'}`).join(' / '))}">${esc(productName)}${shure ? ' · ' + esc(control.label) : ''}</span>
            <span style="font-size:10px;color:var(--muted);font-family:monospace;">${esc(r.ip)}</span>
            <span style="font-size:10px;color:var(--dim);">${r.channels.length} 通道</span>
            ${r._displayOffline ? '<span style="font-size:10px;color:#fb7185;">离线 · 上次数据</span>' : ''}
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="font-size:10px;color:var(--muted);">${shure ? '最后读取: ' + (Number.isFinite(r.ts) ? esc(new Date(r.ts * 1000).toLocaleTimeString('zh-CN')) : '—') : '连接时间: ' + connTime}</span>
            <span style="font-size:10px;color:var(--dim);">·</span>
            <span style="font-size:10px;color:var(--muted);">${shure ? esc(control.detail) : '消息数: ' + esc(r.message_count ?? '—')}</span>
            <span style="font-size:10px;color:var(--dim);">·</span>
            <span style="font-size:10px;color:var(--dim);">服务器: ${esc(r.server_ip)}</span>
          </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="connectToReceiver(${esc(JSON.stringify(r.http_base))},${esc(JSON.stringify(r.server_ip))})" title="一键互通：连接此接收机所在的服务器">🔗 互通</button>
      </div>
      <!-- 通道卡片区域 -->
      ${channelsHtml}
    </div>`;
  }).join('');
  if (_receiverCardMarkup !== html) { list.innerHTML = html; _receiverCardMarkup = html; }
}

// ── 一键互通接收机（连接到接收机所在的服务器） ───────────────────────
function connectToReceiver(httpBase, serverIP) {
  // 构造一个轻量 server 对象用于连接
  const server = {
    ip:    serverIP,
    ports: [8801, 8802],
    label: 'DATY RF PRO',
    ts:    _discoveryRuntime('nowEpochMs'),
  };

  notify('🔗', '正在互通', `连接到 ${serverIP} 并读取接收机数据`);

  // 调用现有的 connectToServer 逻辑
  connectToServer(JSON.stringify(server));

  // 连接成功后自动切换到设备概览 Tab
  _discoveryRuntime('setTimeout', () => {
    const devTab = document.querySelector('[data-tab="devDevices"]');
    if (devTab) devTab.click();
  }, 1500);
}

// ══════════════════════════════════════════════════════════════════
// 服务器连接管理（WebSocket / HTTP 轮询双模式）
// ══════════════════════════════════════════════════════════════════

function connectToServer(serverJsonStr) {
  let server;
  try { server = typeof serverJsonStr === 'string' ? JSON.parse(serverJsonStr) : serverJsonStr; }
  catch(e) { notify('❌','参数错误','无法解析服务器信息'); return; }

  // 防抖：如果正在连接同一台服务器，跳过
  if (_serverTransportConfirmed && _connectedServer && _connectedServer.ip === server.ip) {
    notify('ℹ️','已连接', `已与 ${server.ip} 建立互通`);
    return;
  }

  notify('🔗','正在连接', `${server.ip} — DATY RF PRO`);
  _clearServerTransport();
  _connectedServer = server;
  _serverTransportConfirmed = false;

  // 仅在加密传输之间切换；不允许 WSS → HTTP 降级。
  _startHttpPolling(server); // Logical query DTOs use the sole MQTT port.
}

function disconnectFromServer() {
  _clearServerTransport();
  _serverRetryCount = 0;
  _connectedServer = null;
  _serverTransportConfirmed = false;

  // 同步断开 FAshe SSE（因为 FAshe 数据也通过这台服务器的 mqtt-bridge 中转）
  if (_fasheConnected) {
    _fasheDisconnect();
  }

  // 更新 UI
  document.getElementById('connectedServerStatus').style.display = 'none';

  // 恢复接收机面板状态
  const recvDot = document.getElementById('recvScanDot');
  if (recvDot) recvDot.className = 'dot dot-amber';
  const recvStatus = document.getElementById('recvScanStatusText');
  if (recvStatus) recvStatus.textContent = '等待扫描';

  // 恢复左侧状态
  const connDot = document.getElementById('connDot');
  const connCountEl = document.getElementById('connCount');
  const remainOnline = DEVICES.filter(d => typeof _dashboardIsDeviceOnline === 'function'
    ? _dashboardIsDeviceOnline(d)
    : (d._online !== false && ['online', 'warn'].includes(String(d.status || '').trim().toLowerCase()))
  ).length;
  if (connDot) {
    connDot.className = remainOnline > 0 ? 'dot dot-green' : 'dot dot-red';
  }
  if (connCountEl) {
    connCountEl.textContent = remainOnline > 0 ? remainOnline + '台设备在线' : '无设备连接';
  }

  notify('🔌','已断开','与 DATY RF PRO 服务器的连接已断开');
}

// ── WebSocket 连接 ────────────────────────────────────────────────
function _tryWebSocketConnect(server, generation = _serverGeneration) {
  try {
    const wsUrl = globalThis.DatyPlatformFactory.serviceOrigin('native', server.ip).replace(/^https:/, 'wss:') + '/ws';
    // Native hosts own their transport. This legacy browser-only probe must not
    // silently open browser sockets when an explicit native adapter is injected.
    if (globalThis.DatyPlatform !== undefined && globalThis.DatyPlatform?.kind !== 'browser') return false;
    const ws = new WebSocket(wsUrl);
    _datyWS = ws; // Track CONNECTING sockets too, so disconnect can close them.
    let fellBack = false;
    const fallback = () => {
      if (fellBack || !_isCurrentServer(server, generation)) return;
      fellBack = true;
      if (_serverWsTimer !== null) _discoveryRuntime('clearTimeout', _serverWsTimer);
      _serverWsTimer = null;
      if (_datyWS === ws) _datyWS = null;
      try { ws.close(); } catch (_) {}
      _startHttpPolling(server, generation);
    };
    ws.onopen = () => {
      if (fellBack || !_isCurrentServer(server, generation)) { try { ws.close(); } catch (_) {} return; }
      if (_serverWsTimer !== null) _discoveryRuntime('clearTimeout', _serverWsTimer);
      _serverWsTimer = null;
      _datyWS = ws;
      console.log('[DATY] WebSocket 已连接:', wsUrl);
      _onServerConnected(server, 'WebSocket');
      // 订阅实时数据
      ws.send(JSON.stringify({ cmd: 'subscribe', channels: 'all' }));
    };
    ws.onmessage = (evt) => {
      if (fellBack || !_isCurrentServer(server, generation)) return;
      try { _onServerData(JSON.parse(evt.data)); } catch(e) {}
    };
    ws.onclose = () => {
      console.log('[DATY] WSS 断开，切换到 HTTPS 轮询');
      fallback();
    };
    ws.onerror = () => {
      // WS 失败，用 HTTP 轮询
      fallback();
    };
    // 给 WS 1.5 秒建立连接，超时则降级
    _serverWsTimer = _discoveryRuntime('setTimeout', () => {
      if (ws.readyState !== WebSocket.OPEN) fallback();
    }, 1500);
    return true;
  } catch(e) {
    return false;
  }
}

// ── HTTP 轮询（当 WS 不可用时）────────────────────────────────────
let _httpPollTimer = null;
function _startHttpPolling(server, generation = _serverGeneration) {
  if (!_isCurrentServer(server, generation)) return;
  if (_httpPollTimer !== null) _discoveryRuntime('clearInterval', _httpPollTimer);
  _httpPollTimer = null;
  const apiBase = globalThis.DatyPlatformFactory.serviceOrigin('bridge', server.ip);

  // 先尝试握手
  _discoveryRequest(`${apiBase}/health`, {redirect: 'error'})
    .then(r => { if (!r.ok) throw new Error('HTTPS health failed'); return r.json(); })
    .then(info => {
      if (!_isCurrentServer(server, generation)) return;
      if (info.status !== 'ok') throw new Error('HTTPS health invalid');
      _onServerConnected(server, 'HTTPS轮询');
      // 定时拉取设备数据
      _httpPollTimer = _discoveryRuntime('setInterval', () => {
        if (!_isCurrentServer(server, generation)) return;
        _discoveryRequest(`${apiBase}/api/devices`, {redirect: 'error'})
          .then(r => { if (!r.ok) throw new Error('HTTPS snapshot failed'); return r.json(); })
          .then(data => { if (_isCurrentServer(server, generation)) _onServerData(data); })
          .catch(() => {
            if (!_isCurrentServer(server, generation)) return;
            // 连接丢失
            _onServerDisconnected(server);
          });
      }, 1000);
    })
    .catch(() => {
      if (!_isCurrentServer(server, generation)) return;
      // Discovery evidence alone is not an authenticated TLS connection.
      _onServerDisconnected(server);
      notify('⚠️', 'HTTPS 连接失败', '请检查服务器地址与 CA 证书信任；未连接，不会退回明文 HTTP/TCP');
    });
}

// ── 连接成功回调 ─────────────────────────────────────────────────
function _onServerConnected(server, mode) {
  _connectedServer = server;
  _serverTransportConfirmed = true;
  _serverRetryCount = 0;  // 连接成功，重置重连计数

  // 更新侧边栏
  const connDot = document.getElementById('connDot');
  if (connDot) connDot.className = 'dot dot-green';
  const connCountEl = document.getElementById('connCount');
  if (connCountEl) connCountEl.textContent = `已连接 ${server.ip}`;

  // 更新扫描面板（接收机 Tab 状态点）
  const recvDot = document.getElementById('recvScanDot');
  if (recvDot) recvDot.className = 'dot dot-green';
  const recvStatus = document.getElementById('recvScanStatusText');
  if (recvStatus) recvStatus.textContent = `已连接 ${server.ip}`;

  const cs = document.getElementById('connectedServerStatus');
  if (cs) cs.style.display = '';
  const csTitle = document.getElementById('csTitle');
  if (csTitle) csTitle.textContent = `已连接 DATY RF PRO — ${server.ip}`;
  const csDetail = document.getElementById('csDetail');
  if (csDetail) csDetail.textContent = `${server.version||'v1.0.3'} · ${mode}`;
  const csProto = document.getElementById('csProto');
  if (csProto) csProto.textContent = mode;

  // 启动心跳延迟检测
  _startHeartbeat(server);

  notify('✅','连接成功', `已与 ${server.ip} 建立互通 (${mode})`);
}

// ── 连接断开回调 ─────────────────────────────────────────────────
let _serverRetryCount = 0;
function _markServerDevicesOffline(server) {
  const owner = _normalizeServerIdentity(server?.ip || server?.host || '');
  let changed = false;
  DEVICES.forEach(device => {
    if (!device || !device._serverManaged) return;
    const deviceOwner = _normalizeServerIdentity(device._serverOwner);
    const belongs = (owner && deviceOwner && deviceOwner === owner)
      || (owner && _deviceMatchesServerIdentity(device, owner));
    if (!belongs) return;
    if (device._online !== false || String(device.status || '').toLowerCase() !== 'offline') {
      device._online = false;
      device.status = 'offline';
      changed = true;
    }
  });
  if (changed) {
    if (typeof evaluateRealtimeAlerts === 'function') evaluateRealtimeAlerts(DEVICES);
    if (typeof forceRefreshAllPanels === 'function') forceRefreshAllPanels();
  }
  return changed;
}

function _onServerDisconnected(server) {
  if (!_connectedServer || _connectedServer.ip !== server.ip) return; // 已手动切换到其他服务器
  _clearServerTransport();
  _serverTransportConfirmed = false;
  const statusPanel = document.getElementById('connectedServerStatus');
  if (statusPanel) statusPanel.style.display = 'none';
  const statusText = document.getElementById('recvScanStatusText');
  if (statusText) statusText.textContent = 'HTTPS 连接中断';
  _markServerDevicesOffline(server);
  notify('⚠️','连接断开', `与 ${server.ip} 的连接已中断，正在重连...`);
  // 指数退避重连，最多重试 10 次
  if (_serverRetryCount >= 10) {
    notify('❌','重连失败', `已重试 10 次，请检查服务器 ${server.ip} 是否运行`);
    _connectedServer = null;
    _serverRetryCount = 0;
    document.getElementById('connectedServerStatus').style.display = 'none';
    return;
  }
  const delay = Math.min(1000 * Math.pow(2, _serverRetryCount), 30000);
  _serverRetryCount++;
  const generation = _serverGeneration;
  _serverRetryTimer = _discoveryRuntime('setTimeout', () => {
    if (_isCurrentServer(server, generation)) {
      connectToServer(server);
    }
  }, delay);
}

// ── 接收服务器推送的设备数据 ─────────────────────────────────────
function _readFiniteTelemetry(...values) {
  for (const value of values) {
    if (typeof value === 'boolean' || value === null || value === undefined || value === ''
      || (typeof value === 'string' && value.trim() === '')
      || (typeof value !== 'number' && typeof value !== 'string')) continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

// 服务器旧协议可能没有稳定 device_id；至少要用“接收机身份 + 通道号”
// 保持多通道可区分。名称只能作为最后的唯一匹配回退，不能优先于通道。
function _serverChannelKey(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return '';
  const number = typeof getCanonicalChannelNumber === 'function'
    ? getCanonicalChannelNumber(value, null)
    : (() => {
        const text = String(value).trim();
        if (/^\d+$/.test(text)) return Number(text) > 0 ? Number(text) : null;
        const match = text.match(/(?:^|[^a-z])(?:channel|ch)\s*[-_:#\s]*[^0-9\s]{0,4}\s*(\d+)/i);
        return match && Number(match[1]) > 0 ? Number(match[1]) : null;
      })();
  return number === null ? '' : `CH${number}`;
}

function _serverReceiverKey(device) {
  if (!device || typeof device !== 'object') return '';
  // 与通道卡/仪表盘共用“MAC 优先、IP 次之、ID 最后”的规范身份。
  // Group、通道号和设备名称不参与接收机聚合。
  if (typeof getCanonicalReceiverKey === 'function') {
    const canonical = getCanonicalReceiverKey(device);
    if (canonical) return canonical;
  }
  const candidates = [
    device.receiver_id, device.receiverId, device._receiver_id,
    device.receiver_mac, device.receiverMac, device.mac_address, device.mac,
    device.receiver_ip, device.server_ip, device.serverIp, device._serverOwner,
    device.ip, device._source,
  ];
  for (const candidate of candidates) {
    if (candidate && /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(String(candidate).trim())) {
      return `mac:${String(candidate).trim().toLowerCase().replace(/-/g, ':')}`;
    }
    const normalized = _normalizeServerIdentity(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function _serverPublicReceiverId(device, receiverKey) {
  const key = String(receiverKey || '');
  if (key.startsWith('mac:')) return `FAshe-MAC-${key.slice(4).toUpperCase()}`;
  if (key.startsWith('ip:')) return `FAshe-${key.slice(3)}`;
  const explicit = String(device?.receiver_id || device?.receiverId || device?._receiver_id || '').trim()
    .replace(/(?:[_-])ch\d+$/i, '');
  if (explicit && !/^group\s*[-_:#/ ]*\d+$/i.test(explicit)) return explicit;
  return key.startsWith('id:') ? key.slice(3) : key;
}

function _serverDeviceIsLive(device) {
  return !!(device && (device._serverManaged || device._fasheId || device._source || device._serverOwner));
}

function _onServerData(data) {
  // 期望格式: { devices: [...], type: 'devices_update' }
  if (!data) return;

  const type = String(data.type || data.event || data.message_type || '').toLowerCase();
  const hasDevicesArray = Array.isArray(data.devices);
  // 旧 WebSocket 协议偶尔把设备数组放在 data 中；只有明确的设备事件才接受该字段，
  // 避免把心跳/日志等非设备消息误当成空快照。
  const dataLooksLikeDevices = Array.isArray(data.data) && data.data.some(item => {
    if (!item || typeof item !== 'object') return false;
    const hasTelemetryOrChannel = ['channel', 'ch', 'rf', 'rfLevel', 'battery', 'batt', 'frequency', 'freq', 'af', 'afLevel', 'af_level']
      .some(field => Object.prototype.hasOwnProperty.call(item, field));
    const hasIdentityAndEndpoint = (Object.prototype.hasOwnProperty.call(item, 'id') || Object.prototype.hasOwnProperty.call(item, 'name'))
      && ['ip', 'ipAddress', 'receiver_ip', 'receiverId', '_source'].some(field => Object.prototype.hasOwnProperty.call(item, field));
    return hasTelemetryOrChannel || hasIdentityAndEndpoint;
  });
  const hasTypedDataArray = Array.isArray(data.data) && (/device|channel|receiver/.test(type) || dataLooksLikeDevices);
  if (!hasDevicesArray && !hasTypedDataArray) return;
  const rawDevices = hasDevicesArray ? data.devices : data.data;
  // 某些旧 WS 响应只携带 devices，不带 server 字段；若当前仅有一台服务器的快照索引，
  // 可以安全沿用该唯一归属，否则宁可不猜测以免误置其它服务器设备离线。
  let snapshotOwner = _serverSnapshotIdentity(data);
  if (!snapshotOwner && rawDevices.length > 0) {
    // 无连接上下文的旧快照可从首个通道的来源/接收机地址建立归属索引。
    const firstDevice = rawDevices.find(device => device && typeof device === 'object');
    snapshotOwner = _normalizeServerIdentity(firstDevice?._serverOwner
      || firstDevice?._source || firstDevice?.server_ip || firstDevice?.receiver_ip || firstDevice?.ip);
  }
  if (!snapshotOwner && _serverSnapshotDevices.size === 1) {
    snapshotOwner = _serverSnapshotDevices.keys().next().value;
  }

  // 空数组是“该服务器当前没有通道”的明确全量快照，不是无效消息。
  // 将该服务器此前登记的实时设备标记离线，阈值评估器会同步移除活动告警。
  if (rawDevices.length === 0) {
    if (!snapshotOwner) return;
    const hadTrackedSnapshot = _serverSnapshotDevices.has(snapshotOwner);
    const changed = _markServerSnapshotOffline(snapshotOwner);
    const csDevCount = document.getElementById('csDevCount');
    if (csDevCount) csDevCount.textContent = '0';
    if (changed || hadTrackedSnapshot) {
      if (typeof forceRefreshAllPanels === 'function') forceRefreshAllPanels();
      else {
        if (typeof evaluateRealtimeAlerts === 'function') evaluateRealtimeAlerts(DEVICES);
        if (typeof renderDeviceGrid === 'function') renderDeviceGrid(DEVICES);
        if (typeof renderDevTable === 'function') renderDevTable();
        if (typeof updateStatCards === 'function') updateStatCards();
      }
    }
    return;
  }

  // 将服务端设备格式映射到前端 DEVICES 格式
  let changed = false;
  const mappedSnapshotDevices = [];
  const usedDeviceIndexes = new Set();
  const seenReceiverChannels = new Set();
  rawDevices.forEach(d => {
    if (!d || typeof d !== 'object') return;
    if (['interference', 'noise', 'test_noise'].includes(String(d.device_role || d.role || '').toLowerCase())) return;
    const rawStableId = d.id ?? d.device_id;
    const receiverKey = _serverReceiverKey(d);
    const channelValue = d.channel_number ?? d.channel_no ?? d.channel ?? d.ch ?? d.channel_key;
    const channelKey = _serverChannelKey(channelValue);
    // 实时设备必须同时有“接收机身份 + 明确 CH”。Group-only、名称数字
    // 或孤立 device_id 不得生成通道卡。
    if (!receiverKey || !channelKey) return;
    const routeKey = `${receiverKey}|${channelKey}`;
    if (seenReceiverChannels.has(routeKey)) {
      console.warn('[DATY] 忽略同一接收机的重复通道:', routeKey, d);
      return;
    }
    seenReceiverChannels.add(routeKey);

    const channelNumber = Number(channelKey.replace(/^CH/i, ''));
    const receiverId = _serverPublicReceiverId(d, receiverKey);
    const fallbackId = `${receiverId}_ch${channelNumber}`;
    const rawStableText = rawStableId !== null && rawStableId !== undefined
      ? String(rawStableId).trim() : '';
    // 只有明确包含相同 _chN 后缀的原始 ID 才是通道级稳定 ID；
    // 接收机级 ID 或纯数字 ID 会在多通道/多接收机场景产生碰撞。
    const rawIdChannel = /(?:[_-])ch\s*\d+$/i.test(rawStableText)
      ? _serverChannelKey(rawStableText) : '';
    const fasheId = rawStableText && rawIdChannel === channelKey ? rawStableText : fallbackId;
    const findUnused = predicate => DEVICES.findIndex((x, index) => !usedDeviceIndexes.has(index) && _serverDeviceIsLive(x) && predicate(x));

    // 1) 稳定 ID（字符串/数字统一比较）。
    let idx = fasheId
      ? findUnused(x => String(x._fasheId ?? '').trim() === fasheId)
      : -1;
    // 2) 接收机/服务器身份 + 规范化通道号。
    if (idx < 0 && receiverKey && channelKey) {
      idx = findUnused(x => _serverReceiverKey(x) === receiverKey
        && _serverChannelKey(x.channel_number ?? x.channel_no ?? x.channel ?? x.ch ?? x.channel_key) === channelKey);
    }
    if (idx >= 0) usedDeviceIndexes.add(idx);

    const freqKHz = _rawDeviceFrequencyKHz(d) ?? 0;
    // 缺失遥测保留 null，不用 -70/0 等占位值触发阈值告警。
    const rfValue = _readFiniteTelemetry(d.rfLevel, d.rf);
    const rf = rfValue === null || rfValue < -150 || rfValue > 20 ? null : Math.round(rfValue);
    const af = _rawDeviceAf(d);
    const battValue = _readFiniteTelemetry(d.battery, d.batt);
    const batt = battValue === null || battValue < 0 || battValue > 100 ? null : Math.round(battValue);
    const derivedStatus = typeof _fasheThresholdStatus === 'function'
      // `_rawDeviceAf` 用 -40 作为展示占位值，但 unavailable 时不能把
      // 该占位值送入阈值比较（尤其阈值允许到 -40 dBFS）。
      ? _fasheThresholdStatus(rf, batt, af.available ? af.dbfs : null)
      : (() => {
          const thresholds = typeof getAlertThresholdSettings === 'function'
            ? getAlertThresholdSettings()
            : {rfWeakDbm: -90, batteryLowPercent: 20, afOverloadDbfs: -3};
          return ((Number.isFinite(rf) && rf <= thresholds.rfWeakDbm)
            || (Number.isFinite(batt) && batt <= thresholds.batteryLowPercent)
            || (af.available && Number.isFinite(af.dbfs) && af.dbfs >= thresholds.afOverloadDbfs)) ? 'warn' : 'online';
        })();
    const incomingStatus = String(d.status || '').toLowerCase();
    // 断线/超时状态必须优先于阈值和服务器残留的 online 标记。
    const explicitlyOffline = typeof _deviceIsOffline === 'function'
      ? _deviceIsOffline(d)
      : (d._online === false || d._online === 0 || ['false', '0', 'no', 'offline'].includes(String(d._online).trim().toLowerCase()) || ['offline', 'disconnected', 'disconnect', 'timeout', 'unavailable', 'lost'].includes(incomingStatus));
    const mappedStatus = explicitlyOffline ? 'offline'
      : incomingStatus === 'error' ? 'error'
        : (derivedStatus === 'warn' || incomingStatus === 'warn' ? 'warn' : 'online');
    const receiverIp = d.receiver_ip || d.receiverIp || d.ip || d.ipAddress || '';
    const receiverMac = d.receiver_mac || d.receiverMac || d.mac_address || d.mac || '';
    const mapped = {
      id:     idx >= 0 ? DEVICES[idx].id : fasheId,
      ch:     `CH${channelNumber}`,
      channel: channelNumber,
      channel_number: channelNumber,
      channel_key: `CH${channelNumber}`,
      name:   d.name || '未知设备',
      brand:  d.brand || '未知品牌',
      model:  d.model || '--',
      ip:     receiverIp,
      receiver_ip: receiverIp,
      receiver_mac: receiverMac,
      freq:   freqKHz,
      rf:     rf,
      af:     af.available ? af.percent : null,
      afDbfs: af.available ? af.dbfs : null,
      afUnit: 'dBFS',
      batt:   batt,
      status: mappedStatus,
      planned: idx >= 0 ? (DEVICES[idx].planned ?? freqKHz) : freqKHz,
      _fasheId: fasheId || undefined,
      receiverId,
      receiver_id: receiverId,
      group: d.group,
      group_number: d.group_number,
      group_source: d.group_source,
      _online: !explicitlyOffline,
      _source: d._source,
      shure: d.shure || null,
      capabilities: d.capabilities || null,
      heartbeat: normalizeReceiverHeartbeat(d.heartbeat),
      _thresholdStatusManaged: true,
      _serverManaged: true,
      muted: typeof normalizeMutedValue === 'function'
        ? normalizeMutedValue(d.muted)
        : (d.muted === true || d.muted === 1 || String(d.muted ?? '').trim().toLowerCase() === 'true'),
    };
    if (snapshotOwner) mapped._serverOwner = snapshotOwner;

    if (idx >= 0) {
      Object.assign(DEVICES[idx], mapped);
      mappedSnapshotDevices.push(DEVICES[idx]);
    } else {
      const createdIndex = DEVICES.length;
      DEVICES.push(mapped);
      mappedSnapshotDevices.push(mapped);
      // 新建的通道也要占用本次快照的匹配槽位，避免后续同名通道
      // 通过“唯一名称回退”再次合并到刚创建的第一张卡。
      usedDeviceIndexes.add(createdIndex);
      changed = true;
    }
  });

  if (snapshotOwner && mappedSnapshotDevices.length > 0) {
    const currentKeys = new Set(mappedSnapshotDevices.map(_serverDeviceKey).filter(Boolean));
    if (_isFullServerSnapshot(data)) {
      const removed = _reconcileServerSnapshot(snapshotOwner, currentKeys);
      if (removed > 0) changed = true;
    }
    _serverSnapshotDevices.set(snapshotOwner, currentKeys);
  }

  // HTTP 与 SSE 共用旧缓存 ID 修复，不能把历史重复编号永久保留下来。
  repairRealtimeDeviceIds(DEVICES);

  // 更新 UI
  const csDevCount = document.getElementById('csDevCount');
  if (csDevCount) csDevCount.textContent = rawDevices.length;

  // 与 FAshe SSE 使用同一阈值引擎，及时更新通道卡、实时告警和首页统计。
  if (typeof forceRefreshAllPanels === 'function') forceRefreshAllPanels();
  else {
    renderDeviceGrid(DEVICES);
    renderDevTable();
    updateStatCards();
  }
}

function _mapStatus(s) {
  if (!s) return 'offline';
  const sl = String(s).toLowerCase();
  if (sl === 'online' || sl === '0') return 'online';
  if (sl === 'warn'  || sl === '1') return 'warn';
  if (sl === 'error' || sl === '2') return 'error';
  return 'offline';
}

// ── 心跳延迟检测 ─────────────────────────────────────────────────
function _startHeartbeat(server) {
  if (_heartbeatTimer !== null) _discoveryRuntime('clearInterval', _heartbeatTimer);
  const generation = _serverGeneration;
  _heartbeatTimer = _discoveryRuntime('setInterval', async () => {
    if (!_isCurrentServer(server, generation)) return;
    const t0 = _discoveryRuntime('nowMonotonicMs');
    const controller = new AbortController();
    const deadline = _discoveryRuntime('setTimeout', () => controller.abort(), 2000);
    try {
      // ping mqtt-bridge 的 health 端口（8802）
      const healthUrl = globalThis.DatyPlatformFactory.serviceOrigin('bridge', server.ip) + '/health';
      const response = await _discoveryRequest(healthUrl, { redirect: 'error', signal: controller.signal });
      if (!_isCurrentServer(server, generation)) return;
      if (!response.ok) throw new Error('HTTPS health failed');
      const latency = Math.round(_discoveryRuntime('nowMonotonicMs') - t0);
      const el = document.getElementById('csLatency');
      if (el) el.textContent = latency;
    } catch(e) {
      if (!_isCurrentServer(server, generation)) return;
      const el = document.getElementById('csLatency');
      if (el) el.textContent = '--';
    } finally { _discoveryRuntime('clearTimeout', deadline); }
  }, 3000);
}

// ── 纯前端降级扫描（ip-service 未运行时）────────────────────────
// ── updateStatCards（如未定义则补充）────────────────────────────
function updateStatCards() {
  // 禁止在 discovery 中维护第二套在线设备算法；统一交给 Dashboard。
  if (typeof updateDashboardStats === 'function') updateDashboardStats();
  const warnCount   = DEVICES.filter(d=>d.status==='warn').length;
  const statWarn = document.getElementById('statWarnCount');
  if (statWarn) statWarn.textContent = warnCount;
}

function saveSettings() {
  if(globalThis.DatySystemSettings)return globalThis.DatySystemSettings.retry();
  notify('⚠️','设置尚未保存','服务器数据库设置接口尚未就绪');return false;
}

function importPlugin() {
  return globalThis.DatyPluginImport.start();
}

function importPluginCloud() {
  // No verified cloud catalogue exists; do not list planned brands as available plugins.
  notify('ℹ️','暂无可导入的云端插件','云端插件库尚未接入；品牌插件列表仅显示当前服务器已集成的插件。');
}

function downloadPlugin(name) {
  const modal = document.getElementById('cloudPluginModal');
  if(modal) modal.remove();
  notify('ℹ️','插件下载尚未接入',`「${name}」未下载、未安装；真实插件库及签名校验接口尚未接入。`);
}


// 舒尔协议卡片共用服务器发现服务；页面打开/刷新只读取状态。
globalThis.DatyShureDiscovery = (() => {
  let snapshot = null, receivedAt = 0, source = '', generation = -1;
  let busy = false, timer = null, active = false, revision = 0, error = '', notice = '';
  const element = id => document.getElementById(id);
  const text = (id, value) => { const el = element(id); if (el) el.textContent = value; };
  const endpoint = () => typeof _fasheApiUrl === 'string' ? _fasheApiUrl : '';
  const now = () => _discoveryRuntime('nowMonotonicMs');
  const visible = () => !document.hidden && !!element('panel-devices')?.classList.contains('active')
    && !!element('devProto')?.classList.contains('active');
  const fresh = () => snapshot && source === endpoint() && generation === _serverGeneration
    && now() - receivedAt < 15000;
  const date = value => Number.isFinite(value) && value > 0 ? new Date(value * 1000).toLocaleString('zh-CN') : '—';
  function render() {
    const state = fresh() ? snapshot : null;
    let status = error ? '读取失败' : busy ? '正在读取' : '等待状态';
    if (state) status = !state.enabled ? '已关闭' : state.error ? '扫描异常' : state.scanning ? '正在扫描'
      : state.cancelled ? '本次已停止' : state.completed_at ? '扫描完成' : '待扫描';
    text('shureDiscoveryState', status);
    text('shureDiscoveryRange', state ? (state.scopes || []).map(s => s.scan_network).filter(Boolean).join('、') || '等待扫描' : '—');
    text('shureDiscoveryTime', date(state?.completed_at));
    text('shureDiscoveryProgress', state ? `${state.scanned ?? 0} / ${state.targets ?? 0} 个地址` : '—');
    const receivers = state && Array.isArray(state.receivers) ? state.receivers : [];
    text('shureDiscoveryCount', state ? `发现结果（${receivers.length} 台）` : '发现结果（待确认）');
    text('shureDiscoveryResults', state ? receivers.length ? receivers.map(r => {
      const channels = r.channels && typeof r.channels === 'object' ? Object.keys(r.channels).length : 0;
      return `${r.model || '未知型号'} · ${r.ip || r.receiver_ip || '地址未知'} · ${channels} 个已读取通道 · 频段 ${r.hardware_band?.band || '未识别'}（${r.hardware_band?.source==='receiver-reported'?'设备上报':r.hardware_band?.source==='chassis-label-confirmed'?'机身标签确认':'未确认'}）${r.complete === false ? '（读取未完整）' : ''}`;
    }).join('\n') : '当前未发现在线舒尔接收机。' : '等待服务器确认；此前结果不作为当前在线状态。');
    const limited = state?.scopes?.some(s => s.limited_to_24);
    text('shureDiscoveryMessage', error || state?.error || notice || (limited
      ? '已扫描所示 /24 范围，未覆盖整个大子网；下发须确认目标及硬件能力。'
      : '由服务器扫描直连网络；下发须确认目标及硬件能力。'));
    const scan = element('shureDiscoveryScan'), cancel = element('shureDiscoveryCancel'), refresh = element('shureDiscoveryRefresh');
    if (scan) scan.disabled = busy || !state?.enabled || state.scanning;
    if (cancel) {
      cancel.disabled = busy || !state?.scanning || !state.active_operation_id;
      cancel.title = state?.scanning && !state.active_operation_id ? '服务器自动扫描将自行结束；此按钮仅停止有操作编号的手动扫描' : '仅停止当前手动扫描，已接收的数据保留';
    }
    if (refresh) refresh.disabled = busy;
  }
  function clearTimer() {
    if (timer !== null) _discoveryRuntime('clearTimeout', timer);
    timer = null;
  }
  function schedule() {
    clearTimer();
    if (visible()) timer = _discoveryRuntime('setTimeout', () => { timer = null; void refresh(); }, 3000);
  }
  function context() {
    const base = endpoint(), currentGeneration = _serverGeneration, currentRevision = revision;
    return {base, currentGeneration, current: () => base === endpoint() && currentGeneration === _serverGeneration && currentRevision === revision};
  }
  function accept(value, ctx) {
    if (!ctx.current()) return false;
    if (!value) throw new Error('此服务器未提供舒尔发现服务');
    snapshot = value; receivedAt = now(); source = ctx.base; generation = ctx.currentGeneration; error = '';
    if (!value.scanning && /^(扫描|停止)请求已受理/.test(notice)) notice = '';
    return true;
  }
  async function refresh() {
    if (busy) return;
    clearTimer(); busy = true;
    const ctx = context(); render();
    try {
      if (!ctx.base) throw new Error('请先连接服务器');
      accept(await _shureDiscoveryJson(ctx.base, 'status', ctx.current), ctx);
    } catch (failure) {
      if (ctx.current()) { snapshot = null; error = failure.message || '读取舒尔发现状态失败'; }
    } finally { busy = false; render(); schedule(); }
  }
  async function act(action) {
    if (busy || !fresh() || !snapshot.enabled) return;
    if (action === 'scan' && snapshot.scanning) return;
    if (action === 'cancel' && (!snapshot.scanning || !snapshot.active_operation_id)) return;
    clearTimer(); busy = true; notice = ''; error = '';
    const ctx = context(); render();
    try {
      const result = await _shureDiscoveryJson(ctx.base, action, ctx.current, 'POST');
      if (accept(result, ctx)) notice = action === 'scan' ? '扫描请求已受理，完成状态以服务器更新为准。' : '停止请求已受理，等待服务器结束本次扫描。';
    } catch (failure) {
      if (ctx.current()) notice = `${failure.message || '请求未确认'}；不会自动重复提交，请刷新核对状态。`;
    } finally {
      busy = false; render();
      // Only status is read after submission, including an unknown result. Never replay a POST.
      if (ctx.current() && visible()) await refresh(); else schedule();
    }
  }
  function syncVisibility() {
    const next = visible();
    if (next !== active) { active = next; revision++; }
    if (!next) { clearTimer(); return; }
    if (!fresh()) { snapshot = null; notice = ''; }
    render(); void refresh();
  }
  document.addEventListener?.('visibilitychange', syncVisibility);
  globalThis.addEventListener?.('pagehide', () => { active = false; revision++; clearTimer(); });
  return Object.freeze({syncVisibility, refresh, scan: () => act('scan'), cancel: () => act('cancel')});
})();

// Installed adapters come from server capabilities, independently of live devices.
globalThis.DatyBrandPlugins = (() => {
  let timer = null, request = null, revision = 0;
  let snapshot = null, snapshotBase = '', snapshotGeneration = null;
  const visible = () => !document.hidden && ['panel-settings','panel-channels']
    .some(id => document.getElementById(id)?.classList.contains('active'));
  const endpoint = () => typeof _fasheApiUrl === 'string' ? _fasheApiUrl : '';
  const fresh = () => snapshot && snapshotBase === endpoint() && snapshotGeneration === _serverGeneration;
  function renderBrandFilter(brands) {
    const select = document.getElementById('filterBrandChannels');
    if (!select) return;
    const previous = select.value, values = ['all', ...brands];
    const options = Array.from(select.options);
    if (options.length !== values.length || options.some((option, i) =>
      option.value !== values[i] || option.textContent !== (i === 0 ? '全部品牌' : values[i]))) {
      select.replaceChildren(...values.map(value => {
        const option = document.createElement('option');
        option.value = value; option.textContent = value === 'all' ? '全部品牌' : value;
        return option;
      }));
    }
    select.value = values.includes(previous) ? previous : 'all';
    if (previous !== select.value && typeof filterDevicesChannels === 'function') filterDevicesChannels();
  }
  function render(adapters, message = '') {
    let count = 0;
    const brands = new Set();
    // New brands are registered by the server, never inferred from live devices.
    const list = document.getElementById('brandPluginList');
    if (list) {
      const cards = Array.from(document.querySelectorAll('#panel-settings [data-plugin-adapter]'));
      for (const [key, entry] of Object.entries(adapters || {})) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !entry.plugin_id || typeof entry.brand !== 'string' || cards.some(card => card.dataset.pluginAdapter === key)) continue;
        const card = document.createElement('div'); card.className = 'plugin-card';
        card.dataset.pluginAdapter = key; card.dataset.pluginBrand = entry.brand;
        const info = document.createElement('div'); info.className = 'plugin-info';
        const name = document.createElement('div'); name.className = 'plugin-name'; name.textContent = entry.brand; info.appendChild(name);
        const version = document.createElement('div'); version.className = 'plugin-models'; version.textContent = entry.version || ''; info.appendChild(version);
        const status = document.createElement('span'); status.className = 'badge b-g plugin-status'; status.textContent = '已导入';
        card.appendChild(info); card.appendChild(status); list.appendChild(card); cards.push(card);
      }
    }
    document.querySelectorAll('#panel-settings [data-plugin-adapter]').forEach(card => {
      const entry = adapters && Object.prototype.hasOwnProperty.call(adapters, card.dataset.pluginAdapter)
        ? adapters[card.dataset.pluginAdapter] : null;
      const installed = !!entry && typeof entry === 'object' && !Array.isArray(entry);
      card.hidden = !installed;
      if (installed) {
        count++;
        if (card.dataset.pluginBrand) brands.add(card.dataset.pluginBrand);
      }
    });
    renderBrandFilter([...brands]);
    const state = document.getElementById('brandPluginState');
    if (state) {
      state.hidden = count > 0;
      state.textContent = message || '当前服务器没有已集成的品牌插件。';
    }
  }
  function cancel() {
    revision++;
    if (timer !== null) _discoveryRuntime('clearTimeout', timer);
    timer = null;
    request?.abort(); request = null;
  }
  async function refresh() {
    if (!visible() || request) return;
    if (timer !== null) _discoveryRuntime('clearTimeout', timer);
    timer = null;
    const base = endpoint(), generation = _serverGeneration, version = revision;
    const current = () => version === revision && base === endpoint() && generation === _serverGeneration && visible();
    const controller = new AbortController(); request = controller;
    const timeout = _discoveryRuntime('setTimeout', () => controller.abort(), 5000);
    try {
      if (!base) throw new Error('未连接服务器');
      const response = await _discoveryRequest(base + '/api/capabilities', {method:'GET', cache:'no-store', signal:controller.signal});
      if (!response.ok) throw new Error('插件信息读取失败');
      const data = await response.json();
      if (!data?.success || !data.adapters || typeof data.adapters !== 'object' || Array.isArray(data.adapters)) throw new Error('插件信息无效');
      if (current()) {
        snapshot = data.adapters; snapshotBase = base; snapshotGeneration = generation;
        render(snapshot);
      }
    } catch (_) {
      if (current()) {
        snapshot = null;
        render(null, '暂时无法确认已集成插件，连接恢复后自动更新。');
      }
    } finally {
      _discoveryRuntime('clearTimeout', timeout);
      if (request === controller) request = null;
      if (version === revision && visible()) {
        if (!current()) render(null, '正在读取当前服务器的已集成插件…');
        timer = _discoveryRuntime('setTimeout', refresh, current() ? 5000 : 0);
      }
    }
  }
  function syncVisibility() {
    cancel();
    if (!visible()) return;
    render(fresh() ? snapshot : null, '正在读取当前服务器的已集成插件…');
    void refresh();
  }
  document.addEventListener?.('visibilitychange', syncVisibility);
  globalThis.addEventListener?.('pagehide', cancel);
  return Object.freeze({syncVisibility});
})();

/* DATY_PLUGIN_SOURCE_EXPORT_BEGIN */
/* ZIP file output belongs to the host; an explicit native host never falls back to browser DOM. */
globalThis.DatyPluginExportHost = Object.freeze({
  async save(runtime, bytes, options) {
    const platform = runtime.DatyPlatform, port = runtime.DatyBinaryExports, signal = options.signal;
    if (!(bytes instanceof Uint8Array) || !bytes.length || !/^[a-zA-Z0-9._-]+\.zip$/.test(options.fileName)) throw Error('无效的配接文件');
    if (signal?.aborted) return {status:'cancelled'};
    if (port !== undefined || platform?.kind !== 'browser') {
      if (port?.VERSION !== 'daty-binary-export-v1' || typeof port.saveBytes !== 'function') throw Error('当前宿主未提供 ZIP 保存接口');
      let abort;
      const cancelled = new Promise(resolve => { abort = () => resolve({status:'cancelled'}); signal?.addEventListener('abort',abort,{once:true}); });
      try {
        const operation = port.saveBytes(bytes, {...options, mimeType:'application/zip'});
        if (!operation || typeof operation.then !== 'function') throw Error('ZIP 保存接口必须返回异步结果');
        const result = await Promise.race([operation, cancelled]);
        if (signal?.aborted || runtime.DatyPlatform !== platform || runtime.DatyBinaryExports !== port) return {status:'cancelled'};
        if (!['saved','cancelled'].includes(result?.status)) throw Error('ZIP 保存结果未确认');
        return result;
      } finally { signal?.removeEventListener('abort',abort); }
    }
    const url = runtime.URL.createObjectURL(new runtime.Blob([bytes], {type:'application/zip'}));
    let link;
    try {
      link = runtime.document.createElement('a'); link.href = url; link.download = options.fileName; link.hidden = true;
      runtime.document.body.appendChild(link); link.click();
      return {status:'download-started'};
    } finally {
      link?.remove();
      // Give the browser time to consume the download URL; no business timers or retries.
      const schedule = runtime.DatyHostFactory ? (fn, ms) => runtime.DatyHostFactory.invokeRuntime(runtime,'setTimeout',fn,ms) : runtime.setTimeout.bind(runtime);
      schedule(() => runtime.URL.revokeObjectURL(url), 30000);
    }
  }
});

;
/* Generated by scripts/build-plugin-exports.py. Do not hand-edit. */
globalThis.DatyPluginSourceCatalog = Object.freeze([{"id":"shure-scp","name":"Shure SCP","brand":"Shure","adapterKeys":["shure-scp"],"revision":"ada467c9bba1","fileName":"DATY-shure-scp-ada467c9bba1.zip","sourceFiles":25,"bytes":79196,"sha256":"825dbe3f049f915279b19dcc0bc5ec51faee0fcb343b50b57da41f5e09879634","base64":"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"}]);

;
let developerPluginExportPending = false;
async function exportDeveloperPlugin(selectedId) {
  if (developerPluginExportPending) return false;
  developerPluginExportPending = true;
  const button = document.getElementById('developerPluginExport'), list = document.getElementById('developerPluginExports');
  const controller = new AbortController(), cancel = () => controller.abort();
  const base = typeof _fasheApiUrl === 'string' ? _fasheApiUrl : '', generation = _serverGeneration;
  const current = () => !controller.signal.aborted && base === _fasheApiUrl && generation === _serverGeneration;
  const timer = _discoveryRuntime('setTimeout', cancel, 10000);
  if (button) { button.disabled = true; button.setAttribute('aria-busy','true'); }
  if (list) { list.hidden = true; list.replaceChildren(); }
  globalThis.addEventListener?.('pagehide', cancel, {once:true});
  try {
    if (!base) throw Error('请先连接服务器');
    const response = await _discoveryRequest(base + '/api/capabilities', {method:'GET',cache:'no-store',signal:controller.signal});
    const data = await response.json();
    if (!current()) return false;
    if (!response.ok || !data?.success || !data.adapters || typeof data.adapters !== 'object' || Array.isArray(data.adapters)) throw Error('无法确认服务器已集成插件');
    const catalog = globalThis.DatyPluginSourceCatalog;
    if (!Array.isArray(catalog)) throw Error('配接文件目录尚未就绪');
    const available = catalog.filter(item => item.adapterKeys.some(key => Object.prototype.hasOwnProperty.call(data.adapters,key)
      && data.adapters[key] && typeof data.adapters[key] === 'object' && !Array.isArray(data.adapters[key])));
    const selected = selectedId ? available.find(item => item.id === selectedId) : available.length === 1 ? available[0] : null;
    if (!selected) {
      if (selectedId || !available.length) throw Error('当前服务器没有对应的可导出配接文件');
      if (!list) throw Error('插件选择列表不可用');
      const label = document.createElement('span'); label.textContent = '选择要导出的品牌配接文件：'; list.appendChild(label);
      for (const item of available) {
        const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'btn btn-outline btn-sm';
        choice.textContent = '📤 ' + item.name + ' ZIP'; choice.addEventListener('click', () => { void exportDeveloperPlugin(item.id); }); list.appendChild(choice);
      }
      list.hidden = false; return false;
    }
    const raw = globalThis.atob(selected.base64), bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    const digest = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
    if (!current()) return false;
    if (bytes.length !== selected.bytes || digest !== selected.sha256) throw Error('配接文件校验失败，请刷新后重试');
    _discoveryRuntime('clearTimeout', timer);
    const result = await globalThis.DatyPluginExportHost.save(globalThis, bytes, {fileName:selected.fileName,signal:controller.signal});
    if (!current() || result?.status === 'cancelled') return false;
    if (!['saved','download-started'].includes(result?.status)) throw Error('配接文件保存状态未确认');
    notify('📤', result.status === 'saved' ? '配接文件已保存' : '配接文件已开始下载', selected.name + ' · ' + selected.sourceFiles + ' 个源码文件 · ZIP 压缩包');
    return true;
  } catch (error) {
    if (base === _fasheApiUrl && generation === _serverGeneration) notify('❌','配接文件导出未完成',controller.signal.aborted ? '请求已取消或超时，请重试' : error.message || String(error));
    return false;
  } finally {
    _discoveryRuntime('clearTimeout', timer); developerPluginExportPending = false;
    globalThis.removeEventListener?.('pagehide', cancel);
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
  }
}

;
/* DATY_PLUGIN_SOURCE_EXPORT_END */

















/* ZIP input is a replaceable host capability. No text decoding of binary files. */
globalThis.DatyPluginImportHost = Object.freeze({
  open(runtime, {signal, maxBytes = 131072} = {}) {
    const platform = runtime.DatyPlatform, port = runtime.DatyBinaryImports;
    const check = result => {
      if (signal?.aborted || runtime.DatyPlatform !== platform || runtime.DatyBinaryImports !== port) return {status:'cancelled'};
      if (result?.status === 'cancelled') return result;
      if (result?.status !== 'selected' || !(result.bytes instanceof Uint8Array) || !result.bytes.length || result.bytes.length > maxBytes) throw Error('插件包无效或超过 128 KiB');
      return result;
    };
    if (signal?.aborted) return Promise.resolve({status:'cancelled'});
    if (port !== undefined || platform?.kind !== 'browser') {
      if (port?.VERSION !== 'daty-binary-import-v1' || typeof port.openBytes !== 'function') return Promise.reject(Error('当前宿主未提供 ZIP 读取接口'));
      try {
        const operation = port.openBytes({accept:'.zip',maxBytes,signal});
        if (!operation || typeof operation.then !== 'function') throw Error('ZIP 读取接口必须返回异步结果');
        let abort;
        const cancelled = new Promise(resolve => { abort = () => resolve({status:'cancelled'}); signal?.addEventListener('abort',abort,{once:true}); });
        if (signal?.aborted) abort();
        return Promise.race([operation,cancelled]).then(check).finally(() => signal?.removeEventListener('abort',abort));
      } catch (error) { return Promise.reject(error); }
    }
    // Called synchronously from the button event so the chooser retains user activation.
    return new Promise((resolve,reject) => {
      const input = runtime.document.createElement('input'); input.type = 'file'; input.accept = '.zip,application/zip'; input.hidden = true;
      let settled = false;
      const finish = (value,error) => {
        if (settled) return; settled = true; input.remove(); signal?.removeEventListener('abort',cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => finish({status:'cancelled'});
      input.addEventListener('cancel',cancel,{once:true}); signal?.addEventListener('abort',cancel,{once:true});
      input.addEventListener('change',async () => {
        try {
          const file = input.files?.[0]; if (!file) return cancel();
          if (!/\.zip$/i.test(file.name) || file.size < 1 || file.size > maxBytes) throw Error('请选择不超过 128 KiB 的插件 ZIP');
          const bytes = new Uint8Array(await file.arrayBuffer());
          finish(check({status:'selected',bytes,name:file.name}));
        } catch (error) { finish(null,error); }
      },{once:true});
      try { runtime.document.body.appendChild(input); input.click(); } catch(error) { finish(null,error); }
    });
  }
});

/* UI orchestrates preview/confirmation/one install. The server owns installation truth. */
globalThis.DatyPluginImport = (() => {
  let busy = false, unresolved = null;
  const report = (message, unknown = false) => {
    const state = document.getElementById('pluginImportState');
    if (state) { state.hidden = false; state.textContent = message; }
    const query = document.getElementById('pluginImportQuery'); if (query) query.hidden = !unknown;
  };
  const resultOf = (result, pending) => {
    if (result?.operation_id !== pending.operation_id || result?.sha256 !== pending.sha256 || result?.id !== pending.id) throw Error('安装回执与本次插件不匹配');
    if (result.activation === 'active' && result.state === 'installed') {
      unresolved = null; report(pending.brand + ' 插件已安装并启用 · ' + pending.version);
      globalThis.DatyBrandPlugins?.syncVisibility(); return true;
    }
    if (result.activation === 'failed') { unresolved = null; report('插件安装已记录，但启用失败：' + (result.error || '请检查服务器日志')); return false; }
    report('安装结果尚未确认，请查询结果。',true); return false;
  };
  async function query() {
    if (busy || !unresolved) return false;
    const pending = unresolved; busy = true;
    try {
      if (pending.base !== _fasheApiUrl) throw Error('请连接原服务器后查询');
      const generation = _serverGeneration;
      const result = await globalThis.DatyPluginRpc(pending.base,'plugins.operation',{operation_id:pending.operation_id});
      if (pending.base !== _fasheApiUrl || generation !== _serverGeneration) return false;
      return resultOf(result,pending);
    } catch (error) {
      if (error.code === 'INSTALL_OPERATION_NOT_FOUND' && pending.base === _fasheApiUrl) {
        unresolved = null; report('服务器未记录本次安装，可以重新选择插件包。');
      } else report('安装结果未确认：' + (error.message || String(error)) + '。查询不会重新安装。',true);
      return false;
    }
    finally { busy = false; }
  }
  async function start() {
    if (busy) return false;
    if (unresolved) return query();
    busy = true;
    const button = document.getElementById('brandPluginImport'), controller = new AbortController();
    const base = typeof _fasheApiUrl === 'string' ? _fasheApiUrl : '', generation = _serverGeneration;
    const current = () => !controller.signal.aborted && base === _fasheApiUrl && generation === _serverGeneration;
    const cancel = () => controller.abort();
    globalThis.addEventListener?.('pagehide',cancel,{once:true});
    if (button) { button.disabled = true; button.setAttribute('aria-busy','true'); }
    let pending = null;
    try {
      if (!base) throw Error('请先连接服务器');
      if (typeof globalThis.DatyPluginRpc !== 'function') throw Error('插件导入接口尚未加载，请刷新页面后重试');
      const selected = await globalThis.DatyPluginImportHost.open(globalThis,{signal:controller.signal,maxBytes:131072});
      if (!current() || selected?.status === 'cancelled') return false;
      if (!(selected?.bytes instanceof Uint8Array) || !selected.bytes.length || selected.bytes.length > 131072) throw Error('无效的插件 ZIP');
      let binary = ''; for (const byte of selected.bytes) binary += String.fromCharCode(byte);
      const package_base64 = globalThis.btoa(binary);
      report('正在校验插件包…');
      const preview = await globalThis.DatyPluginRpc(base,'plugins.preview',{package_base64},controller.signal);
      if (!current()) return false;
      const digest = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',selected.bytes)),b => b.toString(16).padStart(2,'0')).join('');
      if (!current()) return false;
      if (preview?.trusted !== true || preview.sha256 !== digest || !Number.isInteger(preview.revision) || !preview.id || !preview.brand) throw Error('插件校验结果不一致');
      const status = await globalThis.DatyPluginRpc(base,'plugins.status',{},controller.signal);
      if (!current()) return false;
      if (!Array.isArray(status?.plugins) || status.revision !== preview.revision) throw Error('服务器插件状态已变化，请重新选择插件包');
      const existing = status.plugins.find(item => item.id === preview.id);
      if (existing?.sha256 === digest && existing.version === preview.version && existing.state === 'installed' && existing.active === true && existing.activation === 'active') {
        report(preview.brand + ' 插件已导入并启用 · ' + preview.version + '，无需重复安装');
        globalThis.DatyBrandPlugins?.syncVisibility(); return true;
      }
      const confirmed = await globalThis.DatyDialogs.confirm({title:'导入品牌插件',message:'安装并启用 ' + preview.name + '？',
        columns:[{key:'brand',label:'品牌'},{key:'version',label:'版本'},{key:'files',label:'源码文件数'}],
        rows:[{brand:preview.brand,version:preview.version,files:String(preview.source_files)}],
        warnings:preview.compatibility_import ? ['此源码包已由平台审核，按兼容安装配置导入。'] : [],confirmLabel:'安装并启用'});
      if (!confirmed || !current()) { if(current())report('已取消，未安装插件。'); return false; }
      pending = {...preview,base,operation_id:globalThis.crypto.randomUUID().replaceAll('-','')};
      unresolved = pending; report('正在保存并启用插件…');
      const result = await globalThis.DatyPluginRpc(base,'plugins.install',{package_base64,operation_id:pending.operation_id,
        expected_revision:preview.revision,sha256:preview.sha256},controller.signal);
      if (!current()) return false;
      return resultOf(result,pending);
    } catch (error) {
      if (pending && ['PLUGIN_REVISION_CHANGED','PLUGIN_PACKAGE_CHANGED','INSTALL_REQUEST_EXPIRED','REQUEST_EXPIRED','SERVER_BOOT_CHANGED','PLUGIN_UPDATE_REQUIRES_MAINTENANCE','PLUGIN_PACKAGE_NOT_TRUSTED','INSTALLED_FILES_CHANGED'].includes(error.code)) {
        unresolved = null; pending = null;
      }
      if (current()) report(pending ? '安装结果未确认，请查询结果；不会自动重复安装。' : '插件未安装：' + (error.message || String(error)),!!pending);
      return false;
    } finally {
      busy = false; globalThis.removeEventListener?.('pagehide',cancel);
      if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }
  }
  return Object.freeze({start,query});
})();
