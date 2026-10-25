"""Real temporary Mosquitto/TLS/WSS, original SQLite/archive/enrollment domains."""
import argparse
import asyncio
import base64
import hashlib
import importlib.util
import json
import os
import queue
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
import zipfile

HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[1]
sys.path[:0]=[str(HERE),str(ROOT),str(ROOT/'tests'),*[str(HERE.parent/f'mqtt-stage{n}') for n in (4,3,2,1)]]
if '--paho-root' in sys.argv:sys.path.insert(0,sys.argv[sys.argv.index('--paho-root')+1])
from pairing_test_support import create_tls_fixture,connect_packet
from tls_support import server_context,client_context
from security_storage import secure_directory
from broker_client import BrokerClient
from mqtt_wire import packet,utf,string,number,WSReader
from receiver_gateway import ReceiverGateway
from receiver_pairing import ReceiverPairingPolicy
from receiver_enrollment import ReceiverEnrollment
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from m5_contract import *
from m5_files import FileStore,hash_bytes
from m5_service import FileService,LargeRepository,LargeDataService,EnrollmentService
from m5_gateway import RpcGateway
from server_archive import ArchiveService
from unified_schema import validate_schema
from unified_browser_import import FORMAT
import unified_database as db
import websockets
from websockets.exceptions import ConnectionClosed,InvalidStatus

OPTIONS=None
def oid():return uuid.uuid4().hex
def b64(raw):return base64.b64encode(raw).decode()
def b64url(raw):return base64.urlsafe_b64encode(raw).decode().rstrip('=')
async def eventually(fn,timeout=8):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if fn():return
        await asyncio.sleep(.01)
    raise AssertionError('Expected isolated state not reached')

class UI:
    def __init__(self,case,mode='files',ip='127.0.0.1'):
        self.case,self.mode,self.ip=case,mode,ip;self.pid=1
    async def start(self):
        self.ws=await websockets.connect(self.case.uris[self.mode],ssl=client_context(self.case.tls),subprotocols=['mqtt'],
            origin='http://127.0.0.1:8081' if self.mode=='enrollment' else 'https://127.0.0.1:8080',local_addr=(self.ip,0))
        await self.ws.send(packet(0x10,utf('MQTT')+b'\x05\x02\0\x0a\0'+utf('')))
        self.reader=WSReader(self.ws);h,b=await self.reader.read();assert h==0x20
        self.sid=b[-36:].decode();assert self.sid.startswith('m5')
        await self.ws.send(packet(0x82,b'\0\x01\0'+utf(topic(self.mode,'reply'))+b'\x01'))
        assert (await self.reader.read())[0]==0x90
        hello=await self.message();self.boot=hello['boot_id'];return self
    async def message(self):
        while True:
            h,b=await self.reader.read()
            if h in (0x40,0xd0):continue
            assert h>>4==3
            t,pos=string(b);assert t==topic(self.mode,'reply')
            if h&6:
                await self.ws.send(packet(0x40,b[pos:pos+2]));pos+=2
            size,pos=number(b,pos);result=json.loads(b[pos+size:]);assert result['client_session_id']==self.sid
            return result
    def request(self,m,b):return {'schema':schema(self.mode),'server_id':SERVER,'boot_id':self.boot,'client_session_id':self.sid,
        'request_id':oid(),'method':m,'deadline_at_ms':int(time.time()*1000)+15000,'body':b}
    async def send(self,r,retain=False):
        self.pid=(self.pid+1)%65000+1
        await self.ws.send(packet(0x33 if retain else 0x32,utf(topic(self.mode,'request'))+self.pid.to_bytes(2,'big')+b'\0'+encoded(r).encode()))
    async def call(self,m,b=None):
        r=self.request(m,b or {});await self.send(r)
        response=await asyncio.wait_for(self.message(),20)
        assert response['request_id']==r['request_id']
        return response
    async def close(self):await self.ws.close()

