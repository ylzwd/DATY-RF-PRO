"""Planning editor configuration, not planning history or scan samples.

Incomplete input is a durable draft. Calculation validation remains separate.
The caller performs the authenticated CAS transaction and commit receipt.
"""
import json

SCHEMA = 'daty-planning-settings-v1'
MAX_BYTES = 128 * 1024
# Order is part of the durable editor representation, independent of UI labels.
IMD_PRODUCTS = ('2T3O', '2T5O', '2T7O', '2T9O', '3T3O')
FIELDS = {
    'plannerRange', 'plannerRangeStart', 'plannerRangeEnd',
    'plannerCompatibility', 'plannerExcludedRanges', 'plannerKnownCarriers',
    'plannerBackupCount', 'plannerStepKHz', 'plannerMinSpacingKHz',
    'plannerImdSpacingKHz', 'plannerScanThresholdDbm', 'plannerImdPolicy',
}
OPTIONAL_FIELDS = {'plannerImdProducts'}


def validate_imd_products(value, fail):
    """Accept a canonical subset, including the explicit no-IMD selection."""
    if (type(value) is not list or any(type(item) is not str or item not in IMD_PRODUCTS for item in value)
            or value != [item for item in IMD_PRODUCTS if item in value]):
        fail('Invalid or repeated IMD product selection')


def validate(value, fail):
    def keys(item, expected):
        if type(item) is not dict or set(item) != set(expected):
            fail('Invalid planning settings fields')

    def text(item, limit, multiline=False):
        if not isinstance(item, str) or len(item) > limit:
            fail('Planning input exceeds text limit')
        if any((ord(c) < 32 and (not multiline or c not in '\r\n\t')) or ord(c) == 127 for c in item):
            fail('Planning input contains control characters')
        try:
            item.encode('utf-8', errors='strict')
        except UnicodeError:
            fail('Planning input contains invalid Unicode')

    keys(value, ('schema', 'fields', 'locks', 'editor'))
    if value['schema'] != SCHEMA:
        fail('Unsupported planning settings schema')
    fields = value['fields']
    if type(fields) is not dict or not FIELDS <= set(fields) or set(fields) - FIELDS - OPTIONAL_FIELDS:
        fail('Invalid planning settings fields')
    for key, item in fields.items():
        multiline = key in ('plannerExcludedRanges', 'plannerKnownCarriers')
        text(item, 16384 if multiline else 64, multiline)
    for key, allowed in (
        ('plannerRange', ('614250:638000', '470000:608000', '640000:690000', 'custom', 'scan')),
        ('plannerCompatibility', ('standard', 'robust', 'more-frequencies')),
        ('plannerImdPolicy', ('third', 'third-fifth')),
    ):
        if fields[key] not in allowed:
            fail('Unknown planning option: ' + key)
    # Missing means a legacy document. Do not insert defaults or mutate read/CAS
    # receipts: clients map the old policy until the next explicit edit is saved.
    if 'plannerImdProducts' in fields:
        raw = fields['plannerImdProducts']
        validate_imd_products(raw.split(',') if raw else [], fail)
    locks = value['locks']
    if type(locks) is not list or len(locks) > 1024:
        fail('Invalid planning lock list')
    seen = set()
    for lock in locks:
        keys(lock, ('deviceId', 'frequencyKHz', 'note'))
        text(lock['deviceId'], 512)
        if not lock['deviceId'].strip() or lock['deviceId'] in seen:
            fail('Planning lock must have a unique stable channel identity')
        seen.add(lock['deviceId'])
        frequency = lock['frequencyKHz']
        if type(frequency) is not int or not 30000 <= frequency <= 3000000:
            fail('Planning lock requires integer kHz')
        text(lock['note'], 80)
    editor = value['editor']
    keys(editor, ('tab', 'selectedDeviceId', 'lockNote'))
    if editor['tab'] not in ('basic', 'constraints'):
        fail('Unknown planning editor tab')
    text(editor['selectedDeviceId'], 512)
    text(editor['lockNote'], 80)
    if len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > MAX_BYTES:
        fail('Planning settings exceeds 128 KiB')
