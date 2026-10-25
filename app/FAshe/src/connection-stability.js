/* Receiver lifecycle helpers. No credentials, server commands or fabricated ACKs. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FasheStability = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  function createPulse(now) {
    let lastData = -Infinity, lastClock = null, started = null;
    return Object.freeze({
      connected() { started = now(); lastClock = null; lastData = -Infinity; },
      sent() { lastData = now(); },
      clock() { lastClock = now(); },
      needsData() { return now() - lastData >= 2000; },
      stale() { return started !== null && now() - (lastClock ?? started) > 45000; },
      stopped() { started = lastClock = null; lastData = -Infinity; }
    });
  }

  // This is the simulated receiver's own applied state, like hardware nonvolatile
  // channel settings. Never restore identity, GROUP, online flags or command IDs.
  function createStateStore(storage, onError = () => {}) {
    const key = mac => 'fashe_applied_channels_v1_' + String(mac).toUpperCase();
    let lastKey, lastValue, warned = false;
    const report = () => { if (!warned) { warned = true; onError(); } };
    const validNumber = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
    function clean(device) {
      const channel = Number(device.channel_number ?? device.channel);
      if (!Number.isInteger(channel) || channel < 1 || channel > 128 || typeof device.brand !== 'string'
          || typeof device.model !== 'string' || !validNumber(device.frequency, 400, 900)
          || typeof device.muted !== 'boolean') return null;
      const item = {channel, brand: device.brand, model: device.model,
        frequency: Math.round(device.frequency * 1000) / 1000, muted: device.muted};
      for (const [field, min, max] of [['rfLevel', -150, 0], ['afLevel', -40, 0], ['battery', 0, 100]]) {
        if (validNumber(device[field], min, max)) item[field] = device[field];
      }
      item.manualOverride = {};
      for (const field of ['rfLevel', 'afLevel', 'battery']) {
        if (device.manualOverride?.[field] === true) item.manualOverride[field] = true;
      }
      return item;
    }
    return Object.freeze({
      save(mac, devices) {
        if (!devices.length || devices.length > 128) return false;
        const channels = devices.map(clean);
        if (channels.some(item => !item) || new Set(channels.map(item => item.channel)).size !== channels.length) return false;
        const name = key(mac), value = JSON.stringify({version: 1, channels});
        if (lastKey === name && lastValue === value) return true;
        try { storage.setItem(name, value); lastKey = name; lastValue = value; return true; }
        catch (_) { report(); return false; }
      },
      restore(mac, devices) {
        try {
          const raw = storage.getItem(key(mac));
          if (!raw) return 0;
          if (raw.length > 65536) throw Error('Oversized state');
          const data = JSON.parse(raw);
          if (data.version !== 1 || !Array.isArray(data.channels) || data.channels.length > 128) throw Error('Invalid state');
          const items = data.channels.map(clean);
          if (items.some(item => !item) || new Set(items.map(item => item.channel)).size !== items.length) throw Error('Invalid channels');
          let restored = 0;
          for (const device of devices) {
            const item = items.find(row => row.channel === Number(device.channel_number ?? device.channel)
              && row.brand === device.brand && row.model === device.model);
            if (!item) continue;
            for (const field of ['frequency', 'muted', 'rfLevel', 'afLevel', 'battery', 'manualOverride']) {
              if (item[field] !== undefined) device[field] = item[field];
            }
            restored++;
          }
          return restored;
        } catch (_) { report(); return 0; }
      }
    });
  }

  // A Web Lock does not expire when background timers are throttled. The existing
  // localStorage lease remains the fallback on origins without Web Locks.
  function createOwner(locks) {
    let held = false, pending = null, releaseHold = null, generation = 0;
    return Object.freeze({
      acquire(mac) {
        if (held) return Promise.resolve(true);
        if (pending) return pending;
        if (!locks?.request) { held = true; return Promise.resolve(true); }
        const ticket = generation;
        let settle;
        const result = new Promise(resolve => { settle = resolve; });
        pending = result;
        Promise.resolve().then(() => locks.request('fashe_receiver_' + mac, {ifAvailable: true}, lock => {
          if (!lock || ticket !== generation) { settle(false); return; }
          held = true;
          const lifetime = new Promise(resolve => { releaseHold = resolve; });
          settle(true);
          return lifetime;
        })).catch(() => settle(false)).finally(() => {
          if (ticket === generation) { held = false; releaseHold = null; }
        });
        result.then(() => { if (pending === result) pending = null; });
        return result;
      },
      release() {
        generation++; held = false; pending = null;
        if (releaseHold) releaseHold();
        releaseHold = null;
      }
    });
  }
  return Object.freeze({version: 'fashe-stability-v2', createPulse, createStateStore, createOwner});
});
