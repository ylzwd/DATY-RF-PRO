"""Candidate only: old file/enrollment writes cannot coexist with M5 authority."""
from urllib.parse import urlsplit
from data_http_entry import handler_for as data_handler

def handler_for(bridge):
    base=data_handler(bridge)
    class Handler(base):
        def do_POST(self):
            path=urlsplit(self.path).path
            if path in ('/api/receivers/challenge','/api/receivers/enroll') or any(
                    path==p or path.startswith(p+'/') for p in ('/api/database/exports','/api/database/archives','/api/database/archive-cleanups')):
                self._json({'success':False,'code':'MQTT_FILE_OR_ENROLLMENT_ENTRY_REQUIRED','error':'候选实例仅接受 MQTT 写入'},status=409)
                return
            super().do_POST()
    return Handler
