"""AD4 loopback TCP -> real TLS/MQTT -> SQLite; production resources are excluded."""
import asyncio,json,time
from pathlib import Path
import websockets
from test_stage6 import Integration
from test_shure_six import GapPeer
from shure_metering import ShureMeterSession
from tls_support import client_context
from mqtt_wire import WSReader,packet,utf,string,number

class SixChain(Integration):
    async def test_ad4_fault_edges_and_battery_survive_mqtt_and_database(self):
        peer=GapPeer('AD4D')
        rx={'ip':'127.0.0.1','receiver_ip':'127.0.0.1','receiver_id':'Shure-AD4D-fixture',
            'model':'AD4D','brand':'Shure','protocol_verified':True,'channels':{
            '1':{'channel_number':1,'frequency_khz':677450},'2':{'channel_number':2,'frequency_khz':678000}}}
        self.b._accept_shure_observation(rx)
        stream=ShureMeterSession(rx,self.b._accept_shure_observation,port=peer.port)
        values=[]
        try:
            async with websockets.connect(self.runtime.uri+'/mqtt-readonly',ssl=client_context(self.tls),subprotocols=['mqtt'],proxy=None) as ws:
                reader=WSReader(ws)
                await ws.send(packet(0x10,utf('MQTT')+b'\x05\x02\x00\x0a\x00'+utf('')))
                self.assertEqual((await reader.read())[0],0x20)
                await ws.send(packet(0x82,b'\x00\x01\x00'+utf('daty/v2/daty-rf-pro/devices/read')+b'\x01'))
                self.assertEqual((await reader.read())[0],0x90)
                stream.start();deadline=time.monotonic()+5
                while time.monotonic()<deadline:
                    head,body=await asyncio.wait_for(reader.read(),3)
                    self.assertEqual(head>>4,3)
                    _,offset=string(body);mid=body[offset:offset+2];size,offset=number(body,offset+2)
                    payload=json.loads(body[offset+size:])['payload'] or {}
                    devices=list(payload.get('devices',[]))
                    for event in payload.get('events',[]):devices.extend(event['payload'].get('devices',[]))
                    values.extend(d for d in devices if d.get('_source')=='shure-scp' and d.get('channel_number')==1)
                    await ws.send(packet(0x40,mid))
                    if any(d.get('shure',{}).get('meter_seq',0)>=5 for d in values):break
            def edges(rows):
                result=[]
                for row in rows:
                    v=row.get('shure',{}).get('interference')
                    if v is not None and (not result or v!=result[-1]):result.append(v)
                return result
            self.assertEqual(edges(values),['DETECTED','NONE','DETECTED'])
            latest=values[-1];s=latest['shure']
            self.assertEqual((s['battery_bars'],s['battery_percent'],s['transmitter_muted']),(1,None,True))
            self.assertEqual((s['audio_dbfs'],s['audio_peak_dbfs'],s['rf_branches']['1']['rf_antennas_dbm']['1']),(-19,-18,-34))
            self.assertEqual(s['settings']['encryption_mode'],'ON')
            self.assertGreater(s['field_times']['battery_bars'],0)
            self.assertTrue(latest['capabilities']['read_battery']);self.assertFalse(latest['capabilities']['write_frequency'])
            await asyncio.to_thread(self.b._unified_runtime.wait_idle)
            with self.runtime.repo.connection() as conn:
                saved=[json.loads(r[0]) for r in conn.execute("SELECT snapshot_json FROM live_samples WHERE device_id=? ORDER BY id",(latest['id'],))]
            self.assertEqual(edges(saved),['DETECTED','NONE','DETECTED'])
            self.assertTrue(any(x.get('shure',{}).get('meter_seq',0)>=5 for x in saved))
            self.assertEqual([len(r.executions) for r in self.receivers],[0,0])
            import test_stage6
            output={'mqtt':values,'saved_count':len(saved),'saved_edges':edges(saved),'device_controls':0}
            (Path(test_stage6.OPTIONS.output)/'ad4-chain.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),'utf-8')
        finally:stream.stop();await asyncio.to_thread(stream.thread.join,2);peer.close()
