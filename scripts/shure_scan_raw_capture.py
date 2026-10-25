"""Optional Windows IP-layer evidence capture. Never send receiver commands.

Two prior PktMon captures covered only 935/2550 and 629/2550 WWB points.
Neither proved a complete scan. This independent receiver-scoped observer is
also evidence collection, not proof of completeness or a hardware scan adapter.
RCVALL_IPLEVEL affects this socket only and does not enable NIC promiscuity.
"""
from __future__ import annotations

import datetime
import hashlib
import ipaddress
import socket
import struct
import threading
import time
from pathlib import Path

RCVALL_IPLEVEL = 3  # Windows SDK Mstcpip.h RCVALL_VALUE
LINKTYPE_RAW = 101
SNAPLEN = 65535


class RawCaptureError(RuntimeError):
    pass


def _address(value):
    address = ipaddress.IPv4Address(value)
    if (address.is_unspecified or address.is_loopback or address.is_multicast
            or address.is_reserved or int(address) == 0xffffffff):
        raise ValueError('An explicit non-loopback IPv4 address is required')
    return address


def accepted_packet(raw, targetpacked):
    """Return an intact target IPv4 packet, or None; never synthesize headers.

Fragments remain separate original IPv4 packets. No protocol/port assumption
excludes discovery, control, or an as-yet unknown receiver data transport.
"""
    if not isinstance(targetpacked, bytes) or len(targetpacked) != 4:
        raise ValueError('targetpacked must contain exactly four IPv4 bytes')
    if not isinstance(raw, bytes) or not 20 <= len(raw) <= SNAPLEN:
        return None
    header = (raw[0] & 15) * 4
    total = int.from_bytes(raw[2:4], 'big')
    if raw[0] >> 4 != 4 or header < 20 or header > len(raw) or total != len(raw):
        return None
    if raw[12:16] != targetpacked and raw[16:20] != targetpacked:
        return None
    return raw


def _block(kind, body):
    size = 12 + len(body)
    return struct.pack('<II', kind, size) + body + struct.pack('<I', size)


def _headers():
    section = _block(0x0a0d0d0a, struct.pack('<IHHq', 0x1a2b3c4d, 1, 0, -1))
    # if_tsresol=9 means timestamps are nanoseconds, not the default microseconds.
    interface = struct.pack('<HHI', LINKTYPE_RAW, 0, SNAPLEN)
    interface += struct.pack('<HHB3xHH', 9, 1, 9, 0, 0)
    return section + _block(1, interface)


def _packet_block(raw, timestamp):
    if not isinstance(timestamp, int) or not 0 <= timestamp < 1 << 64:
        raise ValueError('Capture timestamp is outside uint64 nanoseconds')
    body = struct.pack('<IIIII', 0, timestamp >> 32, timestamp & 0xffffffff, len(raw), len(raw))
    return _block(6, body + raw + bytes((-len(raw)) % 4))


def _utc(timestamp):
    return datetime.datetime.fromtimestamp(timestamp / 1_000_000_000,
        datetime.timezone.utc).isoformat(timespec='microseconds')


