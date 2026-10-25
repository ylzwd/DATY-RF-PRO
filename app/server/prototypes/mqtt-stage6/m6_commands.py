"""One dispatch authority, durable request identity, strict execution receipts."""
import asyncio
import copy
import re
import time
import uuid

from command_journal import CommandError, TERMINAL

SERVER = 'daty-rf-pro'
SCHEMA = 'daty-mqtt6-app-v1'
ID = re.compile(r'[A-Za-z0-9_-]{16,80}\Z')
TARGET_FIELDS = {'device_id', 'receiver_id', 'receiver_mac', 'receiver_ip',
                 'receiver_session_id', 'channel_number', 'expected_brand'}


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise CommandError('INVALID_IDENTIFIER')


def validate_request(request):
    if not isinstance(request, dict) or set(request) != {'schema', 'server_id', 'boot_id',
            'client_session_id', 'request_id', 'method', 'deadline_at_ms', 'body'}:
        raise CommandError('INVALID_REQUEST_SHAPE')
    if request['schema'] != SCHEMA or request['server_id'] != SERVER:
        raise CommandError('WRONG_SERVER_OR_SCHEMA')
    for field in ('request_id', 'boot_id', 'client_session_id'):
        identifier(request[field])
    if type(request['deadline_at_ms']) is not int:
        raise CommandError('INVALID_DEADLINE')
    body = request['body']
    if not isinstance(body, dict):
        raise CommandError('INVALID_BODY')
    if request['method'] == 'commands.request':
        if set(body) != {'operation_id', 'target', 'command', 'expected_value'}:
            raise CommandError('INVALID_COMMAND_SHAPE')
        identifier(body['operation_id'])
        target = body['target']
        if not isinstance(target, dict) or set(target) != TARGET_FIELDS:
            raise CommandError('EXACT_TARGET_REQUIRED')
        if any(not isinstance(target[k], str) or not 1 <= len(target[k]) <= 160
               for k in TARGET_FIELDS - {'channel_number'}):
            raise CommandError('INVALID_TARGET')
        if type(target['channel_number']) is not int or not 1 <= target['channel_number'] <= 128:
            raise CommandError('INVALID_CHANNEL')
        command, value = body['command'], body['expected_value']
        if command == 'set_freq':
            if type(value) is not int or not 400000 <= value <= 900000:
                raise CommandError('INTEGER_KHZ_REQUIRED')
        elif command in ('mute', 'unmute'):
            if type(value) is not bool or value != (command == 'mute'):
                raise CommandError('INVALID_MUTE_VALUE')
        else:
            raise CommandError('COMMAND_NOT_SUPPORTED')
    elif request['method'] == 'commands.get':
        if set(body) != {'operation_id'}:
            raise CommandError('INVALID_QUERY')
        identifier(body['operation_id'])
    elif request['method'] == 'commands.targets':
        if body:
            raise CommandError('INVALID_QUERY')
    else:
        raise CommandError('METHOD_NOT_SUPPORTED')


