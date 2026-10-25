"""Read-only local Shure SystemAPI identity and diagnostics, owned by the plugin.

Never follows redirects, proxies credentials, disables TLS, upgrades firmware or
infers RF bands from a tuned frequency. Diagnostic cache is not control evidence.
"""
import copy
import ipaddress
import json
from pathlib import Path
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ORIGIN='https://127.0.0.1:10000'
SECURITY=Path('C:/ProgramData/Shure/SystemAPI/Standalone/security')
MAX_RESPONSE=1024*1024

class SystemApiError(Exception):
    """Only a bounded, credential-free code may leave this boundary."""

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def identity_from_response(response,host):
    if not isinstance(response,dict) or not isinstance(response.get('edges'),list) or len(response['edges'])>4000:return None
    matches=[]
    for edge in response['edges']:
        if not isinstance(edge,dict) or not isinstance(edge.get('node'),dict):continue
        node=edge['node'];network,software,hardware=(node.get(k,{}) for k in ('communicationProtocol','softwareIdentity','hardwareIdentity'))
        if not all(isinstance(v,dict) for v in (network,software,hardware)):continue
        if (node.get('deviceState')!='ONLINE' or network.get('address')!=host
            or software.get('model') not in ('ULXD4','ULXD4D','ULXD4Q') or software.get('firmwareValid') is not True):continue
        try:
            device_id=str(uuid.UUID(hardware['deviceId']));serial=hardware['serialNumber'];firmware=software['firmwareVersion']
            if not isinstance(serial,str) or not 1<=len(serial)<=64 or not serial.isalnum():continue
            if not isinstance(firmware,str) or not 1<=len(firmware)<=64:continue
        except (KeyError,ValueError,TypeError,AttributeError):continue
        matches.append({'device_id':device_id,'serial':serial,'model':software['model'],'firmware':firmware,'ip':host})
    return matches[0] if len(matches)==1 else None

class SystemApiClient:
    def __init__(self,*,security=SECURITY):self.security=Path(security)
    def get(self,path):
        if not path.startswith('/api/v1/devices') or any(c in path for c in ('\r','\n','#')):raise SystemApiError('INVALID_LOCAL_API_PATH')
        try:
            cert=(self.security/'systemapicertificate.cer').read_bytes()
            context=ssl.create_default_context()
            context.load_verify_locations(cadata=cert.decode('ascii') if cert.startswith(b'-----BEGIN') else cert)
            key=(self.security/'SharedKey.txt').read_text('utf-8-sig').strip()
            if not key or len(key)>4096 or '\r' in key or '\n' in key:raise SystemApiError('LOCAL_API_CREDENTIAL_INVALID')
            request=urllib.request.Request(ORIGIN+path,headers={'x-api-key':key,'Accept':'application/json'},method='GET')
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=context),NoRedirect())
            with opener.open(request,timeout=2) as response:raw=response.read(MAX_RESPONSE+1)
            if len(raw)>MAX_RESPONSE:raise SystemApiError('LOCAL_API_RESPONSE_TOO_LARGE')
            return json.loads(raw)
        except FileNotFoundError:raise SystemApiError('LOCAL_API_NOT_CONFIGURED') from None
        except urllib.error.HTTPError as error:
            code='LOCAL_API_AUTH_FAILED' if error.code in (401,403) else 'LOCAL_API_REDIRECT_REFUSED' if 300<=error.code<400 else 'LOCAL_API_HTTP_'+str(error.code)
            error.close();raise SystemApiError(code) from None
        except ssl.SSLError:raise SystemApiError('LOCAL_API_TLS_FAILED') from None
        except urllib.error.URLError as error:
            raise SystemApiError('LOCAL_API_TLS_FAILED' if isinstance(error.reason,ssl.SSLError) else 'LOCAL_API_UNAVAILABLE') from None
        except (OSError,ValueError,UnicodeError):raise SystemApiError('LOCAL_API_INVALID_RESPONSE') from None
    def devices(self):
        edges=[];after=None;cursors=set();identities=set()
        for _ in range(4):
            path='/api/v1/devices?first=1000'+('&after='+urllib.parse.quote(after,safe='') if after else '')
            body=self.get(path)
            if (not isinstance(body,dict) or not isinstance(body.get('edges'),list) or len(body['edges'])>1000
                or not isinstance(body.get('pageInfo'),dict)):raise SystemApiError('LOCAL_API_INVALID_PAGE')
            for edge in body['edges']:
                try:identity=str(uuid.UUID(edge['node']['hardwareIdentity']['deviceId']))
                except (KeyError,TypeError,ValueError,AttributeError):raise SystemApiError('LOCAL_API_INVALID_DEVICE') from None
                if identity in identities:raise SystemApiError('LOCAL_API_DUPLICATE_DEVICE')
                identities.add(identity);edges.append(edge)
            page=body['pageInfo']
            if page.get('hasNextPage') is False:return {'edges':edges}
            after=page.get('endCursor')
            if page.get('hasNextPage') is not True or not isinstance(after,str) or not 1<=len(after)<=2048 or after in cursors:raise SystemApiError('LOCAL_API_INVALID_PAGE')
            cursors.add(after)
        raise SystemApiError('LOCAL_API_PAGE_LIMIT')
    def identity(self,host):
        try:
            ipaddress.IPv4Address(host)
            return identity_from_response(self.devices(),host)
        except (SystemApiError,ValueError):return None
    def diagnostics(self):
        body=self.devices();devices=[]
        for edge in body['edges']:
            node=edge['node'];hw=node.get('hardwareIdentity',{});sw=node.get('softwareIdentity',{});net=node.get('communicationProtocol',{})
            if not all(isinstance(v,dict) for v in (hw,sw,net)):raise SystemApiError('LOCAL_API_INVALID_DEVICE')
            def field(source,key):
                v=source.get(key)
                return v if isinstance(v,str) and len(v)<=128 else None
            caps=node.get('capabilities',[])
            if not isinstance(caps,list) or len(caps)>128 or any(not isinstance(c,str) or len(c)>128 for c in caps):raise SystemApiError('LOCAL_API_INVALID_CAPABILITIES')
            devices.append({'device_id':field(hw,'deviceId'),'serial':field(hw,'serialNumber'),'model':field(sw,'model'),
                'firmware':field(sw,'firmwareVersion'),'firmware_valid':sw.get('firmwareValid') is True,'ip':field(net,'address'),
                'state':field(node,'deviceState'),'compatibility':field(node,'compatibility'),'capabilities':caps})
        return devices

