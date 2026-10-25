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
    const response = await _discoveryRequest(baseUrl + '/api/discovery/shure/' + action, {
      method, redirect: 'error', signal: controller.signal,
      ...(method === 'POST' ? {headers: {'Content-Type': 'application/json'}, body: '{}'} : {}),
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
  const wsOk = _tryWebSocketConnect(server);
  if (!wsOk) _startHttpPolling(server);
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
