"""Imported brand adapters share the original host identity, journal and feed."""
import base64,copy,hashlib,ipaddress,re,threading,time
from plugin_install import PluginError,SourceNamespace
from command_journal import CommandError
from m6_groups import RuntimeGroupPolicy,RuntimeEnrollment
from receiver_pairing import PairingError,normalize_brand
from receiver_enrollment import EnrollmentError
from shure_fields import METER_FIELDS
from plugin_discovery import AutoDiscovery
from plugin_removal import ExportRemoval
from plugin_scan import PluginScans

def materialize_shure_report(receiver, discovery):
    """Decode unchanged metadata in an installed adapter's sparse REP callback.

    A new field timestamp means that field was actually reported again. The
    legacy package omits its value when unchanged; only that omission may use
    the same chassis/channel's adapter cache. SAMPLE is never a metadata read,
    and expired values never gain a new timestamp from host reconstruction.
    """
    if not receiver.get('observation_received', True):return receiver
    with discovery.lock:
        cached=getattr(discovery,'receivers',{}).get(receiver.get('receiver_ip'))
        if not cached or any(cached.get(k)!=receiver.get(k) for k in ('receiver_id','receiver_ip','model')):return receiver
        mac=receiver.get('settings',{}).get('receiver_mac')
        legacy=receiver.get('settings',{}).get('legacy_scp') is True
        if legacy and receiver['settings'].get('identity_source')=='direct-scp':
            if (not mac or mac!=cached.get('settings',{}).get('receiver_mac')
                or cached.get('settings',{}).get('identity_source')!='direct-scp'
                or receiver.get('version')!=cached.get('version')):return receiver
        elif legacy:
            if any(not receiver['settings'].get(k) or receiver['settings'].get(k)!=cached.get('settings',{}).get(k)
                   for k in ('systemapi_device_id','receiver_serial')):return receiver
            if mac!=cached.get('settings',{}).get('receiver_mac'):return receiver
        elif not mac or cached.get('settings',{}).get('receiver_mac')!=mac:return receiver
        result=copy.deepcopy(receiver)
        for channel,patch in result.get('channels',{}).items():
            old=cached.get('channels',{}).get(channel,{})
            if old.get('channel_number')!=patch.get('channel_number'):continue
            for key,stamp in patch.get('field_times',{}).items():
                prior=old.get('field_times',{}).get(key)
                if (key in patch or key not in old or key in METER_FIELDS or key.startswith('meter_')
                    or key in patch.get('stale_fields',[]) or type(stamp) is not int
                    or type(prior) is not int or prior<=0 or stamp<prior):continue
                patch[key]=copy.deepcopy(old[key])
        return result

class BuiltinMQTTPolicy(RuntimeGroupPolicy):
    def authenticate(self,*args,**kwargs):
        principal=super().authenticate(*args,**kwargs)
        if normalize_brand(principal.get('brand'))!='DATYaudio':raise PairingError('EXTERNAL_BRAND_REQUIRES_PLUGIN_TRANSPORT')
        return principal

class BuiltinEnrollment(RuntimeEnrollment):
    def challenge(self,body,peer):
        try:brand=normalize_brand(body.get('brand'))
        except PairingError:brand=None
        if brand!='DATYaudio':raise EnrollmentError(403,'EXTERNAL_BRAND_REQUIRES_PLUGIN_TRANSPORT','该品牌须通过已导入插件接入')
        return super().challenge(body,peer)

class PluginDiscoveryProxy:
    def __init__(self):self._lock=threading.RLock();self._stop_event=threading.Event();self.target=None
    @property
    def lock(self):return self.target.lock if self.target else self._lock
    @property
    def stop_event(self):return self.target.stop_event if self.target else self._stop_event
    @property
    def enabled(self):return self.target.enabled if self.target else False
    def snapshot(self):
        with self.lock:
            if self.target:return self.target.snapshot()
            return {'protocol':'daty-shure-discovery-v1','enabled':False,'scanning':False,'generation':0,'receivers':[],
                'count':0,'progress':0,'targets':0,'scanned':0,'scopes':[],'error':None,'started_at':None,'completed_at':None,'cancelled':False,'plugin_state':'not_installed'}
    def request_scan(self):
        if not self.target:raise PluginError('BRAND_PLUGIN_NOT_INSTALLED',409)
        return self.target.request_scan()
    def cancel_scan(self):
        if not self.target:raise PluginError('BRAND_PLUGIN_NOT_INSTALLED',409)
        return self.target.cancel_scan()
    def stop(self):
        if self.target:self.target.stop()

