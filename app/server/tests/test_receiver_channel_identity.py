"""回归测试：接收机身份必须先于 CH 通道解析。

这些测试不启动网络服务，直接验证 mqtt-bridge 的协议边界，防止
``Group1/CH2`` 再次被解析成 CH1，或两台接收机的同号通道互相误操作。
"""
import importlib.util
import json
import os
import tempfile
import unittest
from pairing_test_support import PairingFixture


class ReceiverChannelIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix='daty-identity-db-')
        cls._db_path = os.path.join(cls._tmp.name, 'database.sqlite3')
        os.environ['DATY_DB_PATH'] = cls._db_path
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'mqtt-bridge.py')
        spec = importlib.util.spec_from_file_location('daty_mqtt_bridge_test', path)
        cls.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.bridge)
        cls.bridge._push_sse_event = lambda *args, **kwargs: None
        cls.bridge._record_device_state = lambda *args, **kwargs: None
        cls._pairing_temp = tempfile.TemporaryDirectory(prefix='daty-identity-pairing-')
        cls._pairings = PairingFixture(cls._pairing_temp.name, ('02:00:00:00:00:10',))
        cls.bridge._pairing_policy = cls._pairings.policy

    @classmethod
    def tearDownClass(cls):
        cls.bridge._close_database()
        cls._pairing_temp.cleanup()
        for suffix in ('', '-wal', '-shm'):
            try:
                os.unlink(cls._db_path + suffix)
            except FileNotFoundError:
                pass
        cls._tmp.cleanup()

    def setUp(self):
        b = self.bridge
        b._state['devices'].clear()
        b._state['clients'].clear()
        b._state['receivers'].clear()
        b._state['receiver_aliases'].clear()
        b._state.get('source_epochs', {}).clear()
        b._state['source_epoch_seq'] = 0
        b._state.get('receiver_epoch_fences', {}).clear()
        b._offline_announced.clear()
        b._broker_clients.clear()

    def _register(self, ip, mac, channels, mqtt_client=None, connection_token=None):
        payload = {
            'type': 'device_list',
            'client_id': f'FAshe-{ip}_session',
            'ip': ip,
            'receiver_ip': ip,
            'mac_address': mac,
            'receiver_mac': mac,
            'group': 1,
            'devices': [
                {'name': f'{ip}-CH{ch}', 'channel': f'Group9/CH{ch}',
                 'freq_mhz': 641 + ch / 4, 'brand': 'DATYaudio'}
                for ch in channels
            ],
        }
        self.bridge._process_mqtt_message(
            self.bridge.MQTT_TOPIC_REGISTER, json.dumps(payload), mqtt_client or payload['client_id'], connection_token)

    def test_channel_parser_never_uses_group_number(self):
        b = self.bridge
        self.assertEqual(b._channel_number('Group1/CH2', None), 2)
        self.assertEqual(b._channel_number('CH:CH-8', None), 8)
        self.assertIsNone(b._channel_number('Group1', None))

    def test_same_channel_on_two_receivers_isolated(self):
        b = self.bridge
        self._register('192.0.2.102', '02:00:00:00:00:02', [1, 2, 4, 8])
        self._register('192.0.2.103', '02:00:00:00:00:03', [1])
        self.assertEqual(len(b._state['devices']), 5)
        a_id = 'FAshe-MAC-020000000002'
        b_id = 'FAshe-MAC-020000000003'
        self.assertEqual(
            b._resolve_command_targets_locked({'receiver_mac': '02:00:00:00:00:02', 'channel': 1}),
            [f'{a_id}_ch1'])
        self.assertEqual(
            b._resolve_command_targets_locked({'receiver_ip': '192.0.2.103', 'channel': 'Group2/CH1'}),
            [f'{b_id}_ch1'])
        self.assertEqual(b._resolve_command_targets_locked({'channel': 1}), [])
        self.assertEqual(
            b._apply_mute_command({'command': 'mute', 'receiver_mac': '02:00:00:00:00:02', 'channel': 'CH1'}),
            [f'{a_id}_ch1'])
        self.assertTrue(b._state['devices'][f'{a_id}_ch1']['muted'])
        self.assertFalse(b._state['devices'][f'{b_id}_ch1']['muted'])

    def test_mute_commands_are_explicit_and_idempotent(self):
        b = self.bridge
        self._register('192.0.2.106', '02:00:00:00:00:06', [1, 2])
        receiver = 'FAshe-MAC-020000000006'
        ch1 = f'{receiver}_ch1'
        payload = {
            'type': 'device_command',
            'client_id': 'FAshe-192.0.2.106_session',
            'receiver_id': 'FAshe-192.0.2.106',
            'receiver_ip': '192.0.2.106',
            'receiver_mac': '02:00:00:00:00:06',
            'channel': 1,
            'channel_number': 1,
            'command': 'mute',
            'value': True,
        }
        b._process_mqtt_message(b.MQTT_TOPIC_DOWN, json.dumps(payload), payload['client_id'])
        self.assertTrue(b._state['devices'][ch1]['muted'])
        # 重复 mute 仍然是 true，不做 toggle，也不影响 CH2。
        b._process_mqtt_message(b.MQTT_TOPIC_DOWN, json.dumps(payload), payload['client_id'])
        self.assertTrue(b._state['devices'][ch1]['muted'])
        self.assertFalse(b._state['devices'][f'{receiver}_ch2']['muted'])

        payload.update(command='unmute', value=False)
        b._process_mqtt_message(b.MQTT_TOPIC_DOWN, json.dumps(payload), payload['client_id'])
        self.assertFalse(b._state['devices'][ch1]['muted'])

    def test_string_false_is_not_treated_as_muted(self):
        b = self.bridge
        self.assertFalse(b._strict_bool('false'))
        self.assertTrue(b._strict_bool('true'))
        self.assertFalse(b._command_actual_value('mute', {'muted': 'false'}))
        # 取消静音的期望值为 false，设备回报字符串 "false" 时应匹配成功。
        self.assertTrue(b._command_value_matches(
            {'command': 'unmute', 'expected_value': 'false'}, 'false'))
        self.assertFalse(b._command_value_matches(
            {'command': 'mute', 'expected_value': 'true'}, 'false'))

    def test_server_mute_waits_for_real_up_ack(self):
        """服务器发布命令时不能先伪造卡片状态，必须等设备 up 回报。"""
        b = self.bridge
        self._register('192.0.2.111', '02:00:00:00:00:11', [1])
        receiver = 'FAshe-MAC-020000000011'
        device_id = f'{receiver}_ch1'
        command = {
            'type': 'device_command', 'command': 'mute', 'value': True,
            'device_id': device_id, 'receiver_id': receiver,
            'receiver_ip': '192.0.2.111',
            'receiver_mac': '02:00:00:00:00:11', 'channel_number': 1,
        }
        record = b._create_command_record(command, [device_id], 1)
        self.assertFalse(b._state['devices'][device_id]['muted'])
        self.assertEqual(record['status'], 'published')

        # 设备执行后通过 up 回报真实状态，bridge 才能更新并 ACK。
        b._process_mqtt_message(
            b.MQTT_TOPIC_UP,
            json.dumps({
                'type': 'device_update',
                'client_id': 'FAshe-192.0.2.111_session',
                'receiver_ip': '192.0.2.111',
                'receiver_mac': '02:00:00:00:00:11',
                'channel': 1, 'muted': True,
            }),
            'FAshe-192.0.2.111_session',
        )
        self.assertTrue(b._state['devices'][device_id]['muted'])
        self.assertEqual(b._state['commands'][record['command_id']]['status'], 'acknowledged')

    def test_duplicate_channel_items_do_not_create_extra_cards(self):
        b = self.bridge
        payload = {
            'type': 'device_list',
            'client_id': 'FAshe-192.0.2.109_session',
            'receiver_ip': '192.0.2.109',
            'receiver_mac': '02:00:00:00:00:09',
            'devices': [
                {'name': 'CH1-a', 'channel': 'Group1/CH1', 'group': 1},
                {'name': 'CH1-b', 'channel': 'Group2/CH1', 'group': 2},
                {'name': 'CH2', 'channel': 'CH2', 'group': 2},
            ],
        }
        b._process_mqtt_message(
            b.MQTT_TOPIC_REGISTER, json.dumps(payload), payload['client_id'])
        self.assertEqual(
            set(b._state['devices']), {
                'FAshe-MAC-020000000009_ch1',
                'FAshe-MAC-020000000009_ch2',
            })
        snapshot = b._get_devices_snapshot()
        self.assertEqual({item['ch'] for item in snapshot}, {'CH1', 'CH2'})
        self.assertTrue(all(item['receiver_id'] == 'FAshe-MAC-020000000009' for item in snapshot))

    def test_http_command_publish_is_targeted_to_registered_session(self):
        b = self.bridge
        credential = self._pairings.credentials[0]
        token = 'isolated-registered-session'
        self._register('192.0.2.110', '02:00:00:00:00:10', [1, 2], credential.client_id, token)
        session = {'pairing': self._pairings.principal(peer_ip='192.0.2.110'), 'connection_token': token}
        b._broker_clients[credential.client_id] = session
        receiver = 'FAshe-MAC-020000000010'
        captured = {}
        original = b._broker_publish_topic
        try:
            def fake_publish(topic, payload, client_ids=None, expected_sessions=None):
                captured['topic'] = topic
                captured['client_ids'] = set(client_ids or [])
                captured['expected_sessions'] = expected_sessions
                return len(captured['client_ids'])
            b._broker_publish_topic = fake_publish
            sent = b._broker_publish_command(
                {'command': 'mute', 'value': True}, [f'{receiver}_ch2'])
        finally:
            b._broker_publish_topic = original
        self.assertEqual(sent, 1)
        self.assertEqual(captured['topic'], b.MQTT_TOPIC_DOWN)
        self.assertEqual(captured['client_ids'], {credential.client_id})
        self.assertIs(captured['expected_sessions'][credential.client_id], session)

    def test_client_down_commands_are_not_broadcast_to_other_receivers(self):
        """接收机本机发布的 down 命令不能串到其它接收机。"""
        b = self.bridge
        self.assertFalse(b._should_forward_client_publish(b.MQTT_TOPIC_DOWN))
        self.assertTrue(b._should_forward_client_publish(b.MQTT_TOPIC_UP))

    def test_group_only_and_interference_do_not_create_channels(self):
        b = self.bridge
        self._register('192.0.2.104', '02:00:00:00:00:04', [1])
        before = len(b._state['devices'])
        malformed = {
            'type': 'device_status_update', 'client_id': 'FAshe-192.0.2.104_session',
            'ip': '192.0.2.104', 'mac_address': '02:00:00:00:00:04',
            'group': 3, 'channel': 'Group3', 'device_role': 'interference',
        }
        b._process_mqtt_message(b.MQTT_TOPIC_UP, json.dumps(malformed), malformed['client_id'])
        self.assertEqual(len(b._state['devices']), before)

    def test_group_cannot_be_receiver_identity(self):
        b = self.bridge
        payload = {
            'type': 'device_list',
            'receiver_id': 'Group7',
            'devices': [{'name': 'bad', 'channel': 'CH1'}],
        }
        b._process_mqtt_message(b.MQTT_TOPIC_REGISTER, json.dumps(payload), 'Group7')
        self.assertEqual(b._state['devices'], {})

    def test_newer_session_fences_old_session_after_disconnect(self):
        b = self.bridge
        # session-a 先注册 4CH，session-b 后注册 1CH；旧 session-a 的迟到
        # 包以及 b 断线后都不能把 4CH 重新带回来。
        def register(sender, channels):
            payload = {
                'type': 'device_list', 'client_id': 'FAshe-192.0.2.106',
                'receiver_ip': '192.0.2.106', 'receiver_mac': '02:00:00:00:00:06',
                'devices': [{'name': f'CH{ch}', 'channel': ch} for ch in channels],
            }
            b._process_mqtt_message(b.MQTT_TOPIC_REGISTER, json.dumps(payload), sender)
        register('session-a', [1, 2, 3, 4])
        register('session-b', [1])
        self.assertEqual(set(b._state['devices']), {'FAshe-MAC-020000000006_ch1'})
        register('session-a', [1, 2, 3, 4])
        self.assertEqual(set(b._state['devices']), {'FAshe-MAC-020000000006_ch1'})
        with b._state_lock:
            b._state['clients'].pop('session-b:mqtt', None)
            b._state['receivers'].pop('FAshe-MAC-020000000006', None)
        register('session-a', [1, 2, 3, 4])
        self.assertEqual(set(b._state['devices']), {'FAshe-MAC-020000000006_ch1'})

    def test_modern_up_rebinds_new_receiver_alias_after_claim(self):
        """单通道 up 的新 IP/MAC 别名必须在会话 claim 后绑定。"""
        b = self.bridge
        receiver_mac = '02:00:00:00:00:07'
        register = {
            'type': 'device_list',
            'client_id': 'FAshe-rx-7',
            'receiver_ip': '192.0.2.107',
            'receiver_mac': receiver_mac,
            'devices': [{'name': 'CH1', 'channel': 1}],
        }
        b._process_mqtt_message(
            b.MQTT_TOPIC_REGISTER, json.dumps(register), register['client_id'])
        receiver_id = 'FAshe-MAC-020000000007'
        self.assertEqual(
            b._state['receiver_aliases'].get('ip:192.0.2.107'), receiver_id)

        # 模拟设备换 IP 后只发送单通道 up；MAC 仍是同一台接收机。
        up = {
            'type': 'device_update',
            'client_id': 'FAshe-rx-7',
            'receiver_ip': '192.0.2.207',
            'receiver_mac': receiver_mac,
            'channel': 1,
            'rf_level': -55,
        }
        b._process_mqtt_message(
            b.MQTT_TOPIC_UP, json.dumps(up), up['client_id'])
        self.assertEqual(
            b._state['receiver_aliases'].get('ip:192.0.2.207'), receiver_id)

    def test_top_level_receiver_identity_wins_over_channel_item(self):
        """注册批次顶层 IP/MAC 是接收机身份，不能被通道项覆盖。"""
        b = self.bridge
        payload = {
            'type': 'device_list',
            'client_id': 'FAshe-rx-8',
            'receiver_ip': '192.0.2.108',
            'receiver_mac': '02:00:00:00:00:08',
            'devices': [{
                'name': 'CH1', 'channel': 1,
                # 这些字段代表通道/发射机，不能改变接收机归属。
                'ip': '10.10.10.99',
                'mac': '02:00:00:00:99:99',
            }],
        }
        b._process_mqtt_message(
            b.MQTT_TOPIC_REGISTER, json.dumps(payload), payload['client_id'])
        device = b._state['devices']['FAshe-MAC-020000000008_ch1']
        self.assertEqual(device.get('receiver_ip'), '192.0.2.108')
        self.assertEqual(device.get('receiver_mac'), '02:00:00:00:00:08')
        self.assertEqual(device.get('ip'), '192.0.2.108')

    def test_legacy_batch_skips_items_without_explicit_channel(self):
        b = self.bridge
        payload = {
            'type': 'device_list',
            'client_id': 'FAshe-192.0.2.105_session',
            'ip': '192.0.2.105',
            'mac_address': '02:00:00:00:00:05',
            'devices': [
                {'name': 'Group7', 'channel': 'Group7'},
                {'name': 'Group7/CH2', 'channel': 'Group7/CH2'},
            ],
        }
        b._process_mqtt_message(b.MQTT_TOPIC_REGISTER, json.dumps(payload), payload['client_id'])
        self.assertEqual(
            set(b._state['devices']),
            {'FAshe-MAC-020000000005_ch2'},
        )

        # 后续旧格式状态包也不能利用 id/name 回退创建 Group-only 通道。
        status = {
            'type': 'device_status_update',
            'client_id': payload['client_id'],
            'ip': payload['ip'],
            'mac_address': payload['mac_address'],
            'devices': [{'id': 'legacy-group7', 'name': 'Group7', 'group': 7}],
        }
        b._process_mqtt_message(b.MQTT_TOPIC_UP, json.dumps(status), payload['client_id'])
        self.assertEqual(set(b._state['devices']), {'FAshe-MAC-020000000005_ch2'})

    def test_legacy_malformed_register_cannot_claim_session(self):
        """旧格式也必须先完成 CH/role 校验，再驱逐旧会话。"""
        b = self.bridge
        topic = 'daty/rf/devices/legacy-register'
        receiver = 'legacy-rx-1'
        valid = {
            'type': 'device_list', 'receiver_id': receiver,
            'devices': [{'name': 'CH1', 'channel': 1, 'group': 4}],
        }
        b._process_mqtt_message(topic, json.dumps(valid), 'legacy-session-a')
        self.assertEqual(b._state['receivers'].get(receiver), 'legacy-session-a:mqtt')
        self.assertEqual(set(b._state['devices']), {f'{receiver}_ch1'})

        malformed = {
            'type': 'device_list', 'receiver_id': receiver,
            'devices': [{'name': 'Group9', 'group': 9}],
        }
        b._process_mqtt_message(topic, json.dumps(malformed), 'legacy-session-b')
        self.assertEqual(b._state['receivers'].get(receiver), 'legacy-session-a:mqtt')
        self.assertEqual(set(b._state['devices']), {f'{receiver}_ch1'})

    def test_legacy_empty_register_is_explicit_clear(self):
        """空 register 快照是唯一允许在无 CH 时清除该接收机通道的情况。"""
        b = self.bridge
        topic = 'daty/rf/devices/legacy-register'
        receiver = 'legacy-rx-2'
        valid = {
            'type': 'device_list', 'receiver_id': receiver,
            'devices': [{'name': 'CH1', 'channel': 1}, {'name': 'CH2', 'channel': 2}],
        }
        b._process_mqtt_message(topic, json.dumps(valid), 'legacy-session')
        self.assertEqual(len(b._state['devices']), 2)
        b._process_mqtt_message(topic, json.dumps({
            'type': 'device_list', 'receiver_id': receiver, 'devices': [],
        }), 'legacy-session')
        self.assertEqual(b._state['receivers'].get(receiver), 'legacy-session:mqtt')
        self.assertEqual(b._state['devices'], {})

    def test_legacy_malformed_status_cannot_claim_session(self):
        b = self.bridge
        register_topic = 'daty/rf/devices/legacy-register'
        status_topic = 'daty/rf/devices/legacy-status'
        receiver = 'legacy-rx-3'
        b._process_mqtt_message(register_topic, json.dumps({
            'type': 'device_list', 'receiver_id': receiver,
            'devices': [{'name': 'CH1', 'channel': 1, 'muted': False}],
        }), 'legacy-session-a')
        b._process_mqtt_message(status_topic, json.dumps({
            'type': 'device_status_update', 'receiver_id': receiver,
            'devices': [{'group': 7, 'rf_level': -90}],
        }), 'legacy-session-b')
        self.assertEqual(b._state['receivers'].get(receiver), 'legacy-session-a:mqtt')
        self.assertFalse(b._state['devices'][f'{receiver}_ch1']['muted'])


if __name__ == '__main__':
    unittest.main()
