import socket
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shure_metering import BatteryRefresh, ShureMeterSession, decode_sample
from shure_protocol import extract_framed_messages


class MeterPeer:
    """Local protocol peer with varying levels, stale metadata and reconnects."""
    def __init__(self, model='ULXD4D', external_rate=False):
        self.socket = socket.socket(); self.socket.bind(('127.0.0.1', 0)); self.socket.listen(4)
        self.socket.settimeout(.1); self.port = self.socket.getsockname()[1]
        self.stop = threading.Event(); self.commands = []; self.connections = 0
        self.model, self.external_rate = model, external_rate
        self.thread = threading.Thread(target=self.run, daemon=True); self.thread.start()

    def run(self):
        while not self.stop.is_set():
            try: conn, _ = self.socket.accept()
            except socket.timeout: continue
            except OSError: break
            self.connections += 1
            with conn:
                conn.settimeout(.02); pending = ''; samples = False; sent = 0; start = time.monotonic()
                try:
                    while not self.stop.is_set():
                        try:
                            chunk = conn.recv(8192)
                            if not chunk: break
                            frames, pending = extract_framed_messages(pending + chunk.decode())
                            for frame in frames:
                                self.commands.append(frame)
                                if frame == 'GET MODEL': conn.sendall(f'< REP MODEL {{{self.model}}} >'.encode())
                                elif frame == 'GET 0 ALL':
                                    conn.sendall(b'< REP 1 FREQUENCY 677450 >< REP 2 FREQUENCY 678000 >< REP 1 AUDIO_LVL 000 >< REP 1 BATT_BARS 004 >')
                                elif 'GET' in frame and 'METER_RATE' in frame:
                                    ch = frame.split()[1]; conn.sendall(f'< REP {ch} METER_RATE 00200 >'.encode())
                                elif frame.startswith('SET'):
                                    _, ch, key, rate = frame.split()
                                    conn.sendall(f'< REP {ch} {key} {rate} >'.encode()); samples = rate == '00100'
                        except socket.timeout: pass
                        if samples and sent < 12 and time.monotonic()-start > sent*.04:
                            ch = sent % 2 + 1; af = 10 + sent * 3
                            raw = f'< SAMPLE {ch} ALL AX 090 {af:03d} >'.encode()
                            conn.sendall(raw[:14]); time.sleep(.001); conn.sendall(raw[14:]); sent += 1
                            if sent == 12 and self.external_rate:
                                conn.sendall(b'< REP 1 METER_RATE 00300 >< REP 2 METER_RATE 00300 >')
                        # Thereafter keep serving GET but no SAMPLE to prove
                        # metadata does not revive a frozen audio meter.
                except OSError: pass

    def close(self):
        self.stop.set(); self.socket.close(); self.thread.join(2)


class BatteryPeer(MeterPeer):
    """Battery appears only on a query after TX startup; GET ALL stays unknown."""
    def run(self):
        try:
            while not self.stop.is_set():
                try: conn, _ = self.socket.accept()
                except socket.timeout: continue
                self.connections += 1
                with conn:
                    conn.settimeout(.01); pending = ''; samples = False
                    start = time.monotonic(); last = start; sent = 0
                    while not self.stop.is_set():
                        try:
                            chunk = conn.recv(8192)
                            if not chunk: break
                            frames, pending = extract_framed_messages(pending + chunk.decode())
                            for frame in frames:
                                self.commands.append(frame)
                                if frame == 'GET MODEL': conn.sendall(b'< REP MODEL {ULXD4D} >')
                                elif frame == 'GET 0 ALL':
                                    conn.sendall(b'< REP 1 FREQUENCY 677450 >< REP 2 FREQUENCY 678000 >< REP 1 BATT_BARS 255 >< REP 2 BATT_BARS 255 >')
                                elif frame.startswith('GET') and 'METER_RATE' in frame:
                                    ch = frame.split()[1]; conn.sendall(f'< REP {ch} METER_RATE 00200 >'.encode())
                                elif frame.startswith('SET'):
                                    _, ch, key, rate = frame.split()
                                    # Stop closes the client after restoring both
                                    # channels; no reply reader remains then.
                                    if rate == '00100': conn.sendall(f'< REP {ch} {key} {rate} >'.encode())
                                    samples = rate == '00100'
                                elif frame.startswith('GET') and 'BATT_' in frame:
                                    _, ch, key = frame.split()
                                    # CH1 comes online at .15s, battery ready at .4s;
                                    # CH2 stays offline and unknown independently.
                                    value = '000' if ch == '1' and key == 'BATT_BARS' and time.monotonic()-start >= .4 else '255'
                                    conn.sendall(f'< REP {ch} {key} {value} >'.encode())
                        except socket.timeout: pass
                        now = time.monotonic()
                        if samples and now-last >= .025:
                            antenna = 'AX' if now-start >= .15 else 'XX'
                            conn.sendall(f'< SAMPLE 1 ALL {antenna} 090 {10+sent%35:03d} >< SAMPLE 2 ALL XX 000 000 >'.encode())
                            sent += 1; last = now
        except OSError: pass


