// ============================================================
// ip-detection.js — 自动IP检测（ip-service / fetch / WebRTC）
// ============================================================

// ══════════════════ AUTO IP DETECTION ARCHITECTURE ══════════════════
// 优先级: 1.本地API服务(8765) → 2.local-ip.json → 3.WebRTC → 4.手动设置
// 支持: 定时刷新(60s) + 网络变化检测 + 多网卡显示

const IP_SERVICE_URL = (globalThis.DatyPlatformFactory
  ? globalThis.DatyPlatformFactory.serviceOrigin('ip', globalThis.location?.hostname)
  : 'https://127.0.0.1:8765') + '/api/ip';
const IP_REFRESH_INTERVAL = 60000; // 60秒自动刷新
let _ipRefreshTimer = null;
let _currentDetectedIPs = [];

function _ipRuntime(method, ...args) {
  if (globalThis.DatyHostFactory) return globalThis.DatyHostFactory.invokeRuntime(globalThis, method, ...args);
  if (globalThis.DatyPlatform !== undefined && globalThis.DatyPlatform?.kind !== 'browser') {
    throw new TypeError('DatyHost: native runtime capability is unavailable');
  }
  if (method === 'nowEpochMs') return Date.now();
  return globalThis[method](...args);
}

// Address preference only: injected native storage must not fall back to browser storage.
function _ipPreferenceStorage() {
  return globalThis.DatyPlatform === undefined ? localStorage : globalThis.DatyPlatform.storage;
}

// Keep host ownership and method binding. A failed/missing native request port
// must not start browser I/O; async also routes synchronous host errors through
// the existing probe-failure path, preserving API -> JSON -> saved/manual IP.
async function _ipRequest(url, options) {
  const platform = globalThis.DatyPlatform;
  if (platform === undefined) return fetch(url, options);
  if (!platform || typeof platform.request !== 'function') {
    throw new TypeError('DatyPlatform: IP detection requires the host request port');
  }
  return platform.request(url, options);
}

// 判断是否是私网 IP（精简版，供全局使用）
function isPrivateIP(ip) {
  if (!ip) return false;
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;
  // 兼容非标准私网段（192.169.x ~ 192.175.x）
  const m = ip.match(/^192\.(\d+)\./);
  if (m) { const n = parseInt(m[1]); if (n >= 168 && n <= 175) return true; }
  return false;
}

// 从候选列表选最佳私网 IP
function selectBestLocalIP(ipArray) {
  if (!ipArray || ipArray.length === 0) return null;
  const pri = [
    ip => ip.startsWith('192.168.'),
    ip => ip.startsWith('192.169.'),
    ip => ip.startsWith('10.'),
    ip => /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip),
    ip => isPrivateIP(ip),
  ];
  for (const fn of pri) {
    const found = ipArray.find(fn);
    if (found) return found;
  }
  return ipArray[0] || null;
}

// 更新 UI 中所有 IP 显示元素
function applyIPToUI(ip, source) {
  const ipEl = document.getElementById('localIP');
  const settingsEl = document.getElementById('settingsLocalIP');
  const dotEl = ipEl ? ipEl.previousElementSibling : null;

  if (ip) {
    if (ipEl) ipEl.textContent = `局域网 ${ip}`;
    if (settingsEl) settingsEl.value = ip;
    if (dotEl) { dotEl.className = 'dot dot-green'; }
    _ipPreferenceStorage().setItem('daty_local_ip', ip);
    console.log(`[IP] 已获取 (${source}): ${ip}`);
  } else {
    if (ipEl) ipEl.textContent = '局域网 (点击设置)';
    if (settingsEl) settingsEl.value = '未获取';
    if (dotEl) { dotEl.className = 'dot dot-amber'; }
  }
}

// ── 方案1: 本地 IP API 服务（ip-service.py 运行时）──
async function fetchIPFromAPIService() {
  let timer;
  const controller = new AbortController();
  try {
    timer = _ipRuntime('setTimeout', () => controller.abort(), 2000);
    return await _ipRequest(IP_SERVICE_URL, { redirect: 'error', signal: controller.signal })
    .then(r => r.json())
    .then(data => {
      if (data.success && data.ip) {
        _currentDetectedIPs = data.all_ips || [data.ip];
        applyIPToUI(data.ip, 'IP服务');
        return true;
      }
      return false;
    })
    .catch(() => false);
  } catch (_) { return false; }
  finally { if (timer !== undefined) _ipRuntime('clearTimeout', timer); }
}

