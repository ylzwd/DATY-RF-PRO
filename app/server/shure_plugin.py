"""Package-owned entrypoints; constructed only after durable trusted import."""
import shure_active_discovery as discovery_module
from shure_active_discovery import ShureDiscovery,probe_shure_sync
from shure_legacy import legacy_probe,validate_legacy_identity
from shure_legacy_control import attach_legacy_control
from shure_metering import ShureMeterSession
from m6_shure_control import ShureControlRouter

class ShurePluginDiscovery(ShureDiscovery):
    def __init__(self,on_update,*,live=False,**kwargs):
        super().__init__(on_update,**kwargs)
        if live:
            def probe(host,**options):
                return probe_shure_sync(host,**options) or legacy_probe(discovery_module,host,stop=options.get('stop'))
            self.probe=probe
        # This factory belongs to one isolated package namespace, never the host.
        def meter(receiver,callback):
            return ShureMeterSession(receiver,callback,identity_check=validate_legacy_identity) if receiver.get('settings',{}).get('legacy_scp') else ShureMeterSession(receiver,callback)
        discovery_module.ShureMeterSession=meter
    def snapshot(self):
        return {**super().snapshot(),'connection_mode':'direct-scp','systemapi_required':False}

class ShurePluginControl(ShureControlRouter):
    def __init__(self,bus):
        super().__init__(bus);attach_legacy_control(self)
