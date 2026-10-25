"""Candidate normalized business projections; never opens a database or transport.

The caller owns authentication, CAS, operation receipts and the transaction.
Validation preserves unknown non-secret JSON fields. Projections are business
history/preferences only: they never change receiver identity or live telemetry.
Profile rules mirror src/modules/equipment-profiles.js validate() (86-149), with
strict Python JSON/number types instead of JavaScript numeric coercion.
"""
import json
import math
import re


MAX_INTEGER = 9007199254740991
MAX_JSON_BYTES = 4 * 1024 * 1024
KINDS = frozenset({'settings', 'profiles', 'planning_records', 'planning_current',
                   'alerts', 'device_overrides', 'preferences', 'plugins'})


class DomainError(ValueError):
    def __init__(self, message, code='INVALID_BUSINESS_DOCUMENT', status=400):
        super().__init__(message)
        self.code, self.status = code, status


def _fail(message, code='INVALID_BUSINESS_DOCUMENT', status=400):
    raise DomainError(message, code, status)


def _text(value, label, maximum=2048):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        _fail(label + ' must be nonempty text')
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        _fail(label + ' contains control characters')
    try:
        value.encode('utf-8', errors='strict')
    except UnicodeError:
        _fail(label + ' contains invalid Unicode')
    return value


def _number(value, label, low, high, integer=False):
    if (type(value) not in (int, float) or value < low or value > high
            or not math.isfinite(value) or (integer and type(value) is not int)):
        _fail(label + ' has an invalid number or unit')
    return value


def _integer(value, label, low=0, high=MAX_INTEGER):
    return _number(value, label, low, high, True)


def _boolean(value, label):
    if type(value) is not bool:
        _fail(label + ' must be boolean')
    return value


def _object(value, label):
    if type(value) is not dict:
        _fail(label + ' must be an object')
    return value


def _array(value, label, nonempty=False):
    if type(value) is not list or len(value) > 100000 or (nonempty and not value):
        _fail(label + ' must be a bounded array')
    return value


def _frequency(value, label):
    return _integer(value, label, 30000, 3000000)


def _range(value, label):
    if type(value) is not list or len(value) != 2:
        _fail(label + ' must be an integer-kHz range')
    _frequency(value[0], label)
    _frequency(value[1], label)
    if value[0] >= value[1]:
        _fail(label + ' must increase')
    return value


_SECRET = re.compile(r'password|passwd|secret|token|authorization|credential|private.?key|pairing.?code|access.?key|session', re.I)


def _clone(value):
    """Reject secrets/prototype keys, invalid Unicode and non-JSON values early."""
    nodes = 0
    def inspect(item, depth=0):
        nonlocal nodes
        nodes += 1
        if depth > 50 or nodes > 200000:
            _fail('Business JSON exceeds structure budget')
        if item is None or type(item) is bool:
            return
        if type(item) in (int, float):
            _number(item, 'JSON number', -MAX_INTEGER, MAX_INTEGER)
        elif type(item) is str:
            try:
                item.encode('utf-8', errors='strict')
            except UnicodeError:
                _fail('Business JSON contains invalid Unicode')
        elif type(item) is list:
            for child in item:
                inspect(child, depth + 1)
        elif type(item) is dict:
            for key, child in item.items():
                if (type(key) is not str or _SECRET.search(key)
                        or key in ('__proto__', 'constructor', 'prototype')):
                    _fail('Business JSON contains a forbidden credential/object field')
                inspect(key, depth + 1)
                inspect(child, depth + 1)
        else:
            _fail('Business JSON contains a non-JSON value')
    inspect(value)
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        if len(encoded.encode('utf-8')) > MAX_JSON_BYTES:
            _fail('Business JSON exceeds byte budget')
        return json.loads(encoded)
    except (UnicodeError, RecursionError, OverflowError) as error:
        raise DomainError('Business JSON cannot be encoded') from error


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':'))


def _device_key(value):
    # Preserve legacy numeric IDs without conflating 1 with the textual ID "1".
    if type(value) is int:
        _integer(value, 'device ID', 1)
        return 'n:' + str(value)
    return 's:' + _text(value, 'device ID')


def _brand(value):
    compact = re.sub(r'[\s_-]+', '', value.lower()) if isinstance(value, str) else ''
    return {'daty': 'datyaudio', 'ams': 'amsaudio', 'senn': 'sennheiser'}.get(compact, compact)


SETTINGS_IDS = {
    'alert_thresholds': 'thresholds', 'daty_alert_thresholds_v1': 'thresholds',
    'alert_sound': 'sound', 'daty_alert_sound_v1': 'sound',
    'auto_frequency': 'auto_frequency', 'daty_auto_frequency_v1': 'auto_frequency',
    'network_connection': 'network_connection',
    'frequency_planning': 'frequency_planning',
    'spectrum_scan': 'spectrum_scan',
    'shure_scan_profiles': 'shure_scan_profiles',
    'monitoring_display_rules': 'monitoring_display_rules',
}


