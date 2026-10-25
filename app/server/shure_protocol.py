"""Bounded, read-only Shure Command Strings decoding; see docs/shure-active-discovery-analysis.md.

Only documented REP properties identify/update channels. SAMPLE is not used as
identity proof or interpreted as a key/value stream. No SET builder exists here.
"""
from __future__ import annotations

import re
from shure_hardware import network_settings
from shure_fields import EXTRA_CHANNEL_FIELDS, channel_field, receiver_field, METER_FIELDS

MAX_FRAME = 4096
MAX_REPLY = 131072
MODELS = {'ULXD4': ('ULXD', 1), 'ULXD4D': ('ULXD', 2), 'ULXD4Q': ('ULXD', 4),
          'QLXD4': ('QLXD', 1), 'AD4D': ('AD4', 2), 'AD4Q': ('AD4', 4)}
_FRAME = re.compile(r'^(REP|SAMPLE)\s+(?:(\d+)\s+)?([A-Z][A-Z0-9_]*)(?:\s+(.*))?$')


def extract_framed_messages(buffer):
    messages=[]; start=None; in_text=False
    for index,char in enumerate(buffer):
        if start is None:
            if char=='<':start=index;in_text=False
            continue
        if index-start>MAX_FRAME:raise ValueError('Shure frame exceeds limit')
        if char=='{' and not in_text:in_text=True
        elif char=='}' and in_text:in_text=False
        elif not in_text:
            if char=='<':start=index
            elif char=='>':
                messages.append(buffer[start+1:index].strip());start=None
    return messages, buffer[start:] if start is not None else ''


def _valid_frame_text(message):
    in_text=False
    for char in message:
        if char=='{':
            if in_text:return False
            in_text=True
        elif char=='}':
            if not in_text:return False
            in_text=False
        elif char in '<>' and not in_text:return False
        elif ord(char)>126 or (ord(char)<32 and char not in '\t\r\n'):return False
    return not in_text


def parse_shure_frame(message):
    if not isinstance(message, str) or len(message) > MAX_FRAME or not _valid_frame_text(message):
        return None, None, {}
    m = _FRAME.fullmatch(message.strip())
    if not m:
        return None, None, {}
    kind, channel, key, value = m.groups()
    channel = int(channel) if channel is not None else None
    if channel is not None and not 0 <= channel <= 4:
        return None, None, {}
    return kind, channel, {key: (value or '').strip()}


def text_value(value, limit=80):
    value = value.strip()
    if (value.startswith('{') != value.endswith('}')) or ('{' in value[1:-1] or '}' in value[1:-1]):
        return None
    if value.startswith('{') and value.endswith('}'):
        value = value[1:-1].strip()
    elif value.startswith('"') and value.endswith('"'):
        value = value[1:-1].strip()
    if not value or len(value) > limit or any(ord(c) < 32 or ord(c) > 126 for c in value):
        return None
    return value


def number(value, minimum, maximum):
    if not re.fullmatch(r'\d{1,8}', value.strip()):
        return None
    n = int(value)
    return n if minimum <= n <= maximum else None


def model_name(value):
    value = text_value(value, 64)
    if not value:
        return None
    m = re.fullmatch(r'(ULXD4Q|ULXD4D|ULXD4|QLXD4|AD4D|AD4Q)(?:[- ].*)?', value.upper())
    return m.group(1) if m else None


