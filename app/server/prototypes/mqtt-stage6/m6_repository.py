"""All durable business/command receipts share the existing validated SQLite.

No schema changes, auxiliary database, writable history or secret persistence.
Only an isolated M6 candidate may construct these components at this stage.
"""
from contextlib import contextmanager
import contextvars
import copy
import hashlib
from pathlib import Path
import threading
import time
import uuid

import unified_database as db
from command_journal import CommandError, ProcessLease, INFLIGHT, TERMINAL, canonical
from m5_service import LargeRepository
from data_contract import DataError

ORIGIN = 'daty-mqtt-stage6'
PREFIX = 'mqtt6:'
ACTOR = contextvars.ContextVar('mqtt6_actor', default=None)

def connection_refs(value, *, storage):
    # This public random generation fences an old receiver connection; it is
    # neither a login session nor a credential. Use the domain's explicit
    # generation term on disk; leave its established wire DTO unchanged.
    source,target=('receiver_session_id','receiver_generation') if storage else ('receiver_generation','receiver_session_id')
    if isinstance(value,dict):
        return {(target if k==source else k):connection_refs(v,storage=storage) for k,v in value.items()}
    if isinstance(value,list):return [connection_refs(v,storage=storage) for v in value]
    return value

class Repository(LargeRepository):
    def __init__(self,*args,**kwargs):
        try:super().__init__(*args,**kwargs)
        except BaseException:
            if getattr(self,'lease',None):self.lease.close()
            raise

    @contextmanager
    def connection(self):
        # All current-runtime writers share the Bridge lock before entering
        # SQLite. A separate RPC connection must not race the continuous FULL
        # telemetry writer and starve at SQLite's busy timeout.
        if not self.bridge._db_lock.acquire(timeout=3):raise DataError('DATABASE_BUSY',503)
        try:
            with super().connection() as c:
                c.execute('PRAGMA wal_autocheckpoint=0').close()
                yield c
        finally:self.bridge._db_lock.release()

    @staticmethod
    def unreserved(body):
        LargeRepository.unreserved(body)
        for item in body.get('writes', [body]):
            value = item.get('value')
            if (str(item.get('id','')).startswith(PREFIX)
                    or str(item.get('operation_id','')).startswith('m6internal_')
                    or isinstance(value,dict) and (value.get('sourceOrigin') == ORIGIN
                        or str(value.get('sourceKey','')).startswith(PREFIX))):
                raise DataError('RESERVED_RPC_NAMESPACE',409)

    @staticmethod
    def m6_get(c, key):
        row = c.execute("SELECT s.id FROM db_legacy_snapshots s JOIN db_resource_versions v "
            "ON v.kind='legacy_snapshots' AND v.id=s.id AND v.revision=1 "
            "WHERE s.source_origin=? AND s.source_key=? ORDER BY v.audit_seq DESC LIMIT 1",
            (ORIGIN, PREFIX+key)).fetchone()
        return connection_refs(db.get_resource(c,'legacy_snapshots',row[0])['value']['payload'],storage=False) if row else None

    def m6_put(self,c,key,value,actor):
        previous = self.m6_get(c,key)
        revision = previous['_receipt_revision'] + 1 if previous else 1
        value = {**value,'_receipt_revision':revision}
        resource_id = PREFIX+key+':'+str(revision)
        operation = 'm6internal_'+hashlib.sha256(resource_id.encode()).hexdigest()
        db.put_resource(c,{'operation_id':operation,'epoch':db.status(c)['epoch'],
            'kind':'legacy_snapshots','id':resource_id,'expected_revision':0,
            'value':{'sourceOrigin':ORIGIN,'sourceKey':PREFIX+key,'payload':connection_refs(value,storage=True)}},
            actor,int(time.time()*1000))