def receiver():
    return {'ip':'127.0.0.1','receiver_ip':'127.0.0.1','receiver_id':'Shure-ULXD4D-127.0.0.1',
        'model':'ULXD4D','protocol_verified':True,'version':'fixture',
        'channels':{'1':{'channel_number':1,'frequency_khz':677450}, '2':{'channel_number':2,'frequency_khz':678000}}}


def wait_for(predicate, seconds=3):
    end = time.monotonic()+seconds
    while time.monotonic()<end:
        if predicate(): return
        time.sleep(.01)
    raise AssertionError('condition timeout')


class MeterTests(unittest.TestCase):
    def test_battery_unknown_backoff_and_zero_is_known(self):
        schedule = BatteryRefresh(2)
        self.assertEqual(schedule.due(0), [1, 2])
        schedule.observe(1, {'BATT_BARS':'000'}, {'battery_bars':0})
        schedule.observe(1, {'BATT_CHARGE':'255'}, {'battery_percent':None})
        self.assertEqual(schedule.due(.25), [2])
        self.assertEqual(schedule.due(.75), [2])
        self.assertEqual(schedule.due(1), [1])
        self.assertEqual(schedule.due(1.75), [2])
        self.assertEqual(schedule.due(2), [1])
        # Percentage alone, including zero, is enough for a normal cadence.
        schedule.observe(2, {'BATT_CHARGE':'000'}, {'battery_percent':0})
        self.assertEqual(schedule.due(2.5), [])

    def test_battery_rf_onset_rearms_without_flapping_flood(self):
        schedule = BatteryRefresh(1); queries = []
        for step in range(401):
            now = step / 100
            schedule.sample(1, 'AX' if step % 2 else 'XX', now)
            if schedule.due(now): queries.append(now)
        self.assertLessEqual(len(queries), 17)
        self.assertTrue(all(b-a >= .249 for a,b in zip(queries,queries[1:])))
        # A new transmitter gets fresh reads even if the old battery was known.
        schedule.observe(1, {'BATT_BARS':'004'}, {'battery_bars':4})
        schedule.sample(1, 'XX', 5); schedule.sample(1, 'XB', 5.01)
        self.assertEqual(schedule.due(5.01), [1])
        self.assertEqual(schedule.due(5.26), [1])

    def test_delayed_battery_zero_arrives_before_slow_metadata_without_meter_loss(self):
        peer=BatteryPeer(); received=[]; began=time.monotonic()
        session=ShureMeterSession(receiver(),lambda r:received.append((time.monotonic()-began,r)),port=peer.port)
        try:
            session.start()
            wait_for(lambda:any(v.get('battery_bars')==0 for _,r in received for v in r['channels'].values()),2)
            time.sleep(1.2)
            batteries=[(t,v) for t,r in received for v in r['channels'].values() if v.get('battery_bars')==0]
            self.assertEqual(len(batteries),1,'unchanged battery replies must not create duplicate updates')
            onset=min(t for t,r in received for v in r['channels'].values() if v.get('rf_antenna')=='AX')
            self.assertLess(batteries[0][0]-onset,1)
            live=[(t,v) for t,r in received for v in r['channels'].values() if v.get('meter_state')=='live']
            self.assertEqual([v['meter_seq'] for _,v in live],list(range(1,len(live)+1)))
            self.assertGreater(len({v['audio_dbfs'] for _,v in live}),10)
            ch1=[t for t,v in live if v['channel_number']==1]
            self.assertLess(max(b-a for a,b in zip(ch1,ch1[1:])),.3)
            self.assertFalse(any(v.get('battery_bars')==0 for _,r in received for ch,v in r['channels'].items() if ch=='2'))
            self.assertEqual(peer.commands.count('GET 0 ALL'),1)
            self.assertLessEqual(peer.commands.count('GET 2 BATT_BARS'),5)
        finally:session.stop();session.thread.join(2);peer.close()

    def test_model_specific_frame_validation(self):
        self.assertEqual(decode_sample('ULXD4', 'SAMPLE 1 ALL AX 090 037'),
            (1, {'rf_antenna':'AX','rf_dbm':-38,'audio_dbfs':-13,'audio_raw':37,'rf_raw':90}))
        for model, frame in [('AD4D','SAMPLE 1 ALL AX 090 037'),('ULXD4','SAMPLE 2 ALL AX 090 037'),
            ('ULXD4','SAMPLE 1 ALL AX 090 037 extra'),('ULXD4','SAMPLE 1 ALL AF 090 037'),
            ('ULXD4','SAMPLE 1 ALL AX 999 037'),('ULXD4','REP 1 ALL AX 090 037')]:
            self.assertIsNone(decode_sample(model, frame))

    def test_fragmented_multichannel_stream_stale_metadata_and_restoration(self):
        peer=MeterPeer(); received=[]
        session=ShureMeterSession(receiver(),received.append,port=peer.port,metadata_interval=.1,stale_after=.2)
        try:
            session.start()
            wait_for(lambda: sum(v.get('meter_state')=='live' for r in received for v in r['channels'].values())==12)
            wait_for(lambda: any(v.get('meter_state')=='stale' for r in received for v in r['channels'].values()))
            samples=[v for r in received for v in r['channels'].values() if v.get('meter_state')=='live']
            self.assertEqual([s['audio_dbfs'] for s in samples], [10+n*3-50 for n in range(12)])
            self.assertEqual([s['meter_seq'] for s in samples],list(range(1,13)))
            self.assertEqual({s['channel_number'] for s in samples},{1,2})
            self.assertTrue(all(v.get('audio_dbfs')!= -50 for r in received for v in r['channels'].values()))
            self.assertTrue(all(not r['observation_received'] for r in received if any(v.get('meter_state')=='stale' for v in r['channels'].values())))
        finally:
            session.stop();session.thread.join(2);time.sleep(.05);peer.close()
        self.assertFalse(session.thread.is_alive())
        for ch in (1,2): self.assertIn(f'SET {ch} METER_RATE 00200',peer.commands)
        self.assertTrue(all('METER_RATE' in c for c in peer.commands if c.startswith('SET')))

    def test_observed_external_rate_is_not_overwritten_on_stop(self):
        peer=MeterPeer(external_rate=True);received=[]
        session=ShureMeterSession(receiver(),received.append,port=peer.port)
        try:
            session.start();wait_for(lambda: sum(v.get('meter_state')=='live' for r in received for v in r['channels'].values())==12)
            time.sleep(.15)
        finally:
            session.stop();session.thread.join(2);time.sleep(.05);peer.close()
        self.assertFalse(any(c.endswith('00200') for c in peer.commands if c.startswith('SET')))

    def test_wrong_model_never_enables_meters(self):
        peer=MeterPeer(model='AD4D'); session=ShureMeterSession(receiver(),lambda r:None,port=peer.port,retry_delay=.05)
        try:
            session.start();wait_for(lambda: peer.connections>=2)
        finally:session.stop();session.thread.join(2);peer.close()
        self.assertFalse(any(c.startswith('SET') for c in peer.commands))

    def test_stalled_stream_reconnects_with_new_session(self):
        peer=MeterPeer();received=[]
        session=ShureMeterSession(receiver(),received.append,port=peer.port,metadata_interval=.1,stale_after=.1,retry_delay=.05)
        try:
            session.start()
            wait_for(lambda: len({v['meter_stream_id'] for r in received for v in r['channels'].values() if v.get('meter_state')=='live'})==2,5)
        finally:session.stop();session.thread.join(2);peer.close()
        self.assertTrue(any(v.get('meter_state')=='disconnected' for r in received for v in r['channels'].values()))

if __name__=='__main__': unittest.main()
