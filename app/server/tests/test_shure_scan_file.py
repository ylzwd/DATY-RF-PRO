"""Synthetic malformed inputs and an optional external, user-provided WWB file."""
import copy,hashlib,json,os,struct,sys,unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'app/server'))
from shure_scan_file import parse_scan,crc16_arc,ScanFileError


def fixture(count=3):
    header={'Version':'1.0.0.0','ScannerModel':'ULXD4','FreqUnits':'KHz','AmplUnits':'dBm',
            'BitWidth':16,'Scale Factor':10,'NoDataValue':-1400,
            'BinarySchema':[{'Bytes':4,'DataValue':v} for v in ('start-of-sweep','id','timestamp')]+
            [{'Curve':{'Name':'测试 @Binary:','FreqRanges':[{'StartFreq':632125,'EndFreq':632125+(count-1)*25,'StepFreq':25}]}},
             {'Bytes':2,'DataValue':'crc16'}]}
    return header,[-900]*(count-1)+[-1400]


def make_file(header,values,footer=(1,2)):
    raw=b'//@ShureScan\n'+json.dumps(header,ensure_ascii=False).encode()+b'\n@Binary:'
    for identity in (1,0):
        record=b'@Swp'+struct.pack('>II',identity,0)+struct.pack('>'+str(len(values))+'h',*values)
        raw+=record+struct.pack('>H',crc16_arc(record))
    return raw+b'@Extended:\n'+json.dumps({'AppendedSpecialSweeps':['Appended peakhold'],'Band':'L51'}).encode()+b'\n@End'+struct.pack('>II',*footer)


class Decode(unittest.TestCase):
    def assert_code(self,raw,code):
        with self.assertRaises(ScanFileError) as caught:parse_scan(raw)
        self.assertEqual(caught.exception.code,code)
    def test_units_missing_value_and_two_independent_records(self):
        h,v=fixture();raw=make_file(h,v);doc=parse_scan(raw)
        self.assertEqual(doc['records'][0]['points'],[[632125,-90.0],[632150,-90.0],[632175,None]])
        self.assertEqual([r['id_raw'] for r in doc['records']],[1,0])
        self.assertEqual([r['missing_points'] for r in doc['records']],[1,1])
        self.assertEqual(doc['device_scan_state'],'unknown');self.assertIsNone(doc['receiver_identity'])
        self.assertEqual(doc['file_sha256'],hashlib.sha256(raw).hexdigest())
        doc['records'][0]['points'][0][1]=0
        self.assertEqual(doc['records'][1]['points'][0][1],-90)
    def test_truncation_cannot_be_a_completed_device_scan(self):
        h,v=fixture();raw=make_file(h,v)
        for cut in (12,30,raw.index(b'@Binary:')+8,raw.index(b'@Swp')+13,*range(len(raw)-15,len(raw))):
            with self.subTest(cut=cut),self.assertRaises(ScanFileError):parse_scan(raw[:cut])
    def test_crc_and_footer_corruption_fail_closed(self):
        h,v=fixture();raw=bytearray(make_file(h,v));raw[raw.index(b'@Swp')+12]^=1
        self.assert_code(bytes(raw),'SCAN_CRC_MISMATCH')
        self.assert_code(make_file(h,v,(1,1)),'SCAN_UNSUPPORTED_FOOTER')
        self.assert_code(make_file(h,v)+b'garbage','SCAN_UNSUPPORTED_FOOTER')
    def test_unknown_layout_units_version_and_range_are_rejected(self):
        h,v=fixture()
        for key,value in [('BitWidth',32),('BitWidth',True),('Scale Factor',1),('FreqUnits','MHz'),('ScannerModel','AD4'),('NoDataValue',0),('Version','2')]:
            changed=copy.deepcopy(h);changed[key]=value
            self.assert_code(make_file(changed,v),'SCAN_UNSUPPORTED_PROFILE')
        for field,value in [('StepFreq',0),('StepFreq',True),('EndFreq',632170),('StartFreq',-1),('EndFreq',10000001)]:
            changed=copy.deepcopy(h);changed['BinarySchema'][3]['Curve']['FreqRanges'][0][field]=value
            self.assert_code(make_file(changed,v),'SCAN_INVALID_GRID')
        changed=copy.deepcopy(h);changed['BinarySchema'][0]['Bytes']=8
        self.assert_code(make_file(changed,v),'SCAN_UNSUPPORTED_LAYOUT')
    def test_duplicate_invalid_json_and_resource_limits(self):
        h,v=fixture();raw=make_file(h,v)
        self.assert_code(raw.replace(b'"BitWidth": 16',b'"BitWidth": 16, "BitWidth": 16'),'SCAN_DUPLICATE_JSON_KEY')
        self.assert_code(raw.replace(b'"BitWidth": 16',b'"BitWidth": NaN'),'SCAN_INVALID_JSON')
        self.assert_code(b'x'*131073,'SCAN_FILE_SIZE')
        h['BinarySchema'][3]['Curve']['FreqRanges'][0]['EndFreq']=632125+30000*25
        self.assert_code(make_file(h,v),'SCAN_POINT_LIMIT')
        h,v=fixture();self.assert_code(make_file(h,[-3000,-900,-1400]),'SCAN_LEVEL_OUT_OF_RANGE')
    def test_cancel_before_and_during_decode_returns_no_partial_result(self):
        h,v=fixture();raw=make_file(h,v)
        for after in (0,1,2,3):
            counter=[0]
            def cancelled():counter[0]+=1;return counter[0]>after
            with self.assertRaises(ScanFileError) as caught:parse_scan(raw,cancelled)
            self.assertEqual(caught.exception.code,'SCAN_READ_CANCELLED')
    @unittest.skipUnless(os.environ.get('DATY_WWB_TEST_SAMPLE'),'External WWB sample was not specified')
    def test_user_wwb_all_points_and_independent_crc_reference(self):
        # The original user file remains outside Git. No writes to it.
        raw=Path(os.environ['DATY_WWB_TEST_SAMPLE']).read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(),'19f94c569200c8bda81d1c7b9370e78f1ee6fd7b802f0299ab5cd631308de753')
        doc=parse_scan(raw);self.assertEqual(doc['point_count_per_record'],2551)
        for offset,record,crc in zip((975,6091),doc['records'],('4481','ff13')):
            # Independent fixed file offsets and struct decode, not parser fields.
            values=struct.unpack_from('>2551h',raw,offset+12)
            expected=[[632125+i*25,None if value==-1400 else value/10] for i,value in enumerate(values)]
            self.assertEqual(record['points'],expected);self.assertEqual(record['crc16'],crc)
            self.assertEqual((record['valid_points'],record['missing_points']),(2550,1))
            self.assertEqual(max((p for p in expected if p[1] is not None),key=lambda p:p[1]),[649375,-14])
        self.assertEqual(doc['extended']['Band'],'L51');self.assertEqual(doc['file_state'],'validated')


if __name__=='__main__':unittest.main()
