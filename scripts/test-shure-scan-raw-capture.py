"""Pure/mock raw IPv4 capture checks. No real socket or receiver activity."""
import hashlib
import ipaddress
import queue
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent))
from shure_scan_raw_capture import RawIpCapture, RawCaptureError, accepted_packet

TARGET = '192.0.2.104'
LOCAL = '192.0.2.16'
TARGET_BYTES = ipaddress.IPv4Address(TARGET).packed


def packet(source=TARGET, destination=LOCAL, body=b'proof', options=b''):
    header=bytearray(20+len(options));header[0]=0x40+len(header)//4
    header[2:4]=struct.pack('>H',len(header)+len(body));header[8]=64;header[9]=17
    header[12:16]=ipaddress.IPv4Address(source).packed
    header[16:20]=ipaddress.IPv4Address(destination).packed
    header[20:]=options
    return bytes(header)+body


class FakeSocket:
    def __init__(self, *args, fail_start=False, fail_disable=False):
        self.args=args;self.queue=queue.Queue();self.calls=[];self.closed=False
        self.fail_start=fail_start;self.fail_disable=fail_disable
    def setsockopt(self,*args):self.calls.append(('setsockopt',args))
    def bind(self,value):self.calls.append(('bind',value))
    def settimeout(self,value):self.calls.append(('timeout',value))
    def ioctl(self,code,value):
        self.calls.append(('ioctl',value))
        if value==3 and self.fail_start:raise OSError('mock setup failure')
        if value==0 and self.fail_disable:raise OSError('mock cleanup failure')
    def recv(self,size):
        try:value=self.queue.get(timeout=.02)
        except queue.Empty:raise socket.timeout()
        if isinstance(value,Exception):raise value
        return value
    def close(self):
        self.calls.append(('close',));self.closed=True
        self.queue.put(OSError('closed'))


