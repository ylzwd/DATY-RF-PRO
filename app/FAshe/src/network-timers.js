/* Communication timers only. UI animation timers retain browser scheduling.
 * No network, credentials or receiver state crosses the worker boundary.
 */
(function(root, factory) {
  const create = factory();
  if (typeof module === 'object' && module.exports) module.exports = create;
  else root.FasheNetworkTimers = create({global: root,
    workerUrl: new URL('receiver-timer-worker.js?v=1.0.3-stability2', document.currentScript.src).href});
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  return function create(options) {
    const host = options.global;
    const nativeSet = host.setTimeout.bind(host), nativeClear = host.clearTimeout.bind(host);
    const now = () => host.performance.now();
    const jobs = new Map();
    let sequence = 0, worker = null, channel = null, disposed = false, degraded = false;
    function warning() {
      if (degraded) return;
      degraded = true;
      options.onDegraded?.();
      if (host.dispatchEvent && host.CustomEvent) host.dispatchEvent(new host.CustomEvent('fashe-network-timer-warning'));
    }
    function fallback() {
      if (!worker) return;
      worker.onmessage = null; worker.terminate(); worker = null; warning();
      for (const [id, job] of jobs) if (job.kind === 'worker') {
        job.kind = 'native';
        job.handle = nativeSet(() => fire(id), Math.max(0, job.due - now()));
      }
    }
    function arm(id, job) {
      job.due = now() + job.delay;
      if (!job.delay && !job.repeat && channel) {
        job.kind = 'message'; channel.port2.postMessage(id);
      } else if (worker) {
        job.kind = 'worker';
        try { worker.postMessage({action: 'set', id, delay: job.delay}); }
        catch (_) { fallback(); }
      } else {
        job.kind = 'native'; job.handle = nativeSet(() => fire(id), job.delay);
      }
    }
    function fire(id) {
      const job = jobs.get(id);
      if (!job || disposed) return;
      if (!job.repeat) jobs.delete(id);
      // Rearm after execution: a resumed/frozen page must not replay a backlog.
      try { job.callback(...job.args); }
      finally { if (job.repeat && jobs.get(id) === job) arm(id, job); }
    }
    try {
      channel = new host.MessageChannel();
      channel.port1.onmessage = event => fire(event.data);
    } catch (_) { channel = null; }
    try {
      worker = new host.Worker(options.workerUrl, {name: 'FAshe communication timers'});
      worker.onmessage = event => fire(event.data?.id);
      worker.onerror = event => { event.preventDefault?.(); fallback(); };
      worker.onmessageerror = fallback;
    } catch (_) { worker = null; warning(); }
    function schedule(callback, delay, repeat, args) {
      if (disposed) throw new Error('Communication scheduler disposed');
      if (typeof callback !== 'function') throw new TypeError('Timer callback must be a function');
      const value = Number(delay);
      const duration = Number.isFinite(value) ? Math.min(2147483647, Math.max(repeat ? 1 : 0, value)) : 0;
      const id = ++sequence, job = {callback, args, delay: duration, repeat};
      jobs.set(id, job); arm(id, job); return id;
    }
    function clear(id) {
      const job = jobs.get(id);
      if (!job) return;
      jobs.delete(id);
      if (job.kind === 'native') nativeClear(job.handle);
      else if (job.kind === 'worker') {
        try { worker?.postMessage({action: 'clear', id}); } catch (_) { fallback(); }
      }
    }
    return Object.freeze({
      setTimeout: (callback, delay = 0, ...args) => schedule(callback, delay, false, args),
      clearTimeout: clear,
      setInterval: (callback, delay = 0, ...args) => schedule(callback, delay, true, args),
      clearInterval: clear,
      get mode() { return worker ? 'worker-message' : 'page-fallback'; },
      get pending() { return jobs.size; },
      dispose() {
        for (const id of jobs.keys()) clear(id);
        disposed = true; worker?.terminate(); worker = null;
        channel?.port1.close(); channel?.port2.close(); channel = null;
      }
    });
  };
});
