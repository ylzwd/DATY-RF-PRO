"""Actual isolated Broker/TLS/WSS/SQLite. Never imports a production DB."""
import argparse
import asyncio
import copy
import http.client
from http.server import ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
import uuid
import zipfile

HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[1]
sys.path[:0]=[str(HERE),str(ROOT),str(ROOT/'tests'),str(HERE.parent/'mqtt-stage3'),str(HERE.parent/'mqtt-stage2'),str(HERE.parent/'mqtt-stage1')]
if '--paho-root' in sys.argv:sys.path.insert(0,sys.argv[sys.argv.index('--paho-root')+1])
import test_stage3 as support
import unified_database as db
from unified_schema import validate_schema
from shure_active_discovery import ShureDiscovery
from test_shure_active_discovery import observation
from test_unified_browser_import import FORMAT
from data_contract import SERVER,SCHEMA,DataError
from data_repository import Repository,PREFIX as OP_PREFIX
from data_service import DataService
from data_gateway import RpcGateway,PREFIX,REQUEST,REPLY
from data_http_entry import handler_for
from broker_client import BrokerClient
from tls_support import client_context,server_context
from mqtt_wire import packet,utf,WSReader
import websockets

OPTIONS=None
support.SERVER,support.SCHEMA,support.REQUEST,support.REPLY,support.PREFIX=SERVER,SCHEMA,REQUEST,REPLY,PREFIX


class UI(support.UI):
    async def start(self,ip='127.0.0.1'):
        self.ws=await websockets.connect(self.case.uri,ssl=client_context(self.case.tls),subprotocols=['mqtt'],
            origin='https://127.0.0.1:8080',local_addr=(ip,0))
        await self.ws.send(packet(0x10,utf('MQTT')+b'\x05\x02\0\x0a\0'+utf('')))
        self.reader=WSReader(self.ws);header,body=await self.reader.read();assert header==0x20
        self.sid=body[-36:].decode();assert self.sid.startswith('dat-')
        await self.ws.send(packet(0x82,b'\0\x01\0'+utf(REPLY)+b'\x01'))
        assert (await self.reader.read())[0]==0x90
        hello=await self.message();assert hello['kind']=='hello';self.boot=hello['boot_id']
        self.task=asyncio.create_task(self.run());return self
    def request(self,body,method='database.status',deadline=5000):
        return super().request(body,method,deadline)


