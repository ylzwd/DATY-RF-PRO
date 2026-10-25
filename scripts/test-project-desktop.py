"""Project desktop lifetime regression tests; no live servers or devices modified."""
from pathlib import Path
import contextlib, importlib.util, json, os, tempfile, unittest, subprocess
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('project_local', ROOT / 'scripts/project-local.py')
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)
import project_desktop
import project_service


class DesktopLifetimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='daty-desktop-test-')
        self.root = Path(self.temp.name).resolve()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(local, 'base', return_value=self.root))
        self.depth = 0

        @contextlib.contextmanager
        def lease():
            self.depth += 1
            try:
                yield
            finally:
                self.depth -= 1
        self.stack.enter_context(patch.object(local, 'launch_lease', lease))

    def status(self, boot='a' * 32):
        return dict(state='running', pid=1234, boot_id=boot, transport={'ready': True},
                    persistence={'writable': True, 'writer': {'running': True}})

    def test_last_window_requests_owned_boot_stop(self):
        with patch.object(project_desktop, 'native_processes', return_value=[]), \
             patch.object(local, 'stop', return_value={'state': 'stopped'}) as stop:
            self.assertEqual(local.finish_desktop('a' * 32)['state'], 'stopped')
            stop.assert_called_once_with(expected_boot='a' * 32)

    def test_other_window_keeps_server(self):
        with patch.object(project_desktop, 'native_processes', return_value=[456]), \
             patch.object(local,'state',return_value=self.status()), \
             patch.object(local, 'stop') as stop:
            self.assertEqual(local.finish_desktop('a' * 32)['state'], 'desktop-still-open')
            stop.assert_not_called()

    def test_enumeration_failure_never_stops_server(self):
        with patch.object(project_desktop, 'native_processes', side_effect=OSError('unavailable')), \
             patch.object(local, 'stop') as stop:
            with self.assertRaises(OSError):
                local.finish_desktop('a' * 32)
            stop.assert_not_called()

    def test_waiter_does_not_adopt_replacement_backend(self):
        with patch.object(project_desktop,'native_processes',return_value=[456]), \
             patch.object(local,'state',return_value=self.status('b'*32)), \
             patch.object(local,'stop') as stop:
            self.assertEqual(local.finish_desktop('a'*32)['state'],'replacement-preserved')
            stop.assert_not_called()

    def test_replacement_boot_is_preserved(self):
        with patch.object(local, 'state', return_value=self.status('b' * 32)), \
             patch.object(local, 'atomic') as write:
            self.assertEqual(local.stop('a' * 32)['state'], 'replacement-preserved')
            write.assert_not_called()

    def test_graceful_stop_waits_for_real_process_exit(self):
        with patch.object(local, 'state', return_value=self.status()) as state, \
             patch.object(local, 'process_matches', side_effect=[True, True, False]), \
             patch.object(local.time, 'sleep') as sleep:
            self.assertEqual(local.stop('a' * 32)['state'], 'stopped')
            state.assert_called_once_with(require_fresh=False,match_profile=False)
            self.assertEqual(sleep.call_count, 2)
            self.assertEqual(local.read(self.root / 'runtime/stop.request.json'), {'boot_id': 'a' * 32})

    def test_stop_timeout_does_not_claim_success(self):
        with patch.object(local, 'state', return_value=self.status()), \
             patch.object(local, 'process_matches', return_value=True), \
             patch.object(local.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'Graceful stop pending'):
                local.stop('a' * 32)

    def test_stale_heartbeat_is_not_a_dead_process(self):
        status = dict(self.status(), at_utc=(datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat(),
                      database_epoch='e' * 32, web_port=18280, mqtt_port=18283)
        local.atomic(self.root / 'runtime/runtime-status.json', status)
        local.atomic(self.root / 'config/project-instance.local.json', {'epoch': 'e' * 32})
        with patch.object(local, 'profile', return_value={'web_port': 18280, 'mqtt_port': 18283}), \
             patch.object(local, 'process_matches', return_value=True):
            self.assertIsNone(local.state())
            self.assertEqual(local.state(require_fresh=False)['boot_id'], 'a' * 32)
            status['database_epoch'] = 'f' * 32
            local.atomic(self.root / 'runtime/runtime-status.json', status)
            self.assertIsNone(local.state(require_fresh=False))

    def launch_context(self, existing):
        output = 'native/publish/test'
        exe = self.root / output / 'DATY.RF.Native.exe'
        exe.parent.mkdir(parents=True)
        exe.touch()
        self.stack.enter_context(patch.object(local, 'ROOT', self.root))
        self.stack.enter_context(patch.object(local, 'profile', return_value={'native_output': output}))
        self.stack.enter_context(patch.object(local, 'state', return_value=existing))
        self.stack.enter_context(patch.object(local, 'start', return_value=self.status()))

    def test_host_releases_lease_while_window_runs_and_records_exit(self):
        self.launch_context(self.status())
        child = Mock(pid=456)
        def wait():
            self.assertEqual(self.depth, 0)
            return 0
        child.wait.side_effect = wait
        with patch.object(local.subprocess, 'Popen', return_value=child) as spawn, \
             patch.object(project_desktop, 'native_processes', return_value=[]), \
             patch.object(local, 'stop', return_value={'state': 'stopped'}):
            self.assertEqual(local.launch_desktop()['state'], 'stopped')
            self.assertEqual(spawn.call_args.kwargs['env']['DATY_PROJECT_DESKTOP_BOOT'], 'a' * 32)
            record = local.read(self.root / 'runtime/desktop-lifecycle.json')
            self.assertEqual((record['native_pid'], record['native_exit_code']), (456, 0))

    def test_failed_window_start_cleans_up_new_backend(self):
        self.launch_context(None)
        with patch.object(local.subprocess, 'Popen', side_effect=OSError('cannot start')), \
             patch.object(local, 'stop') as stop:
            with self.assertRaises(OSError):
                local.launch_desktop()
            stop.assert_called_once_with(expected_boot='a' * 32)

    def test_host_waits_for_unmanaged_older_window_then_stops(self):
        self.launch_context(self.status())
        child=Mock(pid=456);child.wait.return_value=0
        with patch.object(local.subprocess,'Popen',return_value=child), \
             patch.object(project_desktop,'native_processes',side_effect=[[999],[]]), \
             patch.object(local,'stop',return_value={'state':'stopped'}) as stop, \
             patch.object(local.time,'sleep') as sleep:
            result=local.launch_desktop()
            self.assertEqual(result['state'],'stopped')
            sleep.assert_called_once_with(1)
            stop.assert_called_once_with(expected_boot='a'*32)

    def test_failed_extra_window_preserves_existing_backend(self):
        self.launch_context(self.status())
        with patch.object(local.subprocess, 'Popen', side_effect=OSError('cannot start')), \
             patch.object(local, 'stop') as stop:
            with self.assertRaises(OSError):
                local.launch_desktop()
            stop.assert_not_called()

    def test_readiness_timeout_stops_only_the_backend_it_started(self):
        child=Mock(pid=1234);child.poll.return_value=None
        with patch.object(local,'state',side_effect=[None]*240+[self.status()]), \
             patch.object(local.time,'sleep'),patch.object(local,'stop') as stop:
            with self.assertRaisesRegex(RuntimeError,'readiness timeout'):local.wait_ready(child)
            stop.assert_called_once_with(expected_boot='a'*32)

    def test_readiness_timeout_preserves_another_backend(self):
        child=Mock(pid=5678);child.poll.return_value=None
        with patch.object(local,'state',side_effect=[None]*240+[self.status()]), \
             patch.object(local.time,'sleep'),patch.object(local,'stop') as stop:
            with self.assertRaisesRegex(RuntimeError,'readiness timeout'):local.wait_ready(child)
            stop.assert_not_called()

    def test_orphan_cleanup_serializes_with_launch_and_preserves_other_windows(self):
        runtime=self.root/'runtime';local.atomic(runtime/'runtime-status.json',self.status())
        with patch.object(project_service,'native_processes',return_value=[456]):
            self.assertFalse(project_service.stop_orphan(self.root,runtime,1234))
            self.assertFalse((runtime/'stop.request.json').exists())
        with project_lease(runtime/'project-launch.lock'),patch.object(project_service,'native_processes',return_value=[]):
            self.assertFalse(project_service.stop_orphan(self.root,runtime,1234))
        with patch.object(project_service,'native_processes',return_value=[]):
            self.assertFalse(project_service.stop_orphan(self.root,runtime,999))
            self.assertFalse((runtime/'stop.request.json').exists())
            self.assertTrue(project_service.stop_orphan(self.root,runtime,1234))
            self.assertEqual(local.read(runtime/'stop.request.json'),{'boot_id':'a'*32})

    def test_process_owner_handle_detects_real_exit_and_rejects_other_program(self):
        child=subprocess.Popen([local.sys.executable,'-c','import sys;sys.stdin.read()'],stdin=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
        owner=None
        try:
            with self.assertRaisesRegex(RuntimeError,'another application'):
                project_desktop.ProcessLifetime(child.pid,[self.root/'another.exe'])
            owner=project_desktop.ProcessLifetime(child.pid,[local.sys.executable])
            self.assertFalse(owner.exited)
            child.stdin.close();child.wait(timeout=5)
            self.assertTrue(owner.exited)
        finally:
            if child.stdin and not child.stdin.closed:child.stdin.close()
            child.wait(timeout=5)
            if owner:owner.close()

    def test_windows_process_image_for_current_process(self):
        self.assertEqual(project_desktop.process_image(os.getpid()).resolve(), Path(local.sys.executable).resolve())
        self.assertIsNone(project_desktop.process_image(0))

    def test_port_change_updates_only_connection_bootstrap(self):
        # Real temporary database/CA: custom project ports must be usable after restart.
        first={'web_port':18280,'mqtt_port':18283}
        second={'web_port':18380,'mqtt_port':18383}
        with patch.object(local,'profile',return_value=first):
            local.prepare()
        identity=local.read(self.root/'config/project-instance.local.json')
        native=self.root/'config/native.local.json'
        original=local.read(native);original['PollSeconds']=7;local.atomic(native,original)
        with patch.object(local,'profile',return_value=second):
            local.prepare()
        self.assertEqual(local.read(native),{'Server':'https://127.0.0.1:18380','MqttPort':18383,'PollSeconds':7})
        self.assertEqual(local.read(self.root/'config/project-instance.local.json'),identity)

    def test_active_port_change_preserves_runtime_files_and_allows_stop(self):
        active=dict(self.status(),at_utc=datetime.now(timezone.utc).isoformat(),database_epoch='e'*32,web_port=18280,mqtt_port=18283)
        local.atomic(self.root/'runtime/runtime-status.json',active)
        local.atomic(self.root/'config/project-instance.local.json',{'epoch':'e'*32})
        config=self.root/'config/runtime-config.json';local.atomic(config,{'unchanged':True})
        with patch.object(local,'profile',return_value={'web_port':18380,'mqtt_port':18383}),patch.object(local,'process_matches',return_value=True):
            with self.assertRaisesRegex(RuntimeError,'ports changed'):
                local.prepare()
            self.assertEqual(local.read(config),{'unchanged':True})
            self.assertIsNone(local.state())
            self.assertEqual(local.state(require_fresh=False,match_profile=False)['boot_id'],active['boot_id'])


@contextlib.contextmanager
def project_lease(path):
    lease=local.ProcessLease(str(path))
    try:yield
    finally:lease.close()

if __name__ == '__main__':
    unittest.main(verbosity=2)
