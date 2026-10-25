"""Exclusive migration gate for an isolated Bridge HTTP handler subclass."""
import asyncio

from command_journal import CommandError
from http_transport import HttpRequestError


def handler_for(bridge, service, loop):
    class CandidateHandler(bridge.DatyAPIHandler):
        def do_POST(self):
            path = self.path.split('?', 1)[0]
            if path == '/api/command':
                # Never let the original HTTP sender coexist with the MQTT owner.
                if not self._check_origin():
                    return
                self.close_connection = True
                self._json({'success': False, 'accepted': False, 'error': 'LEGACY_CONTROL_ENTRY_DISABLED'}, status=409)
                return
            if path == '/api/mqtt-stage3/request':
                if not self._check_origin():
                    return
                try:
                    request = self._read_json_body()
                    future = asyncio.run_coroutine_threadsafe(service.request(request, entry='https'), loop)
                    result = future.result(timeout=5)
                    self._json({'success': True, 'result': result})
                except CommandError as error:
                    self._json({'success': False, 'accepted': False, 'error': error.code}, status=409)
                except HttpRequestError as error:
                    self._http_failure(error)
                except Exception:
                    # Do not cancel/redo an accepted command on a caller timeout.
                    self._json({'success': False, 'error': 'OUTCOME_UNKNOWN_QUERY_ONLY'}, status=503)
                return
            super().do_POST()
    return CandidateHandler
