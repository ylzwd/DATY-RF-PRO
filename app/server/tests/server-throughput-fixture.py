"""Explicit loopback-only WSS load; temporary TLS, pairing and WAL/FULL database.

No control publisher is allowed. The optional parent only locates a NEW unique
temporary directory; never selects an existing business database or security file.
"""
import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'tests')]
from pairing_test_support import PairingFixture,connect_packet,create_tls_fixture
from tls_support import server_context,client_context
import websockets


async def replay(bridge,fixture,tls,frames,interval):
    sent=[0,0];failures=[];gaps=[];start=time.perf_counter();stop=asyncio.Event()
    async def probe():
        while not stop.is_set():
            tick=time.perf_counter();await asyncio.sleep(.02);gaps.append((time.perf_counter()-tick)*1000)
    probe_task=asyncio.create_task(probe())
    async with websockets.serve(bridge._handle_mqtt_websocket,'127.0.0.1',0,
            subprotocols=['mqtt'],compression=None,ssl=server_context(tls)) as server:
        async def receiver(index):
            credential=fixture.credentials[index]
            try:
                async with websockets.connect(f'wss://127.0.0.1:{server.sockets[0].getsockname()[1]}/mqtt',
                        subprotocols=['mqtt'],compression=None,ssl=client_context(tls)) as socket:
                    await socket.send(connect_packet(credential));assert (await socket.recv())[0]==0x20
                    registration={'type':'device_list','client_id':credential.receiver_id,'devices':[
                        {'channel':ch,'brand':'DATYaudio','model':'TEST','freq_mhz':640+.25*ch,
                         'rf_level':-50,'af_level':-20,'battery':90,'muted':False,'status':'online'} for ch in range(1,51)]}
                    await socket.send(bridge._build_mqtt_publish_packet(bridge.MQTT_TOPIC_REGISTER,json.dumps(registration)))
                    await asyncio.sleep(.5);begin=time.perf_counter()
                    for frame in range(frames):
                        for ch in range(1,51):
                            payload={'client_id':credential.receiver_id,'channel':ch,'rf_level':-50-frame%10,
                                     'af_level':-20,'battery':90,'status':'online'}
                            await socket.send(bridge._build_mqtt_publish_packet(bridge.MQTT_TOPIC_UP,json.dumps(payload)))
                            sent[index]+=1
                        await asyncio.sleep(max(0,begin+(frame+1)*interval-time.perf_counter()))
                    await socket.send(bytes([0xc0,0]))
                    assert await asyncio.wait_for(socket.recv(),2)==bytes([0xd0,0])
                    await asyncio.wait_for(bridge._get_mqtt_dispatch_queue().join(),30)
                    await socket.send(bytes([0xe0,0]))
            except Exception as error:
                failures.append(dict(receiver=index,error=type(error).__name__,close_code=getattr(error,'code',None)))
        await asyncio.gather(receiver(0),receiver(1))
    await asyncio.wait_for(bridge._get_mqtt_dispatch_queue().join(),30)
    stop.set();await probe_task
    state=bridge._unified_runtime.wait_idle(timeout=30)
    return dict(sent=sent,expected=frames*100,failures=failures,elapsed_s=round(time.perf_counter()-start,3),
                max_loop_gap_ms=round(max(gaps),3),runtime=state,dispatch=bridge._mqtt_dispatch_status(),
                checkpoint=bridge._wal_checkpointer.status(),processed=bridge._state['stats']['total_messages'])


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--isolated-load',action='store_true',required=True)
    parser.add_argument('--frames',type=int,default=200);parser.add_argument('--interval-ms',type=int,default=100)
    parser.add_argument('--temp-parent');args=parser.parse_args()
    if not 1<=args.frames<=1000 or not 50<=args.interval_ms<=1000:parser.error('Bounded fixture parameters required')
    with tempfile.TemporaryDirectory(prefix='daty-server-load-',dir=args.temp_parent) as temporary:
        directory=Path(temporary).resolve();fixture=PairingFixture(directory,('02:00:00:00:00:98','02:00:00:00:00:99'))
        tls=create_tls_fixture(directory)
        os.environ.update(DATY_DB_PATH=str(directory/'fixture.sqlite3'),DATY_PAIRING_FILE=str(fixture.path),DATY_TLS_FILE=str(tls))
        spec=importlib.util.spec_from_file_location('isolated_bridge',ROOT/'mqtt-bridge.py')
        bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge);bridge._log=lambda *args:None
        def forbidden(*args,**kwargs):raise AssertionError('No device controls in load fixture')
        bridge._broker_publish_command=forbidden;bridge._start_unified_runtime()
        try:
            result=asyncio.run(replay(bridge,fixture,tls,args.frames,args.interval_ms/1000))
            with bridge._db_session() as connection:
                result['database']={table:connection.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]
                    for table in ('live_samples','live_latest','telemetry_samples','commands','timeline_events')}
                result['database'].update(integrity=connection.execute('PRAGMA integrity_check').fetchone()[0],
                    foreign_key_errors=len(connection.execute('PRAGMA foreign_key_check').fetchall()),
                    synchronous=connection.execute('PRAGMA synchronous').fetchone()[0])
            result['passed']=bool(not result['failures'] and sum(result['sent'])==result['expected']
                and result['processed']==result['expected']+2 and result['runtime']['complete']
                and result['database']['live_samples']>=result['expected']+100
                and result['database']['live_latest']==100 and result['database']['commands']==0
                and result['database']['integrity']=='ok' and result['database']['foreign_key_errors']==0
                and result['database']['synchronous']==2)
            print(json.dumps(result,ensure_ascii=True));return 0 if result['passed'] else 1
        finally:
            bridge._unified_runtime.stop(timeout=30);bridge._close_database()


if __name__=='__main__':raise SystemExit(main())
