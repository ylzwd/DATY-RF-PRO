"""No production resources: archives, catalog and registry are temporary."""
import base64,copy,hashlib,io,json,sqlite3,stat,tempfile,unittest,uuid,zipfile
from pathlib import Path
from plugin_install import API,MAX_PACKAGE,PackageCatalog,PluginError,PluginStore,SourceNamespace

ROOT=Path(__file__).resolve().parents[1]
def existing_package():
    return (ROOT/'tests/fixtures/shure-original-package.zip').read_bytes()

def synthetic_package():
    code=b'''class Discovery:
    def __init__(self, on_update, **kwargs): self.on_update=on_update;self.started=False
    def start(self): self.started=True
    def stop(self): self.started=False
class Control:
    def __init__(self,bus): self.b=bus.b;self.service=None
    def binding(self,did): return ({'device_id':did}, self.b._state['devices'][did])
    def targets(self): return []
    def validate(self,target,command): return command in ('mute','unmute')
    async def send(self,record,*,allowed): return {'fixture_only':True,'allowed':allowed()}
'''
    manifest={'schema':'daty-plugin-package-v1','id':'fixture-brand','brand':'Fixture Brand','sourceRevision':'test-1',
              'adapterKeys':['fixture-protocol'],'files':{'fixture.py':hashlib.sha256(code).hexdigest()}}
    release={'id':manifest['id'],'name':'Fixture Adapter','brand':manifest['brand'],'version':'test-1','host_api':API,
             'adapterKeys':manifest['adapterKeys'],'observation_format':'canonical-v1',
             'entrypoints':{'discovery':{'file':'fixture.py','class':'Discovery'},'control':{'file':'fixture.py','class':'Control'}},
             'capabilities':{'read_only':True,'read_frequency':True,'read_rf':True,'read_af':True,'mute':False}}
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('fixture-brand/manifest.json',json.dumps(manifest));z.writestr('fixture-brand/README.md','Isolated test only')
        z.writestr('fixture-brand/src/fixture.py',code)
    raw=stream.getvalue();release['sha256']=hashlib.sha256(raw).hexdigest()
    return raw,release