def _settings(identifier, value):
    kind = SETTINGS_IDS.get(identifier)
    if kind is None:
        _fail('Unknown settings document ID')
    if kind == 'monitoring_display_rules':
        from monitoring_rules import validate
        validate(value, _fail)
    elif kind == 'frequency_planning':
        from planning_settings import validate
        validate(value, _fail)
    elif kind == 'spectrum_scan':
        from spectrum_settings import validate
        validate(value, _fail)
    elif kind == 'shure_scan_profiles':
        from shure_scan_profiles import validate
        validate(value, _fail)
    elif kind == 'network_connection':
        import ipaddress
        address = value.get('localIp')
        if not isinstance(address, str) or len(address) > 64 or address != address.strip():
            _fail('localIp must be an IP address/subnet or empty for automatic detection')
        if address:
            try: ipaddress.ip_interface(address)
            except ValueError: _fail('localIp is not a valid IP address/subnet')
        if type(value.get('heartbeatSeconds')) is not int or value['heartbeatSeconds'] not in (15,30,60):
            _fail('heartbeatSeconds must be 15, 30 or 60')
        if value.get('reconnectStrategy') not in ('exponential','fixed5','manual'):
            _fail('Unknown reconnectStrategy')
        _boolean(value.get('shureExclusive'), 'shureExclusive')
        _boolean(value.get('pcom1Enabled'), 'pcom1Enabled')
    elif kind == 'thresholds':
        for key, low, high in [('rfWeakDbm', -90, -30), ('batteryLowPercent', 5, 50),
                               ('afOverloadDbfs', -40, 0)]:
            _integer(value.get(key), key, low, high)
        if 'batteryLowBars' in value:
            _integer(value['batteryLowBars'], 'batteryLowBars', 0, 5)
    else:
        _boolean(value.get('enabled'), 'enabled')


def _profile_settings(value, label, minimum, allow_no_imd=False):
    _object(value, label)
    _integer(value.get('channelSpacingKHz'), label + '.channelSpacingKHz', max(1, minimum))
    _integer(value.get('intermodSpacingKHz'), label + '.intermodSpacingKHz', 0 if allow_no_imd else 1)
    _number(value.get('scanThresholdDbm'), label + '.scanThresholdDbm', -140, 0)
    if 'scanGuardKHz' in value:
        _integer(value['scanGuardKHz'], label + '.scanGuardKHz')


def _grid(value, label, daty=False):
    _object(value, label)
    step = _integer(value.get('stepKHz'), label + '.stepKHz', 1)
    origin = _integer(value.get('originKHz'), label + '.originKHz')
    # 1/0 is the original unspecified grid; DATY effective grid is still 250/0.
    if daty and (step != 1 or origin != 0) and (step % 250 or origin % 250):
        _fail('DATY coordination grid cannot weaken the 250 kHz grid')


def _profile(identifier, value):
    if _text(value.get('id'), 'profile.id') != identifier:
        _fail('Profile ID differs from document ID')
    daty = _brand(_text(value.get('manufacturer'), 'manufacturer')) == 'datyaudio'
    for model in _array(value.get('models'), 'models', True):
        _text(model, 'model')
    start, end = _range(value.get('tuningRangeKHz'), 'tuningRangeKHz')
    _boolean(value.get('intermodSource'), 'intermodSource')
    _number(value.get('priority'), 'priority', -MAX_INTEGER, MAX_INTEGER)
    _boolean(value.get('deploymentEligible'), 'deploymentEligible')
    if 'source' in value:
        _text(value['source'], 'source')
    minimum = 250 if daty else 0
    if 'minimumChannelSpacingKHz' in value:
        minimum = _integer(value['minimumChannelSpacingKHz'], 'minimumChannelSpacingKHz', max(1, minimum))
    provenance = _object(value.get('provenance'), 'provenance')
    for key in ('kind', 'url', 'title', 'revision'):
        _text(provenance.get(key), 'provenance.' + key)
    _boolean(provenance.get('verified'), 'provenance.verified')
    for key, low in [('frequencyStepKHz', 1), ('frequencyOriginKHz', 0)]:
        if key in value:
            _integer(value[key], key, low)
    compatibility = _object(value.get('compatibility'), 'compatibility')
    for required in ('robust', 'standard', 'more-frequencies'):
        if required not in compatibility:
            _fail('Profile is missing compatibility level ' + required)
    for label, settings in compatibility.items():
        _text(label, 'compatibility key')
        _profile_settings(settings, label, minimum, daty and label == 'more-frequencies')
    for collection, default in [('bands', 'defaultBandId'), ('modes', 'defaultModeId')]:
        seen = set()
        for item in _array(value.get(collection), collection, True):
            _object(item, collection)
            key = _text(item.get('id'), collection + '.id')
            if key in seen:
                _fail('Duplicate ' + collection + ' ID')
            seen.add(key)
            if collection == 'modes':
                _profile_settings(item.get('settings'), key, minimum, daty and key == 'more-frequencies')
            else:
                lower, upper = _range(item.get('tuningRangeKHz'), 'band range')
                if lower < start or upper > end:
                    _fail('Band lies outside profile range')
                _text(item.get('region'), 'band.region')
                _boolean(item.get('verified'), 'band.verified')
                for field, low in [('frequencyStepKHz', 1), ('frequencyOriginKHz', 0)]:
                    if field in item:
                        _integer(item[field], 'band.' + field, low)
        if _text(value.get(default), default) not in seen:
            _fail('Profile default does not match ' + collection)
    if 'coordinationGrid' in value:
        _grid(value['coordinationGrid'], 'coordinationGrid', daty)
    if 'imdPolicy' in value:
        policy = _object(value['imdPolicy'], 'imdPolicy')
        if any(type(order) is not int or order not in (3, 5)
               for order in _array(policy.get('orders'), 'imdPolicy.orders', True)):
            _fail('Only IM3/IM5 orders are supported')
        _boolean(policy.get('includeThreeTone'), 'imdPolicy.includeThreeTone')
    if 'spacingProvenance' in value:
        source = _object(value['spacingProvenance'], 'spacingProvenance')
        _text(source.get('title'), 'spacingProvenance.title')
        _text(source.get('revision'), 'spacingProvenance.revision')
        _boolean(source.get('verified'), 'spacingProvenance.verified')


