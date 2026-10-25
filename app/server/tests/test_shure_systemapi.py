import copy,json,ssl,tempfile,time,unittest,uuid
from pathlib import Path
from unittest.mock import patch
import shure_systemapi as api

ID={'device_id':'dd4b7e53-0000-11dd-a000-000eddcccccc','serial':'4192030916','model':'ULXD4','firmware':'2.3.34.0','ip':'127.0.0.2'}
def page():
    return {'pageInfo':{'hasNextPage':False},'edges':[{'node':{
        'deviceState':'ONLINE','compatibility':'INCOMPATIBLE_TOO_OLD',
        'hardwareIdentity':{'deviceId':ID['device_id'],'serialNumber':ID['serial']},
        'softwareIdentity':{'model':ID['model'],'firmwareVersion':ID['firmware'],'firmwareValid':True},
        'communicationProtocol':{'address':ID['ip']},'capabilities':['name','identify']}}]}

class SystemApi(unittest.TestCase):
    def test_actual_identity_and_capability_shape(self):
        c=api.SystemApiClient()
        with patch.object(c,'get',return_value=page()) as get:
            self.assertEqual(c.identity(ID['ip']),ID)
            d=c.diagnostics()[0];self.assertEqual(d['compatibility'],'INCOMPATIBLE_TOO_OLD')
            self.assertEqual(d['capabilities'],['name','identify']);self.assertNotIn('rf_band',d)
            self.assertEqual(get.call_args.args,('/api/v1/devices?first=1000',))
    def test_offline_invalid_and_conflicting_identity_rejected(self):
        for section,key,value in [('softwareIdentity','firmwareValid',False),('softwareIdentity','model','UNKNOWN'),('hardwareIdentity','serialNumber',''),('hardwareIdentity','deviceId','not-uuid')]:
            p=page();p['edges'][0]['node'][section][key]=value
            self.assertIsNone(api.identity_from_response(p,ID['ip']))
        p=page();p['edges'][0]['node']['deviceState']='OFFLINE';self.assertIsNone(api.identity_from_response(p,ID['ip']))
        p=page();p['edges'].append(copy.deepcopy(p['edges'][0]));self.assertIsNone(api.identity_from_response(p,ID['ip']))
    def test_pagination_encodes_cursor_and_refuses_partial_identity(self):
        a=page();a['pageInfo']={'hasNextPage':True,'endCursor':'a/b?x=1&y'}
        b={'pageInfo':{'hasNextPage':False},'edges':[]};c=api.SystemApiClient()
        with patch.object(c,'get',side_effect=[a,b]) as get:
            self.assertEqual(c.identity(ID['ip']),ID);self.assertTrue(get.call_args.args[0].endswith('a%2Fb%3Fx%3D1%26y'))
        with patch.object(c,'get',side_effect=[a,api.SystemApiError('LOCAL_API_UNAVAILABLE')]):self.assertIsNone(c.identity(ID['ip']))
        with patch.object(c,'get',side_effect=[a,a]):
            with self.assertRaisesRegex(api.SystemApiError,'DUPLICATE'):c.devices()
    def test_transport_is_local_verified_get_and_no_secret_in_errors(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);(root/'systemapicertificate.cer').write_bytes(b'fixture-cert');(root/'SharedKey.txt').write_text('fixture-private-key')
            c=api.SystemApiClient(security=root)
            with patch.object(api.ssl,'create_default_context') as ssl_context,patch.object(api.urllib.request,'build_opener') as make:
                response=make.return_value.open.return_value.__enter__.return_value;response.read.return_value=json.dumps(page()).encode()
                c.get('/api/v1/devices?first=1000')
                request=make.return_value.open.call_args.args[0]
                self.assertEqual(request.full_url,api.ORIGIN+'/api/v1/devices?first=1000');self.assertEqual(request.method,'GET')
                self.assertEqual(make.return_value.open.call_args.kwargs['timeout'],2)
                handlers=make.call_args.args;self.assertEqual(handlers[0].proxies,{})
                self.assertIsInstance(handlers[-1],api.NoRedirect);ssl_context.return_value.load_verify_locations.assert_called_once()
                response.read.return_value=b'x'*(api.MAX_RESPONSE+1)
                with self.assertRaisesRegex(api.SystemApiError,'TOO_LARGE'):c.get('/api/v1/devices')
                make.return_value.open.side_effect=api.urllib.error.URLError(ssl.SSLError('fixture-private-key'))
                with self.assertRaisesRegex(api.SystemApiError,'LOCAL_API_TLS_FAILED') as error:c.get('/api/v1/devices')
                self.assertNotIn('fixture-private-key',str(error.exception))
                make.return_value.open.side_effect=api.urllib.error.HTTPError(api.ORIGIN,401,'fixture-private-key',{},None)
                with self.assertRaisesRegex(api.SystemApiError,'AUTH_FAILED'):c.get('/api/v1/devices')
            with self.assertRaisesRegex(api.SystemApiError,'INVALID_LOCAL_API_PATH'):c.get('https://outside.invalid/')
        self.assertIsNone(api.NoRedirect().redirect_request(None,None,None,None,None,None))
    def test_monitor_failure_clears_stale_devices_and_recovers(self):
        c=api.SystemApiClient();m=api.SystemApiMonitor(client=c,enabled=True)
        with patch.object(c,'get',return_value=page()):m.refresh()
        self.assertEqual(m.snapshot()['state'],'ready');self.assertFalse(m.snapshot()['rf_scan_supported'])
        m.value['checked_at_ms']=int(time.time()*1000)-16000;self.assertEqual(m.snapshot()['state'],'stale');self.assertEqual(m.snapshot()['devices'],[])
        with patch.object(c,'get',side_effect=api.SystemApiError('LOCAL_API_UNAVAILABLE')):m.refresh()
        self.assertEqual(m.snapshot()['state'],'unavailable');self.assertEqual(m.snapshot()['devices'],[])
        with patch.object(c,'get',return_value=page()):m.refresh()
        self.assertEqual(m.snapshot()['state'],'ready');m.stop()
    def test_response_bounds_and_malformed_pages(self):
        c=api.SystemApiClient()
        for body in ({},[],{'edges':[],'pageInfo':{}},{'edges':[{}],'pageInfo':{'hasNextPage':False}}):
            with patch.object(c,'get',return_value=body):
                with self.assertRaises(api.SystemApiError):c.devices()
        p=page();p['edges'][0]['node']['capabilities']={'scan':True}
        with patch.object(c,'get',return_value=p):
            with self.assertRaisesRegex(api.SystemApiError,'CAPABILITIES'):c.diagnostics()
    def test_diagnostics_reply_is_bounded_without_affecting_fresh_identity(self):
        c=api.SystemApiClient();m=api.SystemApiMonitor(client=c)
        with patch.object(c,'diagnostics',return_value=[{'capabilities':['x'*128]*128}]*100):m.refresh()
        v=m.snapshot();self.assertEqual(v['device_count'],100);self.assertTrue(v['truncated'])
        self.assertLess(len(json.dumps(v)),18000)
        with patch.object(c,'get',return_value=page()):self.assertEqual(c.identity(ID['ip']),ID)
