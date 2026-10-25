"""Isolated restart/reconnect tests; no production network or database."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from shure_active_discovery import ShureDiscovery
from shure_known_receivers import KnownReceivers, SCHEMA, local_targets

IP='192.0.2.107'
MAC='00:0E:DD:AD:31:A3'
NIC=[{'address':'192.0.2.16','prefix':24}]

def receiver():
    return {'ip':IP,'receiver_ip':IP,'receiver_id':'Shure-ULXD4-'+IP,'model':'ULXD4','protocol_verified':True,
            'settings':{'receiver_mac':MAC,'network_ip':IP},'ts':time.time(),
            'channels':{'1':{'channel_number':1,'frequency_khz':640000,'muted':False}}}

def wait_for(predicate, seconds=2):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if predicate():return
        time.sleep(.005)
    raise AssertionError('Fixture did not reach expected state')

class ReconnectTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'shure-known-receivers.json'

    def seed(self):
        store=KnownReceivers(self.path);self.assertTrue(store.remember(receiver()));return store

    def manager(self, callback, probe, **kwargs):
        manager=ShureDiscovery(callback,probe=probe,interfaces=lambda:NIC,auto_scan=False,poll_interval=.02,known_path=self.path,**kwargs)
        def stop():
            manager.stop()
            if manager.thread:manager.thread.join(2)
        self.addCleanup(stop)
        return manager

    def test_verified_peer_survives_manager_restart_without_saved_channels_or_scan(self):
        first=self.manager(lambda x:None,lambda host,**kw:receiver());first._visit(IP)
        saved=json.loads(self.path.read_bytes());self.assertEqual(saved,{'schema':SCHEMA,'receivers':[{'ip':IP,'model':'ULXD4','mac':MAC}]})
        updates=[];hosts=[]
        def probe(host,**kw):hosts.append(host);return receiver()
        second=self.manager(updates.append,probe)
        self.assertEqual(second.snapshot()['count'],0)  # Disk identity never means online.
        second.request_scan=lambda: self.fail('Restart must not trigger a subnet scan')
        second.start();wait_for(lambda:len(updates)>0)
        self.assertEqual(set(hosts),{IP});self.assertEqual(second.snapshot()['count'],1)
        self.assertEqual(second.snapshot()['generation'],0)
        self.assertNotIn('group_number',updates[0]);self.assertNotIn('command',updates[0])

    def test_offline_at_boot_is_retried_and_online_only_after_actual_reply(self):
        self.seed();online=threading.Event();updates=[];calls=[]
        def probe(host,**kw):calls.append(host);return receiver() if online.is_set() else None
        manager=self.manager(updates.append,probe);manager.start();wait_for(lambda:len(calls)>=2)
        self.assertEqual(updates,[]);self.assertEqual(manager.snapshot()['count'],0)
        online.set();wait_for(lambda:len(updates)>0);self.assertEqual(manager.snapshot()['count'],1)

    def test_wrong_reported_network_address_is_rejected(self):
        for field,value in [('network_ip','192.0.2.108')]:
            self.seed();updates=[];r=receiver();r['settings'][field]=value
            manager=self.manager(updates.append,lambda host,**kw:copy.deepcopy(r));manager._visit(IP)
            self.assertEqual(updates,[]);self.assertEqual(manager.snapshot()['count'],0)
            self.assertEqual(manager.snapshot()['reconnect']['identity_conflicts'],[IP])
            self.assertEqual(KnownReceivers(self.path).targets()[IP]['mac'],MAC)

    def test_replacement_at_same_ip_is_online_with_its_own_identity(self):
        self.seed();updates=[];r=receiver();r['settings']['receiver_mac']='00:0E:DD:AD:31:A4'
        manager=self.manager(updates.append,lambda host,**kw:copy.deepcopy(r));manager._visit(IP)
        self.assertEqual(manager.snapshot()['count'],1)
        self.assertEqual(updates[0]['receiver_id'],'Shure-ULXD4-000EDDAD31A4')
        self.assertEqual(KnownReceivers(self.path).targets()[IP]['mac'],'00:0E:DD:AD:31:A4')
        restarted=self.manager(updates.append,lambda host,**kw:copy.deepcopy(r));restarted._visit(IP)
        self.assertEqual(updates[-1]['receiver_id'],updates[0]['receiver_id'])

    def test_saved_peer_outside_current_nic_is_not_probed(self):
        self.seed();calls=[]
        manager=self.manager(lambda x:None,lambda host,**kw:calls.append(host))
        manager.interfaces=lambda:[{'address':'192.0.2.16','prefix':24}]
        manager.start();wait_for(lambda:manager.snapshot()['reconnect']['error'] is not None)
        self.assertEqual(calls,[]);self.assertEqual(manager.snapshot()['reconnect']['eligible_count'],0)

    def test_expired_receiver_reconnect_candidate_is_not_lost_after_one_hour(self):
        self.seed();calls=[];manager=self.manager(lambda x:None,lambda host,**kw:calls.append(host))
        old=receiver();old['ts']=time.time()-4000;manager.receivers[IP]=old
        manager.start();wait_for(lambda:len(calls)>=2)
        self.assertNotIn(IP,manager.receivers);self.assertEqual(set(calls),{IP})

    def test_store_failure_does_not_drop_live_update_and_retries_atomically(self):
        updates=[];manager=self.manager(updates.append,lambda host,**kw:receiver())
        with patch('shure_known_receivers.os.replace',side_effect=PermissionError('fixture')):
            manager._visit(IP)
        self.assertEqual(len(updates),1);self.assertEqual(manager.snapshot()['count'],1)
        self.assertIsNotNone(manager.snapshot()['reconnect']['error']);self.assertFalse(self.path.exists())
        self.assertTrue(manager.known.flush());self.assertIsNone(manager.known.error)
        self.assertEqual(KnownReceivers(self.path).targets()[IP]['mac'],MAC)
        self.assertEqual(list(self.path.parent.glob('*.tmp')),[])

    def test_corrupt_and_oversized_registry_never_crashes_or_overwrites_file(self):
        for raw in (b'{invalid',b' '*32769,json.dumps({'schema':SCHEMA,'receivers':[{'ip':IP,'model':'ULXD4','mac':MAC,'muted':True}]}).encode()):
            self.path.write_bytes(raw);store=KnownReceivers(self.path)
            self.assertEqual(store.targets(),{});self.assertTrue(store.load_failed)
            self.assertFalse(store.remember(receiver()));self.assertEqual(self.path.read_bytes(),raw)

    def test_partial_metadata_and_unverified_models_are_not_saved(self):
        store=KnownReceivers(self.path)
        for change in ({'settings':{}},{'protocol_verified':False},{'model':'FAKE'}):
            self.assertFalse(store.remember({**receiver(),**change}))
        self.assertFalse(self.path.exists());self.assertEqual(store.targets(),{})

    def test_unchanged_identity_does_not_rewrite_registry_per_poll(self):
        store=self.seed()
        with patch('shure_known_receivers.os.replace',side_effect=AssertionError('Unneeded write')):
            for _ in range(5):self.assertTrue(store.remember(receiver()))

    def test_only_direct_subnet_known_hosts_not_local_broadcast_or_entire_sweep(self):
        self.assertEqual(local_targets(NIC,[IP,'192.0.2.16','192.0.2.255','192.0.2.0','192.0.2.1']),[IP])
        self.assertEqual(local_targets([{'address':'192.0.2.16','prefix':16}],['192.169.2.107']),['192.169.2.107'])

if __name__=='__main__':unittest.main()
