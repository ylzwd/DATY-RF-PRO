"""Full current Bridge on its own temporary TLS/SQLite; all controls blocked."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'tests'))
from pairing_test_support import PairingFixture,create_tls_fixture
from tls_support import bind_https,server_context
from server_archive import ArchiveService


def main():
    if sys.argv[1:]!=['--stdio-fixture']:raise SystemExit('Fixture only')
    temp=tempfile.TemporaryDirectory(prefix='daty-server-storage-test-');path=Path(temp.name)
    pairing=PairingFixture(temp.name);tls=create_tls_fixture(temp.name)
    os.environ.update(DATY_DB_PATH=str(path/'fixture.sqlite3'),DATY_PAIRING_FILE=str(pairing.path),DATY_TLS_FILE=str(tls),DATY_ARCHIVE_PATH=str(path/'archives'))
    spec=importlib.util.spec_from_file_location('isolated_storage_bridge',ROOT/'mqtt-bridge.py');bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
    bridge._log=lambda *args:None;runtime=bridge._start_unified_runtime();bridge._server_archive_service=ArchiveService(path/'fixture.sqlite3',path/'archives')
    commands=[]
    def forbidden(*args):commands.append(args);raise RuntimeError('Device publication forbidden in storage fixture')
    bridge._broker_publish_command=forbidden
    class Handler(bridge.DatyAPIHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            if self.path.startswith('/api/command'):
                commands.append(self.path);self._json({'success':False,'error':'Fixture blocks controls'},status=409);return
            super().do_POST()
    http=bind_https(bridge.ThreadingHTTPServer,('127.0.0.1',0),Handler,server_context(tls))
    worker=threading.Thread(target=http.serve_forever,daemon=True);worker.start()
    config=json.loads(Path(tls).read_text(encoding='utf-8'))
    print(json.dumps({'event':'ready','origin':f'https://127.0.0.1:{http.server_port}','ca':Path(config['ca_file']).read_text(),'temporary':str(path)},ensure_ascii=True),flush=True)
    try:
        for line in sys.stdin:
            request=json.loads(line);name=request.get('command')
            if name=='shutdown':break
            if name=='seed-receiver':
                receiver='FAshe-storage-fixture'
                payload={'type':'device_list','client_id':receiver,'receiver_id':receiver,'receiver_ip':'192.0.2.102','receiver_mac':'02:00:00:00:00:02','brand':'DATYaudio','control_protocol':'fashe-realtime-v1',
                    'devices':[{'name':'测试通道 '+str(i),'channel':i,'brand':'DATYaudio','model':'DATY-X2','freq_mhz':641+(i-1),'rf_level':-45,'af_level':-15,'battery':80,'muted':False,'status':'online'} for i in range(1,3)]}
                bridge._process_mqtt_message(bridge.MQTT_TOPIC_REGISTER,json.dumps(payload),'fixture-mqtt','fixture-session');result=runtime.wait_idle()
            elif name=='stats':
                with bridge._db_session() as connection:
                    result={'tables':{table:connection.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ['db_resources','db_audit','live_samples','biz_planning_records','db_planning_runs','biz_alerts']},'foreignKeys':len(connection.execute('PRAGMA foreign_key_check').fetchall()),'commands':len(commands)}
            else:result={'error':'unknown fixture operation'}
            print(json.dumps({'id':request.get('id'),'result':result}),flush=True)
    finally:
        for queue in list(bridge._state['sse_queues']):queue.put_nowait(None)
        http.shutdown();http.server_close();worker.join(5);runtime.stop();bridge._close_database()
        # Retain temporary evidence for archive-content verification by the parent.
        temp._finalizer.detach()


if __name__=='__main__':main()
