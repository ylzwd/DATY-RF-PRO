"""Versioned, declarative monitoring configuration owned by the business DB.

The server seed is used only for the first committed creation. Clients never
ship this seed or load it as a fallback. No executable code is accepted here.
"""
import copy
import math
import uuid

DOCUMENT_ID = 'monitoring_display_rules'
SCHEMA = 'daty-monitoring-display-v1'
SEED = {
    'schema': SCHEMA,
    'overview': {
        'receiverCount': 'online-deduplicated-receiver',
        'channelCount': 'receiver-online-channels',
        'centerFrequency': 'planning-range-midpoint',
        'brandVisibility': 'online-only',
        'labels': ['在线设备', '活跃通道', '当前中心频率 MHz', '告警事件'],
        'rfMinDbm': -90, 'rfMaxDbm': -30,
    },
    'identity': {
        'order': 'numeric-group-channel', 'groupPrefix': 'GUP', 'channelPrefix': 'CH',
        'receiverPrefix': '接收机 ', 'pageSize': 50,
        'brandSource': 'reported', 'modelSource': 'reported',
        'onlineText': '在线', 'offlineText': '离线', 'warningText': '注意',
        'brandFilter': 'installed-plugins', 'muteBadgeSource': 'fresh-receiver-or-transmitter',
        'muteControl': 'receiver-output-real-confirmation',
        'mutedText': '🔇 已静音', 'muteActionText': '🔇 静音', 'unmuteActionText': '🔊 取消静音',
        'muteUnknownText': '输出静音未知', 'commandPendingText': '⏳ 等待设备确认',
    },
    'frequency': {
        'source': 'reported-khz', 'decimals': 3, 'unit': 'MHz',
        'usageSource': 'frequency_planning.locks.note', 'usageAlignment': 'right',
    },
    'signals': {
        'source': 'current-valid-telemetry', 'unknownText': '—',
        'rfMinDbm': -90, 'rfMaxDbm': -30, 'rfDecimals': 0, 'rfUnit': 'dBm',
        'hideRfWhenOffline': True, 'hideRfWhenUnknown': True,
        'afDecimals': 1, 'afUnit': 'dBFS', 'batteryDecimals': 0, 'batteryUnit': '%',
        'batterySource': 'percent-then-bars-then-runtime',
        'batteryBarsText': '{value}/5 格', 'batteryMinutesText': '{value}分', 'staleText': '已过期',
        'afFloors': {'DATYaudio': -40, 'ULXD4': -50, 'ULXD4D': -50, 'ULXD4Q': -50, 'AD4D': -120, 'AD4Q': -120},
    },
    'transmitter': {
        'offlineBelowDbm': -90, 'comparison': 'lt',
        'recovery': 'current-rf-at-or-above-threshold', 'unknownRf': 'pending-not-recovered',
        'requireFresh': True, 'modelSource': 'current-reported', 'alignment': 'right',
        'offlineText': '话筒离线', 'unknownText': '话筒状态未知',
        'modelUnknownText': '话筒型号未知', 'connectingText': '话筒连接中', 'modelPrefix': '话筒 ',
    },
    'alerts': {
        'thresholdSource': 'alert_thresholds', 'soundSource': 'alert_sound',
        'offlineReplacesRfWeak': True, 'unchanged': 'last-seen-only',
        'lifecycle': 'distinct-recovery-retrigger', 'history': 'memory-only',
        'offlineLevel': 'warn', 'pendingText': '（当前状态待确认）',
        'levels': {'rf': 'warn', 'af': 'crit', 'battery': 'warn', 'battery_bars': 'warn',
                   'battery_error': 'warn', 'rf_interference': 'warn', 'rf_interference_secondary': 'warn',
                   'encryption_mismatch': 'warn', 'unregistered_transmitter': 'warn'},
        'labels': {'transmitter_offline': '话筒离线', 'rf': 'RF 弱信号', 'af': 'AF 过载',
                   'battery': '电池低电量', 'battery_bars': '电池格数低',
                   'battery_error': '电池通讯错误', 'rf_interference': '接收机报告 RF 干扰',
                   'rf_interference_secondary': '第二频率分支 RF 干扰',
                   'encryption_mismatch': '加密不匹配', 'unregistered_transmitter': '未登记的发射机'},
    },
}

# Retain the exact v1 template to validate a stored document before its atomic
# upgrade. Only new evaluator declarations change; user thresholds/text survive.
LEGACY_SEED = copy.deepcopy(SEED)
SCHEMA = 'daty-monitoring-display-v2'
SEED['schema'] = SCHEMA
SEED['transmitter']['offlineEvidence'] = 'fresh-rf-or-ulxd-no-reception'
SEED['transmitter']['recovery'] = 'fresh-valid-reception'
SEED['alerts']['offlineSuppressedMetrics'] = [
    'transmitter_offline', 'rf', 'af', 'battery', 'battery_bars', 'battery_error',
    'encryption_mismatch', 'unregistered_transmitter',
]

