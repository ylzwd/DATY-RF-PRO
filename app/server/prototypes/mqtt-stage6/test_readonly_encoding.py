"""Payload equality and invalid JSON rejection across wire packing."""
import json
from pathlib import Path
import queue
import sys
from types import SimpleNamespace
import threading
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parent))
from m6_feed import CanonicalFeed,Subscription,ByteQueue,envelope
from m6_readonly_encoding import encode_event,batch_payload,wire_envelope


class ReadonlyEncodingTests(unittest.TestCase):
    def test_original_nested_values_and_ch_order_survive_wire_packing(self):
        originals=[]
        for n in range(128):
            payload={'type':'device_update','devices':[{'id':f'rx_ch{n+1}',
                'name':'鼓手 · "测试"\n\\ \u0000 😀','ip':'192.0.2.102','group':4,
                'channel':n+1,'af_dbfs':0.0 if n%2 else None,'muted':False,
                'frequency_khz':640000+n*250,'unknown':{'battery':None}}],
                'clock_source':'fuwuqi','server_time_ms':1789698130202+n,'ts':1789698130.202}
            originals.append(payload)
        encoded=[encode_event(json.dumps(x,ensure_ascii=False)) for x in originals]
        wire=wire_envelope('a'*32,'view-'+'b'*32,2,'event_batch',batch_payload(encoded))
        expected=envelope('a'*32,'view-'+'b'*32,2,'event_batch',
            {'events':[{'kind':x['type'],'payload':x} for x in originals]})
        self.assertEqual(json.loads(wire),expected)

    def test_all_original_readonly_event_kinds(self):
        for kind in ('device_list','device_update','mute_command','command_update','client_disconnect'):
            original={'type':kind,'devices':[],'data':{'value':None,'message':'已确认'}}
            self.assertEqual(json.loads(encode_event(json.dumps(original))),{'kind':kind,'payload':original})
        self.assertIsNone(encode_event('{"type":"internal-metric"}'))
        self.assertEqual(json.loads(wire_envelope('a','b',3,'heartbeat',b'null'))['payload'],None)

    def test_malformed_and_nonfinite_events_fail_explicitly(self):
        for raw in ('{','[]','null','{"type":"device_update","devices":[NaN]}',
                    '{"type":"device_update","data":Infinity}'):
            with self.subTest(raw=raw),self.assertRaises((ValueError,AttributeError)):
                encode_event(raw)

    def test_raw_queue_fifo_and_original_item_byte_bounds_remain(self):
        bridge=SimpleNamespace(_state_lock=threading.RLock(),_state={'sse_queues':[]},
            _get_devices_snapshot=lambda:[],time=SimpleNamespace(time=lambda:1))
        sub=Subscription(bridge,2)
        sub.queue.put_nowait('{"type":"device_update","n":1}')
        sub.queue.put_nowait('{"type":"device_update","n":2}')
        with self.assertRaises(queue.Full):sub.queue.put_nowait('{}')
        self.assertEqual(json.loads(sub.next_raw(0))['n'],1)
        self.assertEqual(sub.next(0)[1]['n'],2)
        with self.assertRaises(queue.Empty):sub.next_raw(0)
        sub.queue.put_nowait(None)
        with self.assertRaises(ConnectionError):sub.next_raw(0)
        sub.close()
        small=ByteQueue(10,max_bytes=5)
        small.put_nowait('12345')
        with self.assertRaises(queue.Full):small.put_nowait('1')
        self.assertEqual(small.get_nowait(),'12345')
        self.assertEqual(small.bytes,0)

    def test_overflow_evidence_survives_removal_and_close(self):
        bridge=SimpleNamespace(_state_lock=threading.RLock(),_state={'sse_queues':[]},
            _get_devices_snapshot=lambda:[],time=SimpleNamespace(time=lambda:1))
        feed=CanonicalFeed(bridge,capacity=2);sub=feed.subscribe()
        sub.queue.put_nowait('{}');sub.queue.put_nowait('{}')
        with self.assertRaises(queue.Full):sub.queue.put_nowait('{}')
        # Original Bridge overflow handling removes the stream and sends None.
        bridge._state['sse_queues'].remove(sub.queue)
        sub.queue.get_nowait();sub.queue.get_nowait();sub.queue.put_nowait(None)
        with self.assertRaisesRegex(ConnectionError,'overflow: event_count'):sub.next_raw(0)
        sub.close();sub.close()
        state=feed.status()
        self.assertEqual(state['streams'],0)
        self.assertEqual(state['overflowed_streams'],1)
        self.assertEqual(state['closed_streams'],1)
        self.assertEqual(state['peak_events'],2)
        self.assertEqual(state['closed_stream_details'][0]['overflow']['count'],2)

if __name__=='__main__':unittest.main(verbosity=2)