class ShureReply:
    """One bounded GET transaction, including properties arriving before MODEL."""
    def __init__(self):
        self.model = None
        self.model_display = None
        self.device_name = None
        self.firmware = None
        self.settings = {}
        self.channels = {}

    def feed(self, message):
        kind, ch, fields = parse_shure_frame(message)
        if kind != 'REP':
            return
        key, value = next(iter(fields.items()))
        if ch is None:
            if key == 'MODEL':
                self.model = model_name(value)
                self.model_display = text_value(value, 64)
                suffix=re.fullmatch(r'(?:ULXD4Q|ULXD4D|ULXD4|AD4D|AD4Q)[ -]([A-Z][0-9]{2}[A-Z]?)',self.model_display or '')
                if suffix:self.settings['rf_band']=suffix[1]
            elif key == 'NET_SETTINGS':
                self.settings.update(network_settings(value) or {})
            elif key == 'RF_BAND':
                band=text_value(value,32)
                if band and re.fullmatch(r'[A-Z][A-Z0-9-]{1,15}',band):self.settings['rf_band']=band
            elif key == 'DEVICE_ID':
                self.device_name = text_value(value)
            elif key in ('FW_VER', 'FW_VERSION'):
                self.firmware = text_value(value, 64)
            elif receiver_field(key, value) is not None:
                self.settings.update(receiver_field(key, value))
            elif key in ('HIGH_DENSITY', 'MENU_LOCK', 'SYNC_LOCK'):
                self.settings[key.lower()] = {'ON': True, 'OFF': False}.get(value)
            elif key == 'FREQUENCY_DIVERSITY_MODE':
                self.settings['frequency_diversity_mode'] = value if value in ('OFF','1+2','3+4','1+2/3+4') else None
            return
        if not ch:
            return
        if key not in EXTRA_CHANNEL_FIELDS and key not in ('FREQUENCY', 'CHAN_NAME', 'AUDIO_MUTE', 'BATT_CHARGE', 'BATT_BARS',
                       'BATT_RUN_TIME', 'RX_RF_LVL', 'AUDIO_LVL', 'AUDIO_LEVEL_RMS', 'RSSI',
                       'BATT_TYPE', 'TX_TYPE', 'TX_MODEL', 'TX_MUTE_STATUS', 'TX_DEVICE_ID',
                       'TX_FW_VER', 'AUDIO_GAIN', 'RF_ANTENNA'):
            return
        raw = self.channels.setdefault(ch, {})
        if key == 'RSSI':
            parts = value.split()
            if len(parts) == 2 and parts[0] in ('1', '2', '3', '4'):
                raw['RSSI_' + parts[0]] = parts[1]
        else:
            raw[key] = value

    def channel_values(self):
        if not self.model:
            return {}
        family, count = MODELS[self.model]
        result = {}
        for ch, raw in self.channels.items():
            if ch > count:
                continue
            values = {}
            for key, value in raw.items():
                extra = channel_field(self.model, key, value, text_value)
                if extra is not None:
                    values.update(extra)
                    continue
                if family == 'QLXD' and key not in ('FREQUENCY', 'CHAN_NAME'):
                    continue  # Do not assume mute/battery/meter encodings across series.
                if key == 'FREQUENCY':
                    values['frequency_khz'] = number(value, 30000, 3000000)
                elif key == 'CHAN_NAME':
                    values['name'] = text_value(value)
                elif key == 'AUDIO_MUTE':
                    values['muted'] = {'ON': True, 'OFF': False}.get(value)
                elif key == 'BATT_CHARGE':
                    values['battery_percent'] = number(value, 0, 100)
                elif key == 'BATT_BARS':
                    values['battery_bars'] = number(value, 0, 5)
                elif key == 'BATT_RUN_TIME':
                    values['battery_minutes'] = number(value, 0, 65532)
                    values['battery_runtime_status'] = ('known' if values['battery_minutes'] is not None else
                        {65533: 'error', 65534: 'calculating', 65535: 'unknown'}.get(number(value,0,65535),'unknown'))
                elif key == 'AUDIO_GAIN':
                    n = number(value,0,60)
                    values['audio_gain_db'] = n - 18 if n is not None else None
                elif key == 'BATT_TYPE' and family == 'ULXD':
                    values['battery_type'] = value if value in ('LION','ALKA','NIMH','LITH','WARN') else None
                elif ((key == 'TX_TYPE' and family == 'ULXD') or (key == 'TX_MODEL' and family == 'AD4')):
                    values['transmitter_type'] = text_value(value,32) if value not in ('UNKN','UNKNOWN') else None
                elif key == 'TX_MUTE_STATUS' and family == 'ULXD':
                    values['transmitter_muted'] = {'ON': True, 'OFF': False}.get(value)
                elif key in ('TX_DEVICE_ID','TX_FW_VER') and family == 'ULXD':
                    values['transmitter_name' if key=='TX_DEVICE_ID' else 'transmitter_firmware'] = text_value(value,32)
                elif key == 'RF_ANTENNA' and family == 'ULXD':
                    values['rf_antenna'] = value if re.fullmatch(r'[AX][BX]',value) else None
                elif key == 'RX_RF_LVL' and family == 'ULXD':
                    n = number(value, 0, 255)
                    values['rf_dbm'] = n - 128 if n is not None else None
                elif (key == 'AUDIO_LVL' and family == 'ULXD') or (key == 'AUDIO_LEVEL_RMS' and family == 'AD4'):
                    n = number(value, 0, 255 if family == 'ULXD' else 120)
                    values['audio_dbfs'] = n - (50 if family == 'ULXD' else 120) if n is not None else None
            if family == 'AD4' and any(k.startswith('RSSI_') for k in raw):
                antenna = {k[-1]: number(v, 0, 120) for k, v in raw.items() if k.startswith('RSSI_')}
                values['rf_antennas_dbm'] = {k: v - 120 if v is not None else None for k, v in antenna.items()}
                valid = [v for v in values['rf_antennas_dbm'].values() if v is not None]
                values['rf_dbm'] = max(valid) if valid else None
            # QLXD RF/AF are intentionally not inferred from another product's units.
            if values:
                result[ch] = values
        return result

    def complete(self):
        values = self.channel_values()
        return bool(self.model and len(values) == MODELS[self.model][1]
                    and all(v.get('frequency_khz') is not None for v in values.values()))


