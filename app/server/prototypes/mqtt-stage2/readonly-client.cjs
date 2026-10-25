/* Injectable MQTT5 transport. No DOM, storage, RPC, publish or control API. */
'use strict';
const TOPIC = 'daty/v2/stage2-server/devices/read';
const SCHEMA = 'daty-device-read-v1';

class ReadonlyDeviceStream {
  constructor({connect, url, handlers, now = () => performance.now(),
    timers = globalThis, idleMs = 5000, retryMs = 1000}) {
    const u = new URL(url);
    if (u.protocol !== 'wss:' || u.username || u.password || u.search || u.hash || u.pathname !== '/mqtt-readonly') {
      throw Error('Exact WSS read-only endpoint required');
    }
    if (!(idleMs >= 2000) || !(retryMs >= 100)) throw Error('Invalid timer bounds');
    this.connect = connect; this.url = url; this.handlers = handlers;
    this.now = now; this.timers = timers; this.idleMs = idleMs; this.retryMs = retryMs;
    this.generation = 0; this.stopped = true; this.client = null;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }
  open() {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.seq = 0; this.stream = null; this.boot = null; this.last = this.now();
    const current = () => !this.stopped && generation === this.generation;
    try {
      const client = this.connect(this.url, {protocolVersion: 5, clean: true, clientId: '',
        keepalive: 10, reconnectPeriod: 0, connectTimeout: 5000, resubscribe: false,
        queueQoSZero: false, properties: {sessionExpiryInterval: 0, maximumPacketSize: 1048576}});
      this.client = client;
      client.on('connect', ack => {
        if (!current()) return;
        const id = ack?.properties?.assignedClientIdentifier;
        if (ack.sessionPresent || typeof id !== 'string' || !/^view-[a-f0-9]{32}$/.test(id)) return this.fail('invalid-session');
        this.stream = id;
        client.subscribe(TOPIC, {qos: 1}, (error, granted) => {
          if (!current()) return;
          if (error || !granted || granted.length !== 1 || granted[0].topic !== TOPIC || ![0,1].includes(granted[0].qos)) this.fail('subscription-failed');
        });
      });
      client.on('message', (topic, bytes, packet) => {
        if (!current()) return;
        try {
          if (topic !== TOPIC || packet?.retain || bytes.length > 900 * 1024) throw Error('invalid-publication');
          const event = JSON.parse(bytes.toString());
          if (event.schema !== SCHEMA || event.server_id !== 'stage2-server' || !this.stream || event.stream_id !== this.stream ||
              typeof event.boot_id !== 'string' || !/^[a-f0-9]{32}$/.test(event.boot_id) ||
              !Number.isSafeInteger(event.seq) || event.seq < 1) throw Error('invalid-envelope');
          if (this.boot && event.boot_id !== this.boot) throw Error('changed-boot');
          if (event.seq <= this.seq) return; // QoS duplicate cannot refresh liveness.
          if (event.seq !== this.seq + 1 || (!this.seq && event.kind !== 'device_list')) throw Error('snapshot-required');
          if (!['device_list', 'device_update', 'heartbeat'].includes(event.kind)) throw Error('invalid-kind');
          if (event.kind !== 'heartbeat' && (!event.payload || !Array.isArray(event.payload.devices))) throw Error('invalid-payload');
          if (event.kind === 'heartbeat' && event.payload !== null) throw Error('invalid-heartbeat');
          if (event.kind === 'device_list') this.handlers.snapshot(event.payload.devices, event.payload);
          if (event.kind === 'device_update') this.handlers.delta(event.payload.devices, event.payload);
          if (!current()) return; // A host callback may stop/switch the connection.
          this.boot = event.boot_id; this.seq = event.seq; this.last = this.now();
          if (event.seq === 1) this.handlers.online?.();
        } catch (error) { this.fail(error.message); }
      });
      for (const name of ['close', 'offline', 'error']) client.on(name, () => { if (current()) this.fail(name); });
      this.watchdog = this.timers.setInterval(() => {
        if (current() && this.now() - this.last >= this.idleMs) this.fail('source-idle');
      }, Math.min(1000, this.idleMs / 2));
    } catch (error) { if (current()) this.fail(error.message); }
  }
  fail(reason) {
    ++this.generation; // Invalidate all old callbacks before force-closing transport.
    this.timers.clearInterval(this.watchdog);
    const client = this.client; this.client = null;
    try { client?.end(true); } finally {
      try { this.handlers.offline(reason); } finally {
        if (!this.stopped) this.retry = this.timers.setTimeout(() => this.open(), this.retryMs);
      }
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.timers.clearTimeout(this.retry);
    this.fail('stopped');
  }
}
module.exports = {ReadonlyDeviceStream, TOPIC, SCHEMA};
