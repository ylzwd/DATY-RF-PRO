"""Explicit-config server launcher. Never provisions or replaces identities.

No Windows task installation, forced restart, automatic command replay or
fixture switch. A stop request must contain this boot_id. Status is local-only.
"""
import argparse
import asyncio
from datetime import datetime,timezone
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parent))
if '--paho-root' in sys.argv:sys.path.insert(0,sys.argv[sys.argv.index('--paho-root')+1])
from m6_runtime import Runtime
from m6_scope import RuntimeScope
from m6_status import RuntimeStatus


async def run(args):
    scope=RuntimeScope(args.config)
    runtime=Runtime(scope.runtime_directory,args.broker,runtime_scope=scope)
    status_path=scope.runtime_directory/'runtime-status.json'
    reporter=RuntimeStatus(status_path)
    started=time.monotonic();error=None
    def status(state):
        return {'schema':'daty-mqtt6-runtime-status-v1','state':state,'pid':os.getpid(),
            'boot_id':runtime.boot_id,'at_utc':datetime.now(timezone.utc).isoformat(),
            'uptime_seconds':round(time.monotonic()-started,3),
            'mqtt_port':getattr(runtime,'port',None),'web_port':runtime.static.server.server_port if hasattr(runtime,'static') else None,
            'database_epoch':scope.epoch,'error':error}
    try:
        await runtime.start()
        while True:
            if runtime.transport.task.done():raise RuntimeError('TRANSPORT_SUPERVISOR_STOPPED')
            for task in runtime.lifecycle:
                if task.done():raise RuntimeError('RUNTIME_SERVICE_STOPPED')
            transport=runtime.transport.snapshot()
            snapshot=status('running' if transport['ready'] else 'degraded')
            snapshot['transport']=transport
            snapshot.update(persistence=runtime.b.get_unified_runtime_status(),dispatch=runtime.b._mqtt_dispatch_status(),
                bus=dict(runtime.bus.metrics),feed=runtime.feed.status(),readonly=runtime.view.metrics)
            await reporter.publish(snapshot)
            request=scope.runtime_directory/'stop.request.json'
            if request.is_file():
                value=json.loads(request.read_text('utf-8'))
                if value=={'boot_id':runtime.boot_id}:break
            await asyncio.sleep(5)
    except BaseException as failure:
        error=type(failure).__name__  # No credentials/unknown exception payload in status.
        raise
    finally:
        try:await runtime.close()
        finally:
            try:await reporter.publish(status('failed' if error else 'stopped'))
            finally:scope.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description='DATY RF PRO MQTT runtime using validated existing resources')
    parser.add_argument('--config',required=True);parser.add_argument('--broker',required=True)
    parser.add_argument('--paho-root',required=True)
    args=parser.parse_args()
    asyncio.run(run(args))