class Capture(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        self.path=Path(self.folder.name)/'capture.pcapng'
        self.fake=FakeSocket();self.raw=None
    def capture(self,max_bytes=65536):
        def factory(*args):
            self.factory_args=args
            return self.fake
        self.raw=RawIpCapture(TARGET,LOCAL,self.path,max_bytes,
            socket_factory=factory,clock_ns=lambda:1791342000123456789)
        self.addCleanup(self.raw.stop)
        return self.raw
    def wait(self,predicate):
        deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            if predicate():return
            time.sleep(.005)
        self.fail('mock capture did not reach expected state')
    def test_ipv4_target_filter_and_original_bytes(self):
        for raw in (packet(),packet(LOCAL,TARGET),packet(options=b'\x01\x01\x01\x01')):
            self.assertIs(accepted_packet(raw,TARGET_BYTES),raw)
        self.assertIsNone(accepted_packet(packet('192.0.2.18','192.0.2.19'),TARGET_BYTES))
        original=packet()
        invalid=[b'',original[:19],original[:-1],original+b'padding']
        for first in (0x65,0x44,0x4f):invalid.append(bytes([first])+original[1:])
        for raw in invalid:self.assertIsNone(accepted_packet(raw,TARGET_BYTES))
        with self.assertRaises(ValueError):accepted_packet(original,b'bad')
    def test_fragment_retains_header_without_reassembly(self):
        fragment=bytearray(packet());fragment[6:8]=b'\x20\x01'
        self.assertEqual(accepted_packet(bytes(fragment),TARGET_BYTES),bytes(fragment))
    def test_exact_interface_and_ip_level_mode_then_repeatable_stop(self):
        raw=self.capture();ready=raw.start()
        self.assertTrue(ready['started']);self.assertFalse(ready['promiscuous'])
        self.assertIn(('bind',(LOCAL,0)),self.fake.calls)
        self.assertEqual(self.factory_args,(socket.AF_INET,socket.SOCK_RAW,socket.IPPROTO_IP))
        self.assertIn(('ioctl',3),self.fake.calls)
        self.assertNotIn(('ioctl',1),self.fake.calls)
        first=raw.stop();second=raw.stop()
        self.assertTrue(first['stopped']);self.assertEqual(first,second)
        self.assertIsNone(first['error']);self.assertEqual(self.fake.calls.count(('close',)),1)
        self.assertEqual(self.fake.calls.count(('ioctl',0)),1)
    def test_timeout_does_not_end_receive_and_other_target_never_written(self):
        raw=self.capture();raw.start()
        forbidden=packet('192.0.2.18','192.0.2.19',b'off-target-secret')
        wanted=packet(body=b'one target datagram')
        for value in (socket.timeout(),forbidden,b'invalid packet',wanted):self.fake.queue.put(value)
        self.wait(lambda:raw.snapshot()['packets']==1)
        summary=raw.stop();data=self.path.read_bytes()
        self.assertEqual(summary['received_packets'],3);self.assertEqual(summary['ignored_packets'],2)
        self.assertNotIn(b'off-target-secret',data)
        self.assertEqual(summary['sha256'],hashlib.sha256(data).hexdigest())
        # Parse the file independently; verify IDB type and exact original IP bytes.
        at=0;blocks=[]
        while at<len(data):
            kind,size=struct.unpack_from('<II',data,at)
            self.assertEqual(size%4,0);self.assertEqual(struct.unpack_from('<I',data,at+size-4)[0],size)
            blocks.append((kind,data[at+8:at+size-4]));at+=size
        self.assertEqual([k for k,_ in blocks],[0x0a0d0d0a,1,6])
        self.assertEqual(struct.unpack_from('<H',blocks[1][1])[0],101)
        self.assertIn(struct.pack('<HHB',9,1,9),blocks[1][1])
        interface,high,low,captured,original=struct.unpack_from('<IIIII',blocks[2][1])
        self.assertEqual((high<<32)|low,1791342000123456789)
        self.assertEqual(captured,len(wanted));self.assertEqual(original,len(wanted))
        self.assertEqual(blocks[2][1][20:20+captured],wanted)
    def test_size_limit_keeps_existing_blocks_and_stops_without_overwrite(self):
        value=packet();packet_size=32+(len(value)+3)//4*4
        raw=self.capture(60+packet_size);raw.start()
        self.fake.queue.put(value);self.fake.queue.put(value)
        self.wait(lambda:raw.snapshot()['stopped'])
        summary=raw.stop()
        self.assertTrue(summary['size_limit_reached']);self.assertEqual(summary['stop_reason'],'size_limit')
        self.assertEqual(summary['packets'],1);self.assertEqual(self.path.stat().st_size,60+packet_size)
        self.assertTrue(self.fake.closed)
    def test_receive_error_closes_resources_and_remains_visible(self):
        raw=self.capture();raw.start();self.fake.queue.put(OSError('mock recv failure'))
        self.wait(lambda:raw.snapshot()['stopped'])
        first=raw.stop();second=raw.stop()
        self.assertIn('mock recv failure',first['error']);self.assertEqual(first,second)
        self.assertTrue(self.fake.closed)
    def test_cleanup_error_does_not_hide_receive_error(self):
        self.fake.fail_disable=True
        raw=self.capture();raw.start();self.fake.queue.put(OSError('primary recv failure'))
        self.wait(lambda:raw.snapshot()['stopped']);summary=raw.stop()
        self.assertIn('primary recv failure',summary['error'])
        self.assertTrue(any('mock cleanup failure' in text for text in summary['cleanup_errors']))
        self.assertTrue(self.fake.closed)
    def test_exclusive_file_is_not_overwritten_or_socket_opened(self):
        self.path.write_bytes(b'preserve evidence')
        factory=lambda *args:self.fail('must not open a socket after exclusive-file failure')
        raw=RawIpCapture(TARGET,LOCAL,self.path,socket_factory=factory)
        with self.assertRaises(RawCaptureError):raw.start()
        self.assertEqual(self.path.read_bytes(),b'preserve evidence')
        self.assertIsNone(raw.snapshot()['sha256']);self.assertTrue(raw.stop()['stopped'])
    def test_start_failure_closes_socket_and_file(self):
        self.fake.fail_start=True;raw=self.capture()
        with self.assertRaises(RawCaptureError):raw.start()
        self.assertTrue(raw.snapshot()['stopped']);self.assertTrue(self.fake.closed)
        self.assertIn(('ioctl',0),self.fake.calls)
        with self.path.open('ab') as output:output.write(b'file handle closed')
    def test_thread_start_failure_allows_repeat_stop_without_join_error(self):
        raw=self.capture()
        with patch('shure_scan_raw_capture.threading.Thread.start',side_effect=RuntimeError('mock thread start failure')):
            with self.assertRaises(RawCaptureError):raw.start()
        self.assertTrue(raw.stop()['stopped']);self.assertTrue(raw.stop()['stopped'])
        self.assertTrue(self.fake.closed);self.assertIn('mock thread start failure',raw.error)
    def test_stop_timeout_is_reported_and_later_exit_preserves_error(self):
        entered=threading.Event();release=threading.Event()
        def blocked(size):
            entered.set();release.wait(2)
            return packet()
        self.fake.recv=blocked
        raw=self.capture();raw.start();self.assertTrue(entered.wait(1))
        try:
            result=raw.stop(timeout=.005)
            self.assertFalse(result['stopped']);self.assertIn('stop_timeout',result['error'])
        finally:
            release.set()
        self.wait(lambda:raw.snapshot()['stopped'])
        self.assertIn('stop_timeout',raw.stop()['error'])
    def test_partial_file_write_fails_and_socket_is_never_opened(self):
        class PartialFile:
            closed=False
            def write(self,data):return 7
            def close(self):self.closed=True
        output=PartialFile();raw=self.capture()
        with patch.object(Path,'open',return_value=output):
            with self.assertRaises(RawCaptureError):raw.start()
        result=raw.stop()
        self.assertEqual(result['bytes'],7);self.assertTrue(output.closed)
        self.assertIn('Incomplete capture-file write',result['error'])
        self.assertFalse(self.fake.calls)
    def test_reject_invalid_interface_target_or_capacity_before_creation(self):
        for address in ('0.0.0.0','127.0.0.1','239.255.0.1','255.255.255.255','hostname'):
            with self.assertRaises(ValueError):RawIpCapture(TARGET,address,self.path)
            with self.assertRaises(ValueError):RawIpCapture(address,LOCAL,self.path)
        for limit in (0,59,True):
            with self.assertRaises(ValueError):RawIpCapture(TARGET,LOCAL,self.path,limit)
        self.assertFalse(self.path.exists())


if __name__=='__main__':unittest.main(verbosity=2)