class Integration(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='daty-mqtt-stage5-');cls.addClassCleanup(cls.temp.cleanup)
        cls.base=Path(cls.temp.name)
        for n in (1,4,5):(cls.base/f'.daty-mqtt-stage{n}-fixture').write_text('isolated-only')
        cls.tls=create_tls_fixture(cls.base);cls.material=json.loads(cls.tls.read_text('utf-8'))
        security=cls.base/'security';secure_directory(security)
        cls.secrets={f'{mode}-{role}':secrets.token_urlsafe(32) for mode in ('files','enrollment') for role in ('business','gateway')}
        passwd=security/'passwords';passwd.write_text(''.join(f'{u}:{p}\n' for u,p in cls.secrets.items()))
        exe=Path(OPTIONS.broker).resolve()
        subprocess.run([str(exe.with_name('mosquitto_passwd.exe')),'-U',str(passwd)],check=True,capture_output=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        acl=security/'acl';acl.write_text(''.join(f'user {m}-business\ntopic read {prefix(m)}/+/request\ntopic write {prefix(m)}/+/reply\nuser {m}-gateway\npattern write {prefix(m)}/%c/request\npattern read {prefix(m)}/%c/reply\n' for m in ('files','enrollment')))
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));cls.tcp=sock.getsockname()[1]
        conf=cls.base/'broker.conf';conf.write_text('\n'.join(['allow_anonymous false',f'password_file {passwd.as_posix()}',f'acl_file {acl.as_posix()}',
            'persistence false','retain_available false','max_packet_size 1048576','max_queued_messages 32','max_inflight_messages 8','log_type error','log_type warning',
            f'listener {cls.tcp} 127.0.0.1','protocol mqtt',f'certfile {Path(cls.material["certificate_file"]).as_posix()}',
            f'keyfile {Path(cls.material["private_key_file"]).as_posix()}','tls_version tlsv1.2'])+'\n')
        cls.log=open(Path(OPTIONS.output)/'broker.log','wb');cls.addClassCleanup(cls.log.close)
        cls.process=subprocess.Popen([str(exe),'-c',str(conf)],stdout=cls.log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));cls.addClassCleanup(cls.stop_broker)
        for _ in range(100):
            if cls.process.poll() is not None:raise RuntimeError('Broker startup failed')
            try:
                with socket.create_connection(('127.0.0.1',cls.tcp),timeout=.1):break
            except OSError:time.sleep(.05)
        cls.evidence=[]
    @classmethod
    def stop_broker(cls):
        if cls.process.poll() is None:cls.process.terminate();cls.process.wait(timeout=5)

    async def asyncSetUp(self):
        asyncio.get_running_loop().set_debug(False)
        self.cleaned=False;self.addAsyncCleanup(self.cleanup)
        self.case=self.base/self._testMethodName;self.case.mkdir();self.uis=[];self.gateways={};self.businesses={};self.uris={}
        spec=importlib.util.spec_from_file_location('m5_'+self._testMethodName,ROOT/'mqtt-bridge.py');self.b=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'DATY_DB_PATH':str(self.case/'business.sqlite3'),'DATY_ARCHIVE_PATH':str(self.case/'archives')}):spec.loader.exec_module(self.b)
        self.b._log=lambda *a:None
        self.repo=LargeRepository(self.b,fixture_root=self.base);self.data=LargeDataService(self.repo,discovery=SimpleNamespace(snapshot=lambda:{}))
        self.store=FileStore(self.case/'staging',fixture_root=self.base);self.archive=ArchiveService(self.case/'business.sqlite3',self.case/'archives')
        self.files=FileService(self.store,self.archive,self.data)
        self.registry=self.case/'security/receiver-pairings.json';self.registry.parent.mkdir()
        self.registry.write_text(json.dumps({'version':1,'receivers':[],'receiver_groups':{'02:00:00:00:00:01':11,'02:00:00:00:00:02':4},
            'development_enrollment':{'enabled':True,'allowed_ips':['127.0.0.1','127.0.0.2','127.0.0.3'],'max_channels':128,'max_receivers':64,'broker_url':'wss://127.0.0.1:8083/mqtt'}}))
        self.policy=ReceiverPairingPolicy(self.registry);self.enrollment=EnrollmentService(ReceiverEnrollment(self.policy,self.tls))
        for mode,service in (('files',self.files),('enrollment',self.enrollment)):
            business=await asyncio.to_thread(BrokerClient,port=self.tcp,ca=self.material['ca_file'],username=mode+'-business',password=self.secrets[mode+'-business']);self.businesses[mode]=business
            gateway=RpcGateway(service,business,broker_port=self.tcp,broker_tls=client_context(self.tls),username=mode+'-gateway',password=self.secrets[mode+'-gateway'],fixture_root=self.base,mode=mode)
            self.gateways[mode]=gateway;p=await gateway.start(server_context(self.tls));self.uris[mode]=f'wss://127.0.0.1:{p}/mqtt-{mode}'
        self.ui=await self.new_ui()
        with self.repo.connection() as c:self.epoch=db.status(c)['epoch']
    async def new_ui(self,mode='files',ip='127.0.0.1'):
        ui=await UI(self,mode,ip).start();self.uis.append(ui);return ui
    async def cleanup(self):
        if self.cleaned:return
        self.cleaned=True
        for ui in getattr(self,'uis',[]):await ui.close()
        for gateway in getattr(self,'gateways',{}).values():await gateway.close()
        if hasattr(self,'rx'):await self.rx.close()
        for business in getattr(self,'businesses',{}).values():await asyncio.to_thread(business.close)
        if hasattr(self,'archive'):await eventually(lambda:not self.archive.active)
        if hasattr(self,'store'):self.store.close()
        if hasattr(self,'repo'):self.repo.close()
        if hasattr(self,'b'):
            if self.b._unified_runtime:self.b._unified_runtime.stop()
            self.b._close_database()
    async def asyncTearDown(self):
        await self.cleanup()
        c=sqlite3.connect(self.case/'business.sqlite3')
        try:
            self.assertEqual(c.execute('PRAGMA integrity_check').fetchall(),[('ok',)]);self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(),[]);validate_schema(c)
            self.assertEqual(c.execute('SELECT count(*) FROM live_commands').fetchone()[0],0)
            self.evidence.append({'test':self._testMethodName,'integrity':'ok','foreign_keys':'ok','live_commands':0})
        finally:c.close()
    def sql(self,q,args=()):
        c=sqlite3.connect(self.case/'business.sqlite3')
        try:return c.execute(q,args).fetchall()
        finally:c.close()
    async def rpc(self,m,b=None,ui=None):
        result=await (ui or self.ui).call(m,b);self.assertTrue(result.get('ok'),result);return result['result']
    async def error(self,m,b,code,ui=None):
        result=await (ui or self.ui).call(m,b);self.assertFalse(result['ok'],result);self.assertEqual(result['error'],code,result)
    async def upload(self,raw,media='text/plain'):
        id=oid();sha=hash_bytes(raw)
        await self.rpc('uploads.begin',{'operation_id':id,'bytes':len(raw),'sha256':sha,'media_type':media})
        for offset in range(0,len(raw),CHUNK):
            part=raw[offset:offset+CHUNK];await self.rpc('uploads.chunk',{'upload_id':id,'offset':offset,'data':b64(part),'sha256':hash_bytes(part)})
        await self.rpc('uploads.finish',{'upload_id':id,'sha256':sha});return {'upload_id':id,'sha256':sha}
    async def invoke(self,m,b):return await self.rpc('data.invoke',await self.upload(encoded({'method':m,'body':b}).encode(),'application/json'))
    async def download(self,desc):
        raw=bytearray()
        for offset in range(0,desc['bytes'],CHUNK):
            part=await self.rpc('downloads.chunk',{'download_id':desc['id'],'offset':offset,'sha256':desc['sha256']});data=base64.b64decode(part['data'])
            self.assertEqual(hash_bytes(data),part['sha256']);raw.extend(data)
        self.assertEqual(hash_bytes(raw),desc['sha256']);self.assertEqual(len(raw),desc['bytes']);return bytes(raw)
    async def resolve(self,value):return json.loads(await self.download(value['transfer'])) if 'transfer' in value else value
    async def export(self,raw):
        ref=await self.upload(raw);id=oid()
        result=await self.rpc('exports.create',{'operation_id':id,**ref,'fileName':'扫描与报告.txt','mimeType':'text/plain','source':'isolated-test'})
        return id,result['result']
    def key_body(self,n=1,key=None):
        key=key or ec.generate_private_key(ec.SECP256R1());p=key.public_key().public_numbers()
        return key,{'protocol':'daty-auto-pair-v1','receiver_mac':f'02:00:00:00:00:{n:02X}','brand':'DATYaudio','channel_count':50,
            'public_key':{'kty':'EC','crv':'P-256','x':b64url(p.x.to_bytes(32,'big')),'y':b64url(p.y.to_bytes(32,'big'))}}
    def proof(self,c,key):
        r,s=decode_dss_signature(key.sign(c['message'].encode(),ec.ECDSA(hashes.SHA256())))
        return {'challenge_id':c['challenge_id'],'signature':b64url(r.to_bytes(32,'big')+s.to_bytes(32,'big'))}
    async def enroll(self,ui,n=1,key=None):
        key,b=self.key_body(n,key);c=await self.rpc('receivers.challenge',b,ui);result=await self.rpc('receivers.enroll',self.proof(c,key),ui)
        return key,result

    async def test_a_file_export_exact_bytes_and_archive_restore(self):
        raw=('\ufeff频率,AF\r\n640.250,0\r\n690.000,-40\r\n'*9000).encode();id,item=await self.export(raw)
        self.assertEqual(item['sha256'],hash_bytes(raw));self.assertEqual((self.archive._folder('exports',id)/'content').read_bytes(),raw)
        opened=await self.rpc('downloads.open',{'operation_id':oid(),'category':'exports','id':id,'sha256':item['sha256']})
        self.assertEqual(await self.download(opened['result']),raw)
        aid=oid();await self.rpc('archives.create',{'operation_id':aid});await eventually(lambda:self.archive.get('archives',aid)['status']=='saved')
        archive=await self.rpc('archives.get',{'id':aid});download=await self.rpc('downloads.open',{'operation_id':oid(),'category':'archives','id':aid,'sha256':archive['sha256']})
        data=await self.download(download['result']);path=self.case/'restore.zip';path.write_bytes(data)
        with zipfile.ZipFile(path) as z:
            self.assertEqual(z.read('exports/'+id+'/'+item['fileName']),raw)
            restored=self.case/'restored.sqlite3';restored.write_bytes(z.read('database.sqlite3'))
        c=sqlite3.connect(restored)
        try:validate_schema(c);self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
        finally:c.close()

    async def test_b_chunks_duplicate_conflict_partial_and_corrupt(self):
        raw=b'A'*(CHUNK+3);id=oid();body={'operation_id':id,'bytes':len(raw),'sha256':hash_bytes(raw),'media_type':'text/plain'}
        await self.rpc('uploads.begin',body);await self.error('uploads.begin',{**body,'bytes':2},'TRANSFER_INTENT_CONFLICT')
        part={'upload_id':id,'offset':0,'data':b64(raw[:CHUNK]),'sha256':hash_bytes(raw[:CHUNK])}
        await self.rpc('uploads.chunk',part);await self.rpc('uploads.chunk',part)
        await self.error('uploads.chunk',{**part,'data':b64(b'B'*CHUNK),'sha256':hash_bytes(b'B'*CHUNK)},'CHUNK_CONFLICT')
        await self.error('uploads.finish',{'upload_id':id,'sha256':body['sha256']},'UPLOAD_INCOMPLETE')
        await self.rpc('uploads.chunk',{'upload_id':id,'offset':CHUNK,'data':b64(b'AAA'),'sha256':hash_bytes(b'AAA')})
        (self.store.folder('uploads',id)/'0.chunk').write_bytes(b'B'*CHUNK)
        await self.error('uploads.finish',{'upload_id':id,'sha256':body['sha256']},'STORED_CHUNK_CORRUPT')

    async def test_c_reconnect_resume_and_restart_preserves_progress(self):
        raw=b'x'*(CHUNK*2);id=oid();await self.rpc('uploads.begin',{'operation_id':id,'bytes':len(raw),'sha256':hash_bytes(raw),'media_type':'text/plain'})
        part={'upload_id':id,'offset':0,'data':b64(raw[:CHUNK]),'sha256':hash_bytes(raw[:CHUNK])};await self.rpc('uploads.chunk',part)
        await self.ui.close();self.ui=await self.new_ui()
        self.store.close();self.store=FileStore(self.case/'staging',fixture_root=self.base);self.files.store=self.store
        status=await self.rpc('uploads.status',{'id':id});self.assertEqual(status['offset'],CHUNK)
        await self.rpc('uploads.chunk',{**part,'offset':CHUNK});await self.rpc('uploads.finish',{'upload_id':id,'sha256':hash_bytes(raw)})
        self.assertEqual(self.store.bytes_for({'upload_id':id,'sha256':hash_bytes(raw)},'network:127.0.0.1'),raw)

    async def test_d_crash_between_chunk_and_manifest_requires_exact_resume(self):
        raw=b'A'*CHUNK;id=oid();await self.rpc('uploads.begin',{'operation_id':id,'bytes':CHUNK,'sha256':hash_bytes(raw),'media_type':'text/plain'})
        part={'upload_id':id,'offset':0,'data':b64(raw),'sha256':hash_bytes(raw)}
        self.store.after_chunk=lambda:(_ for _ in ()).throw(OSError('isolated crash boundary'))
        await self.error('uploads.chunk',part,'OUTCOME_UNKNOWN_QUERY_ONLY');self.store.after_chunk=lambda:None
        self.assertEqual((await self.rpc('uploads.status',{'id':id}))['offset'],0)
        await self.error('uploads.chunk',{**part,'data':b64(b'B'*CHUNK),'sha256':hash_bytes(b'B'*CHUNK)},'CHUNK_CONFLICT')
        await self.rpc('uploads.chunk',part);await self.rpc('uploads.finish',{'upload_id':id,'sha256':hash_bytes(raw)})

    async def test_e_limits_owner_cancel_and_generation(self):
        raw=b'abc';id=oid();body={'operation_id':id,'bytes':3,'sha256':hash_bytes(raw),'media_type':'text/plain'}
        await self.error('uploads.begin',{**body,'bytes':MAX_UPLOAD+1},'INVALID_INTEGER');await self.rpc('uploads.begin',body)
        other=await self.new_ui(ip='127.0.0.2');await self.error('uploads.status',{'id':id},'TRANSFER_OWNER_MISMATCH',other)
        await self.rpc('uploads.cancel',{'upload_id':id});await self.error('uploads.chunk',{'upload_id':id,'offset':0,'data':b64(raw),'sha256':hash_bytes(raw)},'UPLOAD_NOT_WRITABLE')
        await self.error('uploads.status',{'id':'../outside'},'INVALID_IDENTIFIER')
        request=self.ui.request('uploads.status',{'id':id});request['boot_id']=oid();await self.ui.send(request);self.assertEqual((await self.ui.message())['error'],'SERVER_BOOT_CHANGED')

    async def test_f_large_data_write_receipts_and_conflict(self):
        payload={'text':'频率报告'*90000,'zero':0,'unknown':None}
        body={'operation_id':oid(),'epoch':self.epoch,'kind':'legacy_snapshots','id':'large-fixture','expected_revision':0,
            'value':{'sourceOrigin':'stage5-fixture','sourceKey':'large','payload':payload}}
        first=await self.resolve(await self.invoke('database.write',body));self.assertEqual(first['status'],200)
        second=await self.resolve(await self.invoke('database.write',body));self.assertEqual(first,second)
        query=await self.resolve(await self.invoke('operations.get',{'operation_id':body['operation_id']}));self.assertEqual(query['body']['operation']['state'],'committed')
        self.assertEqual(query['body']['operation']['result']['body']['resource']['value']['payload'],payload)
        body['value']['payload']={'changed':1};conflict=await self.invoke('database.write',body);self.assertEqual(conflict['status'],409)
        self.assertEqual(self.sql("SELECT count(*) FROM db_resource_versions WHERE kind='legacy_snapshots' AND id='large-fixture'"),[(1,)])
        aid=oid();await self.rpc('archives.create',{'operation_id':aid});await eventually(lambda:self.archive.get('archives',aid)['status']=='saved')
        with zipfile.ZipFile(self.archive._folder('archives',aid)/'archive.zip') as z:
            restored=self.case/'large-restored.sqlite3';restored.write_bytes(z.read('database.sqlite3'))
        c=sqlite3.connect(restored)
        try:
            validate_schema(c)
            self.assertEqual(c.execute("SELECT count(*) FROM db_resource_versions WHERE id='large-fixture'").fetchone()[0],1)
            self.assertGreater(c.execute("SELECT count(*) FROM db_legacy_snapshots WHERE source_key LIKE 'mqtt4-operation:%'").fetchone()[0],0)
        finally:c.close()

    async def test_g_import_digest_confirmation_and_changed_preview(self):
        backup={'format':FORMAT,'version':1,'sourceOrigin':'https://127.0.0.1:8080','createdAt':'2026-09-17T00:00:00.000Z','values':{'daty_alert_sound_v1':'{"enabled":true}'}}
        preview=await self.invoke('database.import.preview',{'backup':backup});self.assertTrue(preview['body']['ready'])
        b={'operation_id':oid(),'epoch':self.epoch,'confirmed':True,'previewDigest':preview['body']['previewDigest'],'backup':backup}
        bad=await self.invoke('database.import.commit',{**b,'confirmed':False});self.assertGreaterEqual(bad['status'],400)
        b['operation_id']=oid();result=await self.invoke('database.import.commit',b);self.assertEqual(result['status'],200)
        again=await self.invoke('database.import.commit',b);self.assertEqual(result,again)
        changed=await self.invoke('database.import.commit',{**b,'operation_id':oid()});self.assertEqual(changed['status'],409)
        self.assertEqual(self.sql("SELECT revision FROM biz_settings WHERE id='alert_sound'"),[(1,)])

    async def test_h_cleanup_fixed_scope_and_download_snapshot(self):
        id,item=await self.export(b'first');opened=await self.rpc('downloads.open',{'operation_id':oid(),'category':'exports','id':id,'sha256':item['sha256']})
        plan=await self.rpc('cleanups.prepare',{'operation_id':oid(),'selection':{'category':'exports'}});plan=plan['result']
        later,_=await self.export(b'later')
        committed=await self.rpc('cleanups.commit',{'operation_id':oid(),'cleanup_id':plan['id'],'confirmed':True,'planSha256':plan['planSha256']})
        self.assertEqual(committed['result']['deletedCount'],1);self.assertEqual(self.archive.get('exports',later)['status'],'saved')
        self.assertEqual(await self.download(opened['result']),b'first')
        await self.rpc('downloads.close',{'download_id':opened['result']['id']})
        await self.error('downloads.chunk',{'download_id':opened['result']['id'],'offset':0,'sha256':item['sha256']},'DOWNLOAD_CHANGED')

    async def test_i_export_duplicate_and_lost_reply_query_only(self):
        ref=await self.upload(b'exact');b={'operation_id':oid(),**ref,'fileName':'x.txt','mimeType':'text/plain','source':'fixture'}
        first=await self.rpc('exports.create',b);again=await self.rpc('exports.create',b);self.assertEqual(first,again)
        await self.error('exports.create',{**b,'fileName':'y.txt'},'OPERATION_ID_CONFLICT')
        await self.ui.close();self.ui=await self.new_ui();query=await self.rpc('file.operations.get',{'operation_id':b['operation_id']});self.assertEqual(query['result']['sha256'],ref['sha256'])

    async def test_j_enrollment_two_receivers_keep_group_key_and_ip_change(self):
        a=await self.new_ui('enrollment','127.0.0.2');b=await self.new_ui('enrollment','127.0.0.3')
        key,first=await self.enroll(a,1);_,second=await self.enroll(b,2)
        self.assertEqual((first['group_number'],second['group_number']),(11,4))
        renewed=await self.enroll(b,1,key);renewed=renewed[1]
        for name in ('receiver_id','receiver_mac','credential_id','ca_sha256','broker_url'):self.assertEqual(first['pairing'][name],renewed['pairing'][name])
        self.assertEqual(renewed['group_number'],11);self.assertEqual(renewed['receiver_ip'],'127.0.0.3');self.assertNotEqual(first['pairing']['secret'],renewed['pairing']['secret'])
        self.assertNotIn(renewed['pairing']['secret'],self.registry.read_text())
        p=renewed['pairing'];principal=self.policy.authenticate(p['credential_id'],p['secret'],p['credential_id']+'_fixture','127.0.0.3')
        self.assertEqual(self.policy.validate_payload(principal,'daty/rf/devices/up',{'channel':1,'group':999})['group_number'],11)
        with self.assertRaises(Exception):self.policy.authenticate(p['credential_id'],first['pairing']['secret'],p['credential_id']+'_old','127.0.0.2')

    async def test_k_wrong_peer_key_replay_and_revoke(self):
        ui=await self.new_ui('enrollment');key,b=self.key_body();c=await self.rpc('receivers.challenge',b,ui)
        other=await self.new_ui('enrollment','127.0.0.2');await self.error('receivers.enroll',self.proof(c,key),'CHALLENGE_CONNECTION_CHANGED',other)
        proof=self.proof(c,key);await self.rpc('receivers.enroll',proof,ui);await self.error('receivers.enroll',proof,'CHALLENGE_CONNECTION_CHANGED',ui)
        _,wrong=self.key_body();await self.error('receivers.challenge',wrong,'RECEIVER_IDENTITY_DENIED',ui)
        denied=await self.new_ui('enrollment','127.0.0.4');_,fresh=self.key_body(3);await self.error('receivers.challenge',fresh,'ENROLLMENT_PEER_DENIED',denied)
        registry=json.loads(self.registry.read_text());registry['receivers'][0]['revoked']=True;self.registry.write_text(json.dumps(registry))
        await self.error('receivers.challenge',b,'RECEIVER_IDENTITY_DENIED',ui)

    async def test_l_disable_initial_still_signed_renewal_and_expired_challenge(self):
        ui=await self.new_ui('enrollment');key,first=await self.enroll(ui)
        registry=json.loads(self.registry.read_text());registry['development_enrollment']['enabled']=False;self.registry.write_text(json.dumps(registry))
        _,again=await self.enroll(ui,key=key);self.assertEqual(first['group_number'],again['group_number'])
        _,b=self.key_body(3);await self.error('receivers.challenge',b,'ENROLLMENT_PEER_DENIED',ui)
        _,body=self.key_body(key=key);c=await self.rpc('receivers.challenge',body,ui);self.enrollment.pending[c['challenge_id']]['end']=0
        await self.error('receivers.enroll',self.proof(c,key),'CHALLENGE_CONNECTION_CHANGED',ui)

    async def test_m_actual_receiver_wss_accepts_renewed_credentials(self):
        ui=await self.new_ui('enrollment','127.0.0.2');key,first=await self.enroll(ui);_,renewed=await self.enroll(ui,key=key)
        events=[]
        async def publish(topic,event):events.append(event)
        self.rx=ReceiverGateway(self.policy,SimpleNamespace(publish=publish),server_id='stage5-rx',fixture_root=self.base)
        port=await self.rx.start(server_context(self.tls));p=renewed['pairing']
        cred=SimpleNamespace(username=p['credential_id'],secret=p['secret'],client_id=p['credential_id']+'_fixture')
        async with websockets.connect(f'wss://127.0.0.1:{port}/mqtt',ssl=client_context(self.tls),subprotocols=['mqtt'],local_addr=('127.0.0.2',0)) as ws:
            await ws.send(connect_packet(cred));self.assertEqual(await ws.recv(),b'\x20\x02\0\0')
            payload={'type':'device_list','receiver_mac':p['receiver_mac'],'receiver_id':p['receiver_id'],'group':999,'devices':[{'channel':1,'brand':'DATYaudio','model':'RF PRO','freq_mhz':640.25,'muted':False}]}
            await ws.send(packet(0x30,utf('daty/rf/devices/register')+json.dumps(payload).encode()));await eventually(lambda:bool(events))
            self.assertEqual(events[0]['source']['group_number'],11);self.assertEqual(events[0]['source']['peer_ip'],'127.0.0.2')

    async def test_n_origin_retained_topic_and_private_broker_acl(self):
        for mode in ('files','enrollment'):
            with self.assertRaises(InvalidStatus):await websockets.connect(self.uris[mode],ssl=client_context(self.tls),subprotocols=['mqtt'],origin='https://evil.invalid')
        rogue=await asyncio.to_thread(BrokerClient,port=self.tcp,ca=self.material['ca_file'],username='files-business',password=self.secrets['files-business'])
        try:
            # Mosquitto can grant SUBACK while its read ACL filters all deliveries.
            await asyncio.to_thread(rogue.subscribe,prefix('enrollment')+'/#')
            ui=await self.new_ui('enrollment');await self.enroll(ui)
            with self.assertRaises(queue.Empty):await asyncio.to_thread(rogue.receive,.2)
            reason=await asyncio.to_thread(rogue.publish_sync,prefix('enrollment')+'/forged/reply',{'not':'a credential'})
            self.assertGreaterEqual(reason,128)
        finally:await asyncio.to_thread(rogue.close)
        ui=await self.new_ui();await ui.send(ui.request('archives.list',{}),retain=True)
        with self.assertRaises(ConnectionClosed):await ui.message()
        ui=await self.new_ui();await ui.ws.send(packet(0x82,b'\0\x02\0'+utf('#')+b'\x01'))
        with self.assertRaises(ConnectionClosed):await ui.message()

    async def test_o_deadline_and_disk_failure_never_ready(self):
        id=oid();body={'operation_id':id,'bytes':1,'sha256':hash_bytes(b'A'),'media_type':'text/plain'}
        request=self.ui.request('uploads.begin',body);request['deadline_at_ms']=0;await self.ui.send(request);self.assertEqual((await self.ui.message())['error'],'REQUEST_EXPIRED')
        self.assertFalse(self.store.folder('uploads',id).exists())
        await self.rpc('uploads.begin',body)
        with patch('m5_files.os.fsync',side_effect=OSError('fixture disk failure')):
            await self.error('uploads.chunk',{'upload_id':id,'offset':0,'sha256':hash_bytes(b'A'),'data':b64(b'A')},'OUTCOME_UNKNOWN_QUERY_ONLY')
        self.assertEqual((await self.rpc('uploads.status',{'id':id}))['offset'],0)

    async def test_p_mqttjs_original_auto_pair_and_file_ports(self):
        result=await asyncio.to_thread(subprocess.run,[OPTIONS.node,str(HERE/'mqttjs-stage5-live.cjs'),self.uris['files'],self.uris['enrollment'],
            self.material['ca_file'],str(ROOT.parent/'FAshe/vendor/mqtt-5.10.4/mqtt.upstream.min.js'),OPTIONS.ws_bundle],capture_output=True,text=True,timeout=40,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        data=json.loads(result.stdout.strip());self.assertTrue(data['ok']);Path(OPTIONS.output,'mqttjs-live.json').write_text(json.dumps(data,indent=2))

    async def test_q_real_process_exit_before_chunk_and_final_manifest(self):
        raw=b'C'*CHUNK;id=oid();await self.rpc('uploads.begin',{'operation_id':id,'bytes':CHUNK,'sha256':hash_bytes(raw),'media_type':'text/plain'})
        part={'upload_id':id,'offset':0,'data':b64(raw),'sha256':hash_bytes(raw)}
        for phase,code in (('chunk',21),('finish',22)):
            self.store.close()
            try:
                result=await asyncio.to_thread(subprocess.run,[sys.executable,str(HERE/'crash_fixture.py'),str(self.base),str(self.case/'staging'),id,phase],
                    capture_output=True,text=True,timeout=10,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                self.assertEqual(result.returncode,code,result.stdout+result.stderr)
            finally:
                self.store=FileStore(self.case/'staging',fixture_root=self.base);self.files.store=self.store
            status=await self.rpc('uploads.status',{'id':id});self.assertEqual(status['state'],'uploading')
            if phase=='chunk':self.assertEqual(status['offset'],0);await self.rpc('uploads.chunk',part)
            else:self.assertEqual(status['offset'],CHUNK)
        await self.rpc('uploads.finish',{'upload_id':id,'sha256':hash_bytes(raw)})
        self.assertEqual(self.store.bytes_for({'upload_id':id,'sha256':hash_bytes(raw)},'network:127.0.0.1'),raw)

    async def test_r_secrets_excluded_from_business_and_archive_and_no_http_write(self):
        from m5_http_entry import handler_for
        from http.server import ThreadingHTTPServer
        import http.client
        import threading
        ui=await self.new_ui('enrollment');_,result=await self.enroll(ui);secret=result['pairing']['secret'].encode()
        # Exercise the actual candidate HTTPS route, which must refuse before body parsing.
        server=ThreadingHTTPServer(('127.0.0.1',0),handler_for(self.b));server.socket=server_context(self.tls).wrap_socket(server.socket,server_side=True)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def call(path):
            c=http.client.HTTPSConnection('127.0.0.1',server.server_port,context=client_context(self.tls))
            try:c.request('POST',path,b'{}',{'Content-Type':'application/json'});r=c.getresponse();return r.status,r.read()
            finally:c.close()
        try:
            for path in ('/api/receivers/challenge','/api/receivers/enroll','/api/database/exports','/api/database/archives','/api/database/archive-cleanups'):
                code,body=await asyncio.to_thread(call,path);self.assertEqual(code,409)
        finally:await asyncio.to_thread(server.shutdown);server.server_close();thread.join(2)
        aid=oid();await self.rpc('archives.create',{'operation_id':aid});await eventually(lambda:self.archive.get('archives',aid)['status']=='saved')
        with zipfile.ZipFile(self.archive._folder('archives',aid)/'archive.zip') as archive:
            for name in archive.namelist():self.assertNotIn(secret,archive.read(name))
        for path in self.case.rglob('*'):
            if path.is_file() and path.suffix!='.lock':self.assertNotIn(secret,path.read_bytes())

    async def test_s_concurrent_chunks_and_corrupt_download(self):
        raw=b'Z'*CHUNK;id=oid();await self.rpc('uploads.begin',{'operation_id':id,'bytes':CHUNK,'sha256':hash_bytes(raw),'media_type':'text/plain'})
        b={'upload_id':id,'offset':0,'data':b64(raw),'sha256':hash_bytes(raw)};other=await self.new_ui()
        a,c=await asyncio.gather(self.rpc('uploads.chunk',b),self.rpc('uploads.chunk',b,other));self.assertEqual(a,c)
        self.assertEqual(len(self.store.read('uploads',id,'network:127.0.0.1')['chunks']),1)
        eid,item=await self.export(b'original');opened=await self.rpc('downloads.open',{'operation_id':oid(),'category':'exports','id':eid,'sha256':item['sha256']})
        desc=opened['result'];(self.store.folder('downloads',desc['id'])/'content').write_bytes(b'changed!')
        await self.error('downloads.chunk',{'download_id':desc['id'],'offset':0,'sha256':desc['sha256']},'DOWNLOAD_CORRUPT')

    async def test_t_empty_upload_hash_mismatch_and_link_rejection(self):
        ref=await self.upload(b'');self.assertEqual(self.store.bytes_for(ref,'network:127.0.0.1'),b'')
        id=oid();await self.rpc('uploads.begin',{'operation_id':id,'bytes':1,'sha256':hash_bytes(b'B'),'media_type':'text/plain'})
        await self.rpc('uploads.chunk',{'upload_id':id,'offset':0,'data':b64(b'A'),'sha256':hash_bytes(b'A')})
        await self.error('uploads.finish',{'upload_id':id,'sha256':hash_bytes(b'B')},'FILE_DIGEST_MISMATCH')
        path=self.store.folder('uploads',id)/'0.chunk';os.link(path,self.case/'hardlink-fixture')
        await self.error('uploads.finish',{'upload_id':id,'sha256':hash_bytes(b'B')},'HARDLINK_FORBIDDEN')

    async def test_z_broker_loss_no_file_replay(self):
        id,item=await self.export(b'broker-loss');await asyncio.to_thread(self.stop_broker)
        await eventually(lambda:not self.files.accepting);self.assertEqual(self.archive.get('exports',id)['sha256'],item['sha256'])

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--broker',required=True);ap.add_argument('--paho-root',required=True);ap.add_argument('--output',required=True)
    ap.add_argument('--node',default='node');ap.add_argument('--ws-bundle');ap.add_argument('--case');OPTIONS=ap.parse_args();Path(OPTIONS.output).mkdir(parents=True,exist_ok=True)
    suite=unittest.TestSuite([Integration(OPTIONS.case)]) if OPTIONS.case else unittest.defaultTestLoader.loadTestsFromTestCase(Integration)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    Path(OPTIONS.output,'result.json').write_text(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'success':result.wasSuccessful(),
        'broker_stopped':Integration.process.poll() is not None,'temporary_material_removed':not Integration.base.exists(),'evidence':Integration.evidence},indent=2))
    sys.exit(0 if result.wasSuccessful() else 1)
