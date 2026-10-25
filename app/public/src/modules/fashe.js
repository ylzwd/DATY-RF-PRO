// ============================================================
// fashe.js — FAshe实时数据接收（SSE）、断线重连、指令下发
// ============================================================

// ══════════════════════════════════════════════════════════════════
// FAshe 实时数据接收模块（通过 mqtt-bridge.py HTTP SSE 接口）
// 架构: FAshe → :8083(MQTT WS) → mqtt-bridge.py:8802(SSE) → unirf-app.html
// ══════════════════════════════════════════════════════════════════

let _fasheSSE       = null;     // EventSource 对象
let _fasheConnected = false;    // 是否已连接
let _fasheMsgCount  = 0;        // 收到消息总数
let _fasheRetryTimer= null;     // 重连计时器
let _fasheRetryCount= 0;        // 连续重连次数（用于指数退避）
const _fasheMaxRetryDelay = 30000; // 最大重连间隔 30s
let _fasheApiUrl    = globalThis.DatyPlatformFactory
  ? globalThis.DatyPlatformFactory.serviceOrigin('bridge', globalThis.location?.hostname)
  : 'https://127.0.0.1:8802'; // TLS + 直接 IPv4；远程页面默认连接页面所在服务器
let _fasheLastUpdateAt = null;  // 最近一次 FAshe 设备快照/增量时间
let _fasheLastReceivedAt = null; // 单调接收时间，用于判断推送新鲜度
let _fasheLastServerTimeMs = null; // Bridge 主时钟时间（优先于浏览器本地时间）
let _fasheReconnectEnabled = true; // 自动连接/重连意图；手动断开后置 false

function isFasheConnected() {
  return _fasheConnected;
}

function normalizeFasheApiUrl(value) {
  if (!globalThis.DatyPlatformFactory) throw new Error('安全服务地址模块未加载，请完整刷新服务器页面');
  return globalThis.DatyPlatformFactory.normalizeBridgeUrl(value);
}

// 服务管理器复用已接收的状态，不能用服务器时钟与浏览器时钟相减判断过期。
function getFasheServiceSnapshot() {
  if (!_fasheConnected || _fasheSSE?.readyState !== 1 || _fasheLastReceivedAt === null
      || performance.now() - _fasheLastReceivedAt > 10000) return null;
  return DEVICES.filter(d => d._fasheId && !d._serverManaged).map(d => ({...d,id:d._fasheId}));
}

function getFasheRealtimeStatus() {
  return {
    connected: _fasheConnected,
    lastUpdateAt: _fasheLastUpdateAt,
    serverTimeMs: _fasheLastServerTimeMs,
    clockSource: 'fuwuqi',
    messageCount: _fasheMsgCount,
  };
}

// 无显式 status 时，用服务器端统一的系统阈值推导通道注意状态。
// 告警本身由 render.js 的 evaluateRealtimeAlerts 维护，避免两套去重逻辑。
function _fasheToFiniteNumber(value) {
  // JSON 遥测只接受 number 或数字字符串；空白、布尔值、数组/对象
  // 均属于缺失或非法值，不能让 Number(null/[]/true) 变成 0/1。
  if (value === null || value === undefined || value === '' || typeof value === 'boolean'
    || (typeof value === 'string' && value.trim() === '')
    || (typeof value !== 'number' && typeof value !== 'string')) return NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : NaN;
}

function _fasheNormalizeMuted(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'muted'].includes(text)) return true;
  if (['false', '0', 'no', 'off', 'unmuted', 'normal'].includes(text)) return false;
  return !!fallback;
}

const _FASHE_OFFLINE_VALUES = new Set([
  'false', '0', 'no', 'offline', 'disconnected', 'disconnect',
  'connection_lost', 'connection-lost', 'timeout', 'unavailable', 'lost'
]);

function _fasheIsOfflineFlag(value) {
  if (value === false || value === 0) return true;
  return typeof value === 'string' && _FASHE_OFFLINE_VALUES.has(value.trim().toLowerCase());
}

function _fasheIsOfflineStatus(value) {
  return _FASHE_OFFLINE_VALUES.has(String(value ?? '').trim().toLowerCase());
}

function _fasheThresholdStatus(rf, batt, afDbfs) {
  const thresholds = typeof getAlertThresholdSettings === 'function'
    ? getAlertThresholdSettings()
    : {rfWeakDbm: -90, batteryLowPercent: 20, afOverloadDbfs: -3};
  const rfNumber = _fasheToFiniteNumber(rf);
  const battNumber = _fasheToFiniteNumber(batt);
  const rfValue = Number.isFinite(rfNumber) && rfNumber >= -150 && rfNumber <= 20 ? rfNumber : NaN;
  const battValue = Number.isFinite(battNumber) && battNumber >= 0 && battNumber <= 100 ? battNumber : NaN;
  // AF 协议固定为 -40～0 dBFS；越界/非数值必须视为未知，
  // 与 getAfMeter/evaluateRealtimeAlerts 的判定保持一致。
  const afNumber = _fasheToFiniteNumber(afDbfs);
  const afValue = Number.isFinite(afNumber) && afNumber >= -40 && afNumber <= 0 ? afNumber : NaN;
  return (Number.isFinite(rfValue) && rfValue <= thresholds.rfWeakDbm)
    || (Number.isFinite(battValue) && battValue <= thresholds.batteryLowPercent)
    || (Number.isFinite(afValue) && afValue >= thresholds.afOverloadDbfs)
    ? 'warn' : 'online';
}