class SystemApiMonitor:
    def __init__(self,*,client=None,enabled=False,interval=5):
        self.client=client or SystemApiClient();self.enabled=enabled;self.interval=interval
        self.lock=threading.Lock();self.stop_event=threading.Event();self.thread=None
        self.value={'state':'waiting' if enabled else 'disabled','checked_at_ms':None,'error':None,'devices':[],'endpoint':ORIGIN+'/rest','rf_scan_supported':False}
    def refresh(self):
        try:devices=self.client.diagnostics();state='ready';error=None
        except SystemApiError as e:devices=[];state='unavailable';error=str(e)
        except Exception:devices=[];state='unavailable';error='LOCAL_API_READ_FAILED'
        if self.stop_event.is_set():return
        # Diagnostics share bounded MQTT replies with the host. Full fresh reads
        # for control identity above never use this truncated presentation list.
        count=len(devices);shown=[];size=0
        for device in devices:
            size+=len(json.dumps(device,ensure_ascii=True).encode())
            if size>16384 or len(shown)>=64:break
            shown.append(device)
        with self.lock:self.value.update(state=state,error=error,devices=shown,device_count=count,truncated=len(shown)<count,checked_at_ms=int(time.time()*1000))
    def snapshot(self):
        with self.lock:value=copy.deepcopy(self.value)
        if value['state']=='ready' and time.time()*1000-(value['checked_at_ms'] or 0)>max(15000,self.interval*3000):
            value.update(state='stale',devices=[],error='LOCAL_API_STATUS_STALE')
        return value
    def start(self):
        if not self.enabled or self.thread is not None:return
        def run():
            while not self.stop_event.is_set():
                self.refresh()
                self.stop_event.wait(self.interval)
        self.thread=threading.Thread(target=run,name='Shure-SystemAPI-status',daemon=True);self.thread.start()
    def stop(self):
        self.stop_event.set()
        if self.thread:self.thread.join(9)
