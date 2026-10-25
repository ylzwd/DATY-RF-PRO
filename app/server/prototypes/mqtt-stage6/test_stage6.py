"""Integrated real TLS/Broker/SQLite tests. Never connects to live equipment."""
import argparse
import asyncio
import base64
import hashlib
import http.client
import json
from pathlib import Path
import sqlite3
import subprocess
import threading
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from functools import partial
import sys
import tempfile
import time
import unittest
import uuid
import zipfile
from contextlib import closing

sys.path.insert(0,str(Path(__file__).resolve().parent))
if '--paho-root' in sys.argv:sys.path.insert(0,sys.argv[sys.argv.index('--paho-root')+1])
from m6_runtime import Runtime
from m6_test_support import Receiver,UI,eventually,oid
from m6_repository import Journal,ACTOR,ORIGIN
from m6_contract import schema,SERVER
from command_journal import CommandError
from unified_schema import validate_schema
from tls_support import client_context,server_context
from m6_https import ThreadedHTTPSServer
from load_readiness import active_load,wait_active_load
from soak_progress import read_progress
from data_contract import DataError
import unified_database as db

OPTIONS=None
EVIDENCE=[]

class Integration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().set_debug(False)
        self.temp=tempfile.TemporaryDirectory(prefix='daty-mqtt-stage6-')
        self.addCleanup(self.temp.cleanup)
        self.runtime=Runtime(self.temp.name,OPTIONS.broker)
        self.addAsyncCleanup(self.runtime.close)
        await self.runtime.start()
        r=self.runtime
        self.b,self.fixture,self.tls=r.b,r.fixture,r.tls
        self.rx_uri=r.uri+'/mqtt'
        self.uris={m:r.uri+'/mqtt-'+m for m in ('app','enrollment')}
        self.receivers=[];self.uis=[]
        self.addAsyncCleanup(self.close_peers)
        if self._testMethodName!='test_two_original_fashe_windows_100ch':
            for index in (0,1):self.receivers.append(await Receiver(self,index).start())
        self.ui=await self.new_ui()
        with r.repo.connection() as c:self.epoch=db.status(c)['epoch']

    async def close_peers(self):
        for ui in self.uis:await ui.close()
        for receiver in self.receivers:await receiver.close()

    async def new_ui(self,ip='127.0.0.1',mode='app'):
        ui=await UI(self,mode,ip).start();self.uis.append(ui);return ui

    async def rpc(self,m,b=None,ui=None):
        result=await (ui or self.ui).call(m,b or {})
        self.assertTrue(result.get('ok'),result)
        return result['result']

    def intent(self,index=0,ch=1):
        did=self.fixture.credentials[index].receiver_id+'_ch'+str(ch)
        return {'operation_id':oid(),'target':self.runtime.bus.binding(did)[0],
                'command':'mute','expected_value':True}

    async def asyncTearDown(self):
        await self.close_peers();await self.runtime.close()
        with closing(sqlite3.connect(Path(self.temp.name)/'business.sqlite3')) as c:
            self.assertEqual(c.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
            self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(),[])
            validate_schema(c)
            records=c.execute('SELECT count(*) FROM db_legacy_snapshots WHERE source_origin=?',(ORIGIN,)).fetchone()[0]
        EVIDENCE.append({'case':self._testMethodName,'integrity':'ok','schema':'unchanged',
            'command_extension_records':records,'bus':self.runtime.bus.metrics,
            'simulated_executions':[len(rx.executions) for rx in self.receivers],
            'production_commands':0})

    async def test_shure_manual_scan_continues_reading_over_mqtt(self):
        from test_shure_active_discovery import observation
        discovery = self.runtime.discovery
        self.assertTrue(discovery.thread.is_alive())
        self.assertFalse(discovery.auto_scan)
        self.assertEqual(discovery.snapshot()['generation'], 0)
        visited = []
        discovery.interfaces = lambda: [{'address':'192.0.2.1','prefix':30}]
        def probe(host, **kw):
            visited.append(host)
            return observation(host,frames=('REP MODEL {ULXD4D}', 'REP 1 FREQUENCY 641000',
                'REP 2 FREQUENCY 642000','REP 1 AUDIO_LVL 000','REP 1 BATT_BARS 004',
                'REP 1 BATT_CHARGE 255','REP 1 TX_TYPE ULXD2','REP 1 AUDIO_MUTE OFF','REP 1 TX_MUTE_STATUS ON'))
        discovery.probe = probe
        discovery.poll_interval = .05
        result = await self.rpc('discovery.scan', {'operation_id':oid(), 'epoch':self.epoch, 'expected_generation':0})
        self.assertEqual(result['status'], 202, result)
        await eventually(lambda: len(visited) >= 2)
        status = await self.rpc('discovery.status')
        self.assertEqual(status['body']['generation'], 1)
        self.assertEqual(status['body']['count'], 1)
        snapshot = await self.rpc('devices.snapshot')
        channels = [d for d in snapshot['devices'] if d.get('_source') == 'shure-scp']
        self.assertEqual(len(channels), 2)
        first=next(d for d in channels if d['channel_number']==1)
        self.assertEqual(first['shure']['audio_dbfs'],-50)
        self.assertEqual(first['shure']['battery_bars'],4)
        self.assertIsNone(first['batt'])
        self.assertEqual((first['shure']['receiver_muted'],first['shure']['transmitter_muted']),(False,True))
        self.assertFalse(first['capabilities']['control_preparation']['write_enabled'])
        self.assertTrue(all(d['group_number']==3 and d['group']==3 and
                            d['group_source']=='server-fifo-v1' for d in channels))
        self.assertEqual({d['group_number'] for d in snapshot['devices'] if d.get('_source')!='shure-scp'},{1,2})
        self.assertEqual(self.runtime.fixture.policy.status()['assigned_receivers'],3)
        # Repeated observations and partial-channel reconnects retain the slot.
        self.b._accept_shure_observation(observation('192.0.2.2',frames=('REP MODEL {ULXD4D}','REP 1 FREQUENCY 641000')))
        self.assertEqual(self.runtime.fixture.policy.status()['assigned_receivers'],3)
        again=(await self.rpc('devices.snapshot'))['devices']
        self.assertTrue(all(d['group_number']==3 for d in again if d.get('_source')=='shure-scp'))
        self.assertEqual(len(self.b._state['receivers']),2)
        self.assertEqual(len(self.runtime.fixture.policy._load()['receiver_groups']),2)
        self.assertTrue(all(d['capabilities']['read_only'] for d in channels))
        self.assertTrue(all(not d['capabilities']['write_frequency'] for d in channels))
        self.assertEqual([len(r.executions) for r in self.receivers], [0, 0])

    async def test_shure_continuous_meter_tcp_mqtt_and_saved_samples(self):
        import websockets
        from mqtt_wire import WSReader,packet,utf,string,number
        from test_shure_metering import MeterPeer,receiver
        from shure_metering import ShureMeterSession
        peer=MeterPeer()
        captured=[]
        def accept(value):
            captured.append(value)
            self.b._accept_shure_observation(value)
        session=ShureMeterSession(receiver(),accept,port=peer.port,metadata_interval=.1,stale_after=.2)
        self.b._accept_shure_observation(receiver())
        values=[]
        try:
            async with websockets.connect(self.runtime.uri+'/mqtt-readonly',ssl=client_context(self.tls),
                    subprotocols=['mqtt'],proxy=None) as ws:
                reader=WSReader(ws)
                await ws.send(packet(0x10,utf('MQTT')+b'\x05\x02\x00\x0a\x00'+utf('')))
                self.assertEqual((await reader.read())[0],0x20)
                await ws.send(packet(0x82,b'\x00\x01\x00'+utf('daty/v2/daty-rf-pro/devices/read')+b'\x01'))
                self.assertEqual((await reader.read())[0],0x90)
                session.start()
                deadline=time.monotonic()+4
                while time.monotonic()<deadline:
                    head,body=await asyncio.wait_for(reader.read(),3)
                    self.assertEqual(head>>4,3)
                    _,offset=string(body);mid=body[offset:offset+2];size,offset=number(body,offset+2)
                    envelope=json.loads(body[offset+size:]);payload=envelope['payload'] or {}
                    devices=list(payload.get('devices',[]))
                    for event in payload.get('events',[]):devices.extend(event['payload'].get('devices',[]))
                    values.extend(d for d in devices if d.get('_source')=='shure-scp')
                    await ws.send(packet(0x40,mid))
                    if len([d for d in values if d.get('shure',{}).get('meter_state')=='live'])>=12 and any(d.get('shure',{}).get('meter_state')=='stale' for d in values):break
            live=[d for d in values if d.get('shure',{}).get('meter_state')=='live']
            # Metadata freshness refreshes preserve the current sample. Verify
            # every repeated sequence retains its exact meter values, then
            # compare the first occurrence of each sample in receive order.
            unique={}
            for d in live:
                s=d['shure'];key=(s['meter_stream_id'],s['meter_seq'])
                if key in unique:
                    self.assertEqual((s['audio_dbfs'],d['rf'],d['channel_number']),
                        (unique[key]['shure']['audio_dbfs'],unique[key]['rf'],unique[key]['channel_number']))
                else:unique[key]=d
            live=list(unique.values())
            self.assertEqual([d['shure']['meter_seq'] for d in live],list(range(1,13)))
            self.assertEqual([d['shure']['audio_dbfs'] for d in live],[10+n*3-50 for n in range(12)])
            self.assertTrue(all(d['group_number']==3 and d['capabilities']['read_only'] for d in live))
            self.assertTrue(any(d.get('shure',{}).get('meter_state')=='stale' and d['shure']['audio_dbfs'] is None for d in values))
            await asyncio.to_thread(self.b._unified_runtime.wait_idle)
            with self.runtime.repo.connection() as conn:
                from rf_sample_storage import load_snapshot
                saved=[json.loads(load_snapshot(conn,r[0])) for r in conn.execute("SELECT id FROM live_samples WHERE device_id LIKE 'Shure-%' ORDER BY id")]
            saved_seq={d['shure']['meter_seq'] for d in saved if d.get('shure',{}).get('meter_state')=='live'}
            self.assertEqual(saved_seq,set(range(1,13)))
            self.assertEqual([len(r.executions) for r in self.receivers],[0,0])
        finally:
            session.stop();await asyncio.to_thread(session.thread.join,2);peer.close()

    async def test_shure_battery_startup_tcp_mqtt_and_saved_samples(self):
        import websockets
        from mqtt_wire import WSReader,packet,utf,string,number
        from test_shure_metering import BatteryPeer,receiver
        from shure_metering import ShureMeterSession
        peer=BatteryPeer()
        session=ShureMeterSession(receiver(),self.b._accept_shure_observation,port=peer.port)
        self.b._accept_shure_observation(receiver())
        values=[];onset=ready=None
        try:
            async with websockets.connect(self.runtime.uri+'/mqtt-readonly',ssl=client_context(self.tls),
                    subprotocols=['mqtt'],proxy=None) as ws:
                reader=WSReader(ws)
                await ws.send(packet(0x10,utf('MQTT')+b'\x05\x02\x00\x0a\x00'+utf('')))
                self.assertEqual((await reader.read())[0],0x20)
                await ws.send(packet(0x82,b'\x00\x01\x00'+utf('daty/v2/daty-rf-pro/devices/read')+b'\x01'))
                self.assertEqual((await reader.read())[0],0x90)
                session.start();deadline=time.monotonic()+3
                while time.monotonic()<deadline:
                    head,body=await asyncio.wait_for(reader.read(),3)
                    self.assertEqual(head>>4,3)
                    _,offset=string(body);mid=body[offset:offset+2];size,offset=number(body,offset+2)
                    payload=json.loads(body[offset+size:])['payload'] or {}
                    devices=list(payload.get('devices',[]))
                    for event in payload.get('events',[]):devices.extend(event['payload'].get('devices',[]))
                    for d in devices:
                        if d.get('_source')!='shure-scp':continue
                        values.append(d);s=d.get('shure',{})
                        if d['channel_number']==1 and s.get('rf_antenna')=='AX' and onset is None:onset=time.monotonic()
                        if d['channel_number']==1 and s.get('battery_bars')==0 and ready is None:ready=time.monotonic()
                    await ws.send(packet(0x40,mid))
                    if ready is not None and time.monotonic()-ready>.2:break
            self.assertIsNotNone(onset);self.assertIsNotNone(ready)
            self.assertLess(ready-onset,1)
            self.assertEqual(peer.commands.count('GET 0 ALL'),1)
            channel1=[d for d in values if d['channel_number']==1]
            self.assertTrue(any(d['shure'].get('battery_bars')==0 and d['batt'] is None for d in channel1))
            self.assertFalse(any(d['shure'].get('battery_bars')==0 for d in values if d['channel_number']==2))
            live=[d for d in values if d['shure'].get('meter_state')=='live']
            seq=sorted({d['shure']['meter_seq'] for d in live})
            self.assertEqual(seq,list(range(1,max(seq)+1)))
            self.assertTrue(all(d['group_number']==3 and d['capabilities']['read_only'] for d in values))
            self.assertGreater(len({d['shure']['audio_dbfs'] for d in live}),5)
            session.stop();await asyncio.to_thread(session.thread.join,2)
            await asyncio.to_thread(self.b._unified_runtime.wait_idle)
            with self.runtime.repo.connection() as conn:
                from rf_sample_storage import load_snapshot
                saved=[json.loads(load_snapshot(conn,r[0])) for r in conn.execute("SELECT id FROM live_samples WHERE device_id LIKE 'Shure-%' ORDER BY id")]
            self.assertTrue(any(d['channel_number']==1 and d['shure'].get('battery_bars')==0 for d in saved))
            saved_seq={d['shure']['meter_seq'] for d in saved if d.get('shure',{}).get('meter_state')=='live'}
            self.assertTrue(set(seq).issubset(saved_seq))
            self.assertEqual([len(r.executions) for r in self.receivers],[0,0])
            EVIDENCE.append({'batteryStartupMqttMs':round((ready-onset)*1000,2),'sampleCount':len(seq)})
        finally:
            session.stop();await asyncio.to_thread(session.thread.join,2);peer.close()

    async def test_shure_live_scan_receipt_keeps_data_service_available(self):
        from unittest.mock import patch
        from test_shure_metering import MeterPeer,receiver
        from shure_metering import ShureMeterSession
        peer=MeterPeer();discovery=self.runtime.discovery
        discovery.interfaces=lambda:[{'address':'192.0.2.1','prefix':29}]
        def probe(host,**kw):
            if host=='192.0.2.2':return {**receiver(),'ts':time.time()}
            time.sleep(1);return None
        discovery.probe=probe;discovery.metering=True
        def factory(result,callback):return ShureMeterSession(result,callback,port=peer.port)
        operation=oid()
        try:
            with patch('shure_active_discovery.ShureMeterSession',factory):
                result=await self.rpc('discovery.scan',{'operation_id':operation,'epoch':self.epoch,'expected_generation':0})
                self.assertEqual(result['status'],202)
                await eventually(lambda: self.runtime.data.active_scan is None,timeout=5)
                self.assertTrue(self.runtime.data.accepting)
                receipt=await self.rpc('operations.get',{'operation_id':operation})
                record=receipt['body']['operation'];self.assertEqual(record['state'],'completed')
                self.assertIn('meter_stream_id',record['result']['body']['discovery']['receivers'][0]['channels']['1'])
                self.assertEqual((await self.rpc('discovery.status'))['status'],200)
        finally:
            await asyncio.to_thread(discovery.stop);peer.close()

    async def test_business_catalog_mqtt_round_trip(self):
        before=[len(r.executions) for r in self.receivers]
        saved=await self.rpc('database.write',{'kind':'settings','id':'alert_sound','value':{'enabled':True},'deleted':False,'expected_revision':0,'epoch':self.epoch,'operation_id':oid()})
        page=await self.rpc('database.catalog',{'kind':'settings','limit':20})
        page=page['body'];saved=saved['body']
        self.assertEqual(page['catalog_protocol'],'daty-business-catalog-v1')
        item=next(r for r in page['items'] if r['id']=='alert_sound')
        self.assertEqual(item['revision'],saved['resource']['revision'])
        self.assertEqual(item['summary']['enabled'],1);self.assertNotIn('value',item)
        detail=await self.rpc('database.resources.get',{'kind':'settings','id':'alert_sound'})
        self.assertEqual(detail['body']['resource'],saved['resource'])
        rejected=await self.ui.call('database.catalog',{'kind':'scans','project_id':'missing'})
        self.assertEqual(rejected['result']['status'],404)
        self.assertEqual([len(r.executions) for r in self.receivers],before)

    async def test_activity_saved_changes_observations_and_real_ack(self):
        for revision,enabled in [(0,True),(1,False)]:
            saved=await self.rpc('database.write',{'kind':'settings','id':'alert_sound','value':{'enabled':enabled},'deleted':False,'expected_revision':revision,'epoch':self.epoch,'operation_id':oid()})
            self.assertEqual(saved['status'],200)
        records=(await self.rpc('database.activity.list',{'source':'operations','category':'settings'}))['body']
        self.assertEqual(records['activity_protocol'],'daty-activity-v1')
        detail=(await self.rpc('database.activity.get',{'source':'operations','id':records['items'][0]['id']}))['body']['record']
        self.assertEqual(detail['before']['fields']['enabled'],1);self.assertEqual(detail['after']['fields']['enabled'],0)
        body=self.intent();await self.rpc('commands.request',body)
        await eventually(lambda:self.runtime.journal.get(body['operation_id'])['state']=='acknowledged')
        events=(await self.rpc('database.activity.list',{'source':'timeline','category':'commands'}))['body']['items']
        confirmed=next(e for e in events if e['outcome']=='acknowledged')
        actual=(await self.rpc('database.activity.get',{'source':'timeline','id':confirmed['id']}))['body']['record']
        self.assertTrue(actual['details']['actual']);self.assertTrue(actual['details']['execution_evidence'])
        live=(await self.rpc('database.activity.list',{'source':'live'}))['body']['items']
        self.assertTrue(live);self.assertTrue(all(r['outcome']=='observed' for r in live))

    async def test_operation_audit_clear_keeps_new_writes(self):
        from unified_activity import RETENTION_SOURCE,RETENTION_ACTOR
        saved=await self.rpc('database.write',{'kind':'settings','id':'alert_sound','value':{'enabled':True},'deleted':False,'expected_revision':0,'epoch':self.epoch,'operation_id':oid()})
        self.assertEqual(saved['status'],200)
        before=(await self.rpc('database.activity.list',{'source':'operations'}))['body']
        with self.runtime.repo.connection() as c:
            c.execute('BEGIN IMMEDIATE');mark=oid()
            db.put_resource(c,{'kind':'legacy_snapshots','id':mark,'expected_revision':0,'epoch':self.epoch,'operation_id':mark,
                'value':{'sourceOrigin':RETENTION_SOURCE,'sourceKey':'operation-audit','payload':{'protocol':RETENTION_SOURCE,'epoch':self.epoch,'clearedThrough':before['as_of'],'clearedAtMs':int(time.time()*1000),'recordCount':1}}},{'id':RETENTION_ACTOR},int(time.time()*1000));c.commit()
        cleared=(await self.rpc('database.activity.list',{'source':'operations'}))['body'];self.assertEqual(cleared['items'],[])
        old=await self.rpc('database.resources.get',{'kind':'settings','id':'alert_sound'});self.assertTrue(old['body']['resource']['value']['enabled'])
        await self.rpc('database.write',{'kind':'settings','id':'alert_sound','value':{'enabled':False},'deleted':False,'expected_revision':1,'epoch':self.epoch,'operation_id':oid()})
        after=(await self.rpc('database.activity.list',{'source':'operations'}))['body'];self.assertEqual([r['revision'] for r in after['items']],[2])
        self.assertTrue((await self.rpc('database.activity.list',{'source':'live'}))['body']['items'])

    async def test_single_bus_ack_dedup_and_sort(self):
        import socket
        for client in self.runtime.clients:
            self.assertEqual(client.client.socket().getsockopt(socket.IPPROTO_TCP,socket.TCP_NODELAY),1)
        writer=self.b.get_unified_runtime_status()['writer']
        self.assertEqual(writer['kind'],'isolated-process');self.assertTrue(writer['running'])
        targets=await self.rpc('commands.targets')
        self.assertEqual([(x['group_number'],x['target']['channel_number']) for x in targets['targets']],[(1,1),(1,2),(2,1),(2,2)])
        body=self.intent();request=self.ui.request('commands.request',body)
        await self.ui.send(request);reply=await self.ui.message();self.assertTrue(reply['ok'],reply)
        await eventually(lambda:self.runtime.journal.get(body['operation_id'])['state']=='acknowledged')
        result=await self.rpc('commands.get',{'operation_id':body['operation_id']})
        self.assertEqual(result['actual_value'],True)
        self.assertEqual(result['attempts'],1)
        self.assertEqual(result['server_id'],SERVER)
        self.assertEqual(result['execution_evidence']['receiver_session_id'],body['target']['receiver_session_id'])
        await self.ui.send(request);again=await self.ui.message();self.assertEqual(again['result']['state'],'acknowledged')
        self.assertEqual(len(self.receivers[0].executions),1)
        self.assertEqual(self.runtime.bus.metrics['outlet_sends'],1)
        self.assertGreaterEqual(self.runtime.bus.metrics['consumed'],3)
        with self.assertRaisesRegex(CommandError,'LEGACY_CONTROL_SENDER_DISABLED'):
            self.b._broker_publish_command({})

    async def test_explicit_runtime_restarts_existing_identity_database(self):
        from m6_scope import RuntimeScope,checked_scope
        from build_candidate import build
        from tls_support import load_config
        root=Path(self.temp.name)
        public=build(root/'release-public')
        body=self.intent();await self.rpc('commands.request',body)
        await eventually(lambda:self.runtime.journal.get(body['operation_id'])['state']=='acknowledged')
        known=self.runtime.journal.get(body['operation_id'])
        before={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.joinpath('security').glob('*') if p.is_file() and p.suffix in ('.json','.pem')}
        config=root/'runtime-config.json'
        settings={'schema':'daty-mqtt6-runtime-v1','database':str(root/'business.sqlite3'),'database_epoch':self.epoch,
            'archives':str(root/'archives'),'staging':str(root/'staging'),'runtime_directory':str(root/'runtime'),
            'pairing':str(self.fixture.path),'tls':str(self.tls),'ca_sha256':load_config(self.tls)[1]['ca_sha256'],
            'bind_host':'127.0.0.1','mqtt_port':0,'web_port':0,'public_directory':str(public)}
        await self.close_peers();await self.runtime.close()
        # Fixture-owned markers are removed after shutdown. Reusing existing
        # resources must require a real context, never a forged fixture marker.
        for n in range(1,7):(root/f'.daty-mqtt-stage{n}-fixture').unlink()
        for field,bad in [('database_epoch','changed-epoch'),('ca_sha256',['0'*64])]:
            config.write_text(json.dumps({**settings,field:bad}),'utf-8')
            with self.assertRaises(ValueError):RuntimeScope(config)
        with self.assertRaises(ValueError):checked_scope(True)
        config.write_text(json.dumps(settings),'utf-8')
        for restart in range(2):
            scope=RuntimeScope(config)
            self.addCleanup(scope.close)
            with self.assertRaises(CommandError):RuntimeScope(config)
            self.runtime=Runtime(scope.runtime_directory,OPTIONS.broker,runtime_scope=scope)
            self.addAsyncCleanup(self.runtime.close)
            await self.runtime.start();self.b=self.runtime.b
            self.rx_uri=self.runtime.uri+'/mqtt';self.uris={m:self.runtime.uri+'/mqtt-'+m for m in ('app','enrollment')}
            self.uis=[]
            order=list(reversed(self.receivers)) if restart==0 else self.receivers
            self.assertEqual(self.runtime.fixture.policy.status()['assigned_receivers'],0)
            for peer in order:await peer.start()
            self.ui=await self.new_ui()
            restored=await self.rpc('commands.get',{'operation_id':body['operation_id']})
            self.assertEqual(restored['state'],'acknowledged');self.assertEqual(restored['attempts'],1)
            self.assertEqual(restored['command_id'],known['command_id'])
            self.assertEqual(self.runtime.bus.metrics['outlet_sends'],0)
            targets=(await self.rpc('commands.targets'))['targets']
            self.assertEqual([t['group_number'] for t in targets],[1,1,2,2])
            self.assertEqual([t['target']['receiver_id'] for t in targets],
                [peer.cred.receiver_id for peer in order for _ in (1,2)])
            # A receiver-only restart retains its slot and changes its session;
            # old command targets cannot bind to the new connection.
            old_target=targets[0]['target']
            await order[0].close();await order[0].start()
            self.assertEqual(self.runtime.fixture.policy.status()['assigned_receivers'],2)
            with self.assertRaises(CommandError):self.runtime.bus.validate(old_target,'mute')
            self.assertEqual([t['group_number'] for t in (await self.rpc('commands.targets'))['targets']],[1,1,2,2])
            self.assertEqual({p:hashlib.sha256(p.read_bytes()).hexdigest() for p in before},before)
            self.assertFalse(any(root.glob('.daty-mqtt-stage*-fixture')))
            def read_static():
                connection=http.client.HTTPSConnection('127.0.0.1',self.runtime.static.server.server_port,context=client_context(self.tls),timeout=5)
                try:
                    for path,status in [('/unirf-app.html',200),('/src/mqtt6/bundle.js',200),('/api/devices',410),('/local-ip.json',410),('/candidate-manifest.json',404),('/security/tls-config.json',404)]:
                        connection.request('GET',path);response=connection.getresponse();response.read();self.assertEqual(response.status,status,path)
                finally:connection.close()
            await asyncio.to_thread(read_static)
            if restart==0:await self.close_peers();await self.runtime.close()
        (Path(OPTIONS.output)/'existing-runtime-restart.json').write_text(json.dumps({'ok':True,'restarts':2,
            'same_database_epoch':self.epoch,'same_trust_and_pairing_bytes':True,'groups':[1,1,2,2],
            'reversed_arrival_order_verified':True,'receiver_reconnect_keeps_group':True,
            'replayed_commands':0,'fixture_markers_present':False,'production_commands':0}),'utf-8')

    async def test_abrupt_parent_exit_stops_owned_children(self):
        import ctypes
        from ctypes import wintypes
        script="""import os,subprocess,sys
from m6_job import own_process_tree
own_process_tree()
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)'],
    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
print(child.pid,flush=True)
os._exit(42)
"""
        script='import sys;sys.path.insert(0,'+repr(str(Path(__file__).parent))+')\n'+script
        result=await asyncio.to_thread(subprocess.run,[sys.executable,'-c',script],cwd=Path(__file__).parent,
            capture_output=True,text=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(result.returncode,42,result.stderr)
        pid=int(result.stdout.strip())
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes=[wintypes.HANDLE,ctypes.POINTER(wintypes.DWORD)];kernel.GetExitCodeProcess.restype=wintypes.BOOL
        kernel.CloseHandle.argtypes=[wintypes.HANDLE];kernel.CloseHandle.restype=wintypes.BOOL
        handle=kernel.OpenProcess(0x1000,False,pid)
        if handle:
            try:
                code=wintypes.DWORD()
                def stopped():
                    if not kernel.GetExitCodeProcess(handle,ctypes.byref(code)):raise ctypes.WinError(ctypes.get_last_error())
                    return code.value!=259
                await eventually(stopped,timeout=5)
            finally:kernel.CloseHandle(handle)
        else:self.assertEqual(ctypes.get_last_error(),87)
        (Path(OPTIONS.output)/'owned-process-crash.json').write_text(json.dumps({'ok':True,'parent_exit':42,'child_stopped':True}),'utf-8')

    async def test_timeout_review_preserves_outcome_and_owner(self):
        self.receivers[0].acknowledge=False
        body=self.intent();request=self.ui.request('commands.request',body)
        request['deadline_at_ms']=int(time.time()*1000)+500
        await self.ui.send(request);self.assertTrue((await self.ui.message())['ok'])
        await eventually(lambda:self.runtime.journal.get(body['operation_id'])['state']=='timeout')
        # Explicit raw telemetry without command_id isn't an execution ACK.
        await self.receivers[0].publish('daty/rf/devices/up',{'type':'device_status_update','channel':1,'muted':True})
        records=await self.rpc('commands.uncertain');record=records['operations'][0]
        failed=await self.ui.call('commands.request',self.intent());self.assertEqual(failed['error'],'TARGET_PENDING_OR_UNCERTAIN')
        outsider=await self.new_ui('127.0.0.2')
        failed=await outsider.call('commands.get',{'operation_id':body['operation_id']});self.assertEqual(failed['error'],'OPERATION_OWNER_MISMATCH')
        review={'operation_id':body['operation_id'],'expected_revision':record['revision'],'confirmed':True,
            'note':'人工已核对接收机，允许新操作，旧操作仍未确认','observation':record['current_observation']}
        failed=await self.ui.call('commands.review',{**review,'confirmed':False});self.assertEqual(failed['error'],'EXPLICIT_REVIEW_REQUIRED')
        reviewed=await self.rpc('commands.review',review)
        self.assertEqual(reviewed['state'],'timeout');self.assertIsNone(reviewed['execution_evidence'])
        self.assertEqual(reviewed['review']['meaning'],'release-target-no-execution-claim')
        self.receivers[0].acknowledge=True
        new=self.intent();await self.rpc('commands.request',new)
        await eventually(lambda:self.runtime.journal.get(new['operation_id'])['state']=='acknowledged')

    async def test_wrong_target_and_reconnected_session(self):
        body=self.intent();body['target']['receiver_ip']='127.0.0.3'
        result=await self.rpc('commands.request',body)
        self.assertEqual(result['state'],'rejected');self.assertEqual(result['attempts'],0)
        stale=self.intent()
        await self.receivers[0].close();self.receivers[0]=await Receiver(self,0).start()
        result=await self.rpc('commands.request',stale)
        self.assertEqual(result['state'],'rejected');self.assertEqual(len(self.receivers[0].executions),0)

    async def test_discovery_unknown_review_survives_restart(self):
        service=self.runtime.data;actor=self.runtime.repo.actor(self.ui.ip);scan=oid()
        request=self.ui.request('discovery.scan',{'operation_id':scan,'epoch':self.epoch,'expected_generation':0})
        with self.runtime.repo.connection() as c:
            c.execute('BEGIN IMMEDIATE')
            record,_=service.prepare(c,request,actor)
            service.repo.save_receipt(c,record,actor);service.repo.commit(c)
        await asyncio.to_thread(service.recover)
        self.assertEqual(service.active_scan,scan)
        query=await self.rpc('discovery.uncertain');prior=query['body']['operation']
        self.assertEqual(prior['state'],'unknown')
        body={'operation_id':oid(),'epoch':self.epoch,'scan_operation_id':scan,
            'expected_revision':prior['receipt_revision'],'expected_generation':query['body']['discovery']['generation'],
            'confirmed':True,'note':'人工核对扫描已停止，保留原未知结果。'}
        invalid=await self.rpc('discovery.review',{**body,'confirmed':False})
        self.assertEqual(invalid['status'],409)
        result=await self.rpc('discovery.review',body);self.assertEqual(result['status'],200,result)
        self.assertFalse(result['body']['scan_started']);self.assertIsNone(service.active_scan)
        await asyncio.to_thread(service.recover);self.assertIsNone(service.active_scan)
        with service.repo.connection() as c:
            old=service.repo.get_receipt(c,scan,actor)
            self.assertEqual(old['state'],'unknown');self.assertEqual(old['error'],'PROCESS_INTERRUPTED')
            self.assertIsNotNone(old['review'])
        repeated=await self.rpc('discovery.review',body);self.assertEqual(repeated,result)

    async def test_upload_release_preserves_receipt_and_restores_interrupted_cleanup(self):
        from m6_files import FileStore
        store=self.runtime.store;actor='network:'+self.ui.ip;raw=b'consumed temporary bytes';digest=hashlib.sha256(raw).hexdigest();identifier=oid()
        await self.rpc('uploads.begin',{'operation_id':identifier,'bytes':len(raw),'sha256':digest,'media_type':'text/plain'})
        await self.rpc('uploads.chunk',{'upload_id':identifier,'offset':0,'sha256':digest,'data':base64.b64encode(raw).decode()})
        await self.rpc('uploads.finish',{'upload_id':identifier,'sha256':digest})
        record=store.read('uploads',identifier,actor);record['state']='releasing';store.save('uploads',record)
        store.close();restored=FileStore(store.root,fixture_root=self.temp.name)
        self.runtime.store=self.runtime.files.store=restored
        result=await self.rpc('uploads.status',{'id':identifier});self.assertEqual(result['state'],'closed')
        self.assertEqual(result['sha256'],digest)
        self.assertEqual([p.name for p in restored.folder('uploads',identifier).iterdir()],['manifest.json'])
        self.assertEqual((await self.rpc('uploads.release',{'upload_id':identifier,'sha256':digest,'consumed':True}))['state'],'closed')

    async def test_server_network_address_is_not_client_peer(self):
        outsider=await self.new_ui('127.0.0.2')
        expected=await asyncio.to_thread(self.runtime.network_status)
        result=await self.rpc('network.status',ui=outsider)
        self.assertEqual(result['peer_ip'],'127.0.0.2')
        self.assertEqual(result['ip'],expected['ip']);self.assertEqual(result['all_ips'],expected['all_ips'])

    async def test_real_process_exit_preserves_unknown_dispatch(self):
        from m6_repository import Repository
        from types import SimpleNamespace
        base=Path(self.temp.name)/'crash-writer';base.mkdir();(base/'.journal-crash-fixture').write_text('isolated')
        intent=self.intent();request=self.ui.request('commands.request',intent)
        (base/'intent.json').write_text(json.dumps(request),'utf-8')
        run=await asyncio.to_thread(subprocess.run,[sys.executable,str(Path(__file__).with_name('crash_journal_fixture.py')),str(base)],
            capture_output=True,timeout=20,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.assertEqual(run.returncode,73,run.stderr.decode(errors='replace'))
        repo=Repository(SimpleNamespace(_db_path=base/'business.sqlite3',_db_lock=threading.RLock()),fixture_root=base)
        try:
            journal=Journal(repo,fixture_root=base)
            try:
                record=journal.get(intent['operation_id'])
                self.assertEqual(record['state'],'unknown');self.assertEqual(record['error'],'PROCESS_INTERRUPTED')
                self.assertEqual(record['attempts'],1);self.assertIsNone(record['execution_evidence'])
            finally:journal.close()
            with repo.connection() as c:
                self.assertEqual(c.execute('PRAGMA quick_check').fetchall()[0][0],'ok')
                self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(),[])
        finally:repo.close()

    async def test_wal_reclaim_preserves_pinned_snapshot(self):
        from m6_persistence import Checkpointer
        path=Path(self.temp.name)/'wal-reader.sqlite3';lock=threading.Lock()
        def verify():
            with closing(sqlite3.connect(path,isolation_level=None)) as writer,closing(sqlite3.connect(path,isolation_level=None)) as reader:
                writer.execute('PRAGMA journal_mode=WAL').close();writer.execute('PRAGMA synchronous=FULL').close()
                writer.execute('PRAGMA wal_autocheckpoint=0').close();writer.execute('CREATE TABLE evidence(id INTEGER PRIMARY KEY,value BLOB)').close()
                writer.execute('INSERT INTO evidence(value) VALUES(?)',(b'original',)).close()
                reader.execute('BEGIN').close();cursor=reader.execute('SELECT count(*) FROM evidence');self.assertEqual(cursor.fetchone()[0],1);cursor.close()
                checkpointer=Checkpointer(path,lock);checkpointer.interval=.05;checkpointer.threshold=1024
                try:
                    checkpointer.start()
                    for _ in range(34):
                        with lock:writer.execute('INSERT INTO evidence(value) VALUES(zeroblob(4194304))').close()
                    end=time.monotonic()+3
                    while not checkpointer.status()['runs'] and time.monotonic()<end:time.sleep(.05)
                    cursor=reader.execute('SELECT count(*) FROM evidence');self.assertEqual(cursor.fetchone()[0],1);cursor.close()
                    self.assertEqual(checkpointer.status()['reclaims'],0)
                    reader.rollback()
                    end=time.monotonic()+8
                    while not checkpointer.status()['reclaims'] and time.monotonic()<end:time.sleep(.05)
                    self.assertGreater(checkpointer.status()['reclaims'],0,checkpointer.status())
                    cursor=writer.execute('SELECT count(*) FROM evidence');self.assertEqual(cursor.fetchone()[0],35);cursor.close()
                    self.assertEqual(writer.execute('PRAGMA quick_check').fetchone()[0],'ok')
                finally:checkpointer.stop()
        await asyncio.to_thread(verify)

    async def test_atomic_data_and_namespace_protection(self):
        body={'operation_id':oid(),'epoch':self.epoch,'kind':'preferences','id':'m6-preferences',
            'expected_revision':0,'value':{'activePanel':'data','channelPage':1}}
        result=await self.rpc('database.write',body);self.assertEqual(result['status'],200,result)
        item=await self.rpc('database.resources.get',{'kind':'preferences','id':'m6-preferences'})
        self.assertEqual(item['body']['resource']['value'],body['value'])
        forged={**body,'operation_id':oid(),'kind':'legacy_snapshots','id':'forged',
            'value':{'sourceOrigin':ORIGIN,'sourceKey':'mqtt6:op:'+oid(),'payload':{'state':'acknowledged'}}}
        result=await self.rpc('database.write',forged)
        self.assertEqual(result['status'],409,result)
        self.assertEqual(result['body']['code'],'RESERVED_RPC_NAMESPACE')
        with self.runtime.repo.connection() as c:
            self.assertIsNone(db.get_resource(c,'legacy_snapshots','forged'))

    async def test_data_management_delta_and_project_snapshot(self):
        from test_unified_domains import alert
        async def write(kind,id,value,revision=0,deleted=False):
            result=await self.rpc('database.write',dict(operation_id=oid(),epoch=self.epoch,kind=kind,id=id,value=value,expected_revision=revision,deleted=deleted))
            self.assertEqual(result['status'],200,result)
        await write('alerts','a1',alert())
        first=await self.rpc('database.resources.list',{'kind':'alerts'})
        self.assertEqual(first['body']['schema_version'],3)
        upper=first['body']['as_of']
        await write('alerts','a1',alert(True),1)
        again={**alert(),'archiveId':'a2','firstSeen':2000,'lastSeen':2100}
        await write('alerts','a2',again)
        filters={'kind':'alerts','limit':1,'since':upper,'since_epoch':self.epoch}
        page=await self.rpc('database.resources.list',filters)
        self.assertEqual(page['body']['resources'][0]['value']['archiveState'],'ended')
        await write('alerts','a2',None,1,True)
        next_page=await self.rpc('database.resources.list',{**filters,'cursor':page['body']['next_cursor']})
        self.assertFalse(next_page['body']['resources'][0]['deleted'])
        changed=await self.rpc('database.resources.list',{'kind':'alerts','since':page['body']['as_of'],'since_epoch':self.epoch})
        self.assertTrue(changed['body']['resources'][0]['deleted'])
        wrong=await self.rpc('database.resources.list',{**filters,'since_epoch':'wrong'})
        self.assertEqual(wrong['status'],409)
        for project in ('default','other'):
            await write('project_metadata',project,{'id':project,'name':project,'data':{}})
            value={'id':'plan-'+project,'type':'daty_rf_planning','projectId':project,'timestamp':1,'channels':0,'devices':[]}
            await write('planning_records',value['id'],value)
        project=await self.rpc('database.resources.list',{'kind':'planning_records','project_id':'default'})
        self.assertEqual([r['id'] for r in project['body']['resources']],['plan-default'])
        self.assertEqual(project['body']['project_id'],'default')
        EVIDENCE.append({'case':'data-management-r19','delta_edges_tombstones_epoch_and_project':True})

    async def test_archive_contains_control_receipts(self):
        body=self.intent();await self.rpc('commands.request',body)
        await eventually(lambda:self.runtime.journal.get(body['operation_id'])['state']=='acknowledged')
        archive=await self.rpc('archives.create',{'operation_id':oid()})
        archive=archive['result']
        for _ in range(100):
            if archive['status']=='saved':break
            await asyncio.sleep(.05);archive=await self.rpc('archives.get',{'id':archive['id']})
        self.assertEqual(archive['status'],'saved',archive)
        download=await self.rpc('downloads.open',{'operation_id':oid(),'category':'archives','id':archive['id'],'sha256':archive['sha256']})
        while download['state']=='preparing':
            await asyncio.sleep(.05);download=await self.rpc('file.operations.get',{'operation_id':download['id']})
        self.assertEqual(download['state'],'completed',download)
        descriptor=download['result'];raw=bytearray()
        for offset in range(0,descriptor['bytes'],128*1024):
            part=await self.rpc('downloads.chunk',{'download_id':descriptor['id'],'offset':offset,'sha256':descriptor['sha256']})
            chunk=base64.b64decode(part['data']);self.assertEqual(hashlib.sha256(chunk).hexdigest(),part['sha256']);raw.extend(chunk)
        self.assertEqual(hashlib.sha256(raw).hexdigest(),descriptor['sha256'])
        path=Path(self.temp.name)/'verified.zip';path.write_bytes(raw)
        with zipfile.ZipFile(path) as z:
            candidates=[n for n in z.namelist() if n.endswith(('.sqlite3','.sqlite','.db'))]
            self.assertEqual(len(candidates),1)
            restored=Path(self.temp.name)/'restored.sqlite3';restored.write_bytes(z.read(candidates[0]))
        with closing(sqlite3.connect(restored)) as c:
            validate_schema(c);self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            values=c.execute('SELECT payload_json FROM db_legacy_snapshots WHERE source_origin=?',(ORIGIN,)).fetchall()
            self.assertTrue(any(json.loads(v[0]).get('state')=='acknowledged' for v in values))

    async def test_legacy_http_and_sse_rejected(self):
        def request(path,method='GET'):
            conn=http.client.HTTPSConnection('127.0.0.1',self.runtime.port,context=client_context(self.tls),timeout=3)
            try:
                conn.request(method,path,body='{}' if method=='POST' else None)
                try:result=conn.getresponse()
                except http.client.RemoteDisconnected:
                    if method=='POST':return 'parser_rejected'
                    raise
                result.read();return result.status
            finally:conn.close()
        for path,method in [('/api/updates','GET'),('/api/devices','GET'),('/api/command','POST'),('/api/database/resources','POST')]:
            self.assertEqual(await asyncio.to_thread(request,path,method),410 if method=='GET' else 'parser_rejected')
        self.assertEqual(sum(len(rx.executions) for rx in self.receivers),0)

    async def test_download_preparation_is_queryable_and_does_not_hold_business_lock(self):
        store=self.runtime.store;service=self.runtime.files;archive=self.runtime.archive
        record=await asyncio.to_thread(archive.export,{'operation_id':oid(),'text':'streamed exact bytes'*10000,
            'fileName':'async.txt','mimeType':'text/plain','source':'isolated-fixture'},'network:'+self.ui.ip)
        original=store.write_snapshot;entered=threading.Event();release=threading.Event()
        def delayed(*args,**kwargs):
            entered.set()
            if not release.wait(5):raise AssertionError('fixture did not release worker')
            return original(*args,**kwargs)
        store.write_snapshot=delayed
        body={'operation_id':oid(),'category':'exports','id':record['id'],'sha256':record['sha256']}
        try:
            request=self.ui.request('downloads.open',body);request['deadline_at_ms']=int(time.time()*1000)+1000
            started=time.monotonic();await self.ui.send(request);reply=await self.ui.message()
            self.assertTrue(reply['ok'],reply);result=reply['result']
            self.assertEqual(result['state'],'preparing');self.assertLess(time.monotonic()-started,2)
            self.assertTrue(await asyncio.to_thread(entered.wait,2))
            await asyncio.sleep(1.1)  # Accepted preparation outlives the request deadline.
            current=await self.rpc('file.operations.get',{'operation_id':body['operation_id']})
            self.assertEqual(current['state'],'preparing')
            self.assertEqual((await self.rpc('downloads.open',body))['state'],'preparing')
            self.assertEqual(len(service.pending),1)
            conflict=await self.ui.call('downloads.open',{**body,'sha256':'0'*64})
            self.assertEqual(conflict['error'],'OPERATION_ID_CONFLICT')
            self.assertEqual(len((await self.rpc('commands.targets'))['targets']),4)
            with self.assertRaises(db.DatabaseError) as blocked:
                archive.prepare_cleanup({'operation_id':oid(),'selection':{'category':'exports','id':record['id']}},'fixture')
            self.assertEqual(blocked.exception.status,409)
            self.assertIn('下载',str(blocked.exception))
        finally:release.set()
        await eventually(lambda:not service.pending)
        result=await self.rpc('file.operations.get',{'operation_id':body['operation_id']})
        self.assertEqual(result['state'],'completed',result)
        descriptor=result['result'];folder=store.folder('downloads',descriptor['id'])
        self.assertLess((folder/'manifest.json').stat().st_size,2048)
        self.assertNotIn('chunks',json.loads((folder/'manifest.json').read_text('utf-8')))
        part=await self.rpc('downloads.chunk',{'download_id':descriptor['id'],'offset':0,'sha256':descriptor['sha256']})
        self.assertEqual(hashlib.sha256(base64.b64decode(part['data'])).hexdigest(),part['sha256'])
        with (folder/'hashes').open('r+b') as stream:stream.write(bytes(32))
        bad=await self.ui.call('downloads.chunk',{'download_id':descriptor['id'],'offset':0,'sha256':descriptor['sha256']})
        self.assertEqual(bad['error'],'DOWNLOAD_CORRUPT')
        await self.rpc('downloads.close',{'download_id':descriptor['id']})
        self.assertEqual([path.name for path in folder.iterdir()],['manifest.json'])

    async def test_download_cancel_before_worker_and_interrupted_manifest(self):
        from m6_files import FileStore
        store=self.runtime.store;actor='network:'+self.ui.ip;identifier=oid()
        store.prepare_snapshot(identifier,actor,{'fixture':'cancel-before-copy'},16)
        self.assertEqual(store.close_download(identifier,actor)['state'],'cancelling')
        with self.assertRaisesRegex(Exception,'DOWNLOAD_PREPARATION_STOPPED'):
            store.write_snapshot(identifier,actor,raw=b'x'*16)
        self.assertEqual(store.status('downloads',identifier,actor)['state'],'closed')
        self.assertNotIn(identifier,store.download_cancels)
        interrupted=oid();store.prepare_snapshot(interrupted,actor,{'fixture':'interrupted'},16)
        store.close();restored=FileStore(store.root,fixture_root=self.temp.name)
        self.runtime.store=self.runtime.files.store=restored
        status=restored.status('downloads',interrupted,actor)
        self.assertEqual(status['state'],'interrupted');self.assertEqual(status['error'],'PROCESS_INTERRUPTED')
        self.assertFalse((restored.folder('downloads',interrupted)/'content').exists())
        restored.close_download(interrupted,actor)

    async def test_streaming_download_exceeds_old_one_gib_limit(self):
        from server_archive import digest
        from m5_contract import CHUNK
        store=self.runtime.store;actor='network:'+self.ui.ip;source=Path(self.temp.name)/'large-source.bin'
        size=1024**3+17
        def prepare():
            with source.open('wb') as stream:stream.truncate(size)
            sha=digest(source)
            descriptor=store.snapshot(oid(),actor,{'fixture':'over-old-download-limit'},source=source,expected=sha)
            return sha,descriptor
        sha,descriptor=await asyncio.to_thread(prepare)
        self.assertEqual(descriptor['bytes'],size);self.assertEqual(descriptor['sha256'],sha)
        folder=store.folder('downloads',descriptor['id'])
        self.assertLess((folder/'manifest.json').stat().st_size,2048)
        self.assertEqual((folder/'hashes').stat().st_size,((size+CHUNK-1)//CHUNK)*32)
        for offset in (0,512*1024**2,1024**3):
            part=await self.rpc('downloads.chunk',{'download_id':descriptor['id'],'offset':offset,'sha256':sha})
            raw=base64.b64decode(part['data']);self.assertEqual(raw,bytes(min(CHUNK,size-offset)))
            self.assertEqual(hashlib.sha256(raw).hexdigest(),part['sha256'])
        await self.rpc('downloads.close',{'download_id':descriptor['id']})
        self.assertEqual([path.name for path in folder.iterdir()],['manifest.json'])

    async def test_backup_snapshot_completes_during_continuous_writes(self):
        from m6_archive import SnapshotConnection
        source=Path(self.temp.name)/'backup-source.sqlite3'
        def verify():
            with closing(sqlite3.connect(source,isolation_level=None)) as writer:
                writer.execute('PRAGMA journal_mode=WAL');writer.execute('PRAGMA synchronous=FULL')
                writer.execute('CREATE TABLE fixture(id INTEGER PRIMARY KEY,value INTEGER,payload BLOB)')
                writer.execute('INSERT INTO fixture VALUES(1,0,zeroblob(1048576))')
                counts=[]
                def copy(factory,name):
                    calls=0
                    def progress(status,remaining,total):
                        nonlocal calls
                        calls+=1
                        writer.execute('UPDATE fixture SET value=value+1 WHERE id=1')
                        if calls>80:raise RuntimeError('BACKUP_RESTARTED_BY_EVERY_COMMIT')
                    with closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,factory=factory)) as reader:
                        with closing(sqlite3.connect(Path(self.temp.name)/name)) as target:
                            before=writer.execute('SELECT value FROM fixture').fetchone()[0]
                            reader.backup(target,pages=8,progress=progress,sleep=.001)
                            self.assertFalse(reader.in_transaction)
                            self.assertEqual(target.execute('SELECT value FROM fixture').fetchone()[0],before)
                            self.assertEqual(target.execute('PRAGMA integrity_check').fetchone()[0],'ok')
                    counts.append(calls)
                with self.assertRaisesRegex(RuntimeError,'BACKUP_RESTARTED_BY_EVERY_COMMIT'):
                    copy(sqlite3.Connection,'old-unpinned.sqlite3')
                copy(SnapshotConnection,'new-pinned.sqlite3')
                self.assertLess(counts[0],80)
                self.assertEqual(writer.execute('PRAGMA integrity_check').fetchone()[0],'ok')
                return {'old_backup_restarts_reproduced':True,'fixed_pages_callbacks':counts[0],'same_snapshot':True,'writer_continued':True}
        result=await asyncio.to_thread(verify)
        (Path(OPTIONS.output)/'concurrent-backup.json').write_text(json.dumps(result),'utf-8')

    async def test_interrupted_journal_recovers_unknown_without_send(self):
        # Reserve/dispatch directly to reproduce a process dying between its
        # durable permission and socket send; recovery must never retry it.
        body=self.intent();request=self.ui.request('commands.request',body)
        token=ACTOR.set(self.runtime.repo.actor('127.0.0.1'))
        try:record,_=self.runtime.journal.reserve(request,'mqtt')
        finally:ACTOR.reset(token)
        self.runtime.journal.transition(body['operation_id'],{'reserved'},'dispatching',attempt=True)
        await self.runtime.commands.close()
        # close() truthfully marks unknown; startup also must preserve it.
        self.runtime.journal.close()
        self.runtime.journal=Journal(self.runtime.repo,fixture_root=self.temp.name)
        self.runtime.commands.journal=self.runtime.journal
        result=self.runtime.journal.get(body['operation_id'])
        self.assertEqual(result['state'],'unknown');self.assertEqual(result['attempts'],1)
        self.assertEqual(sum(len(rx.executions) for rx in self.receivers),0)

    async def test_original_navigation_and_webcrypto_on_integrated_mqtt(self):
        if not OPTIONS.ws_bundle:self.skipTest('Node WebSocket fixture path required')
        root=Path(__file__).resolve().parents[2]
        args=['node',str(Path(__file__).with_name('mqttjs-stage6-live.cjs')),self.runtime.uri,
            self.runtime.material['ca_file'],str(root.parent/'FAshe/vendor/mqtt-5.10.4/mqtt.upstream.min.js'),OPTIONS.ws_bundle]
        run=await asyncio.to_thread(subprocess.run,args,capture_output=True,text=True,encoding='utf-8',timeout=40,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.assertEqual(run.returncode,0,run.stderr+run.stdout)
        result=json.loads(run.stdout.strip().splitlines()[-1]);self.assertTrue(result['ok'])
        (Path(OPTIONS.output)/'mqttjs-live.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')

    async def test_full_page_network_audit(self):
        if not OPTIONS.browser or not OPTIONS.playwright:self.skipTest('Isolated browser runtime required')
        from build_candidate import build
        static=build(Path(self.temp.name)/'static')
        runtime=self.runtime
        # Synthetic stored ZIP tests the real >64 MiB browser file path only;
        # it is not represented as a real business backup/restore fixture.
        from server_archive import digest,PROTOCOL
        large_id=oid();folder=runtime.archive._folder('archives',large_id);folder.mkdir(parents=True)
        path=folder/'archive.zip'
        with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_STORED) as output:
            with output.open('synthetic-transport-fixture.bin','w') as payload:
                block=bytes(range(256))*4096
                for _ in range(65):payload.write(block)
        large={'protocol':PROTOCOL,'id':large_id,'status':'saved','fileName':'MQTT大型下载.zip','mimeType':'application/zip',
               'sha256':digest(path),'bytes':path.stat().st_size,'createdAtMs':int(time.time()*1000),
               'actor':'network:127.0.0.1','source':'synthetic-transport-fixture','generation':oid()}
        runtime.archive._save(folder,large)
        class Handler(SimpleHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                if self.path.split('?')[0]=='/unirf-app.html':
                    raw=(static/'unirf-app.html').read_text('utf-8')
                    marker='<script src="src/mqtt6/browser-boot.js"></script>'
                    raw=raw.replace(marker,'<script>globalThis.__DATY_MQTT6_CONFIG='+json.dumps({'wssOrigin':runtime.uri,'verifyReadStream':True})+';</script>'+marker)
                    payload=raw.encode('utf-8');self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8')
                    self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
                else:super().do_GET()
        server=ThreadedHTTPSServer(('127.0.0.1',0),partial(Handler,directory=str(static)),tls_context=server_context(self.tls))
        origin=f'https://127.0.0.1:{server.server_port}'
        for path in ('/mqtt-app','/mqtt-readonly'):runtime.gateways[path].fixture_origins.add(origin)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            args=['node',str(Path(__file__).with_name('browser-stage6-live.cjs')),origin+'/unirf-app.html',
                runtime.material['certificate_file'],OPTIONS.playwright,OPTIONS.browser,str(Path(OPTIONS.output).resolve())]
            run=await asyncio.to_thread(subprocess.run,args,capture_output=True,text=True,encoding='utf-8',timeout=180,
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            self.assertEqual(run.returncode,0,run.stderr+run.stdout)
            verified=Path(OPTIONS.output)/'verified-large-download.zip'
            self.assertEqual(verified.stat().st_size,large['bytes']);self.assertEqual(digest(verified),large['sha256'])
            with zipfile.ZipFile(verified) as downloaded:self.assertIsNone(downloaded.testzip())
        finally:
            await asyncio.to_thread(server.shutdown);server.server_close();thread.join(3)

    async def test_original_review_dialogs_preserve_unknown_results(self):
        if not OPTIONS.browser or not OPTIONS.playwright:self.skipTest('Isolated browser runtime required')
        from build_candidate import build
        runtime=self.runtime;body=self.intent();request=self.ui.request('commands.request',body)
        token=ACTOR.set(runtime.repo.actor(self.ui.ip))
        try:runtime.journal.reserve(request,'mqtt')
        finally:ACTOR.reset(token)
        runtime.journal.transition(body['operation_id'],{'reserved'},'dispatching',attempt=True)
        runtime.journal.transition(body['operation_id'],{'dispatching'},'unknown',error='PROCESS_INTERRUPTED')
        scan=oid();request=self.ui.request('discovery.scan',{'operation_id':scan,'epoch':self.epoch,'expected_generation':0})
        actor=runtime.repo.actor(self.ui.ip)
        with runtime.repo.connection() as connection:
            connection.execute('BEGIN IMMEDIATE');record,_=runtime.data.prepare(connection,request,actor)
            runtime.repo.save_receipt(connection,record,actor);runtime.repo.commit(connection)
        await asyncio.to_thread(runtime.data.recover)
        fixture=Path(OPTIONS.output)/'review-fixture.json'
        fixture.write_text(json.dumps({'command_operation_id':body['operation_id'],'target':body['target'],'scan_operation_id':scan}),'utf-8')
        static=build(Path(self.temp.name)/'review-page')
        class Handler(SimpleHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                if self.path.split('?')[0]=='/unirf-app.html':
                    raw=(static/'unirf-app.html').read_text('utf-8');marker='<script src="src/mqtt6/browser-boot.js"></script>'
                    raw=raw.replace(marker,'<script>globalThis.__DATY_MQTT6_CONFIG='+json.dumps({'wssOrigin':runtime.uri})+';</script>'+marker)
                    payload=raw.encode('utf-8');self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8')
                    self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
                else:super().do_GET()
        server=ThreadedHTTPSServer(('127.0.0.1',0),partial(Handler,directory=str(static)),tls_context=server_context(self.tls));origin=f'https://127.0.0.1:{server.server_port}'
        for path in ('/mqtt-app','/mqtt-readonly'):runtime.gateways[path].fixture_origins.add(origin)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            run=await asyncio.to_thread(subprocess.run,['node',str(Path(__file__).with_name('browser-review-live.cjs')),origin+'/unirf-app.html',
                runtime.material['certificate_file'],OPTIONS.playwright,OPTIONS.browser,str(Path(OPTIONS.output).resolve()),str(fixture.resolve())],
                capture_output=True,text=True,encoding='utf-8',timeout=100,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            self.assertEqual(run.returncode,0,run.stderr+run.stdout)
            old=runtime.journal.get(body['operation_id']);self.assertEqual(old['state'],'unknown');self.assertIsNotNone(old['review'])
            self.assertEqual(old['attempts'],1);self.assertIsNone(old['execution_evidence'])
            self.assertEqual(runtime.bus.metrics['outlet_sends'],1)
            self.assertEqual(sum(len(receiver.executions) for receiver in self.receivers),1)
            self.assertIsNone(runtime.data.active_scan)
            with runtime.repo.connection() as connection:
                old_scan=runtime.repo.get_receipt(connection,scan,actor)
                self.assertEqual(old_scan['state'],'unknown');self.assertIsNotNone(old_scan['review'])
            self.assertEqual(runtime.discovery.snapshot()['generation'],0)
        finally:
            await asyncio.to_thread(server.shutdown);server.server_close();thread.join(3)

    async def test_two_original_fashe_windows_100ch(self):
        if not OPTIONS.browser or not OPTIONS.playwright:self.skipTest('Isolated browser runtime required')
        from build_candidate import build_fashe,build
        static=build_fashe(Path(self.temp.name)/'fashe-static');runtime=self.runtime
        build(static/'server')
        timings={}
        if OPTIONS.measure:
            def wrap(owner,name):
                original=getattr(owner,name);stats=timings.setdefault(name,{'calls':0,'milliseconds':0})
                def measured(*args,**kwargs):
                    if threading.get_ident()!=getattr(runtime.bus,'consumer_thread',None):return original(*args,**kwargs)
                    began=time.perf_counter()
                    try:return original(*args,**kwargs)
                    finally:stats['calls']+=1;stats['milliseconds']+=(time.perf_counter()-began)*1000
                setattr(owner,name,measured)
            for name in ('_get_devices_snapshot','_queue_unified_snapshot','_canonical_fashe_id','_claim_receiver_source','_bind_receiver_aliases','_record_device_state','_push_sse_event'):
                wrap(runtime.b,name)
            for name in ('is_active','validate_payload'):wrap(runtime.b._pairing_policy,name)
        registry=json.loads(self.fixture.path.read_text())
        # Registry GROUP assignments are unique per receiver. Move only the two
        # unused static fixture identities; keep the production validator intact.
        registry['receiver_groups'].update({'02:00:00:00:00:98':21,'02:00:00:00:00:99':24,
            '02:00:00:00:00:01':11,'02:00:00:00:00:02':4})
        self.fixture.path.write_text(json.dumps(registry))
        class Handler(SimpleHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                if self.path.split('?')[0]=='/index.html':
                    raw=(static/'index.html').read_text('utf-8');marker='  <script src="src/mqtt6/fashe-mqtt.js"></script>'
                    raw=raw.replace(marker,'<script>globalThis.__FASHE_MQTT6_CONFIG='+json.dumps({'wssOrigin':runtime.uri})+';</script>'+marker)
                    payload=raw.encode('utf-8');self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8')
                    self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
                elif self.path.split('?')[0]=='/server/unirf-app.html':
                    raw=(static/'server/unirf-app.html').read_text('utf-8');marker='<script src="src/mqtt6/browser-boot.js"></script>'
                    raw=raw.replace(marker,'<script>globalThis.__DATY_MQTT6_CONFIG='+json.dumps({'wssOrigin':runtime.uri,'verifyReadStream':True})+';</script>'+marker)
                    payload=raw.encode('utf-8');self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8')
                    self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
                else:super().do_GET()
        server=ThreadedHTTPSServer(('127.0.0.1',0),partial(Handler,directory=str(static)),tls_context=server_context(self.tls))
        origin=f'https://127.0.0.1:{server.server_port}'
        runtime.gateways['/mqtt-enrollment'].fixture_origins.add(origin);runtime.fixture_receiver_origins.add(origin)
        for path in ('/mqtt-app','/mqtt-readonly'):runtime.gateways[path].fixture_origins.add(origin)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            args=['node',str(Path(__file__).with_name('fashe-stage6-live.cjs')),origin+'/index.html',runtime.uri,
                runtime.material['certificate_file'],OPTIONS.playwright,OPTIONS.browser,str(Path(OPTIONS.output).resolve()),str(OPTIONS.load_seconds)]
            async def sample_metrics():
                with (Path(OPTIONS.output)/'load-metrics.jsonl').open('w',encoding='utf-8') as metrics:
                    began=time.monotonic()
                    while True:
                        state={'elapsed_s':round(time.monotonic()-began,3),'dispatch':runtime.b._mqtt_dispatch_status(),
                            'bus':dict(runtime.bus.metrics),'persistence':runtime.b.get_unified_runtime_status(),'readonly':runtime.view.metrics,'feed':runtime.feed.status(),
                            'database_bytes':Path(runtime.b._db_path).stat().st_size,
                            'data_error_responses':dict(runtime.data.error_response_metrics)}
                        metrics.write(json.dumps(state)+'\n');metrics.flush()
                        request=Path(OPTIONS.output)/'drain.request.json';reply=Path(OPTIONS.output)/'drain.reply.json'
                        if request.is_file() and not reply.exists():
                            await eventually(lambda:runtime.b._mqtt_dispatch_status()['queue_count']==0 and not runtime.bus.inflight_batches,timeout=12)
                            persisted=await asyncio.to_thread(runtime.b._unified_runtime.wait_idle,8)
                            await eventually(lambda:runtime.feed.status()['queued_events']==0,timeout=8)
                            with runtime.repo.connection() as connection:
                                rows=[dict(row) for row in connection.execute('''SELECT c.channel_number,r.receiver_mac,l.frequency_khz,l.af_dbfs,l.rf_dbm,l.muted,l.declared_online
                                    FROM live_latest l JOIN live_channels c ON c.device_id=l.device_id JOIN live_receivers r ON r.receiver_id=c.receiver_id
                                    WHERE r.receiver_mac IN ('02:00:00:00:00:01','02:00:00:00:00:02') ORDER BY r.receiver_mac,c.channel_number''')]
                                sample_count=connection.execute('SELECT count(*) FROM live_samples').fetchone()[0]
                            clock=runtime.b._clock_status_snapshot()
                            evidence={'persistence':persisted,'bus':dict(runtime.bus.metrics),'dispatch':runtime.b._mqtt_dispatch_status(),
                                'feed':runtime.feed.status(),'rows':rows,'sample_count':sample_count,'clock':clock}
                            temporary=reply.with_suffix('.pending');temporary.write_text(json.dumps(evidence),'utf-8');temporary.replace(reply)
                        await asyncio.sleep(1)
            sampler=asyncio.create_task(sample_metrics())
            browser_completed=asyncio.Event()
            async def archive_under_load():
                progress_path=Path(OPTIONS.output)/'browser-soak-progress.json'
                browser_start=await wait_active_load(progress_path,browser_completed)
                # The raw framing peer intentionally has no background MQTT
                # keepalive. Open a dedicated session when the workload starts;
                # do not reuse the setup peer after its 10-second idle lease.
                archive_ui=await self.new_ui()
                async def archive_rpc(method,body):return await self.rpc(method,body,ui=archive_ui)
                started=time.monotonic()
                record=(await archive_rpc('archives.create',{'operation_id':oid()}))['result']
                deadline=time.monotonic()+120
                while record['status'] in ('queued','running') and time.monotonic()<deadline:
                    await asyncio.sleep(.2);record=await archive_rpc('archives.get',{'id':record['id']})
                self.assertEqual(record['status'],'saved',record)
                browser_saved=await asyncio.to_thread(read_progress,progress_path)
                saved_during_load=(not browser_completed.is_set() and active_load(browser_saved)
                    and not (Path(OPTIONS.output)/'drain.request.json').exists())
                self.assertTrue(saved_during_load,'Archive did not finish before the load stopped')
                operation=await archive_rpc('downloads.open',{'operation_id':oid(),'category':'archives','id':record['id'],'sha256':record['sha256']})
                while operation['state']=='preparing':
                    await asyncio.sleep(.1);operation=await archive_rpc('file.operations.get',{'operation_id':operation['id']})
                self.assertEqual(operation['state'],'completed',operation)
                descriptor=operation['result'];destination=Path(OPTIONS.output)/'load-archive.zip';digest=hashlib.sha256()
                with destination.open('wb') as output:
                    for offset in range(0,descriptor['bytes'],128*1024):
                        part=await archive_rpc('downloads.chunk',{'download_id':descriptor['id'],'offset':offset,'sha256':descriptor['sha256']})
                        raw=base64.b64decode(part['data']);self.assertEqual(hashlib.sha256(raw).hexdigest(),part['sha256'])
                        output.write(raw);digest.update(raw)
                self.assertEqual(digest.hexdigest(),record['sha256']);self.assertEqual(destination.stat().st_size,record['bytes'])
                await archive_rpc('downloads.close',{'download_id':descriptor['id']})
                await archive_ui.close()
                def inspect_archive():
                    restored=Path(self.temp.name)/'load-archive-restored.sqlite3'
                    with zipfile.ZipFile(destination) as archive:
                        names=[name for name in archive.namelist() if name.endswith(('.sqlite3','.sqlite','.db'))]
                        self.assertEqual(len(names),1)
                        with archive.open(names[0]) as input,restored.open('wb') as output:
                            import shutil
                            shutil.copyfileobj(input,output,1024*1024)
                    with closing(sqlite3.connect(restored)) as connection:
                        validate_schema(connection);self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone()[0],'ok')
                        self.assertEqual(connection.execute('PRAGMA foreign_key_check').fetchall(),[])
                        return connection.execute('SELECT count(*) FROM live_samples').fetchone()[0]
                samples=await asyncio.to_thread(inspect_archive)
                (Path(OPTIONS.output)/'load-archive-result.json').write_text(json.dumps({'ok':True,'bytes':record['bytes'],
                    'sha256':record['sha256'],'snapshot_samples':samples,'elapsed_s':time.monotonic()-started,
                    'saved_during_100ch_load':saved_during_load,'browser_started_utc':browser_start['started_utc'],
                    'archive_started_at_load_seconds':browser_start['elapsed_seconds'],
                    'archive_saved_at_load_seconds':browser_saved['elapsed_seconds']}),'utf-8')
            archive_job=asyncio.create_task(archive_under_load()) if OPTIONS.mixed_archive else None
            try:run=await asyncio.to_thread(subprocess.run,args,capture_output=True,text=True,encoding='utf-8',timeout=OPTIONS.load_seconds+120,
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            finally:
                browser_completed.set()
                sampler.cancel();sample_result=await asyncio.gather(sampler,return_exceptions=True)
                if archive_job:await archive_job
                for error in sample_result:
                    if isinstance(error,Exception):raise error
            (Path(OPTIONS.output)/'fashe-host-output.txt').write_text(run.stderr+run.stdout,'utf-8')
            persistence=runtime.b.get_unified_runtime_status()
            (Path(OPTIONS.output)/'receiver-timings.json').write_text(json.dumps(timings,indent=2),'utf-8')
            (Path(OPTIONS.output)/'fashe-server-metrics.json').write_text(json.dumps({'bus':runtime.bus.metrics,'persistence':persistence,
                'dispatch':runtime.b._mqtt_dispatch_status(),'readonly':runtime.view.metrics,
                'app_failures':runtime.gateways['/mqtt-app'].failures},indent=2),'utf-8')
            self.assertEqual(run.returncode,0,run.stderr+run.stdout)
            self.assertEqual(runtime.bus.metrics['failures'],0,runtime.bus.metrics)
            browser_result=json.loads((Path(OPTIONS.output)/'fashe-browser-result.json').read_text('utf-8'))
            self.assertEqual(len(browser_result['read_verification']),1)
            for receipt in browser_result['read_verification']:
                self.assertIn(receipt,runtime.view.verification,'Browser stream bytes differ from server publication sequence')
            self.assertGreater(runtime.bus.metrics['consumed_channel_observations'],20000)
            self.assertTrue(persistence['complete'],persistence)
            self.assertEqual(runtime.b._mqtt_dispatch_status()['refused'],0)
            drain=json.loads((Path(OPTIONS.output)/'drain.reply.json').read_text('utf-8'))
            self.assertEqual(drain['bus']['stale'],0,drain['bus'])
            self.assertEqual(drain['persistence']['outstanding'],0,drain['persistence'])
            self.assertTrue(drain['persistence']['complete'],drain['persistence'])
            self.assertEqual(len(drain['rows']),100)
            self.assertEqual(drain['clock']['rtt_method'],'server_monotonic_send_ack')
            self.assertGreaterEqual(len([x for x in drain['clock']['clients'] if x.get('status')=='synced' and isinstance(x.get('rtt_ms'),(int,float)) and x['rtt_ms']>=0]),2)
        finally:
            await asyncio.to_thread(server.shutdown);server.server_close();thread.join(3)

    async def test_candidate_alert_edges_and_recommendation_equivalence(self):
        from build_candidate import build,ROOT
        candidate=build(Path(self.temp.name)/'ui-comparison')
        for script in ('candidate-regression.cjs','alert-incremental-regression.cjs'):
            result=await asyncio.to_thread(subprocess.run,['node',str(Path(__file__).with_name(script)),str(ROOT),str(candidate)],
                capture_output=True,text=True,encoding='utf-8',timeout=30,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            (Path(OPTIONS.output)/(Path(script).stem+'.txt')).write_text(result.stdout+result.stderr,'utf-8')
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    async def test_packet_registry_refreshes_after_wait_and_outside_worker(self):
        registry=self.runtime.bus.registry_view;policy=self.fixture.policy
        credential=self.fixture.credentials[0]
        with self.b._broker_lock:
            principal=next(s['pairing'] for s in self.b._broker_clients.values() if s['pairing']['receiver_mac']==credential.receiver_mac)
        def verify():
            with registry.packet():
                self.assertTrue(policy.is_active(principal))
                data=json.loads(self.fixture.path.read_text('utf-8'))
                next(item for item in data['receivers'] if item['credential_id']==principal['credential_id'])['revoked']=True
                self.fixture.path.write_text(json.dumps(data))
                registry.refresh()  # Same hook invoked after persistence backpressure.
                self.assertFalse(policy.is_active(principal))
            self.assertFalse(policy.is_active(principal))
        await asyncio.to_thread(verify)

    async def test_project_history_order_keeps_real_conflict_protection(self):
        from build_candidate import build,ROOT
        candidate=build(Path(self.temp.name)/'history-comparison')
        result=await asyncio.to_thread(subprocess.run,['node',str(Path(__file__).with_name('project-history-order.cjs')),str(ROOT),str(candidate)],
            capture_output=True,text=True,encoding='utf-8',timeout=30,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        (Path(OPTIONS.output)/'history-order-equivalence.txt').write_text(result.stdout+result.stderr,'utf-8')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    async def test_readonly_waits_for_client_ack_and_preserves_queued_events(self):
        from mqtt_wire import WSReader,packet,utf,string,number
        import websockets
        uri=self.runtime.uri+'/mqtt-readonly'
        async with websockets.connect(uri,ssl=client_context(self.tls),subprotocols=['mqtt'],proxy=None) as ws:
            reader=WSReader(ws)
            await ws.send(packet(0x10,utf('MQTT')+b'\x05\x02\x00\x0a\x00'+utf('')))
            self.assertEqual((await reader.read())[0],0x20)
            await ws.send(packet(0x82,b'\x00\x01\x00'+utf('daty/v2/daty-rf-pro/devices/read')+b'\x01'))
            self.assertEqual((await reader.read())[0],0x90)
            header,body=await reader.read();self.assertEqual(header,0x32)
            _,offset=string(body);mid=body[offset:offset+2]
            snapshot=self.b._get_devices_snapshot()[0]
            for n in range(130):self.b._push_sse_event('device_update',[{**snapshot,'fixture_sequence':n}])
            # Suppressing ACK must not allow the producer to flood the Broker.
            with self.assertRaises(asyncio.TimeoutError):await asyncio.wait_for(reader.read(),.2)
            self.assertEqual(self.runtime.view.metrics['publications'],0)
            await ws.send(packet(0x40,mid))
            observed=[]
            while len(observed)<130:
                header,body=await asyncio.wait_for(reader.read(),2)
                _,offset=string(body);mid=body[offset:offset+2];size,start=number(body,offset+2)
                envelope=json.loads(body[start+size:])
                for event in envelope['payload']['events']:
                    observed.extend(d['fixture_sequence'] for d in event['payload']['devices'] if 'fixture_sequence' in d)
                await ws.send(packet(0x40,mid))
            self.assertEqual(observed,list(range(130)))
            state=await asyncio.to_thread(self.b._unified_runtime.wait_idle,5)
            self.assertTrue(state['complete'],state)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--broker',required=True);parser.add_argument('--paho-root')
    parser.add_argument('--output',required=True);parser.add_argument('--case');parser.add_argument('--ws-bundle')
    parser.add_argument('--browser');parser.add_argument('--playwright')
    parser.add_argument('--load-seconds',type=int,default=60)
    parser.add_argument('--measure',action='store_true')
    parser.add_argument('--mixed-archive',action='store_true')
    OPTIONS=parser.parse_args();out=Path(OPTIONS.output);out.mkdir(parents=True,exist_ok=True)
    suite=unittest.defaultTestLoader.loadTestsFromName(OPTIONS.case,Integration) if OPTIONS.case else unittest.defaultTestLoader.loadTestsFromTestCase(Integration)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    (out/'result.json').write_text(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),
        'passed':result.wasSuccessful(),'evidence':EVIDENCE,'soak_started':False},ensure_ascii=False,indent=2),'utf-8')
    sys.exit(not result.wasSuccessful())