def _constraints(value):
    _object(value, 'constraints')
    for item in _array(value.get('excludedRanges', []), 'excludedRanges'):
        _object(item, 'excluded range')
        _range([item.get('startKHz'), item.get('endKHz')], 'excluded range')
    seen = set()
    for item in _array(value.get('lockedAssignments', []), 'lockedAssignments'):
        _object(item, 'locked assignment')
        key = _device_key(item.get('deviceId'))
        if key in seen:
            _fail('Duplicate locked target')
        seen.add(key)
        _frequency(item.get('frequencyKHz'), 'locked frequency')
    for item in _array(value.get('knownCarriers', []), 'knownCarriers'):
        _object(item, 'known carrier')
        _frequency(item.get('frequencyKHz'), 'known frequency')
        _integer(item.get('guardKHz'), 'known guard', 1)
        if 'intermodSource' in item:
            _boolean(item['intermodSource'], 'known intermodSource')
        if 'ownerDeviceId' in item:
            _device_key(item['ownerDeviceId'])
    if 'backupCount' in value:
        _integer(value['backupCount'], 'backupCount', 0, 4)
    for key in ('stepKHz', 'minChannelSpacingKHz', 'minImdSpacingKHz'):
        if key in value:
            _integer(value[key], key, 1)
    for peak in _array(value.get('scanPeakCarriers', []), 'scanPeakCarriers'):
        _object(peak, 'scan peak')
        frequency = _frequency(peak.get('frequencyKHz'), 'scan peak frequency')
        _number(peak.get('levelDbm'), 'scan peak levelDbm', -200, 50)
        if ('startKHz' in peak) != ('endKHz' in peak):
            _fail('Scan peak run needs both bounds')
        if 'startKHz' in peak:
            start = _frequency(peak['startKHz'], 'scan peak start')
            end = _frequency(peak['endKHz'], 'scan peak end')
            if not start <= frequency <= end:
                _fail('Scan peak must be inside its measured run')
        if 'guardKHz' in peak:
            _integer(peak['guardKHz'], 'scan peak guard', 1)
    for key in ('startKHz', 'endKHz', 'minKHz', 'maxKHz', 'rangeStartKHz', 'rangeEndKHz',
                'requestedRangeStartKHz', 'requestedRangeEndKHz', 'planningGridOriginKHz'):
        if key in value:
            _frequency(value[key], key)
    for start, end in [('startKHz', 'endKHz'), ('minKHz', 'maxKHz'), ('rangeStartKHz', 'rangeEndKHz'),
                       ('requestedRangeStartKHz', 'requestedRangeEndKHz')]:
        if start in value and end in value and value[start] >= value[end]:
            _fail('Planning range must increase')
    if 'scanThresholdDbm' in value:
        _number(value['scanThresholdDbm'], 'scanThresholdDbm', -140, 0)
    if 'imdOrders' in value:
        orders = _array(value['imdOrders'], 'imdOrders')
        if any(type(order) is not int or order not in (3, 5, 7, 9) for order in orders) or len(set(orders)) != len(orders):
            _fail('Only unique IM3/IM5/IM7/IM9 orders are supported')
    if 'imdProducts' in value:
        from planning_settings import validate_imd_products
        validate_imd_products(value['imdProducts'], _fail)
    if 'includeThreeTone' in value:
        _boolean(value['includeThreeTone'], 'includeThreeTone')
    for point in _array(value.get('scanPoints', []), 'scanPoints'):
        _object(point, 'scan point')
        _frequency(point.get('frequencyKHz'), 'scan frequency')
        _number(point.get('levelDbm'), 'scan levelDbm', -200, 50)
    for key in ('maxScanGapKHz', 'maxSearchNodes'):
        if key in value:
            _integer(value[key], key, 1)
    if 'preserveCurrent' in value:
        _boolean(value['preserveCurrent'], 'preserveCurrent')
    if 'protectCurrentFrequencies' in value:
        _boolean(value['protectCurrentFrequencies'], 'protectCurrentFrequencies')
    if 'lockMonitoringOnly' in value:
        _boolean(value['lockMonitoringOnly'], 'lockMonitoringOnly')
    if 'autoExpandRange' in value:
        _boolean(value['autoExpandRange'], 'autoExpandRange')


