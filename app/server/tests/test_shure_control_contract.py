import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from shure_control_contract import prepare_frequency_change, frequency_readback_matches, control_readiness

class ControlPreparation(unittest.TestCase):
    def preview(self,**changes):
        return prepare_frequency_change(**dict(dict(model='ULXD4',receiver_id='stable-id',channel=1,
            frequency_khz=677450,band_min_khz=670000,band_max_khz=700000,step_khz=25,origin_khz=0),**changes))
    def test_checked_preview_is_never_a_send_or_ack(self):
        p=self.preview();self.assertEqual(p['set_preview'],'< SET 1 FREQUENCY 677450 >')
        self.assertEqual(p['readback_query'],'< GET 1 FREQUENCY >')
        self.assertFalse(p['sent']);self.assertFalse(p['write_enabled']);self.assertFalse(p['execution_ack_supported'])
        self.assertFalse(control_readiness('ULXD4')['hardware_band_verified'])
    def test_exact_channel_frequency_and_reply_required(self):
        p=self.preview();self.assertTrue(frequency_readback_matches(p,'REP 1 FREQUENCY 677450'))
        for raw in ('REP 2 FREQUENCY 677450','REP 1 FREQUENCY 677475','REP ERR','REP 1 AUDIO_GAIN 029',
                    'SAMPLE 1 FREQUENCY 677450','SET 1 FREQUENCY 677450'):
            self.assertFalse(frequency_readback_matches(p,raw))
    def test_invalid_model_channel_band_grid_and_non_integer_refused(self):
        for changes in (dict(model='QLXD4'),dict(model='AD4D'),dict(channel=2),dict(channel=True),
                dict(frequency_khz=677450.1),dict(frequency_khz=677451),dict(frequency_khz=710000),
                dict(step_khz=0),dict(receiver_id='')):
            with self.assertRaises(ValueError):self.preview(**changes)

if __name__=='__main__':unittest.main()
