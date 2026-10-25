"""Installed Shure adapter compatibility for receivers without MODEL/NET_SETTINGS.

Normal operation identifies a legacy ULXD protocol profile from fresh SCP
properties. SystemAPI is not an onboarding, metering or control prerequisite.
An explicitly supplied provider remains supported for older adapter fixtures.
"""
import ipaddress
import socket
import time
import re

from shure_metering import ShureMeterSession


def local_receiver_mac(host):
    """Windows IPv4 local-link evidence, not a MAC inferred from a device UUID."""
    import ctypes
    import sys
    try:
        ip=ipaddress.IPv4Address(host)
        if sys.platform!='win32' or ip.is_loopback or ip.is_multicast or ip.is_unspecified:return None
        send=ctypes.WinDLL('iphlpapi.dll').SendARP
        send.argtypes=[ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.POINTER(ctypes.c_uint32)]
        send.restype=ctypes.c_uint32
        buffer=(ctypes.c_uint32*2)();size=ctypes.c_uint32(8)
        if send(int.from_bytes(ip.packed,'little'),0,buffer,ctypes.byref(size)) or size.value!=6:return None
        raw=bytes(buffer)[:6]
        if raw[0]&1 or not any(raw):return None
        return ':'.join(f'{v:02X}' for v in raw)
    except (OSError,ValueError):return None


def systemapi_identity(host):
    from shure_systemapi import SystemApiClient
    return SystemApiClient().identity(host)


def identity_from_response(response, host):
    from shure_systemapi import identity_from_response as parse
    return parse(response, host)


def direct_model(reply):
    """Select a compatible decoder, not a fabricated receiver-reported MODEL.

    Require the ULXD receiver/channel property combination, never an open port,
    editable label, battery/sample alone, manufacturer OUI or tuned frequency.
    """
    if reply.model:
        return reply.model
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', reply.firmware or ''):
        return None
    if not isinstance(reply.settings.get('high_density'), bool) or reply.settings.get('frequency_diversity_mode') not in ('OFF','1+2','3+4','1+2/3+4'):
        return None
    channels=sorted(reply.channels)
    model={1:'ULXD4',2:'ULXD4D',4:'ULXD4Q'}.get(len(channels))
    if not model or channels!=list(range(1,len(channels)+1)):
        return None
    for raw in reply.channels.values():
        if (not re.fullmatch(r'\d{6}',raw.get('FREQUENCY',''))
            or raw.get('AUDIO_MUTE') not in ('ON','OFF')
            or not re.fullmatch(r'[AX][BX]',raw.get('RF_ANTENNA',''))
            or not re.fullmatch(r'\d{3}',raw.get('RX_RF_LVL',''))
            or not re.fullmatch(r'\d{3}',raw.get('AUDIO_LVL',''))
            or 'TX_TYPE' not in raw):
            return None
    return model