class Integration(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        support.OPTIONS=OPTIONS
        support.Integration.setUpClass.__func__(cls)
        (cls.base/'.daty-mqtt-stage4-fixture').write_text('isolated-only')
    stop_broker=classmethod(support.Integration.stop_broker.__func__)

    async def asyncSetUp(self):
        self.cleaned=False
        self.addAsyncCleanup(self.cleanup)
        self.case=self.base/self._testMethodName;self.case.mkdir()
        spec=importlib.util.spec_from_file_location('m4_'+self._testMethodName,ROOT/'mqtt-bridge.py')
        self.b=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'DATY_DB_PATH':str(self.case/'business.sqlite3'),'DATY_ARCHIVE_PATH':str(self.case/'archives')}):
            spec.loader.exec_module(self.b)
        self.b._log=lambda *a:None
        self.probes=[];self.probe_gate=threading.Event();self.probe_gate.set()
        def probe(host,stop):
            assert host=='127.0.0.2'
            self.probes.append(host)
            while not self.probe_gate.wait(.01):
                if stop.is_set():return None
            return observation(ip=host)
        self.discovery=ShureDiscovery(self.b._accept_shure_observation,interfaces=lambda:[],probe=probe,enabled=True)
        self.b._shure_discovery=self.discovery
        self.target_patch=patch('shure_active_discovery.scan_targets',lambda *a:(['127.0.0.2'],[{'isolated':True}]))
        self.target_patch.start()
        self.repo=Repository(self.b,fixture_root=self.base)
        self.service=DataService(self.repo,discovery=self.discovery);await self.service.start()
        self.business=await asyncio.to_thread(BrokerClient,port=self.tcp,ca=self.material['ca_file'],username='business',password=self.secrets['business'])
        self.gateway=RpcGateway(self.service,self.business,broker_port=self.tcp,broker_tls=client_context(self.tls),
            username='gateway',password=self.secrets['gateway'],fixture_root=self.base)
        self.port=await self.gateway.start(server_context(self.tls));self.uri=f'wss://127.0.0.1:{self.port}/mqtt-data'
        self.http=ThreadingHTTPServer(('127.0.0.1',0),handler_for(self.b))
        self.http.socket=server_context(self.tls).wrap_socket(self.http.socket,server_side=True)
        self.http_thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.http_thread.start()
        self.uis=[await UI(self).start()]
        self.epoch=(await self.rpc('database.status'))['body']['epoch']

    async def cleanup(self):
        if self.cleaned:return
        self.cleaned=True
        if hasattr(self,'probe_gate'):self.probe_gate.set()
        if hasattr(self,'discovery'):self.discovery.stop()
        for ui in getattr(self,'uis',[]):await ui.close()
        if hasattr(self,'gateway'):await self.gateway.close()
        if hasattr(self,'service'):await self.service.close()
        if hasattr(self,'business'):await asyncio.to_thread(self.business.close)
        if hasattr(self,'http'):
            await asyncio.to_thread(self.http.shutdown);self.http.server_close();self.http_thread.join(2)
        if hasattr(self,'repo'):self.repo.close()
        if hasattr(self,'discovery'):await support.eventually(lambda:not self.discovery.busy)
        if hasattr(self,'b'):
            runtime=getattr(self.b,'_unified_runtime',None)
            if runtime is not None:runtime.stop()
            self.b._close_database()
        if hasattr(self,'target_patch'):self.target_patch.stop()

    async def asyncTearDown(self):
        await self.cleanup()
        with sqlite3.connect(self.case/'business.sqlite3') as c:
            assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
            assert c.execute('PRAGMA foreign_key_check').fetchall()==[]
            validate_schema(c)
            self.evidence.append({'test':self._testMethodName,'operations':c.execute("SELECT COUNT(DISTINCT source_key) FROM db_legacy_snapshots WHERE source_key LIKE 'mqtt4-operation:%'").fetchone()[0],
                'receiver_commands':c.execute('SELECT COUNT(*) FROM live_commands').fetchone()[0],
                'discovery_probe_calls':len(self.probes)})
        c.close()

    async def wire(self,method,body=None,ui=None):
        ui=ui or self.uis[0];result=await ui.call(ui.request(body or {},method))
        if result.get('ok') and result['result']['status']>=400:result['error']=result['result']['body']['code']
        return result
    async def rpc(self,method,body=None,status=200,ui=None):
        result=await self.wire(method,body,ui)
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['result']['status'],status,result)
        return result['result']
    def op(self,**body):return {'operation_id':uuid.uuid4().hex,'epoch':self.epoch,**body}
    def resource(self,id='alert_sound',value=None,revision=0,kind='settings'):
        return self.op(kind=kind,id=id,expected_revision=revision,value={'enabled':True} if value is None else value)
    def sql(self,query,args=()):
        c=sqlite3.connect(self.case/'business.sqlite3')
        try:return c.execute(query,args).fetchall()
        finally:c.close()
    def https(self,path,body=None):
        conn=http.client.HTTPSConnection('127.0.0.1',self.http.server_port,context=client_context(self.tls),timeout=5)
        try:
            data=json.dumps(body) if body is not None else None
            conn.request('POST' if data else 'GET',path,data,{'Origin':'https://127.0.0.1:8080','Content-Type':'application/json'})
            response=conn.getresponse();return response.status,json.loads(response.read())
        finally:conn.close()

    async def test_a_commit_readback_operation_and_https_parity(self):
        body=self.resource();result=await self.rpc('database.write',body)
        self.assertEqual(self.sql("SELECT revision,deleted FROM biz_settings WHERE id='alert_sound'"),[(1,0)])
        query=await self.rpc('database.operations.get',{'operation_id':body['operation_id']})
        self.assertEqual(query['body']['operation']['resource'],result['body']['resource'])
        status,http=await asyncio.to_thread(self.https,'/api/database/resources/settings/alert_sound')
        mqtt=await self.rpc('database.resources.get',{'kind':'settings','id':'alert_sound'})
        self.assertEqual(status,200);self.assertEqual(mqtt['body'],http)
        self.assertEqual(self.sql('PRAGMA synchronous'),[(2,)])

    async def test_b_duplicate_two_clients_and_changed_intent(self):
        second=await UI(self).start();self.uis.append(second);body=self.resource()
        results=await asyncio.gather(self.rpc('database.write',body),self.rpc('database.write',body,ui=second))
        self.assertEqual(results[0],results[1]);self.assertEqual(self.sql("SELECT count(*) FROM db_audit WHERE kind='settings'"),[(1,)])
        bad=copy.deepcopy(body);bad['value']={'enabled':False}
        self.assertEqual((await self.wire('database.write',bad))['error'],'OPERATION_ID_CONFLICT')
        request=self.uis[0].request(self.resource('alert_sound',{'enabled':False},1),'database.write')
        await self.uis[0].call(request);request['body']=self.resource('alert_sound',{'enabled':True},2)
        self.assertEqual((await self.uis[0].call(request))['result']['body']['code'],'REQUEST_ID_CONFLICT')

    async def test_c_parallel_conflict_preserves_winner_and_rejected_query(self):
        a=self.resource();b=self.resource(value={'enabled':False})
        results=await asyncio.gather(self.wire('database.write',a),self.wire('database.write',b))
        self.assertEqual(sorted(x['result']['status'] for x in results),[200,409])
        loser=b if results[1]['result']['status']==409 else a
        receipt=await self.rpc('operations.get',{'operation_id':loser['operation_id']})
        self.assertEqual(receipt['body']['operation']['state'],'rejected')
        self.assertEqual(self.sql("SELECT revision FROM biz_settings WHERE id='alert_sound'"),[(1,)])

    async def test_d_atomic_batch_rolls_back_first_write_on_second_failure(self):
        first={'kind':'settings','id':'alert_sound','expected_revision':0,'value':{'enabled':True}}
        bad={'kind':'settings','id':'alert_thresholds','expected_revision':0,'value':{'invalid':1}}
        body=self.op(writes=[first,bad]);result=await self.wire('database.batch',body)
        self.assertEqual(result['result']['status'],400,result)
        self.assertEqual(self.sql('SELECT count(*) FROM biz_settings'),[(0,)])
        self.assertEqual(self.sql('SELECT count(*) FROM db_batches'),[(0,)])

    async def test_e_alert_205_clear_scope_tombstones_and_versions(self):
        def alert(i):return {'kind':'alerts','id':'alert-'+str(i),'expected_revision':0,'value':{
            'archiveId':'alert-'+str(i),'deviceId':'rx-ch1','metric':'af','firstSeen':1000+i,'lastSeen':2000+i,
            'endedAt':3000+i,'archiveState':'ended','level':'critical','value':0,'threshold':-5,'msg':'AF overloaded',
            'groupNumber':4,'receiverIp':'127.0.0.2','receiverBrand':'DATYaudio','receiverModel':'RF PRO'}}
        items=[alert(i) for i in range(205)]
        for start in (0,200):await self.rpc('database.batch',self.op(writes=items[start:start+200]))
        await self.rpc('database.write',self.op(**alert(300)))
        for start in (0,200):
            rows=[{'kind':'alerts','id':x['id'],'expected_revision':1,'deleted':True,'value':None} for x in items[start:start+200]]
            await self.rpc('database.batch',self.op(writes=rows))
        self.assertEqual(self.sql('SELECT deleted,count(*) FROM biz_alerts GROUP BY deleted'),[(0,1),(1,205)])
        self.assertEqual(self.sql("SELECT count(*) FROM db_resource_versions WHERE kind='alerts'"),[(411,)])
        # A concurrently changed selected row prevents the whole stale clear batch.
        x=alert(301);await self.rpc('database.write',self.op(**x));x['expected_revision']=1;x['value']['msg']='updated'
        await self.rpc('database.write',self.op(**x))
        result=await self.rpc('database.batch',self.op(writes=[{'kind':'alerts','id':'alert-300','expected_revision':1,'deleted':True,'value':None},
            {'kind':'alerts','id':'alert-301','expected_revision':1,'deleted':True,'value':None}]),status=409)
        self.assertEqual(result['body']['code'],'RESOURCE_REVISION_CONFLICT')
        self.assertEqual(self.sql("SELECT deleted FROM biz_alerts WHERE id='alert-300'"),[(0,)])

    async def test_f_project_history_draft_run_and_timeline_atomic_queries(self):
        project=self.op(id='p4',name='Stage4',data={'unknown':None,'zero':0},devices=[],expected_revision=0)
        await self.rpc('projects.save',project);await self.rpc('projects.save',project)
        await self.rpc('projects.get',{'id':'p4'})
        draft=self.op(projectId='p4',fields={'plannerStart':'640','plannerEnd':'690'},expected_draft_id=None)
        await self.rpc('database.draft.save',draft)
        await self.rpc('database.draft.save',self.op(projectId='p4',fields={'plannerStart':'650'},expected_draft_id=None),status=409)
        self.assertEqual((await self.rpc('database.draft.get',{'project_id':'p4'}))['body']['draft']['value']['payload']['fields'],draft['fields'])
        run=self.op(project_id='p4',input={'range':[640000,690000]},result={'assigned':0},baseline=None)
        await self.rpc('planning.run.create',run);await self.rpc('planning.run.create',run)
        event=self.op(event_type='planning.deployment',summary='fixture',details={'actual':None,'level':0},project_id='p4')
        await self.rpc('timeline.append',event);await self.rpc('timeline.append',event)
        self.assertEqual(self.sql('SELECT count(*) FROM coordination_runs'),[(1,)])
        mqtt=await self.rpc('timeline.list',{'project_id':'p4','limit':200})
        _,http=await asyncio.to_thread(self.https,'/api/timeline?project_id=p4&limit=200')
        self.assertEqual(mqtt['body'],http)
        receipt=await self.rpc('operations.get',{'operation_id':run['operation_id']});self.assertEqual(receipt['body']['operation']['state'],'committed')

    async def test_g_scan_source_pagination_is_snapshot_pinned(self):
        def scan(id,name='Fixture'):
            return self.resource(id,{'projectId':'default','name':name,'sourceKind':'imported_csv','frequencyUnit':'kHz','levelUnit':'dBm',
                'points':[{'frequencyKHz':640000,'levelDbm':-80.5},{'frequencyKHz':640250,'levelDbm':0}],
                'original':{'name':'x.csv','text':'MHz,dBm\n640,-80.5\n640.25,0\n'}},kind='scans')
        for id in ('a','b','c'):await self.rpc('database.write',scan(id))
        page=(await self.rpc('database.resources.list',{'kind':'scans','limit':1}))['body']
        changed=scan('b','changed');changed['expected_revision']=1;await self.rpc('database.write',changed)
        await self.rpc('database.write',scan('aa'))
        second=(await self.rpc('database.resources.list',{'kind':'scans','limit':1,'cursor':page['next_cursor']}))['body']
        self.assertEqual((second['resources'][0]['id'],second['resources'][0]['revision']),('b',1))
        self.assertEqual(self.sql("SELECT level_dbm FROM db_scan_points WHERE scan_id='a' ORDER BY ordinal"),[(-80.5,),(0.0,)])

    async def test_h_epoch_and_operation_peer_are_not_socket_identity(self):
        body=self.resource();await self.rpc('database.write',body)
        ui=await UI(self).start();self.uis.append(ui)
        await self.rpc('operations.get',{'operation_id':body['operation_id']},ui=ui)
        other=await UI(self).start(ip='127.0.0.3');self.uis.append(other)
        self.assertEqual((await self.wire('operations.get',{'operation_id':body['operation_id']},other))['error'],'OPERATION_OWNER_MISMATCH')
        with self.repo.connection() as c:
            c.execute('BEGIN IMMEDIATE');db.rotate_recovery_epoch(c,self.epoch,uuid.uuid4().hex);c.commit()
        self.assertEqual((await self.wire('database.write',body))['error'],'DATABASE_EPOCH_CHANGED')
        self.assertEqual((await self.wire('operations.get',{'operation_id':body['operation_id']}))['error'],'DATABASE_EPOCH_CHANGED')

    async def test_i_lost_reply_after_real_commit_only_query_on_reconnect(self):
        body=self.resource();original=self.gateway.reply
        async def lose(sid,**kwargs):
            if kwargs.get('method')=='database.write':
                await self.gateway.sessions[sid].close(1013,'fixture lost response');return
            await original(sid,**kwargs)
        self.gateway.reply=lose
        with self.assertRaises(ConnectionError):await self.wire('database.write',body)
        self.gateway.reply=original
        ui=await UI(self).start();self.uis.append(ui)
        result=await self.rpc('operations.get',{'operation_id':body['operation_id']},ui=ui)
        self.assertEqual(result['body']['operation']['state'],'committed')
        self.assertEqual(self.sql("SELECT count(*) FROM db_audit WHERE kind='settings'"),[(1,)])

    async def test_j_commit_failure_leaves_no_business_or_receipt_and_stops_writes(self):
        self.repo.before_commit=lambda c:(_ for _ in ()).throw(OSError('fixture disk failure'))
        body=self.resource();reply=await self.wire('database.write',body)
        self.assertEqual(reply['error'],'OUTCOME_UNKNOWN_QUERY_ONLY')
        self.assertEqual(self.sql('SELECT count(*) FROM biz_settings'),[(0,)])
        self.assertEqual((await self.wire('operations.get',{'operation_id':body['operation_id']}))['error'],'OPERATION_NOT_FOUND')
        self.assertEqual((await self.wire('database.write',body))['error'],'STORE_UNCERTAIN_QUERY_ONLY')

    async def test_k_commit_success_but_result_lost_queries_actual_disk(self):
        self.repo.after_commit=lambda c:(_ for _ in ()).throw(OSError('fixture commit result lost'))
        body=self.resource();reply=await self.wire('database.write',body)
        self.assertEqual(reply['error'],'OUTCOME_UNKNOWN_QUERY_ONLY')
        result=await self.rpc('operations.get',{'operation_id':body['operation_id']})
        self.assertEqual(result['body']['operation']['state'],'committed')
        self.assertEqual(self.sql('SELECT count(*) FROM biz_settings'),[(1,)])

    async def test_l_expired_and_disconnected_while_waiting_never_write(self):
        ui=self.uis[0];request=ui.request(self.resource(),'database.write',deadline=-1)
        self.assertEqual((await ui.call(request))['error'],'REQUEST_EXPIRED')
        entered,release=threading.Event(),threading.Event()
        self.service.before_transaction=lambda:(entered.set(),release.wait(3))
        request=ui.request(self.resource(),'database.write');await ui.send(request)
        await support.eventually(entered.is_set);await ui.close();release.set()
        await support.eventually(lambda:not self.gateway.jobs)
        self.assertEqual(self.sql('SELECT count(*) FROM biz_settings'),[(0,)])

    async def test_m_discovery_durable_accept_complete_duplicate_and_cancel_target(self):
        self.probe_gate.clear();body=self.op(expected_generation=0)
        first=await self.rpc('discovery.scan',body,status=202);await support.eventually(lambda:bool(self.probes))
        await self.rpc('discovery.scan',body,status=202)
        self.assertEqual(len(self.probes),1)
        self.assertEqual((await self.wire('discovery.cancel',self.op(expected_generation=0,scan_operation_id=body['operation_id'])))['error'],'DISCOVERY_GENERATION_CONFLICT')
        cancel=self.op(expected_generation=first['body']['discovery']['generation'],scan_operation_id=body['operation_id'])
        await self.rpc('discovery.cancel',cancel,status=202)
        await support.eventually(lambda:self.service.active_scan is None)
        result=await self.rpc('operations.get',{'operation_id':body['operation_id']})
        self.assertEqual(result['body']['operation']['state'],'cancelled')
        self.probe_gate.set();new=self.op(expected_generation=first['body']['discovery']['generation'])
        await self.rpc('discovery.scan',new,status=202);await support.eventually(lambda:self.service.active_scan is None)
        result=await self.rpc('operations.get',{'operation_id':new['operation_id']})
        self.assertEqual(result['body']['operation']['state'],'completed')
        self.assertEqual(result['body']['operation']['result']['body']['discovery']['receivers'][0]['model'],'ULXD4D')

    async def test_n_restart_query_retains_result_without_reexecuting(self):
        body=self.resource();await self.rpc('database.write',body)
        await self.service.close();self.repo.close()
        self.repo=Repository(self.b,fixture_root=self.base)
        self.service=DataService(self.repo,discovery=self.discovery);await self.service.start();self.gateway.service=self.service
        ui=await UI(self).start();self.uis.append(ui)
        result=await self.rpc('operations.get',{'operation_id':body['operation_id']},ui=ui)
        self.assertEqual(result['body']['operation']['state'],'committed')
        self.assertEqual(self.sql("SELECT count(*) FROM db_audit WHERE kind='settings'"),[(1,)])

    async def test_o_http_write_disabled_read_preserved_and_reserved_namespace(self):
        status,body=await asyncio.to_thread(self.https,'/api/database/write',self.resource())
        self.assertEqual((status,body['code']),(409,'DATA_ENTRY_DISABLED'))
        self.assertEqual(self.sql('SELECT count(*) FROM biz_settings'),[(0,)])
        bad=self.resource(OP_PREFIX+'x',{'sourceOrigin':'x','sourceKey':'x','payload':{}},kind='legacy_snapshots')
        result=await self.rpc('database.write',bad,status=409);self.assertEqual(result['body']['code'],'RESERVED_RPC_NAMESPACE')
        for method in ('state.health','state.stats','state.capabilities','state.clock','database.overview','database.channels'):
            result=await self.rpc(method);self.assertIn('body',result)

    async def test_p_browser_import_preview_commit_and_query(self):
        source={'format':FORMAT,'version':1,'sourceOrigin':'https://localhost:8080','createdAt':'2026-09-17T00:00:00.000Z',
            'values':{'daty_alert_sound_v1':json.dumps({'enabled':True})}}
        plan=(await self.rpc('database.import.preview',{'backup':source}))['body']
        request=self.op(backup=source,confirmed=True,previewDigest=plan['previewDigest'])
        await self.rpc('database.import.commit',request);await self.rpc('database.import.commit',request)
        result=await self.rpc('operations.get',{'operation_id':request['operation_id']})
        self.assertEqual(result['body']['operation']['state'],'committed')

    async def test_q_real_mqttjs_and_original_repositories(self):
        command=[OPTIONS.node,str(HERE/'mqttjs-data-live.cjs'),self.uri,self.material['ca_file'],
            str(ROOT.parent/'FAshe/vendor/mqtt-5.10.4/mqtt.upstream.min.js'),OPTIONS.ws_bundle]
        result=await asyncio.to_thread(subprocess.run,command,capture_output=True,text=True,timeout=25,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        evidence=json.loads(result.stdout);self.assertTrue(evidence['ok'])
        Path(OPTIONS.output,'mqttjs-data-live.json').write_text(json.dumps(evidence,indent=2))

    async def test_r_history_pointer_deletion_and_immutable_run(self):
        from test_unified_domains import record
        values=[]
        for id in ('hist-a','hist-b'):
            value=record();value.update(id=id,projectId='default')
            values.append({'kind':'planning_records','id':id,'expected_revision':0,'value':value})
        current={'kind':'planning_current','id':'default','expected_revision':0,
            'value':{'projectId':'default','currentRecordId':'hist-b','deletedRecordIds':[]}}
        await self.rpc('database.batch',self.op(writes=[*values,current]))
        page=(await self.rpc('database.resources.list',{'kind':'planning_records','limit':1}))['body']
        current['expected_revision']=1;current['value'].update(currentRecordId='hist-a',deletedRecordIds=['hist-b'])
        await self.rpc('database.write',self.op(**current))
        archived=(await self.rpc('database.resources.list',{'kind':'planning_records','limit':1,'cursor':page['next_cursor']}))['body']['resources'][0]
        self.assertFalse(archived['deleted'])
        latest=(await self.rpc('database.resources.get',{'kind':'planning_records','id':'hist-b'}))['body']['resource']
        self.assertTrue(latest['deleted'])
        run=self.resource('immutable-run',{'projectId':'default','input':{},'result':{},'engineVersion':'fixture'},kind='planning_runs')
        await self.rpc('database.write',run);run['operation_id']=uuid.uuid4().hex;run['expected_revision']=1
        await self.rpc('database.write',run,status=409)

    async def test_s_schema_valid_archive_includes_business_and_rpc_receipts(self):
        body=self.resource();await self.rpc('database.write',body)
        archive=self.b.get_server_archive_service();oid=uuid.uuid4().hex
        await asyncio.to_thread(archive.create,{'operation_id':oid},self.repo.actor('127.0.0.1'))
        await support.eventually(lambda:archive.get('archives',oid)['status'] in ('saved','failed'),timeout=10)
        record=archive.get('archives',oid);self.assertEqual(record['status'],'saved',record)
        folder=archive._folder('archives',oid)
        restored=self.case/'restored.sqlite3'
        with zipfile.ZipFile(folder/'archive.zip') as zipped:
            restored.write_bytes(zipped.read('database.sqlite3'))
            self.assertIn('tables/db_legacy_snapshots.csv',zipped.namelist())
        c=sqlite3.connect(restored)
        try:
            validate_schema(c);self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertIsNotNone(db.get_operation(c,body['operation_id'],'network:127.0.0.1'))
            self.assertEqual(self.repo.get_receipt(c,body['operation_id'],self.repo.actor('127.0.0.1'))['state'],'committed')
        finally:c.close()

    async def test_t_actual_process_exit_before_and_after_commit(self):
        await self.service.close();self.repo.close()
        for phase in ('before','after'):
            request=self.uis[0].request(self.resource(),'database.write')
            request_path=self.case/(phase+'-crash.json');request_path.write_text(json.dumps(request))
            result=await asyncio.to_thread(subprocess.run,[sys.executable,str(HERE/'crash_writer.py'),str(self.base),
                str(self.case/'business.sqlite3'),str(request_path),phase],capture_output=True,timeout=12,
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            self.assertEqual(result.returncode,23,result.stderr)
            self.assertEqual(self.sql('SELECT COUNT(*) FROM biz_settings'),[(0 if phase=='before' else 1,)])
            self.repo=Repository(self.b,fixture_root=self.base)
            with self.repo.connection() as c:
                receipt=self.repo.get_receipt(c,request['body']['operation_id'],self.repo.actor('127.0.0.1'))
                if phase=='before':self.assertIsNone(receipt)
                else:self.assertEqual(receipt['state'],'committed')
            self.repo.close()
        self.repo=Repository(self.b,fixture_root=self.base)
        self.service=DataService(self.repo,discovery=self.discovery);await self.service.start();self.gateway.service=self.service
        ui=await UI(self).start();self.uis.append(ui)
        await self.rpc('operations.get',{'operation_id':request['body']['operation_id']},ui=ui)

    async def test_u_origin_topics_retained_forgery_and_internal_receipt_source(self):
        from websockets.exceptions import InvalidStatus
        for origin in ('null','https://evil.invalid:8080','http://127.0.0.1:8080'):
            with self.assertRaises(InvalidStatus):await websockets.connect(self.uri,ssl=client_context(self.tls),subprotocols=['mqtt'],origin=origin)
        for topic,header in (('daty/rf/devices/down',0x32),(REQUEST,0x33),(PREFIX+'/foreign/reply',0x32)):
            ui=await UI(self).start();self.uis.append(ui)
            await ui.ws.send(packet(header,utf(topic)+b'\0\x03\0'+json.dumps(ui.request(self.resource(),'database.write')).encode()))
            await support.eventually(lambda:ui.ws.close_code is not None)
            self.assertEqual(ui.ws.close_code,1008)
        forged=self.resource('ordinary-id',{'sourceOrigin':'daty-mqtt-stage4','sourceKey':OP_PREFIX+'fake','payload':{'state':'committed'}},kind='legacy_snapshots')
        await self.rpc('database.write',forged,status=409)
        self.assertEqual(self.sql('SELECT COUNT(*) FROM biz_settings'),[(0,)])

    async def test_v_interrupted_discovery_recovers_unknown_not_rescanned(self):
        request=self.uis[0].request(self.op(expected_generation=0),'discovery.scan');actor=self.repo.actor('127.0.0.1')
        with self.repo.connection() as c:
            c.execute('BEGIN IMMEDIATE');record,_=self.service.prepare(c,request,actor)
            self.repo.save_receipt(c,record,actor);self.repo.commit(c)
        await self.service.close();self.repo.close()
        self.repo=Repository(self.b,fixture_root=self.base);self.service=DataService(self.repo,discovery=self.discovery)
        await self.service.start();self.gateway.service=self.service
        ui=await UI(self).start();self.uis.append(ui)
        result=await self.rpc('operations.get',{'operation_id':request['body']['operation_id']},ui=ui)
        self.assertEqual(result['body']['operation']['state'],'unknown');self.assertEqual(self.probes,[])
        result=await self.wire('discovery.scan',self.op(expected_generation=0),ui)
        self.assertEqual(result['error'],'DISCOVERY_BUSY_OR_UNKNOWN')

    async def test_z_broker_loss_after_commit_does_not_replay(self):
        request=self.resource();await self.rpc('database.write',request)
        await asyncio.to_thread(self.stop_broker);await support.eventually(lambda:not self.service.accepting)
        self.assertEqual(self.sql("SELECT COUNT(*) FROM db_audit WHERE kind='settings'"),[(1,)])


if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--broker',required=True);ap.add_argument('--paho-root',required=True)
    ap.add_argument('--output',required=True);ap.add_argument('--case');ap.add_argument('--node',default='node');ap.add_argument('--ws-bundle')
    OPTIONS=ap.parse_args();Path(OPTIONS.output).mkdir(parents=True,exist_ok=True)
    suite=unittest.TestSuite([Integration(OPTIONS.case)]) if OPTIONS.case else unittest.defaultTestLoader.loadTestsFromTestCase(Integration)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    Path(OPTIONS.output,'result.json').write_text(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),
        'skipped':len(result.skipped),'success':result.wasSuccessful(),'broker_stopped':Integration.process.poll() is not None,
        'temporary_material_removed':not Integration.base.exists(),'evidence':Integration.evidence},indent=2))
    sys.exit(0 if result.wasSuccessful() else 1)