class Install(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='daty-plugin-unit-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.catalog=PackageCatalog(ROOT/'contracts/trusted-plugin-packages.json')
        self.raw=existing_package();self.store=PluginStore(self.root/'plugins',self.catalog);self.calls=[]
    def install(self,**options):
        args=dict(operation_id=uuid.uuid4().hex,expected_revision=self.store.status()['revision'],actor='test',allowed=lambda:True,activate=lambda *args:self.calls.append(args))
        args.update(options);return self.store.install(self.raw,**args)
    def trusted(self,raw,release=None):
        release=copy.deepcopy(release or next(iter(self.catalog.releases.values())))
        release['sha256']=hashlib.sha256(raw).hexdigest();self.catalog.releases[release['sha256']]=release
        return self.catalog.verify(raw)
    def rewrite(self,change):
        with zipfile.ZipFile(io.BytesIO(self.raw)) as z:entries=[(i,z.read(i)) for i in z.infolist()]
        entries=change(entries);out=io.BytesIO()
        with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
            for name,data in entries:z.writestr(name,data)
        return out.getvalue()
    def test_real_package_preview_and_durable_install(self):
        self.assertEqual(hashlib.sha256(self.raw).hexdigest(),'b6e7055ab3b3dbe45a094b01f9c483219269742d28afb5757e8ea9dfecfb5b12')
        view=self.store.preview(self.raw);self.assertTrue(view['compatibility_import']);self.assertEqual(view['source_files'],12)
        self.assertEqual(self.store.status()['plugins'],[]);self.assertEqual(self.calls,[])
        def activate(item,root):
            second=PluginStore(self.root/'plugins',self.catalog)
            self.assertEqual(second.status()['plugins'][0]['state'],'installed')
            self.assertEqual(root.parts[-1],'src');self.calls.append(root)
        result=self.install(activate=activate);self.assertEqual(result['activation'],'active')
        self.assertEqual(len(self.calls),1);self.assertEqual(self.store.operation(result['operation_id'],'test'),result)
        second=PluginStore(self.root/'plugins',self.catalog)
        verified,root=second.load_record(second.status()['plugins'][0]);self.assertEqual(verified['raw'],self.raw)
    def test_operation_id_and_revision_never_reactivate(self):
        operation=uuid.uuid4().hex;first=self.install(operation_id=operation,expected_revision=0)
        self.assertEqual(self.install(operation_id=operation,expected_revision=0),first);self.assertEqual(len(self.calls),1)
        for opts in ({'operation_id':operation,'expected_revision':0,'actor':'other'},{'operation_id':operation,'expected_revision':1},{'expected_revision':0}):
            with self.assertRaises(PluginError):self.install(**opts)
        with self.assertRaises(PluginError):self.store.operation(operation,'other')
        self.assertEqual(len(self.calls),1)
    def test_failed_and_expired_never_succeed(self):
        with self.assertRaisesRegex(PluginError,'EXPIRED'):self.install(allowed=lambda:False)
        self.assertEqual(self.store.status()['plugins'],[])
        def fail(*args):raise RuntimeError('fixture activation failure')
        result=self.install(activate=fail);self.assertEqual(result['activation'],'failed');self.assertEqual(self.store.status()['plugins'][0]['state'],'failed')
    def test_failed_files_do_not_activate(self):
        self.store.materialize=lambda item:(_ for _ in ()).throw(OSError('fixture disk full'))
        with self.assertRaises(OSError):self.install()
        self.assertEqual(self.calls,[]);self.assertEqual(self.store.status()['plugins'],[])
    def test_database_failure_rolls_back_authority_before_activation(self):
        with self.store.connection() as c:c.execute("CREATE TRIGGER fixture_no_write BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'fixture disk failure');END")
        with self.assertRaises(sqlite3.DatabaseError):self.install()
        self.assertEqual(self.calls,[]);self.assertEqual(self.store.status()['plugins'],[]);self.assertEqual(self.store.status()['revision'],0)
    def test_committed_pending_receipt_survives_interruption_and_is_reconciled(self):
        operation=uuid.uuid4().hex
        def stop(*args):raise SystemExit('fixture abrupt termination')
        with self.assertRaises(SystemExit):self.install(operation_id=operation,activate=stop)
        fresh=PluginStore(self.root/'plugins',self.catalog);receipt=fresh.operation(operation,'test')
        self.assertEqual(receipt['activation'],'pending')
        record=fresh.status()['plugins'][0];fresh.load_record(record)
        fresh.reconcile(record['id'],record['sha256']);self.assertEqual(fresh.operation(operation,'test')['activation'],'active')
    def test_unknown_corrupt_oversized_and_invalid_base64_rejected(self):
        for raw in (b'',b'bad zip',self.raw+b'tamper',b'x'*(MAX_PACKAGE+1)):
            with self.assertRaises(PluginError):self.catalog.verify(raw)
        with self.assertRaises(PluginError):self.catalog.decode('!!!')
        with self.assertRaisesRegex(PluginError,'INVALID_ZIP'):self.trusted(b'PK-invalid')
    def test_zip_path_duplicate_link_and_undeclared_rejected(self):
        for name in ('../outside.py','/absolute.py','C:/escape.py','shure-scp/src/CON.py','shure-scp/src/a\\b.py','shure-scp/src/extra.py'):
            raw=self.rewrite(lambda entries:entries+[(name,b'bad')])
            with self.assertRaises(PluginError):self.trusted(raw)
        raw=self.rewrite(lambda entries:entries+[entries[0]])
        with self.assertRaises(PluginError):self.trusted(raw)
        link=zipfile.ZipInfo('shure-scp/src/link.py');link.create_system=3;link.external_attr=(stat.S_IFLNK|0o777)<<16
        with self.assertRaises(PluginError):self.trusted(self.rewrite(lambda e:e+[(link,b'outside')]))
    def test_wrong_identity_version_missing_and_hash_rejected(self):
        for field,value in (('id','other'),('brand','DATYaudio'),('sourceRevision','bad'),('adapterKeys',['fashe-mqtt'])):
            def mutate(entries):
                result=[]
                for i,blob in entries:
                    if i.filename.endswith('/manifest.json'):
                        m=json.loads(blob);m[field]=value;blob=json.dumps(m).encode()
                    result.append((i,blob))
                return result
            with self.assertRaisesRegex(PluginError,'IDENTITY'):self.trusted(self.rewrite(mutate))
        with self.assertRaises(PluginError):self.trusted(self.rewrite(lambda e:e[:-1]))
        with self.assertRaisesRegex(PluginError,'HASH'):self.trusted(self.rewrite(lambda e:[(i,blob+b'# changed' if i.filename.endswith('shure_fields.py') else blob) for i,blob in e]))
    def test_tampered_installed_source_and_archive_rejected(self):
        self.install();record=self.store.status()['plugins'][0];item,root=self.store.load_record(record)
        path=root/'shure_fields.py';original=path.read_bytes();path.write_bytes(original+b'#changed')
        with self.assertRaisesRegex(PluginError,'CHANGED'):self.store.load_record(record)
        path.write_bytes(original);(root.parent/'package.zip').write_bytes(b'bad')
        with self.assertRaises(PluginError):self.store.load_record(record)
    def test_independent_brand_and_namespace(self):
        raw,release=synthetic_package();item=self.trusted(raw,release);root=self.store.materialize(item)
        import sys
        before=sys.modules.get('fixture');space=SourceNamespace(root,item)
        self.addCleanup(space.close);cls=space.entry(release['entrypoints']['discovery'])
        instance=cls(lambda _:None);instance.start();self.assertTrue(instance.started)
        self.assertTrue(cls.__module__.startswith('_daty_plugin_fixture_brand_'));self.assertIs(sys.modules.get('fixture'),before)
        self.assertEqual(Path(space.load('fixture.py').__file__),root/'fixture.py')