class PluginRouter:
    def __init__(self,manager,bus):self.manager,self.bus,self.b=manager,bus,bus.b
    @property
    def service(self):return self.bus.service
    @service.setter
    def service(self,value):
        self.bus.service=value
        for item in list(self.manager.active.values()):item['control'].service=value
    def owner(self,did):
        with self.b._state_lock:device=copy.deepcopy(self.b._state['devices'].get(did,{}))
        brand=self.b._normalize_device_brand(device.get('brand'))
        if brand=='DATYaudio':return self.bus
        for item in list(self.manager.active.values()):
            if self.b._normalize_device_brand(item['release']['brand'])==brand and device.get('_source') in item['release']['adapterKeys']:return item['control']
        raise CommandError('BRAND_PLUGIN_NOT_INSTALLED')
    def binding(self,did):return self.owner(did).binding(did)
    def validate(self,target,command):return self.owner(target['device_id']).validate(target,command)
    async def send(self,record,*,allowed):
        adapter=self.owner(record['target']['device_id'])
        with self.manager.lifecycle_lock:
            identity=next((i for i,p in list(self.manager.active.items()) if p['control'] is adapter),None)
            if identity in self.manager.removal.draining:raise CommandError('PLUGIN_REMOVAL_PENDING')
            if identity:self.manager.sending[identity]=self.manager.sending.get(identity,0)+1
        try:return await adapter.send(record,allowed=lambda:allowed() and self.owner(record['target']['device_id']) is adapter)
        finally:
            if identity:
                with self.manager.lifecycle_lock:self.manager.sending[identity]-=1
    def targets(self):
        targets={}
        for adapter in (self.bus,*(item['control'] for item in self.manager.active.values())):
            for row in adapter.targets():
                try:self.owner(row['target']['device_id'])
                except CommandError:continue
                targets[row['target']['device_id']]=row
        return sorted(targets.values(),key=lambda r:(r.get('group_number') or float('inf'),r['target']['channel_number']))

