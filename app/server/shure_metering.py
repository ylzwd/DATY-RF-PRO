"""ULXD continuous telemetry. Only METER_RATE is written; no device controls.

Shure ULXD command strings document 8338: SAMPLE x ALL antenna RF AF.
Other product families keep their existing model-specific GET polling.
"""
from __future__ import annotations

import copy
import socket
import threading
import time
import uuid

from shure_protocol import MODELS, MAX_REPLY, ShureReply, extract_framed_messages, parse_shure_frame

from shure_fields import ad4_sample, METER_FIELDS
from shure_freshness import MetadataFreshness

METER_MS = 100
STALE_SECONDS = 1.0


class BatteryRefresh:
    """Per-channel, nonblocking battery reads independent of the slow GET ALL.

    RF onset starts a short burst; unknown/non-rechargeable percentages do not
    keep that burst alive when bars are available. Flapping is limited to four
    pairs/second per channel, and a continuously unknown battery settles to 1Hz.
    """
    def __init__(self, count):
        self.channels = {ch: {'due': 0, 'last': float('-inf'), 'attempt': 0,
            'active': False, 'values': {}} for ch in range(1, count + 1)}

    def sample(self, channel, antenna, now):
        state = self.channels[channel]
        active = antenna in ('AX', 'XB', 'AB')
        if active and not state['active']:
            state.update(attempt=0, values={}, due=max(now, state['last'] + .25))
        state['active'] = active

    def observe(self, channel, fields, values):
        state = self.channels[channel]
        for field, key in (('BATT_BARS', 'battery_bars'), ('BATT_CHARGE', 'battery_percent'), ('TX_BATT_BARS','battery_bars'), ('TX_BATT_CHARGE_PERCENT','battery_percent')):
            if field in fields and key in values:
                state['values'][key] = values[key]
        if any(value is not None for value in state['values'].values()):
            state['due'] = state['last'] + 1

    def due(self, now):
        channels = []
        for channel, state in self.channels.items():
            if now < state['due']:
                continue
            channels.append(channel)
            state['attempt'] += 1
            known = any(value is not None for value in state['values'].values())
            delay = 1 if known or state['attempt'] >= 3 else (.25 if state['attempt'] == 1 else .5)
            state.update(last=now, due=now + delay)
        return channels


def decode_sample(model, frame):
    family, count = MODELS.get(model, ('', 0))
    kind, channel, fields = parse_shure_frame(frame)
    if family not in ('ULXD','AD4') or kind != 'SAMPLE' or not channel or channel > count or set(fields) != {'ALL'}:
        return None
    parts = fields['ALL'].split()
    if family == 'AD4':
        values = ad4_sample(parts)
        if model == 'AD4D' and values and values['meter_layout'].startswith('quadversity'):return None
        return (channel,values) if values else None
    if len(parts) != 3 or parts[0] not in ('AX', 'XB', 'AB', 'XX'):
        return None
    if any(len(v) != 3 or not v.isascii() or not v.isdigit() for v in parts[1:]):
        return None
    rf, af = map(int, parts[1:])
    if rf > 255 or af > 255 or (model == 'ULXD4' and parts[0] == 'AB'):
        return None
    return channel, {'rf_antenna': parts[0], 'rf_dbm': rf - 128, 'audio_dbfs': af - 50,
                     'audio_raw': af, 'rf_raw': rf}


