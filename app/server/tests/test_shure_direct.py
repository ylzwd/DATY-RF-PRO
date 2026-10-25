"""Installed current plugin, real loopback SCP and MQTT/TLS/SQLite; no SystemAPI."""
import asyncio, unittest
from unittest.mock import patch
from test_shure_package_v2 import Current
from shure_protocol import ShureReply
from shure_legacy import direct_model
from shure_hardware import capabilities, frequency_limits
from m6_test_support import eventually


class Direct(Current):
    async def test_installed_direct_metering_and_metadata_recovery_without_any_api(self):
        import copy
        from test_plugin_auto_discovery import LegacyPeer
        from test_shure_legacy_control import MAC
        await self.install_shure()
        peer=LegacyPeer();self.addAsyncCleanup(asyncio.to_thread,peer.close);port=peer.server_address[1]
        item=self.runtime.plugins.active['shure-scp'];ns=item['namespace'];d=item['discovery']
        legacy=ns.load('shure_legacy.py');module=ns.load('shure_active_discovery.py');entry=ns.load('shure_plugin.py')
        with patch.object(ns.load('shure_systemapi.py').SystemApiClient,'identity',side_effect=AssertionError('SystemAPI used')):
            raw=await asyncio.to_thread(legacy.legacy_probe,module,'127.0.0.1',port=port,mac_provider=lambda _:MAC)
            self.assertEqual(raw['settings']['identity_source'],'direct-scp')
            session=entry.ShureMeterSession
            entry.ShureMeterSession=lambda receiver,callback,**kwargs:session(receiver,callback,port=port,metadata_interval=.15,**kwargs)
            entry.validate_legacy_identity=lambda receiver:legacy.validate_legacy_identity(receiver,mac_provider=lambda _:MAC)
            d.probe=lambda *a,**k:copy.deepcopy(raw);d.metering=True
            await asyncio.to_thread(d._visit,'127.0.0.1');did=raw['receiver_id']+'_ch1'
            await eventually(lambda:self.b._state['devices'].get(did,{}).get('rf')==-32)
            with self.b._state_lock:self.b._state['devices'].pop(did)
            await eventually(lambda:self.b._state['devices'].get(did,{}).get('freq')==632700)
            self.assertFalse(hasattr(d,'systemapi'))
            await eventually(lambda:d.snapshot()['health']['monitoring']['active']==1)
            status=await self.rpc('plugins.status');health=status['plugins'][0]['health']
            self.assertEqual(health['provider'],'daty-scp');self.assertEqual(health['receivers_online'],1)
            self.assertEqual(health['monitoring'],{'total':1,'active':1,'recovering':0,'stale':0})
            self.assertNotIn('systemapi',status['plugins'][0])
            self.assertFalse(any(c.startswith('SET ') and ' METER_RATE ' not in c for c in peer.commands))
            d.stop()
            self.assertEqual(d.snapshot()['health']['receivers_online'],0)
            self.assertEqual(d.snapshot()['health']['monitoring']['active'],0)

    async def test_no_systemapi_mute_unmute_and_frequency_without_reported_band(self):
        control=await self.setup_legacy(band=False,direct=True)
        control.legacy.identity_provider=lambda _:self.fail('SystemAPI was used')
        settings=self.raw['settings']
        self.assertEqual(settings['identity_source'],'direct-scp')
        self.assertNotIn('systemapi_device_id',settings)
        d=self.b._state['devices'][self.rid+'_ch1'];caps=self.b._device_capabilities(d,d)
        self.assertTrue(caps['mute']);self.assertTrue(caps['write_frequency'])
        self.assertFalse(caps['hardware_band']['verified'])
        self.assertEqual(caps['frequency_control']['range_source'],'scp-command-envelope')
        for command,value in [('mute',True),('unmute',False),('set_freq',633000)]:
            request=self.body(command,value);reply=await self.rpc('commands.request',request)
            self.assertEqual(reply['state'],'readback_confirmed',reply)
            self.assertEqual(reply['actual_value'],value)
            self.assertEqual(reply['execution_evidence']['identity_basis'],'direct-scp-and-local-link')
            self.assertEqual(self.runtime.journal.get(request['operation_id'])['state'],'readback_confirmed')
        self.assertEqual(len(self.executions),3)
        for connection,cmd in self.executions:
            index=self.wires.index((connection,cmd))
            self.assertNotEqual(self.wires[index+1][0],connection)

    async def test_rejected_frequency_not_claimed_applied_and_never_replayed(self):
        await self.setup_legacy(band=False,direct=True)
        self.failure='mismatch'
        request=self.body('set_freq',633000)
        wire=self.ui.request('commands.request',request)
        import time
        wire['deadline_at_ms']=int(time.time()*1000)+2000
        await self.ui.send(wire);result=(await self.ui.message())['result']
        self.assertEqual(result['state'],'unknown')
        await eventually(lambda:bool(self.runtime.journal.get(request['operation_id']).get('review')),timeout=6)
        self.assertEqual(len(self.executions),1)
        self.assertIsNone(self.runtime.journal.get(request['operation_id'])['execution_evidence'])

    async def test_direct_target_mac_change_and_invalid_grid_do_not_send(self):
        await self.setup_legacy(band=False,direct=True)
        self.mac='02:00:00:00:00:B4'
        self.assertEqual((await self.rpc('commands.request',self.body()))['state'],'not_sent')
        self.mac=self.raw['settings']['receiver_mac']
        self.assertEqual((await self.rpc('commands.request',self.body('set_freq',632701)))['state'],'not_sent')
        self.assertEqual(self.executions,[])


