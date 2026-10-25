"""Injectable adapter for an ISOLATED existing Bridge; no production patching.

The original pairing, socket session, channel normalization and telemetry path
remain authoritative. The candidate has exactly one command socket send path.
"""
import asyncio
import copy
import json
from pathlib import Path

from command_journal import CommandError


class BridgeAdapter:
    def __init__(self, bridge, *, fixture_root=None, runtime_scope=None):
        if runtime_scope is not None:
            from m6_scope import checked_scope
            checked_scope(runtime_scope).check_bridge(bridge)
        else:
            base = Path(fixture_root).resolve()
            forbidden = (Path(__file__).resolve().parents[2], Path('C:/ProgramData/DATY RF PRO'))
            if (not (base / '.daty-mqtt-stage3-fixture').is_file()
                or not Path(bridge._db_path).resolve().is_relative_to(base)
                or not bridge._pairing_policy.path.resolve().is_relative_to(base)
                or any(base.is_relative_to(p.resolve()) for p in forbidden)):
                raise ValueError('Production Bridge/registry forbidden')
        self.b, self.service = bridge, None
        self.loop = asyncio.get_running_loop()
        self.attempts = []
        self.observers = set()
        self.before_send = None  # Fault-injection seam, never a second sender.
        self.original_process = bridge._process_mqtt_message
        self.original_publish = bridge._broker_publish_command
        bridge._process_mqtt_message = self.process
        bridge._broker_publish_command = self.deny_legacy_sender

    @staticmethod
    def deny_legacy_sender(*args, **kwargs):
        raise CommandError('LEGACY_CONTROL_SENDER_DISABLED')

    def binding(self, device_id):
        b = self.b
        with b._state_lock:
            device = copy.deepcopy(b._state['devices'].get(device_id))
        if not device or b.time.time() - device.get('_last_seen', 0) >= b.DEVICE_ONLINE_SECONDS:
            raise CommandError('TARGET_OFFLINE')
        client_id = b._mqtt_client_id_from_source(device.get('_source'))
        with b._broker_lock:
            session = b._broker_clients.get(client_id)
            principal = session.get('pairing') if session else None
            token = session.get('connection_token') if session else None
        if not session or not token or not b._pairing_policy.is_active(principal):
            raise CommandError('TARGET_SESSION_LOST')
        if (device.get('_source') != b._mqtt_source_key(client_id, token)
                or device.get('_receiver_id') != principal['receiver_id']
                or device.get('receiver_mac') != principal['receiver_mac']
                or device.get('receiver_ip') != principal['_peer_ip']
                or b._normalize_device_brand(device.get('brand')) != b._normalize_device_brand(principal['brand'])):
            raise CommandError('TARGET_IDENTITY_MISMATCH')
        ch = device.get('channel_number')
        if type(ch) is not int or not 1 <= ch <= principal['max_channels']:
            raise CommandError('INVALID_CHANNEL')
        target = {'device_id': device_id, 'receiver_id': principal['receiver_id'],
                  'receiver_mac': principal['receiver_mac'], 'receiver_ip': principal['_peer_ip'],
                  'receiver_session_id': token, 'channel_number': ch,
                  'expected_brand': b._normalize_device_brand(principal['brand'])}
        return target, device, client_id, session

    def targets(self):
        with self.b._state_lock:
            ids = list(self.b._state['devices'])
        result = []
        for did in ids:
            try:
                target, device, _, _ = self.binding(did)
                caps = self.b._device_capabilities(device, device)
                if device.get('control_protocol') == 'fashe-realtime-v1' and (caps.get('mute') or caps.get('write_frequency')):
                    groups = self.b._pairing_policy._load().get('receiver_groups', {})
                    result.append({'target': target, 'group_number': groups.get(target['receiver_mac']),
                        'group_source': 'server-fifo-v1', 'model': device.get('model'), 'capabilities': caps})
            except CommandError:
                pass
        # GROUP is view metadata only. Unknown last; sort whole set before host pagination.
        return sorted(result, key=lambda item: (item['group_number'] if type(item['group_number']) is int
                     and item['group_number'] > 0 else float('inf'), item['target']['channel_number']))

    def validate(self, target, command):
        current, device, client_id, session = self.binding(target['device_id'])
        if current != target:
            raise CommandError('TARGET_BINDING_CHANGED')
        if device.get('control_protocol') != 'fashe-realtime-v1':
            raise CommandError('EXPLICIT_COMMAND_ACK_REQUIRED')
        capability = 'write_frequency' if command == 'set_freq' else 'mute'
        if not self.b._device_capabilities(device, device).get(capability):
            raise CommandError('CAPABILITY_DENIED')
        if self.b.MQTT_TOPIC_DOWN not in session['subscriptions']:
            raise CommandError('TARGET_NOT_SUBSCRIBED')
        return current, device, client_id, session

    async def send(self, record, *, allowed):
        if self.before_send:
            await self.before_send(record)
        if not allowed():
            raise CommandError('DISPATCH_CANCELLED_OR_EXPIRED')
        target, device, client_id, session = self.validate(record['target'], record['command'])
        # This check and entering ws.send share the receiver socket event loop.
        # A replacement session cannot be substituted after this final check.
        with self.b._broker_lock:
            if self.b._broker_clients.get(client_id) is not session:
                raise CommandError('TARGET_SESSION_LOST')
        payload = {'type': 'device_command', 'command_id': record['command_id'],
                   'device_id': target['device_id'], 'receiver_id': target['receiver_id'],
                   'receiver_ip': target['receiver_ip'], 'ip': target['receiver_ip'],
                   'receiver_mac': target['receiver_mac'], 'mac_address': target['receiver_mac'],
                   'brand': target['expected_brand'], 'expected_brand': target['expected_brand'],
                   'channel': target['channel_number'], 'channel_number': target['channel_number'],
                   'command': record['command'], 'value': record['expected_value'] / 1000
                       if record['command'] == 'set_freq' else record['expected_value']}
        wire = self.b._build_mqtt_publish_packet(self.b.MQTT_TOPIC_DOWN, json.dumps(payload))
        # One QoS0 legacy delivery, no offline queue, retry or scheduled coroutine.
        # If it times out after entry, execution is unknown, never "not sent".
        async def send_once():
            if not allowed():
                raise CommandError('DISPATCH_CANCELLED_OR_EXPIRED')
            _, _, cid, current = self.validate(record['target'], record['command'])
            if cid != client_id or current is not session:
                raise CommandError('TARGET_SESSION_LOST')
            self.attempts.append({'command_id': record['command_id'], 'target': copy.deepcopy(target)})
            await session['ws'].send(wire)
        await asyncio.wait_for(send_once(), 2)

    def process(self, topic, payload, client_id=None, connection_token=None):
        self.original_process(topic, payload, client_id, connection_token)
        if topic != self.b.MQTT_TOPIC_UP or not self.service:
            return
        try:
            raw = json.loads(payload) if isinstance(payload, str) else payload
            if not raw.get('command_id'):
                return
            with self.b._broker_lock:
                session = self.b._broker_clients.get(client_id)
                if not session or session.get('connection_token') != connection_token:
                    return
                principal = session['pairing']
            checked = self.b._pairing_policy.validate_payload(principal, topic, raw)
            channel = self.b._channel_from_payload(checked, None)
            with self.b._state_lock:
                ids = self.b._resolve_command_targets_locked({'receiver_id': principal['receiver_id'], 'channel_number': channel})
            if len(ids) != 1:
                return
            target, _, _, _ = self.binding(ids[0])
            if target['receiver_session_id'] != connection_token:
                return
            proof = {'command_id': checked['command_id'], 'target': target, 'raw': checked}
            self.loop.call_soon_threadsafe(self.schedule_observation, proof)
        except Exception:
            return  # A malformed/unbound report never becomes execution success.

    def schedule_observation(self, proof):
        async def receive():
            record = await asyncio.to_thread(self.service.journal.by_command, proof['command_id'])
            if not record:
                return
            raw = proof.pop('raw')
            command = record['command']
            if command == 'set_freq':
                actual = self.b._normalize_frequency_khz(raw.get('freq_mhz'), 'MHz') if 'freq_mhz' in raw else None
            else:
                actual = self.b._strict_bool(raw.get('muted'), None) if 'muted' in raw else None
            await self.service.observe({**proof, 'command': command, 'actual_value': actual})
        task = asyncio.create_task(receive())
        self.observers.add(task)
        task.add_done_callback(self.observation_done)

    def observation_done(self, task):
        self.observers.discard(task)
        if not task.cancelled() and task.exception() is not None:
            self.service.accepting = False

    async def close(self):
        self.b._process_mqtt_message = self.original_process
        self.b._broker_publish_command = self.original_publish
        await asyncio.gather(*self.observers, return_exceptions=True)