def _planning_record(identifier, value):
    if _text(value.get('id'), 'record.id') != identifier:
        _fail('Planning record ID differs from document ID')
    _text(value.get('projectId'), 'projectId')
    if value.get('type') != 'daty_rf_planning':
        _fail('Unsupported planning record type')
    _integer(value.get('timestamp'), 'planning timestamp')
    devices = _array(value.get('devices'), 'devices')
    if _integer(value.get('channels'), 'channels', 0, 10000) != len(devices):
        _fail('Planning channel count differs from devices')
    seen, brands = set(), {}
    for device in devices:
        _object(device, 'planning device')
        key = _device_key(device.get('id'))
        if key in seen:
            _fail('Duplicate planning device ID')
        seen.add(key)
        brands[key] = _brand(device.get('brand'))
        for field in ('receiver_id', 'receiverId', 'brand'):
            if device.get(field) is not None:
                _text(device[field], field)
        for field in ('freq', 'planned'):
            if device.get(field) is not None:
                # Existing constraint-only histories use exactly integer 0 for unplanned.
                if field == 'planned' and type(device[field]) is int and device[field] == 0:
                    continue
                _frequency(device[field], 'device.' + field)
        for field in ('channel_number', 'channel'):
            if field in device and device[field] is not None:
                _integer(device[field], field, 1, 10000)
    for field in ('constraints', 'options'):
        if field in value:
            _constraints(value[field])
    coordination = value.get('coordination')
    if coordination is not None:
        _object(coordination, 'coordination')
        assignments = set()
        for item in _array(coordination.get('assignments', []), 'assignments'):
            _object(item, 'assignment')
            key = _device_key(item.get('deviceId'))
            if key not in seen or key in assignments:
                _fail('Assignment has an unknown or repeated channel')
            assignments.add(key)
            if item.get('brand') is not None and _brand(item['brand']) != brands[key]:
                _fail('Assignment brand differs from channel brand')
            _frequency(item.get('frequencyKHz'), 'assigned frequency')
            daty = brands[key] == 'datyaudio'
            for field in ('minimumChannelSpacingKHz', 'channelSpacingKHz', 'intermodSpacingKHz', 'candidateStepKHz'):
                if item.get(field) is not None:
                    low = 250 if daty and field != 'intermodSpacingKHz' else 1
                    if daty and field == 'intermodSpacingKHz' and value.get('options', {}).get('compatibilityLevel') == 'more-frequencies':
                        low = 0  # Explicit DATY compact preset: no IMD protection.
                    _integer(item[field], field, low)
            if daty and item.get('candidateStepKHz') is not None and item['candidateStepKHz'] % 250:
                _fail('DATY candidate step must be a multiple of 250 kHz')
            if 'coordinationGrid' in item:
                _grid(item['coordinationGrid'], 'assignment.coordinationGrid', daty)
            for frequency in _array(item.get('backupFrequenciesKHz', []), 'backup frequencies'):
                _frequency(frequency, 'backup frequency')


def _planning_current(identifier, value):
    if _text(value.get('projectId'), 'projectId') != identifier:
        _fail('Current planning document ID must equal projectId')
    current = value.get('currentRecordId')
    if current is not None:
        _text(current, 'currentRecordId')
    deleted = _array(value.get('deletedRecordIds'), 'deletedRecordIds')
    for record in deleted:
        _text(record, 'deletedRecordId')
    if len(set(deleted)) != len(deleted) or current in deleted:
        _fail('Repeated tombstone or deleted current planning record')


def _alert(identifier, value):
    if _text(value.get('archiveId'), 'archiveId') != identifier:
        _fail('Alert document ID must equal archiveId')
    first = _integer(value.get('firstSeen'), 'firstSeen')
    last = _integer(value.get('lastSeen'), 'lastSeen')
    if last < first:
        _fail('Alert lastSeen precedes firstSeen')
    if value.get('archiveState') not in ('active', 'ended'):
        _fail('Alert archiveState must be active or ended')
    ended = value.get('endedAt')
    if value['archiveState'] == 'ended':
        if _integer(ended, 'endedAt') < first:
            _fail('Alert endedAt precedes firstSeen')
    elif ended is not None:
        _fail('Active alert cannot carry endedAt')
    for key in ('value', 'threshold'):
        if key in value and value[key] is not None:
            _number(value[key], key, -MAX_INTEGER, MAX_INTEGER)
    if value.get('deviceId') is not None:
        _device_key(value['deviceId'])
    for key in ('metric', 'level'):
        if value.get(key) is not None:
            _text(value[key], key)


_LIVE_FIELDS = frozenset({'rf', 'rfdbm', 'rflevel', 'af', 'afdbfs', 'aflevel', 'batt',
    'battery', 'batterypercent', 'freq', 'freqkhz', 'freqmhz', 'frequency',
    'frequencykhz', 'frequencymhz', 'planned', 'plannedkhz', 'mute', 'muted',
    'unmute', 'online', 'isonline', 'status', 'capabilities', 'command', 'ack',
    'group', 'groupnumber', 'groupid', 'receiverip', 'receivermac', 'mac', 'ip', 'fasheid'})


def _override(identifier, value):
    _text(value.get('receiverId'), 'receiverId')
    _integer(value.get('channelNumber'), 'channelNumber', 1, 10000)
    for key in value:
        if re.sub(r'[_-]', '', key).lower() in _LIVE_FIELDS or key == 'receiver_id':
            _fail('Device override cannot mutate live state or receiver identity')
    if 'alias' in value and value['alias'] is not None:
        if not isinstance(value['alias'], str) or len(value['alias']) > 256:
            _fail('alias must be text of at most 256 characters')


# Address/credential caches intentionally excluded: they are host connection
# preferences and must not silently retarget a live receiver/API after restore.
PREFERENCE_KEYS = frozenset({'specStartFreq', 'specEndFreq', 'spectrumStartKHz',
    'spectrumEndKHz', 'channelPage', 'devicePage', 'historyPage', 'alertPage',
    'timelinePage', 'activePanel', 'alertLogView', 'source', '_source', 'provenance'})


