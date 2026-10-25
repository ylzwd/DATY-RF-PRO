"""Spectrum analysis thresholds owned by the versioned business database."""
import copy
import math
import uuid

DOCUMENT_ID = 'spectrum_scan'
SCHEMA = 'daty-spectrum-settings-v1'
SEED = {'schema': SCHEMA, 'peakThresholdDbm': -60, 'exclusionThresholdDbm': -85}


def validate(value, fail):
    if type(value) is not dict or set(value) != set(SEED) or value.get('schema') != SCHEMA:
        fail('Invalid spectrum settings document')
    for key in ('peakThresholdDbm', 'exclusionThresholdDbm'):
        number = value[key]
        if type(number) not in (int, float) or not math.isfinite(number) or not -140 <= number <= 0:
            fail('Spectrum thresholds require finite dBm values from -140 through 0')


def ensure(connection, now_ms):
    """Caller owns the startup transaction; existing values and tombstones survive."""
    import unified_database as db
    existing = db.get_resource(connection, 'settings', DOCUMENT_ID)
    if existing is not None:
        return existing
    result = db.put_resource(connection, {
        'operation_id': uuid.uuid4().hex, 'epoch': db.status(connection)['epoch'],
        'kind': 'settings', 'id': DOCUMENT_ID, 'expected_revision': 0,
        'value': copy.deepcopy(SEED), 'deleted': False,
    }, {'id': 'server-spectrum-settings-v1', 'kind': 'server'}, now_ms)
    return result['resource']
