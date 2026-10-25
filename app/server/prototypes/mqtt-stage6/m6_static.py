"""Original static headers/file confinement; exact candidate asset allowlist.

No business HTTP/SSE handler, IP cache, directory listing or configuration route.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from functools import partial
import threading

from tls_support import server_context
from m6_https import WorkerTLSHandshake

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('mqtt6_static_base',ROOT/'web-service.py')
web=importlib.util.module_from_spec(spec);spec.loader.exec_module(web)
ASSETS=(web.PUBLIC_ASSETS-{'ws-probe.html','browser-data-migration.html'})|{
    'src/app/system-settings.js','src/mqtt6/network-timers.js','src/mqtt6/receiver-timer-worker.js',
    'src/mqtt6/mqtt.min.js','src/mqtt6/bundle.js','src/mqtt6/browser-boot.js'}


def verify_assets(root):
    manifest=json.loads((root/'candidate-manifest.json').read_text('utf-8'))
    for name in ASSETS:
        path=web.confined_file(str(root),name)
        if path is None or hashlib.sha256(path.read_bytes()).hexdigest()!=manifest['files'].get(name):
            raise ValueError('Candidate asset verification failed: '+name)


class Handler(web.DatyWebHandler):
    def send_head(self):
        path=self.path.split('?',1)[0]
        if path=='/':path='/unirf-app.html'
        if path=='/health':return self.json_head({'status':'ok','service':'DATY RF PRO MQTT static','transport':'mqtt-v2'})
        if path[1:] not in ASSETS or not path.startswith('/'):
            self.send_error(410 if path.startswith(('/api/','/local-ip.json')) else 404);return
        target=web.confined_file(self.directory,path[1:])
        if target is None:self.send_error(404);return
        try:
            source=target.open('rb')
            self.send_response(200)
            self.send_header('Content-Type',web.PUBLIC_CONTENT_TYPES[target.suffix])
            self.send_header('Content-Length',str(os.fstat(source.fileno()).st_size))
            self.end_headers();return source
        except BaseException:
            if 'source' in locals():source.close()
            raise

    def do_POST(self):self.send_error(410)
    def log_message(self,*args):pass  # Business audit stays in the MQTT database.


class CandidateHTTPSServer(WorkerTLSHandshake, web.ExclusiveThreadingHTTPServer):
    pass


class StaticServer:
    def __init__(self,scope):
        verify_assets(scope.public_directory)
        self.server=CandidateHTTPSServer(scope.web_socket.getsockname(),partial(Handler,directory=str(scope.public_directory)),bind_and_activate=False)
        self.server.socket.close()
        self.server.tls_context=server_context(scope.tls)
        self.server.socket=scope.web_socket
        scope.web_socket=None
        self.server.server_address=self.server.socket.getsockname()
        self.server.server_name=self.server.server_address[0]
        self.server.server_port=self.server.server_address[1]
        self.thread=threading.Thread(target=self.server.serve_forever,name='mqtt6-static',daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown();self.server.server_close();self.thread.join(5)
