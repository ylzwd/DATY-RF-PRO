"""Official-shaped frames and private ephemeral loopback sockets only; no LAN scan."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import queue
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT/'tests'))
from shure_protocol import ShureReply, extract_framed_messages
from shure_active_discovery import ShureDiscovery, probe_shure_sync, scan_targets
from pairing_test_support import PairingFixture, create_tls_fixture
from tls_support import server_context, client_context, bind_https


def reply(*frames):
    value = ShureReply()
    for frame in frames:
        value.feed(frame)
    return value


def observation(ip='192.0.2.5', frames=('REP MODEL {ULXD4D}', 'REP 1 FREQUENCY 641000', 'REP 2 FREQUENCY 642000')):
    value = reply(*frames)
    return {'receiver_id': f'Shure-{value.model}-{ip}', 'receiver_ip': ip, 'ip': ip, 'model': value.model,
            'device_name': 'Receiver', 'protocol_verified': value.model != 'QLXD4', 'ts': time.time(),
            'discovered_via': 'shure-scp', 'channels': {str(ch): {'channel_number': ch, **v} for ch,v in value.channel_values().items()}}


def wait_until(fn, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if fn(): return
        time.sleep(.005)
    raise AssertionError('fixture did not complete')


class ProtocolTests(unittest.TestCase):
    def test_global_model_padding_and_all_channels(self):
        r = reply('REP 2 FREQUENCY 642250', 'REP MODEL {ULXD4D   }',
                  'REP DEVICE_ID { My Rack }', 'REP 1 CHAN_NAME {Lead Vox   }', 'REP 1 FREQUENCY 641000')
        self.assertTrue(r.complete())
        self.assertEqual(r.device_name, 'My Rack')
        self.assertEqual(r.channel_values()[1]['name'], 'Lead Vox')
        self.assertEqual(sorted(r.channel_values()), [1, 2])

    def test_ulxd_units_and_unknown_battery(self):
        r = reply('REP MODEL {ULXD4}', 'REP 1 RX_RF_LVL 083', 'REP 1 AUDIO_LVL 045',
                  'REP 1 BATT_CHARGE 255', 'REP 1 BATT_BARS 255', 'REP 1 BATT_RUN_TIME 65535')
        self.assertEqual(r.channel_values()[1], {'rf_dbm': -45, 'audio_dbfs': -5,
                         'battery_percent': None, 'battery_bars': None, 'battery_minutes': None,
                         'battery_runtime_status': 'unknown'})

    def test_ad4_units_are_not_ulxd(self):
        r = reply('REP MODEL {AD4Q-A }', 'REP 1 FREQUENCY 0641250', 'REP 1 AUDIO_LEVEL_RMS 102',
                  'REP 1 RSSI 1 083', 'REP 1 RSSI 2 064', 'REP 1 RSSI 3 082', 'REP 1 RSSI 4 255')
        c = r.channel_values()[1]
        self.assertEqual(c['frequency_khz'], 641250)
        self.assertEqual(c['audio_dbfs'], -18)
        self.assertEqual(c['rf_dbm'], -37)
        self.assertEqual(c['rf_antennas_dbm'], {'1': -37, '2': -56, '3': -38, '4': None})

    def test_ulxd_real_frame_bars_and_distinct_output_transmitter_mute(self):
        r=reply('REP MODEL {ULXD4}', 'REP 1 AUDIO_LVL 000', 'REP 1 BATT_CHARGE 255',
                'REP 1 BATT_BARS 004', 'REP 1 BATT_RUN_TIME 65534', 'REP 1 BATT_TYPE LITH',
                'REP 1 TX_TYPE ULXD2', 'REP 1 AUDIO_MUTE OFF', 'REP 1 TX_MUTE_STATUS ON',
                'REP 1 AUDIO_GAIN 029', 'REP 1 RF_ANTENNA XB', 'REP HIGH_DENSITY OFF')
        c=r.channel_values()[1]
        self.assertEqual((c['audio_dbfs'],c['battery_bars'],c['audio_gain_db']),(-50,4,11))
        self.assertIsNone(c['battery_percent']);self.assertIsNone(c['battery_minutes'])
        self.assertEqual(c['battery_runtime_status'],'calculating')
        self.assertEqual((c['muted'],c['transmitter_muted']),(False,True))
        self.assertEqual(c['transmitter_type'],'ULXD2');self.assertEqual(c['rf_antenna'],'XB')
        self.assertEqual(r.settings,{'high_density':False})

    def test_runtime_special_values_and_transmitter_unknown_clear(self):
        for raw,status in [('00125','known'),('65533','error'),('65534','calculating'),('65535','unknown'),('99999','unknown')]:
            c=reply('REP MODEL {ULXD4}',f'REP 1 BATT_RUN_TIME {raw}',
                    'REP 1 TX_MUTE_STATUS UNKN','REP 1 TX_TYPE UNKN','REP 1 BATT_BARS 255').channel_values()[1]
            self.assertEqual(c['battery_runtime_status'],status)
            self.assertIsNone(c['transmitter_muted']);self.assertIsNone(c['transmitter_type'])
            self.assertIsNone(c['battery_bars'])

    def test_qlxd_does_not_guess_units_or_second_channel(self):
        r = reply('REP MODEL {QLXD4}', 'REP 1 FREQUENCY 641000', 'REP 1 RX_RF_LVL 083',
                  'REP 1 AUDIO_LVL 045', 'REP 1 AUDIO_MUTE ON', 'REP 1 BATT_CHARGE 050', 'REP 2 FREQUENCY 642000')
        self.assertEqual(r.channel_values(), {1: {'frequency_khz': 641000}})

    def test_unknown_model_error_sample_and_invalid_channel(self):
        for frame in ('REP 1 ERROR unsupported', 'SAMPLE 1 ALL 005 000 045 062 BB 31 099',
                      'REP MODEL {Dante}', 'REP MODEL {ULXD4FAKE}'):
            self.assertIsNone(reply(frame).model)
        self.assertEqual(reply('REP MODEL {AD4D}', 'REP 0 FREQUENCY 641000', 'REP 9 FREQUENCY 641000').channel_values(), {})

    def test_fragment_resync_and_limits(self):
        frames, tail = extract_framed_messages('noise > < abandoned < REP MODEL {ULXD4} >< REP 1 FREQ')
        self.assertEqual(frames, ['REP MODEL {ULXD4}'])
        frames, tail = extract_framed_messages(tail + 'UENCY 641000 > garbage')
        self.assertEqual(frames, ['REP 1 FREQUENCY 641000'])
        self.assertEqual(tail, '')
        with self.assertRaises(ValueError): extract_framed_messages('<' + 'x'*5000)

    def test_invalid_value_clears_but_omitted_is_absent(self):
        r = reply('REP MODEL {ULXD4}', 'REP 1 FREQUENCY invalid', 'REP 1 BATT_CHARGE 000', 'REP 1 AUDIO_MUTE MAYBE')
        self.assertEqual(r.channel_values()[1], {'frequency_khz': None, 'battery_percent': 0, 'muted': None})


class ProbeTests(unittest.TestCase):
    def run_peer(self, handler, timeout=.5):
        listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(1)
        commands, errors = [], []
        def run():
            try:
                with listener.accept()[0] as conn:
                    conn.settimeout(1)
                    commands.append(conn.recv(1024))
                    handler(conn, commands)
            except (OSError, BrokenPipeError): pass
            except Exception as e: errors.append(e)
            finally: listener.close()
        worker = threading.Thread(target=run, daemon=True); worker.start()
        result = probe_shure_sync('127.0.0.1', timeout=timeout, port=listener.getsockname()[1])
        worker.join(2)
        self.assertFalse(errors)
        self.assertFalse(worker.is_alive())
        self.assertIn(b'< GET 0 ALL >', commands[0])
        self.assertNotRegex(b''.join(commands), rb'<\s*SET\s')
        return result

    def test_one_connection_fragments_and_delayed_other_channel(self):
        def peer(conn, commands):
            conn.sendall(b'< REP MODEL {ULXD4D} >< REP 1 FREQUENCY 641000 >')
            time.sleep(.05)
            conn.sendall(b'< REP 2 CHAN_NAME {Back ')
            time.sleep(.03)
            conn.sendall(b'Vox} >< REP 2 FREQUENCY 642250 >')
        r = self.run_peer(peer)
        self.assertEqual(r['channel_count'], 2)
        self.assertEqual(r['channels']['2']['name'], 'Back Vox')

    def test_qlxd_safe_fallback(self):
        def peer(conn, commands):
            conn.sendall(b'< REP MODEL {QLXD4} >')
            commands.append(conn.recv(1024))
            conn.sendall(b'< REP 1 FREQUENCY 641000 >')
        r = self.run_peer(peer)
        self.assertFalse(r['protocol_verified'])
        self.assertFalse(r['hardware_verified'])

    def test_open_port_error_is_not_device(self):
        self.assertIsNone(self.run_peer(lambda c, _: c.sendall(b'< REP 1 ERROR unsupported >')))

    def test_continuous_garbage_has_total_deadline(self):
        def peer(conn, commands):
            for i in range(300):
                conn.sendall(b'garbage')
                time.sleep(.003)
        start = time.monotonic()
        self.assertIsNone(self.run_peer(peer, .15))
        self.assertLess(time.monotonic()-start, 1)

    def test_cancel_before_connect(self):
        stop = threading.Event(); stop.set()
        with patch('shure_active_discovery.socket.create_connection') as connect:
            self.assertIsNone(probe_shure_sync('127.0.0.1', stop=stop))
            connect.assert_not_called()


class NetworkTests(unittest.TestCase):
    def test_non_rfc1918_mask_and_254(self):
        targets, scopes = scan_targets([{'address': '192.0.2.16', 'prefix': 16}])
        self.assertEqual(len(targets), 253)
        self.assertIn('192.0.2.254', targets)
        self.assertNotIn('192.0.2.16', targets)
        self.assertEqual(scopes[0]['network'], '192.0.2.0/16')
        self.assertTrue(scopes[0]['limited_to_24'])

    def test_small_network_multiple_addresses_and_32(self):
        targets, _ = scan_targets([{'address':'10.0.0.1','prefix':29}, {'address':'10.0.0.2','prefix':29},
                                  {'address':'10.1.1.1','prefix':32}, {'address':'127.0.0.1','prefix':8}])
        self.assertEqual(targets, ['10.0.0.3','10.0.0.4','10.0.0.5','10.0.0.6'])

    def test_explicit_host_only_on_direct_subnet(self):
        interfaces = [{'address':'192.0.2.16','prefix':16}]
        targets, _ = scan_targets(interfaces, ['192.169.1.20'])
        self.assertIn('192.169.1.20', targets)
        for value in ('8.8.8.8','host.example','192.169.255.255'):
            with self.assertRaises(ValueError): scan_targets(interfaces, [value])

    def test_target_cap(self):
        with self.assertRaises(ValueError): scan_targets([{'address':f'10.0.{i}.1','prefix':24} for i in range(5)])


class ManagerTests(unittest.TestCase):
    def test_one_meter_per_receiver_and_stale_does_not_refresh_last_seen(self):
        from test_shure_metering import MeterPeer, receiver
        from shure_metering import ShureMeterSession
        peer=MeterPeer();accepted=[];probed=[]
        def probe(host, **kw):
            probed.append(host)
            return {**receiver(), 'ts':time.time()}
        m=ShureDiscovery(accepted.append,probe=probe,auto_scan=False)
        m.metering=True
        def factory(result, callback):
            return ShureMeterSession(result,callback,port=peer.port,metadata_interval=.1,stale_after=.2)
        try:
            with patch('shure_active_discovery.ShureMeterSession',factory):
                m._visit('127.0.0.1');m._visit('127.0.0.1')
                wait_until(lambda:any(v.get('meter_state')=='stale' for r in accepted for v in r['channels'].values()))
                self.assertEqual(len(probed),1);self.assertEqual(len(m.meters),1)
                from unified_domains import _clone
                _clone(m.snapshot())  # Discovery receipts use the business JSON guard.
                meter=m.meters['127.0.0.1'];old=m.receivers['127.0.0.1']['ts']
                m._meter_update('127.0.0.1',{**receiver(),'channels':{},'ts':old+100,'observation_received':False})
                self.assertEqual(m.receivers['127.0.0.1']['ts'],old)
        finally:m.stop();peer.close()
        self.assertFalse(meter.thread.is_alive())

    def test_manual_mode_polls_discovered_peers_without_automatic_rescan(self):
        accepted, enumerated = [], []
        def interfaces():
            enumerated.append(True)
            return [{'address':'192.0.2.1','prefix':30}]
        m = ShureDiscovery(accepted.append, interfaces=interfaces,
            probe=lambda host, **kw: observation(host), interval=.01, poll_interval=.01, auto_scan=False)
        try:
            m.start(); time.sleep(.05)
            self.assertEqual(enumerated, [])
            self.assertEqual(m.snapshot()['generation'], 0)
            m.request_scan()
            wait_until(lambda: len(accepted) >= 3)
            self.assertEqual(len(enumerated), 1)
            self.assertEqual(m.snapshot()['generation'], 1)
        finally:
            m.stop(); m.thread.join(2)
        self.assertFalse(m.thread.is_alive())

    def test_singleflight_cancel_and_stop_discard_late_results(self):
        for stop_all in (False, True):
            entered, release, accepted = threading.Event(), threading.Event(), []
            def probe(host, **kwargs):
                entered.set(); release.wait(2); return observation(host)
            m = ShureDiscovery(accepted.append, interfaces=lambda:[{'address':'192.0.2.1','prefix':30}], probe=probe)
            first = m.request_scan(); self.assertTrue(entered.wait(1))
            self.assertEqual(m.request_scan()['generation'], first['generation'])
            m.stop() if stop_all else m.cancel_scan()
            release.set(); wait_until(lambda: not m.busy)
            wait_until(lambda: not m.snapshot()['scanning'])
            self.assertEqual(accepted, [])
            m.stop()

    def test_disconnect_expiry_and_same_host_reconnect(self):
        accepted = []
        m = ShureDiscovery(accepted.append, probe=lambda host, **kw: observation(host))
        m._visit('192.0.2.2')
        m.receivers['192.0.2.2']['ts'] -= 16
        m.probe = lambda *args, **kw: None
        m._visit('192.0.2.2'); self.assertEqual(m.snapshot()['count'], 0)
        m.probe = lambda host, **kw: observation(host)
        m._visit('192.0.2.2'); self.assertEqual(m.snapshot()['count'], 1)
        self.assertEqual(len(accepted), 2)

    def test_scan_does_not_block_known_receiver_poll(self):
        entered, release, polled = threading.Event(), threading.Event(), threading.Event()
        def probe(host, **kw):
            if host == '192.0.2.2': entered.set(); release.wait(2)
            else: polled.set()
            return observation(host)
        m = ShureDiscovery(lambda r: None, interfaces=lambda:[{'address':'192.0.2.1','prefix':30}], probe=probe)
        m.request_scan(); self.assertTrue(entered.wait(1))
        m._visit('192.0.2.5'); self.assertTrue(polled.is_set())
        release.set(); wait_until(lambda: not m.snapshot()['scanning']); m.stop()

    def test_store_error_is_not_success(self):
        def fail(r): raise RuntimeError('test database failure')
        m = ShureDiscovery(fail, probe=lambda host, **kw: observation(host))
        m._visit('192.0.2.2')
        self.assertEqual(m.snapshot()['count'], 0)
        self.assertIn('存储失败', m.snapshot()['error'])


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-shure-isolated-')
        cls.pairing = PairingFixture(cls.temp.name)
        spec = importlib.util.spec_from_file_location('isolated_shure_bridge', ROOT/'mqtt-bridge.py')
        cls.b = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'DATY_DB_PATH':str(Path(cls.temp.name)/'fixture.sqlite3'),
                        'DATY_PAIRING_FILE':str(cls.pairing.path), 'DATY_SHURE_DISCOVERY':'0'}):
            spec.loader.exec_module(cls.b)
        cls.b._log = lambda *args: None
        cls.b._start_unified_runtime()
        cls.tls = create_tls_fixture(cls.temp.name)
        cls.http = bind_https(cls.b.ThreadingHTTPServer, ('127.0.0.1',0), cls.b.DatyAPIHandler, server_context(cls.tls))
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True); cls.worker.start()
        cls.base = f'https://127.0.0.1:{cls.http.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown(); cls.http.server_close(); cls.worker.join(3)
        cls.b._unified_runtime.stop(); cls.b._close_database(); cls.temp.cleanup()

    def setUp(self):
        for key in ('devices','clients','receivers','receiver_aliases','commands'):
            self.b._state[key].clear()
        self.b._state['sse_queues'].clear()

    def request(self, path, data=None, **headers):
        req = Request(self.base+path, data=None if data is None else json.dumps(data).encode(),
                      headers={'Content-Type':'application/json', **headers})
        with urlopen(req, context=client_context(self.tls), timeout=3) as r: return json.load(r)

    def test_durable_sse_two_receivers_and_unknown_group(self):
        b = self.b; packets = queue.Queue(); b._state['sse_queues'].append(packets)
        b._accept_shure_observation(observation())
        b._accept_shure_observation(observation('192.0.2.6'))
        snapshot = self.request('/api/devices')['devices']
        self.assertEqual(len(snapshot), 4)
        self.assertEqual(len({d['id'] for d in snapshot}), 4)
        self.assertTrue(all(d['group_number'] is None and d['capabilities']['read_only'] for d in snapshot))
        self.assertEqual(b._state['clients'], {})
        self.assertEqual(b._state['receivers'], {})
        self.assertEqual(json.loads(packets.get_nowait())['type'], 'device_update')
        b._unified_runtime.wait_idle()
        with b._db_session() as db:
            self.assertGreaterEqual(db.execute('SELECT COUNT(*) FROM telemetry_samples WHERE device_id LIKE ?', ('Shure-%',)).fetchone()[0], 4)
            self.assertGreaterEqual(db.execute('SELECT COUNT(*) FROM live_samples').fetchone()[0], 4)

    def test_partial_reply_does_not_refresh_missing_channel(self):
        b = self.b; b._accept_shure_observation(observation())
        did = 'Shure-ULXD4D-192.0.2.5_ch2'; b._state['devices'][did]['_last_seen'] -= 16
        b._accept_shure_observation(observation(frames=('REP MODEL {ULXD4D}', 'REP 1 FREQUENCY 641000')))
        self.assertFalse(next(d for d in b._get_devices_snapshot() if d['id']==did)['_online'])
        b._accept_shure_observation(observation())
        self.assertTrue(next(d for d in b._get_devices_snapshot() if d['id']==did)['_online'])

    def test_nulls_and_original_fashe_state_preserved(self):
        b = self.b; fashe = {'id':'FAshe-fixture_ch1', '_source':'fixture:mqtt','_last_seen':time.time(), 'freq':640000,'muted':True}
        b._state['devices'][fashe['id']] = copy.deepcopy(fashe)
        b._accept_shure_observation(observation(frames=('REP MODEL {ULXD4}', 'REP 1 FREQUENCY 641000', 'REP 1 AUDIO_LVL 000')))
        dev = b._state['devices']['Shure-ULXD4-192.0.2.5_ch1']
        self.assertIsNone(dev['af_dbfs']); self.assertEqual(dev['af_source_dbfs'], -50)
        self.assertIsNone(dev['muted']); self.assertIsNone(dev['batt'])
        self.assertEqual(b._state['devices'][fashe['id']], fashe)

    def test_vendor_display_dto_preserves_canonical_units_and_delta_clearing(self):
        b=self.b
        b._accept_shure_observation(observation(frames=('REP MODEL {ULXD4}', 'REP 1 FREQUENCY 677450',
            'REP 1 AUDIO_LVL 000','REP 1 BATT_BARS 004','REP 1 BATT_CHARGE 255',
            'REP 1 AUDIO_MUTE OFF','REP 1 TX_MUTE_STATUS ON')))
        dev=b._get_devices_snapshot()[0]
        self.assertIsNone(dev['af_dbfs']);self.assertIsNone(dev['batt'])
        self.assertEqual(dev['shure']['audio_dbfs'],-50)
        self.assertEqual(dev['shure']['battery_bars'],4)
        self.assertEqual((dev['shure']['receiver_muted'],dev['shure']['transmitter_muted']),(False,True))
        self.assertTrue(dev['capabilities']['read_af']);self.assertTrue(dev['capabilities']['read_battery'])
        self.assertFalse(dev['capabilities']['write_frequency']);self.assertFalse(dev['capabilities']['mute'])
        b._accept_shure_observation(observation(frames=('REP MODEL {ULXD4}','REP 1 FREQUENCY 677450',)))
        self.assertEqual(b._get_devices_snapshot()[0]['shure']['battery_bars'],4)
        b._accept_shure_observation(observation(frames=('REP MODEL {ULXD4}','REP 1 BATT_BARS 255','REP 1 TX_MUTE_STATUS UNKN')))
        dev=b._get_devices_snapshot()[0]
        self.assertIsNone(dev['shure']['battery_bars']);self.assertIsNone(dev['shure']['transmitter_muted'])

    def test_shure_frequency_and_mute_writes_rejected(self):
        b = self.b; b._accept_shure_observation(observation())
        with patch.object(b, '_broker_publish_command') as publish:
            for command in ('set_freq','mute','unmute'):
                with self.assertRaises(HTTPError) as error:
                    self.request('/api/command', {'device_id':'Shure-ULXD4D-192.0.2.5_ch1', 'command':command,
                                                 'value':641.25, 'expected_brand':'Shure'})
                self.assertEqual(error.exception.code, 403)
            publish.assert_not_called()
        self.assertEqual(b._state['commands'], {})

    def test_api_status_scan_body_origin_and_no_network_on_import(self):
        self.assertIsNone(self.b._shure_discovery.thread)
        self.assertFalse(self.request('/api/discovery/shure/status')['enabled'])
        self.assertFalse(self.request('/api/discovery/shure/scan', {})['scanning'])
        self.assertFalse(self.request('/api/discovery/shure/cancel', {})['scanning'])
        with self.assertRaises(HTTPError) as error: self.request('/api/discovery/shure/scan', {'host':'8.8.8.8'})
        self.assertEqual(error.exception.code, 400)
        with self.assertRaises(HTTPError) as error: self.request('/api/discovery/shure/scan', {}, Origin='https://evil.example')
        self.assertEqual(error.exception.code, 403)

    def test_model_only_does_not_create_channel(self):
        self.b._accept_shure_observation(observation(frames=('REP MODEL {ULXD4}',)))
        self.assertEqual(self.b._get_devices_snapshot(), [])

    def test_other_shure_sources_cannot_break_capability_view_with_null_metadata(self):
        for value in (None,[],42,'bad'):
            caps=self.b._device_capabilities({'brand':'Shure','model':'ULXD4','shure':value})
            self.assertFalse(caps['write_frequency']);self.assertFalse(caps['mute'])


if __name__ == '__main__': unittest.main()