def _preferences(identifier, value):
    if set(value) - PREFERENCE_KEYS:
        _fail('Unknown or connection-sensitive preference')
    for key, item in value.items():
        if key in ('specStartFreq', 'specEndFreq'):
            if type(item) is not str or not re.fullmatch(r'\d+(?:\.\d{1,3})?', item):
                _fail('Legacy spectrum preference must be an explicit MHz string')
            _number(float(item), key, 30, 3000)
        elif key in ('spectrumStartKHz', 'spectrumEndKHz'):
            _frequency(item, key)
        elif key.endswith('Page'):
            _integer(item, key, 1)
        elif key == 'activePanel':
            if item not in ('dashboard', 'monitor', 'channels', 'spectrum', 'planner', 'devices', 'data', 'settings'):
                _fail('Unknown panel preference')
        elif key == 'alertLogView' and item not in ('archive', 'timeline'):
            _fail('Unknown alert log view')
    for start, end in [('specStartFreq', 'specEndFreq'), ('spectrumStartKHz', 'spectrumEndKHz')]:
        if start in value and end in value and float(value[start]) >= float(value[end]):
            _fail('Spectrum preference range must increase')


def _plugin(identifier, value):
    if value.get('status') not in ('development', 'not-integrated', '开发中', '尚未接入'):
        _fail('Plugin metadata cannot claim an installation or enabled adapter')
    for key in ('installed', 'enabled', 'loaded', 'verified', 'ready'):
        if key in value and value[key] is not False:
            _fail('Plugin capability is not implemented')


_VALIDATORS = {'settings': _settings, 'profiles': _profile, 'planning_records': _planning_record,
               'planning_current': _planning_current, 'alerts': _alert,
               'device_overrides': _override, 'preferences': _preferences, 'plugins': _plugin}


def validate_document(kind, identifier, value, deleted=False):
    """Return an isolated validated document; never reads/writes a database."""
    if type(kind) is not str or kind not in KINDS:
        _fail('Unsupported business document kind')
    _text(identifier, 'document ID')
    _boolean(deleted, 'deleted')
    checked = _clone(_object(value, 'document'))
    if not deleted:
        _VALIDATORS[kind](identifier, checked)
    return checked


# Normalized tables retain raw non-secret metadata in addition to queryable
# fields/children. Each schema statement is a single SQL statement (no script).
_DEFINITIONS = {
    'biz_settings': ('id TEXT PRIMARY KEY, setting_type TEXT NOT NULL, rf_weak_dbm INTEGER, battery_low_percent INTEGER, af_overload_dbfs INTEGER, enabled INTEGER, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, metadata_json TEXT NOT NULL', ()),
    'biz_profiles': ('id TEXT PRIMARY KEY, manufacturer TEXT NOT NULL, start_khz INTEGER NOT NULL, end_khz INTEGER NOT NULL, default_band_id TEXT NOT NULL, default_mode_id TEXT NOT NULL, minimum_spacing_khz INTEGER, coordination_step_khz INTEGER, coordination_origin_khz INTEGER, source TEXT, provenance_json TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, metadata_json TEXT NOT NULL', ()),
    'biz_profile_models': ('profile_id TEXT NOT NULL, ordinal INTEGER NOT NULL, model TEXT NOT NULL', ('PRIMARY KEY(profile_id,ordinal)', 'FOREIGN KEY(profile_id) REFERENCES biz_profiles(id) ON DELETE CASCADE')),
    'biz_profile_bands': ('profile_id TEXT NOT NULL, band_id TEXT NOT NULL, start_khz INTEGER NOT NULL, end_khz INTEGER NOT NULL, region TEXT NOT NULL, verified INTEGER NOT NULL, step_khz INTEGER, origin_khz INTEGER, metadata_json TEXT NOT NULL', ('PRIMARY KEY(profile_id,band_id)', 'FOREIGN KEY(profile_id) REFERENCES biz_profiles(id) ON DELETE CASCADE')),
    'biz_profile_modes': ('profile_id TEXT NOT NULL, mode_kind TEXT NOT NULL, mode_id TEXT NOT NULL, channel_spacing_khz INTEGER NOT NULL, intermod_spacing_khz INTEGER NOT NULL, scan_threshold_dbm REAL NOT NULL, scan_guard_khz INTEGER, metadata_json TEXT NOT NULL', ('PRIMARY KEY(profile_id,mode_kind,mode_id)', 'FOREIGN KEY(profile_id) REFERENCES biz_profiles(id) ON DELETE CASCADE')),
    'biz_planning_records': ('id TEXT PRIMARY KEY, project_id TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, channel_count INTEGER NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, metadata_json TEXT NOT NULL', ('UNIQUE(project_id,id)', 'FOREIGN KEY(project_id) REFERENCES projects(id)')),
    'biz_planning_channels': ('record_id TEXT NOT NULL, device_key TEXT NOT NULL, receiver_id TEXT, channel_number INTEGER, brand TEXT, frequency_khz INTEGER, planned_khz INTEGER, metadata_json TEXT NOT NULL', ('PRIMARY KEY(record_id,device_key)', 'FOREIGN KEY(record_id) REFERENCES biz_planning_records(id) ON DELETE CASCADE')),
    'biz_planning_constraints': ('record_id TEXT NOT NULL, origin TEXT NOT NULL, kind TEXT NOT NULL, ordinal INTEGER NOT NULL, device_key TEXT, frequency_khz INTEGER, start_khz INTEGER, end_khz INTEGER, guard_khz INTEGER, metadata_json TEXT NOT NULL', ('PRIMARY KEY(record_id,origin,kind,ordinal)', 'FOREIGN KEY(record_id) REFERENCES biz_planning_records(id) ON DELETE CASCADE')),
    'biz_planning_backups': ('record_id TEXT NOT NULL, device_key TEXT NOT NULL, ordinal INTEGER NOT NULL, frequency_khz INTEGER NOT NULL, metadata_json TEXT NOT NULL', ('PRIMARY KEY(record_id,device_key,ordinal)', 'FOREIGN KEY(record_id) REFERENCES biz_planning_records(id) ON DELETE CASCADE')),
    'biz_planning_current': ('project_id TEXT PRIMARY KEY, current_record_id TEXT, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, metadata_json TEXT NOT NULL', ('FOREIGN KEY(project_id) REFERENCES projects(id)', 'FOREIGN KEY(project_id,current_record_id) REFERENCES biz_planning_records(project_id,id)')),
    'biz_planning_tombstones': ('project_id TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL', ('PRIMARY KEY(project_id,record_id)', 'FOREIGN KEY(project_id) REFERENCES projects(id)')),
    'biz_alerts': ('id TEXT PRIMARY KEY, archive_id TEXT NOT NULL UNIQUE, device_id TEXT, metric TEXT, level TEXT, first_seen_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL, archive_state TEXT NOT NULL, ended_at_ms INTEGER, value REAL, threshold REAL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, metadata_json TEXT NOT NULL', ()),
    'biz_device_overrides': ('id TEXT PRIMARY KEY, receiver_id TEXT NOT NULL, channel_number INTEGER NOT NULL, alias TEXT, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, metadata_json TEXT NOT NULL', ('UNIQUE(receiver_id,channel_number)',)),
    'biz_preferences': ('id TEXT PRIMARY KEY, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, metadata_json TEXT NOT NULL', ()),
    'biz_preference_values': ('preference_id TEXT NOT NULL, preference_key TEXT NOT NULL, value_type TEXT NOT NULL, number_value REAL, text_value TEXT, boolean_value INTEGER', ('PRIMARY KEY(preference_id,preference_key)', 'FOREIGN KEY(preference_id) REFERENCES biz_preferences(id) ON DELETE CASCADE')),
    'biz_plugins': ('id TEXT PRIMARY KEY, status TEXT NOT NULL, installed INTEGER NOT NULL CHECK(installed=0), revision INTEGER NOT NULL, deleted INTEGER NOT NULL, metadata_json TEXT NOT NULL', ()),
}
TABLES = {name: frozenset(column.strip().split()[0] for column in columns.split(','))
          for name, (columns, _) in _DEFINITIONS.items()}