def telemetry_view(receiver, channel, previous=None):
    """Versioned display DTO; preserve absent properties, clear explicit unknowns.

    Vendor meter floor and battery bars do not change DATY's canonical -40..0
    alarm range or pretend that bars are a measured battery percentage.
    """
    result = dict(previous or {})
    result.update(schema='daty-shure-telemetry-v1', model=receiver['model'],
                  receiver_firmware=receiver.get('version'))
    result['audio_floor_dbfs'] = {'ULXD': -50, 'AD4': -120}.get(MODELS.get(receiver['model'], ('',0))[0])
    for source,target in [('audio_dbfs','audio_dbfs'),('muted','receiver_muted'),
                          ('battery_percent','battery_percent'),('battery_bars','battery_bars'),
                          ('battery_minutes','battery_minutes'),('battery_runtime_status','battery_runtime_status'),
                          ('battery_type','battery_type'),('transmitter_type','transmitter_type'),
                          ('transmitter_muted','transmitter_muted'),('transmitter_name','transmitter_name'),
                          ('transmitter_firmware','transmitter_firmware'),('audio_gain_db','audio_gain_db'),
                          ('rf_antenna','rf_antenna'),('audio_raw','audio_raw'),('rf_raw','rf_raw'),
                          ('meter_state','meter_state'),('meter_stream_id','meter_stream_id'),
                          ('meter_seq','meter_seq'),('meter_received_at_ms','meter_received_at_ms'),
                          ('meter_interval_ms','meter_interval_ms')]:
        if source in channel:result[target]=channel[source]
    for key in channel:
        if key.startswith(('battery_', 'transmitter_')) or key in ('interference','interference_secondary','encryption_warning','unregistered_transmitter','rf_branches','rf_antennas_dbm','antenna_status','channel_quality','audio_peak_dbfs','audio_led_bitmap','meter_layout','rf_preset','rf_preset_secondary','frequency_secondary_khz','frequency_diversity_mode','stale_fields'):
            result[key] = channel[key]
    if 'field_times' in channel:
        result['field_times'] = {**result.get('field_times', {}), **channel['field_times']}
    result['settings'] = {**result.get('settings',{}),**receiver.get('settings',{})}
    return result
