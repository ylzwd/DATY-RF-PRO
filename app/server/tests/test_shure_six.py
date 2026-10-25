"""Six-gap regression, synthetic fixtures only; never connects to live devices."""
import sys,time,socket,threading,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from shure_protocol import ShureReply,extract_framed_messages,parse_shure_frame,telemetry_view,MAX_FRAME
from shure_freshness import MetadataFreshness
from shure_metering import ShureMeterSession,decode_sample

SAMPLES=[
 '005 031 102 101 BB 31 086 31 065',
 '005 255 102 101 BRXB 31 083 31 068 31 069 31 072',
 '005 031 102 101 BB 31 082 31 060 RB 31 081 31 060',
 '255 031 102 101 BBBB 31 084 31 065 31 070 31 070 BRXB 31 080 31 064 31 071 31 073']
def decoded(model,*frames):
    r=ShureReply();r.feed('REP MODEL {'+model+'}')
    for frame in frames:r.feed(frame)
    return r

class GapPeer:
    def __init__(self,model='ULXD4'):
        self.model=model;self.commands=[];self.stop=threading.Event()
        self.sock=socket.socket();self.sock.bind(('127.0.0.1',0));self.sock.listen(1)
        self.port=self.sock.getsockname()[1];self.thread=threading.Thread(target=self.run,daemon=True);self.thread.start()
    def run(self):
        try:
            conn,_=self.sock.accept()
            with conn:
                conn.settimeout(.02);pending='';enabled=False;last=0
                while not self.stop.is_set():
                    try:
                        raw=conn.recv(8192)
                        if not raw:break
                        frames,pending=extract_framed_messages(pending+raw.decode())
                        for f in frames:
                            self.commands.append(f)
                            if f=='GET MODEL':conn.sendall(('< REP MODEL {'+self.model+'} >').encode())
                            elif f=='GET 0 ALL':
                                if self.model=='ULXD4':
                                    conn.sendall(b'< REP 1 FREQUENCY 677450 >< REP ENCRYPTION AUTO >< REP 1 RF_INT_DET CRITICAL >< REP 1 RF_INT_DET NONE >< REP 1 RF_INT_DET CRITICAL >< REP 1 BATT_BARS 001 >< REP 1 BATT_CHARGE 255 >')
                                else:
                                    conn.sendall(b'< REP 1 FREQUENCY 677450 >< REP 2 FREQUENCY 678000 >< REP ENCRYPTION_MODE ON >< REP 1 INTERFERENCE_STATUS DETECTED >< REP 1 INTERFERENCE_STATUS NONE >< REP 1 INTERFERENCE_STATUS DETECTED >< REP 1 TX_BATT_BARS 001 >< REP 1 TX_BATT_CHARGE_PERCENT 255 >< REP 1 TX_MUTE_MODE_STATUS MUTE >')
                            elif 'METER_RATE' in f:
                                p=f.split();ch=p[1];rate=p[-1] if p[0]=='SET' else '00200'
                                if rate=='00100':enabled=True
                                conn.sendall(f'< REP {ch} METER_RATE {rate} >'.encode())
                    except socket.timeout:pass
                    if enabled and time.monotonic()-last>.05:
                        sample='AX 090 037' if self.model=='ULXD4' else SAMPLES[0]
                        conn.sendall(f'< SAMPLE 1 ALL {sample} >'.encode());last=time.monotonic()
        except OSError:pass
    def close(self):
        self.stop.set();self.sock.close();self.thread.join(2)

