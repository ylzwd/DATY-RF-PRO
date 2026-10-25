"""Offline replacement: require the same OS lease and resources as the server.

No activation or device I/O. The next normal startup verifies the installed
archive again and completes the durable pending receipt. Never hot-swap code.
"""
import hashlib,json,re,time
from plugin_install import PluginError
from m6_scope import checked_scope

def replace_plugin(store,scope,raw,*,operation_id,expected_revision,expected_sha256,actor):
    checked_scope(scope)
    if store.root.resolve()!=(scope.archives.parent/'plugins').resolve():raise PluginError('PLUGIN_MAINTENANCE_SCOPE_MISMATCH')
    if (not re.fullmatch('[A-Za-z0-9_-]{16,80}',operation_id) or type(expected_revision) is not int
        or not re.fullmatch('[a-f0-9]{64}',expected_sha256) or not isinstance(actor,str) or not 1<=len(actor)<=128):raise PluginError('INVALID_INSTALL_INTENT')
    item=store.catalog.verify(raw);release=item['release'];digest=item['sha256']
    intent=hashlib.sha256(json.dumps(['maintenance',digest,expected_revision,expected_sha256]).encode()).hexdigest()
    with store.lock,store.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        old=c.execute('SELECT * FROM operations WHERE id=?',(operation_id,)).fetchone()
        if old:
            if old['actor']!=actor or old['digest']!=intent:raise PluginError('INSTALL_OPERATION_CONFLICT',409)
            return json.loads(old['result'])
        revision=c.execute('SELECT value FROM revision').fetchone()[0]
        if revision!=expected_revision:raise PluginError('PLUGIN_REVISION_CHANGED',409)
        previous=c.execute('SELECT * FROM plugins WHERE id=?',(release['id'],)).fetchone()
        if not previous or previous['sha256']!=expected_sha256 or previous['brand']!=release['brand']:raise PluginError('PLUGIN_MAINTENANCE_BASE_CHANGED',409)
        store.load_record(dict(previous))
        store.materialize(item)
        record={'id':release['id'],'sha256':digest,'version':release['version'],'brand':release['brand'],'state':'installed','installed_at':time.time(),'error':None}
        result={**record,'operation_id':operation_id,'revision':revision+1,'activation':'pending','previous_sha256':expected_sha256,'mode':'offline-maintenance'}
        c.execute('UPDATE plugins SET sha256=:sha256,version=:version,brand=:brand,state=:state,installed_at=:installed_at,error=:error WHERE id=:id',record)
        c.execute('UPDATE revision SET value=value+1')
        c.execute('INSERT INTO operations VALUES(?,?,?,?)',(operation_id,actor,intent,json.dumps(result)))
    return result
