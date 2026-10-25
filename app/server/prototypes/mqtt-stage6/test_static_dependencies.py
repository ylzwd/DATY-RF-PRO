"""A built page must load every dependency through the real static allowlist."""
import http.client,importlib.util,json,os,sys,tempfile,threading,unittest
from functools import partial
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT),str(ROOT/'tests'),str(Path(__file__).resolve().parent)]
from build_candidate import build
from m6_static import ASSETS,Handler,CandidateHTTPSServer,verify_assets
from pairing_test_support import create_tls_fixture
from tls_support import client_context,server_context

class References(HTMLParser):
    def __init__(self):super().__init__();self.paths=[]
    def handle_starttag(self,tag,attributes):
        values=dict(attributes)
        value=values.get('src') if tag in ('script','img') else values.get('href') if tag=='link' and values.get('rel')=='stylesheet' else None
        if value and not urlsplit(value).scheme:self.paths.append(value)

class StaticDependencyTests(unittest.TestCase):
    def test_built_page_references_are_verified_and_served(self):
        with tempfile.TemporaryDirectory(prefix='daty-r19-static-') as folder:
            output=Path(os.environ['DATY_BUILT_PUBLIC']) if os.environ.get('DATY_BUILT_PUBLIC') else build(Path(folder)/'public')
            verify_assets(output)
            parser=References();parser.feed((output/'unirf-app.html').read_text('utf-8'))
            self.assertNotIn('src/modules/data-management.js',[urlsplit(v).path for v in parser.paths])
            self.assertIn('root.DatyDataManagement',(output/'src/modules/render.js').read_text('utf-8'))
            self.assertIn('r19 data views',(output/'src/styles/main.css').read_text('utf-8'))
            tls=create_tls_fixture(Path(folder)/'tls')
            server=CandidateHTTPSServer(('127.0.0.1',0),partial(Handler,directory=str(output)))
            server.tls_context=server_context(tls)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                c=http.client.HTTPSConnection('127.0.0.1',server.server_port,context=client_context(tls),timeout=10)
                try:
                    for reference in parser.paths:
                        name=urlsplit(reference).path
                        self.assertIn(name,ASSETS,reference)
                        c.request('GET','/'+reference);r=c.getresponse();body=r.read()
                        self.assertEqual(r.status,200,reference)
                        self.assertEqual(body,(output/name).read_bytes(),reference)
                    c.request('GET','/candidate-manifest.json');r=c.getresponse();r.read();self.assertEqual(r.status,404)
                finally:c.close()
            finally:server.shutdown();server.server_close();thread.join(3)

if __name__=='__main__':unittest.main(verbosity=2)
