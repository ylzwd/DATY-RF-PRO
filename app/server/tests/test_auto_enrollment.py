"""Development onboarding regression: temp CA/registries and ephemeral TLS only."""
import base64
import concurrent.futures
import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from pairing_test_support import create_tls_fixture
from receiver_enrollment import ReceiverEnrollment, EnrollmentError, AUTO_PROTOCOL
from receiver_pairing import ReceiverPairingPolicy
from tls_support import bind_https, server_context, client_context


def b64(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


class AutoEnrollmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-auto-enrollment-')
        cls.base = Path(cls.temp.name)
        cls.tls = create_tls_fixture(cls.base)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.path = self.base / 'security' / 'receiver-pairings.json'
        self.config = dict(enabled=True, allowed_ips=['127.0.0.1', '192.0.2.102'],
            max_channels=128, max_receivers=64, broker_url='wss://127.0.0.1:8083/mqtt')
        self.path.write_text(json.dumps(dict(version=1, receivers=[], development_enrollment=self.config)), encoding='utf-8')
        self.policy = ReceiverPairingPolicy(self.path)
        self.enrollment = ReceiverEnrollment(self.policy, self.tls)
        self.key = ec.generate_private_key(ec.SECP256R1())

    def body(self, n=1, key=None, **changes):
        point = (key or self.key).public_key().public_numbers()
        body = dict(protocol=AUTO_PROTOCOL, receiver_mac=f'02:00:00:00:00:{n:02X}', brand='DATYaudio', channel_count=8,
            public_key=dict(kty='EC', crv='P-256', x=b64(point.x.to_bytes(32,'big')), y=b64(point.y.to_bytes(32,'big'))))
        return {**body, **changes}

    def proof(self, challenge, key=None):
        raw = (key or self.key).sign(challenge['message'].encode(), ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(raw)
        return dict(challenge_id=challenge['challenge_id'], signature=b64(r.to_bytes(32,'big') + s.to_bytes(32,'big')))

    def login(self, n=1, peer='192.0.2.102', **changes):
        challenge = self.enrollment.challenge(self.body(n, **changes), peer)
        return self.enrollment.complete(self.proof(challenge), peer)

    def test_first_come_group_and_same_mac_reconnect_after_restart(self):
        first, second = self.login(7), self.login(1)
        self.assertEqual((first['group_number'],second['group_number']), (1,2))
        self.enrollment = ReceiverEnrollment(ReceiverPairingPolicy(self.path), self.tls)
        again = self.login(7, peer='127.0.0.1')
        self.assertEqual(again['group_number'],1)
        self.assertEqual(again['receiver_ip'],'127.0.0.1')
        self.assertEqual(again['pairing']['receiver_id'],first['pairing']['receiver_id'])
        self.assertNotEqual(again['pairing']['secret'],first['pairing']['secret'])

    def test_returned_credentials_authenticate_and_all_channels_use_server_group(self):
        result = self.login()
        bundle = result['pairing']
        principal = self.policy.authenticate(bundle['credential_id'],bundle['secret'],bundle['credential_id']+'_auto',result['receiver_ip'])
        for ch in (1,2,4,8,128):
            data = self.policy.validate_payload(principal,'daty/rf/devices/up',dict(channel=ch, group=999))
            self.assertEqual(data['group'],1)
            self.assertEqual(data['group_number'],1)
            self.assertEqual(data['group_source'],'server-fifo-v1')
        stored = self.path.read_text(encoding='utf-8')
        self.assertNotIn(bundle['secret'],stored)
        self.assertNotIn('"d":',stored)

    def test_unapproved_peer_cannot_first_register_or_allocate(self):
        with self.assertRaises(EnrollmentError):
            self.enrollment.challenge(self.body(),'192.0.2.103')
        self.assertEqual(self.policy._load()['receivers'],[])
        self.assertNotIn('receiver_groups',self.policy._load())

    def test_revoked_identity_cannot_reenroll_with_same_or_other_key(self):
        self.login()
        data = self.policy._load()
        data['receivers'][0]['revoked'] = True
        self.path.write_text(json.dumps(data))
        for key in (self.key,ec.generate_private_key(ec.SECP256R1())):
            with self.assertRaises(EnrollmentError):
                self.enrollment.challenge(self.body(key=key),'192.0.2.102')

    def test_wrong_key_cannot_claim_existing_mac(self):
        self.login()
        with self.assertRaises(EnrollmentError):
            self.enrollment.challenge(self.body(key=ec.generate_private_key(ec.SECP256R1())),'192.0.2.102')

    def test_bad_proof_replay_and_wrong_peer_allocate_nothing(self):
        for wrong_peer in (False,True):
            challenge = self.enrollment.challenge(self.body(),'192.0.2.102')
            proof = self.proof(challenge, key=ec.generate_private_key(ec.SECP256R1()) if not wrong_peer else None)
            with self.assertRaises(EnrollmentError):
                self.enrollment.complete(proof,'127.0.0.1' if wrong_peer else '192.0.2.102')
            with self.assertRaises(EnrollmentError):
                self.enrollment.complete(self.proof(challenge),'192.0.2.102')
        self.assertEqual(self.policy._load()['receivers'],[])

    def test_concurrent_approvals_allocate_unique_groups_and_duplicate_mac_same_group(self):
        challenges = [self.enrollment.challenge(self.body(n),'192.0.2.102') for n in (1,2,3,4)]
        self.enrollment.rates.clear()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda c:self.enrollment.complete(self.proof(c),'192.0.2.102'),challenges))
        self.assertEqual(sorted(r['group_number'] for r in results),[1,2,3,4])
        self.assertEqual(len(self.policy._load()['receivers']),4)

    def test_disabling_new_enrollment_preserves_signed_login_not_brand_escalation(self):
        self.login()
        data = self.policy._load(); data['development_enrollment']['enabled'] = False
        self.path.write_text(json.dumps(data))
        self.assertEqual(self.login()['group_number'],1)
        with self.assertRaises(EnrollmentError): self.login(2)
        with self.assertRaises(EnrollmentError): self.login(1,brand='AMSaudio')

    def test_expired_challenge_allocates_nothing(self):
        challenge = self.enrollment.challenge(self.body(),'192.0.2.102')
        self.enrollment.pending[challenge['challenge_id']]['deadline'] = 0
        with self.assertRaises(EnrollmentError): self.enrollment.complete(self.proof(challenge),'192.0.2.102')
        self.assertEqual(self.policy._load()['receivers'],[])

    @unittest.skipUnless(shutil.which('node'), 'Node WebCrypto required')
    def test_real_javascript_webcrypto_p1363_signature_accepted_by_python(self):
        script = r'''
const {webcrypto}=require('node:crypto'),fs=require('node:fs');
(async()=>{
 const keys=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
 process.stdout.write(JSON.stringify(await webcrypto.subtle.exportKey('jwk',keys.publicKey))+'\n');
 const message=JSON.parse(fs.readFileSync(0,'utf8')).message;
 const signature=await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,new TextEncoder().encode(message));
 process.stdout.write(Buffer.from(signature).toString('base64url'));
})().catch(()=>process.exitCode=1);
'''
        process = subprocess.Popen([shutil.which('node'),'-e',script],stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            key = json.loads(process.stdout.readline())
            self.assertNotIn('d',key)
            challenge = self.enrollment.challenge(self.body(public_key=key),'192.0.2.102')
            # JSON escapes LF; Windows text pipes must not translate signing bytes to CRLF.
            signature,errors = process.communicate(json.dumps({'message':challenge['message']}),timeout=10)
            self.assertEqual(process.returncode,0,errors)
            result = self.enrollment.complete(dict(challenge_id=challenge['challenge_id'],signature=signature),'192.0.2.102')
            self.assertEqual(result['group_number'],1)
            self.assertEqual(result['receiver_ip'],'192.0.2.102')
        finally:
            if process.poll() is None: process.kill()
            process.communicate(timeout=5)

    def test_concurrent_same_mac_keeps_one_record_and_one_group(self):
        challenges = [self.enrollment.challenge(self.body(),'192.0.2.102') for _ in range(2)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda c:self.enrollment.complete(self.proof(c),'192.0.2.102'), challenges))
        self.assertEqual([r['group_number'] for r in results], [1,1])
        self.assertEqual(len(self.policy._load()['receivers']),1)

    def test_config_changes_between_challenge_and_finish_are_rechecked(self):
        challenge = self.enrollment.challenge(self.body(),'192.0.2.102')
        data = self.policy._load(); data['development_enrollment']['enabled'] = False
        self.path.write_text(json.dumps(data))
        with self.assertRaises(EnrollmentError):
            self.enrollment.complete(self.proof(challenge),'192.0.2.102')
        self.assertEqual(self.policy._load()['receivers'],[])

    def test_rate_limits_and_channel_limits(self):
        with self.assertRaises(EnrollmentError): self.login(channel_count=129)
        for _ in range(11): self.enrollment.challenge(self.body(),'192.0.2.102')
        with self.assertRaises(EnrollmentError) as caught:
            self.enrollment.challenge(self.body(),'192.0.2.102')
        self.assertEqual(caught.exception.status,429)

    def test_actual_https_enrollment_cors_peer_and_operator_boundary(self):
        previous = os.environ.get('DATY_DB_PATH')
        os.environ['DATY_DB_PATH'] = str(self.base/'isolated.sqlite3')
        try:
            spec = importlib.util.spec_from_file_location('auto_enrollment_bridge_test',ROOT/'mqtt-bridge.py')
            bridge = importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
        finally:
            if previous is None: os.environ.pop('DATY_DB_PATH',None)
            else: os.environ['DATY_DB_PATH'] = previous
        from http.server import ThreadingHTTPServer
        http = bind_https(ThreadingHTTPServer,('127.0.0.1',0),bridge.DatyAPIHandler,server_context(self.tls))
        http.receiver_enrollment = self.enrollment
        worker = threading.Thread(target=http.serve_forever,daemon=True);worker.start()
        try:
            def post(route,body,origin='http://localhost:8081',**headers):
                request = Request(f'https://127.0.0.1:{http.server_port}'+route,
                    data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':origin,**headers})
                try:
                    with urlopen(request,context=client_context(self.tls),timeout=3) as response:
                        return response.status,json.loads(response.read()),response.headers
                except HTTPError as error: return error.code,json.loads(error.read()),error.headers
            status,challenge,headers = post('/api/receivers/challenge',self.body(),**{'X-Forwarded-For':'192.0.2.99'})
            self.assertEqual(status,200)
            self.assertEqual(headers['Access-Control-Allow-Origin'],'http://localhost:8081')
            status,result,_ = post('/api/receivers/enroll',self.proof(challenge))
            self.assertEqual(status,200)
            self.assertEqual(result['receiver_ip'],'127.0.0.1')
            self.assertEqual(result['group_number'],1)
            self.assertEqual(post('/api/receivers/challenge',self.body(),origin='https://evil.invalid')[0],403)
            self.assertEqual(post('/api/command',dict(command='mute',channel_number=1))[0],403)
        finally:
            http.shutdown();http.server_close();worker.join(3)
            bridge._close_database()


if __name__ == '__main__': unittest.main(verbosity=2)
