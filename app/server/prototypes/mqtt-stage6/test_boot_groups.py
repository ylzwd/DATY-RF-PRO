"""Isolated boot grouping, enrollment durability and authentication regressions."""
import concurrent.futures
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
sys.path[:0]=[str(HERE),str(ROOT),str(ROOT/'tests')]
from m6_groups import RuntimeGroupPolicy,RuntimeEnrollment
from receiver_pairing import PairingError
from receiver_enrollment import EnrollmentError
from pairing_test_support import PairingFixture,create_tls_fixture
from test_auto_enrollment import AutoEnrollmentTests
from cryptography.hazmat.primitives.asymmetric import ec


class BootGroups(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='daty-boot-groups-')
        self.addCleanup(self.temp.cleanup)
        self.fixture=PairingFixture(self.temp.name,tuple(f'02:00:00:00:00:{n:02X}' for n in range(1,17)))
        data=json.loads(self.fixture.path.read_text())
        data['receiver_groups']={x.receiver_mac:100+i for i,x in enumerate(self.fixture.credentials)}
        self.fixture.path.write_text(json.dumps(data))
        self.before=self.fixture.path.read_bytes()
        self.policy=RuntimeGroupPolicy(self.fixture.path,boot_id='first')
        self.fixture.policy=self.policy

    def test_first_arrival_ignores_old_map_and_reboot_reverses_order(self):
        p1,p2=self.fixture.principal(0),self.fixture.principal(1)
        self.assertIsNone(p1['group_number'])
        self.assertEqual(self.policy.ensure_group(p2),1)
        self.assertEqual(self.policy.ensure_group(p1),2)
        self.assertEqual(self.policy.ensure_group(self.fixture.principal(1)),1)
        fresh=RuntimeGroupPolicy(self.fixture.path,boot_id='next')
        self.assertEqual(fresh.ensure_group(p1),1)
        self.assertEqual(fresh.ensure_group(p2),2)
        self.assertEqual(self.fixture.path.read_bytes(),self.before)

    def test_simultaneous_registrations_unique_duplicate_identity_reuses(self):
        principals=[self.fixture.principal(n) for n in range(16)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            values=list(pool.map(self.policy.ensure_group,principals*3))
        self.assertEqual(set(values),set(range(1,17)))
        for n in range(16):self.assertEqual(len(set(values[n::16])),1)
        self.assertEqual(self.fixture.path.read_bytes(),self.before)

    def test_revoked_or_bad_auth_does_not_consume_number(self):
        principal=self.fixture.principal()
        self.fixture.records[0]['revoked']=True;self.fixture.save()
        with self.assertRaises(PairingError):self.policy.ensure_group(principal)
        c=self.fixture.credentials[1]
        with self.assertRaises(PairingError):self.policy.authenticate(c.username,'bad',c.client_id,'127.0.0.1')
        self.assertEqual(self.policy.ensure_group(self.fixture.principal(1)),1)

    def test_packet_views_are_immutable_and_payload_group_is_server_owned(self):
        first=self.fixture.principal()
        self.policy.ensure_group(first)
        before=self.policy._load()
        self.policy.ensure_group(self.fixture.principal(1))
        self.assertEqual(len(before['receiver_groups']),1)
        self.assertEqual(len(self.policy._load()['receiver_groups']),2)
        for ch in range(1,51):
            payload=self.policy.validate_payload(first,'daty/rf/devices/up',{'channel':ch,'group':999,'group_number':999})
            self.assertEqual((payload['group'],payload['group_number']),(1,1))
            self.assertEqual(payload['receiver_id'],first['receiver_id'])

    def test_mixed_transports_share_order_and_reconnect_without_credentials(self):
        p1,p2=self.fixture.principal(0),self.fixture.principal(1)
        self.assertEqual(self.policy.ensure_group(p1),1)
        view=self.policy._load()
        self.assertEqual(self.policy.ensure_adapter_group('shure-scp','ULXD-endpoint'),2)
        self.assertEqual(self.policy.ensure_group(p2),3)
        self.assertEqual(self.policy.ensure_adapter_group('other-brand','receiver'),4)
        self.assertEqual(self.policy.ensure_adapter_group('shure-scp','ULXD-endpoint'),2)
        self.assertEqual(self.policy.ensure_group(p1),1)
        self.assertEqual(self.policy.status()['assigned_receivers'],4)
        self.assertEqual(view['receiver_groups'],{p1['receiver_mac']:1})
        self.assertEqual(self.policy._load()['receiver_groups'],{p1['receiver_mac']:1,p2['receiver_mac']:3})
        payload=self.policy.validate_payload(p2,'daty/rf/devices/up',{'channel':1,'group_number':2})
        self.assertEqual(payload['group_number'],3)
        fresh=RuntimeGroupPolicy(self.fixture.path,boot_id='reboot')
        self.assertEqual(fresh.status()['assigned_receivers'],0)
        self.assertEqual(fresh.ensure_adapter_group('shure-scp','ULXD-endpoint'),1)
        self.assertEqual(fresh.ensure_group(p1),2)
        self.assertEqual(self.fixture.path.read_bytes(),self.before)

    def test_parallel_mixed_registrations_are_unique_and_namespaced(self):
        principals=[self.fixture.principal(n) for n in range(16)]
        tasks=[('paired',p) for p in principals]+[('adapter',p) for p in principals]
        def register(task):
            kind,p=task
            return (self.policy.ensure_group(p) if kind=='paired' else
                    self.policy.ensure_adapter_group('shure-scp',p['receiver_mac']))
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            groups=list(pool.map(register,tasks*3))
        self.assertEqual(set(groups),set(range(1,33)))
        for n in range(32):self.assertEqual(len(set(groups[n::32])),1)
        self.assertEqual(len(self.policy._load()['receiver_groups']),16)
        self.assertEqual(self.fixture.path.read_bytes(),self.before)

    def test_mixed_capacity_is_shared_and_invalid_identity_does_not_allocate(self):
        for adapter,rid in [('', 'id'),('shure',None),('shure',' '*2),('shure','x'*257)]:
            with self.assertRaises(PairingError):self.policy.ensure_adapter_group(adapter,rid)
        self.assertEqual(self.policy.status()['assigned_receivers'],0)
        self.assertEqual(self.policy.ensure_group(self.fixture.principal()),1)
        for n in range(2,16385):
            self.assertEqual(self.policy.ensure_adapter_group('fixture',str(n)),n)
        with self.assertRaises(PairingError):self.policy.ensure_group(self.fixture.principal(1))
        with self.assertRaises(PairingError):self.policy.ensure_adapter_group('fixture','extra')
        self.assertEqual(self.policy.ensure_adapter_group('fixture','2'),2)
        self.assertEqual(self.policy.ensure_group(self.fixture.principal()),1)
        self.assertEqual(self.policy.status()['assigned_receivers'],16384)


class BootEnrollment(unittest.TestCase):
    body=AutoEnrollmentTests.body
    proof=AutoEnrollmentTests.proof
    login=AutoEnrollmentTests.login

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='daty-boot-enrollment-')
        self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.tls=create_tls_fixture(self.base)
        AutoEnrollmentTests.setUp(self)
        registry=json.loads(self.path.read_text())
        self.legacy={'02:00:00:00:00:77':13}
        registry['receiver_groups']=self.legacy
        self.path.write_text(json.dumps(registry))
        self.policy=RuntimeGroupPolicy(self.path,boot_id='first')
        self.enrollment=RuntimeEnrollment(self.policy,self.tls)

    def test_signed_registration_and_mqtt_reconnect_share_one_number(self):
        first=self.login(7);second=self.login(1)
        self.assertEqual([first['group_number'],second['group_number']],[1,2])
        bundle=first['pairing']
        p=self.policy.authenticate(bundle['credential_id'],bundle['secret'],bundle['credential_id']+'_mqtt','127.0.0.1')
        self.assertEqual(self.policy.ensure_group(p),1)
        again=self.login(7)
        self.assertEqual(again['group_number'],1)
        self.assertFalse(self.policy.is_active(p))  # A renewed secret revokes the previous one.
        self.assertEqual(json.loads(self.path.read_text())['receiver_groups'],self.legacy)
        self.policy=RuntimeGroupPolicy(self.path,boot_id='next')
        self.enrollment=RuntimeEnrollment(self.policy,self.tls)
        self.assertEqual(self.login(1)['group_number'],1)
        self.assertEqual(self.login(7)['group_number'],2)

    def test_challenge_bad_proof_and_failed_commit_do_not_allocate(self):
        challenge=self.enrollment.challenge(self.body(),'192.0.2.102')
        self.assertEqual(self.policy.status()['assigned_receivers'],0)
        with self.assertRaises(EnrollmentError):
            self.enrollment.complete(self.proof(challenge,key=ec.generate_private_key(ec.SECP256R1())),'192.0.2.102')
        challenge=self.enrollment.challenge(self.body(),'192.0.2.102')
        before=self.path.read_bytes()
        with patch('receiver_enrollment.save_registry',side_effect=OSError('isolated write failure')):
            with self.assertRaises(OSError):self.enrollment.complete(self.proof(challenge),'192.0.2.102')
        self.assertEqual(self.path.read_bytes(),before)
        self.assertEqual(self.policy.status()['assigned_receivers'],0)
        self.assertEqual(self.login(2)['group_number'],1)

    def test_parallel_signed_registrations_are_contiguous(self):
        challenges=[self.enrollment.challenge(self.body(n),'192.0.2.102') for n in range(1,5)]
        proofs=[self.proof(c) for c in challenges]
        self.enrollment.rates.clear()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            replies=list(pool.map(lambda p:self.enrollment.complete(p,'192.0.2.102'),proofs))
        self.assertEqual(sorted(x['group_number'] for x in replies),[1,2,3,4])
        self.assertEqual(json.loads(self.path.read_text())['receiver_groups'],self.legacy)


if __name__=='__main__':unittest.main(verbosity=2)