// ── 方案2: 读取 local-ip.json（启动脚本生成的静态文件）──
function fetchIPFromFile() {
  const base = globalThis.DatyPlatformFactory
    ? globalThis.DatyPlatformFactory.serviceOrigin('web', globalThis.location?.hostname) : 'https://127.0.0.1:8080';
  return _ipRequest(base + '/local-ip.json?t=' + _ipRuntime('nowEpochMs'), {redirect: 'error'})
    .then(r => r.json())
    .then(data => {
      if (data.success && data.ip) {
        _currentDetectedIPs = data.all_ips || [data.ip];
        applyIPToUI(data.ip, 'JSON文件');
        return true;
      }
      return false;
    })
    .catch(() => false);
}

// ── 方案3: WebRTC 本地候选（浏览器兜底）──
function fetchIPViaWebRTC() {
  // WebRTC is a browser-only fallback, not a substitute for native host I/O.
  const platform = globalThis.DatyPlatform;
  if (platform !== undefined && (!platform || platform.kind !== 'browser')) return Promise.resolve(false);
  return new Promise(resolve => {
    const RTCPeerConnection = window.RTCPeerConnection ||
      window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
    if (!RTCPeerConnection) { resolve(false); return; }

    const ips = [];
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      const best = selectBestLocalIP(ips);
      if (best) {
        _currentDetectedIPs = ips;
        applyIPToUI(best, 'WebRTC');
        resolve(true);
      } else {
        resolve(false);
      }
      try { pc.close(); } catch(e) {}
    };

    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('_ip');
      pc.onicecandidate = e => {
        if (!e.candidate) return;
        const m = e.candidate.candidate.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (m) {
          const ip = m[1];
          if (ip !== '127.0.0.1' && !ip.startsWith('169.254') && !ips.includes(ip)) {
            ips.push(ip);
            if (isPrivateIP(ip) && !done) finish();
          }
        }
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => finish());
      _ipRuntime('setTimeout', finish, 3000);
    } catch(e) { resolve(false); }
  });
}

// ── 主入口：依次尝试各方案 ──
async function getLocalIP() {
  const ipEl = document.getElementById('localIP');
  if (ipEl) ipEl.textContent = '检测中...';

  // 优先方案1: API 服务
  let ok = await fetchIPFromAPIService();

  // 降级方案2: JSON 文件
  if (!ok) ok = await fetchIPFromFile();

  // 降级方案3: WebRTC
  if (!ok) ok = await fetchIPViaWebRTC();

  // 全部失败：尝试从同一平台存储恢复
  if (!ok) {
    const saved = _ipPreferenceStorage().getItem('daty_local_ip');
    if (saved && isPrivateIP(saved)) {
      applyIPToUI(saved, '缓存');
    } else {
      applyIPToUI(null, '无');
    }
  }

  // 启动定时刷新（检测网络变化）
  if (_ipRefreshTimer) _ipRuntime('clearInterval', _ipRefreshTimer);
  _ipRefreshTimer = _ipRuntime('setInterval', async () => {
    const prev = _ipPreferenceStorage().getItem('daty_local_ip');
    const refreshed = await fetchIPFromAPIService() || await fetchIPFromFile();
    if (!refreshed) return;
    const curr = _ipPreferenceStorage().getItem('daty_local_ip');
    if (curr && curr !== prev) {
      console.log(`[IP] 网络变化: ${prev} → ${curr}`);
      notify('🌐', 'IP 已更新', `本机网络地址变更为 ${curr}`);
    }
  }, IP_REFRESH_INTERVAL);
}

// 更新设置页面的 IP 显示（兼容旧调用）
function updateSettingsIP(ip) {
  const input = document.getElementById('settingsLocalIP');
  if (input) input.value = ip || '未获取';
}

