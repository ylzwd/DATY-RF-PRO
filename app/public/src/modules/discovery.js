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
globalThis.DatyPluginSourceCatalog = Object.freeze([{"id":"shure-scp","name":"Shure SCP","brand":"Shure","adapterKeys":["shure-scp"],"revision":"f9f657916929","fileName":"DATY-shure-scp-f9f657916929.zip","sourceFiles":23,"bytes":77448,"sha256":"a2441d94a4fd120d75f05e81e004ba54620ef0d7bfe4173b4218ce35bb9708a4","base64":"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"}]);

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
