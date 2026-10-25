"""Domain preservation of bounded pure metadata reuse; no receiver connections."""
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import random
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import unified_live as live


def device(**changes):
    return dict(id='rx_ch1', receiver_id='rx', receiver_mac='02:00:00:00:00:01',
                receiver_ip='127.0.0.1', channel_number=1, group_number=11,
                brand='DATYaudio', model='RF PRO', name='鼓手', _source='socket:a',
                _online=True, _age_s=0, freq=641000, rf=-60, af_dbfs=0,
                batt=0, muted=False, status='online') | changes


class PureCacheTests(unittest.TestCase):
    def setUp(self):
        for f in (live._identity_fields, live._normalized_mac, live._normalized_ip,
                  live._session_digest, live._receiver_metadata):
            f.cache_clear()

    def test_actual_changes_and_missing_fields_are_not_cached_as_state(self):
        before=live._observation(device(),1000)
        after=live._observation(device(group_number=4,receiver_ip='192.0.2.190',
            name='主唱',_source='socket:b',rf=None,af_dbfs=None,batt=None,muted=True),2000)
        self.assertEqual((after['group_number'],after['receiver_ip'],after['name'],after['source_key']),
                         (4,'192.0.2.190','主唱','socket:b'))
        self.assertEqual((after['rf_dbm'],after['af_dbfs'],after['battery_percent'],after['muted']),
                         (None,None,None,1))
        self.assertEqual(before['af_dbfs'],0)
        self.assertNotEqual(before['snapshot_json'],after['snapshot_json'])

    def test_strict_types_stay_distinct_after_valid_integer_cache_hit(self):
        live._observation(device(),1000)
        for field in ('channel_number','group_number'):
            for bad in (True,1.0,{},[],float('nan')):
                with self.subTest(field=field,bad=bad):
                    if field=='group_number' and type(bad) is not bool:
                        # Original textual group parser maps these to unknown.
                        self.assertIsNone(live._observation(device(**{field:bad}),1000)['group_number'])
                    elif field=='group_number':
                        self.assertIsNone(live._observation(device(**{field:bad}),1000)['group_number'])
                    else:
                        with self.assertRaises(live.LiveStoreError):
                            live._observation(device(**{field:bad}),1000)

    def test_control_text_and_invalid_unicode_still_rejected(self):
        for code in (*range(32),127,0xd800,0xdfff):
            with self.subTest(code=code),self.assertRaises(live.LiveStoreError):
                live._observation(device(name='鼓'+chr(code)),1000)
        for text in ('鼓手','A\u0080B','😀','\u2028'):
            self.assertEqual(live._observation(device(name=text),1000)['name'],text)

    def test_cache_has_fixed_bounds_and_large_extensions_are_not_retained(self):
        for n in range(1300):live._observation(device(name=str(n)),1000)
        self.assertEqual(live._identity_fields.cache_info().currsize,1024)
        live._identity_fields.cache_clear()
        long_name='鼓'*10000
        result=live._observation(device(name=long_name,extra={'credentials':'secret','values':[0,None,True]}),1000)
        self.assertEqual(live._identity_fields.cache_info().currsize,0)
        self.assertEqual(json.loads(result['snapshot_json'])['extra'],{'values':[0,None,True]})

    def test_cached_metadata_does_not_skip_database_identity_or_closed_source_checks(self):
        with closing(sqlite3.connect(':memory:')) as c:
            for sql in live.schema_statements():c.execute(sql)
            live.record_snapshot(c,'boot',[device()],1000)
            live.record_snapshot(c,'boot',[device(_source='socket:b')],2000)
            c.commit()
            with self.assertRaises(live.LiveStoreError):live.record_snapshot(c,'boot',[device()],3000)
            c.rollback()
            with self.assertRaises(live.LiveStoreError):
                live.record_snapshot(c,'boot',[device(receiver_mac='02:00:00:00:00:02',_source='socket:b')],3000)


class FixedR9Parity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path=os.environ.get('DATY_M6_LIVE_REFERENCE')
        if not path:raise unittest.SkipTest('Explicit fixed r9 reference path required')
        spec=importlib.util.spec_from_file_location('fixed_r9_live',path)
        cls.old=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.old)

    def test_original_snapshot_results_and_all_table_rows_match(self):
        rng=random.Random(918)
        streams=[]
        for i in range(1400):
            ch=1+i%20;rx=1+(ch>10)
            value=device(id=f'rx{rx}_ch{ch}',receiver_id=f'rx{rx}',
                receiver_mac=f'02:00:00:00:00:0{rx}',channel_number=ch,
                group_number=11 if rx==1 else 4,_source=f'socket:{rx}',
                rf=rng.choice([-60,None,0]),af_dbfs=rng.choice([-40,-5,0,None]),
                batt=rng.choice([0,100,None]),muted=bool(i%2),
                extra={'array':[0,None,True,'鼓手'],'access_token':'redacted'})
            if i%71==0:value['receiver_ip']='192.0.2.190'
            if i%79==0:value['group_number']=None
            if i%83==0:value['receiver_mac']='02:00:00:00:FF:FF'
            if i%89==0:value['channel_number']=True
            streams.append(([value],1000+i,False))
        streams += [([],3000,True),([device()],2000,False)]
        outputs=[]
        for module in (self.old,live):
            with closing(sqlite3.connect(':memory:')) as c:
                c.execute('PRAGMA foreign_keys=ON')
                for sql in module.schema_statements():c.execute(sql)
                result=[]
                for values,observed,full in streams:
                    c.execute('SAVEPOINT observation')
                    try:result.append(module.record_snapshot(c,'boot',values,observed,full=full))
                    except Exception as error:
                        c.execute('ROLLBACK TO observation')
                        result.append((type(error).__name__,str(error)))
                    c.execute('RELEASE observation')
                self.assertEqual(c.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
                self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(),[])
                outputs.append((result,'\n'.join(c.iterdump())))
        self.assertEqual(outputs[0],outputs[1])


if __name__=='__main__':unittest.main()