def schema_statements():
    return tuple('CREATE TABLE IF NOT EXISTS ' + name + ' (' + columns
                 + (', ' + ', '.join(constraints) if constraints else '') + ')'
                 for name, (columns, constraints) in _DEFINITIONS.items())


def _put(connection, table, values, conflict):
    keys = tuple(values)
    updates = ','.join(key + '=excluded.' + key for key in keys if key not in conflict)
    connection.execute('INSERT INTO ' + table + ' (' + ','.join(keys) + ') VALUES ('
                       + ','.join('?' for _ in keys) + ') ON CONFLICT (' + ','.join(conflict)
                       + ') DO UPDATE SET ' + updates, tuple(values.values()))


def _existing(connection, table, identifier, key='id'):
    return connection.execute('SELECT metadata_json,revision,deleted FROM ' + table
                              + ' WHERE ' + key + '=?', (identifier,)).fetchone()


def _monotonic(connection, kind, identifier, value, revision, deleted):
    table = {'planning_current': 'biz_planning_current'}.get(kind, 'biz_' + kind)
    old = _existing(connection, table, identifier, 'project_id' if kind == 'planning_current' else 'id')
    if old and revision <= old[1]:
        _fail('Projection revision must increase', 'BUSINESS_REVISION_CONFLICT', 409)
    previous = json.loads(old[0]) if old else None
    if kind == 'planning_records':
        project_id = value.get('projectId') if not deleted else (previous or {}).get('projectId')
        if not project_id:
            _fail('Deleting an unknown planning record requires an existing project identity')
        if previous and previous['projectId'] != project_id:
            _fail('Planning record project identity is immutable', 'PLANNING_PROJECT_CONFLICT', 409)
        if not deleted and connection.execute('SELECT 1 FROM biz_planning_tombstones WHERE project_id=? AND record_id=?', (project_id, identifier)).fetchone():
            _fail('A planning tombstone prevents record resurrection', 'PLANNING_RECORD_DELETED', 409)
        if previous and not deleted and previous != value:
            _fail('Planning history records are immutable; use a new record ID', 'PLANNING_RECORD_IMMUTABLE', 409)
        if deleted and connection.execute('SELECT 1 FROM biz_planning_current WHERE project_id=? AND current_record_id=? AND deleted=0', (project_id, identifier)).fetchone():
            _fail('Clear current planning selection before deleting its record', 'PLANNING_CURRENT_CONFLICT', 409)
    elif kind == 'planning_current' and not deleted:
        existing = {row[0] for row in connection.execute('SELECT record_id FROM biz_planning_tombstones WHERE project_id=?', (identifier,))}
        if not existing.issubset(value['deletedRecordIds']):
            _fail('Existing planning tombstones cannot be removed', 'PLANNING_TOMBSTONE_REGRESSION', 409)
        current = value.get('currentRecordId')
        if current is not None and not connection.execute('SELECT 1 FROM biz_planning_records WHERE id=? AND project_id=? AND deleted=0', (current, identifier)).fetchone():
            _fail('Current planning record is missing or belongs to another project', 'PLANNING_CURRENT_CONFLICT', 409)
        for record in value['deletedRecordIds']:
            owner = connection.execute('SELECT project_id FROM biz_planning_records WHERE id=?', (record,)).fetchone()
            if owner and owner[0] != identifier:
                _fail('A tombstone cannot target another project', 'PLANNING_PROJECT_CONFLICT', 409)
    elif kind == 'alerts' and previous and not deleted:
        for field in ('deviceId', 'metric'):
            if previous.get(field) != value.get(field):
                _fail('An alert lifecycle cannot move to another device/metric', 'ALERT_IDENTITY_CONFLICT', 409)
        if (previous['archiveState'] == 'ended' and value['archiveState'] != 'ended'):
            _fail('An ended alert cannot become active again', 'ALERT_ALREADY_ENDED', 409)
        if (value['firstSeen'] != previous['firstSeen'] or value['lastSeen'] < previous['lastSeen']
                or (previous.get('endedAt') is not None and value.get('endedAt', -1) < previous['endedAt'])):
            _fail('Alert lifecycle time cannot regress', 'ALERT_STALE_SNAPSHOT', 409)
    elif kind == 'device_overrides' and previous and not deleted:
        if (previous['receiverId'], previous['channelNumber']) != (value['receiverId'], value['channelNumber']):
            _fail('An override cannot be moved to another receiver/channel', 'DEVICE_OVERRIDE_TARGET_CONFLICT', 409)
    return table, previous


