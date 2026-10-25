"""Model-specific read-only fields (Shure ULXD 8338 / AD4 7483)."""
import re


def numeric(value, low, high, offset=0):
    if not re.fullmatch(r'[0-9]{1,8}', value):
        return None
    n = int(value)
    return n + offset if low <= n <= high else None


def enum(value, choices):
    return value if value in choices.split() else None


BATTERY = {
    'BARS': ('battery_bars', 0, 5, 0),
    'CHARGE': ('battery_percent', 0, 100, 0),
    'RUN_TIME': ('battery_minutes', 0, 65532, 0),
    'HEALTH': ('battery_health_percent', 0, 100, 0),
    'CYCLE': ('battery_cycles', 0, 65534, 0),
    'TEMP_C': ('battery_temperature_c', 0, 254, -40),
    'TEMP_F': ('battery_temperature_f', 0, 254, -40),
}
AD_BATTERY = {'BARS':'BARS','CHARGE_PERCENT':'CHARGE','MINS':'RUN_TIME',
              'HEALTH_PERCENT':'HEALTH','CYCLE_COUNT':'CYCLE','TEMP_C':'TEMP_C','TEMP_F':'TEMP_F','TYPE':'TYPE'}
EXTRA_CHANNEL_FIELDS = set('RF_INT_DET ENCRYPTION_WARNING ENCRYPTION_STATUS INTERFERENCE_STATUS INTERFERENCE_STATUS2 UNREGISTERED_TX_STATUS TX_MUTE_MODE_STATUS TX_POWER_LEVEL TX_RF_PWR TX_OFFSET TX_INPUT_PAD TX_POLARITY TX_LOCK TX_MENU_LOCK TX_PWR_LOCK TX_POWER_SOURCE TX_MUTE_BUTTON_STATUS TX_TALK_SWITCH GROUP_CHAN GROUP_CHANNEL GROUP_CHANNEL2 FREQUENCY2 FD_MODE AUDIO_LEVEL_PEAK ANTENNA_STATUS CHAN_QUALITY AUDIO_LED_BITMAP'.split()) | {'BATT_'+k for k in BATTERY} | {'TX_BATT_'+k for k in AD_BATTERY}
METER_FIELDS = {'audio_dbfs','audio_peak_dbfs','rf_dbm','rf_antenna','rf_antennas_dbm',
                'rf_branches','antenna_status','channel_quality','audio_led_bitmap',
                'audio_raw','rf_raw','meter_layout'}


def channel_field(model, key, value, text):
    """None means not handled; a dict containing null is an explicit unknown."""
    family = 'AD4' if model.startswith('AD4') else 'ULXD' if model.startswith('ULXD') else ''
    if not family:
        return None
    if (family=='AD4' and key.startswith('BATT_')) or (family=='ULXD' and key.startswith('TX_BATT_')):
        return {}
    suffix = key[5:] if family == 'ULXD' and key.startswith('BATT_') else AD_BATTERY.get(key[8:]) if family == 'AD4' and key.startswith('TX_BATT_') else None
    if suffix in BATTERY:
        name, low, high, offset = BATTERY[suffix]
        result = {name:numeric(value, low, high, offset)}
        if suffix == 'RUN_TIME':
            result['battery_runtime_status'] = 'known' if result[name] is not None else {'65533':'error','65534':'calculating'}.get(value,'unknown')
        return result
    if suffix == 'TYPE':
        return {'battery_type':enum(value, 'LION ALKA NIMH LITH WARN' if family=='ULXD' else 'LION ALKA NIMH LITH')}
    names = {'RF_INT_DET':('interference','NONE CRITICAL'), 'ENCRYPTION_WARNING':('encryption_warning','OFF ON'),
        'ENCRYPTION_STATUS':('encryption_warning','OK ERROR'), 'INTERFERENCE_STATUS':('interference','NONE DETECTED'),
        'INTERFERENCE_STATUS2':('interference_secondary','NONE DETECTED'), 'UNREGISTERED_TX_STATUS':('unregistered_transmitter','OK ERROR')}
    allowed = {'ULXD': {'RF_INT_DET','ENCRYPTION_WARNING'}, 'AD4':set(names)-{'RF_INT_DET','ENCRYPTION_WARNING'}}
    if key in allowed[family]:
        name, choices = names[key]
        return {name:enum(value, choices)}
    if key == 'TX_MUTE_MODE_STATUS' and family == 'AD4':
        return {'transmitter_muted':{'ON':False,'MUTE':True}.get(value)}
    if key == 'TX_DEVICE_ID' and family == 'AD4':
        return {'transmitter_name':text(value,31)}
    if key in ('TX_OFFSET','TX_INPUT_PAD') and (key=='TX_OFFSET' or family=='AD4'):
        return {'transmitter_offset_db' if key=='TX_OFFSET' else 'transmitter_input_pad_db':
                numeric(value,0,33,-12) if key=='TX_OFFSET' else {'000':-12,'012':0}.get(value)}
    if key == 'TX_POWER_LEVEL' and family == 'AD4':
        return {'transmitter_power_mw':numeric(value,0,254)}
    enums = {'TX_RF_PWR':('transmitter_power_level','LOW NORMAL HIGH'),
        'TX_POWER_SOURCE':('transmitter_power_source','BATTERY EXTERNAL'),
        'TX_MUTE_BUTTON_STATUS':('transmitter_mute_button','PRESSED RELEASED'),
        'TX_LOCK':('transmitter_lock','NONE POWER MENU ALL'),
        'TX_POLARITY':('transmitter_polarity','POSITIVE NEGATIVE'),
        'FD_MODE':('frequency_diversity_mode','OFF FD-S FD-C')}
    if key in enums and ((family=='ULXD') == (key in ('TX_RF_PWR','TX_POWER_SOURCE','TX_MUTE_BUTTON_STATUS'))):
        name, choices = enums[key]
        return {name:enum(value,choices)}
    if (family=='ULXD' and key in ('TX_MENU_LOCK','TX_PWR_LOCK')) or (family=='AD4' and key=='TX_TALK_SWITCH'):
        name={'TX_MENU_LOCK':'transmitter_menu_lock','TX_PWR_LOCK':'transmitter_power_lock','TX_TALK_SWITCH':'transmitter_talk_switch'}[key]
        return {name:{'ON':True,'OFF':False}.get(value)}
    if (family=='ULXD' and key=='GROUP_CHAN') or (family=='AD4' and key in ('GROUP_CHANNEL','GROUP_CHANNEL2')):
        return {'rf_preset_secondary' if key.endswith('2') else 'rf_preset':text(value,32)}
    if family=='AD4':
        if key=='FREQUENCY2':return {'frequency_secondary_khz':numeric(value,30000,3000000)}
        if key=='AUDIO_LEVEL_PEAK':return {'audio_peak_dbfs':numeric(value,0,120,-120)}
        if key=='CHAN_QUALITY':return {'channel_quality':numeric(value,0,5)}
        if key=='AUDIO_LED_BITMAP':return {'audio_led_bitmap':numeric(value,0,255)}
        if key=='ANTENNA_STATUS':return {'antenna_status':value if re.fullmatch(r'[XRB]{2}(?:[XRB]{2})?',value) else None}
    return None


