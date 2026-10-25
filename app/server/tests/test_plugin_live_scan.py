"""MQTT/TLS/SQLite scan lifecycle with a socket-free, isolated adapter fixture."""
import asyncio
import base64
import copy
import hashlib
import json
import threading
import time
import unittest
import uuid
from unittest.mock import patch

from plugin_scan import RANGE
from plugin_install import PluginError
from test_shure_package_v2 import current_package
from test_stage6 import Integration
from m6_test_support import eventually


class FakeScan:
    instances = []
    mode = 'complete'
    open_gate = None
    close_gate = None

    def __init__(self, address, *, range_evidence=None):
        self.address=address;self.started=0;self.cancelled=0;self.closed=False
        self.range_evidence=range_evidence
        self.phase='ready';self.ticks=0;self.actual={**RANGE,'verified':True,'evidence':'current_scan_configuration_not_hardware_band'}
        self.__class__.instances.append(self)

    def open(self, timeout=12):
        if self.open_gate is not None:assert self.open_gate.wait(5)
        if self.mode=='range-mismatch':self.actual['end_khz']-=25

    def start(self, **options):
        assert options==RANGE
        self.started+=1;self.phase='starting' if self.mode.startswith('handshake') else 'scanning'

    def poll(self, timeout=.1):
        time.sleep(.01);self.ticks+=1
        if self.cancelled:self.phase='cancelled'
        elif self.mode=='handshake-fail' and self.ticks>=4:self.phase='failed'
        elif self.mode not in ('hold','handshake','cancel-unconfirmed') and self.ticks>=4:self.phase='completed'

    def snapshot(self):
        points=[[k,-90.5] for k in range(RANGE['start_khz'],RANGE['end_khz']+1,RANGE['step_khz'])] if self.started else []
        if points and self.mode.startswith('partial'):points[-1][1]=None
        handshake=self.mode.startswith('handshake')
        if handshake:points=[[point[0],None] for point in points]
        return {'state':self.phase,'actual_range':self.actual,'points':points,
                'range_evidence':self.range_evidence,'range_profile_confirmed':self.mode!='range-mismatch',
                'start_sent':bool(self.started) and not handshake,'device_started':bool(self.started) and not handshake,
                'device_ended':self.phase in ('completed','cancelled') and not handshake and self.mode!='cancel-unconfirmed',
                'session_state':('cancelled' if self.cancelled else 'failed' if self.phase=='failed' else 'confirming') if handshake else 'ready',
                'session_established':not handshake,'error':'SCAN_SESSION_KEY_STATUS_TIMEOUT' if self.phase=='failed' else None,
                'private_intermediate':'FIXTURE_NOT_A_REAL_KEY',
                'coverage_complete':bool(points) and not self.mode.startswith('partial') and not handshake,
                'max_progress':100 if self.mode=='partial-reset' and self.phase=='completed' else None,
                'progress':0 if self.mode=='partial-reset' and self.phase=='completed' else 100 if self.phase=='completed' else None if handshake else 10}

    def cancel(self):self.cancelled+=1
    def close(self):
        if self.close_gate is not None:assert self.close_gate.wait(5)
        self.closed=True


