"""Static HTTPS handshakes belong to request workers, never the accept loop.

The listener remains a plain TCP socket internally; no HTTP handler is invoked
until TLS succeeds. Keep the existing backlog and HTTP behavior unchanged.
"""
from http.server import ThreadingHTTPServer


class WorkerTLSHandshake:
    handshake_timeout = 10.0

    def process_request_thread(self, request, client_address):
        original_timeout = request.gettimeout()
        try:
            request.settimeout(self.handshake_timeout)
            secure = self.tls_context.wrap_socket(request, server_side=True)
            secure.settimeout(original_timeout)
        except OSError:
            self.shutdown_request(request)
            return
        super().process_request_thread(secure, client_address)


class ThreadedHTTPSServer(WorkerTLSHandshake, ThreadingHTTPServer):
    def __init__(self, address, handler, *, tls_context):
        self.tls_context = tls_context
        super().__init__(address, handler)
