"""Original server NIC query behind a transport-neutral callable; no listener."""
import importlib.util
from pathlib import Path
import platform
import socket
import time

class NetworkStatus:
    def __init__(self):
        spec=importlib.util.spec_from_file_location('mqtt6_network_source',Path(__file__).resolve().parents[2]/'ip-service.py')
        self.source=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.source)

    def __call__(self):
        ips=self.source.get_local_ips()
        return {'success':True,'ip':self.source.best_ip(ips),'all_ips':ips,
                'hostname':socket.gethostname(),'platform':platform.system(),
                'ts':int(time.time()),'source':'server-network-interfaces'}