class Profile(unittest.TestCase):
    def test_label_or_firmware_alone_cannot_select_protocol_decoder(self):
        r=ShureReply()
        for frame in ['REP FW_VER {2.3.34.0}','REP DEVICE_ID {ULXD4}','REP 1 FREQUENCY 632700','REP 1 AUDIO_MUTE OFF']:
            r.feed(frame)
        self.assertIsNone(direct_model(r))
        for frame in ['REP HIGH_DENSITY OFF','REP FREQUENCY_DIVERSITY_MODE OFF','REP 1 RF_ANTENNA XX',
                      'REP 1 RX_RF_LVL 033','REP 1 AUDIO_LVL 000','REP 1 TX_TYPE UNKN']:
            r.feed(frame)
        self.assertEqual(direct_model(r),'ULXD4')
        r.channels[2]=dict(r.channels[1]);self.assertEqual(direct_model(r),'ULXD4D')
        r.channels[4]=dict(r.channels[1]);self.assertIsNone(direct_model(r))


class SplitReply(unittest.IsolatedAsyncioTestCase):
    async def test_dual_and_quad_profiles_wait_for_all_channel_fragments(self):
        from types import SimpleNamespace
        from shure_legacy_control import LegacyControl
        for model,count in [('ULXD4D',2),('ULXD4Q',4)]:
            with self.subTest(model=model):
                async def peer(reader,writer):
                    try:
                        self.assertEqual(await reader.readuntil(b'>'),b'< GET 0 ALL >')
                        writer.write(b'< REP FW_VER {2.3.34.0} >< REP HIGH_DENSITY OFF >< REP FREQUENCY_DIVERSITY_MODE OFF >')
                        for channel in range(1,count+1):
                            values=['FREQUENCY 632700','AUDIO_MUTE OFF','RF_ANTENNA XX','RX_RF_LVL 033','AUDIO_LVL 000','TX_TYPE UNKN']
                            writer.write(''.join(f'< REP {channel} {value} >' for value in values).encode())
                            await writer.drain()
                            if channel<count:await asyncio.sleep(.05)
                        await reader.read()
                    finally:
                        writer.close();await writer.wait_closed()
                server=await asyncio.start_server(peer,'127.0.0.1',0)
                async with server:
                    control=SimpleNamespace(port=server.sockets[0].getsockname()[1],binding=None,send=None)
                    device={'receiver_ip':'127.0.0.1','model':model,'shure':{'receiver_firmware':'2.3.34.0','settings':{'identity_source':'direct-scp'}}}
                    reply,writer=await LegacyControl(control).query(device,'muted',1,lambda:True)
                    try:
                        self.assertEqual(reply.model,model)
                        self.assertEqual(len(reply.channels),count)
                        self.assertFalse(reply.channel_values()[1]['muted'])
                    finally:
                        writer.close();await writer.wait_closed()


def load_tests(loader,tests,pattern):
    return unittest.TestSuite([loader.loadTestsFromTestCase(Profile),loader.loadTestsFromTestCase(SplitReply),*(Direct(n) for n in Direct.__dict__ if n.startswith('test_'))])
