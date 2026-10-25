"""Retained, fixed-release 24h rehearsal. Loopback identities, never site devices.

Runs the same explicit-resource engine as the restartable launcher. The shared
100CH fixture performs stream hashes, persistence drain and SQLite integrity.
Only its browser workload clock counts; setup and validation do not count.
"""
import argparse
import asyncio
from contextlib import closing
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time
from types import SimpleNamespace
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parent))
if '--paho-root' in sys.argv:sys.path.insert(0,sys.argv[sys.argv.index('--paho-root')+1])
import test_stage6 as tests
from m6_runtime import Runtime
from m6_scope import RuntimeScope
from build_candidate import build,ROOT
from tls_support import load_config
from soak_progress import read_progress, write_progress
import unified_bootstrap
import unified_database as db

ARGS=None


def verify_release():
    manifest=Path(ARGS.release_manifest).resolve()
    contents=json.loads(manifest.read_text('utf-8'))
    for name,expected in contents['files'].items():
        path=(manifest.parent/name).resolve()
        if not path.is_relative_to(manifest.parent) or not path.is_file():raise ValueError('Fixed release file missing')
        if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:raise ValueError('Fixed release changed: '+name)
    return hashlib.sha256(manifest.read_bytes()).hexdigest()


def progress(state,**extra):
    write_progress(Path(ARGS.output)/'soak-status.json',{'state':state,'at_utc':datetime.now(timezone.utc).isoformat(),
        'pid':os.getpid(),'duration_seconds':ARGS.duration_seconds,'actual_24_hours':ARGS.duration_seconds==86400,
        'release_manifest_sha256':ARGS.release_sha,'production_switched':False,'remote_copies_updated':False,**extra})


async def progress_async(state,**extra):
    # Retry sleeps belong in a worker, not the MQTT/Bridge event loop. Finish an
    # in-flight publish before teardown writes validating/final status.
    task=asyncio.create_task(asyncio.to_thread(progress,state,**extra))
    try:await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