class PluginManager:
    def __init__(self,store,bridge,bus,discovery,known_path,*,live=False,data_service=None,discovery_allowed=lambda:True):
        self.store,self.b,self.bus,self.discovery,self.known_path,self.live=store,bridge,bus,discovery,known_path,live
        self.active={};self.errors={};self.closed=False
        self.lifecycle_lock=threading.RLock();self.sending={};self.removal=ExportRemoval(self)
        self.scans=PluginScans(self,data_service)
        self.auto_discovery=AutoDiscovery(self,data_service,allowed=discovery_allowed) if data_service is not None else None
        self.original_shure=bridge._accept_shure_observation
        bridge._accept_shure_observation=lambda raw:self.accept('shure-scp',raw)
        self.original_caps=bridge._device_capabilities
        bridge._device_capabilities=self.capabilities
    def capabilities(self,device,raw=None):
        brand=self.b._normalize_device_brand(device.get('brand'))
        if brand=='DATYaudio':return self.original_caps(device,raw)
        for item in list(self.active.values()):
            if self.b._normalize_device_brand(item['release']['brand'])==brand and (raw or device).get('_source') in item['release']['adapterKeys']:
                if item['release']['observation_format'] in ('shure-v1','shure-v2'):
                    caps=self.original_caps(device,raw)
                    settings=(raw or device).get('shure',{}).get('settings',{})
                    if settings.get('legacy_scp') and not settings.get('legacy_control_identity'):
                        caps.update(read_only=True,mute=False,write_frequency=False)
                    caps.update(self.scans.capability(item,device))
                    return caps
                return copy.deepcopy(item['release']['capabilities'])
        return {'adapter':'not-installed','read_only':True,'discover':False,'read_rf':False,'read_af':False,'read_frequency':False,'mute':False,'write_frequency':False}
    def accept(self,identity,raw,source=None):
        with self.lifecycle_lock:
            if self.closed or identity not in self.active:return False
            item=self.active[identity]
            if source is not None and item['source_token'] is not source:return False
            if item['release']['observation_format'] in ('shure-v1','shure-v2'):self.original_shure(materialize_shure_report(raw,item['discovery']))
            else:self.accept_canonical(item['release'],raw)
            return True
    def accept_canonical(self,release,receiver):
        # A future package normalizes its proprietary protocol to this host DTO.
        if not isinstance(receiver,dict):raise PluginError('INVALID_PLUGIN_OBSERVATION')
        rid=receiver.get('receiver_id');model=receiver.get('model');ip=receiver.get('receiver_ip');channels=receiver.get('channels')
        if (not isinstance(rid,str) or not re.fullmatch('[A-Za-z0-9_.:-]{1,80}',rid)
            or not isinstance(model,str) or not 1<=len(model)<=128
            or not isinstance(channels,dict) or not 1<=len(channels)<=128):raise PluginError('INVALID_PLUGIN_OBSERVATION')
        try:ip=str(ipaddress.ip_address(ip))
        except (ValueError,TypeError):raise PluginError('INVALID_PLUGIN_IP')
        namespace='plugin:'+release['id']+':'+rid
        seen=set();updates=[]
        for ch,item in channels.items():
            if not isinstance(item,dict) or type(item.get('channel_number')) is not int or not 1<=item['channel_number']<=128 or item['channel_number'] in seen:raise PluginError('INVALID_PLUGIN_CHANNEL')
            seen.add(item['channel_number'])
            if item.get('frequency_khz') is not None and type(item['frequency_khz']) is not int:raise PluginError('INVALID_PLUGIN_FREQUENCY')
            if 'name' in item and (not isinstance(item['name'],str) or len(item['name'])>256):raise PluginError('INVALID_PLUGIN_NAME')
            for key,limits in {'frequency_khz':(1,10000000),'rf_dbm':(-150,20),'audio_dbfs':(-150,0),'battery_percent':(0,100)}.items():
                value=item.get(key)
                if value is not None and (type(value) not in (int,float) or not limits[0]<=value<=limits[1]):raise PluginError('INVALID_PLUGIN_TELEMETRY')
            if item.get('muted') is not None and type(item['muted']) is not bool:raise PluginError('INVALID_PLUGIN_MUTE')
        group=self.b._pairing_policy.ensure_adapter_group(release['id'],namespace)
        with self.b._state_lock:
            for item in channels.values():
                ch=item['channel_number'];did=namespace+'_ch'+str(ch);previous=self.b._state['devices'].get(did)
                device=dict(previous or {'name':model+' CH'+str(ch),'freq':None,'rf':None,'af':None,'af_dbfs':None,'batt':None,'muted':None},id=did,brand=release['brand'],model=model,receiver_id=namespace,_receiver_id=namespace,
                    receiver_ip=ip,ip=ip,receiver_mac=receiver.get('receiver_mac'),channel_number=ch,channel=ch,ch='CH'+str(ch),
                    _source=release['adapterKeys'][0],_last_seen=time.time(),status='online',group=group,group_number=group,group_source='server-fifo-v1')
                for source,target in {'frequency_khz':'freq','rf_dbm':'rf','audio_dbfs':'af_dbfs','battery_percent':'batt','muted':'muted','name':'name'}.items():
                    if source in item:device[target]=item[source]
                if 'audio_dbfs' in item:device['af']=item['audio_dbfs']
                self.b._state['devices'][did]=device;updates.append((did,previous,dict(device)))
        for did,previous,device in updates:self.b._record_device_state(did,previous,device)
        if updates:self.b._push_sse_event('device_update',self.b._get_devices_snapshot([d[0] for d in updates]))
    def activate(self,item,root):
        release=item['release'];identity=release['id']
        if self.closed:raise PluginError('PLUGIN_HOST_CLOSED')
        if identity in self.active:
            if self.active[identity]['sha256']!=item['sha256']:raise PluginError('PLUGIN_ALREADY_ACTIVE')
            return
        if any(self.b._normalize_device_brand(p['release']['brand'])==self.b._normalize_device_brand(release['brand']) or set(p['release']['adapterKeys'])&set(release['adapterKeys']) for p in self.active.values()):raise PluginError('BRAND_ALREADY_OWNED')
        namespace=SourceNamespace(root,item);discovery=None;old_functions={};source_token=object()
        try:
            discovery_class=namespace.entry(release['entrypoints']['discovery'])
            control_class=namespace.entry(release['entrypoints']['control'])
            if release['observation_format'] in ('shure-v1','shure-v2'):
                # Runtime chassis-label configuration stays on the host, never in the package.
                import shure_hardware
                namespace.load('shure_hardware.py').hardware_registry=shure_hardware.hardware_registry
                if release['observation_format']=='shure-v1':namespace.load('shure_hardware.py').band_identity=shure_hardware.band_identity
            kwargs={'auto_scan':False,'known_path':self.known_path if identity=='shure-scp' else self.known_path.parent/(identity+'-known.json')}
            if not self.live:kwargs.update(interfaces=lambda:[],probe=lambda *a,**k:None)
            if release['observation_format']=='shure-v2':kwargs['live']=self.live
            discovery=discovery_class(lambda raw:self.accept(identity,raw,source_token),**kwargs)
            if release['observation_format']=='shure-v1':
                from shure_legacy import attach_legacy_support
                attach_legacy_support(namespace,discovery,live=self.live)
            control=control_class(self.bus);control.service=self.bus.service
            if release['observation_format']=='shure-v1':
                from shure_legacy_control import attach_legacy_control
                attach_legacy_control(control)
            scan_files=namespace.entry(release['entrypoints']['scan_files'])() if 'scan_files' in release['entrypoints'] else None
            scan_live=namespace.entry(release['entrypoints']['scan_live']) if 'scan_live' in release['entrypoints'] else None
            if release['observation_format'] in ('shure-v1','shure-v2'):
                for attr,path,fn in (('shure_telemetry_view','shure_protocol.py','telemetry_view'),('shure_capabilities','shure_hardware.py','capabilities'),('shure_control_readiness','shure_control_contract.py','control_readiness')):
                    old_functions[attr]=getattr(self.b,attr);setattr(self.b,attr,getattr(namespace.load(path),fn))
            self.active[identity]={'release':release,'sha256':item['sha256'],'discovery':discovery,'control':control,'namespace':namespace,'scan_files':scan_files,'scan_live':scan_live,'source_token':source_token,'old_functions':old_functions}
            if identity=='shure-scp':self.discovery.target=discovery;self.b._shure_discovery=discovery
            discovery.start()
            self.errors.pop(identity,None)
        except BaseException:
            for attr,fn in old_functions.items():setattr(self.b,attr,fn)
            self.active.pop(identity,None)
            if identity=='shure-scp':self.discovery.target=None;self.b._shure_discovery=self.discovery
            if discovery:discovery.stop()
            namespace.close();raise
    def read_scan_file(self, identity, encoded, digest, *, allowed):
        # Reads supplied bytes only. Brand code stays in the installed package;
        # no server path, URL, device scan or persistent scan-resource creation.
        if not isinstance(identity,str):raise PluginError('INVALID_PLUGIN_ID')
        item=self.active.get(identity)
        if self.closed or item is None:raise PluginError('BRAND_PLUGIN_NOT_INSTALLED',409)
        if identity in self.removal.draining:raise PluginError('PLUGIN_REMOVAL_PENDING',409)
        adapter=item.get('scan_files')
        if adapter is None:raise PluginError('SCAN_FILE_ADAPTER_NOT_INSTALLED',409)
        if not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):raise PluginError('INVALID_SCAN_DIGEST')
        if not isinstance(encoded,str) or len(encoded)>((128*1024+2)//3)*4:raise PluginError('SCAN_FILE_TOO_LARGE',413)
        try:raw=base64.b64decode(encoded,validate=True)
        except ValueError:raise PluginError('INVALID_SCAN_BASE64')
        if not 1<=len(raw)<=128*1024:raise PluginError('SCAN_FILE_TOO_LARGE',413)
        if hashlib.sha256(raw).hexdigest()!=digest:raise PluginError('SCAN_FILE_CHANGED',409)
        def cancelled():
            return (self.closed or self.active.get(identity) is not item
                    or identity in self.removal.draining or not allowed())
        if cancelled():raise PluginError('SCAN_READ_CANCELLED',409)
        result=adapter.read(raw,cancelled=cancelled)
        if cancelled():raise PluginError('SCAN_READ_CANCELLED',409)
        return {**result,'plugin':{'id':identity,'version':item['release']['version'],'sha256':item['sha256']}}

    def deactivate(self,identity):
        with self.lifecycle_lock:
            item=self.removal.retiring.get(identity)
            if item is None:
                item=self.active.pop(identity,None)
                if item:self.removal.retiring[identity]=item
            if identity=='shure-scp':self.discovery.target=None;self.b._shure_discovery=self.discovery
        if item:
            self.scans.close(identity)
            item['discovery'].stop()
            # Discovery implementations may signal stop without joining their main loop.
            thread=getattr(item['discovery'],'thread',None)
            if thread and thread is not threading.current_thread():
                thread.join(2)
                if thread.is_alive():raise PluginError('PLUGIN_STOP_PENDING',409)
            with self.b._state_lock:
                for attr,fn in item.get('old_functions',{}).items():setattr(self.b,attr,fn)
            item['namespace'].close()
        release=item['release'] if item else next((r for r in self.store.catalog.releases.values() if r['id']==identity),None)
        if release:
            with self.b._state_lock:
                remove=[did for did,d in self.b._state['devices'].items() if d.get('_source') in release['adapterKeys'] and self.b._normalize_device_brand(d.get('brand'))==self.b._normalize_device_brand(release['brand'])]
                for did in remove:self.b._state['devices'].pop(did,None)
            if remove:self.b._push_sse_event('device_list',self.b._get_devices_snapshot())
        self.removal.retiring.pop(identity,None)

    def start(self):
        self.scans.refresh_profiles()
        self.removal.draining.update(r['id'] for r in self.store.status()['plugins'] if r['state'] in ('remove_requested','removing'))
        for record in self.store.status()['plugins']:
            if record['state'] not in ('installed','remove_requested'):continue
            try:
                item,root=self.store.load_record(record);self.activate(item,root)
                self.store.reconcile(record['id'],record['sha256'])
            except Exception as error:
                self.errors[record['id']]=type(error).__name__
                self.store.reconcile(record['id'],record['sha256'],type(error).__name__)
        self.removal.start()
        if self.live and self.auto_discovery:self.auto_discovery.start()
    def status(self):
        self.scans.refresh_profiles()
        result=self.store.status()
        result['builtin']=[{'id':'fashe-mqtt','name':'DATYaudio MQTT','brand':'DATYaudio','state':'builtin','active':True}]
        for item in result['plugins']:
            item['active']=item['id'] in self.active
            item['activation']='active' if item['active'] else 'failed' if item['id'] in self.errors or item['state']=='failed' else 'inactive'
            item['error']=self.errors.get(item['id']) or item['error']
            active=self.active.get(item['id'])
            snapshot=getattr(active['discovery'],'snapshot',None) if active else None
            if callable(snapshot):
                health=snapshot().get('health')
                if health is not None:item['health']=health
            scheduler=self.auto_discovery
            item['automatic_discovery']={'enabled':bool(self.live and item['active'] and scheduler
                and self.active[item['id']]['release']['capabilities'].get('discover')),
                'interval_seconds':scheduler.interval if scheduler else None,
                'error':scheduler.errors.get(item['id']) if scheduler else None}
        return result
    def filter_capabilities(self,body):
        body=copy.deepcopy(body);adapters=body['adapters'];out={'fashe-mqtt':adapters['fashe-mqtt']}
        for item in list(self.active.values()):
            for key in item['release']['adapterKeys']:out[key]={**adapters.get(key,copy.deepcopy(item['release']['capabilities'])),'brand':item['release']['brand'],'plugin_id':item['release']['id'],'version':item['release']['version'],'read_scan_file':item.get('scan_files') is not None,'scan':item.get('scan_live') is not None,'scan_readiness':'probe-required' if item.get('scan_live') else 'unavailable'}
        body['adapters']=out;body['brand_plugins']=self.status();return body
    def stop(self):
        self.removal.stop()
        self.scans.close()
        self.closed=True
        if self.auto_discovery:self.auto_discovery.stop()
        for item in list(self.active.values()):item['discovery'].stop();item['namespace'].close()
        self.active.clear();self.discovery.target=None;self.b._shure_discovery=self.discovery