class RawIpCapture:
    """One explicitly selected local interface, one target, one exclusive file.

    start() synchronously opens the output/socket and enables IP-layer capture.
    Only the dedicated worker receives/writes. stop() is repeatable, closes the
    socket to unblock recv, and waits up to its timeout; all errors remain in
    snapshot(). A size limit ends capture rather than overwriting evidence.
    Kernel socket losses are unknown, not reported as zero.
    """
    def __init__(self, target, interface, path, max_bytes=128*1024*1024, *,
                 socket_factory=None, clock_ns=time.time_ns):
        self.target = str(_address(target))
        self.interface = str(_address(interface))
        self._targetpacked = ipaddress.IPv4Address(self.target).packed
        if type(max_bytes) is not int or max_bytes < len(_headers()):
            raise ValueError('max_bytes must allow the pcapng headers')
        self.path = Path(path)
        self.max_bytes = max_bytes
        self._factory = socket_factory or socket.socket
        self._clock = clock_ns
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._done = threading.Event()
        self._thread = self._socket = self._file = None
        self._started = False
        self._created = False
        self._enabled = False
        self._error = None
        self._cleanup_errors = []
        self._reason = None
        self._received = self._packets = self._ignored = self._bytes = 0
        self._limit = False
        self._started_ns = self._stopped_ns = self._first_ns = self._last_ns = None
        self._digest = hashlib.sha256()

    @property
    def error(self):
        with self._lock:
            return self._error

    def _failed(self, reason, error):
        with self._lock:
            if self._error is None:
                self._error = f'{reason}: {type(error).__name__}: {error}'
                self._reason = reason

    def _cleanup_failed(self, action, error):
        with self._lock:
            self._cleanup_errors.append(f'{action}: {type(error).__name__}: {error}')
        self._failed('cleanup_error', error)

    def _close_socket(self):
        with self._lock:
            client, enabled = self._socket, self._enabled
            self._socket, self._enabled = None, False
        if client is None:
            return
        try:
            if enabled:
                client.ioctl(socket.SIO_RCVALL, socket.RCVALL_OFF)
        except Exception as error:
            self._cleanup_failed('disable IP capture', error)
        finally:
            try:
                client.close()
            except Exception as error:
                self._cleanup_failed('close capture socket', error)

    def _close_file(self):
        with self._lock:
            output, self._file = self._file, None
        if output is not None:
            try:
                output.close()
            except Exception as error:
                self._cleanup_failed('close capture file', error)

    def _write(self, data):
        # The single receive thread owns writes after start() writes the headers.
        written = self._file.write(data)
        if isinstance(written, int) and 0 <= written <= len(data):
            with self._lock:
                self._digest.update(data[:written])
                self._bytes += written
        if written != len(data):
            raise OSError('Incomplete capture-file write')

    def start(self):
        with self._lock:
            if self._started or self._done.is_set():
                raise RawCaptureError('Capture objects cannot be restarted')
            self._started = True
        try:
            self._file = self.path.open('xb')
            self._created = True
            self._write(_headers())
            client = self._factory(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_IP)
            with self._lock:
                self._socket = client
            client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8*1024*1024)
            client.bind((self.interface, 0))
            client.settimeout(.2)
            # Even an uncertain enable response must try OFF on this own socket.
            with self._lock:
                self._enabled = True
            client.ioctl(socket.SIO_RCVALL, RCVALL_IPLEVEL)
            with self._lock:
                self._started_ns = self._clock()
            self._thread = threading.Thread(target=self._receive, args=(client,),
                name='DATY receiver IP evidence', daemon=True)
            self._thread.start()
            return self.snapshot()
        except Exception as error:
            self._failed('startup_error', error)
            self._close_socket()
            self._close_file()
            with self._lock:
                self._stopped_ns = self._clock()
                self._done.set()
            raise RawCaptureError(self.error) from error

    def _receive(self, client):
        try:
            while not self._stop.is_set():
                try:
                    raw = client.recv(SNAPLEN)
                except socket.timeout:
                    continue
                except OSError:
                    if self._stop.is_set():
                        break
                    raise
                if self._stop.is_set():
                    break
                if not raw:
                    raise OSError('Raw receive returned an empty packet')
                with self._lock:
                    self._received += 1
                packet = accepted_packet(raw, self._targetpacked)
                if packet is None:
                    with self._lock:
                        self._ignored += 1
                    continue
                timestamp = self._clock()
                data = _packet_block(packet, timestamp)
                with self._lock:
                    if self._bytes + len(data) > self.max_bytes:
                        self._limit = True
                        self._reason = 'size_limit'
                        self._stop.set()
                        break
                self._write(data)
                with self._lock:
                    self._packets += 1
                    self._first_ns = self._first_ns if self._first_ns is not None else timestamp
                    self._last_ns = timestamp
        except Exception as error:
            self._failed('receive_error', error)
        finally:
            self._close_socket()
            self._close_file()
            with self._lock:
                self._reason = self._reason or 'stop_requested'
                self._stopped_ns = self._clock()
                self._done.set()

    def stop(self, timeout=3):
        self._stop.set()
        self._close_socket()
        worker = self._thread
        if worker is not None and worker.ident is not None and worker is not threading.current_thread():
            worker.join(timeout)
            if worker.is_alive():
                self._failed('stop_timeout', TimeoutError('Capture receive thread is still running'))
        elif worker is None or worker.ident is None:
            self._close_file()
            with self._lock:
                self._reason = self._reason or 'stop_requested'
                self._stopped_ns = self._stopped_ns or self._clock()
                self._done.set()
        return self.snapshot()

    def snapshot(self):
        with self._lock:
            return {'source': 'windows_raw_ip', 'target': self.target, 'interface': self.interface,
                'file': str(self.path), 'format': 'pcapng', 'linktype': LINKTYPE_RAW,
                'capture_mode': 'RCVALL_IPLEVEL', 'promiscuous': False,
                'started': self._started_ns is not None, 'stopped': self._done.is_set(),
                'stop_reason': self._reason, 'error': self._error,
                'cleanup_errors': list(self._cleanup_errors), 'size_limit_reached': self._limit,
                'packets': self._packets, 'received_packets': self._received,
                'ignored_packets': self._ignored, 'bytes': self._bytes, 'max_bytes': self.max_bytes,
                'started_at_utc': _utc(self._started_ns) if self._started_ns is not None else None,
                'stopped_at_utc': _utc(self._stopped_ns) if self._stopped_ns is not None else None,
                'first_packet_at_utc': _utc(self._first_ns) if self._first_ns is not None else None,
                'last_packet_at_utc': _utc(self._last_ns) if self._last_ns is not None else None,
                'sha256': self._digest.hexdigest() if self._created and self._error is None and self._done.is_set() and self._file is None else None,
                'kernel_dropped_packets': None, 'completeness_verified': False}
