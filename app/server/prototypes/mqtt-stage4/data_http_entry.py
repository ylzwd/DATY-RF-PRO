"""M4 candidate HTTP gate. Production class is never patched globally."""
from urllib.parse import urlsplit


def handler_for(bridge):
    class Handler(bridge.DatyAPIHandler):
        def do_POST(self):
            if not self._check_origin():return
            self._json({'success':False,'code':'DATA_ENTRY_DISABLED','error':'Candidate mutations require MQTT'},status=409)
    return Handler
