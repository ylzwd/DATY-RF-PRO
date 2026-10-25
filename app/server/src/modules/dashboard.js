// ============================================================
// dashboard.js — 仪表板统计卡片更新
// ============================================================

// ══════════════════ DASHBOARD STATS ══════════════════
// 不同来源的快照可能把 _online/status 编码成布尔值、数字或字符串。
// 统一在这里归一化，避免字符串 "false" 被 JavaScript 当作在线真值。
const _OFFLINE_STATUS_VALUES = new Set([
  'offline', 'disconnected', 'disconnect', 'connection_lost',
  'connection-lost', 'timeout', 'unavailable', 'lost', 'false', 'no'
]);
const _FALSE_ONLINE_FLAG_VALUES = new Set(['false', '0', 'no', 'offline', ..._OFFLINE_STATUS_VALUES]);

function _deviceConnectionIsOnline(device) {
  if (!device || typeof device !== 'object') return false;
  const online = device._online;
  if (online === false || online === 0 || _FALSE_ONLINE_FLAG_VALUES.has(String(online ?? '').trim().toLowerCase())) {
    return false;
  }
  const status = String(device.status ?? '').trim().toLowerCase();
  return !_OFFLINE_STATUS_VALUES.has(status);
}

function _dashboardIsDeviceOnline(device) {
  if (!_deviceConnectionIsOnline(device)) return false;
  const status = String(device.status ?? '').trim().toLowerCase();
  // 部分实时协议只发送 `_online=true` 而不带 status；只在有明确在线
  // 标志或实时来源身份时接受这种快照，避免手工空记录被统计为在线。
  if (!status) {
    const online = device._online;
    return online === true || online === 1 || String(online ?? '').trim().toLowerCase() === 'true'
      || !!(device._fasheId || device._serverManaged || device._source);
  }
  // 兼容旧协议的 0=online、1=warn 编码。
  return status === 'online' || status === 'warn' || status === '0' || status === '1';
}

function _dashboardReceiverIdentity(device) {
  if (typeof getCanonicalReceiverKey === 'function') {
    const canonical = getCanonicalReceiverKey(device);
    if (canonical) return canonical;
  }
  const explicit = device.receiverId || device.receiver_id || device._receiver_id;
  if (explicit) return String(explicit).trim().replace(/(?:[_-])ch\d+$/i, '');
  const mac = device.receiver_mac || device.receiverMac || device.mac_address || device.mac;
  if (mac && String(mac).trim()) return `mac:${String(mac).trim().toLowerCase().replace(/-/g, ':')}`;
  if (device._fasheId !== undefined && device._fasheId !== null) {
    return String(device._fasheId).replace(/_ch\d+$/i, '');
  }
  if (device.ip && String(device.ip).trim()) return String(device.ip).trim();
  if (device._source && String(device._source).trim()) {
    return String(device._source).trim().replace(/:(mqtt|ws|sse)$/i, '');
  }
  return `manual:${device.id}`;
}

function _dashboardBrandKey(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'datyaudio' || normalized === 'daty') return 'DATYaudio';
  if (normalized === 'amsaudio' || normalized === 'ams') return 'AMSaudio';
  if (normalized === 'shure') return 'Shure';
  if (normalized === 'senn' || normalized === 'sennheiser') return 'Sennheiser';
  return '';
}

function _dashboardUniqueReceivers(devices, onlineOnly = false) {
  const receivers = new Map();
  devices.forEach(device => {
    if (onlineOnly && !_dashboardIsDeviceOnline(device)) return;
    const key = _dashboardReceiverIdentity(device);
    if (!receivers.has(key)) receivers.set(key, device);
  });
  return Array.from(receivers.values());
}

// 更新设备概览统计卡片
function updateDashboardStats() {
  const devices = typeof DEVICES !== 'undefined' && Array.isArray(DEVICES) ? DEVICES : [];
  const alerts = typeof ALERTS !== 'undefined' && Array.isArray(ALERTS) ? ALERTS : [];
  const onlineChannels = devices.filter(_dashboardIsDeviceOnline);
  const onlineReceivers = _dashboardUniqueReceivers(devices, true);
  const receiverCount = onlineReceivers.length;
  const channelCount = onlineChannels.length;
  
  // 统计各品牌数量
  const brandCount = { DATYaudio: 0, AMSaudio: 0, Shure: 0, Sennheiser: 0 };
  onlineReceivers.forEach(d => {
    const brand = _dashboardBrandKey(d.brand);
    if (brand && Object.prototype.hasOwnProperty.call(brandCount, brand)) brandCount[brand]++;
  });
  
  // 计算中心频率：根据频谱扫描输入框计算中心点
  const startInput = typeof document !== 'undefined' ? document.getElementById('specStart') : null;
  const endInput = typeof document !== 'undefined' ? document.getElementById('specEnd') : null;
  const scanStart = parseInt(startInput?.value, 10) || 400;
  const scanEnd = parseInt(endInput?.value, 10) || 900;
  const avgFreq = ((scanStart + scanEnd) / 2).toFixed(1);
  
  // 统计告警
  const alertCount = alerts.length;
  const lowBattAlerts = alerts.filter(a => String(a?.msg || '').includes('电量')).length;
  const rfAlerts = alerts.filter(a => String(a?.msg || '').includes('RF') || String(a?.msg || '').includes('信号')).length;
  const afAlerts = alerts.filter(a => String(a?.msg || '').includes('AF') || a?.metric === 'af').length;
  
  // 更新DOM
  const byId = id => typeof document !== 'undefined' ? document.getElementById(id) : null;
  const onlineEl = byId('statOnlineCount');
  const brandEl = byId('statBrandBreakdown');
  const activeEl = byId('statActiveChannels');
  const freqEl = byId('statCenterFreq');
  const alertEl = byId('alertCount');
  const alertBreakdownEl = byId('statAlertBreakdown');
  
  if (onlineEl) onlineEl.textContent = receiverCount;
  if (brandEl) brandEl.textContent = `DATYaudio ×${brandCount.DATYaudio} · AMSaudio ×${brandCount.AMSaudio} · Shure ×${brandCount.Shure} · Senn ×${brandCount.Sennheiser}`;
  if (activeEl) activeEl.textContent = channelCount;
  if (freqEl) freqEl.textContent = avgFreq;
  if (alertEl) alertEl.textContent = alertCount;
  if (alertBreakdownEl) {
    if (alertCount === 0) {
      alertBreakdownEl.textContent = '无告警';
    } else {
      const parts = [];
      if (lowBattAlerts > 0) parts.push(`${lowBattAlerts} 低电量`);
      if (rfAlerts > 0) parts.push(`${rfAlerts} RF弱信号`);
      if (afAlerts > 0) parts.push(`${afAlerts} AF过载`);
      alertBreakdownEl.textContent = parts.join(' · ') || '系统正常';
    }
  }
}