def legacy_probe(module, host, *, port=2202, stop=None, identity_provider=None, mac_provider=local_receiver_mac):
    ipaddress.IPv4Address(host)
    if stop and stop.is_set():return None
    reply=module.ShureReply();pending='';total=0
    try:
        with socket.create_connection((host,port),timeout=.35) as sock:
            sock.sendall(b'< GET 0 ALL >')  # SCP frames have no CR/LF terminator.
            sock.settimeout(.15);end=time.monotonic()+1.5
            while time.monotonic()<end:
                if stop and stop.is_set():return None
                try:chunk=sock.recv(8192)
                except socket.timeout:
                    if identity_provider and reply.firmware and reply.channels:break
                    continue
                if not chunk:break
                total+=len(chunk)
                if total>module.MAX_REPLY:return None
                frames,pending=module.extract_framed_messages(pending+chunk.decode('ascii'))
                for frame in frames:reply.feed(frame)
    except (OSError,ValueError):return None
    if not reply.firmware or not reply.channels:return None
    if identity_provider is None:
        model=direct_model(reply)
        if not model or (stop and stop.is_set()):return None
        reply.model=model;channels=reply.channel_values()
        if not reply.complete():return None
        mac=mac_provider(host)
        settings={**reply.settings,'identity_source':'direct-scp','model_source':'scp-compatible-profile',
            'legacy_scp':True,'receiver_mac':mac,'network_ip':host,
            'receiver_mac_source':'windows-arp' if mac else None,'legacy_control_identity':bool(mac)}
        return {'ip':host,'receiver_ip':host,'receiver_id':'Shure-'+model+'-'+(mac.replace(':','') if mac else host),
            'identity_basis':'direct-scp-local-link' if mac else 'direct-scp-endpoint','type':'receiver','brand':'Shure',
            'model':model,'model_display':model+' · SCP兼容识别','device_name':reply.device_name,'device_id':reply.device_name,
            'version':reply.firmware,'label':'Shure '+model,'ports':[port],
            'protocols':[{'port':port,'desc':'Shure SCP · 直接接入','proto':'Shure'}],
            'channels':{str(ch):{'channel_number':ch,**v} for ch,v in channels.items()},
            'channel_count':len(channels),'complete':True,'verified':True,'settings':settings,
            'protocol_verified':True,'hardware_verified':False,'discovered_via':'shure-scp','ts':time.time()}
    identity=identity_provider(host)
    if not identity or identity['firmware']!=reply.firmware or (stop and stop.is_set()):return None
    reply.model=identity['model'];channels=reply.channel_values()
    if not channels or not any(v.get('frequency_khz') is not None for v in channels.values()):return None
    settings={**reply.settings,'systemapi_device_id':identity['device_id'],'receiver_serial':identity['serial'],
              'identity_source':'local-shure-systemapi','legacy_scp':True,
              'receiver_mac':None,'network_ip':None,'receiver_mac_source':None,'legacy_control_identity':False}
    mac=mac_provider(host)
    if mac:
        settings.update(receiver_mac=mac,network_ip=host,receiver_mac_source='windows-arp',legacy_control_identity=True)
    return {'ip':host,'receiver_ip':host,'receiver_id':'Shure-'+identity['device_id'],
        'identity_basis':'systemapi-hardware-identity','type':'receiver','brand':'Shure','model':identity['model'],
        'model_display':identity['model'],'device_name':reply.device_name,'device_id':reply.device_name,
        'version':reply.firmware,'label':'Shure '+identity['model'],'ports':[port],
        'protocols':[{'port':port,'desc':'Shure SCP · 旧固件兼容','proto':'Shure'}],
        'channels':{str(ch):{'channel_number':ch,**v} for ch,v in channels.items()},
        'channel_count':len(channels),'complete':True,'verified':True,'settings':settings,
        'protocol_verified':True,'hardware_verified':False,'discovered_via':'shure-scp','ts':time.time()}


def validate_legacy_identity(receiver, provider=systemapi_identity, mac_provider=local_receiver_mac):
    if receiver.get('settings',{}).get('identity_source')=='direct-scp':
        expected=receiver['settings'].get('receiver_mac')
        return not expected or mac_provider(receiver['ip'])==expected
    identity=provider(receiver['ip']);settings=receiver['settings']
    return bool(identity and identity['device_id']==settings.get('systemapi_device_id')
        and identity['serial']==settings.get('receiver_serial') and identity['model']==receiver['model']
        and identity['firmware']==receiver['version']
        and (not settings.get('legacy_control_identity') or mac_provider(receiver['ip'])==settings.get('receiver_mac')))


def attach_legacy_support(namespace, discovery, *, live):
    module=namespace.load('shure_active_discovery.py')
    original_probe=module.probe_shure_sync;original_meter=module.ShureMeterSession
    if live:
        def probe(host, **kwargs):
            return original_probe(host, **kwargs) or legacy_probe(module,host,stop=kwargs.get('stop'))
        discovery.probe=probe
    def meter(receiver, callback):
        if receiver.get('settings',{}).get('legacy_scp'):
            return ShureMeterSession(receiver,callback,identity_check=validate_legacy_identity)
        return original_meter(receiver,callback)
    module.ShureMeterSession=meter