class LiveScan(Integration):
    async def setup_scan(self, mode='complete'):
        raw=current_package();encoded=base64.b64encode(raw).decode()
        view=await self.rpc('plugins.preview',{'package_base64':encoded})
        await self.rpc('plugins.install',{'package_base64':encoded,'sha256':view['sha256'],
            'expected_revision':view['revision'],'operation_id':uuid.uuid4().hex})
        item=self.runtime.plugins.active['shure-scp']
        item['scan_live']=FakeScan;FakeScan.instances=[];FakeScan.mode=mode;FakeScan.open_gate=None;FakeScan.close_gate=None
        self.rid='Shure-ULXD4-scan-fixture';self.did=self.rid+'_ch1'
        await self.rpc('database.write',{'kind':'settings','id':'shure_scan_profiles','operation_id':uuid.uuid4().hex,'epoch':self.epoch,
            'expected_revision':0,'value':{'schema':'daty-shure-scan-profiles-v1','receivers':[{'receiver_mac':'00:0E:DD:AD:31:A3','model':'ULXD4','band':'L51',
                'source':'user-confirmed-chassis-label','scan_range_khz':copy.deepcopy(RANGE),'evidence_id':'isolated-fixture'}]}})
        self.runtime.plugins.scans.refresh_profiles()
        now=int(time.time()*1000)
        self.b._accept_shure_observation({'receiver_id':self.rid,'receiver_ip':'127.0.0.1','model':'ULXD4','protocol_verified':True,
            'settings':{'receiver_mac':'00:0E:DD:AD:31:A3','network_ip':'127.0.0.1'},
            'settings_field_times':{'receiver_mac':now,'network_ip':now},
            'channels':{'1':{'channel_number':1,'frequency_khz':632700,'meter_state':'live','meter_stream_id':'a'*32,
                'meter_received_at_ms':now,'field_times':{'frequency_khz':now}}}})
        return item

    def start_body(self):
        return {'plugin_id':'shure-scp','operation_id':uuid.uuid4().hex,'epoch':self.epoch,
                'device_id':self.did,'options':copy.deepcopy(RANGE)}

    async def wait_scan(self, operation):
        for _ in range(100):
            status=await self.rpc('plugins.scan.status',{'plugin_id':'shure-scp','operation_id':operation})
            if status['finalized'] and status['state'] in ('completed','partial','cancelled','interrupted','failed','unknown','not_started'):
                await eventually(lambda:not self.runtime.plugins.scans.jobs[operation]['thread'].is_alive())
                return status
            await asyncio.sleep(.03)
        self.fail('scan did not settle')

    async def test_chassis_profile_save_readback_conflict_reconnect_and_scan_without_restart(self):
        await self.setup_scan()
        empty={'schema':'daty-shure-scan-profiles-v1','receivers':[]}
        async def save(value,revision):
            return await self.rpc('database.write',{'kind':'settings','id':'shure_scan_profiles','operation_id':uuid.uuid4().hex,
                'epoch':self.epoch,'expected_revision':revision,'value':value})
        async def snapshot():
            return next(d for d in (await self.rpc('devices.snapshot'))['devices'] if d['id']==self.did)
        async def read():
            return (await self.rpc('database.resources.get',{'kind':'settings','id':'shure_scan_profiles'}))['body']['resource']
        await save(empty,1);await self.rpc('plugins.status')
        before=await snapshot();self.assertFalse(before['capabilities']['scan'])
        self.assertEqual(before['capabilities']['scan_unavailable_reason'],'SCAN_HARDWARE_PROFILE_REQUIRED')
        row={'receiver_mac':'00:0E:DD:AD:31:A3','model':'ULXD4','band':'L51','source':'user-confirmed-chassis-label',
             'scan_range_khz':copy.deepcopy(RANGE),'evidence_id':'chassis-label-isolated-fixture'}
        other={**row,'receiver_mac':'00:0E:DD:AD:31:A4','evidence_id':'other-chassis'}
        value={**empty,'receivers':[other,row]}
        receipt=await save(value,2);self.assertEqual(receipt['body']['resource']['revision'],3)
        committed=await read();self.assertEqual(committed['value'],value);self.assertEqual(committed['revision'],3)
        conflict=await self.ui.call('database.write',{'kind':'settings','id':'shure_scan_profiles','operation_id':uuid.uuid4().hex,
            'epoch':self.epoch,'expected_revision':2,'value':empty})
        self.assertTrue(conflict['ok']);self.assertEqual(conflict['result']['status'],409);self.assertIn('RESOURCE_REVISION_CONFLICT',json.dumps(conflict))
        self.assertEqual((await read())['value'],value)
        await self.rpc('plugins.status');self.assertTrue((await snapshot())['capabilities']['scan'])
        self.assertEqual(FakeScan.instances,[],'saving a label must never start a receiver scan')
        await self.ui.close();self.ui=await self.new_ui()
        self.assertEqual((await read())['value'],value)
        self.assertTrue((await snapshot())['capabilities']['scan'])
        body=self.start_body();await self.rpc('plugins.scan.start',body);result=await self.wait_scan(body['operation_id'])
        self.assertEqual(result['state'],'completed');self.assertTrue(result['complete'])
        self.assertEqual(len(FakeScan.instances),1);self.assertEqual(FakeScan.instances[0].started,1)
        self.assertEqual(FakeScan.instances[0].range_evidence['receiver_mac'],row['receiver_mac'])
        self.assertEqual(FakeScan.instances[0].range_evidence['evidence_id'],row['evidence_id'])
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))

    async def test_chassis_label_never_overrides_reported_band_or_stale_identity(self):
        item=await self.setup_scan();scans=self.runtime.plugins.scans
        original=next(d for d in self.b._get_devices_snapshot() if d['id']==self.did)
        self.assertTrue(scans.capability(item,original)['scan'])
        for field,value,reason in [('rf_band','G50','SCAN_HARDWARE_BAND_UNSUPPORTED'),('receiver_mac','invalid','SCAN_RECEIVER_IDENTITY_UNAVAILABLE')]:
            device=copy.deepcopy(original);device['shure']['settings'][field]=value
            if field=='receiver_mac':device['receiver_mac']=value
            capability=scans.capability(item,device);self.assertFalse(capability['scan']);self.assertEqual(capability['scan_unavailable_reason'],reason)
        for field in ('settings.receiver_mac','settings.rf_band'):
            device=copy.deepcopy(original);device['shure']['stale_fields']=[field]
            self.assertFalse(scans.capability(item,device)['scan'])
        device=copy.deepcopy(original);device['model']='ULXD4D';self.assertFalse(scans.capability(item,device)['scan'])
        device=copy.deepcopy(original);device['receiver_mac']='00:0E:DD:AD:31:A5';device['shure']['settings']['receiver_mac']=device['receiver_mac']
        self.assertFalse(scans.capability(item,device)['scan'],'another MAC must not inherit a chassis label')
        scans.profiles={};device=copy.deepcopy(original);device['shure']['settings']['rf_band']='L51'
        self.assertTrue(scans.capability(item,device)['scan'],'receiver-reported supported band does not need a manual label')
        self.assertEqual(FakeScan.instances,[])

    async def test_durable_intent_complete_reconnect_and_no_point_history(self):
        await self.setup_scan();body=self.start_body()
        result=await self.rpc('plugins.scan.start',body)
        self.assertEqual(result['state'],'starting');self.assertTrue(result['accepted']);self.assertFalse(result['complete'])
        await self.ui.close();self.ui=await self.new_ui()
        result=await self.wait_scan(body['operation_id'])
        self.assertEqual(result['state'],'completed');self.assertTrue(result['complete'])
        self.assertEqual(result['received_points'],2551);self.assertEqual(result['missing_points'],0)
        repeated=await self.rpc('plugins.scan.start',body)
        self.assertTrue(repeated['replayed']);self.assertEqual(FakeScan.instances[0].started,1)
        receipt=(await self.rpc('operations.get',{'operation_id':body['operation_id']}))['body']['operation']
        self.assertEqual(receipt['state'],'completed');self.assertEqual(receipt['result']['body']['points'],[])
        self.assertFalse(receipt['result']['body']['data_available'])
        with self.runtime.repo.connection() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM db_scan_points').fetchone()[0],0)
        self.assertTrue(FakeScan.instances[0].closed)
        self.assertTrue(all(not r.executions for r in self.receivers))

    async def test_partial_range_probe_failure_and_validation(self):
        await self.setup_scan('partial');body=self.start_body()
        await self.rpc('plugins.scan.start',body);result=await self.wait_scan(body['operation_id'])
        self.assertEqual(result['state'],'partial');self.assertFalse(result['complete'])
        self.assertEqual(result['points'][-1][1],None);self.assertEqual(result['missing_points'],1)
        FakeScan.mode='range-mismatch';body=self.start_body();await self.rpc('plugins.scan.start',body)
        result=await self.wait_scan(body['operation_id'])
        self.assertEqual(result['state'],'not_started');self.assertEqual(result['error'],'SCAN_RECEIVER_RANGE_UNCONFIRMED')
        self.assertEqual(FakeScan.instances[-1].started,0)
        invalid=self.start_body();invalid['options']['start_khz']+=25
        response=await self.ui.call('plugins.scan.start',invalid)
        self.assertFalse(response['ok']);self.assertIn('SCAN_RANGE_NOT_VERIFIED',json.dumps(response))
        invalid=self.start_body();invalid['receiver_ip']='192.0.2.99'
        response=await self.ui.call('plugins.scan.start',invalid)
        self.assertFalse(response['ok'])

    async def test_cancel_idempotent_target_busy_and_plugin_removal(self):
        item=await self.setup_scan('hold');body=self.start_body();await self.rpc('plugins.scan.start',body)
        await eventually(lambda:bool(FakeScan.instances) and FakeScan.instances[0].started==1)
        busy=await self.ui.call('plugins.scan.start',self.start_body())
        self.assertFalse(busy['ok']);self.assertIn('SCAN_RECEIVER_BUSY',json.dumps(busy))
        cancel={'plugin_id':'shure-scp','operation_id':uuid.uuid4().hex,'epoch':self.epoch,'scan_operation_id':body['operation_id']}
        result=await self.rpc('plugins.scan.cancel',cancel);self.assertEqual(result['state'],'cancel_requested')
        await self.rpc('plugins.scan.cancel',cancel)
        result=await self.wait_scan(body['operation_id']);self.assertEqual(result['state'],'cancelled')
        self.assertEqual(FakeScan.instances[0].cancelled,1)
        body=self.start_body();await self.rpc('plugins.scan.start',body)
        await eventually(lambda:len(FakeScan.instances)==2 and FakeScan.instances[1].started==1)
        self.runtime.plugins.removal.draining.add('shure-scp')
        self.assertTrue(self.runtime.plugins.removal.busy({'id':'shure-scp','brand':'Shure'}))
        rejected=await self.ui.call('plugins.scan.start',self.start_body());self.assertFalse(rejected['ok'])
        result=await self.wait_scan(body['operation_id']);self.assertTrue(FakeScan.instances[1].closed)
        self.runtime.plugins.removal.draining.discard('shure-scp')
        self.assertFalse(self.runtime.plugins.scans.busy('shure-scp'))

    async def test_terminal_progress_reset_retains_observed_peak_without_completing_missing_data(self):
        await self.setup_scan('partial-reset');body=self.start_body()
        await self.rpc('plugins.scan.start',body);result=await self.wait_scan(body['operation_id'])
        self.assertEqual(result['progress'],100);self.assertEqual(result['state'],'partial')
        self.assertTrue(result['device_ended']);self.assertFalse(result['complete']);self.assertFalse(result['coverage_complete'])
        self.assertEqual(result['received_points'],2550);self.assertEqual(result['missing_points'],1);self.assertIsNone(result['points'][-1][1])
        receipt=(await self.rpc('operations.get',{'operation_id':body['operation_id']}))['body']['operation']
        self.assertEqual(receipt['result']['body']['progress'],100);self.assertFalse(receipt['result']['body']['complete'])
        raw=FakeScan.instances[-1].snapshot()
        cases=[{'max_progress':value} for value in (None,99,True,'100',float('nan'),float('inf'),101,-1)]
        cases.extend([{'device_ended':False},{'points':[]},{'state':'scanning'}])
        for changes in cases:
            with self.subTest(changes=changes):
                job={'started':True,'view':copy.deepcopy(result)}
                self.runtime.plugins.scans._update(job,{**raw,'progress':42,**changes})
                self.assertEqual(job['view']['progress'],42)
                self.assertFalse(job['view']['complete'])
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))

    async def test_gate_missing_old_plugin_wrong_owner_and_restart_no_replay(self):
        self.did='Shure-none_ch1'
        result=await self.ui.call('plugins.scan.start',self.start_body())
        self.assertFalse(result['ok']);self.assertIn('BRAND_PLUGIN_NOT_INSTALLED',json.dumps(result))
        item=await self.setup_scan('hold');item['scan_live']=None
        result=await self.ui.call('plugins.scan.start',self.start_body())
        self.assertFalse(result['ok']);self.assertIn('SCAN_ADAPTER_NOT_INSTALLED',json.dumps(result))
        item['scan_live']=FakeScan;body=self.start_body();await self.rpc('plugins.scan.start',body)
        await eventually(lambda:bool(FakeScan.instances) and FakeScan.instances[0].started==1)
        other=await self.new_ui('127.0.0.2')
        result=await other.call('plugins.scan.status',{'plugin_id':'shure-scp','operation_id':body['operation_id']})
        self.assertFalse(result['ok']);self.assertIn('OPERATION_OWNER_MISMATCH',json.dumps(result))
        job=self.runtime.plugins.scans.jobs[body['operation_id']]
        job['cancel'].set();await eventually(lambda:not job['thread'].is_alive())
        with self.runtime.repo.connection() as c:
            c.execute('BEGIN IMMEDIATE')
            record=job['record'];record['state']='accepted'
            self.runtime.repo.save_receipt(c,record,job['actor']);self.runtime.repo.commit(c)
        self.runtime.plugins.scans.jobs.clear()
        await asyncio.to_thread(self.runtime.data.recover)
        result=await self.rpc('plugins.scan.status',{'plugin_id':'shure-scp','operation_id':body['operation_id']})
        self.assertEqual(result['state'],'unknown');self.assertFalse(result['complete']);self.assertFalse(result['data_available'])
        self.assertEqual(len(FakeScan.instances),1)

    async def test_durable_claim_failure_never_constructs_or_starts_adapter(self):
        await self.setup_scan()
        with patch.object(self.runtime.repo,'save_receipt',side_effect=PluginError('FIXTURE_DATABASE_UNAVAILABLE',503)):
            result=await self.ui.call('plugins.scan.start',self.start_body())
        self.assertFalse(result['ok']);self.assertEqual(FakeScan.instances,[])
        self.assertEqual(self.runtime.plugins.scans.jobs,{})
        self.assertTrue(all(not r.executions for r in self.receivers))

    async def test_missing_mac_bound_profile_never_attempts_network_scan(self):
        await self.setup_scan()
        await self.rpc('database.write',{'kind':'settings','id':'shure_scan_profiles','operation_id':uuid.uuid4().hex,'epoch':self.epoch,
            'expected_revision':1,'value':{'schema':'daty-shure-scan-profiles-v1','receivers':[]}})
        result=await self.ui.call('plugins.scan.start',self.start_body())
        self.assertFalse(result['ok']);self.assertIn('SCAN_HARDWARE_PROFILE_REQUIRED',json.dumps(result))
        self.assertEqual(FakeScan.instances,[])

    async def test_accepted_scan_outlives_request_connection(self):
        await self.setup_scan();gate=threading.Event();FakeScan.open_gate=gate
        try:
            body=self.start_body();await self.rpc('plugins.scan.start',body)
            await self.ui.close();self.ui=await self.new_ui()
            gate.set();result=await self.wait_scan(body['operation_id'])
            self.assertEqual(result['state'],'completed');self.assertEqual(FakeScan.instances[0].started,1)
        finally:gate.set();FakeScan.open_gate=None

    async def test_handshake_cancel_is_not_started_and_never_confirms_device_cancel(self):
        await self.setup_scan('handshake')
        for remove in (False,True):
            body=self.start_body();await self.rpc('plugins.scan.start',body)
            await eventually(lambda:self.runtime.plugins.scans.jobs[body['operation_id']]['view']['handshake_state']=='confirming')
            status=await self.rpc('plugins.scan.status',{'plugin_id':'shure-scp','operation_id':body['operation_id']})
            self.assertEqual(status['state'],'starting');self.assertFalse(status['start_sent']);self.assertFalse(status['handshake_complete'])
            self.assertEqual(status['received_points'],0);self.assertTrue(all(p[1] is None for p in status['points']))
            self.assertNotIn('FIXTURE_NOT_A_REAL_KEY',json.dumps(status))
            if remove:
                self.runtime.plugins.removal.draining.add('shure-scp')
                self.assertTrue(self.runtime.plugins.removal.busy({'id':'shure-scp','brand':'Shure'}))
            else:
                cancel={'plugin_id':'shure-scp','operation_id':uuid.uuid4().hex,'epoch':self.epoch,'scan_operation_id':body['operation_id']}
                await self.rpc('plugins.scan.cancel',cancel);await self.rpc('plugins.scan.cancel',cancel)
            status=await self.wait_scan(body['operation_id'])
            self.assertEqual(status['state'],'not_started');self.assertEqual(status['error'],'SCAN_CANCELLED_BEFORE_START')
            self.assertFalse(status['start_sent']);self.assertFalse(status['device_ended']);self.assertTrue(FakeScan.instances[-1].closed)
            self.assertEqual(FakeScan.instances[-1].cancelled,1)
            receipt=(await self.rpc('operations.get',{'operation_id':body['operation_id']}))['body']['operation']
            self.assertEqual(receipt['state'],'not_started');self.assertFalse(receipt['result']['body']['start_sent'])
            self.assertNotIn('FIXTURE_NOT_A_REAL_KEY',json.dumps(receipt))
            self.runtime.plugins.removal.draining.discard('shure-scp')
        FakeScan.mode='cancel-unconfirmed';body=self.start_body();await self.rpc('plugins.scan.start',body)
        await eventually(lambda:self.runtime.plugins.scans.jobs[body['operation_id']]['view']['start_sent'])
        await self.rpc('plugins.scan.cancel',{'plugin_id':'shure-scp','operation_id':uuid.uuid4().hex,'epoch':self.epoch,'scan_operation_id':body['operation_id']})
        status=await self.wait_scan(body['operation_id'])
        self.assertEqual(status['state'],'interrupted');self.assertTrue(status['start_sent']);self.assertFalse(status['device_ended'])
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))

    async def test_handshake_failure_retains_only_public_progress_and_error(self):
        await self.setup_scan('handshake-fail');body=self.start_body();await self.rpc('plugins.scan.start',body)
        status=await self.wait_scan(body['operation_id'])
        self.assertEqual(status['state'],'failed');self.assertEqual(status['error'],'SCAN_SESSION_KEY_STATUS_TIMEOUT')
        self.assertEqual(status['handshake_state'],'failed');self.assertFalse(status['handshake_complete'])
        self.assertFalse(status['start_sent']);self.assertFalse(status['device_started']);self.assertEqual(status['received_points'],0)
        self.assertNotIn('FIXTURE_NOT_A_REAL_KEY',json.dumps(status))
        receipt=(await self.rpc('operations.get',{'operation_id':body['operation_id']}))['body']['operation']
        self.assertEqual(receipt['result']['body']['error'],'SCAN_SESSION_KEY_STATUS_TIMEOUT')
        self.assertNotIn('FIXTURE_NOT_A_REAL_KEY',json.dumps(receipt))

    async def test_packaged_start_confirmation_errors_survive_mqtt_and_receipt(self):
        item=await self.setup_scan()
        client_module=item['namespace'].load('shure_scan_client.py')
        self.assertTrue(client_module.__name__.startswith('_daty_plugin_'))
        for code in ('SCAN_START_NOT_CONFIRMED','SCAN_ARRAY_SUBSCRIBE_TIMEOUT'):
            with self.subTest(code=code),patch.object(FakeScan,'poll',side_effect=client_module.ScanClientError(code)):
                body=self.start_body();await self.rpc('plugins.scan.start',body)
                result=await self.wait_scan(body['operation_id'])
            self.assertEqual(result['state'],'unknown');self.assertEqual(result['error'],code)
            self.assertTrue(result['finalized']);self.assertFalse(result['complete']);self.assertFalse(result['data_available'])
            self.assertEqual(result['received_points'],0);self.assertEqual(result['points'],[])
            self.assertIsNone(result['missing_points'])  # No first snapshot was received before this transport failure.
            self.assertEqual(FakeScan.instances[-1].started,1);self.assertEqual(FakeScan.instances[-1].cancelled,0)
            self.assertTrue(FakeScan.instances[-1].closed)
            receipt=(await self.rpc('operations.get',{'operation_id':body['operation_id']}))['body']['operation']
            self.assertEqual(receipt['state'],'unknown');self.assertEqual(receipt['result']['body']['error'],code)
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))

    async def test_finalized_waits_for_cleanup_and_failed_final_receipt_is_unknown(self):
        await self.setup_scan();gate=threading.Event();FakeScan.close_gate=gate
        body=self.start_body()
        try:
            await self.rpc('plugins.scan.start',body)
            await eventually(lambda:self.runtime.plugins.scans.jobs[body['operation_id']]['view']['state']=='completed')
            status=await self.rpc('plugins.scan.status',{'plugin_id':'shure-scp','operation_id':body['operation_id']})
            self.assertFalse(status['finalized'])
            busy=await self.ui.call('plugins.scan.start',self.start_body())
            self.assertFalse(busy['ok']);self.assertIn('SCAN_RECEIVER_BUSY',json.dumps(busy))
            with patch.object(self.runtime.repo,'save_receipt',side_effect=PluginError('FIXTURE_FINAL_WRITE_FAILED',503)):
                gate.set();result=await self.wait_scan(body['operation_id'])
            self.assertTrue(result['finalized']);self.assertEqual(result['state'],'unknown')
            self.assertEqual(result['error'],'SCAN_RECEIPT_UNCONFIRMED');self.assertFalse(result['complete'])
        finally:gate.set();FakeScan.close_gate=None


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(LiveScan(name) for name in LiveScan.__dict__ if name.startswith('test_'))
