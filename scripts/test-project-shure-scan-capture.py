"""Pure/mock capture lifecycle tests: no real PktMon mutation or device I/O."""
from pathlib import Path
import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, Mock, patch

spec = importlib.util.spec_from_file_location('scan_capture', Path(__file__).with_name('project-shure-scan-capture.py'))
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
TARGET = '192.0.2.107'


class FakePktMon:
    def __init__(self, directory):
        self.directory, self.calls, self.filters, self.etl = directory, [], [], None
        self.start_timeout, self.start_failure, self.convert_failure = False, False, False

    def __call__(self, args):
        self.calls.append(args)
        if args == ['status']:
            return 0, f'Logger Parameters:\n    Log file:           {self.etl}\n' if self.etl else '数据包监视器没有运行。\n'
        if args == ['filter', 'list']:
            return 0, ('数据包筛选器:\n    无\n' if not self.filters else
                '数据包筛选器:\r\n     # 名称                    IP 地址         \r\n     - --                    -----         \r\n'
                +''.join(f'     {i} {name} {ip} \r\n' for i, (name, ip) in enumerate(self.filters, 1)))
        if args[:2] == ['filter', 'add']:
            self.filters.append((args[2], args[4]))
            return 0, 'Added'
        if args == ['filter', 'remove']:
            self.filters = []
            return 0, 'Removed'
        if args[0] == 'start':
            if self.start_failure:
                return 1, 'fixture failure'
            self.etl = args[args.index('--file-name')+1]
            Path(self.etl).write_bytes(b'fixture-etl-not-real-capture')
            if self.start_timeout:
                raise subprocess.TimeoutExpired('fixture-pktmon', 45)
            return 0, 'Started'
        if args == ['stop']:
            self.etl = None
            return 0, 'Flushing logs... No events lost (fixture only)'
        if args[0] == 'etl2pcap':
            if self.convert_failure:
                return 1, 'fixture conversion error'
            Path(args[-1]).write_bytes(b'fixture-pcapng-not-real-capture')
            return 0, 'Converted'
        raise AssertionError(args)

    def mutations(self):
        return [args for args in self.calls if args[0] in ('start', 'stop') or args[:2] in (['filter', 'add'], ['filter', 'remove'])]


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.runner = FakePktMon(self.folder)
        self.session = tool.CaptureSession(self.runner, TARGET, self.folder)

    def test_default_plan_never_constructs_pktmon(self):
        with patch.object(tool, 'PktMon', side_effect=AssertionError('must not execute')), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(tool.main(['--target', TARGET]), 0)

    def test_check_is_read_only(self):
        with patch.object(tool, 'PktMon', return_value=self.runner), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(tool.main(['--target', TARGET, '--check']), 0)
        self.assertEqual(self.runner.calls, [['status'], ['filter', 'list']])

    def test_command_mode_still_requires_explicit_target(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            tool.main(['--check'])

    def test_interactive_blank_input_never_uses_example_or_starts_pktmon(self):
        for arguments in [['--interactive'], ['--interactive', '--target', TARGET]]:
            with patch('builtins.input', return_value=''), patch.object(tool, 'PktMon', side_effect=AssertionError('must not execute')), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(tool.main(arguments), 0)

    def test_interactive_invalid_target_retries_and_confirmation_can_cancel(self):
        args = tool.parser().parse_args(['--interactive'])
        answers = iter(['192.0.2.0/24', TARGET, 'q'])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(tool.interactive_setup(args, read=lambda _: next(answers)))
        self.assertEqual(args.target, TARGET)
        self.assertFalse(args.capture)

    def test_interactive_requires_enter_after_target_and_shows_same_computer_guidance(self):
        args = tool.parser().parse_args(['--interactive'])
        answers = iter([TARGET, ''])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertTrue(tool.interactive_setup(args, read=lambda _: next(answers)))
        self.assertEqual(args.target, TARGET)
        self.assertTrue(args.capture)
        self.assertIn('同一台电脑', output.getvalue())
        self.assertIn('自然结束', output.getvalue())
        self.assertIn('不要求拔网线', output.getvalue())
        self.assertIn('.sdb3', output.getvalue())

    def test_interactive_eof_or_interrupt_cancels_before_pktmon(self):
        for exception in [EOFError(), KeyboardInterrupt()]:
            with patch('builtins.input', side_effect=exception), patch.object(tool, 'PktMon', side_effect=AssertionError('must not execute')), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(tool.main(['--interactive']), 0)

    def test_interactive_confirmation_reaches_capture_boundary_only_after_both_inputs(self):
        answers = iter([TARGET, ''])
        entered = []
        def read(prompt):
            value = next(answers)
            entered.append(value)
            return value
        def boundary():
            self.assertEqual(entered, [TARGET, ''])
            raise RuntimeError('mock capture boundary; no real PktMon')
        with patch('builtins.input', side_effect=read), patch.object(tool, 'PktMon', side_effect=boundary), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'mock capture boundary'):
                tool.main(['--interactive'])

    def test_visible_launcher_is_relative_and_uses_interactive_project_python(self):
        launcher = Path(__file__).with_name('采集ULXD4扫描.vbs').read_text('utf-8')
        self.assertIn('fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))', launcher)
        self.assertIn('app\\tools\\python\\python.exe', launcher)
        self.assertIn(' --interactive', launcher)
        self.assertIn('projectRoot, "runas", 1', launcher)
        self.assertNotIn('--capture', launcher)
        self.assertNotIn('cmd.exe', launcher.lower())

    def test_exact_ipv4_only_no_subnet_hostname_or_multicast(self):
        self.assertEqual(tool.target_address(TARGET), TARGET)
        for invalid in ['0.0.0.0', '127.0.0.1', '239.255.254.253', '255.255.255.255',
                        '192.0.2.0/24', 'receiver', '::1', TARGET+' --bad']:
            with self.assertRaises(tool.argparse.ArgumentTypeError):
                tool.target_address(invalid)

    def test_duration_size_limits(self):
        with contextlib.redirect_stderr(io.StringIO()):
            for option, value in [('--seconds', '0'), ('--seconds', '901'), ('--max-mb', '257'), ('--max-mb', '0')]:
                with self.assertRaises(SystemExit):
                    tool.parser().parse_args(['--target', TARGET, option, value])

    def test_recognizes_only_supported_idle_and_single_filter_outputs(self):
        for value in ['Packet Monitor is not running.\r\n', '数据包监视器没有运行。']:
            self.assertTrue(tool.is_idle(value))
        self.assertFalse(tool.is_idle('Error: Packet Monitor is not running.'))
        self.assertFalse(tool.no_filters('Error\nPacket Filters:\nNone'))
        self.assertTrue(tool.sole_owned_filter('Packet Filters:\nId Name IP Address\n1 own '+TARGET, 'own', TARGET))
        for row in ['1 own '+TARGET+' TCP', '1 own '+TARGET+'\n2 other 10.0.0.1', 'unexpected']:
            self.assertFalse(tool.sole_owned_filter(row, 'own', TARGET))

    def test_real_chinese_filter_output_with_separator_is_single_owned_filter(self):
        # Exact output from the failed 20261007-102122 run, not a synthetic table.
        output = ('数据包筛选器:\r\n'
            '     # 名称                    IP 地址         \r\n'
            '     - --                    -----         \r\n'
            '     1 DatyScan_51f5de80fa55 192.0.2.104 \r\n')
        self.assertTrue(tool.sole_owned_filter(output, 'DatyScan_51f5de80fa55', '192.0.2.104'))
        self.assertFalse(tool.sole_owned_filter(output, 'DatyScan_51f5de80fa55', TARGET))
        self.assertFalse(tool.sole_owned_filter(output, 'DatyScan_someone_else', '192.0.2.104'))

    def test_english_separator_is_allowed_but_extra_filters_or_rows_are_refused(self):
        output = 'Packet Filters:\r\n # Name IP Address\r\n - ---- ----------\r\n 1 own '+TARGET+'\r\n'
        self.assertTrue(tool.sole_owned_filter(output, 'own', TARGET))
        for extra in [' 2 other 10.0.0.1\r\n', ' Unknown output\r\n', ' 2 own '+TARGET+'\r\n']:
            self.assertFalse(tool.sole_owned_filter(output+extra, 'own', TARGET))

    def test_existing_session_is_not_stopped_or_changed(self):
        self.runner.etl = r'C:\somebody\existing.etl'
        with self.assertRaisesRegex(RuntimeError, '已有 PktMon'):
            self.session.start()
        self.session.close()
        self.assertEqual(self.runner.mutations(), [])

    def test_existing_filters_are_not_deleted_or_modified(self):
        self.runner.filters = [('Other', '10.0.0.1')]
        with self.assertRaisesRegex(RuntimeError, '已有 PktMon 过滤器'):
            self.session.start()
        self.session.close()
        self.assertEqual(self.runner.mutations(), [])
        self.assertEqual(self.runner.filters, [('Other', '10.0.0.1')])

    def test_success_captures_only_target_full_packets_cleans_then_converts(self):
        self.session.start()
        self.session.close()
        added = next(args for args in self.runner.calls if args[:2] == ['filter', 'add'])
        self.assertEqual(added, ['filter', 'add', self.session.name, '-i', TARGET])
        command = next(args for args in self.runner.calls if args[0] == 'start')
        self.assertEqual(command, tool.capture_command(self.session.etl, 128))
        self.assertEqual(command[command.index('--comp')+1], 'all')
        self.assertNotIn('--trace', command)
        self.assertTrue(self.session.stopped)
        self.assertTrue(self.session.converted)
        self.assertFalse(self.session.warnings)
        self.assertEqual(self.runner.filters, [])
        self.assertLess(self.runner.calls.index(['stop']), self.runner.calls.index(['filter', 'remove']))

    def test_failed_start_removes_only_own_filter(self):
        self.runner.start_failure = True
        with self.assertRaises(RuntimeError):
            self.session.start()
        self.session.close()
        self.assertEqual(self.runner.filters, [])
        self.assertNotIn(['stop'], self.runner.calls)
        self.assertFalse(self.session.converted)

    def test_lost_start_reply_stops_owned_session(self):
        self.runner.start_timeout = True
        with self.assertRaises(subprocess.TimeoutExpired):
            self.session.start()
        self.session.close()
        self.assertIn(['stop'], self.runner.calls)
        self.assertEqual(self.runner.filters, [])

    def test_new_external_filter_stops_our_capture_but_preserves_all_filters(self):
        self.session.start()
        self.runner.filters.append(('Other', '10.0.0.1'))
        with self.assertRaisesRegex(RuntimeError, '被外部改变'):
            self.session.assert_unchanged()
        self.session.close()
        self.assertIn(['stop'], self.runner.calls)
        self.assertNotIn(['filter', 'remove'], self.runner.calls)
        self.assertEqual(len(self.runner.filters), 2)
        self.assertTrue(self.session.warnings)

    def test_replaced_session_is_never_stopped_or_filters_removed(self):
        self.session.start()
        self.runner.etl = r'C:\somebody\replacement.etl'
        self.session.close()
        self.assertNotIn(['stop'], self.runner.calls)
        self.assertNotIn(['filter', 'remove'], self.runner.calls)
        self.assertFalse(self.session.stopped)
        self.assertTrue(self.session.warnings)

    def test_session_path_match_is_exact_not_prefix(self):
        self.assertTrue(tool.owned_session('Log file: '+str(self.session.etl), self.session.etl))
        self.assertFalse(tool.owned_session('Log file: '+str(self.session.etl)+'.other', self.session.etl))

    def test_multiple_trials_all_markers_are_observations_not_protocol_ack(self):
        self.session.start()
        for key in ['s', 'n', 's', 'c', 's', 'd', 'r']:
            self.assertTrue(self.session.mark(key))
        self.assertFalse(self.session.mark('?'))
        self.assertEqual([e['trial'] for e in self.session.events], [1, 1, 2, 2, 3, 3, 3])
        self.assertTrue(all(e['source'] == 'operator_observation' and not e['device_event_verified'] for e in self.session.events))
        self.assertNotIn(['stop'], self.runner.calls)
        self.session.close()
        args = tool.parser().parse_args(['--target', TARGET])
        tool.save_report(self.session, args, final=True)
        report = json.loads((self.folder/'evidence.json').read_text('utf-8'))
        self.assertFalse(report['device_scan_completion_verified'])
        self.assertFalse(report['device_scan_protocol_verified'])
        self.assertEqual(len(report['files']), 2)
        self.assertEqual(len(report['files'][0]['sha256']), 64)

    def test_conversion_failure_keeps_etl_and_reports_no_pcapng(self):
        self.runner.convert_failure = True
        self.session.start()
        self.session.close()
        self.assertTrue(self.session.etl.exists())
        self.assertFalse(self.session.converted)
        self.assertTrue(self.session.warnings)

    def guarded(self, state, on_ready=lambda: None, deadline=12, pause=None):
        args = tool.parser().parse_args(['--target', TARGET])
        tick = [10]
        def advance(value):
            tick[0] += value
            if pause:
                pause(state)
        result = tool.run_guarded_capture(self.session, args, deadline,
            parent_alive=lambda: state['alive'], stop_requested=lambda: state['stop'],
            ready=on_ready, clock=lambda: tick[0], pause=advance)
        report = json.loads((self.folder/'watchdog.json').read_text('utf-8'))
        return result, report

    def test_watchdog_parent_disappears_stops_only_owned_session_and_cleans(self):
        state = {'alive': True, 'stop': False}
        result, report = self.guarded(state, on_ready=lambda: state.update(alive=False))
        self.assertEqual(result, 0)
        self.assertEqual(report['capture_stop_reason'], 'capture_window_exited')
        self.assertIn(['stop'], self.runner.calls)
        self.assertEqual(self.runner.filters, [])
        self.assertTrue(report['capture_stopped_verified'])
        self.assertTrue(report['pcapng_created'])

    def test_watchdog_normal_stop_exits_after_same_owned_cleanup(self):
        state = {'alive': True, 'stop': False}
        result, report = self.guarded(state, on_ready=lambda: state.update(stop=True))
        self.assertEqual(result, 0)
        self.assertEqual(report['capture_stop_reason'], 'operator_stopped_capture')
        self.assertEqual(self.runner.calls.count(['stop']), 1)
        self.assertEqual(self.runner.calls.count(['filter', 'remove']), 1)

    def test_watchdog_deadline_is_independent_of_parent_console_loop(self):
        state = {'alive': True, 'stop': False}
        result, report = self.guarded(state)
        self.assertEqual(result, 0)
        self.assertEqual(report['capture_stop_reason'], 'duration_limit')
        self.assertIn(['stop'], self.runner.calls)

    def test_watchdog_replacement_session_survives_parent_disappearance(self):
        state = {'alive': True, 'stop': False}
        def replaced():
            self.runner.etl = r'C:\someone-else\new.etl'
            state['alive'] = False
        result, report = self.guarded(state, on_ready=replaced)
        self.assertEqual(result, 1)
        self.assertNotIn(['stop'], self.runner.calls)
        self.assertNotIn(['filter', 'remove'], self.runner.calls)
        self.assertFalse(report['capture_stopped_verified'])

    def test_watchdog_parent_already_gone_never_starts_capture(self):
        result, report = self.guarded({'alive': False, 'stop': False})
        self.assertEqual(result, 0)
        self.assertEqual(self.runner.mutations(), [])
        self.assertEqual(report['capture_stop_reason'], 'capture_window_exited')

    def test_watchdog_cancel_during_startup_removes_filter_without_starting(self):
        state = {'alive': True, 'stop': False}
        original = self.runner
        def vanished(args):
            reply = original(args)
            if args[:2] == ['filter', 'add']:
                state['alive'] = False
            return reply
        self.session.runner = vanished
        _, report = self.guarded(state)
        self.assertEqual(self.runner.filters, [])
        self.assertFalse(any(args[0] == 'start' for args in self.runner.calls))
        self.assertEqual(report['capture_stop_reason'], 'capture_window_exited')

    def test_hidden_watchdog_uses_inherited_process_handle_and_no_console(self):
        api = Mock()
        api.OpenProcess.return_value = 111
        api.CreateEventW.side_effect = [222, 333]
        api.WaitForSingleObject.return_value = 0
        api.SetEvent.return_value = 1
        child = Mock()
        child.poll.return_value = None
        child.wait.return_value = 0
        args = tool.parser().parse_args(['--target', TARGET])
        with patch.object(tool, 'windows_handles', return_value=api), patch.object(tool.os, 'set_handle_inheritable'), patch.object(tool.subprocess, 'Popen', return_value=child) as popen:
            guardian = tool.CaptureWatchdog(self.session, args)
            guardian.start()
            guardian.finish()
        command = popen.call_args.args[0]
        self.assertEqual(command[0], str(tool.ROOT/'app/tools/python/python.exe'))
        self.assertIn('--watchdog', command)
        self.assertEqual(command[command.index('--parent-handle')+1], '111')
        self.assertEqual(popen.call_args.kwargs['creationflags'], subprocess.CREATE_NO_WINDOW)
        self.assertTrue(popen.call_args.kwargs['close_fds'])
        self.assertEqual(popen.call_args.kwargs['startupinfo'].lpAttributeList['handle_list'], [111, 222, 333])
        api.SetEvent.assert_called_once_with(222)
        child.terminate.assert_not_called()
        child.kill.assert_not_called()


class RawCaptureIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.args = tool.parser().parse_args(['--target', TARGET, '--engine', 'raw-ip', '--interface', '192.0.2.16'])
        self.session = tool.make_session(self.args, self.folder)

    def test_raw_plan_and_check_never_start_capture_or_touch_pktmon(self):
        with patch.object(tool, 'PktMon', side_effect=AssertionError('no PktMon')), patch.object(tool, 'local_capture_interface', return_value='192.0.2.16') as route, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(tool.main(['--target', TARGET, '--engine', 'raw-ip']), 0)
            route.assert_not_called()
            self.assertEqual(tool.main(['--target', TARGET, '--engine', 'raw-ip', '--check']), 0)
            route.assert_called_once()
        self.assertFalse(self.session.pcap.exists())

    def test_route_selection_does_not_send_receiver_commands(self):
        route = MagicMock()
        route.__enter__.return_value = route
        route.getsockname.return_value = ('192.0.2.16', 54321)
        with patch.object(tool.socket, 'socket', return_value=route):
            self.assertEqual(tool.local_capture_interface(TARGET), '192.0.2.16')
        route.connect.assert_called_once_with((TARGET, 9))
        route.send.assert_not_called()
        route.sendto.assert_not_called()
        route.__exit__.assert_called_once()

    def run_fake_capture(self, failed=False, capacity=False):
        state = {'stopped': False, 'error': 'fixture receive failed' if failed else None,
                 'size_limit_reached': capacity, 'packets': 1}
        clock = [0.0]
        captured = Mock()
        captured.snapshot.side_effect = lambda: dict(state)
        captured.start.side_effect = lambda: self.session.pcap.write_bytes(b'fixture-not-real-pcapng'*4)
        def stop():
            state['stopped'] = True
        captured.stop.side_effect = stop
        module = types.SimpleNamespace(RawIpCapture=Mock(return_value=captured))
        with patch.dict(sys.modules, {'shure_scan_raw_capture': module}):
            result = tool.run_guarded_capture(self.session, self.args, 5,
                parent_alive=lambda: True, stop_requested=lambda: False, ready=lambda: None,
                clock=lambda: clock[0], pause=lambda seconds: clock.__setitem__(0, clock[0]+seconds))
        return result, captured, json.loads((self.folder/'watchdog.json').read_text('utf-8'))

    def test_raw_deadline_closes_capture_and_reports_own_source(self):
        result, captured, report = self.run_fake_capture()
        self.assertEqual(result, 0)
        captured.stop.assert_called_once()
        self.assertTrue(report['capture_stopped_verified'])
        self.assertEqual(report['capture_stop_reason'], 'duration_limit')
        self.assertEqual(report['source'], 'passive_windows_raw_ip')
        self.assertEqual(report['interface_ip'], '192.0.2.16')
        self.assertEqual([f['name'] for f in report['files']], ['receiver.pcapng'])
        self.assertEqual(report['commands'], [])
        self.assertFalse(report['device_scan_protocol_verified'])

    def test_raw_receive_error_is_not_reported_as_success_and_still_closes(self):
        result, captured, report = self.run_fake_capture(failed=True)
        self.assertEqual(result, 1)
        captured.stop.assert_called_once()
        self.assertIn('fixture receive failed', report['error'])
        self.assertTrue(report['capture_stopped_verified'])

    def test_raw_size_limit_preserves_stop_reason_and_partial_file(self):
        result, captured, report = self.run_fake_capture(capacity=True)
        self.assertEqual(result, 1)
        self.assertEqual(report['capture_stop_reason'], 'size_limit')
        self.assertTrue(report['raw_ip']['size_limit_reached'])
        self.assertEqual(len(report['files']), 1)
        captured.stop.assert_called_once()

    def test_raw_parent_gone_never_constructs_receiver_socket(self):
        module = types.SimpleNamespace(RawIpCapture=Mock(side_effect=AssertionError('no raw socket')))
        with patch.dict(sys.modules, {'shure_scan_raw_capture': module}):
            result = tool.run_guarded_capture(self.session, self.args, 5,
                parent_alive=lambda: False, stop_requested=lambda: False,
                ready=lambda: self.fail('not ready'), clock=lambda: 0)
        self.assertEqual(result, 0)
        module.RawIpCapture.assert_not_called()
        self.assertFalse(self.session.pcap.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