class SixTests(unittest.TestCase):
    def test_discovery_detail_merges_independent_observation_times(self):
        from shure_active_discovery import ShureDiscovery
        d=ShureDiscovery(lambda update:None,auto_scan=False)
        d.meters['127.0.0.1']=object()
        d.receivers['127.0.0.1']={'channels':{'1':{'battery_bars':4,'field_times':{'battery_bars':100}}},'ts':time.time()}
        d._meter_update('127.0.0.1',{'channels':{'1':{'transmitter_type':'ULXD2','field_times':{'transmitter_type':200}}},'ts':time.time()})
        self.assertEqual(d.snapshot()['receivers'][0]['channels']['1']['field_times'],{'battery_bars':100,'transmitter_type':200})

    def test_text_special_characters_every_split_and_coalescing(self):
        for name in ('A>B','A<B','A<B>C','"&<tag>'):
            raw=f'< REP 1 CHAN_NAME {{{name:<8}}} >< REP 1 BATT_BARS 001 >'
            for split in range(len(raw)+1):
                frames,pending=extract_framed_messages(raw[:split]);next_frames,pending=extract_framed_messages(pending+raw[split:]);frames+=next_frames
                r=decoded('ULXD4',*frames).channel_values()[1]
                self.assertEqual(r['name'],name);self.assertEqual(r['battery_bars'],1);self.assertEqual(pending,'')
        self.assertEqual(parse_shure_frame('REP 1 CHAN_NAME {not closed')[0],None)
        self.assertEqual(extract_framed_messages('< abandoned < REP 1 BATT_BARS 001 >')[0],['REP 1 BATT_BARS 001'])
        with self.assertRaises(ValueError):extract_framed_messages('< {'+'a'*(MAX_FRAME+1))

    def test_encryption_and_device_conditions(self):
        for mode in ('OFF','AUTO','MANUAL'):
            r=decoded('ULXD4','REP ENCRYPTION '+mode,'REP 1 RF_INT_DET CRITICAL','REP 1 ENCRYPTION_WARNING ON')
            self.assertEqual(r.settings['encryption_mode'],mode)
            self.assertEqual(r.channel_values()[1],{'interference':'CRITICAL','encryption_warning':'ON'})
        self.assertIsNone(decoded('ULXD4','REP ENCRYPTION INVALID').settings['encryption_mode'])

    def test_ad4_battery_mute_power_and_unknowns(self):
        r=decoded('AD4D','REP 1 TX_BATT_BARS 000','REP 1 TX_BATT_CHARGE_PERCENT 255','REP 1 TX_BATT_MINS 65533',
            'REP 1 TX_BATT_HEALTH_PERCENT 095','REP 1 TX_BATT_CYCLE_COUNT 00020','REP 1 TX_BATT_TEMP_C 065',
            'REP 1 TX_MUTE_MODE_STATUS ON','REP 1 TX_POWER_LEVEL 010','REP 1 TX_DEVICE_ID {Lead A}', 'REP 1 TX_INPUT_PAD 000')
        c=r.channel_values()[1]
        self.assertEqual((c['battery_bars'],c['battery_percent'],c['battery_runtime_status']),(0,None,'error'))
        self.assertEqual((c['battery_health_percent'],c['battery_cycles'],c['battery_temperature_c']),(95,20,25))
        self.assertEqual((c['transmitter_muted'],c['transmitter_power_mw'],c['transmitter_input_pad_db']),(False,10,-12))
        self.assertEqual(c['transmitter_name'],'Lead A')
        r.feed('REP 1 TX_MUTE_MODE_STATUS MUTE');self.assertTrue(r.channel_values()[1]['transmitter_muted'])
        r.feed('REP 1 TX_MUTE_MODE_STATUS UNKNOWN');self.assertIsNone(r.channel_values()[1]['transmitter_muted'])
        for code,status in [('65534','calculating'),('65535','unknown'),('00000','known')]:
            r.feed('REP 1 TX_BATT_MINS '+code);self.assertEqual(r.channel_values()[1]['battery_runtime_status'],status)

    def test_all_ad4_meter_layouts_and_dto(self):
        for raw,layout,count in zip(SAMPLES,('standard','quadversity','fd-c','quadversity-fd-c'),(2,4,2,4)):
            ch,v=decode_sample('AD4Q','SAMPLE 1 ALL '+raw)
            self.assertEqual(v['meter_layout'],layout);self.assertEqual(v['audio_dbfs'],-19);self.assertEqual(v['audio_peak_dbfs'],-18)
            self.assertEqual(len(v['rf_antennas_dbm']),count)
            dto=telemetry_view({'model':'AD4Q'},v)
            self.assertEqual(dto['rf_branches'],v['rf_branches'])
        self.assertIsNone(decode_sample('AD4D','SAMPLE 1 ALL '+SAMPLES[1]))
        self.assertIsNone(decode_sample('AD4Q','SAMPLE 1 ALL '+SAMPLES[0]+' 001'))
        self.assertIsNone(decode_sample('AD4Q','SAMPLE 1 ALL '+SAMPLES[0].replace('086','255')))
        self.assertIsNone(decode_sample('ULXD4','SAMPLE 1 ALL AB 090 037'))

    def test_independent_field_freshness_and_explicit_null(self):
        f=MetadataFreshness(2,ttl=10)
        a=f.observe(1,{'battery_bars':4,'transmitter_type':'ULXD2'},now=0,wall_ms=100)
        f.observe(1,{'transmitter_type':'ULXD2'},now=8,wall_ms=8100)
        self.assertEqual(f.expire(now=11)['1']['stale_fields'],['battery_bars'])
        b=f.observe(1,{'battery_bars':None},now=12,wall_ms=12100)
        dto=telemetry_view({'model':'ULXD4'},{'battery_bars':4,**a})
        dto=telemetry_view({'model':'ULXD4'},{'battery_bars':None,**b},dto)
        self.assertIsNone(dto['battery_bars']);self.assertEqual(dto['stale_fields'],[])
        self.assertEqual(dto['field_times']['battery_bars'],12100)
        self.assertEqual(set(f.expire(disconnected=True)['1']['stale_fields']),{'battery_bars','transmitter_type'})

    def test_tcp_packet_preserves_each_condition_edge_and_ad4_continuous(self):
        for model in ('ULXD4','AD4D'):
            peer=GapPeer(model);received=[]
            rx={'ip':'127.0.0.1','receiver_id':'fixture','model':model,'channels':{'1':{'channel_number':1,'frequency_khz':677450}}}
            stream=ShureMeterSession(rx,received.append,port=peer.port)
            try:
                stream.start();deadline=time.monotonic()+2
                while time.monotonic()<deadline and not any(v.get('meter_seq',0)>=3 for r in received for v in r['channels'].values()):time.sleep(.01)
                vals=[v for r in received for v in r['channels'].values()]
                self.assertEqual([v['interference'] for v in vals if 'interference' in v],['CRITICAL','NONE','CRITICAL'] if model=='ULXD4' else ['DETECTED','NONE','DETECTED'])
                self.assertTrue(any(v.get('meter_seq',0)>=3 for v in vals))
                if model=='AD4D':self.assertIn('GET 1 TX_BATT_BARS',peer.commands)
                self.assertTrue(all('METER_RATE' in cmd for cmd in peer.commands if cmd.startswith('SET')))
            finally:stream.stop();stream.thread.join(2);peer.close()

if __name__=='__main__':unittest.main()
