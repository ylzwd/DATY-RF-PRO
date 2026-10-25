/* daty-auto-pair-v1: key proof and enrollment only; no device-control authority.
 * Browser private key is non-extractable and stored as a CryptoKey in IndexedDB.
 * MQTT passwords stay in the existing memory-only receiver-security session.
 */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DatyAutoPair = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const PROTOCOL = 'daty-auto-pair-v1';
  function serverOrigin(value) {
    if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new Error('服务器地址不能含空白或反斜杠');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port !== '8802' || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
      throw new Error('请输入 https://服务器IP:8802，不支持明文地址');
    return url.origin;
  }
  function base64url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  async function browserKey(browser, name) {
    if (!browser.crypto?.subtle || !browser.indexedDB) throw new Error('自动接入需要 WebCrypto 和 IndexedDB；请使用启动FAshe.bat 打开同一个浏览器');
    const database = await new Promise((resolve,reject) => {
      const request = browser.indexedDB.open('daty-fashe-identity-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('浏览器身份库不可用；不会退回明文保存私钥'));
      request.onblocked = () => reject(new Error('身份库被其他页面占用，请关闭重复页面'));
    });
    try {
      const read = () => new Promise((resolve,reject) => {
        const request = database.transaction('keys').objectStore('keys').get(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('无法读取接收机身份'));
      });
      let keys = await read();
      if (!keys) {
        const generated = await browser.crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, false, ['sign','verify']);
        await new Promise((resolve,reject) => {
          const tx = database.transaction('keys', 'readwrite');
          tx.objectStore('keys').add(generated, name);
          tx.oncomplete = resolve;
          tx.onabort = () => tx.error?.name === 'ConstraintError' ? resolve() : reject(new Error('无法保存接收机身份，未发送登记'));
        });
        keys = await read();
      }
      if (!keys?.privateKey || keys.privateKey.extractable || keys.privateKey.type !== 'private') throw new Error('身份库格式无效，请联系管理员恢复；未生成替代身份');
      return keys;
    } finally { database.close(); }
  }
  function create(options) {
    const browser = options.browser || globalThis;
    const timers = options.timers || browser.FasheNetworkTimers || globalThis;
    let pending = null;
    async function enroll(originValue, identity, signal) {
      const origin = serverOrigin(originValue);
      const broker = origin.replace('https:', 'wss:').replace(':8802', ':8083') + '/mqtt';
      const key = await (options.keyStore || (name => browserKey(browser,name)))(origin + '|' + identity.receiver_mac);
      if (signal?.aborted) throw new Error('自动接入已取消');
      const publicKey = await browser.crypto.subtle.exportKey('jwk', key.publicKey);
      async function post(path, body) {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal?.addEventListener('abort', cancel, {once:true});
        const timer = timers.setTimeout(cancel, 6000);
        try {
          if (signal?.aborted) cancel();
          const response = await (options.request || browser.fetch.bind(browser))(origin + path,
            {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
              credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', cache:'no-store', signal:controller.signal});
          const text = await response.text();
          if (text.length > 16384) throw new Error('服务器接入回复过大');
          const data = JSON.parse(text);
          if (!response.ok || data.success !== true) throw new Error(data.error || '服务器拒绝自动接入');
          return data;
        } finally { timers.clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
      }
      const challenge = await post('/api/receivers/challenge', {protocol:PROTOCOL,
        receiver_mac:identity.receiver_mac, brand:identity.brand, channel_count:identity.max_channels, public_key:publicKey});
      const fields = String(challenge.message || '').split('\n');
      if (challenge.protocol !== PROTOCOL || fields.length !== 8 || fields[0] !== PROTOCOL || fields[1] !== broker || fields[2] !== challenge.challenge_id || fields[4] !== identity.receiver_mac || fields[5] !== identity.brand || fields[6] !== String(identity.max_channels))
        throw new Error('服务器身份挑战与本次请求不一致');
      const signature = await browser.crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, key.privateKey, new TextEncoder().encode(challenge.message));
      if (signal?.aborted) throw new Error('自动接入已取消');
      const result = await post('/api/receivers/enroll', {challenge_id:challenge.challenge_id, signature:base64url(signature)});
      if (result.protocol !== PROTOCOL || result.pairing?.broker_url !== broker || result.pairing?.receiver_mac !== identity.receiver_mac || result.receiver_ip !== fields[7] || !Number.isInteger(result.group_number) || result.group_number < 1 || result.ip_source !== 'socket-peer' || result.group_source !== 'server-fifo-v1') throw new Error('服务器登记回复不完整');
      return result;
    }
    return Object.freeze({enroll(origin, identity, signal) {
      // One in-flight enrollment per page prevents accidental secret rotation.
      if (!pending) pending = enroll(origin, identity, signal).finally(() => {pending = null;});
      return pending;
    }});
  }
  return Object.freeze({PROTOCOL, serverOrigin, create, browserKey});
});
