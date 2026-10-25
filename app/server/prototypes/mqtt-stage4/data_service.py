"""Single M4 authority: no commands, file operations or replay queue."""
import asyncio
import hashlib
import json
import time
from types import SimpleNamespace
import uuid

import unified_database as db
from data_contract import DataError, SCHEMA, SERVER, WRITES, fields, encoded, validate_request
from data_repository import PREFIX, Repository


class DataService:
    def __init__(self, repository, *, discovery):
        self.repo, self.discovery = repository, discovery
        self.boot_id, self.accepting = uuid.uuid4().hex, True
        self.wall_ms = lambda:int(time.time()*1000)
        self.monitor = None
        self.active_scan = None
        self.before_transaction = lambda:None
        self.error_response_metrics={'count':0,'wall_ms':0,'max_wall_ms':0}

    async def start(self):
        await asyncio.to_thread(self.recover)
        self.monitor = asyncio.create_task(self.watch_discovery())

    def recover(self):
        # Recovery records interruption, never relaunches a scan.
        with self.repo.connection() as c:
            c.execute('BEGIN IMMEDIATE')
            resources = c.execute("SELECT DISTINCT source_key FROM db_legacy_snapshots WHERE source_origin='daty-mqtt-stage4' AND source_key LIKE 'mqtt4-operation:%'").fetchall()
            for row in resources:
                record=self.repo.internal(c,row[0])['value']['payload']
                if record['state'] in ('dispatching','accepted'):
                    record.update(state='unknown',error='PROCESS_INTERRUPTED',updated_at_ms=self.wall_ms())
                    self.repo.save_receipt(c,record,self.repo.actor(record['actor'][8:]))
                if record['method']=='discovery.scan' and record['state']=='unknown':
                    self.active_scan=record['operation_id']
            self.repo.commit(c)

    async def close(self):
        self.accepting=False
        if self.monitor:
            self.monitor.cancel()
            await asyncio.gather(self.monitor,return_exceptions=True)

    async def request(self,request,*,entry,current,peer_ip):
        validate_request(request)
        if request['boot_id'] != self.boot_id: raise DataError('SERVER_BOOT_CHANGED',409)
        remaining=request['deadline_at_ms']-self.wall_ms()
        if remaining<=0 or remaining>30000: raise DataError('REQUEST_EXPIRED',408)
        end=time.monotonic()+remaining/1000
        def allowed():
            return current() and self.accepting and time.monotonic()<end and self.wall_ms()<request['deadline_at_ms']
        if not allowed(): raise DataError('CONNECTION_OR_DEADLINE_CHANGED',409)
        method=request['method']
        if method in WRITES and entry!='mqtt': raise DataError('DATA_ENTRY_DISABLED',409)
        actor=self.repo.actor(peer_ip)
        try:
            if method.startswith('discovery.') and method!='discovery.status':
                return await asyncio.to_thread(self.discover,request,actor,allowed)
            return await asyncio.to_thread(self.run,request,actor,allowed)
        except DataError as error:
            return await self.error_result(error)
        except Exception as error:
            if hasattr(error,'code'):
                return await self.error_result(error)
            raise

    async def error_result(self,error):
        # Error metadata is a real database read too. Waiting for the shared
        # FULL writer lock on the socket loop stalls unrelated device streams.
        # Keep the same snapshot/error contract, but wait in the DB executor.
        began=time.monotonic()
        try:return await asyncio.to_thread(self.domain_error,error)
        finally:
            elapsed=(time.monotonic()-began)*1000
            self.error_response_metrics['count']+=1
            self.error_response_metrics['wall_ms']+=elapsed
            self.error_response_metrics['max_wall_ms']=max(self.error_response_metrics['max_wall_ms'],elapsed)

    def domain_error(self,error):
        with self.repo.connection() as c:
            c.execute('BEGIN');meta=db.status(c)
        return {'status':getattr(error,'status',400),'body':{'success':False,'accepted':False,
            **meta,'code':error.code,'error':str(error)}}

    def run(self,request,actor,allowed):
        method,b=request['method'],request['body']
        if method.startswith('state.') or method=='discovery.status':
            fields(b)
            if not allowed(): raise DataError('CONNECTION_OR_DEADLINE_CHANGED',409)
            if method=='discovery.status':
                return {'status':200,'body':{'success':True,**self.discovery.snapshot()}}
            paths={'state.health':'/health','state.stats':'/api/stats','state.capabilities':'/api/capabilities','state.clock':'/api/clock'}
            # Internal domain call after the MQTT gate; not an HTTP request/fallback.
            handler=self.repo.bridge.DatyAPIHandler.__new__(self.repo.bridge.DatyAPIHandler)
            handler.path=paths[method];handler.headers={};handler.client_address=(actor['ip'],0)
            handler.server=SimpleNamespace(transport_security='mqtt5-tls-isolated')
            handler._check_origin=lambda:True
            result={}
            handler._json=lambda body,status=200:result.update(status=status,body=body)
            handler.do_GET()
            return self.repo.bound(result)
        self.before_transaction()
        with self.repo.connection() as c:
            c.execute('BEGIN IMMEDIATE' if method in WRITES else 'BEGIN')
            if not allowed(): raise DataError('CONNECTION_OR_DEADLINE_CHANGED',409)
            if method not in WRITES:
                return self.repo.bound({'status':200,'body':self.repo.read(c,method,b,actor)})
            if self.repo.poisoned: raise DataError('STORE_UNCERTAIN_QUERY_ONLY',503)
            record,replay=self.prepare(c,request,actor)
            if replay:
                self.repo.commit(c)
                return record['result']
            c.execute('SAVEPOINT business_write')
            try:
                body=self.repo.write(c,method,b,actor)
                result=self.repo.bound({'status':200,'body':body,'operation_id':b['operation_id']})
            except Exception as error:
                c.execute('ROLLBACK TO business_write')
                c.execute('RELEASE business_write')
                if not hasattr(error,'code') or getattr(error,'status',400)>=500:
                    raise
                result={'status':getattr(error,'status',400),'operation_id':b['operation_id'],'body':{'success':False,'accepted':False,
                    **db.status(c),'code':error.code,'error':str(error)}}
            else:
                c.execute('RELEASE business_write')
            record.update(state='committed' if result['status']==200 else 'rejected',result=result,updated_at_ms=self.wall_ms())
            self.repo.save_receipt(c,record,actor)
            # Serialize the full query receipt before committing too.
            self.repo.bound({'status':200,'body':{'operation':self.repo.public(record)}})
            if not allowed(): raise DataError('CONNECTION_OR_DEADLINE_CHANGED',409)
            self.repo.commit(c)
            return result

    def prepare(self,c,request,actor):
        b,method=request['body'],request['method'];oid=b['operation_id']
        if oid.startswith(('m4internal_','batch_')): raise DataError('RESERVED_RPC_NAMESPACE',409)
        if b['epoch']!=db.status(c)['epoch']: raise DataError('DATABASE_EPOCH_CHANGED',409)
        # Same business intent across reconnects, not bound to a temporary socket.
        digest=hashlib.sha256(db._safe_json({'method':method,'body':b}).encode()).hexdigest()
        old=self.repo.get_receipt(c,oid,actor)
        if old:
            if old['digest']!=digest: raise DataError('OPERATION_ID_CONFLICT',409)
            self.repo.bind_request(c,request,actor,digest)
            return old,True
        # IDs previously used through the old domain API cannot acquire new intent.
        if c.execute('SELECT 1 FROM db_operations WHERE operation_id=? UNION ALL SELECT 1 FROM db_batches WHERE operation_id=? UNION ALL SELECT 1 FROM db_import_batches WHERE id=?',(oid,oid,oid)).fetchone():
            raise DataError('OPERATION_ID_ALREADY_USED_QUERY_NATIVE_RECEIPT',409)
        self.repo.bind_request(c,request,actor,digest)
        return {'operation_id':oid,'method':method,'epoch':b['epoch'],'actor':actor['id'],'digest':digest,
                'state':'dispatching','created_at_ms':self.wall_ms(),'updated_at_ms':self.wall_ms(),
                'result':{'status':202,'body':{'success':True,'state':'dispatching','operation_id':oid}}},False

    def discover(self,request,actor,allowed):
        b,method=request['body'],request['method']
        fields(b,('operation_id','epoch','expected_generation'),('scan_operation_id',))
        if type(b['expected_generation']) is not int or b['expected_generation']<0:
            raise DataError('INVALID_SCAN_GENERATION')
        # Discovery lock precedes DB lock, matching original on_update flow.
        with self.discovery.lock:
            snapshot=self.discovery.snapshot()
            with self.repo.connection() as c:
                c.execute('BEGIN IMMEDIATE')
                if not allowed(): raise DataError('CONNECTION_OR_DEADLINE_CHANGED',409)
                if self.repo.poisoned: raise DataError('STORE_UNCERTAIN_QUERY_ONLY',503)
                record,replay=self.prepare(c,request,actor)
                if replay:
                    self.repo.commit(c);return record['result']
                if snapshot['generation']!=b['expected_generation']:
                    raise DataError('DISCOVERY_GENERATION_CONFLICT',409)
                if method=='discovery.scan':
                    if 'scan_operation_id' in b: raise DataError('INVALID_METHOD_FIELDS')
                    if self.active_scan or snapshot['scanning']: raise DataError('DISCOVERY_BUSY_OR_UNKNOWN',409)
                    if not snapshot['enabled'] or self.discovery.stop_event.is_set(): raise DataError('DISCOVERY_DISABLED',409)
                elif not b.get('scan_operation_id') or b['scan_operation_id']!=self.active_scan or not snapshot['scanning']:
                    raise DataError('SCAN_TARGET_CHANGED',409)
                self.repo.save_receipt(c,record,actor)
                self.repo.commit(c)
            # Scan start is an external effect: durable claim first, no replay.
            if not allowed():
                record.update(state='not_started',result={'status':409,'body':{'success':False,'code':'CONNECTION_OR_DEADLINE_CHANGED'}})
            else:
                try:
                    state=self.discovery.request_scan() if method=='discovery.scan' else self.discovery.cancel_scan()
                    if method=='discovery.scan': self.active_scan=b['operation_id']
                    record.update(state='accepted',generation=state['generation'],result={'status':202,
                        'body':{'success':True,'accepted':True,'operation_id':b['operation_id'],'state':'accepted','discovery':state}})
                    if method=='discovery.cancel':
                        record.update(state='cancel_requested')
                except Exception:
                    if method=='discovery.scan':self.active_scan=b['operation_id']
                    record.update(state='unknown',result={'status':503,'body':{'success':False,'code':'SCAN_OUTCOME_UNKNOWN'}})
            record['updated_at_ms']=self.wall_ms()
            with self.repo.connection() as c:
                c.execute('BEGIN IMMEDIATE');self.repo.save_receipt(c,record,actor);self.repo.commit(c)
            return record['result']

    async def watch_discovery(self):
        while True:
            await asyncio.sleep(.05)
            try: await asyncio.to_thread(self.finish_discovery)
            except Exception: self.accepting=False

    def finish_discovery(self):
        with self.discovery.lock:
            state=self.discovery.snapshot()
            if state['scanning'] or not self.active_scan:return
            with self.repo.connection() as c:
                c.execute('BEGIN IMMEDIATE')
                resource=self.repo.internal(c,PREFIX+self.active_scan)
                record=resource['value']['payload'] if resource else None
                if not record or record['state']!='accepted' or record.get('generation')!=state['generation']:return
                phase='failed' if state['error'] else 'cancelled' if state['cancelled'] else 'completed'
                record.update(state=phase,updated_at_ms=self.wall_ms(),result={'status':200,'body':{
                    'success':not state['error'],'operation_id':record['operation_id'],'state':phase,'discovery':state}})
                self.repo.save_receipt(c,record,self.repo.actor(record['actor'][8:]));self.repo.commit(c)
                self.active_scan=None
