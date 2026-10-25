"""DATY health evidence from isolated SCP sockets; no production resources."""
import time
import unittest
from unittest.mock import patch

from shure_active_discovery import ShureDiscovery
from shure_metering import ShureMeterSession
from test_shure_metering import MeterPeer, receiver, wait_for


class Health(unittest.TestCase):
    def manager(self, peer, on_update=None, **options):
        manager = ShureDiscovery(on_update or (lambda _: None), auto_scan=False,
            probe=lambda *a, **k: {**receiver(), 'ts': time.time()})
        manager.metering = True
        def factory(raw, callback):
            return ShureMeterSession(raw, callback, port=peer.port,
                **{'metadata_interval': .1, 'stale_after': .15, 'retry_delay': 1, **options})
        with patch('shure_active_discovery.ShureMeterSession', factory):
            manager._visit('127.0.0.1')
        self.addCleanup(manager.stop)
        return manager

    def test_real_stream_stale_metadata_and_disconnection_are_distinct(self):
        peer = MeterPeer(); self.addCleanup(peer.close)
        manager = self.manager(peer)
        wait_for(lambda: manager.health()['monitoring']['active'] == 1)
        health = manager.health()
        self.assertEqual(health['provider'], 'daty-scp')
        self.assertEqual(health['receivers_online'], 1)
        self.assertEqual(health['state'], 'ready')
        # The peer stops SAMPLE but keeps answering metadata; device presence
        # remains true while the telemetry session becomes stale.
        wait_for(lambda: manager.health()['monitoring']['stale'] == 1)
        self.assertEqual(manager.health()['receivers_online'], 1)
        peer.close()
        wait_for(lambda: manager.health()['monitoring']['recovering'] == 1)
        wait_for(lambda: manager.health()['last_error'] is not None)
        health = manager.health()
        self.assertEqual(health['receivers_online'], 0)
        self.assertEqual(health['monitoring'], {'total': 1, 'active': 0, 'recovering': 1, 'stale': 0})
        self.assertIsNotNone(health['last_error'])
        self.assertLess(time.time() - manager.receivers['127.0.0.1']['ts'], 15,
            'A cached discovery timestamp must not override a closed socket')
        manager.stop()
        health = manager.health()
        self.assertEqual(health['state'], 'stopped')
        self.assertEqual(health['receivers_online'], 0)
        self.assertEqual(health['monitoring'], {'total': 1, 'active': 0, 'recovering': 0, 'stale': 0})
        self.assertFalse(any(cmd.startswith('SET ') and ' METER_RATE ' not in cmd for cmd in peer.commands))

    def test_unverified_tcp_never_counts_as_online(self):
        peer = MeterPeer(model='AD4D'); self.addCleanup(peer.close)
        manager = self.manager(peer)
        wait_for(lambda: manager.health()['last_error'] is not None)
        self.assertEqual(manager.health()['receivers_online'], 0)
        self.assertEqual(manager.health()['monitoring']['active'], 0)
        self.assertEqual(manager.health()['monitoring']['recovering'], 1)
        self.assertFalse(any(cmd.startswith('SET ') for cmd in peer.commands))

    def test_disconnected_callback_already_observes_offline_health(self):
        peer = MeterPeer(); self.addCleanup(peer.close)
        observed = []
        def update(raw):
            if any(value.get('meter_state') == 'disconnected' for value in raw['channels'].values()):
                observed.append(manager.health())
        manager = self.manager(peer, on_update=update)
        wait_for(lambda: manager.health()['monitoring']['active'] == 1)
        peer.close()
        wait_for(lambda: len(observed) > 0)
        self.assertEqual(observed[0]['receivers_online'], 0)
        self.assertEqual(observed[0]['monitoring']['active'], 0)
        self.assertEqual(observed[0]['monitoring']['recovering'], 1)

    def test_stream_timeout_recovers_only_after_new_valid_reports(self):
        peer = MeterPeer(); self.addCleanup(peer.close)
        manager = self.manager(peer, retry_delay=.3)
        wait_for(lambda: manager.health()['monitoring']['active'] == 1)
        wait_for(lambda: manager.health()['last_error'] is not None, 5)
        self.assertEqual(manager.health()['receivers_online'], 0)
        wait_for(lambda: manager.health()['monitoring']['active'] == 1)
        self.assertGreaterEqual(peer.connections, 2)
        self.assertEqual(manager.health()['receivers_online'], 1)
        self.assertIsNone(manager.health()['last_error'])

    def test_polled_receiver_requires_fresh_observation_and_enabled_plugin(self):
        manager = ShureDiscovery(lambda _: None, auto_scan=False, probe=lambda *a, **k: None)
        raw = receiver()
        manager.receivers[raw['ip']] = {**raw, 'ts': time.time() - 20}
        self.assertEqual(manager.health()['receivers_online'], 0)
        manager.receivers[raw['ip']]['ts'] = time.time() + 100
        self.assertEqual(manager.health()['receivers_online'], 0)
        manager.receivers[raw['ip']]['ts'] = time.time()
        self.assertEqual(manager.health()['receivers_online'], 1)
        manager.enabled = False
        self.assertEqual(manager.health()['state'], 'disabled')
        self.assertEqual(manager.health()['receivers_online'], 0)


if __name__ == '__main__':
    unittest.main()
