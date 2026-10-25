/* daty-pairing-v1: transport-independent receiver credential boundary.
 * Browser certificates are validated by the OS/browser, not by fingerprint text.
 * No persistence, URL secrets, plaintext fallback, or hidden enrollment.
 */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DatyReceiverSecurity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const PROTOCOL = 'daty-pairing-v1';
  const BRANDS = ['DATYaudio', 'AMSaudio', 'Shure', 'Sennheiser'];
  function fail(message) { throw new Error(message); }
  function normalizeMac(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(value)) fail('接收机 MAC 格式无效');
    if (value === '00:00:00:00:00:00' || (parseInt(value.slice(0, 2), 16) & 1)) fail('接收机 MAC 必须为非零单播地址');
    return value.toUpperCase();
  }
  function brokerUrl(value) {
    if (typeof value !== 'string' || /[\s\\]/.test(value)) fail('配对服务器地址不能包含空白或反斜杠');
    let url;
    try { url = new URL(value); } catch (_) { fail('配对服务器地址无效'); }
    if (url.protocol !== 'wss:' || url.port !== '8083' || url.username || url.password || url.search || url.hash || url.pathname !== '/mqtt') fail('配对仅允许无凭据参数的 WSS 8083 /mqtt 地址');
    if (!/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname || url.hostname.endsWith('.')) fail('服务器必须使用证书中的固定 IP 或域名');
    return url.href;
  }
  function identity(value) {
    if (!value || !BRANDS.includes(value.brand)) fail('接收机品牌无效');
    if (!Number.isInteger(value.max_channels) || value.max_channels < 1 || value.max_channels > 128) fail('通道数量必须为 1～128');
    return {receiver_mac: normalizeMac(value.receiver_mac), brand: value.brand, max_channels: value.max_channels};
  }
  function validateBundle(value, expected, nowMs) {
    if (!value || value.protocol !== PROTOCOL || Array.isArray(value)) fail('不支持的接收机配对文件');
    const bound = identity(value), current = identity(expected);
    if (bound.receiver_mac !== current.receiver_mac) fail('配对 MAC 与本机模拟接收机不一致，请按本机 MAC 重新签发');
    if (bound.brand !== current.brand) fail('配对品牌与当前品牌不一致');
    if (bound.max_channels < current.max_channels) fail('当前通道数量超出配对授权上限');
    const id = value.credential_id;
    if (typeof id !== 'string' || !/^rx_[0-9a-f]{16}$/.test(id)) fail('配对凭据编号无效');
    if (typeof value.secret !== 'string' || !new RegExp('^daty_rx_' + id.slice(3) + '_[A-Za-z0-9_-]{43}$').test(value.secret)) fail('配对密钥格式无效');
    const receiverId = 'FAshe-MAC-' + bound.receiver_mac.replace(/:/g, '');
    if (typeof value.receiver_id !== 'string' || value.receiver_id.toLowerCase() !== receiverId.toLowerCase()) fail('配对接收机身份与 MAC 不一致');
    if (typeof value.ca_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.ca_sha256)) fail('配对 CA 指纹无效');
    if (!Number.isFinite(value.expires_at) || value.expires_at <= 0 || value.expires_at >= 1e12 || value.expires_at * 1000 <= nowMs) fail('配对凭据已过期或期限无效，请重新签发');
    return Object.freeze({...bound, protocol: PROTOCOL, credential_id: id, secret: value.secret,
      receiver_id: receiverId, broker_url: brokerUrl(value.broker_url),
      ca_sha256: value.ca_sha256.toUpperCase(), expires_at: value.expires_at});
  }
  function publicInfo(bundle) {
    if (!bundle) return null;
    const {secret, ...visible} = bundle;
    return Object.freeze(visible);
  }
  function redact(value) {
    return String(value).replace(/daty_rx_[A-Za-z0-9_-]+/g, '[接收机密钥已隐藏]');
  }
  function createSession(options = {}) {
    const now = options.now || Date.now;
    let bundle = null, client = null;
    function closeTransport() {
      const previous = client;
      client = null;
      if (previous) {
        if (typeof previous.removeAllListeners === 'function') previous.removeAllListeners();
        if (typeof previous.on === 'function') previous.on('error', () => {});
        try { if (typeof previous.end === 'function') previous.end(true); } catch (_) {}
        // MQTT.js owns an in-memory copy; remove references once disconnected.
        if (previous.options) { previous.options.password = undefined; previous.options.username = undefined; }
      }
    }
    function check(expected, requestedUrl) {
      if (!bundle) fail('尚未配对：请自动接入服务器，或导入管理员签发的备用配对文件');
      if (requestedUrl !== undefined && brokerUrl(requestedUrl) !== bundle.broker_url) fail('已阻止连接未配对的服务器');
      try { validateBundle(bundle, expected, now()); }
      catch (error) { closeTransport(); throw error; }
      return bundle;
    }
    return Object.freeze({
      importBundle(value, expected) {
        const parsed = typeof value === 'string' ? (() => {
          if (value.length > 16384) fail('配对文件过大');
          try { return JSON.parse(value); } catch (_) { fail('配对文件不是有效 JSON'); }
        })() : value;
        const next = validateBundle(parsed, expected, now());
        closeTransport(); bundle = next;
        return publicInfo(bundle);
      },
      publicInfo: () => publicInfo(bundle),
      assertReady(expected, requestedUrl) { return publicInfo(check(expected, requestedUrl)); },
      connect(transport, expected, requestedUrl) {
        const ready = check(expected, requestedUrl);
        if (!transport || typeof transport.connect !== 'function') fail('本地 MQTT 组件未加载');
        closeTransport();
        const random = options.randomBytes || (length => {
          if (typeof globalThis.crypto?.getRandomValues !== 'function') fail('浏览器缺少安全随机数支持');
          return globalThis.crypto.getRandomValues(new Uint8Array(length));
        });
        const suffix = Array.from(random(12), value => value.toString(16).padStart(2, '0')).join('');
        client = transport.connect(ready.broker_url, {
          username: ready.credential_id, password: ready.secret,
          clientId: ready.credential_id + '_' + suffix,
          clean: true, connectTimeout: 8000, reconnectPeriod: 0, keepalive: 30,
          protocolId: 'MQTT', protocolVersion: 4, queueQoSZero: false,
          resubscribe: false,
          // MQTT.js verbose debug must never serialize CONNECT credentials to the console.
          log: () => {}
        });
        return client;
      },
      closeTransport,
      clear() { closeTransport(); bundle = null; }
    });
  }
  return Object.freeze({PROTOCOL, normalizeMac, brokerUrl, identity, validateBundle, redact, createSession});
});
