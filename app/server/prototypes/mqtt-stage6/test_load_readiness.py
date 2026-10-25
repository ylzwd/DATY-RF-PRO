import asyncio,json
from datetime import datetime,timezone,timedelta
from pathlib import Path
import sys,tempfile,unittest

sys.path.insert(0,str(Path(__file__).resolve().parent))
from load_readiness import active_load,wait_active_load

def state(elapsed=31):
    now=datetime.now(timezone.utc).isoformat()
    return dict(started_utc=now,updated_utc=now,elapsed_seconds=elapsed,
                receivers=[dict(connected=True,powered=True,channels=50) for _ in range(2)])

class Readiness(unittest.IsolatedAsyncioTestCase):
    def test_requires_fresh_two_receiver_workload_and_sampling_time(self):
        self.assertTrue(active_load(state()))
        self.assertFalse(active_load(state(29)))
        value=state();value['receivers'][1]['channels']=0;self.assertFalse(active_load(value))
        value=state();value['receivers'][1]['connected']=False;self.assertFalse(active_load(value))
        value=state();value['updated_utc']=(datetime.now(timezone.utc)-timedelta(seconds=10)).isoformat()
        self.assertFalse(active_load(value))

    async def test_delayed_browser_start_does_not_start_archive_early(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'progress.json';done=asyncio.Event()
            task=asyncio.create_task(wait_active_load(path,done,timeout=2))
            await asyncio.sleep(.15);self.assertFalse(task.done())
            path.write_text(json.dumps(state(5)),'utf-8')
            await asyncio.sleep(.15);self.assertFalse(task.done())
            path.write_text(json.dumps(state(31)),'utf-8')
            self.assertEqual((await task)['elapsed_seconds'],31)

    async def test_browser_failure_stops_gate_without_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            done=asyncio.Event();done.set()
            with self.assertRaisesRegex(RuntimeError,'Browser ended'):
                await wait_active_load(Path(directory)/'missing.json',done)

    async def test_missing_progress_times_out_instead_of_passing(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(TimeoutError):
                await wait_active_load(Path(directory)/'missing.json',asyncio.Event(),timeout=.1)

if __name__=='__main__':unittest.main()
