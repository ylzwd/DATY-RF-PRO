"""Real loopback MQTT/SQLite recovery, with no physical device access."""
import asyncio,copy,time
from unittest.mock import patch
from test_stage6 import Integration
from m6_repository import ACTOR,Journal
from command_journal import CommandError
from m6_test_support import eventually

class AutomaticCommands(Integration):
    async def test_auto_imported_shure_unknown_readback_is_not_replayed(self):
        import base64,uuid
        from pathlib import Path
        from test_shure_control_chain import ControlChain,MAC
        import shure_hardware
        label=patch.object(shure_hardware,'hardware_registry',lambda:{MAC:{'model':'ULXD4','band':'L51'}})
        label.start();self.addCleanup(label.stop)
        package=Path(__file__).resolve().parents[3]/'plugins/packages/DATY-shure-scp-source-3aee959ed650.zip'
        encoded=base64.b64encode(package.read_bytes()).decode()
        preview=await self.rpc('plugins.preview',{'package_base64':encoded})
        await self.rpc('plugins.install',{'package_base64':encoded,'sha256':preview['sha256'],'expected_revision':preview['revision'],'operation_id':uuid.uuid4().hex})
        await ControlChain.setup_shure(self)
        self.runtime.plugins.active['shure-scp']['control'].port=self.peer.sockets[0].getsockname()[1]
        self.emitter.cancel();await asyncio.gather(self.emitter,return_exceptions=True)
        async def telemetry():
            while True:
                now=int(time.time()*1000)
                self.b._accept_shure_observation({'receiver_id':self.rid,'receiver_ip':'127.0.0.1','model':'ULXD4','protocol_verified':True,
                    'settings':{'receiver_mac':MAC,'network_ip':'127.0.0.1','high_density':False,'frequency_diversity_mode':'OFF'},
                    'channels':{'1':{'channel_number':1,'frequency_khz':self.value,'muted':self.muted,'meter_state':'live','meter_stream_id':self.stream,'meter_received_at_ms':now,'field_times':{'muted':now,'frequency_khz':now}}}})
                await asyncio.sleep(.1)
        self.emitter=asyncio.create_task(telemetry());await asyncio.sleep(.15)
        body={'operation_id':uuid.uuid4().hex,'target':self.runtime.commands.adapter.binding(self.rid+'_ch1')[0],'command':'mute','expected_value':True}
        self.failure='mismatch';request=self.ui.request('commands.request',body);request['deadline_at_ms']=int(time.time()*1000)+2000
        await self.ui.send(request);reply=await self.ui.message();self.assertTrue(reply['ok'])
        original=reply['result'];self.assertIn(original['state'],('unknown','timeout'))
        await eventually(lambda:bool(self.runtime.journal.get(body['operation_id'])['review']),timeout=8)
        reviewed=self.runtime.journal.get(body['operation_id'])
        self.assertEqual(reviewed['state'],original['state']);self.assertIsNone(reviewed['execution_evidence'])
        self.assertFalse(reviewed['review']['observed']['muted'])
        self.assertEqual([w for w in self.wires if w.startswith('< SET')],['< SET 1 AUDIO_MUTE ON >'])
        self.failure=None
        result=await self.rpc('commands.request',{**body,'operation_id':uuid.uuid4().hex,'command':'unmute','expected_value':False})
        self.assertEqual(result['state'],'readback_confirmed')
        self.assertEqual([w for w in self.wires if w.startswith('< SET')],['< SET 1 AUDIO_MUTE ON >','< SET 1 AUDIO_MUTE OFF >'])

    async def pause_worker(self):
        task=self.runtime.commands.reconciliation_task
        if task:task.cancel();await asyncio.gather(task,return_exceptions=True)
        self.runtime.commands.reconciliation_task=None

    def unknown(self,body=None):
        body=body or self.intent();request=self.ui.request('commands.request',body)
        request['deadline_at_ms']=int(time.time()*1000)-5000
        token=ACTOR.set(self.runtime.repo.actor(self.ui.ip))
        try:
            self.runtime.journal.reserve(request,'mqtt')
            self.runtime.journal.transition(body['operation_id'],{'reserved'},'dispatching',attempt=True)
            return self.runtime.journal.transition(body['operation_id'],{'dispatching'},'unknown',error='ISOLATED_LOST_RECEIPT')
        finally:ACTOR.reset(token)

    async def fresh(self,record,muted=False):
        await self.receivers[0].publish('daty/rf/devices/up',{'type':'device_status_update','channel':1,'muted':muted})
        await eventually(lambda:self.b._state['devices'][record['target']['device_id']]['_last_seen']*1000>=record['updated_at_ms'])

    async def test_auto_background_without_ui_keeps_unknown_and_allows_new_intent(self):
        record=self.unknown();await self.ui.close();await self.fresh(record)
        await eventually(lambda:bool(self.runtime.journal.get(record['operation_id']).get('review')),timeout=6)
        result=self.runtime.journal.get(record['operation_id'])
        for key in ('state','error','actual_value','execution_evidence','attempts','command_id','target'):
            self.assertEqual(result[key],record[key])
        self.assertEqual(result['review']['mode'],'automatic');self.assertFalse(result['review']['observed']['muted'])
        self.assertEqual(result['review']['meaning'],'release-target-no-execution-claim')
        self.assertEqual(sum(len(r.executions) for r in self.receivers),0)
        self.ui=await self.new_ui();outsider=await self.new_ui('127.0.0.2')
        self.assertEqual((await outsider.call('commands.get',{'operation_id':record['operation_id']}))['error'],'OPERATION_OWNER_MISMATCH')
        body=self.intent();await self.rpc('commands.request',body)
        await eventually(lambda:self.runtime.journal.get(body['operation_id'])['state']=='acknowledged')
        self.assertEqual(sum(len(r.executions) for r in self.receivers),1)
        revision=result['revision']
        for _ in range(3):await self.runtime.commands.reconcile_once()
        self.assertEqual(self.runtime.journal.get(record['operation_id'])['revision'],revision)

    async def test_auto_offline_identity_missing_values_and_active_dispatch_hold_lock(self):
        await self.pause_worker();record=self.unknown();service=self.runtime.commands
        await self.fresh(record)
        service.executing[record['operation_id']]=1;await service.reconcile_once()
        self.assertIsNone(self.runtime.journal.get(record['operation_id'])['review']);service.executing.clear()
        did=record['target']['device_id']
        with self.b._state_lock:original=copy.deepcopy(self.b._state['devices'][did])
        for changes in ({'_last_seen':0},{'receiver_mac':'00:00:00:00:00:00'},{'muted':None}):
            with self.b._state_lock:self.b._state['devices'][did]={**original,**changes}
            await service.reconcile_once();self.assertIsNone(self.runtime.journal.get(record['operation_id'])['review'])
        with self.b._state_lock:self.b._state['devices'][did]=original
        await service.reconcile_once();self.assertTrue(self.runtime.journal.get(record['operation_id'])['review'])

    async def test_auto_observation_race_rolls_back_and_retry_commits_once(self):
        await self.pause_worker();record=self.unknown();await self.fresh(record)
        service=self.runtime.commands;observed=service.automatic_observation(record);calls=[]
        def changed():calls.append(1);return len(calls)==1
        with self.assertRaises(CommandError):
            await asyncio.to_thread(self.runtime.journal.auto_review,record['operation_id'],record['revision'],observed,changed)
        self.assertEqual(self.runtime.journal.get(record['operation_id']),record)
        self.assertEqual(len(self.runtime.journal.unresolved_records()),1)
        await service.reconcile_once();self.assertEqual(self.runtime.journal.get(record['operation_id'])['revision'],record['revision']+1)

    async def test_auto_restart_reloads_unresolved_without_sending(self):
        await self.pause_worker();record=self.unknown()
        self.runtime.journal.close()
        self.runtime.journal=Journal(self.runtime.repo,fixture_root=self.temp.name)
        self.runtime.commands.journal=self.runtime.journal
        self.assertEqual(self.runtime.journal.unresolved_records(),[record])
        await self.fresh(record);await self.runtime.commands.reconcile_once()
        self.assertTrue(self.runtime.journal.get(record['operation_id'])['review'])
        self.assertEqual(sum(len(r.executions) for r in self.receivers),0)

    async def test_auto_shure_requires_current_report_for_command_field(self):
        await self.pause_worker();service=self.runtime.commands
        body=self.intent();body['target']['expected_brand']='Shure';record=self.unknown(body)
        now=int(time.time()*1000)+10;target=record['target']
        device={'_source':'shure-scp','_last_seen':now/1000,'freq':640000,'muted':False,
            'shure':{'stale_fields':[],'field_times':{'muted':0}}}
        with patch.object(service.adapter,'binding',return_value=(target,device,None,None)):
            await service.reconcile_once();self.assertIsNone(self.runtime.journal.get(record['operation_id'])['review'])
            device['shure']['field_times']['muted']=now;device['shure']['stale_fields']=['muted']
            await service.reconcile_once();self.assertIsNone(self.runtime.journal.get(record['operation_id'])['review'])
            device['shure']['stale_fields']=[];await service.reconcile_once()
        self.assertEqual(self.runtime.journal.get(record['operation_id'])['review']['mode'],'automatic')
        self.assertEqual(sum(len(r.executions) for r in self.receivers),0)
