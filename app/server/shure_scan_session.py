"""Independent implementation of the observed ULXD per-session key exchange.

This is session setup, not a receiver PIN or account/password operation.
The verified legacy profile uses 32-bit modular exponentiation, generator 2,
and a length-prefixed four-byte public value. Never replay a captured value.
The class has no socket, storage, logging, or dependency on vendor software.
"""
from dataclasses import dataclass
import secrets
import struct

from shure_scan_sdt import distance

EXCHANGE_A = 0x01200020
EXCHANGE_B = 0x01200021
GENERATE_KEY = 0x01200022
KEY_STATUS = 0x01200023
MODULUS = 0x01200024
BIT_SIZE = 0x01200025
READ_PROPERTIES = (BIT_SIZE, MODULUS, EXCHANGE_B, KEY_STATUS)
WRITE_PROPERTIES = (EXCHANGE_A, GENERATE_KEY)
VERIFIED_MODULUS = 0xffe01a43


class SessionExchangeError(ValueError):
    pass


@dataclass(frozen=True)
class SessionAction:
    vector: int
    address: int
    value: bytes = b''


def decode_public_value(raw):
    if not isinstance(raw, bytes) or len(raw) != 6 or raw[:2] != b'\0\6':
        raise SessionExchangeError('SCAN_SESSION_PARAMETER_ENCODING')
    return int.from_bytes(raw[2:], 'big')


def encode_public_value(value):
    if type(value) is not int or not 0 <= value <= 0xffffffff:
        raise SessionExchangeError('SCAN_SESSION_PUBLIC_VALUE_INVALID')
    return b'\0\6'+struct.pack('>I', value)


def make_public_value(bits, modulus, peer_public, *, random_bits=secrets.randbits):
    """Generate our fresh public value; no private exponent leaves this call."""
    if bits != 32 or modulus != VERIFIED_MODULUS or not 1 < peer_public < modulus-1:
        raise SessionExchangeError('SCAN_SESSION_PARAMETERS_UNSUPPORTED')
    for _ in range(8):
        private = random_bits(32)
        if type(private) is not int or not 0 <= private <= 0xffffffff:
            raise SessionExchangeError('SCAN_SESSION_RANDOM_INVALID')
        if private:
            public = pow(2, private, modulus)
            if 1 < public < modulus-1:
                return encode_public_value(public)
    raise SessionExchangeError('SCAN_SESSION_RANDOM_FAILED')


class SessionKeyExchange:
    """Poll-driven one-shot exchange; all writes occur after an inbound batch.

    observe only records GET replies strictly newer than the corresponding
    request barrier. advance creates one action batch; the caller sends it
    after processing every incoming wrapper and calls sent with its sequence.
    Status zero is pending, and only GET status one after our generate request
    verifies the session. No event, transport ACK or cached one can do so.
    """
    def __init__(self, *, clock, random_bits=secrets.randbits, timeout=3.0):
        self.clock, self.random_bits, self.timeout = clock, random_bits, timeout
        self.stage = 'new'
        self.parameters = {}
        self.read_barrier = None
        self.status_barrier = None
        self.write_sequence = None
        self.deadline = None
        self.next_read = None
        self.status_pending = False
        self.status_reads = 0
        self.error = None

    @property
    def verified(self):
        return self.stage == 'verified'

    def _fail(self, code):
        self.stage, self.error = 'failed', code
        self.parameters.clear()
        raise SessionExchangeError(code)

    def begin(self, receive_sequence):
        if self.stage != 'new':
            self._fail('SCAN_SESSION_ALREADY_STARTED')
        self.stage = 'parameters'
        self.read_barrier = receive_sequence
        self.deadline = self.clock()+self.timeout
        return tuple(SessionAction(1, address) for address in READ_PROPERTIES)

    def observe(self, record):
        if record.address not in (*READ_PROPERTIES, *WRITE_PROPERTIES):
            return False
        if self.stage in ('new', 'failed', 'cancelled', 'verified'):
            return True
        if self.deadline is not None and self.clock() >= self.deadline:
            self._fail('SCAN_SESSION_PARAMETERS_TIMEOUT' if self.stage == 'parameters' else 'SCAN_SESSION_KEY_STATUS_TIMEOUT')
        if record.kind != 'single':
            self._fail('SCAN_SESSION_PARAMETER_ENCODING')
        if record.vector in (9, 10):
            self._fail('SCAN_SESSION_PROPERTY_REJECTED_'+format(record.address, '08x'))
        if record.vector != 3:
            return True
        if self.stage == 'parameters':
            if distance(record.reliable_sequence, self.read_barrier) <= 0 or record.address not in READ_PROPERTIES:
                return True
            self.parameters[record.address] = record.values
        elif (self.stage == 'status' and record.address == KEY_STATUS and self.status_pending
                and self.status_barrier is not None
                and distance(record.reliable_sequence, self.status_barrier) > 0):
            if record.values not in (b'\0', b'\1'):
                self._fail('SCAN_SESSION_STATUS_INVALID')
            self.status_pending = False
            if record.values == b'\1':
                self.stage = 'verified'
                self.parameters.clear()
            else:
                self.next_read = self.clock()+0.2
        return True

    def advance(self, receive_sequence, acknowledged_sequence):
        if self.stage in ('new', 'verified', 'failed', 'cancelled', 'write_pending', 'read_pending'):
            return ()
        if self.clock() >= self.deadline:
            self._fail('SCAN_SESSION_PARAMETERS_TIMEOUT' if self.stage == 'parameters' else 'SCAN_SESSION_KEY_STATUS_TIMEOUT')
        if self.stage == 'parameters' and all(address in self.parameters for address in READ_PROPERTIES):
            bits = self.parameters[BIT_SIZE]
            if len(bits) != 4 or self.parameters[KEY_STATUS] not in (b'\0', b'\1'):
                self._fail('SCAN_SESSION_PARAMETER_ENCODING')
            try:
                public = make_public_value(int.from_bytes(bits, 'big'),
                    decode_public_value(self.parameters[MODULUS]),
                    decode_public_value(self.parameters[EXCHANGE_B]), random_bits=self.random_bits)
            except SessionExchangeError as error:
                self._fail(str(error))
            self.parameters.clear()
            self.stage = 'write_pending'
            return (SessionAction(2, EXCHANGE_A, public), SessionAction(2, GENERATE_KEY, b'\1'))
        if self.stage == 'status':
            # ACK only gates the following fresh read; it is never completion.
            if (acknowledged_sequence is not None and self.write_sequence is not None
                    and distance(acknowledged_sequence, self.write_sequence) >= 0
                    and self.clock() >= self.next_read
                    and (not self.status_pending or self.clock() >= self.next_read+0.4)):
                self.stage = 'read_pending'
                self.status_barrier = receive_sequence
                self.status_reads += 1
                return (SessionAction(1, KEY_STATUS),)
        return ()

    def sent(self, reliable_sequence, receive_sequence):
        if self.stage == 'write_pending':
            self.write_sequence = reliable_sequence
            self.stage = 'status'
            self.status_pending = False
            self.deadline = self.clock()+self.timeout
            self.next_read = self.clock()+0.1
        elif self.stage == 'read_pending':
            self.stage = 'status'
            self.status_pending = True
            self.status_barrier = receive_sequence
            self.next_read = self.clock()
        else:
            self._fail('SCAN_SESSION_ACTION_ORDER')

    def cancel(self):
        self.parameters.clear()
        if not self.verified and self.stage != 'failed':
            self.stage = 'cancelled'

    def abort(self):
        self.parameters.clear()
        if not self.verified:
            self.stage = 'failed'
