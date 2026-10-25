"""Hardware identity/band authority; never infer a band from tuned frequency."""
import json
from functools import lru_cache
import re
from pathlib import Path

# ULXD user guide 8964: L51 632–696 MHz, 25 kHz tuning and 350 kHz normal spacing.
BANDS = {'L51': {'min_khz':632000,'max_khz':696000,'step_khz':25,'origin_khz':0}}
def network_settings(value):
    parts=value.split()
    if len(parts)!=6 or parts[0]!='SC' or parts[1] not in ('AUTO','MANUAL'):return None
    if not re.fullmatch(r'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}',parts[5]):return None
    def ip(raw):
        values=raw.split('.')
        if len(values)!=4 or any(not v.isascii() or not v.isdigit() or not 0<=int(v)<=255 for v in values):raise ValueError()
        return '.'.join(str(int(v)) for v in values)
    try:return {'receiver_mac':parts[5].upper(),'network_ip':ip(parts[2])}
    except ValueError:return None

@lru_cache(maxsize=1)
def hardware_registry():
    try:
        value=json.loads(Path(__file__).with_name('shure-hardware.json').read_text('utf-8'))
        return value if isinstance(value,dict) else {}
    except (OSError,ValueError):return {}

def band_identity(model, settings, registry=None):
    """Only exact receiver-reported band or explicit MAC/model-bound label record."""
    if registry is None:
        registry=hardware_registry()
    reported=settings.get('rf_band')
    label=registry.get(settings.get('receiver_mac'),{})
    if label.get('receiver_serial') and label['receiver_serial']!=settings.get('receiver_serial'):
        return {'band':reported,'source':'identity-conflict','verified':False}
    if label.get('systemapi_device_id') and label['systemapi_device_id']!=settings.get('systemapi_device_id'):
        return {'band':reported,'source':'identity-conflict','verified':False}
    label=label.get('band') if label.get('model')==model else None
    if reported and label and reported!=label:
        return {'band':reported,'source':'conflict','verified':False}
    band=reported or label
    source='receiver-reported' if reported else 'chassis-label-confirmed' if label else 'unavailable'
    limits=BANDS.get(band) if model in ('ULXD4','ULXD4D','ULXD4Q') else None
    return {'band':band,'source':source,'verified':bool(limits),**(limits or {})}

def capabilities(device):
    shure=device.get('shure');shure=shure if isinstance(shure,dict) else {}
    settings=shure.get('settings');settings=settings if isinstance(settings,dict) else {}
    model=device.get('model');band=band_identity(model,settings)
    live=(device.get('_source')=='shure-scp' and shure.get('meter_state')=='live' and bool(shure.get('meter_stream_id'))
          and bool(settings.get('receiver_mac')))
    supported=model in ('ULXD4','ULXD4D','ULXD4Q','AD4D','AD4Q')
    normal=(settings.get('frequency_diversity_mode')=='OFF' and settings.get('high_density') is False)
    limits=frequency_limits(model,settings)
    frequency=bool(live and supported and normal and limits['verified'])
    return {'write_frequency':frequency,'mute':bool(live and supported),'read_only':not(live and supported),
        'adapter':'shure-scp','confirmation':'post-write-readback','hardware_band':band,
        'frequency_control':{'scope':'shure-scp','ack_mode':'readback','brand_binding':'expected-brand-v1',
            **{k:limits[k] for k in ('min_khz','max_khz','step_khz','origin_khz') if k in limits},
            'band':band['band'],'band_source':band['source'],'minimum_spacing_khz':350,
            'hardware_range_known':band['verified'],'range_source':limits.get('source'),
            'note':'接收机输出静音/调频，发送后新连接回读；不提供设备 command_id ACK'},
        'control_preparation':{'write_enabled':frequency,'hardware_band_verified':band['verified'],
            'confirmation':'post-write-readback','execution_ack_supported':False}}

def frequency_limits(model,settings):
    band=band_identity(model,settings)
    if band['verified'] or band['source']=='conflict' or settings.get('identity_source')!='direct-scp':return band
    # Command envelope, NOT a claimed hardware band. The receiver accepts/rejects
    # the request; only an independent matching readback confirms application.
    if model in ('ULXD4','ULXD4D','ULXD4Q'):
        return {'verified':True,'source':'scp-command-envelope','min_khz':400000,'max_khz':900000,'step_khz':25,'origin_khz':0}
    return band