class CommandService:
    def __init__(self, journal, adapter, *, wall_ms=lambda: int(time.time() * 1000), monotonic=time.monotonic):
        self.journal, self.adapter = journal, adapter
        self.wall_ms, self.monotonic = wall_ms, monotonic
        self.boot_id = uuid.uuid4().hex
        self.expirations, self.subscribers, self.fenced = {}, [], set()
        self.accepting = True
        self.timer = None
        adapter.service = self

    async def start(self):
        self.timer = asyncio.create_task(self.expiry_loop())

    async def close(self):
        self.accepting = False
        if self.timer:
            self.timer.cancel()
            await asyncio.gather(self.timer, return_exceptions=True)
        try:
            for record in self.journal.pending():
                await self.change(record['operation_id'], {'reserved', 'dispatching', 'published'}, 'unknown', error='SERVICE_STOPPED')
        except Exception:
            pass  # Failed store remains uncertain and is recovered on next boot.

    async def notify(self, record):
        for listener in self.subscribers:
            try:
                await listener(copy.deepcopy(record))
            except Exception:
                pass  # Durable result is queried; never retry physical control.

    async def change(self, oid, expected, state, **kwargs):
        if state in TERMINAL:
            # Fence synchronously before any awaited disk write or notification.
            self.fenced.add(oid)
        record = await asyncio.to_thread(self.journal.transition, oid, expected, state, **kwargs)
        if record['state'] in TERMINAL:
            self.expirations.pop(oid, None)
        await self.notify(record)
        return record

    def expired(self, record):
        return (self.wall_ms() >= record['deadline_at_ms'] or
                self.monotonic() >= self.expirations.get(record['operation_id'], float('inf')))

    async def request(self, request, *, entry, current=lambda: True):
        try:
            return await self._request(request, entry=entry, current=current)
        except CommandError:
            raise
        except Exception as error:
            self.accepting = False
            raise CommandError('JOURNAL_OR_SERVICE_OUTCOME_UNKNOWN') from error

    async def _request(self, request, *, entry, current):
        validate_request(request)
        if not current() or not self.accepting:
            raise CommandError('CLIENT_DISCONNECTED')
        if request['boot_id'] != self.boot_id:
            # A repeated old intent is read via commands.get on the new boot.
            raise CommandError('SERVER_BOOT_CHANGED')
        remaining = request['deadline_at_ms'] - self.wall_ms()
        monotonic_deadline = self.monotonic() + remaining / 1000
        if remaining <= 0 or remaining > 30000:
            raise CommandError('REQUEST_EXPIRED_OR_TOO_LONG')
        method = request['method']
        if method == 'commands.get':
            return await asyncio.to_thread(self.journal.get, request['body']['operation_id'])
        if method == 'commands.targets':
            return {'targets': self.adapter.targets(), 'active_entry': self.journal.entry}
        record, created = await asyncio.to_thread(self.journal.reserve, request, entry)
        if not created:
            return record
        oid = record['operation_id']
        # Capture a monotonic cap after durable acceptance; a backwards wall
        # clock must not lengthen the lifetime of a queued command.
        self.expirations[oid] = monotonic_deadline
        if not current():
            return await self.change(oid, {'reserved'}, 'not_sent', error='CLIENT_DISCONNECTED_BEFORE_DISPATCH')
        try:
            if self.expired(record):
                raise CommandError('DEADLINE_BEFORE_DISPATCH')
            self.adapter.validate(record['target'], record['command'])
        except CommandError as error:
            return await self.change(oid, {'reserved'}, 'rejected', error=error.code)
        # FULL commit is the one and only permission to attempt socket send.
        record = await self.change(oid, {'reserved'}, 'dispatching', attempt=True)
        if record['state'] != 'dispatching':
            return record
        try:
            proof = await self.adapter.send(record, allowed=lambda: current() and self.accepting
                and oid not in self.fenced and self.monotonic() < monotonic_deadline
                and self.wall_ms() < record['deadline_at_ms'])
        except CommandError as error:
            return await self.change(oid, {'dispatching'}, 'not_sent', error=error.code)
        except Exception:
            return await self.change(oid, {'dispatching', 'published'}, 'unknown', error='SEND_OUTCOME_UNKNOWN')
        if proof is not None:
            # Only the server-owned SCP outlet returns this proof, never UI RPC.
            if (proof.get('source') != 'shure-post-write-readback' or proof.get('target') != record['target']
                or proof.get('command') != record['command'] or proof.get('execution_ack_supported') is not False
                or type(proof.get('actual_value')) is not type(record['expected_value'])
                or proof['actual_value'] != record['expected_value'] or self.expired(record)):
                return await self.change(oid, {'dispatching'}, 'unknown', error='SHURE_READBACK_UNVERIFIED')
            evidence={**proof, 'command_id':record['command_id'], 'receiver_session_id':record['target']['receiver_session_id']}
            return await self.change(oid, {'dispatching'}, 'readback_confirmed', actual=proof['actual_value'], evidence=evidence)
        return await self.change(oid, {'dispatching'}, 'published')

    async def observe(self, proof):
        """Only called by the authenticated receiver adapter, never UI RPC."""
        record = await asyncio.to_thread(self.journal.by_command, proof.get('command_id'))
        if not record or record['state'] not in ('dispatching', 'published'):
            return False
        if self.expired(record):
            await self.change(record['operation_id'], {'dispatching', 'published'}, 'timeout', error='EXECUTION_ACK_TIMEOUT')
            return False
        if proof.get('target') != record['target'] or proof.get('command') != record['command']:
            return False
        try:
            self.adapter.validate(record['target'], record['command'])
        except CommandError:
            return False
        actual = proof.get('actual_value')
        if type(actual) is not type(record['expected_value']) or actual != record['expected_value']:
            return False
        evidence = {'source': 'paired-receiver-status', 'command_id': record['command_id'],
                    'receiver_session_id': record['target']['receiver_session_id'],
                    'receiver_id': record['target']['receiver_id'], 'device_id': record['target']['device_id'],
                    'channel_number': record['target']['channel_number'], 'brand': record['target']['expected_brand'],
                    'received_at_ms': self.wall_ms()}
        result = await self.change(record['operation_id'], {'dispatching', 'published'}, 'acknowledged', actual=actual, evidence=evidence)
        return result['state'] == 'acknowledged'

    async def expiry_loop(self):
        while True:
            await asyncio.sleep(.05)
            try:
                pending = await asyncio.to_thread(self.journal.pending)
            except Exception:
                self.accepting = False
                return
            for record in pending:
                try:
                    if self.expired(record):
                        await self.change(record['operation_id'], {record['state']},
                            'not_sent' if record['state'] == 'reserved' else 'timeout', error='EXECUTION_ACK_TIMEOUT')
                    elif record['state'] in ('dispatching', 'published'):
                        try:
                            self.adapter.validate(record['target'], record['command'])
                        except CommandError:
                            await self.change(record['operation_id'], {record['state']}, 'unknown', error='TARGET_SESSION_LOST')
                except Exception:
                    self.accepting = False  # Store failure is not permission to send.
                    return
