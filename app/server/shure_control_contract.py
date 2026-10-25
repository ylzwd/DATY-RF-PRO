"""Offline ULX-D frequency preparation, never a socket or a production outlet.

Reference: Shure ULX-D Command Strings / FREQUENCY. A matching readback proves
observed frequency, not an attributable execution ACK; Shure has no command ID.
The runtime remains read-only until model/band, authorization and reconciliation
are connected to the existing command journal and independently accepted.
"""
from shure_protocol import MODELS, parse_shure_frame, number


def control_readiness(model):
    documented = isinstance(model,str) and model in MODELS and MODELS[model][0] == 'ULXD'
    return {'schema':'daty-shure-control-preparation-v1', 'write_enabled':False,
            'frequency_command_documented':documented, 'hardware_band_verified':False,
            'confirmation':'post-write-frequency-readback', 'execution_ack_supported':False}


def prepare_frequency_change(*, model, receiver_id, channel, frequency_khz,
                             band_min_khz, band_max_khz, step_khz, origin_khz):
    """Pure checked preview; supplied hardware band must be verified by the caller."""
    if not control_readiness(model)['frequency_command_documented']:
        raise ValueError('Frequency command not verified for this model')
    if not isinstance(receiver_id,str) or not receiver_id.strip() or len(receiver_id)>256:
        raise ValueError('Stable receiver identity required')
    if type(channel) is not int or not 1<=channel<=MODELS[model][1]:
        raise ValueError('Channel outside this receiver model')
    if any(type(v) is not int for v in (frequency_khz,band_min_khz,band_max_khz,step_khz,origin_khz)):
        raise ValueError('Integer kHz values required; never round a command')
    if not (30000<=band_min_khz<=frequency_khz<=band_max_khz<=999999 and step_khz>0):
        raise ValueError('Frequency outside supplied hardware band')
    if (frequency_khz-origin_khz)%step_khz:
        raise ValueError('Frequency outside supplied tuning grid')
    return {'schema':'daty-shure-frequency-preview-v1','receiver_id':receiver_id,'model':model,
            'channel':channel,'frequency_khz':frequency_khz,'sent':False,'write_enabled':False,
            'set_preview':f'< SET {channel} FREQUENCY {frequency_khz:06d} >',
            'readback_query':f'< GET {channel} FREQUENCY >',
            'confirmation':'post-write-frequency-readback','execution_ack_supported':False}


def frequency_readback_matches(preview, message):
    kind,ch,fields=parse_shure_frame(message)
    return (kind=='REP' and ch==preview['channel'] and 'FREQUENCY' in fields and
            number(fields['FREQUENCY'],30000,999999)==preview['frequency_khz'])
