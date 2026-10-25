"""Isolated MQTT peers; original M3 execution DTO checks and M5 RPC framing."""
import asyncio
import json
import time
import uuid
import websockets
from websockets.exceptions import ConnectionClosed
from pairing_test_support import connect_packet,subscribe_packet
from tls_support import client_context
from mqtt_wire import packet,utf,string,number,split,WSReader
from m6_contract import SERVER,schema,topic,encoded

def oid():return uuid.uuid4().hex
async def eventually(fn,timeout=8):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if fn():return
        await asyncio.sleep(.01)
    raise AssertionError('Expected isolated state not reached')

class Receiver:
    def __init__(self, case, index):
        self.case, self.index = case, index
        self.cred = case.fixture.credentials[index]
        self.ip = '127.0.0.' + str(index + 2)
        self.commands, self.executions = asyncio.Queue(), []
        self.values = {ch: {'muted': False, 'freq_mhz': 640 + ch / 4} for ch in (1,2)}
        self.acknowledge = True
        self.task, self.ws, self.heartbeat = None, None, None

    async def start(self):
        self.ws = await websockets.connect(self.case.rx_uri, ssl=client_context(self.case.tls),
            subprotocols=['mqtt'], local_addr=(self.ip, 0))
        await self.ws.send(connect_packet(self.cred))
        assert await self.ws.recv() == b'\x20\x02\0\0'
        await self.ws.send(subscribe_packet(['daty/rf/devices/down']))
        assert await self.ws.recv() == b'\x90\x03\0\x01\0'
        await self.publish('daty/rf/devices/register', {'type':'device_list',
            'control_protocol':'fashe-realtime-v1', 'devices':[
                {'channel':ch,'channel_number':ch,'brand':'DATYaudio','model':'RF PRO',**value} for ch,value in self.values.items()]})
        self.task = asyncio.create_task(self.run())
        self.heartbeat=asyncio.create_task(self.keep_alive())
        await eventually(lambda: any(d.get('_receiver_id') == self.cred.receiver_id
            and d.get('_source','').endswith(self.case.b._broker_clients[self.cred.client_id]['connection_token'])
            for d in self.case.b._state['devices'].values()))
        return self

    async def publish(self, topic, body):
        payload = {'receiver_id':self.cred.receiver_id, 'receiver_mac':self.cred.receiver_mac,
                   'receiver_ip':self.ip, 'brand':'DATYaudio', **body}
        await self.ws.send(self.case.b._build_mqtt_publish_packet(topic, json.dumps(payload)))

    async def keep_alive(self):
        try:
            while True:
                await asyncio.sleep(2)
                await self.publish('daty/rf/devices/up',{'type':'device_status_update',
                    'control_protocol':'fashe-realtime-v1','devices':[
                        {'channel':ch,'channel_number':ch,'brand':'DATYaudio',**value} for ch,value in self.values.items()]})
        except ConnectionClosed:pass

    async def ack(self, command, **changes):
        ch = command['channel_number']
        await self.publish('daty/rf/devices/up', {'type':'device_status_update','control_protocol':'fashe-realtime-v1',
            'command_id':command['command_id'], 'channel':ch, 'channel_number':ch, **self.values[ch], **changes})

    async def run(self):
        try:
            async for raw in self.ws:
                header, body = split(bytearray(raw))
                if header >> 4 != 3:
                    continue
                topic, at = string(body)
                if topic != 'daty/rf/devices/down':
                    continue
                command = json.loads(body[at:])
                # Isolated peer executes the unchanged legacy command DTO only
                # for its exact paired receiver, CH and registered brand.
                assert command['receiver_id'] == self.cred.receiver_id
                assert command['receiver_ip'] == self.ip
                assert command['receiver_mac'] == self.cred.receiver_mac
                assert command['expected_brand'] == 'DATYaudio'
                ch = command['channel_number']
                assert ch in self.values
                assert command['device_id'] == self.cred.receiver_id + '_ch' + str(ch)
                if command['command'] == 'set_freq':
                    self.values[ch]['freq_mhz'] = command['value']
                else:
                    self.values[ch]['muted'] = command['command'] == 'mute'
                self.executions.append(command)
                await self.commands.put(command)
                if self.acknowledge:
                    await self.ack(command)
        except ConnectionClosed:
            pass

    async def close(self):
        if self.heartbeat:
            self.heartbeat.cancel();await asyncio.gather(self.heartbeat,return_exceptions=True)
        if self.ws:
            await self.ws.close()
        if self.task:
            await self.task


class UI:
    def __init__(self,case,mode='app',ip='127.0.0.1'):
        self.case,self.mode,self.ip=case,mode,ip;self.pid=1
    async def start(self):
        self.ws=await websockets.connect(self.case.uris[self.mode],ssl=client_context(self.case.tls),subprotocols=['mqtt'],
            origin='http://127.0.0.1:8081' if self.mode=='enrollment' else 'https://127.0.0.1:8080',local_addr=(self.ip,0))
        await self.ws.send(packet(0x10,utf('MQTT')+b'\x05\x02\0\x0a\0'+utf('')))
        self.reader=WSReader(self.ws);h,b=await self.reader.read();assert h==0x20
        self.sid=b[-36:].decode();assert self.sid.startswith('m6')
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
