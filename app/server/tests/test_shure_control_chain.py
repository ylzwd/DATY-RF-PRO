import asyncio,copy,json,time,uuid
from test_stage6 import Integration
from shure_protocol import ShureReply
from shure_hardware import band_identity,network_settings

MAC='00:0E:DD:AD:31:A3'
class ControlChain(Integration):
    async def setup_shure(self):
        self.wires=[];self.value=677450;self.muted=False;self.mode='normal';self.mac=MAC
        self.rid='Shure-ULXD4-127.0.0.1';self.stream='a'*32
        self.writers=set();self.failure=None
        async def peer(reader,writer):
            self.writers.add(writer)
            try:
                while raw:=await reader.readline():
                    text=raw.decode().strip();self.wires.append(text)
                    if text.startswith('< SET'):
                        if 'FREQUENCY' in text:self.value=int(text.split()[4])
                        if 'AUDIO_MUTE' in text:self.muted=text.split()[4]=='ON'
                        if self.failure=='disconnect':writer.close();continue
                        if self.failure=='mismatch':self.muted=False
                    elif 'MODEL' in text:writer.write(b'< REP MODEL {ULXD4} >')
                    elif 'NET_SETTINGS' in text:writer.write(f'< REP NET_SETTINGS SC AUTO 127.000.000.001 255.0.0.0 127.0.0.1 {self.mac} >'.encode())
                    elif 'FREQUENCY_DIVERSITY_MODE' in text:writer.write(f'< REP FREQUENCY_DIVERSITY_MODE {"OFF" if self.mode=="normal" else "1+2"} >'.encode())
                    elif 'HIGH_DENSITY' in text:writer.write(b'< REP HIGH_DENSITY OFF >')
                    elif 'FREQUENCY' in text:writer.write(f'< REP 1 FREQUENCY {self.value:06d} >'.encode())
                    elif 'AUDIO_MUTE' in text:
                        ch=2 if self.failure=='wrong-channel' and any(x.startswith('< SET') for x in self.wires) else 1
                        if self.failure=='disconnect' and any(x.startswith('< SET') for x in self.wires):writer.close();continue
                        writer.write(f'< REP {ch} AUDIO_MUTE {"ON" if self.muted else "OFF"} >'.encode())
                    await writer.drain()
            except (ConnectionError,asyncio.CancelledError):pass
            finally:
                self.writers.discard(writer);writer.close()
        self.peer=await asyncio.start_server(peer,'127.0.0.1',0)
        self.runtime.commands.adapter.port=self.peer.sockets[0].getsockname()[1]
        async def emit():
            while True:
                now=int(time.time()*1000)
                self.b._accept_shure_observation({'receiver_id':self.rid,'receiver_ip':'127.0.0.1','model':'ULXD4','protocol_verified':True,
                    'settings':{'receiver_mac':MAC,'network_ip':'127.0.0.1','high_density':False,'frequency_diversity_mode':'OFF'},
                    'settings_field_times':{k:now for k in ('receiver_mac','network_ip','high_density','frequency_diversity_mode')},
                    'channels':{'1':{'channel_number':1,'frequency_khz':self.value,'muted':self.muted,'meter_state':'live','meter_stream_id':self.stream,'meter_received_at_ms':now,
                        'field_times':{'frequency_khz':now,'muted':now}}}})
                await asyncio.sleep(.1)
        self.emitter=asyncio.create_task(emit());await asyncio.sleep(.03)
        async def close():
            self.emitter.cancel();await asyncio.gather(self.emitter,return_exceptions=True)
            for writer in list(self.writers):writer.close()
            self.peer.close();await self.peer.wait_closed()
        self.addAsyncCleanup(close)
    def body(self,command='mute',value=True):
        return {'operation_id':uuid.uuid4().hex,'target':self.runtime.commands.adapter.binding(self.rid+'_ch1')[0],
                'command':command,'expected_value':value}
    def sets(self):return [w for w in self.wires if w.startswith('< SET')]
    async def test_shure_success_journal_and_datyaudio_independent(self):
        await self.setup_shure()
        targets=await self.rpc('commands.targets');self.assertEqual(len(targets['targets']),5)
        body=self.body();request=self.ui.request('commands.request',body)
        await self.ui.send(request);reply=await self.ui.message();self.assertTrue(reply['ok']);result=reply['result']
        self.assertEqual(result['state'],'readback_confirmed');self.assertTrue(result['actual_value'])
        self.assertFalse(result['execution_evidence']['execution_ack_supported'])
        self.assertEqual(result['execution_evidence']['source'],'shure-post-write-readback')
        self.assertEqual(self.sets(),['< SET 1 AUDIO_MUTE ON >'])
        await self.ui.send(request);again=await self.ui.message()
        self.assertEqual(again['result']['state'],'readback_confirmed');self.assertEqual(len(self.sets()),1)
        frequency_body=self.body('set_freq',678000)
        frequency=await self.rpc('commands.request',frequency_body)
        self.assertEqual(frequency['state'],'readback_confirmed');self.assertEqual(frequency['actual_value'],678000)
        for intent,actual in ((body,True),(frequency_body,678000)):
            receipt=self.runtime.journal.get(intent['operation_id'])
            self.assertEqual(receipt['state'],'readback_confirmed');self.assertEqual(receipt['actual_value'],actual)
        with self.runtime.repo.connection() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM timeline_events').fetchone()[0],0)
        self.assertEqual([len(r.executions) for r in self.receivers],[0,0])
    async def test_mute_skips_only_unused_old_value_and_keeps_independent_readback(self):
        await self.setup_shure()
        result=await self.rpc('commands.request',self.body())
        self.assertEqual(result['state'],'readback_confirmed')
        first_set=next(i for i,wire in enumerate(self.wires) if wire.startswith('< SET'))
        self.assertEqual(self.wires[:first_set],['< GET MODEL >','< GET NET_SETTINGS SC >'])
        self.assertEqual(self.wires[first_set+1:],['< GET MODEL >','< GET NET_SETTINGS SC >','< GET 1 AUDIO_MUTE >'])
        result=await self.rpc('commands.request',self.body('unmute',False))
        self.assertEqual(result['state'],'readback_confirmed');self.assertFalse(result['actual_value'])
        self.assertEqual(self.sets(),['< SET 1 AUDIO_MUTE ON >','< SET 1 AUDIO_MUTE OFF >'])

    async def test_shure_wrong_mac_band_and_grid_never_send(self):
        await self.setup_shure()
        for value in (631975,696025,677451):
            r=await self.rpc('commands.request',self.body('set_freq',value));self.assertEqual(r['state'],'not_sent')
        self.mac='00:0E:DD:AD:31:A4'
        r=await self.rpc('commands.request',self.body());self.assertEqual(r['state'],'not_sent')
        self.assertEqual(self.sets(),[])
    async def test_shure_wrong_channel_unknown_blocks_retries(self):
        await self.setup_shure();self.failure='wrong-channel'
        r=await self.rpc('commands.request',self.body());self.assertEqual(r['state'],'unknown')
        again=await self.ui.call('commands.request',self.body());self.assertFalse(again['ok'])
        self.assertEqual(len(self.sets()),1)
    async def test_shure_mismatched_readback_is_not_success(self):
        await self.setup_shure();self.failure='mismatch'
        r=await self.rpc('commands.request',self.body());self.assertEqual(r['state'],'unknown');self.assertEqual(len(self.sets()),1)
    async def test_shure_disconnect_after_set_is_unknown(self):
        await self.setup_shure();self.failure='disconnect'
        r=await self.rpc('commands.request',self.body());self.assertEqual(r['state'],'unknown');self.assertEqual(len(self.sets()),1)
    async def test_shure_wrong_session_and_diversity_no_set(self):
        await self.setup_shure();body=self.body();body['target']['receiver_session_id']='b'*32
        r=await self.rpc('commands.request',body);self.assertEqual(r['state'],'rejected')
        self.mode='diversity';r=await self.rpc('commands.request',self.body('set_freq',678000))
        self.assertEqual(r['state'],'not_sent');self.assertEqual(self.sets(),[])
    async def test_shure_failed_save_never_sends(self):
        await self.setup_shure();commit=self.runtime.journal.commit
        def fail(c):raise OSError('fixture disk failure')
        self.runtime.journal.commit=fail
        try:
            r=await self.ui.call('commands.request',self.body());self.assertFalse(r['ok']);self.assertEqual(self.sets(),[])
        finally:self.runtime.journal.commit=commit

import unittest
class Hardware(unittest.TestCase):
    def test_identification_sources_and_conflicts(self):
        r=ShureReply();r.feed('REP MODEL {AD4D}');r.feed('REP RF_BAND {G56}')
        self.assertEqual(band_identity(r.model,r.settings,{})['source'],'receiver-reported')
        self.assertFalse(band_identity(r.model,r.settings,{})['verified'])
        self.assertIsNone(band_identity('ULXD4',{}, {})['band'])
        r.feed(f'REP NET_SETTINGS SC AUTO 192.169.000.107 255.255.0.0 192.0.2.18 {MAC}')
        self.assertEqual(r.settings['network_ip'],'192.0.2.107')
        self.assertEqual(band_identity('ULXD4',{'receiver_mac':MAC})['band'],'L51')
        self.assertFalse(band_identity('ULXD4',{'receiver_mac':MAC,'rf_band':'L50'})['verified'])
        self.assertIsNone(network_settings('SC AUTO 999.0.0.1 255.0.0.0 0.0.0.0 '+MAC))
