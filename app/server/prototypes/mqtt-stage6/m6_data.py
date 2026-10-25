"""Original data authority plus durable, nonexecuting discovery review."""
import asyncio
import json
import time
import unified_database as db
from data_contract import DataError,fields,identifier
from data_repository import PREFIX
from m5_service import LargeDataService

class DataService(LargeDataService):
    def recover(self):
        with self.discovery.lock,self.repo.connection() as c:
            c.execute('BEGIN IMMEDIATE');pending=[]
            rows=c.execute("SELECT DISTINCT source_key FROM db_legacy_snapshots WHERE source_origin='daty-mqtt-stage4' AND source_key LIKE 'mqtt4-operation:%'").fetchall()
            for row in rows:
                record=self.repo.internal(c,row[0])['value']['payload']
                if record['state'] in ('dispatching','accepted'):
                    record.update(state='unknown',error='PROCESS_INTERRUPTED',updated_at_ms=self.wall_ms())
                    self.repo.save_receipt(c,record,self.repo.actor(record['actor'][8:]))
                if record['method']=='discovery.scan' and record['state']=='unknown' and not record.get('review'):
                    pending.append(record['operation_id'])
            if len(pending)>1:raise DataError('MULTIPLE_UNRESOLVED_SCANS',503)
            self.repo.commit(c)
            self.active_scan=pending[0] if pending else None

    async def review_request(self,request,*,entry,current,peer_ip):
        remaining=request['deadline_at_ms']-self.wall_ms();end=time.monotonic()+remaining/1000
        def allowed():return current() and self.accepting and time.monotonic()<end and self.wall_ms()<request['deadline_at_ms']
        if entry!='mqtt' or not 0<remaining<=30000 or not allowed():raise DataError('CONNECTION_OR_DEADLINE_CHANGED',409)
        try:return await asyncio.to_thread(self.review_discovery,request,self.repo.actor(peer_ip),allowed)
        except DataError as error:return await self.error_result(error)

    def review_discovery(self,request,actor,allowed):
        body=request['body'];query=request['method']=='discovery.uncertain'
        fields(body,() if query else ('operation_id','epoch','scan_operation_id','expected_revision','expected_generation','confirmed','note'))
        if not query:
            identifier(body['operation_id']);identifier(body['scan_operation_id'])
            if body['confirmed'] is not True or type(body['expected_revision']) is not int or type(body['expected_generation']) is not int or not isinstance(body['note'],str) or not 1<=len(body['note'].strip())<=500:
                raise DataError('EXPLICIT_REVIEW_REQUIRED',409)
        with self.discovery.lock,self.repo.connection() as c:
            c.execute('BEGIN' if query else 'BEGIN IMMEDIATE')
            if not allowed():raise DataError('CONNECTION_OR_DEADLINE_CHANGED',409)
            snapshot=self.discovery.snapshot()
            if query:
                record=self.repo.get_receipt(c,self.active_scan,actor) if self.active_scan else None
                return {'status':200,'body':{'success':True,'operation':self.repo.public(record) if record and record['state']=='unknown' else None,'discovery':snapshot}}
            own,replay=self.prepare(c,request,actor)
            if replay:self.repo.commit(c);return own['result']
            previous=self.repo.get_receipt(c,body['scan_operation_id'],actor)
            if not previous or previous['method']!='discovery.scan' or previous['state']!='unknown' or previous.get('review'):
                raise DataError('UNCERTAIN_UNREVIEWED_ONLY',409)
            if previous['receipt_revision']!=body['expected_revision'] or snapshot['generation']!=body['expected_generation'] or snapshot['scanning'] or self.active_scan!=body['scan_operation_id']:
                raise DataError('DISCOVERY_REVIEW_CHANGED',409)
            previous['review']={'confirmed':True,'note':body['note'].strip(),'actor':actor['id'],
                'reviewed_at_ms':self.wall_ms(),'observed_generation':snapshot['generation'],
                'meaning':'release-scan-no-execution-claim'}
            self.repo.save_receipt(c,previous,actor)
            result={'status':200,'body':{'success':True,'state':'reviewed','operation_id':body['operation_id'],
                'scan_operation_id':body['scan_operation_id'],'original_state':'unknown','scan_started':False}}
            own.update(state='committed',result=result,updated_at_ms=self.wall_ms())
            self.repo.save_receipt(c,own,actor)
            if not allowed():raise DataError('CONNECTION_OR_DEADLINE_CHANGED',409)
            self.repo.commit(c);self.active_scan=None
            return result
