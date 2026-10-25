"""Durable export-then-remove lifecycle. Never deletes business history or dependencies."""
import hashlib,json,re,threading,time
from plugin_install import PluginError,path_inside

class ExportRemoval:
    def __init__(self, manager):
        self.manager=manager;self.store=manager.store
        self.draining=set();self.retiring={};self.stop_event=threading.Event();self.thread=None
        self.wake_event=threading.Event();self.step_lock=threading.Lock()

    def request(self, body, actor, allowed):
        identity=body['plugin_id'];digest=body['sha256'];oid=body['operation_id'];revision=body['expected_revision']
        if (not isinstance(identity,str) or not re.fullmatch('[a-z0-9][a-z0-9-]{0,63}',identity)
            or identity in ('fashe-mqtt','datyaudio','unknown-readonly')):raise PluginError('BUILTIN_OR_INVALID_PLUGIN',409)
        if (not isinstance(oid,str) or not re.fullmatch('[A-Za-z0-9_-]{16,80}',oid) or type(revision) is not int
            or any(not isinstance(x,str) or not re.fullmatch('[a-f0-9]{64}',x) for x in (digest,body['export_sha256']))
            or type(body['export_bytes']) is not int or not 1<=body['export_bytes']<=512*1024*1024):raise PluginError('INVALID_EXPORT_REMOVAL')
        intent=hashlib.sha256(json.dumps(['remove_exported',body],sort_keys=True).encode()).hexdigest()
        with self.store.lock,self.store.connection() as c:
            previous=c.execute('SELECT * FROM operations WHERE id=?',(oid,)).fetchone()
            if previous:
                if previous['actor']!=actor or previous['digest']!=intent:raise PluginError('INSTALL_OPERATION_CONFLICT',409)
                return json.loads(previous['result'])
            if c.execute('SELECT value FROM revision').fetchone()[0]!=revision:raise PluginError('PLUGIN_REVISION_CHANGED',409)
            row=c.execute('SELECT * FROM plugins WHERE id=?',(identity,)).fetchone()
            if row is None or row['sha256']!=digest:raise PluginError('EXPORTED_PLUGIN_CHANGED',409)
            if row['state'] not in ('installed','failed'):raise PluginError('PLUGIN_REMOVAL_PENDING',409)
            if not allowed():raise PluginError('REMOVAL_REQUEST_EXPIRED',409)
            result={'action':'remove_exported','operation_id':oid,'id':identity,'sha256':digest,
                'export_sha256':body['export_sha256'],'export_bytes':body['export_bytes'],
                'state':'removal_pending','revision':revision+1,'error':None}
            # Block new commands before committing intent; existing sends finish normally.
            self.draining.add(identity)
            try:
                c.execute('BEGIN IMMEDIATE')
                c.execute("UPDATE plugins SET state='remove_requested',error=NULL WHERE id=?",(identity,))
                c.execute('UPDATE revision SET value=value+1')
                c.execute('INSERT INTO operations VALUES(?,?,?,?)',(oid,actor,intent,json.dumps(result)));c.commit()
            except BaseException:self.draining.discard(identity);raise
            self.wake_event.set()  # Only committed removal intent may wake cleanup.
            return result

    def start(self):
        self.draining.update(r['id'] for r in self.store.status()['plugins'] if r['state'] in ('remove_requested','removing'))
        self.thread=threading.Thread(target=self.run,name='Plugin-export-removal',daemon=True);self.thread.start()

    def busy(self, record):
        m=self.manager;service=m.bus.service
        if m.scans.busy(record['id']):
            m.scans.request_stop(record['id'],'PLUGIN_REMOVAL_PENDING')
            return True
        if m.sending.get(record['id'],0):return True
        if service:
            rows=service.journal.pending()+service.journal.unresolved_records()
            if any(m.b._normalize_device_brand(r['target']['expected_brand'])==m.b._normalize_device_brand(record['brand']) for r in rows):return True
        if record['id']=='shure-scp' and m.auto_discovery and m.auto_discovery.service.active_scan:return True
        return False

    def purge(self, identity):
        # Validate the complete absolute target tree BEFORE removing anything.
        folder=path_inside(self.store.root,'packages/'+identity)
        if not folder.exists():return
        entries=list(folder.rglob('*'))
        for p in entries:path_inside(self.store.root,p.relative_to(self.store.root).as_posix())
        for p in sorted(entries,key=lambda p:len(p.parts),reverse=True):
            safe=path_inside(self.store.root,p.relative_to(self.store.root).as_posix())
            if safe.is_dir():safe.rmdir()
            else:safe.unlink()
        folder.rmdir()

    def step(self):
        pending=False
        # One worker owns cleanup; the registry lock must not cover slow thread
        # shutdown or filesystem I/O, which would block unrelated platform RPCs.
        with self.step_lock:
            with self.store.lock:records=self.store.status()['plugins']
            for record in records:
                identity=record['id']
                if record['state'] not in ('remove_requested','removing'):continue
                self.draining.add(identity)
                try:
                    if record['state']=='remove_requested' and self.busy(record):
                        pending=True;continue
                    with self.store.lock:
                        with self.store.connection() as c:
                            current=c.execute('SELECT sha256,state FROM plugins WHERE id=?',(identity,)).fetchone()
                            if current is None or current['sha256']!=record['sha256'] or current['state'] not in ('remove_requested','removing'):continue
                            c.execute("UPDATE plugins SET state='removing' WHERE id=? AND sha256=?",(identity,record['sha256']))
                    self.manager.deactivate(identity)
                    self.purge(identity)
                    with self.store.lock,self.store.connection() as c:
                        c.execute('BEGIN IMMEDIATE')
                        deleted=c.execute("DELETE FROM plugins WHERE id=? AND sha256=? AND state='removing'",(identity,record['sha256']))
                        if deleted.rowcount!=1:raise PluginError('REMOVAL_IDENTITY_CHANGED',409)
                        c.execute('UPDATE revision SET value=value+1')
                        revision=c.execute('SELECT value FROM revision').fetchone()[0]
                        for row in c.execute('SELECT id,result FROM operations').fetchall():
                            result=json.loads(row['result'])
                            if result.get('action')=='remove_exported' and result.get('state')=='removal_pending' and result['id']==identity and result['sha256']==record['sha256']:
                                result.update(state='removed',revision=revision,error=None,completed_at=time.time())
                                c.execute('UPDATE operations SET result=? WHERE id=?',(json.dumps(result),row['id']))
                    self.draining.discard(identity);self.manager.errors.pop(identity,None)
                except Exception as error:
                    # No success receipt until both the adapter and its installed files are gone.
                    pending=True;self.manager.errors[identity]=getattr(error,'code',type(error).__name__)
                    with self.store.lock,self.store.connection() as c:c.execute('UPDATE plugins SET error=? WHERE id=? AND sha256=?',(self.manager.errors[identity],identity,record['sha256']))
        return pending

    def run(self):
        while not self.stop_event.is_set():
            # Clear before reading durable state: requests arriving during step
            # remain signalled, so the transition to an idle wait cannot lose one.
            self.wake_event.clear();pending=True
            try:
                pending=self.step();self.manager.errors.pop('removal_worker',None)
            except Exception as error:self.manager.errors['removal_worker']=type(error).__name__
            if self.stop_event.is_set():break
            self.wake_event.wait(.5 if pending else None)

    def stop(self):
        self.stop_event.set();self.wake_event.set()
        if self.thread:self.thread.join(15)
