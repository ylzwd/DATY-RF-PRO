"""Idle/wakeup races use barriers; slow cleanup also checked over real RPC elsewhere."""
import threading,time,unittest
from types import SimpleNamespace
from plugin_removal import ExportRemoval

class Scheduling(unittest.TestCase):
    def worker(self,step):
        store=SimpleNamespace(status=lambda:{'plugins':[]})
        worker=ExportRemoval(SimpleNamespace(store=store,errors={}))
        worker.step=step;self.addCleanup(worker.stop);worker.start();return worker

    def test_idle_has_no_periodic_registry_poll_and_stop_wakes(self):
        called=threading.Event();count=[]
        def step():count.append(1);called.set();return False
        w=self.worker(step);self.assertTrue(called.wait(1));time.sleep(.65)
        self.assertEqual(len(count),1)
        start=time.monotonic();w.stop();self.assertFalse(w.thread.is_alive());self.assertLess(time.monotonic()-start,.5)

    def test_request_during_step_is_not_lost_at_idle_transition(self):
        entered=threading.Event();release=threading.Event();second=threading.Event();count=[]
        def step():
            count.append(1)
            if len(count)==1:entered.set();release.wait(2)
            else:second.set()
            return False
        self.addCleanup(release.set);w=self.worker(step);self.assertTrue(entered.wait(1))
        w.wake_event.set();release.set();self.assertTrue(second.wait(1));self.assertEqual(len(count),2)

    def test_pending_and_worker_errors_retry_but_return_to_idle(self):
        finished=threading.Event();count=[]
        def step():
            count.append(1)
            if len(count)==1:raise OSError('fixture transient registry access')
            if len(count)==2:return True
            finished.set();return False
        w=self.worker(step);self.assertTrue(finished.wait(2));time.sleep(.65)
        self.assertEqual(len(count),3);self.assertNotIn('removal_worker',w.manager.errors)
