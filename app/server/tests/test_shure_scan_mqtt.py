"""Actual TLS/MQTT and temporary SQLite; no LAN scanner or production install."""
import asyncio,base64,hashlib,json,os,unittest,uuid
from pathlib import Path
from unittest.mock import patch
from plugin_install import PluginError
from test_stage6 import Integration
from test_shure_scan_file import fixture,make_file,parse_scan,ROOT
from test_plugin_install import existing_package
from test_shure_package_v2 import current_package


class Scan(Integration):
    async def install(self,raw=None):
        raw=raw or current_package()
        encoded=base64.b64encode(raw).decode()
        view=await self.rpc('plugins.preview',{'package_base64':encoded})
        body={'package_base64':encoded,'sha256':view['sha256'],'expected_revision':view['revision'],'operation_id':uuid.uuid4().hex}
        result=await self.rpc('plugins.install',body)
        self.assertEqual(result['activation'],'active')
        return result

    def body(self,raw):
        return {'plugin_id':'shure-scp','file_base64':base64.b64encode(raw).decode(),'file_sha256':hashlib.sha256(raw).hexdigest()}

    async def download(self,reply):
        desc=reply['transfer'];parts=[];offset=0
        while offset<desc['bytes']:
            chunk=await self.rpc('downloads.chunk',{'download_id':desc['id'],'offset':offset,'sha256':desc['sha256']})
            data=base64.b64decode(chunk['data']);parts.append(data);offset+=len(data)
        raw=b''.join(parts);self.assertEqual(hashlib.sha256(raw).hexdigest(),desc['sha256'])
        await self.rpc('downloads.close',{'download_id':desc['id']})
        return json.loads(raw)

    async def test_installed_package_reads_user_file_without_device_or_resource_write(self):
        await self.install();item=self.runtime.plugins.active['shure-scp']
        self.assertTrue(type(item['scan_files']).__module__.startswith('_daty_plugin_shure_scp_'))
        caps=(await self.rpc('state.capabilities'))['body']['adapters']['shure-scp']
        self.assertTrue(caps['read_scan_file']);self.assertTrue(caps['scan']);self.assertEqual(caps['scan_readiness'],'probe-required')
        self.assertTrue(item['scan_live'].__module__.startswith('_daty_plugin_shure_scp_'))
        raw=Path(os.environ['DATY_WWB_TEST_SAMPLE']).read_bytes() if os.environ.get('DATY_WWB_TEST_SAMPLE') else make_file(*fixture())
        names=['db_resources','db_resource_versions','db_operations','db_scans','db_scan_points',
               'db_scan_originals','db_scan_current','commands','live_command_events']
        with self.runtime.repo.connection() as c:
            # Preserve domain resources, settings and control journal exactly.
            before={name:list(c.execute('SELECT * FROM '+name)) for name in names}
        before_discovery=item['discovery'].snapshot()
        # Parser must only use imported code; failing host copy is irrelevant.
        with patch('shure_scan_file.parse_scan',side_effect=AssertionError('host parser bypass')):
            doc=await self.rpc('plugins.scan_file',self.body(raw))
        expected=parse_scan(raw)
        self.assertEqual({k:v for k,v in doc.items() if k!='plugin'},expected)
        self.assertEqual(doc['plugin']['sha256'],item['sha256'])
        self.assertEqual(item['discovery'].snapshot(),before_discovery)
        self.assertEqual([len(r.executions) for r in self.receivers],[0,0])
        with self.runtime.repo.connection() as c:
            self.assertEqual({name:list(c.execute('SELECT * FROM '+name)) for name in names},before)

    async def test_missing_and_old_plugin_cannot_use_parser_or_bypass_upgrade(self):
        body=self.body(make_file(*fixture()))
        result=await self.ui.call('plugins.scan_file',body)
        self.assertFalse(result['ok']);self.assertIn('BRAND_PLUGIN_NOT_INSTALLED',str(result))
        await self.install(existing_package())
        result=await self.ui.call('plugins.scan_file',body)
        self.assertFalse(result['ok']);self.assertIn('SCAN_FILE_ADAPTER_NOT_INSTALLED',str(result))
        raw=current_package()
        encoded=base64.b64encode(raw).decode();view=await self.rpc('plugins.preview',{'package_base64':encoded})
        result=await self.ui.call('plugins.install',{'package_base64':encoded,'sha256':view['sha256'],'expected_revision':view['revision'],'operation_id':uuid.uuid4().hex})
        self.assertFalse(result['ok']);self.assertIn('PLUGIN_UPDATE_REQUIRES_MAINTENANCE',str(result))
        self.assertIsNone(self.runtime.plugins.active['shure-scp']['scan_files'])

    async def test_file_errors_stale_requests_and_cancellation_do_not_change_service(self):
        await self.install();raw=make_file(*fixture());body=self.body(raw)
        original=await self.rpc('plugins.scan_file',body)
        for changed,code in [({'file_base64':'%%%'},'INVALID_SCAN_BASE64'),({'file_sha256':'0'*64},'SCAN_FILE_CHANGED'),({'plugin_id':'other'},'BRAND_PLUGIN_NOT_INSTALLED'),({'file_base64':base64.b64encode(raw[:-1]).decode(),'file_sha256':hashlib.sha256(raw[:-1]).hexdigest()},'SCAN_FILE_TRUNCATED')]:
            result=await self.ui.call('plugins.scan_file',{**body,**changed})
            self.assertFalse(result['ok']);self.assertIn(code,str(result))
        for changed in ({'deadline_at_ms':1},{'boot_id':'0'*32}):
            request=self.ui.request('plugins.scan_file',body);request.update(changed)
            await self.ui.send(request);self.assertFalse((await self.ui.message())['ok'])
        with self.assertRaises(PluginError) as caught:
            self.runtime.plugins.read_scan_file(body['plugin_id'],body['file_base64'],body['file_sha256'],allowed=lambda:False)
        self.assertEqual(caught.exception.code,'SCAN_READ_CANCELLED')
        self.assertEqual(await self.rpc('plugins.scan_file',body),original)
        self.assertEqual([len(r.executions) for r in self.receivers],[0,0])

    async def test_large_result_chunking_and_ui_reconnect_preserve_all_points(self):
        await self.install();raw=make_file(*fixture(15000));body=self.body(raw)
        response=await self.rpc('plugins.scan_file',body)
        self.assertEqual(response['status'],'download_required')
        # New MQTT session can read its same-peer immutable temporary transfer.
        await self.ui.close();self.ui=await self.new_ui()
        result=await self.download(response)
        self.assertEqual(result['records'],parse_scan(raw)['records'])
        self.assertEqual(result['point_count_per_record'],15000)
        self.assertEqual((await self.rpc('plugins.scan_file',self.body(make_file(*fixture()))))['source_kind'],'wwb-file')
        self.assertTrue(self.runtime.plugins.active['shure-scp']['discovery'].enabled)
        self.assertEqual([len(r.executions) for r in self.receivers],[0,0])

    async def test_plugin_removal_blocks_new_reads_and_discards_inflight_result(self):
        await self.install();body=self.body(make_file(*fixture()))
        manager=self.runtime.plugins;adapter=manager.active['shure-scp']['scan_files']
        manager.removal.draining.add('shure-scp')
        try:
            result=await self.ui.call('plugins.scan_file',body)
            self.assertFalse(result['ok']);self.assertIn('PLUGIN_REMOVAL_PENDING',str(result))
        finally:manager.removal.draining.discard('shure-scp')
        original=adapter.read
        def removing(raw,*,cancelled):
            result=original(raw,cancelled=cancelled)
            manager.removal.draining.add('shure-scp')
            return result
        try:
            with patch.object(adapter,'read',side_effect=removing):
                result=await self.ui.call('plugins.scan_file',body)
            self.assertFalse(result['ok']);self.assertIn('SCAN_READ_CANCELLED',str(result))
        finally:manager.removal.draining.discard('shure-scp')
        self.assertEqual((await self.rpc('plugins.scan_file',body))['file_state'],'validated')
        self.assertEqual([len(r.executions) for r in self.receivers],[0,0])


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(Scan(name) for name in Scan.__dict__ if name.startswith('test_'))
