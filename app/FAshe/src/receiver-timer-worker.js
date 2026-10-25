'use strict';
// Only timer IDs/delays enter this worker; never MQTT packets or secrets.
const pending = new Map();
self.onmessage = event => {
  const {action, id, delay} = event.data || {};
  if (!Number.isSafeInteger(id) || id < 1) return;
  if (pending.has(id)) { clearTimeout(pending.get(id)); pending.delete(id); }
  if (action !== 'set' || !Number.isFinite(delay) || delay < 0 || delay > 2147483647) return;
  pending.set(id, setTimeout(() => {
    pending.delete(id); self.postMessage({id});
  }, delay));
};