def project_document(connection, kind, identifier, value, revision, deleted=False):
    """Validate then project in caller transaction; return validated raw metadata.

    DomainError has code/status. The caller MUST roll back on any exception and
    commit CAS/envelope/receipt and this projection together. No commits occur
    here. A deleted planning_current never removes its monotonic tombstones.
    """
    checked = validate_document(kind, identifier, value, deleted)
    _integer(revision, 'revision', 1)
    if not connection.in_transaction:
        _fail('Projection requires a caller-owned transaction', 'TRANSACTION_REQUIRED')
    table, previous = _monotonic(connection, kind, identifier, checked, revision, deleted)
    if deleted:
        if previous is None:
            _fail('Cannot delete a missing normalized document', 'BUSINESS_DOCUMENT_NOT_FOUND', 404)
        key = 'project_id' if kind == 'planning_current' else 'id'
        connection.execute('UPDATE ' + table + ' SET revision=?,deleted=1 WHERE ' + key + '=?', (revision, identifier))
        if kind == 'planning_records':
            _put(connection, 'biz_planning_tombstones', {'project_id': previous['projectId'], 'record_id': identifier, 'revision': revision}, ('project_id', 'record_id'))
        return checked
    common = {'revision': revision, 'deleted': 0, 'metadata_json': _json(checked)}
    if kind == 'settings':
        _put(connection, table, {'id': identifier, 'setting_type': SETTINGS_IDS[identifier],
            'rf_weak_dbm': checked.get('rfWeakDbm'), 'battery_low_percent': checked.get('batteryLowPercent'),
            'af_overload_dbfs': checked.get('afOverloadDbfs'), 'enabled': checked.get('enabled'), **common}, ('id',))
    elif kind == 'profiles':
        daty = _brand(checked['manufacturer']) == 'datyaudio'
        grid = checked.get('coordinationGrid')
        _put(connection, table, {'id': identifier, 'manufacturer': checked['manufacturer'],
            'start_khz': checked['tuningRangeKHz'][0], 'end_khz': checked['tuningRangeKHz'][1],
            'default_band_id': checked['defaultBandId'], 'default_mode_id': checked['defaultModeId'],
            'minimum_spacing_khz': max(250, checked.get('minimumChannelSpacingKHz', 0)) if daty else checked.get('minimumChannelSpacingKHz'),
            'coordination_step_khz': max(250, (grid or {}).get('stepKHz', 1)) if daty else (grid or {}).get('stepKHz'),
            'coordination_origin_khz': (grid or {}).get('originKHz', 0) if daty else (grid or {}).get('originKHz'),
            'source': checked.get('source'), 'provenance_json': _json(checked['provenance']), **common}, ('id',))
        for child in ('biz_profile_models', 'biz_profile_bands', 'biz_profile_modes'):
            connection.execute('DELETE FROM ' + child + ' WHERE profile_id=?', (identifier,))
        for index, model in enumerate(checked['models']):
            _put(connection, 'biz_profile_models', {'profile_id': identifier, 'ordinal': index, 'model': model}, ('profile_id', 'ordinal'))
        for band in checked['bands']:
            _put(connection, 'biz_profile_bands', {'profile_id': identifier, 'band_id': band['id'],
                'start_khz': band['tuningRangeKHz'][0], 'end_khz': band['tuningRangeKHz'][1],
                'region': band['region'], 'verified': band['verified'], 'step_khz': band.get('frequencyStepKHz'),
                'origin_khz': band.get('frequencyOriginKHz'), 'metadata_json': _json(band)}, ('profile_id', 'band_id'))
        modes = [('compatibility', key, item, item) for key, item in checked['compatibility'].items()]
        modes += [('mode', item['id'], item['settings'], item) for item in checked['modes']]
        for mode_kind, key, settings, original in modes:
            _put(connection, 'biz_profile_modes', {'profile_id': identifier, 'mode_kind': mode_kind, 'mode_id': key,
                'channel_spacing_khz': settings['channelSpacingKHz'], 'intermod_spacing_khz': settings['intermodSpacingKHz'],
                'scan_threshold_dbm': settings['scanThresholdDbm'], 'scan_guard_khz': settings.get('scanGuardKHz'),
                'metadata_json': _json(original)}, ('profile_id', 'mode_kind', 'mode_id'))
    elif kind == 'planning_records':
        _put(connection, table, {'id': identifier, 'project_id': checked['projectId'],
            'timestamp_ms': checked['timestamp'], 'channel_count': checked['channels'], **common}, ('id',))
        for child in ('biz_planning_channels', 'biz_planning_constraints', 'biz_planning_backups'):
            connection.execute('DELETE FROM ' + child + ' WHERE record_id=?', (identifier,))
        for device in checked['devices']:
            _put(connection, 'biz_planning_channels', {'record_id': identifier, 'device_key': _device_key(device['id']),
                'receiver_id': device.get('receiver_id') or device.get('receiverId'),
                'channel_number': device.get('channel_number', device.get('channel')), 'brand': device.get('brand'),
                'frequency_khz': device.get('freq'), 'planned_khz': device.get('planned'),
                'metadata_json': _json(device)}, ('record_id', 'device_key'))
        for origin in ('constraints', 'options'):
            constraints = checked.get(origin, {})
            for name in ('excludedRanges', 'lockedAssignments', 'knownCarriers', 'backupCount'):
                rows = [{'count': constraints[name]}] if name == 'backupCount' and name in constraints else constraints.get(name, [])
                for index, item in enumerate(rows):
                    _put(connection, 'biz_planning_constraints', {'record_id': identifier, 'origin': origin, 'kind': name,
                        'ordinal': index, 'device_key': _device_key(item['deviceId']) if 'deviceId' in item else None,
                        'frequency_khz': item.get('frequencyKHz'), 'start_khz': item.get('startKHz'), 'end_khz': item.get('endKHz'),
                        'guard_khz': item.get('guardKHz'), 'metadata_json': _json(item)}, ('record_id', 'origin', 'kind', 'ordinal'))
        for assignment in (checked.get('coordination') or {}).get('assignments', []):
            for index, frequency in enumerate(assignment.get('backupFrequenciesKHz', [])):
                _put(connection, 'biz_planning_backups', {'record_id': identifier, 'device_key': _device_key(assignment['deviceId']),
                    'ordinal': index, 'frequency_khz': frequency, 'metadata_json': _json({'frequencyKHz': frequency})}, ('record_id', 'device_key', 'ordinal'))
    elif kind == 'planning_current':
        _put(connection, table, {'project_id': identifier, 'current_record_id': checked.get('currentRecordId'), **common}, ('project_id',))
        for record in checked['deletedRecordIds']:
            _put(connection, 'biz_planning_tombstones', {'project_id': identifier, 'record_id': record, 'revision': revision}, ('project_id', 'record_id'))
            connection.execute('UPDATE biz_planning_records SET deleted=1 WHERE project_id=? AND id=?', (identifier, record))
    elif kind == 'alerts':
        _put(connection, table, {'id': identifier, 'archive_id': checked['archiveId'],
            'device_id': str(checked['deviceId']) if checked.get('deviceId') is not None else None,
            'metric': checked.get('metric'), 'level': checked.get('level'), 'first_seen_ms': checked['firstSeen'],
            'last_seen_ms': checked['lastSeen'], 'archive_state': checked['archiveState'], 'ended_at_ms': checked.get('endedAt'),
            'value': checked.get('value'), 'threshold': checked.get('threshold'), **common}, ('id',))
    elif kind == 'device_overrides':
        _put(connection, table, {'id': identifier, 'receiver_id': checked['receiverId'],
            'channel_number': checked['channelNumber'], 'alias': checked.get('alias'), **common}, ('id',))
    elif kind == 'preferences':
        _put(connection, table, {'id': identifier, **common}, ('id',))
        connection.execute('DELETE FROM biz_preference_values WHERE preference_id=?', (identifier,))
        for key, item in checked.items():
            value_type = 'null' if item is None else 'boolean' if type(item) is bool else 'number' if type(item) in (int, float) else 'text' if type(item) is str else 'json'
            _put(connection, 'biz_preference_values', {'preference_id': identifier, 'preference_key': key, 'value_type': value_type,
                'number_value': item if value_type == 'number' else None,
                'text_value': item if value_type == 'text' else _json(item) if value_type == 'json' else None,
                'boolean_value': item if value_type == 'boolean' else None}, ('preference_id', 'preference_key'))
    elif kind == 'plugins':
        _put(connection, table, {'id': identifier, 'status': checked['status'], 'installed': 0, **common}, ('id',))
    return checked
