"""Session exchange protocol vectors and lifecycle, with no sockets or secrets persisted."""
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shure_scan_session import (SessionKeyExchange, SessionExchangeError,
    SessionAction, BIT_SIZE, MODULUS, EXCHANGE_B, EXCHANGE_A, GENERATE_KEY,
    KEY_STATUS, VERIFIED_MODULUS, decode_public_value, encode_public_value,
    make_public_value)
from shure_scan_wire import DmpRecord


class Clock:
    def __init__(self): self.value = 0.0
    def __call__(self): return self.value
    def advance(self, value): self.value += value


def record(address, value, sequence=101, vector=3):
    return DmpRecord('00'*16, 17, sequence, sequence, 1, 20,
        vector, 2, 0, 0, 'single', address=address, values=value)


def parameters(exchange, *, modulus=VERIFIED_MODULUS, baseline=b'\0'):
    for address, value in ((BIT_SIZE, struct.pack('>I', 32)),
            (MODULUS, encode_public_value(modulus)), (EXCHANGE_B, encode_public_value(17)), (KEY_STATUS, baseline)):
        exchange.observe(record(address, value))


class SessionTests(unittest.TestCase):
    def make(self):
        clock = Clock(); exchange = SessionKeyExchange(clock=clock, random_bits=lambda bits: 32)
        exchange.begin(100)
        return clock, exchange

    def generating(self, baseline=b'\0'):
        clock, exchange = self.make(); parameters(exchange, baseline=baseline)
        actions = exchange.advance(101, 99)
        self.assertEqual(actions, (SessionAction(2, EXCHANGE_A, bytes.fromhex('0006001fe5bd')),
                                  SessionAction(2, GENERATE_KEY, b'\1')))
        exchange.sent(1000, 101)
        return clock, exchange

    def test_public_modular_vector_and_network_length_prefix(self):
        self.assertEqual(make_public_value(32, VERIFIED_MODULUS, 17, random_bits=lambda n: 32), bytes.fromhex('0006001fe5bd'))
        self.assertEqual(make_public_value(32, VERIFIED_MODULUS, 17, random_bits=lambda n: 1), b'\0\6\0\0\0\2')
        self.assertEqual(decode_public_value(bytes.fromhex('0006ffe01a43')), VERIFIED_MODULUS)

    def test_invalid_parameter_encoding_and_profile_refused(self):
        for value in (b'', b'\0\4\0\0\0\2', b'\0\6\0\2', b'\0\10'+b'\0'*8):
            with self.assertRaises(SessionExchangeError): decode_public_value(value)
        for bits, modulus, peer in ((64, VERIFIED_MODULUS, 17), (32, 17, 3), (32, VERIFIED_MODULUS, 1), (32, VERIFIED_MODULUS, VERIFIED_MODULUS-1)):
            with self.assertRaises(SessionExchangeError): make_public_value(bits, modulus, peer)

    def test_zero_private_value_retried_without_escaping(self):
        values = iter((0, 32))
        self.assertEqual(make_public_value(32, VERIFIED_MODULUS, 17, random_bits=lambda n: next(values)), bytes.fromhex('0006001fe5bd'))
        with self.assertRaisesRegex(SessionExchangeError, 'RANDOM_FAILED'):
            make_public_value(32, VERIFIED_MODULUS, 17, random_bits=lambda n: 0)

    def test_stale_parameters_cannot_satisfy_reads(self):
        _, exchange = self.make()
        exchange.observe(record(BIT_SIZE, struct.pack('>I', 32), sequence=100))
        self.assertNotIn(BIT_SIZE, exchange.parameters)
        self.assertEqual(exchange.advance(100, 99), ())

    def test_parameters_timeout_has_no_write(self):
        clock, exchange = self.make(); clock.advance(3)
        with self.assertRaisesRegex(SessionExchangeError, 'PARAMETERS_TIMEOUT'): exchange.advance(100, 99)
        self.assertEqual(exchange.stage, 'failed')

    def test_status_requires_ack_then_new_get_reply(self):
        clock, exchange = self.generating(); clock.advance(.2)
        self.assertEqual(exchange.advance(101, 999), ())
        self.assertEqual(exchange.advance(101, 1000), (SessionAction(1, KEY_STATUS),))
        exchange.sent(1001, 101)
        exchange.observe(record(KEY_STATUS, b'\1', sequence=102, vector=4))
        self.assertFalse(exchange.verified)
        exchange.observe(record(KEY_STATUS, b'\1', sequence=101))
        self.assertFalse(exchange.verified)
        exchange.observe(record(KEY_STATUS, b'\1', sequence=102))
        self.assertTrue(exchange.verified)

    def test_cached_baseline_one_is_not_completion(self):
        clock, exchange = self.generating(baseline=b'\1')
        self.assertFalse(exchange.verified)
        clock.advance(.2); exchange.advance(101, 1000); exchange.sent(1001, 101)
        exchange.observe(record(KEY_STATUS, b'\0', sequence=102))
        self.assertFalse(exchange.verified)
        clock.advance(.2)
        self.assertEqual(exchange.advance(102, 1001), (SessionAction(1, KEY_STATUS),))

    def test_status_zero_and_missing_response_are_bounded(self):
        clock, exchange = self.generating(); clock.advance(.2)
        exchange.advance(101, 1000); exchange.sent(1001, 101)
        clock.advance(.5)
        self.assertEqual(exchange.advance(101, 1001), (SessionAction(1, KEY_STATUS),))
        exchange.sent(1002, 101); exchange.observe(record(KEY_STATUS, b'\0', sequence=102))
        clock.advance(3)
        with self.assertRaisesRegex(SessionExchangeError, 'KEY_STATUS_TIMEOUT'): exchange.advance(102, 1002)

    def test_property_reject_and_cancel_never_produce_further_actions(self):
        _, exchange = self.make()
        with self.assertRaisesRegex(SessionExchangeError, 'PROPERTY_REJECTED'):
            exchange.observe(record(BIT_SIZE, b'\3', vector=9))
        self.assertEqual(exchange.advance(101, 1000), ())
        _, exchange = self.make(); parameters(exchange); exchange.cancel()
        self.assertEqual(exchange.advance(101, 1000), ())

    def test_late_success_reply_cannot_override_deadline(self):
        clock, exchange = self.generating(); clock.advance(.2)
        exchange.advance(101, 1000); exchange.sent(1001, 101)
        clock.advance(3)
        with self.assertRaisesRegex(SessionExchangeError, 'KEY_STATUS_TIMEOUT'):
            exchange.observe(record(KEY_STATUS, b'\1', sequence=102))
        self.assertFalse(exchange.verified)
        self.assertEqual(exchange.stage, 'failed')

    def test_abort_clears_parameters_and_preserves_failure(self):
        _, exchange = self.make(); parameters(exchange)
        exchange.abort(); exchange.cancel()
        self.assertEqual(exchange.parameters, {})
        self.assertEqual(exchange.stage, 'failed')


if __name__ == '__main__': unittest.main()
