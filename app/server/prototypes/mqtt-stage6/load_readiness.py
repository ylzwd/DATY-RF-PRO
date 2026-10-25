"""Test-only gate: archive work begins during an observed 100CH workload."""
import asyncio
from datetime import datetime,timezone
import time
from soak_progress import read_progress


def active_load(state, minimum_seconds=30):
    if not state.get('started_utc') or state.get('elapsed_seconds',0)<minimum_seconds:return False
    updated=datetime.fromisoformat(state['updated_utc'].replace('Z','+00:00'))
    if not 0<=(datetime.now(timezone.utc)-updated).total_seconds()<5:return False
    receivers=state.get('receivers',[])
    return (len(receivers)==2 and all(r.get('connected') and r.get('powered') and r.get('channels')==50 for r in receivers))


async def wait_active_load(path, completed, minimum_seconds=30, timeout=120):
    deadline=time.monotonic()+timeout
    while True:
        if completed.is_set():raise RuntimeError('Browser ended before concurrent archive workload')
        state=await asyncio.to_thread(read_progress,path,missing_ok=True)
        if active_load(state,minimum_seconds):return state
        if time.monotonic()>=deadline:raise TimeoutError('Observed 100CH workload did not become ready')
        await asyncio.sleep(.1)