function _fasheNormalizeRf(value) {
  const numeric = _fasheToFiniteNumber(value);
  return Number.isFinite(numeric) && numeric >= -150 && numeric <= 20 ? Math.round(numeric) : null;
}

function _fasheNormalizeBattery(value) {
  const numeric = _fasheToFiniteNumber(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100 ? Math.round(numeric) : null;
}

function _fasheNormalizeAf(fd = {}, fallbackDbfs = null) {
  let raw;
  let explicitPresent = false;
  let explicitDbfs = false;
  const explicitFields = ['af_dbfs', 'afDbfs', 'afLevel', 'af_level'];
  for (const field of explicitFields) {
    if (!Object.prototype.hasOwnProperty.call(fd, field)) continue;
    // 即使字段值为 null/空，也要记住“显式提供过 dBFS 字段”，
    // 防止随后用旧版 af 或 fallback 把不可用值伪造成有效电平。
    explicitPresent = true;
    if (fd[field] === undefined || fd[field] === null || fd[field] === '') continue;
    // 忽略非数值候选，继续检查后续兼容字段；第一个有限数值仍遵循
    // 协议字段优先级，越界会在统一范围校验中被判为未知。
    const candidate = _fasheToFiniteNumber(fd[field]);
    if (!Number.isFinite(candidate)) continue;
    raw = candidate;
    explicitDbfs = true;
    break;
  }
  if (!explicitPresent && raw === undefined && fd.af !== undefined && fd.af !== null && fd.af !== '') raw = fd.af;

  // `Number(null)` 等于 0，但 null/空字符串在协议中表示“没有值”，
  // 不能被误解释为 0 dBFS（满量程）。
  const fallback = _fasheToFiniteNumber(fallbackDbfs);
  const fallbackAvailable = Number.isFinite(fallback);
  let dbfs = _fasheToFiniteNumber(raw);
  const realtime = !!(fd._fasheId || fd.id || fd._source || fd.receiver_id || fd.receiverId || fd.afUnit === 'dBFS' || fd.af_unit === 'dBFS');
  if (!Number.isFinite(dbfs)) {
    if (explicitPresent) return {dbfs: null, percent: null, available: false};
    if (!fallbackAvailable) return {dbfs: null, percent: null, available: false};
    dbfs = fallback;
  } else if (!explicitDbfs) {
    // 负值始终是 dBFS；正值兼容旧版 0～100 百分比。实时协议中的 0 为 0 dBFS。
    const unit = String(fd.afUnit || fd.af_unit || '').toLowerCase();
    const isPercent = unit === 'percent' || unit === '%' || (!realtime && dbfs >= 0);
    if (isPercent) {
      if (dbfs > 100) return {dbfs: null, percent: null, available: false};
      dbfs = -40 + Math.max(0, Math.min(100, dbfs)) * 0.4;
    }
  }
  if (!Number.isFinite(dbfs) || dbfs < -40 || dbfs > 0) {
    return {dbfs: null, percent: null, available: false};
  }
  dbfs = Math.max(-40, Math.min(0, dbfs));
  return { dbfs: Math.round(dbfs * 100) / 100, percent: Math.round((dbfs + 40) / 40 * 100), available: true };
}

// ── UI 状态更新 ───────────────────────────────────────────────────
function _fasheSetStatus(state, text, devCount) {
  const dot  = document.getElementById('fasheStatusDot');
  const txt  = document.getElementById('fasheStatusText');
  const btn  = document.getElementById('fasheConnBtn');
  const devEl= document.getElementById('fasheDevCount');
  const lastEl= document.getElementById('fasheLastUpdate');

  const colors = { ok:'#10b981', warn:'#f59e0b', err:'#f43f5e', idle:'#4a5578' };
  if (dot) dot.style.background = colors[state] || colors.idle;
  if (dot && state === 'ok') dot.style.boxShadow = '0 0 6px #10b981';
  else if (dot) dot.style.boxShadow = 'none';
  if (txt) txt.textContent = text;

  if (btn) {
    if (state === 'ok' || state === 'warn') {
      btn.textContent = '⏹ 停止接收';
      btn.className = 'btn btn-danger btn-sm';
    } else {
      btn.textContent = '🔌 开始接收';
      btn.className = 'btn btn-success btn-sm';
    }
  }

  if (devEl) {
    if (devCount != null && devCount > 0) {
      devEl.textContent = devCount + ' 台设备';
      devEl.style.display = '';
    } else {
      devEl.style.display = 'none';
    }
  }
  if (lastEl) lastEl.style.display = (state === 'ok') ? '' : 'none';
}

// SSE 断开或用户手动停止接收时，缓存通道不能继续被当作实时在线数据。
// 保留卡片以便重连后复用，但将其置为离线并立即清除阈值告警。
function _fasheMarkDevicesOffline() {
  if (typeof _fasheUiCancel === 'function') _fasheUiCancel();
  if (typeof DEVICES === 'undefined' || !Array.isArray(DEVICES)) return false;
  let changed = false;
  DEVICES.forEach(device => {
    // discovery.js 标记的 _serverManaged 设备由服务器连接生命周期负责，
    // 不应因另一条 FAshe SSE 链路短暂断开而被误置离线。
    if (!device || !device._fasheId || device._serverManaged) return;
    if (device._online !== false || String(device.status || '').toLowerCase() !== 'offline') {
      device._online = false;
      device.status = 'offline';
      changed = true;
    }
  });
  if (typeof _rememberReceiverCards === 'function') _rememberReceiverCards([]);
  if (changed) {
    if (typeof evaluateRealtimeAlerts === 'function') evaluateRealtimeAlerts(DEVICES);
    if (typeof forceRefreshAllPanels === 'function') forceRefreshAllPanels();
  }
  return changed;
}

// ── 切换连接状态 ──────────────────────────────────────────────────
function toggleFasheConn() {
  if (_fasheConnected) {
    _fasheDisconnect();
    notify('⏹', '实时接收已停止', '接收机实时数据接收已停止');
  } else {
    _fasheReconnectEnabled = true;
    const urlEl = document.getElementById('fasheApiUrl');
    try { _fasheApiUrl = normalizeFasheApiUrl(urlEl?.value); }
    catch (error) { notify('⚠️', 'Bridge 地址无效', error.message); return; }
    if (urlEl) urlEl.value = _fasheApiUrl;
    _fasheConnect();
  }
}

// ── 建立 SSE 连接 ─────────────────────────────────────────────────
function _fasheConnect() {
  if (!_fasheReconnectEnabled) return;
  try { _fasheApiUrl = normalizeFasheApiUrl(_fasheApiUrl); }
  catch (error) { _fasheSetStatus('err', 'HTTPS 地址无效', null); notify('⚠️', '连接未发送', error.message); return; }
  _fasheLastReceivedAt = null;
  if (_fasheSSE) { _fasheSSE.close(); _fasheSSE = null; }
  if (_fasheRetryTimer) { clearTimeout(_fasheRetryTimer); _fasheRetryTimer = null; }

  _fasheSetStatus('warn', '连接中...', null);

  // 先做一次 health check，确认服务器在线
  (globalThis.DatyPlatform?.request || fetch)(_fasheApiUrl + '/health', { redirect: 'error', signal: AbortSignal.timeout(3000) })
    .then(r => r.json())
    .then(d => {
      if (d.status !== 'ok') throw new Error('服务器状态异常');
      _fasheStartSSE();
    })
    .catch(err => {
      console.warn('[FAshe] Bridge HTTPS 连接失败:', err.message);
      _fasheMarkDevicesOffline();
      _fasheSetStatus('err', 'HTTPS 连接失败', null);
      notify('⚠️', '数据服务连接失败', '请检查 Bridge 运行、HTTPS 地址及本机对服务器 CA 的信任；不会退回 HTTP');
      _fasheConnected = false;
      if (_fasheReconnectEnabled) _fasheScheduleReconnect();
    });
}

// ── 启动 SSE 实时推送监听 ─────────────────────────────────────────
function _fasheStartSSE() {
  const sseUrl = _fasheApiUrl + '/api/updates';
  _fasheSSE = globalThis.DatyPlatform
    ? globalThis.DatyPlatform.openEventStream(sseUrl)
    : new EventSource(sseUrl);
  _fasheConnected = true;
  _fasheRetryCount = 0;  // 连接成功，重置重连计数

  _fasheSSE.onopen = () => {
    console.log('[FAshe] SSE 已连接:', sseUrl);
    _fasheSetStatus('ok', '已连接 · 等待数据...', null);
    notify('📡', '实时数据服务已连接', '实时数据接收已启动，等待接收机上报...');
  };

  _fasheSSE.addEventListener('device_list', e => {
    try {
      const payload = JSON.parse(e.data);
      _fasheMsgCount++;
      if (Number.isFinite(Number(payload.server_time_ms))) _fasheLastServerTimeMs = Number(payload.server_time_ms);
      _fasheHandleDeviceList(payload.devices || []);
    } catch(err) { console.error('[FAshe] device_list 解析失败:', err); }
  });

  _fasheSSE.addEventListener('device_update', e => {
    try {
      const payload = JSON.parse(e.data);
      _fasheMsgCount++;
      if (Number.isFinite(Number(payload.server_time_ms))) _fasheLastServerTimeMs = Number(payload.server_time_ms);
      _fasheHandleDeviceUpdate(payload.devices || []);
    } catch(err) { console.error('[FAshe] device_update 解析失败:', err); }
  });

  _fasheSSE.addEventListener('mute_command', e => {
    try {
      const payload = JSON.parse(e.data);
      _fasheMsgCount++;
      _fasheHandleMuteCommand(payload.data || payload);
    } catch(err) { console.error('[FAshe] mute_command 解析失败:', err); }
  });

  _fasheSSE.addEventListener('command_update', e => {
    try {
      const payload = JSON.parse(e.data);
      receiveCommandAcknowledgement(payload.data || payload);
    } catch(err) { console.error('[FAshe] command_update 解析失败:', err); }
  });

  _fasheSSE.addEventListener('client_disconnect', e => {
    notify('⚠️', '接收机连接中断', '接收机已断开连接');
  });

  _fasheSSE.onerror = () => {
    if (!_fasheConnected) return;
    console.warn(`[FAshe] SSE 连接中断，准备重连...`);
    _fasheConnected = false;
    _fasheMarkDevicesOffline();
    _fasheSetStatus('err', '连接中断，重连中...', null);
    _fasheSSE.close();
    _fasheScheduleReconnect();
  };
}

// ── 断开连接 ──────────────────────────────────────────────────────
function _fasheDisconnect() {
  _fasheReconnectEnabled = false;
  _fasheConnected = false;
  _fasheRetryCount = 0;
  if (_fasheSSE) { _fasheSSE.close(); _fasheSSE = null; }
  if (_fasheRetryTimer) { clearTimeout(_fasheRetryTimer); _fasheRetryTimer = null; }
  _fasheMarkDevicesOffline();
  _fasheSetStatus('idle', '未连接', null);
  _fasheMsgCount = 0;
}

// ── 指数退避重连（1s → 2s → 4s → 8s → max 30s）────────────────
function _fasheScheduleReconnect() {
  if (_fasheRetryTimer) clearTimeout(_fasheRetryTimer);
  const delay = Math.min(1000 * Math.pow(2, _fasheRetryCount), _fasheMaxRetryDelay);
  _fasheRetryCount++;
  console.log(`[FAshe] 将在 ${(delay/1000).toFixed(1)}s 后重连 (第 ${_fasheRetryCount} 次)`);
  _fasheRetryTimer = setTimeout(() => {
    _fasheRetryTimer = null;
    if (_fasheReconnectEnabled) {
      _fasheConnect();  // 重新 health check + 建立 SSE
    }
  }, delay);
}

// ── 处理 FAshe 设备列表（初始连接时发来的全量数据）────────────────
function _fasheGetReceiverId(device) {
  const explicit = device.receiverId || device.receiver_id || device._receiver_id;
  if (explicit) return String(explicit).trim();
  const fasheId = device._fasheId || device.id;
  if (fasheId !== undefined && fasheId !== null) {
    const value = String(fasheId).trim();
    if (/_ch\d+$/i.test(value)) return value.replace(/_ch\d+$/i, '');
  }
  const ip = device.ip || device.receiver_ip || device.ipAddress;
  if (ip) return String(ip).trim();
  if (device._source) return String(device._source).trim().replace(/:(mqtt|ws|sse)$/i, '');
  return '';
}

function _fasheReceiverAliases(device) {
  if (!device || typeof device !== 'object') return new Set();
  const aliases = new Set();
  const add = value => {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return;
    aliases.add(text);
    aliases.add(text.replace(/_ch\d+$/i, ''));
  };
  add(device.receiverId || device.receiver_id || device._receiver_id);
  add(device.ip || device.receiver_ip || device.ipAddress);
  add(device._source);
  const mac = device.receiver_mac || device.receiverMac || device.mac_address || device.mac;
  if (mac) {
    const compact = String(mac).toLowerCase().replace(/[^0-9a-f]/g, '');
    if (compact.length === 12) {
      aliases.add(`mac:${compact}`);
      aliases.add(`fashe-mac-${compact}`);
    }
  }
  const fasheId = device._fasheId || device.id;
  if (fasheId) add(fasheId);
  return aliases;
}

function _fasheGetChannelKey(device) {
  const raw = device?.channel_number ?? device?.channel_no ?? device?.channel ?? device?.ch ?? device?.channel_key;
  const number = typeof getCanonicalChannelNumber === 'function'
    ? getCanonicalChannelNumber(raw, null)
    : (() => {
        const text = String(raw ?? '').trim();
        if (/^\d+$/.test(text)) return Number(text) > 0 ? Number(text) : null;
        const match = text.match(/(?:^|[^a-z])(?:channel|ch)\s*[-_:#\s]*[^0-9\s]{0,4}\s*(\d+)/i);
        return match && Number(match[1]) > 0 ? Number(match[1]) : null;
      })();
  return number === null ? '' : `CH${number}`;
}

function _fasheFindMatchingIndex(devices, incoming) {
  // 名称不是接收机身份；相同名称的不同接收机必须继续按
  // “接收机身份 + CH”匹配，不能因 name 恰好相同而串台。
  const stableId = incoming._fasheId || incoming.id;
  if (stableId !== undefined && stableId !== null && String(stableId).trim()) {
    const exactIndex = devices.findIndex(device => String(device._fasheId) === String(stableId));
    if (exactIndex >= 0) return exactIndex;
  }

  // 遗留数据只能在“同一接收机 + 同一通道”时回退匹配，禁止仅凭 CH1 串台。
  const receiverId = _fasheGetReceiverId(incoming);
  const channelKey = _fasheGetChannelKey(incoming);
  if (!receiverId || !channelKey) return -1;
  return devices.findIndex(device =>
    !!device._fasheId &&
    [..._fasheReceiverAliases(device)].some(alias => _fasheReceiverAliases(incoming).has(alias)) &&
    _fasheGetChannelKey(device) === channelKey
  );
}

function _fasheHandleDeviceList(fasheDevices) {
  if (!Array.isArray(fasheDevices)) return;

  // 全量快照为空也必须清除旧 FAshe 通道；手动设备始终保留。
  // 服务器轮询/WS 链路写入的设备同样带有 `_fasheId`，但由服务器
  // 生命周期管理；FAshe SSE 的空快照不能把这类设备误删。若后续
  // 收到同一稳定 ID 的 FAshe 快照，则允许它接管并合并该设备。
  const manualDevices = DEVICES.filter(d => !d._fasheId);
  const previousFasheDevices = DEVICES.filter(d => !!d._fasheId);
  const serverManagedFasheDevices = previousFasheDevices.filter(d => d._serverManaged);
  const nextFasheDevices = [];
  const consumedPrevious = new Set();

  let addedCount = 0;
  fasheDevices.forEach(fd => {
    // 批次在循环完成后才写回 DEVICES，分配新 ID 时必须同时预留本批次已生成的 ID。
    const normalized = _fasheNormalizeDevice(fd, [...DEVICES, ...nextFasheDevices]);
    const existIdx = _fasheFindMatchingIndex(previousFasheDevices, fd);
    if (existIdx >= 0) {
      const previous = previousFasheDevices[existIdx];
      consumedPrevious.add(previous);
      const merged = {
        ...previous,
        ...normalized,
        id: previous.id,
        planned: previous.planned ?? normalized.planned,
      };
      // 设备已由 FAshe SSE 接管时，清除旧服务器快照归属，避免断线生命周期串台。
      delete merged._serverOwner;
      nextFasheDevices.push(merged);
    } else {
      nextFasheDevices.push(normalized);
      addedCount++;
    }
  });

  // 保留本次 FAshe 快照未覆盖的服务器设备；否则一个短暂的空/部分
  // FAshe 快照会让另一条服务器连接的通道从总览和告警中消失。
  const retainedServerDevices = serverManagedFasheDevices.filter(device => !consumedPrevious.has(device));
  DEVICES.length = 0;
  DEVICES.push(...manualDevices, ...retainedServerDevices, ...nextFasheDevices);
  repairRealtimeDeviceIds(DEVICES);

  _fasheUpdateUI(fasheDevices);
  if (addedCount > 0) {
    const products = typeof formatReceiverProductSummary === 'function' ? formatReceiverProductSummary(nextFasheDevices) : '接收机';
    notify('📡', '接收机已加载', `${products}：新增 ${addedCount} 个通道，共 ${nextFasheDevices.length} 个实时通道`);
  }
  console.log('[FAshe] 收到设备列表:', fasheDevices.length, '台');

  // 按 receiver_ip 聚合接收机，更新频率规划目标通道数
  _rebuildReceiversFromDevices(fasheDevices, {renderCards:true});
}

// ── 处理 FAshe 周期性数据更新 ─────────────────────────────────────
function _mqtt6RecommendationKey(device) {
  if (!device) return null;
  const live=!!(device._fasheId||device.receiver_id||device.receiverId||device._serverManaged);
  const online=device._online===true||device.online===true||['online','warn','error'].includes(device.status);
  if(!live||!online||(typeof _deviceIsOffline==='function'&&_deviceIsOffline(device)))return null;
  const fields=['id','_fasheId','receiver_id','receiverId','receiver_ip','receiver_mac','ip','mac','brand','model',
      'channel_number','channel','ch','freq','equipmentProfileId','equipment_profile_id','equipmentBandId','equipmentModeId','capabilities'];
  return JSON.stringify(Object.fromEntries(fields.filter(field=>device[field]!==undefined).map(field=>[field,device[field]])));
}

function _fasheHandleDeviceUpdate(updates) {
  if (!updates || updates.length === 0) return;

  let recommendationRefresh=false;
  const changedDevices=[];
  updates.forEach(upd => {
    const existIdx = _fasheFindMatchingIndex(DEVICES, upd);
    const recommendationBefore=_mqtt6RecommendationKey(DEVICES[existIdx]);

    if (existIdx >= 0) {
      // 更新现有设备的实时数据
      const dev = DEVICES[existIdx];
      // Omitted product fields are deltas; explicit empty values clear old labels.
      if (Object.prototype.hasOwnProperty.call(upd, 'brand')) {
        const raw = typeof upd.brand === 'string' ? upd.brand.trim() : '';
        dev.brand = raw === 'DATY audio' ? 'DATYaudio' : (raw || '未知品牌');
      }
      if (Object.prototype.hasOwnProperty.call(upd, 'model')) dev.model = typeof upd.model === 'string' && upd.model.trim() ? upd.model.trim() : '未知型号';
      if (upd.rfLevel !== undefined || upd.rf !== undefined) {
        const rfRaw = upd.rfLevel !== undefined ? upd.rfLevel : upd.rf;
        dev.rf = _fasheNormalizeRf(rfRaw);
      }
      if (upd.af_dbfs !== undefined || upd.afDbfs !== undefined || upd.afLevel !== undefined || upd.af_level !== undefined || upd.af !== undefined) {
        // 只在更新包完全没有 AF 字段时才允许沿用旧值；显式 null、NaN
        // 或越界值代表本次遥测不可用，必须清除旧 AF，避免继续触发旧告警。
        const normalizedAf = _fasheNormalizeAf(upd, null);
        dev.afDbfs = normalizedAf.dbfs;
        dev.af = normalizedAf.percent;
      }
      if (upd.battery !== undefined || upd.batt !== undefined) {
        const battRaw = upd.battery !== undefined ? upd.battery : upd.batt;
        dev.batt = _fasheNormalizeBattery(battRaw);
      }
      if (upd.muted !== undefined) dev.muted = _fasheNormalizeMuted(upd.muted, dev.muted);
      if (Object.prototype.hasOwnProperty.call(upd, 'shure')) dev.shure = upd.shure;
      if (upd.capabilities !== undefined) dev.capabilities = upd.capabilities;
      if (Object.prototype.hasOwnProperty.call(upd, 'heartbeat')) dev.heartbeat = normalizeReceiverHeartbeat(upd.heartbeat);
      if (upd.channel !== undefined || upd.ch !== undefined) {
        const incomingRaw = upd.channel_number ?? upd.channel_no
          ?? (upd.channel !== undefined ? upd.channel : upd.ch) ?? upd.channel_key;
        const incomingNumber = typeof getCanonicalChannelNumber === 'function'
          ? getCanonicalChannelNumber(incomingRaw, null) : null;
        if (incomingNumber !== null) {
          dev.channel_number = incomingNumber;
          dev.channel = incomingNumber;
          dev.ch = `CH${incomingNumber}`;
          dev.channel_key = `CH${incomingNumber}`;
        }
      }
      const receiverId = _fasheGetReceiverId(upd);
      if (receiverId) dev.receiverId = receiverId;
      if (upd.receiver_id || upd.receiverId) dev.receiver_id = upd.receiver_id || upd.receiverId;
      if (upd.receiver_ip || upd.ip) {
        dev.receiver_ip = upd.receiver_ip || upd.ip;
        dev.ip = upd.receiver_ip || upd.ip;
      }
      if (upd.receiver_mac || upd.receiverMac || upd.mac_address || upd.mac) {
        dev.receiver_mac = upd.receiver_mac || upd.receiverMac || upd.mac_address || upd.mac;
        dev.mac = dev.receiver_mac;
      }
      if (Object.prototype.hasOwnProperty.call(upd, 'group')) dev.group = upd.group;
      if (Object.prototype.hasOwnProperty.call(upd, 'group_number')) dev.group_number = upd.group_number;
      if (Object.prototype.hasOwnProperty.call(upd, 'group_source')) dev.group_source = upd.group_source;
      if (upd._online !== undefined) {
        const onlineRaw = upd._online;
        dev._online = !_fasheIsOfflineFlag(onlineRaw);
      } else if (dev._online === undefined) {
        dev._online = true;
      }
      // 频率边界：内部统一为整数 kHz；兼容 MQTT 的 MHz 和遗留 kHz。
      dev.freq = DatyFrequency.frequencyFromPayload(upd, dev.freq);
      // 在线状态与静音状态独立；静音不得映射为 offline。
      // 硬件 error/offline 保留；online/warn 与当前可配置阈值合并，避免服务端旧阈值覆盖设置。
      const incomingStatus = String(upd.status || '').toLowerCase();
      if (_fasheIsOfflineFlag(dev._online) || _fasheIsOfflineStatus(incomingStatus)) dev.status = 'offline';
      else if (incomingStatus === 'error' || incomingStatus === '2') dev.status = 'error';
      else dev.status = _fasheThresholdStatus(dev.rf, dev.batt, dev.afDbfs);
      dev._thresholdStatusManaged = true;
      dev._lastRealtimeAt = Date.now();
      if (typeof applyConfirmedShureMuteView === 'function') applyConfirmedShureMuteView(dev);
    } else {
      // 增量推送可能先于注册快照到达（例如 SSE 重连）；新通道不能被静默丢弃。
      DEVICES.push(_fasheNormalizeDevice(upd));
    }
    changedDevices.push(existIdx>=0?DEVICES[existIdx]:DEVICES[DEVICES.length-1]);
    if(recommendationBefore!==_mqtt6RecommendationKey(existIdx>=0?DEVICES[existIdx]:DEVICES[DEVICES.length-1]))recommendationRefresh=true;
  });

  const onlineReceivers = new Set(
    DEVICES
      .filter(dev => dev._fasheId && (typeof _dashboardIsDeviceOnline === 'function'
        ? _dashboardIsDeviceOnline(dev)
        : (!_fasheIsOfflineFlag(dev._online) && ['online', 'warn'].includes(String(dev.status || '').trim().toLowerCase()))))
      .map(_fasheGetReceiverId)
      .filter(Boolean)
  );
  const onlineCount = onlineReceivers.size;
  _fasheUpdateUI(updates, onlineCount, recommendationRefresh, changedDevices);
}

// ── 处理静音指令事件 ───────────────────────────────────────────────
function _fasheHandleMuteCommand(cmd) {
  if (!cmd || !['mute', 'unmute'].includes(cmd.command)) {
    console.warn('[FAshe] 无效的静音指令:', cmd);
    return;
  }

  const isMute = cmd.command === 'mute';
  const rawChannel = cmd.channel_number ?? cmd.channel_no ?? cmd.channel ?? cmd.ch ?? cmd.channel_key;
  const channelNumber = typeof getCanonicalChannelNumber === 'function'
    ? getCanonicalChannelNumber(rawChannel, null) : null;
  if (channelNumber === null) {
    console.warn('[FAshe] 拒绝没有有效 CH 号的静音指令（Group 不可作为 CH）:', cmd);
    return;
  }
  const chLabel = `CH${channelNumber}`;
  const commandIdentity = {
    ...cmd,
    _fasheId: cmd.device_id || cmd._fasheId || '',
    id: cmd.device_id || cmd.id || '',
    receiver_id: cmd.receiver_id || cmd.receiverId,
    receiver_ip: cmd.receiver_ip || cmd.ip,
    receiver_mac: cmd.receiver_mac || cmd.receiverMac || cmd.mac_address || cmd.mac,
  };
  const targetAliases = _fasheReceiverAliases(commandIdentity);
  if (targetAliases.size === 0) {
    console.warn('[FAshe] 拒绝没有接收机身份的静音指令:', cmd);
    return;
  }
  const candidates = DEVICES.map((d, index) => ({d, index})).filter(({d}) => {
    if (!d || !d._fasheId || _fasheGetChannelKey(d) !== `CH${channelNumber}`) return false;
    return [..._fasheReceiverAliases(d)].some(alias => targetAliases.has(alias));
  });
  const exact = cmd.device_id
    ? candidates.find(item => String(item.d._fasheId) === String(cmd.device_id))
    : null;
  const existIdx = exact ? exact.index : (candidates.length === 1 ? candidates[0].index : -1);
  if (existIdx >= 0) {
    const dev = DEVICES[existIdx];
    // 协议中的 muted 可能是字符串；严格归一化后再判断边沿，
    // 避免 "false" 被当成真值导致 UI 反向闪烁。
    const wasMuted = _fasheNormalizeMuted(dev.muted, false);
    dev.muted = isMute;

    console.log(`[FAshe] 更新静音状态: ${dev.name} ${chLabel} -> ${isMute ? '已静音' : '已取消静音'}`);

    // 如果状态发生变化，显示通知并更新 UI
    if (wasMuted !== isMute) {
      notify(
        isMute ? '🔇' : '🔊',
        isMute ? '通道已静音' : '通道已取消静音',
        `${dev.name} (${chLabel})`
      );

      // 强制刷新通道总览面板
      renderDeviceGridChannels(DEVICES);
    }
  } else {
    console.warn(`[FAshe] 未找到唯一目标通道: ${chLabel}`, cmd);
  }
}

// ── 将 FAshe 设备格式标准化为 DATY 格式 ──────────────────────────
function _fasheNormalizeDevice(fd, devicesForIds = DEVICES) {
  const newId = allocateLocalDeviceId(devicesForIds);
  // 频率必须来自设备报文；缺失/非法时保留 null，不能再用 614.750 MHz
  // 之类的演示频率填充。bridge 当前对外的 `freq` 是 kHz，旧报文的
  // `frequency`/`freq_mhz` 可能是 MHz，因此按字段明确单位解析。
  const freqKHz = DatyFrequency.frequencyFromPayload(fd);
  const rfRaw = fd.rfLevel !== undefined ? fd.rfLevel : fd.rf;
  const rf = _fasheNormalizeRf(rfRaw);
  const normalizedAf = _fasheNormalizeAf(fd);
  const battRaw = fd.battery !== undefined ? fd.battery : fd.batt;
  const batt = _fasheNormalizeBattery(battRaw);
  // 通道号只来自显式 channel_number/channel/CH 标记；Group 从不当作 CH。
  const rawChannel = fd.channel_number ?? fd.channel_no ?? fd.channel ?? fd.ch ?? fd.channel_key;
  let channelNumber = typeof getCanonicalChannelNumber === 'function'
    ? getCanonicalChannelNumber(rawChannel, null) : null;
  if (channelNumber === null) {
    const idChannel = String(fd.id ?? '').match(/_ch(\d+)$/i)?.[1];
    channelNumber = idChannel ? Number(idChannel) : null;
  }
  const chLabel = channelNumber === null ? 'CH?' : `CH${channelNumber}`;
  // 规范化 brand：支持 "DATY audio"(有空格) → "DATYaudio"
  const rawBrand = fd.brand || '';
  const brandMap = {
    'DATY audio': 'DATYaudio',
    'DATYaudio': 'DATYaudio',
  };
  const normalizedBrand = brandMap[rawBrand] || (typeof rawBrand === 'string' && rawBrand.trim() ? rawBrand.trim() : '未知品牌');
  const receiverId = _fasheGetReceiverId(fd);
  const receiverIp = fd.receiver_ip || fd.receiverIp || fd.ip || fd.ipAddress || '';
  const receiverMac = fd.receiver_mac || fd.receiverMac || fd.mac_address || fd.mac || '';
  // 稳定身份必须由设备 ID 或“接收机 + CH”组成；名称可能在两台接收机
  // 上重复，不能作为跨接收机匹配/静音路由键。
  const stableDeviceId = fd.id ?? (
    receiverId && channelNumber !== null ? `${receiverId}_ch${channelNumber}` : undefined
  );

  const normalized = {
    id:      newId,
    ch:      chLabel,
    channel: channelNumber,
    channel_number: channelNumber,
    channel_key: channelNumber === null ? '' : `CH${channelNumber}`,
    name:    fd.name || `${normalizedBrand} ${chLabel}`,
    brand:   normalizedBrand,
    model:   fd.model || '未知型号',
    ip:      receiverIp,
    receiver_ip: receiverIp,
    receiver_mac: receiverMac,
    freq:    freqKHz,
    rf:      rf,
    af:      normalizedAf.available ? normalizedAf.percent : null,
    afDbfs:  normalizedAf.available ? normalizedAf.dbfs : null,
    afUnit:  'dBFS',
    batt:    batt,
    // 状态：优先使用服务端返回的 status
    status:  (_fasheIsOfflineFlag(fd._online) || _fasheIsOfflineStatus(fd.status)) ? 'offline'
      : (['error', '2'].includes(String(fd.status || '').toLowerCase()) ? 'error'
        : _fasheThresholdStatus(rf, batt, normalizedAf.dbfs)),
    planned: freqKHz || 0,
    muted:   _fasheNormalizeMuted(fd.muted),   // 静音状态
    shure: fd.shure || null,
    capabilities: fd.capabilities || null,
    heartbeat: normalizeReceiverHeartbeat(fd.heartbeat),
    equipmentProfileId: fd.equipmentProfileId || fd.equipment_profile_id || (normalizedBrand === 'DATYaudio' ? 'datyaudio-generic' : undefined),
    equipmentBandId: fd.equipmentBandId || fd.equipment_band_id,
    equipmentModeId: fd.equipmentModeId || fd.equipment_mode_id,
    _fasheId: stableDeviceId,     // 记录接收机+CH稳定 ID 用于后续匹配
    receiverId,
    receiver_id: receiverId,
    group: fd.group,
    group_number: fd.group_number,
    group_source: fd.group_source,
    _online: !_fasheIsOfflineFlag(fd._online),
    _source: fd._source,
    _thresholdStatusManaged: true,
    _serverManaged: false,
    _lastRealtimeAt: Date.now(),
  };
  return typeof applyConfirmedShureMuteView === 'function' ? applyConfirmedShureMuteView(normalized) : normalized;
}

// ── 更新 UI 和统计信息 ────────────────────────────────────────────
let _fasheUiPending = false;
let _fasheUiLatest = null;
let _fasheUiCancel = null;
function _fasheUpdateUI(devices, onlineCount, recommendationRefresh=true, changedDevices) {
  _fasheLastReceivedAt = performance.now();
  // 每笔状态先评估告警，不能把同一帧内的“越限→恢复”合并丢失。
  if (typeof evaluateRealtimeAlerts === 'function') evaluateRealtimeAlerts(DEVICES,{recommendationRefresh,changedDevices});
  _fasheUiLatest = {devices, onlineCount};
  if (_fasheUiPending) return;
  _fasheUiPending = true;
  let frame, timer;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    _fasheUiPending = false;
    _fasheUiCancel = null;
    clearTimeout(timer);
    if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  };
  _fasheUiCancel = cancel;
  const flush = () => {
    if (cancelled) return;
    cancel();
    _fasheFlushUI(_fasheUiLatest.devices, _fasheUiLatest.onlineCount);
  };
  // 网络、状态、ACK 不依赖 rAF。仅 DOM 合并到下一帧，后台页面用定时器兜底。
  timer = setTimeout(flush, 50);
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(flush);
}

function _fasheFlushUI(devices, onlineCount) {
  _fasheLastUpdateAt = Number.isFinite(Number(_fasheLastServerTimeMs))
    ? Number(_fasheLastServerTimeMs) : Date.now();
  const ts = new Date(_fasheLastUpdateAt).toLocaleTimeString('zh-CN');
  const online = onlineCount != null ? onlineCount : new Set(
    devices
    .filter(d => (typeof _deviceConnectionIsOnline === 'function'
      ? _deviceConnectionIsOnline(d)
      : (!_fasheIsOfflineFlag(d._online) && !_fasheIsOfflineStatus(d.status)))
      && (d.status === undefined || ['online', 'warn', '0', '1'].includes(String(d.status).trim().toLowerCase())))
      .map(_fasheGetReceiverId)
      .filter(Boolean)
  ).size;

  // 更新状态栏（不重建 DOM，只更新 textContent）
  const msgEl    = document.getElementById('fasheMsgCount');
  const onlineEl = document.getElementById('fasheOnlineCount');
  const timeEl   = document.getElementById('fasheLastTime');
  const clockEl  = document.getElementById('fasheClockSource');
  const lastEl   = document.getElementById('fasheLastUpdate');
  if (msgEl) msgEl.textContent = _fasheMsgCount;
  if (onlineEl) onlineEl.textContent = online;
  if (timeEl) timeEl.textContent = ts;
  if (clockEl) clockEl.textContent = Number.isFinite(Number(_fasheLastServerTimeMs)) ? 'fuwuqi' : '本机（未校时）';
  if (lastEl) lastEl.style.display = '';

  _fasheSetStatus('ok', `已连接 · ${online} 台在线`, online);

  if (typeof _refreshReceiverCardsFromLiveState === 'function') _refreshReceiverCardsFromLiveState();
  forceRefreshAllPanels({realtime: true, alertsEvaluated: true});
}

// ── 自动连接（页面加载后立即连接 SSE）──────────────────────────────
// 打开软件即自动接收 FAshe 数据，无需手动点"开始接收"
document.addEventListener('DOMContentLoaded', () => {
  const urlEl = document.getElementById('fasheApiUrl');
  if (urlEl) {
    const savedUrl = (globalThis.DatyPlatform?.storage || localStorage).getItem('daty_fashe_api_url');
    try { _fasheApiUrl = normalizeFasheApiUrl(savedUrl || _fasheApiUrl); }
    catch (error) {
      urlEl.value = savedUrl || urlEl.value;
      _fasheApiUrl = urlEl.value; // Invalid selection must not authorize a different default server.
      _fasheReconnectEnabled = false;
      _fasheSetStatus('err', '请更新 HTTPS 地址', null);
      notify('⚠️', 'Bridge 地址需要更新', error.message);
    }
    if (_fasheReconnectEnabled) urlEl.value = _fasheApiUrl;
    if (_fasheReconnectEnabled && savedUrl && savedUrl !== _fasheApiUrl) (globalThis.DatyPlatform?.storage || localStorage).setItem('daty_fashe_api_url', _fasheApiUrl);
    urlEl.addEventListener('change', () => {
      try { urlEl.value = normalizeFasheApiUrl(urlEl.value); }
      catch (error) { notify('⚠️', 'Bridge 地址无效', error.message); return; }
      (globalThis.DatyPlatform?.storage || localStorage).setItem('daty_fashe_api_url', urlEl.value);
    });
  }
  // Restore the existing server-side discovery snapshot on every page load;
  // do not start another active network scan merely because the browser refreshed.
  if (_fasheReconnectEnabled && typeof scanForReceivers === 'function') void scanForReceivers({passive:true,quiet:true});
  // 页面加载 1 秒后自动连接 SSE
  setTimeout(() => {
    console.log('[FAshe] 自动连接 MQTT Bridge...');
    _fasheConnect();
  }, 1000);
});

// ── 打开远程 WS 探测工具 ──────────────────────────────────────────────
function openWsProbe() {
  const urlEl = document.getElementById('wsProbeUrl');
  const targetUrl = urlEl ? urlEl.value.trim() : 'wss://127.0.0.1:8801';
  try { if (new URL(targetUrl).protocol !== 'wss:') throw new Error('仅允许 WSS 探测地址'); }
  catch (error) { notify('⚠️', '安全连接要求', error.message); return; }
  const encoded = encodeURIComponent(targetUrl);
  window.open(`ws-probe.html?url=${encoded}&mode=http&autoconnect=1`, '_blank');
}