# Source/aggregation selectors are an allowlist of implemented evaluators, never
# arbitrary expressions. Safety/protocol constraints cannot be disabled by UI data.
FIXED = {'schema', 'receiverCount', 'channelCount', 'centerFrequency', 'brandVisibility',
         'order', 'brandSource', 'modelSource', 'source', 'usageSource', 'usageAlignment',
         'batterySource', 'comparison', 'recovery', 'unknownRf', 'requireFresh', 'alignment',
         'thresholdSource', 'soundSource', 'offlineReplacesRfWeak', 'unchanged', 'lifecycle',
         'history', 'hideRfWhenOffline', 'hideRfWhenUnknown'}
FIXED.update({'brandFilter','muteBadgeSource','muteControl','offlineEvidence'})
BOUNDS = {'pageSize': (1, 100), 'decimals': (0, 6), 'rfDecimals': (0, 3),
          'afDecimals': (0, 3), 'batteryDecimals': (0, 2), 'rfMinDbm': (-150, -1),
          'rfMaxDbm': (-149, 20), 'offlineBelowDbm': (-150, -30)}


def validate(value, fail, *, _template=None):
    def walk(actual, expected, key=''):
        if isinstance(expected, dict):
            if not isinstance(actual, dict) or set(actual) != set(expected):
                fail('Monitoring rules have missing or unknown fields: ' + key)
            if key == 'afFloors':
                for k,v in expected.items():
                    if type(actual[k]) not in (int,float) or actual[k]!=v:fail('Unsupported protocol AF scale: '+k)
            else:
                for k, v in expected.items(): walk(actual[k], v, k)
        elif isinstance(expected, list):
            if key == 'offlineSuppressedMetrics':
                if actual != expected: fail('Unsupported offline alert policy')
                return
            if not isinstance(actual, list) or len(actual) != len(expected): fail('Invalid overview labels')
            for item in actual: walk(item, '', 'label')
        elif key in FIXED:
            if type(actual) is not type(expected) or actual != expected: fail('Unsupported monitoring evaluator: ' + key)
        elif key in BOUNDS:
            low, high = BOUNDS[key]
            if type(actual) not in (int, float) or not math.isfinite(actual) or not low <= actual <= high:
                fail('Invalid monitoring numeric rule: ' + key)
            if key in ('pageSize', 'decimals', 'rfDecimals', 'afDecimals', 'batteryDecimals') and type(actual) is not int:
                fail('Integer required: ' + key)
        elif not isinstance(actual, str) or not actual.strip() or len(actual) > 100 or any(ord(c) < 32 for c in actual):
            fail('Invalid monitoring text: ' + key)
    walk(value, SEED if _template is None else _template)
    for category in ('overview', 'signals'):
        if value[category]['rfMinDbm'] >= value[category]['rfMaxDbm']: fail('RF display range is reversed')
    if value['alerts']['offlineLevel'] not in ('warn', 'crit'): fail('Invalid offline severity')
    if any(level not in ('warn','crit') for level in value['alerts']['levels'].values()):fail('Invalid alarm severity')
    for k in ('batteryBarsText', 'batteryMinutesText'):
        text=value['signals'][k]
        if text.count('{value}') != 1 or '{' in text.replace('{value}', '') or '}' in text.replace('{value}', ''):
            fail('Invalid battery value template')


def ensure(connection, now_ms):
    """Run inside the server's existing startup DB transaction, before listeners.

    V1 upgrades once via the existing versioned resource transaction. All user
    thresholds/text and unrelated settings survive; tombstones stay deleted.
    """
    import unified_database as db
    existing = db.get_resource(connection, 'settings', DOCUMENT_ID)
    if existing is not None:
        if existing.get('deleted') or existing.get('value', {}).get('schema') != LEGACY_SEED['schema']:
            return existing
        value = copy.deepcopy(existing['value'])
        def invalid(message): raise ValueError(message)
        validate(value, invalid, _template=LEGACY_SEED)
        value['schema'] = SCHEMA
        value['transmitter']['offlineEvidence'] = SEED['transmitter']['offlineEvidence']
        value['transmitter']['recovery'] = SEED['transmitter']['recovery']
        value['alerts']['offlineSuppressedMetrics'] = copy.deepcopy(SEED['alerts']['offlineSuppressedMetrics'])
    else:
        value = copy.deepcopy(SEED)
    result = db.put_resource(connection, {
        'operation_id': uuid.uuid4().hex, 'epoch': db.status(connection)['epoch'],
        'kind': 'settings', 'id': DOCUMENT_ID, 'expected_revision': existing['revision'] if existing else 0,
        'value': value, 'deleted': False,
    }, {'id': 'server-monitoring-rules-v2', 'kind': 'server'}, now_ms)
    return result['resource']
