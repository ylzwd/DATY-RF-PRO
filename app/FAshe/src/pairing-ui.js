(function() {
  'use strict';
  const timers = globalThis.FasheNetworkTimers || globalThis;
  const security = DatyReceiverSecurity.createSession();
  const automatic = DatyAutoPair.create({browser:window});
  let autoPending = null, autoAbort = null, retryTimer = null, autoWanted = false, attempts = 0;
  let assignment = null, autoSession = false, expiryStopped = false;
  let returnFocus = null;
  const el = id => document.getElementById(id);
  function identity() {
    return {receiver_mac: getLocalMacAddress(), brand: el('deviceBrand').value,
      max_channels: Number(el('deviceCount').value)};
  }
  function render() {
    const pairing = security.publicInfo();
    const request = {...DatyReceiverSecurity.identity(identity()), protocol: 'daty-pairing-request-v1'};
    el('pairingIdentity').value = JSON.stringify(request, null, 2);
    el('pairingSummary').textContent = pairing ? `${pairing.brand} · CH ≤ ${pairing.max_channels}${assignment ? ` · GROUP${assignment.group_number} · IP ${assignment.receiver_ip}` : ''} · 有效至 ${new Date(pairing.expires_at * 1000).toLocaleString()}` : '等待自动接入。浏览器保存不可导出的身份私钥，连接密钥只在页面内存中使用，无需复制 MAC 或导入文件。';
    el('pairingFingerprint').textContent = pairing ? `CA SHA-256：${pairing.ca_sha256}` : 'CA SHA-256：接入或导入后显示；浏览器必须预先信任管理员提供的服务器 CA。';
    el('serverAddress').value = pairing ? pairing.broker_url : el('autoPairServer').value;
    el('pairingButton').textContent = pairing ? '🔐 已配对 · 管理' : '🔐 自动接入 · 设置';
    el('forgetPairing').disabled = !pairing;
  }
  function open() {
    returnFocus = document.activeElement;
    render(); el('pairingFeedback').textContent = '';
    const modal = el('pairingDialog');
    if (!modal.open) modal.showModal();
  }
  function close() {
    el('pairingDialog').close();
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  async function importFile(file) {
    if (!file) return;
    if (file.size > 16384) throw new Error('配对文件过大（上限 16 KB）');
    if (!el('pairingTrustCheck').checked) throw new Error('请先确认文件来自服务器管理员，并已按部署说明信任内部 CA');
    if (typeof isPoweredOn !== 'undefined' && isPoweredOn) throw new Error('请先关机再更换配对，避免中断正在执行的通道控制');
    cancelAuto(); autoSession = false;
    const text = await file.text();
    const publicData = security.importBundle(text, identity());
    assignment = null; delete groupMapping[getLocalMacAddress()];
    render();
    el('pairingFeedback').textContent = '配对文件已载入内存。核对 CA 指纹后关闭此窗口，点击开机。此状态不代表服务器已接受配对。';
    return publicData;
  }
  function forget() {
    disconnect(); security.clear(); stopPing();
    autoSession = false; assignment = null; delete groupMapping[getLocalMacAddress()];
    render(); el('pairingFeedback').textContent = '已清除当前页面连接凭据并停止自动接入；浏览器身份保留。再次接入沿用原 GROUP；彻底撤销请在服务器操作。';
  }
  function validateAssignment(value) {
    if (!value || value.group_source !== 'server-fifo-v1' || value.ip_source !== 'socket-peer'
        || !Number.isInteger(value.group_number) || value.group_number < 1
        || (value.receiver_mac && value.receiver_mac !== getLocalMacAddress())
        || !(isLanIPv4(value.receiver_ip) || value.receiver_ip === '127.0.0.1')) throw new Error('服务器接收机登记信息无效');
  }
  function applyAssignment(value) {
    validateAssignment(value);
    const changed = !assignment || assignment.group_number !== value.group_number || assignment.receiver_ip !== value.receiver_ip;
    assignment = Object.freeze({receiver_ip:value.receiver_ip, group_number:value.group_number, ip_source:'socket-peer'});
    groupMapping[getLocalMacAddress()] = value.group_number;
    el('localIP').value = value.receiver_ip;
    if (el('ipHint')) el('ipHint').textContent = '服务器确认的连接来源 IP（由网络分配，不是网页 DHCP）';
    if (changed) { render(); if (typeof renderDevices === 'function') renderDevices(); }
  }
  function cancelAuto() {
    autoWanted = false;
    if (autoAbort) autoAbort.abort();
    timers.clearTimeout(retryTimer); retryTimer = null;
  }
  function autoConnect(options = {}) {
    if (autoPending) return autoPending;
    autoWanted = true;
    timers.clearTimeout(retryTimer); retryTimer = null;
    autoAbort = new AbortController();
    const signal = autoAbort.signal;
    autoPending = (async () => {
      if (typeof acquireReceiverOwnership === 'function' && !await acquireReceiverOwnership()) throw new Error('本模拟接收机已有 FAshe 页面运行，请返回原页面。');
      if (signal.aborted || !autoWanted) return;
      if (!acquireInstanceLease(getLocalMacAddress())) throw new Error('本模拟接收机已有页面运行，请关闭重复页面');
      const origin = DatyAutoPair.serverOrigin(el('autoPairServer').value.trim());
      // Public connection preference only. Never store MQTT secret in localStorage.
      try { localStorage.setItem('fashe_auto_server_v1', origin); } catch (_) {}
      el('pairingFeedback').textContent = '正在自动请求服务器登记…';
      const expected = identity();
      const result = await automatic.enroll(origin, expected, signal);
      if (signal.aborted || !autoWanted) return;
      const current = identity();
      if (JSON.stringify(expected) !== JSON.stringify(current)) throw new Error('登记期间配置发生变化，请重新接入');
      // Validate BOTH parts before changing visible IP/GROUP or active transport.
      DatyReceiverSecurity.validateBundle(result.pairing, expected, Date.now());
      validateAssignment({...result, receiver_mac:result.pairing.receiver_mac});
      security.importBundle(result.pairing, expected);
      applyAssignment({...result, receiver_mac:result.pairing.receiver_mac});
      autoSession = true; expiryStopped = false; attempts = 0; render();
      el('pairingFeedback').textContent = `登记成功：IP ${result.receiver_ip} · GROUP${result.group_number}，正在连接接收机通道…`;
      if (isPoweredOn) discoverAndConnect(); else connect();
    })().catch(error => {
      if (signal.aborted) return;
      const message = error.name === 'TypeError' || error.name === 'AbortError'
        ? '安全连接暂不可达，模拟器保持开机并自动重试。请通过「启动FAshe.bat」检查服务器网络和本机证书信任；不会改用明文连接。' : error.message;
      el('pairingFeedback').textContent = DatyReceiverSecurity.redact(message);
      log('WARN', message);
      if (isPoweredOn) { updateStatus('connecting'); updateServerStatus('reconnecting'); }
      else { releaseInstanceLease(); updateStatus('disconnected'); updateServerStatus('disconnected'); }
      el('serverStatusText').title = DatyReceiverSecurity.redact(message);
      if (autoWanted) retryTimer = timers.setTimeout(() => autoConnect(options), Math.min(30000, 3000 * 2 ** Math.min(attempts++, 4)));
    }).finally(() => {autoPending = null;});
    return autoPending;
  }
  function assertReady(url) { return security.assertReady(identity(), url); }
  function onPowerOn() { if (autoSession) autoWanted = true; }
  function connectTransport(url) { return security.connect(window.mqtt, identity(), url); }
  async function probe() {
    const info = assertReady();
    const start = performance.now();
    return new Promise(resolve => {
      let socket, timer, settled = false;
      const done = ok => {
        if (settled) return;
        settled = true; timers.clearTimeout(timer);
        if (socket) { socket.onopen = socket.onerror = socket.onclose = null; try { socket.close(); } catch (_) {} }
        resolve({ok, ms: Math.round(performance.now() - start), broker_url: info.broker_url});
      };
      try {
        // TLS handshake only: no CONNECT packet, pairing password, cookies or fallback host.
        socket = new WebSocket(info.broker_url, ['mqtt']);
        socket.onopen = () => done(true);
        socket.onerror = socket.onclose = () => done(false);
        timer = timers.setTimeout(() => done(false), 3000);
      } catch (_) { done(false); }
    });
  }
  window.FashePairing = Object.freeze({open, close, render, importFile, forget, assertReady,
    connectTransport, probe, publicInfo: security.publicInfo, closeTransport: security.closeTransport,
    autoConnect, cancelAuto, onPowerOn, applyAssignment, serverAssignment: () => assignment,
    redact: DatyReceiverSecurity.redact});
  window.addEventListener('DOMContentLoaded', () => {
    try {
      const saved = localStorage.getItem('fashe_auto_server_v1');
      if (saved) el('autoPairServer').value = DatyAutoPair.serverOrigin(saved);
    } catch (_) {}
    el('pairingFile').addEventListener('change', async event => {
      const file = event.target.files[0]; event.target.value = '';
      try { await importFile(file); }
      catch (error) { el('pairingFeedback').textContent = DatyReceiverSecurity.redact(error.message); }
    });
    render();
    // Page memory only. Stop transport before an expired credential can reconnect.
    timers.setInterval(() => {
      const pairing = security.publicInfo();
      if (pairing && autoSession && autoWanted && !autoPending && !retryTimer && pairing.expires_at * 1000 - Date.now() < 60000) {
        autoConnect({renew:true});
      }
      if (pairing && pairing.expires_at * 1000 <= Date.now()) {
        if (autoSession && autoWanted) {
          if (!expiryStopped) {
            expiryStopped = true; security.closeTransport(); stopUpdates();
            updateStatus(isPoweredOn ? 'connecting' : 'disconnected'); updateServerStatus('reconnecting');
            log('WARN', '连接凭据到期，已停止发送；保留通道状态，等待自动重新接入');
          }
          return;
        }
        forget(); el('pairingFeedback').textContent = '配对凭据已过期，已断开连接，请重新签发。';
        log('WARN', '配对凭据已过期，连接已停止');
      }
    }, 1000);
  });
  window.addEventListener('pagehide', () => {cancelAuto(); security.clear();});
})();
