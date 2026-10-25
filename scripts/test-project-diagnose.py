"""No network or production reads: verify diagnosis and output redaction."""
from pathlib import Path
import builtins, importlib.util, json, unittest
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location('diagnose', Path(__file__).with_name('project-diagnose.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Diagnosis(unittest.TestCase):
    def test_rpc_result_and_nested_body_are_unwrapped_and_errors_rejected(self):
        self.assertEqual(module.body({'ok': True, 'result': {'plugins': [1]}}), {'plugins': [1]})
        self.assertEqual(module.body({'ok': True, 'result': {'status': 200, 'body': {'enabled': True}}}), {'enabled': True})
        for reply in ({'ok': False, 'error': 'fixture'}, {'ok': True, 'result': {'status': 503, 'body': {}}}):
            with self.assertRaises(ValueError):
                module.body(reply)

    def raw(self):
        return {'rpc': {'plugins.status': {'plugins': [{'id': 'shure-scp', 'active': True,
            'state': 'installed', 'automatic_discovery': {'enabled': True}}]},
            'discovery.status': {'enabled': True, 'connection_mode': 'direct-scp'},
            'devices.snapshot': {'devices': []}},
            'receiver': {'tcp2202': True, 'scpReply': True, 'firmware': '2.3.34.0', 'channels': 1},
            'api': {'state': 'ready', 'target_present': True}}

    def test_missing_official_service_is_not_a_dependency_or_install_instruction(self):
        raw = self.raw(); raw['api'] = {'state': 'unavailable', 'error': 'LOCAL_API_NOT_CONFIGURED'}
        report = module.summarize(raw, '192.0.2.104')
        self.assertTrue(report['plugin']['active'])
        self.assertNotIn('systemapi', report)
        self.assertNotIn('SystemAPI', ''.join(report['findings']))
        self.assertTrue(any('服务器没有目标通道' in v for v in report['findings']))
        self.assertFalse(any('没有舒尔插件安装记录' in v for v in report['findings']))

    def test_reference_api_cannot_mask_actual_network_failure(self):
        raw = self.raw(); raw['api']['target_present'] = False; raw['receiver']['tcp2202'] = False
        raw['reference_systemapi'] = True
        report = module.summarize(raw, '192.0.2.104')
        self.assertTrue(any('本电脑无法连通' in v for v in report['findings']))
        self.assertTrue(report['systemapi']['reference_only'])
        self.assertFalse(report['systemapi']['target_present'])
        self.assertFalse(any('安装' in v or '修复' in v for v in report['findings']))

    def test_absent_mode_is_unknown_and_real_discovery_failures_are_reported(self):
        raw = self.raw()
        raw['rpc']['discovery.status'] = {'enabled': False}
        raw['rpc']['plugins.status']['plugins'][0]['automatic_discovery']['error'] = 'fixture'
        report = module.summarize(raw, '192.0.2.104')
        self.assertEqual(report['connection_mode'], 'unknown')
        self.assertTrue(any('调度报告错误' in v for v in report['findings']))
        self.assertTrue(any('发现已关闭' in v for v in report['findings']))
        self.assertNotIn('SystemAPI', ''.join(report['findings']))

    def test_partial_scp_response_is_not_a_complete_receiver(self):
        raw = self.raw(); raw['receiver']['channels'] = 0
        report = module.summarize(raw, '192.0.2.104')
        self.assertTrue(any('没有完整的接收机通道信息' in v for v in report['findings']))

    def test_missing_runtime_does_not_claim_plugin_absent(self):
        raw = self.raw(); raw.pop('rpc')
        result = module.summarize(raw, '192.0.2.104')
        self.assertTrue(any('无法读取本项目后台' in v for v in result['findings']))
        self.assertFalse(any('没有舒尔插件安装记录' in v for v in result['findings']))

    def test_no_settings_credentials_labels_or_device_identity_exported(self):
        raw = self.raw()
        raw['rpc']['plugins.status']['plugins'][0]['secret'] = 'DO_NOT_EXPORT'
        raw['rpc']['devices.snapshot']['devices'] = [{'receiver_ip': '192.0.2.104', 'name': 'DO_NOT_EXPORT', 'receiver_mac': 'DO_NOT_EXPORT'}]
        raw['rpc']['network.status'] = {'secret': 'DO_NOT_EXPORT'}
        raw['api']['SharedKey'] = 'DO_NOT_EXPORT'; raw['receiver']['raw'] = 'DO_NOT_EXPORT'
        raw['reference_systemapi'] = True
        result = module.summarize(raw, '192.0.2.104')
        self.assertNotIn('DO_NOT_EXPORT', json.dumps(result))
        self.assertEqual(result['target_channels_in_server'], 1)


class Collection(unittest.TestCase):
    raw = Diagnosis.raw

    def collect(self, *, reference=False):
        import project_identity
        import shure_active_discovery
        raw = self.raw()
        with patch.object(project_identity, 'instance_root', return_value=Path('fixture-instance')), \
             patch.object(module, 'runtime_status', new=AsyncMock(return_value=raw['rpc'])), \
             patch.object(shure_active_discovery, 'local_interfaces', return_value=[{'address': '192.0.2.17'}]), \
             patch.object(module, 'receiver_get', return_value=raw['receiver']) as receiver:
            result = (module.collect('192.0.2.104', reference_systemapi=True)
                      if reference else module.collect('192.0.2.104'))
            receiver.assert_called_once_with('192.0.2.104')
            return result

    def test_default_collection_neither_imports_nor_calls_official_client(self):
        original = builtins.__import__
        def import_without_official(name, *args, **kwargs):
            if name == 'shure_systemapi':
                raise AssertionError('Default diagnosis imported official API')
            return original(name, *args, **kwargs)
        with patch('builtins.__import__', side_effect=import_without_official), \
             patch.object(module, 'systemapi_reference', side_effect=AssertionError('Official API called')):
            result = self.collect()
        self.assertTrue(result['runtime_readable'])
        self.assertTrue(result['receiver']['scpReply'])
        self.assertEqual(result['local_addresses'], ['192.0.2.17'])
        self.assertNotIn('systemapi', result)

    def test_explicit_reference_uses_mocked_official_get_and_exports_only_allowlist(self):
        import shure_systemapi as api
        identity = {'model': 'ULXD4', 'firmware': '2.3.34.0', 'serial': 'DO_NOT_EXPORT'}
        with patch.object(api.SystemApiClient, 'devices', return_value={'fixture': True}) as get, \
             patch.object(api, 'identity_from_response', return_value=identity) as parse:
            result = self.collect(reference=True)
        get.assert_called_once_with()
        parse.assert_called_once_with({'fixture': True}, '192.0.2.104')
        self.assertEqual(result['systemapi']['target_model'], 'ULXD4')
        self.assertTrue(result['systemapi']['reference_only'])
        self.assertNotIn('DO_NOT_EXPORT', json.dumps(result))

    def test_explicit_reference_failure_does_not_turn_daty_connection_into_failure(self):
        import shure_systemapi as api
        with patch.object(api.SystemApiClient, 'devices', side_effect=api.SystemApiError('LOCAL_API_NOT_CONFIGURED')):
            result = self.collect(reference=True)
        self.assertTrue(result['runtime_readable'])
        self.assertTrue(result['plugin']['active'])
        self.assertTrue(result['receiver']['scpReply'])
        self.assertEqual(result['systemapi']['state'], 'unavailable')
        self.assertFalse(any('安装向导' in v or '身份校验会阻止' in v for v in result['findings']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