class Journal:
    """M3 state-machine port with immutable records in the original unified DB.

    The pending cache contains only current operations; it is updated AFTER FULL
    commit and only accelerates polling. Identity/value/result remain on disk.
    Explicit review releases a target but preserves its original unknown outcome.
    """
    def __init__(self, repository, *, fixture_root=None, runtime_scope=None):
        if runtime_scope is not None:
            from m6_scope import checked_scope
            checked_scope(runtime_scope).check_database(repository.path)
        else:
            root = Path(fixture_root).resolve()
            if not (root/'.daty-mqtt-stage6-fixture').is_file() or not repository.path.is_relative_to(root):
                raise ValueError('Isolated M6 journal required')
        self.repo = repository
        self.lease = ProcessLease(str(repository.path)+'.mqtt6-command-owner.lock')
        self.lock = threading.RLock()
        self.entry, self.poisoned, self.active = 'mqtt', False, {}
        self.unresolved = {}
        try:
            with self.transaction() as c:
                keys = c.execute("SELECT DISTINCT source_key FROM db_legacy_snapshots WHERE source_origin=? AND source_key LIKE 'mqtt6:op:%'",(ORIGIN,)).fetchall()
                for row in keys:
                    record = self.repo.m6_get(c,row[0][len(PREFIX):])
                    if record['state'] in INFLIGHT:
                        record = self._change(c,record,'unknown',error='PROCESS_INTERRUPTED')
                    if record['state'] in ('unknown','timeout') and not record.get('review'):
                        lock = self.repo.m6_get(c,'target:'+self.target_key(record['target']['device_id']))
                        if lock and lock.get('operation_id') == record['operation_id']:
                            self.unresolved[record['operation_id']] = copy.deepcopy(record)
        except BaseException:
            self.lease.close()
            raise

    @contextmanager
    def transaction(self):
        with self.lock:
            if self.poisoned or self.repo.poisoned:
                raise CommandError('JOURNAL_UNAVAILABLE')
            with self.repo.connection() as c:
                c.execute('BEGIN IMMEDIATE')
                try:
                    yield c
                    self.commit(c)
                except BaseException:
                    c.rollback()
                    raise

    def commit(self,c):
        try:
            self.repo.commit(c)
        except BaseException:
            self.poisoned = True
            raise

    def actor(self):
        actor = ACTOR.get()
        if not actor:
            raise CommandError('NETWORK_ACTOR_REQUIRED')
        return actor

    @staticmethod
    def public(record):
        return {k:copy.deepcopy(v) for k,v in record.items()
                if k not in ('digest','actor','_receipt_revision')}

    def _get(self,c,oid):
        record = self.repo.m6_get(c,'op:'+oid)
        if not record:
            raise CommandError('NOT_FOUND')
        return record

    def get(self,oid):
        with self.lock, self.repo.connection() as c:
            if self.poisoned or self.repo.poisoned:
                raise CommandError('JOURNAL_UNAVAILABLE')
            return self.public(self._get(c,oid))

    def owned(self,oid,actor):
        with self.lock, self.repo.connection() as c:
            if self.poisoned or self.repo.poisoned:
                raise CommandError('JOURNAL_UNAVAILABLE')
            record = self._get(c,oid)
            if record['actor']['id'] != actor['id']:
                raise CommandError('OPERATION_OWNER_MISMATCH')
            return self.public(record)

    def by_command(self,command_id):
        if not isinstance(command_id,str):
            return None
        with self.lock, self.repo.connection() as c:
            if self.poisoned or self.repo.poisoned:
                raise CommandError('JOURNAL_UNAVAILABLE')
            index = self.repo.m6_get(c,'cmd:'+command_id)
            return self.public(self._get(c,index['operation_id'])) if index else None

    def reserve(self,request,entry):
        if entry != self.entry:
            raise CommandError('CONTROL_ENTRY_DISABLED')
        actor = self.actor()
        content = {k:request[k] for k in ('server_id','boot_id','deadline_at_ms','body')}
        digest = hashlib.sha256(canonical(content).encode()).hexdigest()
        oid,rid = request['body']['operation_id'],request['request_id']
        binding = {'operation_id':oid,'digest':digest,'actor':actor['id'],'entry':entry}
        with self.lock:
            with self.transaction() as c:
                prior_request = self.repo.m6_get(c,'req:'+rid)
                if prior_request and any(prior_request.get(k)!=v for k,v in binding.items()):
                    raise CommandError('REQUEST_ID_CONFLICT')
                prior = self.repo.m6_get(c,'op:'+oid)
                if prior and (prior['digest'] != digest or prior['actor']['id'] != actor['id'] or prior['entry'] != entry):
                    raise CommandError('OPERATION_ID_CONFLICT')
                if not prior:
                    target = content['body']['target']['device_id']
                    lock = self.repo.m6_get(c,'target:'+self.target_key(target))
                    if lock and lock['operation_id']:
                        raise CommandError('TARGET_PENDING_OR_UNCERTAIN')
                    now = int(time.time()*1000)
                    record = {'operation_id':oid,'command_id':uuid.uuid4().hex,'digest':digest,
                        'entry':entry,'actor':actor,'state':'reserved','revision':1,
                        **{k:content[k] for k in ('server_id','boot_id','deadline_at_ms')},
                        **{k:content['body'][k] for k in ('target','command','expected_value')},
                        'attempts':0,'error':None,'actual_value':None,'execution_evidence':None,
                        'created_at_ms':now,'updated_at_ms':now,'review':None}
                    self.repo.m6_put(c,'op:'+oid,record,actor)
                    self.repo.m6_put(c,'cmd:'+record['command_id'],{'operation_id':oid},actor)
                    self.repo.m6_put(c,'target:'+self.target_key(target),{'operation_id':oid},actor)
                    self.timeline(c,record)
                else:
                    record = prior
                if not prior_request:
                    self.repo.m6_put(c,'req:'+rid,binding,actor)
            # FULL commit precedes publishing this active operation to expiry/send.
            if not prior:
                self.active[oid] = self.public(record)
            return self.public(record),prior is None

    @staticmethod
    def target_key(device_id):
        return hashlib.sha256(device_id.encode()).hexdigest()

    @staticmethod
    def timeline(c,record,kind=None):
        return  # Command transaction/receipt remains in m6_put; no audit copy.
        state=kind or record['state']
        details={'operation_id':record['operation_id'],'revision':record['revision'],
            'actor':record['actor'],'target':connection_refs(record['target'],storage=True),
            'expected':record['expected_value'],'actual':record['actual_value'],
            'unit':'kHz' if record['command']=='set_freq' else 'boolean',
            'execution_evidence':connection_refs(record['execution_evidence'],storage=True),
            'error':record['error']}
        if kind=='reviewed':details['review']=connection_refs(record['review'],storage=True)
        c.execute('INSERT INTO timeline_events(project_id,ts,event_type,device_id,command_id,summary,details_json) VALUES(?,?,?,?,?,?,?)',
            ('default',time.time(),'command.'+state,record['target']['device_id'],record['command_id'],
             '接收机指令 '+record['command']+' · '+state,canonical(details)))

    def _change(self,c,record,state,error=None,actual=None,evidence=None,*,attempt=False):
        changed = {**record,'state':state,'revision':record['revision']+1,
            'error':error,'actual_value':actual,'execution_evidence':evidence,
            'attempts':record['attempts']+int(attempt),'updated_at_ms':int(time.time()*1000)}
        self.repo.m6_put(c,'op:'+record['operation_id'],changed,record['actor'])
        self.timeline(c,changed)
        if state in ('readback_confirmed','acknowledged','not_sent','rejected'):
            self.repo.m6_put(c,'target:'+self.target_key(record['target']['device_id']),
                             {'operation_id':None},record['actor'])
        return changed

    def transition(self,oid,expected,state,**kwargs):
        if state not in INFLIGHT | TERMINAL:
            raise CommandError('INVALID_STATE')
        with self.lock:
            with self.transaction() as c:
                record = self._get(c,oid)
                if record['state'] in expected:
                    record = self._change(c,record,state,**kwargs)
            if record['state'] in INFLIGHT:
                self.active[oid] = self.public(record)
            else:
                self.active.pop(oid,None)
            if record['state'] in ('timeout','unknown') and not record.get('review'):
                self.unresolved[oid] = copy.deepcopy(record)
            else:
                self.unresolved.pop(oid,None)
            return self.public(record)

    def pending(self):
        with self.lock:
            if self.poisoned or self.repo.poisoned:
                raise CommandError('JOURNAL_UNAVAILABLE')
            return copy.deepcopy(list(self.active.values()))

    def unresolved_records(self):
        # Internal server worker only. Cache changes follow durable commits.
        with self.lock:
            if self.poisoned or self.repo.poisoned:raise CommandError('JOURNAL_UNAVAILABLE')
            return [self.public(r) for r in self.unresolved.values()]

    def uncertain(self,actor):
        with self.lock:
            if self.poisoned or self.repo.poisoned:raise CommandError('JOURNAL_UNAVAILABLE')
            return [self.public(r) for r in self.unresolved.values() if r['actor']['id']==actor['id']]

    def auto_review(self,oid,revision,observation,allowed):
        # No RPC can select this server-owned authority or substitute evidence.
        with self.lock, self.repo.connection() as c:
            actor=copy.deepcopy(self._get(c,oid)['actor'])
        return self.review(oid,revision,True,
            '服务器自动核对当前接收机参数，解除旧操作占用；保留原未知结果，不重发指令。',
            observation,actor,allowed,automatic=True)

    def review(self,oid,revision,confirmed,note,observation,actor,allowed=lambda:True,*,automatic=False):
        if confirmed is not True or type(revision) is not int or not isinstance(note,str) or not 1 <= len(note.strip()) <= 500:
            raise CommandError('EXPLICIT_REVIEW_REQUIRED')
        with self.transaction() as c:
            if not allowed():raise CommandError('REVIEW_EXPIRED_OR_CHANGED')
            record=self._get(c,oid)
            if record['actor']['id'] != actor['id']:
                raise CommandError('OPERATION_OWNER_MISMATCH')
            if record['revision'] != revision:
                raise CommandError('REVIEW_REVISION_CHANGED')
            if record['state'] not in ('timeout','unknown') or record.get('review'):
                raise CommandError('UNCERTAIN_UNREVIEWED_ONLY')
            if observation is None:
                raise CommandError('CURRENT_RECEIVER_OBSERVATION_REQUIRED')
            # A fresh observation aids the human decision, but cannot prove that
            # this old command executed. Preserve state/error/actual/ACK evidence.
            review={'confirmed':True,'note':note.strip(),'actor':actor,'observed':observation,
                    'reviewed_at_ms':int(time.time()*1000),'meaning':'release-target-no-execution-claim'}
            if automatic:
                review.update(mode='automatic',actor={'id':'server-command-reconciliation','kind':'server'},
                    evidence_source='current-receiver-telemetry')
            record={**record,'review':review,'revision':revision+1}
            self.repo.m6_put(c,'op:'+oid,record,actor)
            key='target:'+self.target_key(record['target']['device_id'])
            lock=self.repo.m6_get(c,key)
            if not lock or lock['operation_id']!=oid:
                raise CommandError('TARGET_LOCK_CHANGED')
            self.repo.m6_put(c,key,{'operation_id':None},actor)
            self.timeline(c,record,'reviewed')
            if not allowed():raise CommandError('REVIEW_EXPIRED_OR_CHANGED')
        with self.lock:self.unresolved.pop(oid,None)
        return self.public(record)

    def close(self):
        self.lease.close()
