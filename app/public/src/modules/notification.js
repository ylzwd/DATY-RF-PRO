// ============================================================
// notification.js — Toast 通知与实时 UI 重绘
// ============================================================

// ══════════════════ NOTIFICATION ══════════════════
let notifTimer=null;
function _notificationRuntime(runtime, method, ...args) {
  if (runtime.DatyHostFactory) return runtime.DatyHostFactory.invokeRuntime(runtime, method, ...args);
  if (runtime.DatyPlatform !== undefined && runtime.DatyPlatform?.kind !== 'browser') {
    throw new TypeError('DatyHost: native runtime capability is unavailable');
  }
  if (method === 'nowMonotonicMs') return runtime.performance.now();
  return runtime[method](...args);
}
function notify(icon, title, msg) {
  if (globalThis.DatyHostFactory?.usesMessagePort(globalThis)) {
    return globalThis.DatyHostFactory.invokeMessage(globalThis, 'notify', icon, title, msg);
  }
  if (globalThis.DatyPlatform !== undefined && globalThis.DatyPlatform?.kind !== 'browser') {
    throw new TypeError('DatyHost: native notification capability is unavailable');
  }
  const n = document.getElementById('notif');
  document.getElementById('notifIcon').textContent = icon;
  document.getElementById('notifTitle').textContent = title;
  document.getElementById('notifMsg').textContent = msg;
  n.classList.add('show');
  if(notifTimer) _notificationRuntime(globalThis, 'clearTimeout', notifTimer);
  notifTimer = _notificationRuntime(globalThis, 'setTimeout', ()=>n.classList.remove('show'),3000);
}

// ══════════════════ LIVE UPDATE（仅重绘，不伪造设备数据）══════════════════
function liveUpdate() {
  const active = document.querySelector('.panel.active');
  if(active && active.id==='panel-dashboard') {
    _notificationRuntime(globalThis, 'setTimeout', drawRFBarChart,50);
  }
  if(active && active.id==='panel-channels') {
    // 实时更新通道总览页面
    const brandFilter = document.getElementById('filterBrandChannels');
    const statusFilter = document.getElementById('filterStatusChannels');
    if(brandFilter && statusFilter) {
      let devs = DEVICES;
      if(brandFilter.value !== 'all') devs = devs.filter(d => d.brand === brandFilter.value);
      if(statusFilter.value !== 'all') devs = devs.filter(d => d.status === statusFilter.value);
      renderDeviceGridChannels(devs);
    }
  }
}

