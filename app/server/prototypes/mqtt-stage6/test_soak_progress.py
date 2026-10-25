"""Real Windows sharing/atomicity regressions, no server imports or site I/O."""
import argparse
import ast
import asyncio
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent))
from soak_progress import read_progress, write_progress

OPTIONS=None
NODE_WRITE="""const {writeProgress}=require(process.argv[1]);
writeProgress(process.argv[2],{sequence:2},{retryMs:Number(process.argv[3])})
.then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.code);process.exitCode=1;});"""


@unittest.skipUnless(os.name=='nt','Windows sharing semantics required')
class SharingTests(unittest.TestCase):
    def setUp(self):
        self.folder=Path(tempfile.mkdtemp(prefix=self._testMethodName+'-',dir=OPTIONS.output))
        self.path=self.folder/'progress.json'
        write_progress(self.path,{'sequence':1})

    def child(self,budget=2000):
        return subprocess.Popen([OPTIONS.node,'-e',NODE_WRITE,str(Path(__file__).with_name('progress-json.cjs')),
            str(self.path),str(budget)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
            creationflags=subprocess.CREATE_NO_WINDOW)

    def wait_pending(self,child):
        deadline=time.monotonic()+5
        while not self.path.with_suffix('.pending').exists():
            if child.poll() is not None:self.fail(child.communicate())
            if time.monotonic()>deadline:self.fail('Child did not prepare progress')
            time.sleep(.01)

    def test_legacy_rename_fails_with_actual_python_reader(self):
        pending=self.path.with_suffix('.pending');pending.write_text('{"sequence":2}','utf-8')
        with self.path.open('r',encoding='utf-8'):
            run=subprocess.run([OPTIONS.node,'-e',"require('node:fs').renameSync(process.argv[1],process.argv[2])",str(pending),str(self.path)],
                capture_output=True,text=True,creationflags=subprocess.CREATE_NO_WINDOW,timeout=5)
            self.assertNotEqual(run.returncode,0);self.assertIn('EPERM',run.stderr)
            self.assertEqual(read_progress(self.path),{'sequence':1})
        (self.folder/'legacy-error.txt').write_text(run.stderr,'utf-8')

    def test_node_waits_for_external_reader_then_publishes(self):
        with self.path.open('r',encoding='utf-8') as held:
            child=self.child();self.wait_pending(child);time.sleep(.25)
            self.assertIsNone(child.poll());self.assertEqual(json.load(held),{'sequence':1})
            self.assertEqual(read_progress(self.path),{'sequence':1})
        out,err=child.communicate(timeout=5)
        self.assertEqual(child.returncode,0,err);self.assertGreater(json.loads(out)['replace_retries'],0)
        self.assertEqual(read_progress(self.path),{'sequence':2})

    def test_reader_releases_handle_before_parsing_the_snapshot(self):
        decode=json.loads
        def parse(raw):
            child=self.child();out,err=child.communicate(timeout=5)
            self.assertEqual(child.returncode,0,err);self.assertEqual(decode(out)['replace_retries'],0)
            return decode(raw)
        with patch('soak_progress.json.loads',side_effect=parse):
            self.assertEqual(read_progress(self.path),{'sequence':1})
        self.assertEqual(read_progress(self.path),{'sequence':2})

    def test_node_permanent_lock_is_bounded_and_retains_both_files(self):
        with self.path.open('r',encoding='utf-8'):
            began=time.monotonic();child=self.child(150);out,err=child.communicate(timeout=5)
            self.assertNotEqual(child.returncode,0);self.assertIn('EPERM',err)
            self.assertLess(time.monotonic()-began,3)
            self.assertEqual(read_progress(self.path),{'sequence':1})
            self.assertEqual(read_progress(self.path.with_suffix('.pending')),{'sequence':2})

    def test_python_writer_retries_and_retains_atomicity(self):
        results=[];errors=[]
        def publish():
            try:results.append(write_progress(self.path,{'sequence':2}))
            except Exception as error:errors.append(error)
        with self.path.open('r',encoding='utf-8'):
            worker=threading.Thread(target=publish);worker.start();time.sleep(.3)
            self.assertTrue(worker.is_alive());self.assertEqual(read_progress(self.path),{'sequence':1})
        worker.join(5);self.assertFalse(worker.is_alive());self.assertEqual(errors,[])
        self.assertGreater(results[0]['replace_retries'],0);self.assertEqual(read_progress(self.path),{'sequence':2})

    def test_python_permanent_lock_fails_without_deleting_valid_snapshot(self):
        with self.path.open('r',encoding='utf-8'):
            began=time.monotonic()
            with self.assertRaises(OSError):write_progress(self.path,{'sequence':2},retry_seconds=.15)
            self.assertLess(time.monotonic()-began,1)
            self.assertEqual(read_progress(self.path),{'sequence':1})
            self.assertEqual(read_progress(self.path.with_suffix('.pending')),{'sequence':2})

    def test_fatal_errors_and_corrupt_data_are_not_hidden(self):
        with patch('soak_progress.os.replace',side_effect=OSError(errno.ENOSPC,'disk full')) as replace:
            with self.assertRaises(OSError):write_progress(self.path,{'sequence':2})
            self.assertEqual(replace.call_count,1)
        self.assertEqual(read_progress(self.path),{'sequence':1})
        self.path.write_text('{broken','utf-8')
        with self.assertRaises(json.JSONDecodeError):read_progress(self.path)
        self.assertEqual(read_progress(self.folder/'not-created.json',missing_ok=True),{})
        with self.assertRaises(FileNotFoundError):read_progress(self.folder/'missing.json')

    def test_concurrent_node_replacements_and_python_reads(self):
        source="""const {writeProgress}=require(process.argv[1]);
(async()=>{let retries=0;for(let sequence=2;sequence<=1001;sequence++)
retries+=(await writeProgress(process.argv[2],{sequence,padding:'x'.repeat(8192)})).replace_retries;
console.log(JSON.stringify({retries}));})().catch(e=>{console.error(e);process.exitCode=1;});"""
        child=subprocess.Popen([OPTIONS.node,'-e',source,str(Path(__file__).with_name('progress-json.cjs')),str(self.path)],
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
        samples=0;last=1;deadline=time.monotonic()+120
        while child.poll() is None:
            self.assertLess(time.monotonic(),deadline)
            current=read_progress(self.path);self.assertGreaterEqual(current['sequence'],last)
            last=current['sequence'];samples+=1
            time.sleep(.002)  # 500 reads/sec, far more frequent than the 5s monitor.
        out,err=child.communicate(timeout=5);self.assertEqual(child.returncode,0,err)
        self.assertGreater(samples,100);self.assertEqual(read_progress(self.path)['sequence'],1001)
        (self.folder/'result.json').write_text(json.dumps({'reads':samples,'writes':1000,'writer':json.loads(out)}),'utf-8')

    def test_async_status_retry_does_not_block_or_outlive_teardown(self):
        # Load only the pure wrapper: importing the server harness would touch
        # runtime dependencies and is unnecessary for this cancellation test.
        tree=ast.parse(Path(__file__).with_name('soak_stage6.py').read_text('utf-8'))
        wrapper=next(node for node in tree.body if isinstance(node,ast.AsyncFunctionDef) and node.name=='progress_async')
        entered=threading.Event();release=threading.Event();states=[]
        def progress(state,**extra):
            entered.set();release.wait(3);states.append(state)
        namespace={'asyncio':asyncio,'progress':progress}
        exec(compile(ast.Module(body=[wrapper],type_ignores=[]),'<status-wrapper>','exec'),namespace)
        async def verify():
            task=asyncio.create_task(namespace['progress_async']('running'))
            await asyncio.to_thread(entered.wait,2)
            task.cancel();await asyncio.sleep(.03)
            self.assertFalse(task.done());self.assertEqual(states,[])
            release.set()
            with self.assertRaises(asyncio.CancelledError):await task
            states.append('validating');self.assertEqual(states,['running','validating'])
        asyncio.run(verify())


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);parser.add_argument('--output',required=True)
    OPTIONS=parser.parse_args();Path(OPTIONS.output).mkdir(parents=True,exist_ok=False)
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(SharingTests))
    (Path(OPTIONS.output)/'result.json').write_text(json.dumps({'ok':result.wasSuccessful(),'tests':result.testsRun,
        'failures':len(result.failures),'errors':len(result.errors)}),'utf-8')
    sys.exit(not result.wasSuccessful())