class ShureMeterSession:
    """One bounded socket/thread per confirmed receiver; reconnect never rescans.

    Metadata GET replies cannot overwrite SAMPLE meters. Missing samples clear
    AF within one second even when metadata continues. Each new session verifies
    MODEL and queries the previous rate before requesting periodic telemetry.
    """
    def __init__(self, receiver, on_update, *, port=2202, metadata_interval=5,
                 stale_after=STALE_SECONDS, retry_delay=1, identity_check=None):
        self.receiver = copy.deepcopy(receiver)
        self.on_update, self.port = on_update, port
        self.metadata_interval, self.stale_after, self.retry_delay = metadata_interval, stale_after, retry_delay
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name='Shure-meter-' + receiver['ip'], daemon=True)
        self.last_error = None
        self.health_lock = threading.Lock()
        self.connected = self.verified = False
        self.last_received_at = self.last_received_monotonic = None
        self.last_sample_at = self.last_sample_monotonic = None
        self.last_error_at = None
        self.identity_check = identity_check

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def health(self):
        """Memory-only evidence; a worker or a cached channel is not a live session."""
        with self.health_lock:
            running = not self.stop_event.is_set()
            now = time.monotonic()
            return {'connected': running and self.connected, 'verified': running and self.verified,
                    'last_received_at': self.last_received_at,
                    'received_age': None if self.last_received_monotonic is None else max(0, now - self.last_received_monotonic),
                    'sample_fresh': self.last_sample_monotonic is not None and now - self.last_sample_monotonic < self.stale_after,
                    'last_error': self.last_error, 'last_error_at': self.last_error_at}

    def _run(self):
        while not self.stop_event.is_set():
            try:
                self._connection()
            except Exception as error:
                with self.health_lock:
                    self.last_error = type(error).__name__
                    self.last_error_at = time.time()
            finally:
                with self.health_lock:
                    self.connected = self.verified = False
            if self.stop_event.wait(self.retry_delay):
                break

    def _connection(self):
        if self.identity_check and not self.identity_check(self.receiver):
            raise ValueError('Legacy receiver identity unavailable or changed')
        identity_pending = bool(self.identity_check)
        model = self.receiver['model']
        count = MODELS[model][1]
        session, seq = uuid.uuid4().hex, 0
        pending, window_bytes, window_at = '', 0, time.monotonic()
        reply, rates, changed_rates, current_rates = ShureReply(), {}, set(), {}
        if self.identity_check:
            reply.model = model
            reply.settings = copy.deepcopy(self.receiver['settings'])
        last_sample, states = {}, {}
        battery = BatteryRefresh(count)
        freshness = MetadataFreshness(count)
        family = MODELS[model][0]
        cached = copy.deepcopy(self.receiver.get('channels', {}))
        verified = initialized = False
        began = time.monotonic()
        last_metadata = began

        def emit(channels, *, received=True):
            if not channels or self.stop_event.is_set():
                return
            if received:
                with self.health_lock:
                    self.last_received_at, self.last_received_monotonic = time.time(), time.monotonic()
                    self.last_error = None
                    if any(values.get('meter_state') == 'live' for values in channels.values()):
                        self.last_sample_at, self.last_sample_monotonic = self.last_received_at, self.last_received_monotonic
            # Keep metadata discovered after the initial probe across reconnects
            # so the next connection cannot accidentally make an old value fresh.
            for channel, values in channels.items():
                old = self.receiver.setdefault('channels', {}).setdefault(channel, {})
                times = {**old.get('field_times', {}), **values.get('field_times', {})}
                old.update(copy.deepcopy(values))
                if times: old['field_times'] = times
            result = {**self.receiver, 'channels': channels, 'ts': time.time(),
                      'observation_received': received}
            self.on_update(result)

        def invalidate(state):
            updates = freshness.expire(disconnected=True)
            for ch in range(1, count + 1):
                if str(ch) in cached and states.get(ch) != state:
                    states[ch] = state
                    updates[str(ch)] = {**updates.get(str(ch), {}), 'channel_number': ch, 'audio_dbfs': None, 'rf_dbm': None, 'rf_antenna':None, 'antenna_status':None, 'rf_antennas_dbm':None, 'rf_branches':None,
                        'meter_state': state, 'meter_stream_id': session, 'meter_interval_ms': METER_MS}
            emit(updates, received=False)

        for channel,values in cached.items():
            known={k:v for k,v in values.items() if k not in METER_FIELDS and not k.startswith('meter_') and k not in ('channel_number','field_times','stale_fields')}
            known.update({'settings.'+key:value for key,value in self.receiver.get('settings',{}).items()})
            known['receiver_firmware'] = self.receiver.get('version')
            freshness.observe(int(channel),known)
        invalidate('connecting')
        with socket.create_connection((self.receiver['ip'], self.port), timeout=.5) as sock:
            with self.health_lock:
                self.connected = True
                self.verified = False
                self.last_received_at = self.last_received_monotonic = None
                self.last_sample_at = self.last_sample_monotonic = None
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.settimeout(.1)

            def send(command):
                sock.sendall(command.replace('\r','').replace('\n','').encode('ascii') if self.identity_check else (command + '\r\n').encode('ascii'))

            if not self.identity_check:send('< GET MODEL >')
            send('< GET 0 ALL >')
            if not self.identity_check:
                send('< GET NET_SETTINGS SC >')
                send('< GET RF_BAND >')  # Once per connection; unsupported stays unknown.
            try:
                while not self.stop_event.is_set():
                    now = time.monotonic()
                    if not verified and now - began > 2:
                        raise ValueError('MODEL verification timed out')
                    if verified and now - last_metadata >= self.metadata_interval:
                        if self.identity_check and not self.identity_check(self.receiver):
                            raise ValueError('Legacy receiver identity changed')
                        identity_pending = bool(self.identity_check)
                        send('< GET 0 ALL >')
                        last_metadata = now
                    if verified:
                        for channel in battery.due(now):
                            # One write, no synchronous reply wait: SAMPLE keeps
                            # flowing while the transmitter reports its battery.
                            keys = ('BATT_BARS','BATT_CHARGE') if family == 'ULXD' else ('TX_BATT_BARS','TX_BATT_CHARGE_PERCENT')
                            send('\r\n'.join(f'< GET {channel} {key} >' for key in keys))
                    # Valid metadata alone cannot make a stale audio meter live.
                    stale = freshness.expire()
                    if initialized:
                        for ch in range(1, count + 1):
                            if now - last_sample.get(ch, began) > self.stale_after and states.get(ch) != 'stale':
                                states[ch] = 'stale'
                                stale[str(ch)] = {**stale.get(str(ch), {}), 'channel_number': ch, 'audio_dbfs': None, 'rf_dbm': None, 'rf_antenna':None, 'antenna_status':None, 'rf_antennas_dbm':None, 'rf_branches':None,
                                    'meter_state': 'stale', 'meter_stream_id': session, 'meter_interval_ms': METER_MS}
                        emit(stale, received=False)
                        if now - max(last_sample.values(), default=began) > max(3, self.stale_after * 3):
                            raise ValueError('SAMPLE stream timed out')
                    try:
                        chunk = sock.recv(8192)
                    except socket.timeout:
                        continue
                    if not chunk:
                        raise ConnectionError('Shure socket closed')
                    if now - window_at >= 1:
                        window_bytes, window_at = 0, now
                    window_bytes += len(chunk)
                    if window_bytes > MAX_REPLY:
                        raise ValueError('Shure byte rate exceeds limit')
                    frames, pending = extract_framed_messages(pending + chunk.decode('ascii'))
                    metadata = {}
                    for frame in frames:
                        kind, ch, fields = parse_shure_frame(frame)
                        if kind == 'REP':
                            reply.feed(frame)
                            if 'MODEL' in fields or (self.identity_check and 'FW_VER' in fields):
                                if reply.model != model:
                                    raise ValueError('Receiver model changed')
                                if self.identity_check and reply.firmware != self.receiver['version']:
                                    raise ValueError('Legacy receiver firmware identity changed')
                                if not verified:
                                    verified = True
                                    with self.health_lock:
                                        self.verified = True
                                    for channel in range(1, count + 1):
                                        send(f'< GET {channel} METER_RATE >')
                            if verified and ch in range(1, count + 1) and 'METER_RATE' in fields:
                                value = fields['METER_RATE']
                                if value.isascii() and value.isdigit() and (int(value) == 0 or 100 <= int(value) <= (65535 if family == 'AD4' else 99999)):
                                    rate = int(value)
                                    current_rates[ch] = rate
                                    if ch not in rates:
                                        rates[ch] = rate
                                        if rate != METER_MS:
                                            changed_rates.add(ch)
                                            send(f'< SET {ch} METER_RATE {METER_MS:05d} >')
                            if verified:
                                # Only this REP renews its own fields. Publish
                                # condition transitions immediately, even when
                                # several arrive inside the same TCP packet.
                                one = ShureReply(); one.model = model; one.feed(frame)
                                current = one.channel_values()
                                receiver_values = {}
                                if ch is None:
                                    receiver_values = {'settings.'+k:v for k,v in one.settings.items()}
                                    if 'FW_VER' in fields:receiver_values['receiver_firmware']=reply.firmware
                                    if self.identity_check and identity_pending and 'FW_VER' in fields:
                                        # These fields were checked by the installed adapter;
                                        # renew them only after the same connection confirms firmware.
                                        receiver_values.update({'settings.'+k:reply.settings[k] for k in (
                                            'systemapi_device_id','receiver_serial','identity_source','legacy_scp',
                                            'receiver_mac','network_ip','receiver_mac_source','legacy_control_identity','model_source')
                                            if k in reply.settings})
                                        identity_pending=False
                                    self.receiver.update(version=reply.firmware or self.receiver.get('version'),
                                        device_name=reply.device_name or self.receiver.get('device_name'), settings=copy.deepcopy(reply.settings))
                                for channel in range(1,count+1):
                                    values = {k:v for k,v in current.get(channel,{}).items() if k not in METER_FIELDS}
                                    observed = {**values, **receiver_values}
                                    if not observed:continue
                                    if ch == channel:battery.observe(ch,fields,values)
                                    old=cached.setdefault(str(channel),{'channel_number':channel})
                                    delta={k:v for k,v in values.items() if k not in old or old[k]!=v}
                                    old.update(values)
                                    stamp=freshness.observe(channel,observed)
                                    emit({str(channel):{'channel_number':channel,**delta,**stamp}})
                        elif verified and kind == 'SAMPLE':
                            sample = decode_sample(model, frame)
                            if sample:
                                channel, values = sample
                                battery.sample(channel, values.get('rf_antenna', 'AX' if 'B' in values.get('antenna_status','') else 'XX'), time.monotonic())
                                # Flush older metadata before the sample. There
                                # is only one producer for this receiver.
                                emit(metadata); metadata = {}
                                seq += 1
                                states[channel] = 'live'
                                last_sample[channel] = time.monotonic()
                                values.update(channel_number=channel, meter_state='live', meter_stream_id=session,
                                    meter_seq=seq, meter_received_at_ms=int(time.time()*1000), meter_interval_ms=METER_MS)
                                emit({str(channel): values})
                    if verified:
                        self.receiver.update(version=reply.firmware or self.receiver.get('version'),
                            device_name=reply.device_name or self.receiver.get('device_name'), settings=copy.deepcopy(reply.settings))
                        initialized = True
                    emit(metadata)
            finally:
                # Mark transport loss before restoration writes or callbacks:
                # observers must not see a disconnected report as still live.
                with self.health_lock:
                    self.connected = self.verified = False
                # Rate is telemetry configuration. Restore only our own last
                # acknowledged setting, never overwrite an observed external rate.
                for ch in changed_rates:
                    if current_rates.get(ch) == METER_MS:
                        try:
                            send(f'< SET {ch} METER_RATE {rates[ch]:05d} >')
                        except OSError:
                            pass
                invalidate('disconnected')