// daty-alert-sound-v1: pure alert-edge policy + replaceable audio output.
// Kept in the already published notification asset; no extra service/port required.
(function(root, build) {
  const factory = build();
  if (typeof module === 'object' && module.exports) { module.exports = factory; return; }
  root.DatyAlertSoundFactory = factory;
  if (root.document?.getElementById('soundAlertEnabled')) root.DatyAlertSound = factory.mount(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const STORAGE_KEY = 'daty_alert_sound_v1', COOLDOWN_MS = 2000;

  // Output contract: state(): ready|blocked|unsupported|error; unlock(): Promise<boolean>;
  // play({level}): boolean (scheduled, NOT proof of speaker audibility); stop(): void.
  function create({storage, output, now = () => performance.now(), schedule = setTimeout,
    cancel = clearTimeout, onChange = () => {}, initialReady = true}) {
    let enabled = true, storageError = false, audioError = false, disposed = false, silenced = false;
    let preferenceReady = initialReady;
    let active = new Map(), pending = new Map(), timer = null, lastPlayed = -Infinity, generation = 0;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw !== null) {
        const value = JSON.parse(raw);
        if (!value || typeof value.enabled !== 'boolean') throw new Error('Invalid sound preference');
        enabled = value.enabled;
      }
    } catch (_) { storageError = true; }
    function getState() {
      let audio = 'error';
      try { audio = audioError ? 'error' : output.state(); } catch (_) { /* UI stays available */ }
      return {enabled, storageError, audio, preferenceReady};
    }
    function changed() { try { onChange(getState()); } catch (_) { /* view failure cannot block alerts */ } }
    function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
    function stop() { try { output.stop(); } catch (_) { audioError = true; } }
    function silence() { generation += 1; silenced = true; pending.clear(); clearTimer(); stop(); }
    function play(level) {
      try {
        if (output.play({level}) !== true) { audioError = true; return false; }
        audioError = false; lastPlayed = now(); return true;
      } catch (_) { audioError = true; return false; }
    }
    function arm(delay) {
      if (timer === null) timer = schedule(() => { timer = null; flush(); }, delay);
    }
    function flush() {
      if (disposed || !enabled || !preferenceReady || silenced) { clearTimer(); return; }
      // Explicit metrics, not text/key parsing or severity: sustained AF must not
      // be included in the RF/battery repeat tone after its first notification.
      const repeats = [...active.values()].filter(issue => issue.metric === 'rf' || issue.metric === 'battery');
      if (!pending.size && !repeats.length) { clearTimer(); return; }
      if (getState().audio !== 'ready') { clearTimer(); changed(); return; }
      const remaining = COOLDOWN_MS - (now() - lastPlayed);
      if (remaining > 0) {
        arm(remaining);
        return;
      }
      clearTimer();
      const level = [...pending.values(), ...repeats.map(issue => issue.level)].includes('crit') ? 'crit' : 'warn';
      if (play(level)) {
        pending.clear();
        // One timer per page; schedule from actual playback, never catch up with
        // multiple stale sounds after a throttled/background timer wakes up.
        if (repeats.length) arm(COOLDOWN_MS);
      }
      changed();
    }
    function observe(issues) {
      if (disposed || !Array.isArray(issues)) return;
      const next = new Map();
      issues.forEach(issue => {
        if (issue && typeof issue.key === 'string' && issue.key && ['warn', 'crit'].includes(issue.level)) {
          next.set(issue.key, {level:issue.level, metric:issue.metric});
        }
      });
      // Use authoritative threshold keys, not the UI array/archived occurrence ID.
      // Clearing the visible list and rereading history must not retrigger sounds.
      for (const key of pending.keys()) {
        if (!next.has(key)) pending.delete(key);
        else pending.set(key, next.get(key).level);
      }
      next.forEach(({level}, key) => {
        if (enabled && (!active.has(key) || (level === 'crit' && active.get(key).level !== 'crit'))) pending.set(key, level);
      });
      active = next; silenced = false;
      flush();
    }
    function setEnabled(value) {
      if (typeof value !== 'boolean' || disposed) return getState();
      const previous = enabled && preferenceReady; enabled = value; preferenceReady = true;
      try {
        const raw = JSON.stringify({enabled});
        if (storage.getItem(STORAGE_KEY) !== raw) storage.setItem(STORAGE_KEY, raw);
        storageError = false;
      }
      catch (_) { storageError = true; }
      if (!enabled) silence();
      else if (!previous) {
        silenced = false;
        pending = new Map([...active].map(([key, issue]) => [key, issue.level]));
        flush();
      }
      changed(); return getState();
    }
    async function unlock(playPending = true) {
      if (!enabled || !preferenceReady || disposed) return false;
      const ticket = generation;
      // Call unlock synchronously inside the trusted user event before awaiting.
      try { if (await output.unlock() !== true) { changed(); return false; } audioError = false; }
      catch (_) { audioError = true; changed(); return false; }
      if (!enabled || disposed || ticket !== generation) return false;
      if (playPending) flush();
      changed(); return getState().audio === 'ready';
    }
    async function preview() {
      if (!await unlock(false) || !enabled || disposed) return false;
      // Explicit preview is not an alert and never writes ALERTS or the archive.
      stop(); const result = play('warn'); flush(); changed(); return result;
    }
    function dispose() { disposed = true; silence(); active.clear(); }
    return Object.freeze({observe, setEnabled, getState, unlock, preview, silence, dispose});
  }

  function createBrowserOutput(browser) {
    let context = null;
    const voices = new Set(), listeners = new Set();
    const AudioContext = browser.AudioContext || browser.webkitAudioContext;
    function state() {
      if (!AudioContext) return 'unsupported';
      return context?.state === 'running' ? 'ready' : 'blocked';
    }
    async function unlock() {
      if (!AudioContext) return false;
      if (!context || context.state === 'closed') {
        context = new AudioContext();
        context.onstatechange = () => {
          // Do not resume a stale half-played pulse after OS/browser suspension.
          if (context.state !== 'running') stop();
          listeners.forEach(listener => { try { listener(); } catch (_) { /* isolated view */ } });
        };
      }
      if (context.state !== 'running') await context.resume();
      return context.state === 'running';
    }
    function stop() {
      for (const voice of voices) {
        try { voice.oscillator.stop(); } catch (_) { /* may already be ended */ }
        voice.oscillator.disconnect(); voice.gain.disconnect();
      }
      voices.clear();
    }
    function play({level}) {
      if (state() !== 'ready') return false;
      stop();
      const oscillator = context.createOscillator(), gain = context.createGain();
      const voice = {oscillator, gain}, t = context.currentTime;
      voices.add(voice);
      try {
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(level === 'crit' ? 880 : 660, t);
        oscillator.frequency.setValueAtTime(level === 'crit' ? 1175 : 880, t + 0.22);
        // Two short, low-gain pulses with smooth attack/release, no downloaded sound.
        gain.gain.setValueAtTime(0, t);
        for (const offset of [0, 0.22]) {
          gain.gain.setValueAtTime(0, t + offset);
          gain.gain.linearRampToValueAtTime(0.08, t + offset + 0.015);
          gain.gain.setValueAtTime(0.08, t + offset + 0.10);
          gain.gain.linearRampToValueAtTime(0, t + offset + 0.17);
        }
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); voices.delete(voice); };
        oscillator.start(t); oscillator.stop(t + 0.42);
        return true;
      } catch (error) { stop(); throw error; }
    }
    function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    return Object.freeze({state, unlock, play, stop, subscribe});
  }

  function mount(browser) {
    // A repeated mount must never leave an audible, unreachable controller.
    browser.DatyAlertSound?.dispose();
    const doc = browser.document, checkbox = doc.getElementById('soundAlertEnabled');
    const label = doc.getElementById('soundAlertStatus'), testButton = doc.getElementById('soundAlertTest');
    const platform = browser.DatyPlatform;
    const storage = {getItem:()=>null,setItem:()=>{}}; // Display state only; database owns persistence.
    // Native hosts inject a dedicated sound port. Missing native audio never falls
    // through to browser facilities; other platform v1.0.0 ports stay unchanged.
    const output = browser.DatyAlertSoundOutput !== undefined ? browser.DatyAlertSoundOutput
      : platform === undefined || platform.kind === 'browser' ? createBrowserOutput(browser)
      : {state:() => 'unsupported', unlock:async () => false, play:() => false, stop() {}};
    function sync(state) {
      checkbox.checked = state.enabled;
      if (testButton) testButton.disabled = !state.enabled || !state.preferenceReady || state.audio === 'unsupported';
      const text = !state.enabled ? '声音告警已关闭' : !state.preferenceReady ? '正在读取服务器声音设置…' : state.audio === 'ready' ? '触发告警时播放提示音（已就绪）'
        : state.audio === 'unsupported' ? '当前运行环境不支持提示音'
        : state.audio === 'error' ? '声音不可用，请点击试听重试' : '提示音待启用：请点击页面或试听';
      if (label) {
        const localMessage = state.storageError ? '声音设置未保存，仅本页生效' : text;
        const message = browser.DatyBusinessDatabase?.preferenceMessage('alert_sound', localMessage) ?? localMessage;
        if (label.textContent !== message) label.textContent = message;
        label.title = text + '。AF 过载每次触发只响一次；RF 弱信号、电池低电量持续时每 2 秒重复提示，恢复后停止。开关立即生效并保存；首次播放需用户操作。若听不到，请检查浏览器站点静音、系统音量和输出设备。';
      }
    }
    const controller = create({storage, output, now:() => _notificationRuntime(browser, 'nowMonotonicMs'),
      schedule:(fn, ms) => _notificationRuntime(browser, 'setTimeout', fn, ms),
      cancel:id => _notificationRuntime(browser, 'clearTimeout', id), onChange:sync,
      initialReady:false}); // Do not play before the server database has supplied the preference.
    const unsubscribe = typeof output?.subscribe === 'function' ? output.subscribe(() => sync(controller.getState())) : null;
    const change = () => {
      if (browser.DatyBusinessDatabase) { void browser.DatyBusinessDatabase.setBooleanPreference('alert_sound', checkbox.checked, value => controller.setEnabled(value), () => controller.unlock()); return; }
      browser.notify?.('⚠️','声音设置未保存','服务器数据库尚未就绪');
    };
    const preview = () => { void controller.preview(); };
    const gesture = event => {
      if (!event.isTrusted || !controller.getState().enabled || controller.getState().audio === 'ready') return;
      // Let the switch/test handlers own their gesture; switching OFF must never beep.
      if (event.target?.closest?.('#soundAlertControls')) return;
      void controller.unlock();
    };
    const pagehide = () => controller.silence();
    const storageChanged = event => {
      if (event.key !== STORAGE_KEY || event.newValue === null || !controller.getState().preferenceReady) return;
      try {
        const value = JSON.parse(event.newValue);
        if (typeof value?.enabled === 'boolean' && value.enabled !== controller.getState().enabled) controller.setEnabled(value.enabled);
      } catch (_) { /* malformed/unrelated cache writes cannot enable audio */ }
    };
    checkbox.addEventListener('change', change);
    testButton?.addEventListener('click', preview);
    doc.addEventListener('pointerdown', gesture, true); doc.addEventListener('keydown', gesture, true);
    browser.addEventListener('pagehide', pagehide);
    // Browser storage events do not control database settings.
    sync(controller.getState());
    return Object.freeze({...controller, dispose() {
      checkbox.removeEventListener('change', change); testButton?.removeEventListener('click', preview);
      doc.removeEventListener('pointerdown', gesture, true); doc.removeEventListener('keydown', gesture, true);
      browser.removeEventListener('pagehide', pagehide); controller.dispose();
      browser.removeEventListener('storage', storageChanged);
      if (typeof unsubscribe === 'function') unsubscribe();
    }});
  }
  return Object.freeze({VERSION:'1.0.0', STORAGE_KEY, COOLDOWN_MS, create, createBrowserOutput, mount});
});

