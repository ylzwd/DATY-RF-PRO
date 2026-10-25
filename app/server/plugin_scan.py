"""Brand-owned live scans with durable intents and bounded, session-only points.

The transport lives in the installed package. The host owns target binding,
MQTT receipts and shutdown; an accepted request never proves a receiver scan.
"""
import copy
import ipaddress
import math
import re
import threading
import time

from plugin_install import PluginError
from data_contract import fields, identifier

SCHEMA = 'daty-live-scan-v1'
RANGE = {'start_khz': 632125, 'end_khz': 695875, 'step_khz': 25}
TERMINAL = frozenset({'completed', 'partial', 'cancelled', 'interrupted', 'failed', 'unknown', 'not_started'})
MAX_RESULTS = 8
MAX_POINTS = 30000
SESSION_STATES = frozenset({'not_started', 'reading_parameters', 'exchanging', 'confirming', 'ready', 'failed', 'cancelled'})


def safe_code(error):
    code = getattr(error, 'code', None)
    if code is None and error.args and isinstance(error.args[0],str) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,99}',error.args[0]):code=error.args[0]
    if code is None:code=type(error).__name__
    return code if isinstance(code, str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}', code) else 'SCAN_ADAPTER_ERROR'


class PluginScans:
    def __init__(self, manager, data_service):
        self.manager, self.data = manager, data_service
        self.lock = threading.RLock()
        self.jobs = {}
        self.closed = False
        self.profiles = {}

    def refresh_profiles(self):
        if self.data is None:return
        import unified_database as db
        from shure_scan_profiles import DOCUMENT_ID,validate
        with self.data.repo.connection() as c:
            record=db.get_resource(c,'settings',DOCUMENT_ID)
        entries={}
        if record is not None and not record.get('deleted'):
            validate(record['value'],lambda message:(_ for _ in ()).throw(PluginError('INVALID_SCAN_PROFILE',409)))
            entries={row['receiver_mac']:copy.deepcopy(row) for row in record['value']['receivers']}
        with self.lock:self.profiles=entries

    @staticmethod
    def _receiver_mac(device):
        telemetry=device.get('shure',{})
        mac=device.get('receiver_mac') or telemetry.get('settings',{}).get('receiver_mac')
        if 'settings.receiver_mac' in telemetry.get('stale_fields',[]):return None
        return mac.upper() if isinstance(mac,str) and re.fullmatch(r'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}',mac) else None

    def _range_evidence(self,item,device):
        settings=device.get('shure',{}).get('settings',{})
        mac=self._receiver_mac(device)
        # A label is only a fallback for old firmware that does not report a band.
        # It cannot override contradictory or explicitly stale receiver evidence.
        if mac is None or settings.get('rf_band') not in (None,'','L51'):return None
        if 'settings.rf_band' in device.get('shure',{}).get('stale_fields',[]):return None
        evidence=None
        if item.get('namespace') is not None:
            band=item['namespace'].load('shure_hardware.py').band_identity(device.get('model'),settings)
            if band.get('verified') and band.get('band')=='L51' and band.get('source')=='receiver-reported':
                evidence={'source':'receiver_reported'}
        if evidence is None:
            profile=self.profiles.get(mac)
            if profile and profile['model']==device.get('model') and profile['band']=='L51':
                evidence={'source':'user_confirmed_hardware_label','evidence_id':profile['evidence_id']}
        if evidence is None:return None
        return {**evidence,'band':'L51','model':'ULXD4','receiver_mac':mac,
                'receiver_id':device.get('receiver_id') or device.get('_receiver_id'),
                'receiver_ip':device.get('receiver_ip') or device.get('ip')}

    def capability(self, item, device):
        adapter = item.get('scan_live')
        model = device.get('model')
        candidate=adapter is not None and model=='ULXD4'
        evidence=self._range_evidence(item,device) if candidate else None
        available = candidate and evidence is not None
        reason='SCAN_ADAPTER_NOT_INSTALLED' if adapter is None else 'SCAN_MODEL_NOT_VERIFIED'
        if candidate:
            if self._receiver_mac(device) is None:reason='SCAN_RECEIVER_IDENTITY_UNAVAILABLE'
            elif device.get('shure',{}).get('settings',{}).get('rf_band') not in (None,'','L51'):reason='SCAN_HARDWARE_BAND_UNSUPPORTED'
            elif 'settings.rf_band' in device.get('shure',{}).get('stale_fields',[]):reason='SCAN_HARDWARE_IDENTITY_STALE'
            else:reason='SCAN_HARDWARE_PROFILE_REQUIRED'
        return {'scan': available, 'scan_readiness': 'probe-required' if available else 'unavailable',
                'scan_range_khz': copy.deepcopy(RANGE) if available else None,
                'scan_unavailable_reason': None if available else reason}

    def _item(self, plugin_id, *, starting=False):
        if not isinstance(plugin_id, str):
            raise PluginError('INVALID_PLUGIN_ID')
        item = self.manager.active.get(plugin_id)
        if self.closed or self.manager.closed or item is None:
            raise PluginError('BRAND_PLUGIN_NOT_INSTALLED', 409)
        if starting and plugin_id in self.manager.removal.draining:
            raise PluginError('PLUGIN_REMOVAL_PENDING', 409)
        if item.get('scan_live') is None:
            raise PluginError('SCAN_ADAPTER_NOT_INSTALLED', 409)
        return item

    def _target(self, item, device_id):
        if not isinstance(device_id, str) or not 1 <= len(device_id) <= 512:
            raise PluginError('INVALID_SCAN_TARGET')
        devices = self.manager.b._get_devices_snapshot([device_id])
        device = next((row for row in devices if row.get('id') == device_id), None)
        if device is None or device.get('_online') is not True:
            raise PluginError('SCAN_RECEIVER_OFFLINE', 409)
        if (device.get('_source') not in item['release']['adapterKeys'] or
                self.manager.b._normalize_device_brand(device.get('brand')) != self.manager.b._normalize_device_brand(item['release']['brand'])):
            raise PluginError('SCAN_PLUGIN_TARGET_MISMATCH', 409)
        capability=self.capability(item,device)
        if not capability['scan']:
            raise PluginError(capability['scan_unavailable_reason'], 409)
        try:
            address = str(ipaddress.IPv4Address(device.get('receiver_ip') or device.get('ip')))
        except (ValueError, TypeError):
            raise PluginError('INVALID_SCAN_RECEIVER_ADDRESS')
        mac = device.get('receiver_mac') or device.get('shure', {}).get('settings', {}).get('receiver_mac')
        if not isinstance(mac, str) or not re.fullmatch(r'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}', mac):
            raise PluginError('SCAN_RECEIVER_IDENTITY_UNAVAILABLE', 409)
        return {'device_id': device_id, 'receiver_id': device.get('receiver_id') or device.get('_receiver_id'),
                'receiver_ip': address, 'receiver_mac': mac.upper(), 'model': device['model'],
                'range_evidence':self._range_evidence(item,device)}

    @staticmethod
    def _range(options):
        if options is None:
            return copy.deepcopy(RANGE)
        if type(options) is not dict or set(options) != set(RANGE):
            raise PluginError('INVALID_SCAN_RANGE')
        if any(type(options[k]) is not int or options[k] != v for k, v in RANGE.items()):
            raise PluginError('SCAN_RANGE_NOT_VERIFIED', 409)
        return copy.deepcopy(options)

    def _service(self):
        if self.data is None or not self.data.accepting or self.data.repo.poisoned:
            raise PluginError('SCAN_DURABLE_SERVICE_UNAVAILABLE', 503)
        return self.data

    def _summary(self, job):
        with self.lock:
            return {k: copy.deepcopy(v) for k, v in job['view'].items() if k != 'points'}

    def _save(self, job, state):
        service = self._service()
        record = job['record']
        view = self._summary(job)
        view['finalized'] = True
        record.update(state=state, updated_at_ms=service.wall_ms(),
                      result={'status': 200, 'body': {**view, 'points': [], 'data_available': False}})
        with service.repo.connection() as c:
            c.execute('BEGIN IMMEDIATE')
            service.repo.save_receipt(c, record, job['actor'])
            service.repo.commit(c)

    def start(self, request, peer_ip, allowed):
        body = request['body']
        fields(body, ('plugin_id', 'operation_id', 'epoch', 'device_id'), ('options',))
        identifier(body['operation_id'])
        actual_range = self._range(body.get('options'))
        service = self._service()
        actor = service.repo.actor(peer_ip)
        self.refresh_profiles()
        with self.manager.lifecycle_lock, self.lock:
            item = self._item(body['plugin_id'], starting=True)
            target = self._target(item, body['device_id'])
            if not allowed():
                raise PluginError('SCAN_REQUEST_EXPIRED', 409)
            with service.repo.connection() as c:
                c.execute('BEGIN IMMEDIATE')
                record, replay = service.prepare(c, request, actor)
                if replay:
                    service.repo.commit(c)
                    return {**record['result']['body'], 'replayed': True}
                if any(job['view']['target']['receiver_mac'] == target['receiver_mac'] and
                       (job['thread'].is_alive() or not job['cleanup_complete']) for job in self.jobs.values()):
                    raise PluginError('SCAN_RECEIVER_BUSY', 409)
                while len(self.jobs) >= MAX_RESULTS:
                    completed = next((oid for oid, job in self.jobs.items() if job['view']['state'] in TERMINAL and not job['thread'].is_alive()), None)
                    if completed is None:
                        raise PluginError('SCAN_SESSION_LIMIT', 409)
                    self.jobs.pop(completed)
                view = {'schema': SCHEMA, 'operation_id': body['operation_id'],
                        'plugin': {k: item['release'][k] for k in ('id', 'version', 'sha256')},
                        'target': target, 'state': 'starting', 'actual_range': actual_range,
                        'progress': None, 'points': [], 'received_points': 0, 'missing_points': None,
                        'expected_points': (actual_range['end_khz']-actual_range['start_khz'])//actual_range['step_khz']+1,
                        'coverage_complete': False, 'device_ended': False, 'complete': False,
                        'start_sent': False, 'device_started': False,
                        'handshake_state': 'not_started', 'handshake_complete': False,
                        'data_available': False, 'error': None, 'accepted': True, 'finalized': False}
                record.update(state='accepted', result={'status': 202, 'body': copy.deepcopy(view)},
                              updated_at_ms=service.wall_ms())
                service.repo.save_receipt(c, record, actor)
                if not allowed():
                    raise PluginError('SCAN_REQUEST_EXPIRED', 409)
                service.repo.commit(c)
            job = {'view': view, 'record': record, 'actor': actor, 'item': item,
                   'cancel': threading.Event(), 'cancel_reason': None, 'client': None,
                   'started': False, 'cleanup_complete': False}
            thread = threading.Thread(target=self._run, args=(job,), name='Plugin-spectrum-scan', daemon=True)
            job['thread'] = thread
            self.jobs[body['operation_id']] = job
            thread.start()
            return copy.deepcopy(view)

    def _update(self, job, raw):
        if not isinstance(raw, dict):
            raise PluginError('INVALID_SCAN_ADAPTER_RESULT')
        points = raw.get('points', [])
        if not isinstance(points, list) or len(points) > MAX_POINTS:
            raise PluginError('SCAN_POINT_LIMIT')
        checked = []
        previous = None
        for point in points:
            if (not isinstance(point, (tuple, list)) or len(point) != 2 or type(point[0]) is not int or
                    not 30000 <= point[0] <= 3000000 or previous is not None and point[0] <= previous or
                    point[1] is not None and (type(point[1]) not in (int, float) or not math.isfinite(point[1]) or not -150 <= point[1] <= 20)):
                raise PluginError('INVALID_SCAN_POINT')
            checked.append(list(point));previous = point[0]
        actual=job['view']['actual_range']
        if any(not actual['start_khz']<=point[0]<=actual['end_khz'] or (point[0]-actual['start_khz'])%actual['step_khz'] for point in checked):
            raise PluginError('SCAN_POINTS_OUTSIDE_ACTUAL_RANGE')
        if job['started']:
            values=dict(checked)
            checked=[[khz,values.get(khz)] for khz in range(actual['start_khz'],actual['end_khz']+1,actual['step_khz'])]
        valid = sum(point[1] is not None for point in checked)
        coverage = raw.get('coverage_complete') is True and valid == len(checked) == job['view']['expected_points']
        ended = raw.get('device_ended') is True
        start_sent = raw.get('start_sent') if type(raw.get('start_sent')) is bool else None
        device_started = raw.get('device_started') if type(raw.get('device_started')) is bool else None
        if start_sent is False and (valid or ended or device_started):
            raise PluginError('SCAN_RESULT_BEFORE_START')
        session_state = raw.get('session_state') if isinstance(raw.get('session_state'), str) and raw['session_state'] in SESSION_STATES else None
        session_established = raw.get('session_established') if type(raw.get('session_established')) is bool else None
        error = raw.get('error') if isinstance(raw.get('error'),str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}',raw['error']) else 'SCAN_ADAPTER_ERROR' if raw.get('error') else None
        phase = raw.get('state')
        if phase == 'completed':
            phase = 'completed' if coverage and ended else 'partial' if ended and valid else 'unknown'
        elif phase == 'unknown' and ended and valid and raw.get('error')=='SCAN_TERMINAL_WITH_MISSING_POINTS':
            phase = 'partial'
        elif phase == 'cancelled' and not ended:
            if start_sent is False:
                phase, error = 'not_started', 'SCAN_CANCELLED_BEFORE_START'
            else:
                phase = 'interrupted'
        elif phase not in TERMINAL and phase not in ('starting', 'scanning', 'connecting', 'ready', 'cancel_requested'):
            phase = 'scanning' if job['started'] else 'starting'
        elif phase in ('connecting', 'ready'):
            phase = 'scanning' if job['started'] else 'starting'
        progress = raw.get('progress')
        if type(progress) not in (int, float) or not math.isfinite(progress) or not 0 <= progress <= 100:
            progress = None
        # ULXD resets its current progress on exit. Keep a witnessed 100% only
        # after the device ended with real samples; coverage remains independent.
        max_progress = raw.get('max_progress')
        if phase in TERMINAL and ended and valid and type(max_progress) in (int, float) and max_progress == 100:
            progress = 100
        with self.lock:
            job['view'].update(state=phase, points=checked, received_points=valid,
                missing_points=job['view']['expected_points']-valid, progress=progress, coverage_complete=coverage,
                device_ended=ended, complete=phase=='completed' and coverage and ended,
                start_sent=start_sent, device_started=device_started,
                handshake_state=session_state, handshake_complete=session_established,
                data_available=bool(valid), error=error)

    def _run(self, job):
        client = None
        try:
            client = job['item']['scan_live'](job['view']['target']['receiver_ip'],range_evidence=job['view']['target']['range_evidence'])
            job['client'] = client
            client.open(timeout=12)
            readiness=client.snapshot();reported=readiness.get('actual_range')
            reported_match=(type(reported) is dict and reported.get('verified') is True and
                all(type(reported.get(k)) is int and reported[k]==v for k,v in job['view']['actual_range'].items()))
            profile_match=(readiness.get('range_profile_confirmed') is True and
                readiness.get('range_evidence')==job['view']['target']['range_evidence'])
            if not (reported_match or profile_match):
                raise PluginError('SCAN_RECEIVER_RANGE_UNCONFIRMED', 409)
            with self.lock:
                job['view']['range_source']='receiver_configuration' if reported_match else job['view']['target']['range_evidence']['source']
                job['view']['receiver_configuration_range']=copy.deepcopy(reported)
            with self.manager.lifecycle_lock:
                identity = job['view']['plugin']['id']
                # The durable accepted operation outlives its short MQTT request
                # and client connection. Only its owner can explicitly cancel it.
                if job['cancel'].is_set():
                    raise PluginError('SCAN_CANCELLED_BEFORE_START', 409)
                if (self.closed or self.manager.closed or self.manager.active.get(identity) is not job['item'] or
                        identity in self.manager.removal.draining or self._target(job['item'], job['view']['target']['device_id']) != job['view']['target']):
                    raise PluginError('SCAN_TARGET_OR_REQUEST_CHANGED', 409)
                client.start(**job['view']['actual_range'])
                job['started'] = True
            deadline = time.monotonic() + 180
            cancel_deadline = None
            while True:
                if job['cancel'].is_set() and cancel_deadline is None:
                    client.cancel()
                    cancel_deadline = time.monotonic() + 5
                client.poll(timeout=.1)
                self._update(job, client.snapshot())
                if job['view']['state'] in TERMINAL:
                    break
                if time.monotonic() >= (cancel_deadline or deadline):
                    with self.lock:
                        job['view'].update(state='interrupted' if cancel_deadline else 'unknown',
                            error=job['cancel_reason'] or 'SCAN_COMPLETION_TIMEOUT', complete=False)
                    break
        except BaseException as error:
            with self.lock:
                job['view'].update(state='unknown' if job['started'] else 'not_started', error=safe_code(error), complete=False)
        finally:
            if client is not None:
                try: client.close();job['cleanup_complete'] = True
                except Exception:
                    with self.lock: job['view'].update(state='unknown', error='SCAN_CONNECTION_CLEANUP_UNCONFIRMED', complete=False)
            else:job['cleanup_complete'] = True
            try: self._save(job, job['view']['state'])
            except Exception:
                with self.lock: job['view'].update(state='unknown', error='SCAN_RECEIPT_UNCONFIRMED', complete=False)
            finally:
                with self.lock:job['view']['finalized']=True

    def status(self, body, peer_ip):
        fields(body, ('plugin_id', 'operation_id'))
        identifier(body['operation_id'])
        service = self._service();actor = service.repo.actor(peer_ip)
        with self.lock:
            job = self.jobs.get(body['operation_id'])
            if job is not None:
                if job['actor']['id'] != actor['id']:
                    raise PluginError('OPERATION_OWNER_MISMATCH', 403)
                if job['view']['plugin']['id'] != body['plugin_id']:
                    raise PluginError('SCAN_PLUGIN_OPERATION_MISMATCH', 409)
                return copy.deepcopy(job['view'])
        with service.repo.connection() as c:
            record = service.repo.get_receipt(c, body['operation_id'], actor)
        if not record or record['method'] != 'plugins.scan.start':
            raise PluginError('SCAN_OPERATION_NOT_FOUND', 404)
        value = copy.deepcopy(record['result']['body'])
        if value.get('plugin', {}).get('id') != body['plugin_id']:
            raise PluginError('SCAN_PLUGIN_OPERATION_MISMATCH', 409)
        value.update(state=record['state'], points=[], data_available=False, complete=False,finalized=True)
        if record['state'] == 'unknown':
            value['error'] = record.get('error') or 'SCAN_OUTCOME_UNKNOWN'
        return value

    def cancel(self, request, peer_ip, allowed):
        body = request['body']
        fields(body, ('plugin_id', 'operation_id', 'epoch', 'scan_operation_id'))
        identifier(body['operation_id']);identifier(body['scan_operation_id'])
        service = self._service();actor = service.repo.actor(peer_ip)
        with self.lock:
            job = self.jobs.get(body['scan_operation_id'])
            if job is None or job['view']['plugin']['id'] != body['plugin_id']:
                raise PluginError('SCAN_OPERATION_NOT_ACTIVE', 409)
            if job['actor']['id'] != actor['id']:
                raise PluginError('OPERATION_OWNER_MISMATCH', 403)
            with service.repo.connection() as c:
                c.execute('BEGIN IMMEDIATE')
                record, replay = service.prepare(c, request, actor)
                if replay:
                    service.repo.commit(c);return record['result']['body']
                result = {'schema': SCHEMA, 'operation_id': body['operation_id'],
                          'scan_operation_id': body['scan_operation_id'], 'accepted': True,
                          'state': 'cancel_requested' if job['view']['state'] not in TERMINAL else job['view']['state']}
                record.update(state='committed', result={'status': 200, 'body': result}, updated_at_ms=service.wall_ms())
                service.repo.save_receipt(c, record, actor)
                if not allowed():raise PluginError('SCAN_REQUEST_EXPIRED', 409)
                service.repo.commit(c)
            if job['view']['state'] not in TERMINAL:
                job['cancel_reason'] = 'USER_CANCELLED';job['cancel'].set()
            return result

    def busy(self, plugin_id):
        with self.lock:
            return any(job['view']['plugin']['id'] == plugin_id and job['thread'].is_alive() for job in self.jobs.values())

    def request_stop(self, plugin_id, reason):
        with self.lock:
            for job in self.jobs.values():
                if job['view']['plugin']['id'] == plugin_id and job['thread'].is_alive():
                    job['cancel_reason'] = reason;job['cancel'].set()

    def close(self, plugin_id=None):
        with self.lock:
            if plugin_id is None:self.closed = True
            jobs = [job for job in self.jobs.values() if plugin_id is None or job['view']['plugin']['id'] == plugin_id]
            for job in jobs:job['cancel_reason'] = 'PLUGIN_STOPPED';job['cancel'].set()
        for job in jobs:
            if job['thread'] is not threading.current_thread():job['thread'].join(18)
            if job['thread'].is_alive() or not job['cleanup_complete']:raise PluginError('SCAN_STOP_PENDING', 409)