def receiver_field(key, value):
    enums = {'ENCRYPTION':('encryption_mode','OFF AUTO MANUAL'),
        'ENCRYPTION_MODE':('encryption_mode','OFF ON'),
        'TRANSMISSION_MODE':('transmission_mode','STANDARD HIGH_DENSITY'),
        'AUDIO_SUMMING_MODE':('audio_summing_mode','OFF 1+2 3+4 1+2/3+4 1+2+3+4')}
    if key in enums:
        name,choices=enums[key]
        return {name:enum(value,choices)}
    if key in ('POWER_LOCK','GAIN_LOCK','SCAN_LOCK','QUADVERSITY_MODE'):
        return {key.lower():{'ON':True,'OFF':False}.get(value)}
    if key=='RF_BAND':return {'rf_band':value.strip('{} ').strip()[:32] or None}
    return None


def ad4_sample(parts):
    """All four documented layouts are self-describing by exact field count."""
    layout = {9:('standard',2,1),13:('quadversity',4,1),14:('fd-c',2,2),22:('quadversity-fd-c',4,2)}.get(len(parts))
    if not layout:return None
    name,antennas,branches=layout
    if any(not re.fullmatch(r'[0-9]{3}',v) for v in parts[:4]):return None
    quality,bitmap,peak,rms=map(int,parts[:4])
    if quality not in (0,1,2,3,4,5,255) or bitmap>255 or peak>120 or rms>120:return None
    rf_branches={}; pos=4
    for branch in range(1,branches+1):
        status=parts[pos];pos+=1
        if len(status)!=antennas or not re.fullmatch('[XRB]+',status):return None
        signals={};leds={}
        for ant in range(1,antennas+1):
            led,rf=parts[pos:pos+2];pos+=2
            if not re.fullmatch(r'[0-9]{2}',led) or not re.fullmatch(r'[0-9]{3}',rf):return None
            if int(led)>63 or int(rf)>120:return None
            signals[str(ant)]=int(rf)-120;leds[str(ant)]=int(led)
        rf_branches[str(branch)]={'antenna_status':status,'rf_antennas_dbm':signals,'rf_led_bitmap':leds}
    primary=rf_branches['1']
    return {'channel_quality':quality if quality<=5 else None,'audio_led_bitmap':bitmap,
        'audio_dbfs':rms-120,'audio_peak_dbfs':peak-120,'audio_raw':rms,
        'rf_dbm':max(v for b in rf_branches.values() for v in b['rf_antennas_dbm'].values()),
        'rf_antennas_dbm':primary['rf_antennas_dbm'],'antenna_status':primary['antenna_status'],
        'rf_branches':rf_branches,'meter_layout':name}
