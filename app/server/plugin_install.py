"""Versioned, durable installation of explicitly trusted brand source packages.

Trusted Python is not sandboxed. A ZIP's self-declared hashes do not establish
trust: the complete archive must be present in the separately shipped catalog.
No code executes during preview, verification or extraction.
"""
from pathlib import Path, PurePosixPath
import base64, builtins, copy, hashlib, io, json, os, re, sqlite3, stat, sys, threading, time, types, uuid, zipfile
from contextlib import contextmanager

MAX_PACKAGE = 128 * 1024
MAX_EXPANDED = 4 * 1024 * 1024
API = 'daty-brand-plugin-host-v1'

class PluginError(Exception):
    def __init__(self, code, status=400):
        super().__init__(code);self.code,self.status=code,status

def json_unique(raw):
    def pairs(items):
        result={}
        for key,value in items:
            if key in result:raise PluginError('DUPLICATE_JSON_KEY')
            result[key]=value
        return result
    try:return json.loads(raw,object_pairs_hook=pairs)
    except PluginError:raise
    except (ValueError,UnicodeError):raise PluginError('INVALID_PACKAGE_JSON')

def path_inside(root, relative):
    p=PurePosixPath(relative)
    if (not relative or p.is_absolute() or '..' in p.parts or '.' in p.parts
        or '\\' in relative or ':' in relative or str(p)!=relative
        or any(part.endswith((' ','.')) or re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?',part) for part in p.parts)):
        raise PluginError('UNSAFE_PACKAGE_PATH')
    target=root.joinpath(*p.parts)
    for parent in (target,*target.parents):
        if parent.is_symlink() or (hasattr(parent,'is_junction') and parent.is_junction()):raise PluginError('PACKAGE_LINK_FORBIDDEN')
        if parent==root:break
    if not target.resolve().is_relative_to(root.resolve()):raise PluginError('PACKAGE_PATH_ESCAPE')
    if target.exists() and target.is_file() and target.stat().st_nlink!=1:raise PluginError('PACKAGE_LINK_FORBIDDEN')
    return target

class PackageCatalog:
    def __init__(self, path):
        data=json_unique(Path(path).read_bytes())
        if not isinstance(data,dict) or data.get('schema')!='daty-trusted-plugin-catalog-v1' or not isinstance(data.get('releases'),list):raise PluginError('INVALID_TRUST_CATALOG')
        self.releases={}
        for release in data['releases']:
            if (release['host_api']!=API or re.sub(r'[\s_-]+','',release['brand']).lower() in ('daty','datyaudio')
                or release['id'] in ('fashe-mqtt','unknown-readonly')
                or not re.fullmatch('[a-z0-9][a-z0-9-]{0,63}',release['id'])
                or not re.fullmatch('[a-f0-9]{64}',release['sha256']) or release['sha256'] in self.releases):raise PluginError('INVALID_TRUST_ENTRY')
            if (not isinstance(release.get('capabilities'),dict) or not isinstance(release.get('version'),str)
                or release.get('observation_format') not in ('shure-v1','shure-v2','canonical-v1')
                or not {'discovery','control'} <= set(release.get('entrypoints',{})) <= {'discovery','control','scan_files','scan_live'}
                or ('scan_files' in release.get('entrypoints',{})) != (release['capabilities'].get('read_scan_file') is True)
                or ('scan_live' in release.get('entrypoints',{})) != (release['capabilities'].get('scan') is True)
                or not isinstance(release.get('adapterKeys'),list) or not release['adapterKeys']
                or len(set(release['adapterKeys']))!=len(release['adapterKeys'])
                or any(not re.fullmatch('[a-z0-9][a-z0-9-]{0,63}',k) or k in ('fashe-mqtt','unknown-readonly') for k in release['adapterKeys'])):raise PluginError('INVALID_TRUST_ENTRY')
            self.releases[release['sha256']]=release

    def decode(self, encoded):
        if not isinstance(encoded,str) or len(encoded)>((MAX_PACKAGE+2)//3)*4:raise PluginError('PLUGIN_PACKAGE_TOO_LARGE',413)
        try:raw=base64.b64decode(encoded,validate=True)
        except ValueError:raise PluginError('INVALID_PACKAGE_BASE64')
        return self.verify(raw)

    def verify(self, raw):
        if not isinstance(raw,bytes) or not 1<=len(raw)<=MAX_PACKAGE:raise PluginError('PLUGIN_PACKAGE_TOO_LARGE',413)
        digest=hashlib.sha256(raw).hexdigest();release=self.releases.get(digest)
        if release is None:raise PluginError('PLUGIN_PACKAGE_NOT_TRUSTED',403)
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                infos=archive.infolist()
                if not 1<=len(infos)<=128 or sum(i.file_size for i in infos)>MAX_EXPANDED:raise PluginError('PLUGIN_EXPANSION_LIMIT',413)
                names=set();contents={}
                for info in infos:
                    name=info.filename;path_inside(Path.cwd(),name)
                    if name.casefold() in names or info.is_dir() or info.flag_bits&1 or stat.S_ISLNK(info.external_attr>>16):raise PluginError('INVALID_ZIP_ENTRY')
                    if info.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED):raise PluginError('UNSUPPORTED_ZIP_COMPRESSION')
                    names.add(name.casefold());contents[name]=archive.read(info)
        except PluginError:raise
        except (ValueError,RuntimeError,zipfile.BadZipFile,NotImplementedError):raise PluginError('INVALID_ZIP')
        prefix=release['id']+'/'
        manifest=json_unique(contents.get(prefix+'manifest.json',b''))
        if (not isinstance(manifest,dict) or manifest.get('id')!=release['id'] or manifest.get('brand')!=release['brand']
            or manifest.get('schema') not in ('daty-plugin-source-package-v1','daty-plugin-package-v1')
            or manifest.get('sourceRevision')!=release['version']
            or manifest.get('adapterKeys')!=release['adapterKeys']):raise PluginError('PLUGIN_IDENTITY_MISMATCH')
        files=manifest.get('files')
        if not isinstance(files,dict) or not files:raise PluginError('EMPTY_PLUGIN')
        if set(contents)!={prefix+'manifest.json',prefix+'README.md',*(prefix+'src/'+p for p in files)}:raise PluginError('UNDECLARED_PACKAGE_FILES')
        sources={}
        for name,digest_value in files.items():
            path_inside(Path.cwd(),name)
            if Path(name).suffix not in ('.py','.js','.cjs','.md'):raise PluginError('PLUGIN_FILE_TYPE_FORBIDDEN')
            blob=contents[prefix+'src/'+name]
            if hashlib.sha256(blob).hexdigest()!=digest_value:raise PluginError('PLUGIN_FILE_HASH_MISMATCH')
            try:blob.decode('utf-8-sig')
            except UnicodeError:raise PluginError('INVALID_SOURCE_ENCODING')
            sources[name]=blob
        for entry in release['entrypoints'].values():
            if entry['file'] not in sources or not entry['file'].endswith('.py') or not re.fullmatch(r'[A-Za-z_]\w*',entry['class']):raise PluginError('INVALID_PLUGIN_ENTRYPOINT')
        return {'sha256':hashlib.sha256(raw).hexdigest(),'raw':raw,'release':copy.deepcopy(release),'manifest':manifest,'sources':sources}

class SourceNamespace:
    """Load package-local absolute imports under an isolated module namespace."""
    def __init__(self, root, verified):
        self.root=Path(root);self.files=verified['sources'];self.modules={}
        self.prefix='_daty_plugin_'+verified['release']['id'].replace('-','_')+'_'+uuid.uuid4().hex
        self.local={Path(p).stem:p for p in self.files if p.endswith('.py')}
        if len(self.local)!=sum(p.endswith('.py') for p in self.files):raise PluginError('AMBIGUOUS_PLUGIN_MODULE')
    def load(self, path):
        if path in self.modules:return self.modules[path]
        module=types.ModuleType(self.prefix+'.'+path.replace('/','.').removesuffix('.py'))
        module.__file__=str(path_inside(self.root,path));module.__package__=module.__name__.rpartition('.')[0]
        def importing(name,globals=None,locals=None,fromlist=(),level=0):
            if level==0 and name in self.local:return self.load(self.local[name])
            return builtins.__import__(name,globals,locals,fromlist,level)
        module.__dict__['__builtins__']={**vars(builtins),'__import__':importing}
        self.modules[path]=module;sys.modules[module.__name__]=module
        try:exec(compile(self.files[path],module.__file__,'exec'),module.__dict__)
        except BaseException:self.close();raise
        return module
    def entry(self, entry):return getattr(self.load(entry['file']),entry['class'])
    def close(self):
        for module in self.modules.values():sys.modules.pop(module.__name__,None)
        self.modules.clear()

class PluginStore:
    def __init__(self, root, catalog):
        self.root=Path(root).absolute();path_inside(self.root.parent,self.root.name)
        self.root.mkdir(parents=True,exist_ok=True);self.catalog=catalog;self.lock=threading.RLock()
        self.db=path_inside(self.root,'registry.sqlite3')
        with self.connection() as c:
            c.executescript('CREATE TABLE IF NOT EXISTS plugins(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,version TEXT NOT NULL,brand TEXT NOT NULL,state TEXT NOT NULL,installed_at REAL NOT NULL,error TEXT);'
                'CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,actor TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL);'
                'CREATE TABLE IF NOT EXISTS revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value INTEGER NOT NULL);'
                'INSERT OR IGNORE INTO revision VALUES(1,0);')
    @contextmanager
    def connection(self):
        c=sqlite3.connect(self.db,timeout=3);c.row_factory=sqlite3.Row;c.execute('PRAGMA synchronous=FULL')
        try:
            with c:yield c
        finally:c.close()
    def status(self):
        with self.lock,self.connection() as c:
            return {'schema':'daty-plugin-install-state-v1','revision':c.execute('SELECT value FROM revision').fetchone()[0],
                'plugins':[dict(r) for r in c.execute('SELECT * FROM plugins ORDER BY id')]}
    def preview(self, raw):
        item=self.catalog.verify(raw);release=item['release'];state=self.status()
        return {'id':release['id'],'brand':release['brand'],'name':release['name'],'version':release['version'],
            'sha256':item['sha256'],'source_files':len(item['sources']),'bytes':len(raw),'trusted':True,'host_api':API,
            'format':item['manifest']['schema'],'compatibility_import':item['manifest']['schema']=='daty-plugin-source-package-v1','revision':state['revision']}
    def operation(self, operation_id, actor):
        if not isinstance(operation_id,str) or not re.fullmatch('[A-Za-z0-9_-]{16,80}',operation_id):raise PluginError('INVALID_INSTALL_INTENT')
        with self.lock,self.connection() as c:
            row=c.execute('SELECT * FROM operations WHERE id=? AND actor=?',(operation_id,actor)).fetchone()
            if row is None:raise PluginError('INSTALL_OPERATION_NOT_FOUND',404)
            return json.loads(row['result'])
    def reconcile(self, identity, digest, error=None):
        # Complete receipts left pending by a crash after the installation commit.
        with self.lock,self.connection() as c:
            for row in c.execute('SELECT id,result FROM operations').fetchall():
                result=json.loads(row['result'])
                if result.get('id')!=identity or result.get('sha256')!=digest or result.get('activation')!='pending':continue
                result.update(activation='failed' if error else 'active',error=error)
                if error:result['state']='failed'
                c.execute('UPDATE operations SET result=? WHERE id=?',(json.dumps(result),row['id']))
    def materialize(self, item):
        relative='packages/'+item['release']['id']+'/'+item['sha256'];folder=path_inside(self.root,relative)
        folder.mkdir(parents=True,exist_ok=True)
        for name,blob in {'package.zip':item['raw'],**{'src/'+k:v for k,v in item['sources'].items()}}.items():
            path=path_inside(folder,name);path.parent.mkdir(parents=True,exist_ok=True)
            if path.exists():
                if path.read_bytes()!=blob:raise PluginError('INSTALLED_FILES_CHANGED',409)
                continue
            temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
            try:
                with temporary.open('xb') as f:f.write(blob);f.flush();os.fsync(f.fileno())
                os.replace(temporary,path)
            finally:
                if temporary.exists():temporary.unlink()
        return folder/'src'
    def load_record(self, record):
        folder=path_inside(self.root,'packages/'+record['id']+'/'+record['sha256'])
        raw=path_inside(folder,'package.zip').read_bytes();item=self.catalog.verify(raw)
        if item['sha256']!=record['sha256'] or item['release']['id']!=record['id']:raise PluginError('INSTALLED_IDENTITY_CHANGED')
        for name,blob in item['sources'].items():
            if path_inside(folder,'src/'+name).read_bytes()!=blob:raise PluginError('INSTALLED_FILES_CHANGED')
        return item,folder/'src'
    def install(self, raw, *, operation_id, expected_revision, actor, allowed, activate):
        if not isinstance(operation_id,str) or not re.fullmatch('[A-Za-z0-9_-]{16,80}',operation_id) or type(expected_revision) is not int:raise PluginError('INVALID_INSTALL_INTENT')
        item=self.catalog.verify(raw);release=item['release'];digest=item['sha256']
        intent=hashlib.sha256(json.dumps([digest,expected_revision]).encode()).hexdigest()
        with self.lock,self.connection() as c:
            old=c.execute('SELECT * FROM operations WHERE id=?',(operation_id,)).fetchone()
            if old:
                if old['actor']!=actor or old['digest']!=intent:raise PluginError('INSTALL_OPERATION_CONFLICT',409)
                return json.loads(old['result'])
            revision=c.execute('SELECT value FROM revision').fetchone()[0]
            if revision!=expected_revision:raise PluginError('PLUGIN_REVISION_CHANGED',409)
            previous=c.execute('SELECT * FROM plugins WHERE id=?',(release['id'],)).fetchone()
            if previous and previous['state'] in ('remove_requested','removing'):raise PluginError('PLUGIN_REMOVAL_PENDING',409)
            if previous and previous['sha256']!=digest:raise PluginError('PLUGIN_UPDATE_REQUIRES_MAINTENANCE',409)
            if not allowed():raise PluginError('INSTALL_REQUEST_EXPIRED',409)
            root=self.materialize(item)
            if not allowed():raise PluginError('INSTALL_REQUEST_EXPIRED',409)
            record={'id':release['id'],'sha256':digest,'version':release['version'],'brand':release['brand'],'state':'installed','installed_at':time.time(),'error':None}
            result={**record,'operation_id':operation_id,'revision':revision+1,'activation':'pending'}
            c.execute('BEGIN IMMEDIATE')
            c.execute('INSERT OR REPLACE INTO plugins VALUES(:id,:sha256,:version,:brand,:state,:installed_at,:error)',record)
            c.execute('UPDATE revision SET value=value+1');c.execute('INSERT INTO operations VALUES(?,?,?,?)',(operation_id,actor,intent,json.dumps(result)))
            c.commit()  # Installation authority is durable before any plugin code runs.
            try:
                activate(item,root)
                result['activation']='active'
            except Exception as error:
                result.update(state='failed',activation='failed',error=type(error).__name__)
                c.execute('UPDATE plugins SET state=?,error=? WHERE id=?',('failed',result['error'],release['id']))
            c.execute('UPDATE operations SET result=? WHERE id=?',(json.dumps(result),operation_id));c.commit()
            return result