function showIPSettings() {
  const savedIP = _ipPreferenceStorage().getItem('daty_local_ip') || '';
  
  // 构建多网卡 IP 快捷选项
  const ipListHTML = _currentDetectedIPs.length > 1
    ? `<div style="margin-bottom:12px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">检测到的网卡 IP（点击快速填入）</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          ${_currentDetectedIPs.map(ip => `<button onclick="document.getElementById('manualIP').value='${ip}'" 
            style="background:var(--bg3);border:1px solid var(--border);color:${isPrivateIP(ip)?'#6ee7b7':'var(--muted)'};
            padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;font-family:'Cascadia Code','Consolas',monospace;">
            ${ip}</button>`).join('')}
        </div>
      </div>` : '';

  const html = `
    <div id="ipSettingsModal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;">
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;width:420px;max-height:90vh;overflow-y:auto;">
        <div style="padding:16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:var(--bg2);z-index:1;">
          <span style="font-size:15px;font-weight:700;">🌐 网络设置</span>
          <button onclick="document.getElementById('ipSettingsModal').remove()" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;">×</button>
        </div>
        <div style="padding:16px;display:flex;flex-direction:column;gap:12px;">
          
          <!-- 自动检测状态 -->
          <div id="ipDetectStatus" style="background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.3);border-radius:8px;padding:10px;font-size:12px;">
            <div style="display:flex;align-items:center;justify-content:space-between;">
              <span style="color:#a5b4fc;">🔍 自动检测</span>
              <button onclick="_redetectIP()" style="background:rgba(99,102,241,.2);border:1px solid rgba(99,102,241,.4);color:#a5b4fc;padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;">重新检测</button>
            </div>
            <div style="margin-top:6px;color:var(--muted);font-size:11px;" id="ipDetectDetail">
              优先级：<span style="color:#6ee7b7;">本地API服务</span> → JSON文件 → WebRTC → 手动设置
            </div>
          </div>
          
          ${ipListHTML}
          
          <!-- 手动输入 -->
          <div>
            <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:6px;">当前 IP 地址</label>
            <input type="text" id="manualIP" value="${savedIP}" placeholder="例如: 192.168.1.100" 
              style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:10px 12px;border-radius:6px;font-size:14px;font-family:'Cascadia Code','Consolas',monospace;">
          </div>
          
          <div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.25);border-radius:8px;padding:10px;font-size:11px;color:#fbbf24;">
            💡 <strong>自动获取失败时</strong>可手动输入，或运行 <code style="background:rgba(0,0,0,.3);padding:1px 5px;border-radius:3px;">ipconfig</code> 查看本机 IPv4 地址
          </div>
        </div>
        <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;position:sticky;bottom:0;background:var(--bg2);">
          <button class="btn btn-outline" onclick="document.getElementById('ipSettingsModal').remove()">取消</button>
          <button class="btn btn-primary" onclick="saveLocalIP()">💾 保存</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  _ipRuntime('setTimeout', () => document.getElementById('manualIP') && document.getElementById('manualIP').focus(), 100);
}

// 弹窗内一键重新检测
async function _redetectIP() {
  const statusEl = document.getElementById('ipDetectDetail');
  if (statusEl) statusEl.innerHTML = '<span style="color:#f59e0b;">检测中...</span>';
  
  let source = '未检测到';
  let ip = null;
  
  const ok1 = await fetchIPFromAPIService();
  if (ok1) { source = '本地API服务 ✓'; ip = _ipPreferenceStorage().getItem('daty_local_ip'); }
  else {
    const ok2 = await fetchIPFromFile();
    if (ok2) { source = 'JSON文件 ✓'; ip = _ipPreferenceStorage().getItem('daty_local_ip'); }
    else {
      const ok3 = await fetchIPViaWebRTC();
      if (ok3) { source = 'WebRTC ✓'; ip = _ipPreferenceStorage().getItem('daty_local_ip'); }
    }
  }

  if (ip && document.getElementById('manualIP')) {
    document.getElementById('manualIP').value = ip;
  }
  if (statusEl) {
    statusEl.innerHTML = ip
      ? `检测来源：<span style="color:#6ee7b7;">${source}</span>  →  <span style="color:#fff;font-family:monospace;">${ip}</span>`
      : `<span style="color:#f87171;">自动检测失败，请手动输入</span>`;
  }
}

function saveLocalIP() {
  const ip = document.getElementById('manualIP').value.trim();
  
  // 验证 IP 格式
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(ip)) {
    notify('❌', '格式错误', '请输入有效的 IP 地址格式');
    return;
  }
  
  // 验证每段数字范围
  const parts = ip.split('.');
  const valid = parts.every(p => parseInt(p) >= 0 && parseInt(p) <= 255);
  if (!valid) {
    notify('❌', '格式错误', 'IP 地址每段应在 0-255 之间');
    return;
  }
  
  _ipPreferenceStorage().setItem('daty_local_ip', ip);
  document.getElementById('localIP').textContent = `局域网 ${ip}`;
  
  const modal = document.getElementById('ipSettingsModal');
  if (modal) modal.remove();
  
  notify('✓', '设置成功', `本机 IP 已设置为 ${ip}`);
}

