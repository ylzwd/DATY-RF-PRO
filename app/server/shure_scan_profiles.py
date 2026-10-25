"""MAC-bound, explicitly evidenced ULXD scan profiles in the business database."""
import re

DOCUMENT_ID='shure_scan_profiles'
SCHEMA='daty-shure-scan-profiles-v1'
VERIFIED_RANGE={'start_khz':632125,'end_khz':695875,'step_khz':25}


def validate(value,fail):
    if type(value) is not dict or set(value)!={'schema','receivers'} or value.get('schema')!=SCHEMA:
        fail('Invalid Shure scan profiles document')
    entries=value['receivers']
    if type(entries) is not list or len(entries)>128:
        fail('Invalid Shure scan profile count')
    seen=set()
    for entry in entries:
        if type(entry) is not dict or set(entry)!={'receiver_mac','model','band','source','scan_range_khz','evidence_id'}:
            fail('Invalid Shure scan profile fields')
        mac=entry['receiver_mac']
        if not isinstance(mac,str) or not re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}',mac) or mac in seen:
            fail('Shure scan profile requires a unique normalized receiver MAC')
        seen.add(mac)
        if entry['model']!='ULXD4' or entry['band']!='L51' or entry['source']!='user-confirmed-chassis-label':
            fail('Shure scan profile is not verified for this hardware')
        limits=entry['scan_range_khz']
        if type(limits) is not dict or set(limits)!=set(VERIFIED_RANGE) or any(type(limits[k]) is not int or limits[k]!=v for k,v in VERIFIED_RANGE.items()):
            fail('Shure scan grid has not been verified')
        evidence=entry['evidence_id']
        if not isinstance(evidence,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}',evidence):
            fail('Shure scan profile needs a bounded evidence identifier')