class Soak(tests.Integration):
    async def asyncSetUp(self):
        asyncio.get_running_loop().set_debug(False)
        root=Path(ARGS.runtime).resolve()
        forbidden=(ROOT,ROOT.parent/'FAshe',Path(os.environ.get('ProgramData','C:/ProgramData'))/'DATY RF PRO')
        if any(root.is_relative_to(p.resolve()) for p in forbidden):raise ValueError('Soak directory must be isolated')
        root.mkdir(parents=True,exist_ok=False)
        if shutil.disk_usage(root).free<ARGS.minimum_free_gib*1024**3:raise ValueError('Insufficient reserved soak disk space')
        self.temp=SimpleNamespace(name=str(root))  # Retain all evidence, including failures.
        prepared=Runtime(root,ARGS.broker);prepared.prepare_fixture()
        self.fixture,self.tls=prepared.fixture,prepared.tls
        with closing(unified_bootstrap.open_database(root/'business.sqlite3')) as connection:
            unified_bootstrap.initialize(connection,int(time.time()*1000));connection.commit()
            unified_bootstrap.enable_wal(connection);connection.execute('PRAGMA synchronous=FULL')
            self.epoch=db.status(connection)['epoch']
        public=build(root/'public')
        settings={'schema':'daty-mqtt6-runtime-v1','database':str(root/'business.sqlite3'),'database_epoch':self.epoch,
            'archives':str(root/'archives'),'staging':str(root/'staging'),'runtime_directory':str(root/'runtime'),
            'pairing':str(self.fixture.path),'tls':str(self.tls),'ca_sha256':load_config(self.tls)[1]['ca_sha256'],
            'bind_host':'127.0.0.1','mqtt_port':0,'web_port':0,'public_directory':str(public)}
        config=root/'runtime-config.json';config.write_text(json.dumps(settings),'utf-8')
        for n in range(1,7):(root/f'.daty-mqtt-stage{n}-fixture').unlink()
        scope=RuntimeScope(config);self.addCleanup(scope.close)
        self.runtime=Runtime(scope.runtime_directory,ARGS.broker,runtime_scope=scope)
        self.addAsyncCleanup(self.runtime.close);await self.runtime.start()
        self.b=self.runtime.b;self.rx_uri=self.runtime.uri+'/mqtt'
        self.uris={m:self.runtime.uri+'/mqtt-'+m for m in ('app','enrollment')}
        self.receivers=[];self.uis=[];self.ui=await self.new_ui()
        self.addAsyncCleanup(self.close_peers)
        self.monitor=asyncio.create_task(self.observe())
        self.monitor.add_done_callback(self.monitor_finished)
        self.addAsyncCleanup(self.stop_monitor)

    def monitor_finished(self,task):
        if not task.cancelled() and task.exception() is not None:
            try:
                progress('failed',reason='MONITOR_FAILED',error_type=type(task.exception()).__name__)
            finally:
                # Even a permanently locked status file must fail-stop the job.
                print('MONITOR_FAILED: '+repr(task.exception()),file=sys.stderr,flush=True)
                os._exit(4)

    async def stop_monitor(self):
        if hasattr(self,'monitor'):
            self.monitor.cancel();results=await asyncio.gather(self.monitor,return_exceptions=True)
            for result in results:
                if isinstance(result,Exception):raise result

    async def observe(self):
        seen_browser=False
        while True:
            browser=Path(ARGS.output)/'browser-soak-progress.json'
            state=await asyncio.to_thread(read_progress,browser,missing_ok=not seen_browser)
            seen_browser=seen_browser or bool(state.get('started_utc'))
            free=shutil.disk_usage(ARGS.runtime).free
            metrics={'persistence':self.b.get_unified_runtime_status(),'dispatch':self.b._mqtt_dispatch_status(),
                'feed':self.runtime.feed.status(),'bus':dict(self.runtime.bus.metrics),'free_bytes':free,
                'readonly':dict(self.runtime.view.metrics),'data_error_responses':dict(self.runtime.data.error_response_metrics)}
            reason=None
            if free<64*1024**3:reason='DISK_RESERVE_EXHAUSTED'
            if self.runtime.process.poll() is not None:reason='BROKER_EXITED'
            # No dispatch queue exists until the first receiver packet.
            if metrics['dispatch'].get('refused',0) or metrics['persistence']['refused'] or metrics['persistence']['failed']:reason='DATA_NOT_ACCEPTED_OR_COMMITTED'
            if reason:
                await progress_async('failed',reason=reason,browser=state,metrics=metrics)
                # Fail-stop this isolated tree before filling the disk. The
                # Windows job kills only descendants; WAL/evidence are retained.
                os._exit(3)
            await progress_async('running' if state.get('started_utc') else 'starting',browser=state,metrics=metrics)
            await asyncio.sleep(5)

    async def asyncTearDown(self):
        await self.stop_monitor()
        await progress_async('validating',soak_started=(Path(ARGS.output)/'browser-soak-progress.json').exists())
        await super().asyncTearDown()


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    for name in ('broker','paho-root','output','runtime','browser','playwright','release-manifest'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--smoke-seconds',type=int)
    parser.add_argument('--minimum-free-gib',type=int,default=750)
    ARGS=parser.parse_args();ARGS.duration_seconds=ARGS.smoke_seconds or 86400
    if ARGS.smoke_seconds is not None and not 60<=ARGS.smoke_seconds<=3600:raise ValueError('Smoke duration must be 60..3600 seconds')
    Path(ARGS.output).mkdir(parents=True,exist_ok=False)
    ARGS.release_sha=verify_release();progress('preparing')
    node=Path(ARGS.release_manifest).resolve().parent/'tools/node'
    os.environ['PATH']=str(node)+os.pathsep+os.environ.get('PATH','')
    os.environ['DATY_M6_SOAK']='pilot' if ARGS.smoke_seconds else '24h'
    tests.OPTIONS=SimpleNamespace(broker=ARGS.broker,output=ARGS.output,browser=ARGS.browser,playwright=ARGS.playwright,
        load_seconds=ARGS.duration_seconds,measure=False,mixed_archive=True)
    suite=unittest.TestSuite([Soak('test_two_original_fashe_windows_100ch')])
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    verify_release()
    progress('passed' if result.wasSuccessful() else 'failed',tests=result.testsRun,failures=len(result.failures),errors=len(result.errors),
        evidence=tests.EVIDENCE,soak_started=(Path(ARGS.output)/'browser-soak-progress.json').exists())
    sys.exit(not result.wasSuccessful())
