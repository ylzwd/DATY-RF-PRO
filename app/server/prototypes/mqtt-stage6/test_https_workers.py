"""Real loopback TLS, including the old serial-handshake negative control."""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import http.client
from pathlib import Path
import socket,ssl,sys,tempfile,threading,time,unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT),str(ROOT/'tests'),str(Path(__file__).resolve().parent)]
from pairing_test_support import create_tls_fixture
from tls_support import client_context,server_context
from m6_https import ThreadedHTTPSServer


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        self.server.handled+=1
        body=b'fixture-only';self.send_response(200)
        self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)


class HTTPSWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='daty-m6-handshake-')
        self.addCleanup(self.temp.cleanup)
        self.tls=create_tls_fixture(self.temp.name)

    def start(self,legacy=False):
        if legacy:
            entered=threading.Event()
            class Legacy(ThreadingHTTPServer):
                def get_request(self):
                    entered.set();return super().get_request()
                def handle_error(self,*args):pass
            server=Legacy(('127.0.0.1',0),Handler)
            server.socket=server_context(self.tls).wrap_socket(server.socket,server_side=True)
            server.entered=entered
        else:
            server=ThreadedHTTPSServer(('127.0.0.1',0),Handler,tls_context=server_context(self.tls))
        server.handled=0
        thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.02},daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join(2)))
        return server

    def get(self,server,timeout=2,context=None):
        c=http.client.HTTPSConnection('127.0.0.1',server.server_port,timeout=timeout,
                                       context=context or client_context(self.tls))
        try:
            c.request('GET','/');r=c.getresponse();return r.status,r.read()
        finally:c.close()

    def test_old_accept_loop_is_blocked_by_one_unfinished_handshake(self):
        server=self.start(legacy=True)
        idle=socket.create_connection(server.server_address,timeout=1)
        try:
            self.assertTrue(server.entered.wait(1))
            with self.assertRaises(TimeoutError):self.get(server,timeout=.2)
            self.assertEqual(server.handled,0)
        finally:idle.close()
        self.assertEqual(self.get(server),(200,b'fixture-only'))

    def test_idle_handshake_does_not_block_parallel_authenticated_resources(self):
        server=self.start()
        idle=socket.create_connection(server.server_address,timeout=1)
        try:
            self.assertEqual(server.request_queue_size,ThreadingHTTPServer.request_queue_size)
            with ThreadPoolExecutor(max_workers=6) as pool:
                replies=list(pool.map(lambda _:self.get(server),range(24)))
            self.assertEqual(replies,[(200,b'fixture-only')]*24)
        finally:idle.close()

    def test_unfinished_handshake_expires_without_calling_http_handler(self):
        server=self.start();server.handshake_timeout=.15
        idle=socket.create_connection(server.server_address,timeout=1)
        try:
            idle.settimeout(1)
            try:self.assertEqual(idle.recv(1),b'')
            except ConnectionResetError:pass
            self.assertEqual(server.handled,0)
        finally:idle.close()
        self.assertEqual(self.get(server),(200,b'fixture-only'))

    def test_plaintext_and_untrusted_certificates_do_not_bypass_tls(self):
        server=self.start()
        with self.assertRaises(ssl.SSLCertVerificationError):
            self.get(server,context=ssl.create_default_context())
        with socket.create_connection(server.server_address,timeout=1) as plain:
            plain.sendall(b'GET / HTTP/1.0\r\n\r\n')
            try:self.assertEqual(plain.recv(4096),b'')
            except ConnectionResetError:pass
        self.assertEqual(server.handled,0)
        self.assertEqual(self.get(server),(200,b'fixture-only'))


if __name__=='__main__':unittest.main()
