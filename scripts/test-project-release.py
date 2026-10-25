"""A delivery must never combine current source with stale/tampered executables."""
import json, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import project_release as release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='daty-release-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'config').mkdir()
        (self.root/'config/project-development.json').write_text(json.dumps({'native_output': 'native/publish/test'}))
        self.output = self.root/'native/publish/test'
        self.output.mkdir(parents=True)
        for name in ('DATY.RF.Native.exe', 'DATY.RF.Native.dll', 'hostfxr.dll', 'coreclr.dll', 'PresentationFramework.dll'):
            (self.output/name).write_bytes(b'test fixture')
        (self.root/release.ENTRY).write_bytes(b'entry fixture')
        release.record(self.root, 'current', True)

    def test_complete_release(self):
        self.assertEqual(len(release.verify(self.root, 'current')['files']), 6)

    def test_old_commit(self):
        with self.assertRaisesRegex(ValueError, 'committed sources'): release.verify(self.root, 'new')

    def test_dirty_build(self):
        release.record(self.root, 'current', False)
        with self.assertRaisesRegex(ValueError, 'committed sources'): release.verify(self.root, 'current')

    def test_changed_root_entry(self):
        (self.root/release.ENTRY).write_bytes(b'another entry')
        with self.assertRaisesRegex(ValueError, 'missing/changed'): release.verify(self.root, 'current')

    def test_missing_runtime(self):
        (self.output/'coreclr.dll').unlink()
        with self.assertRaisesRegex(ValueError, 'Self-contained release missing'): release.verify(self.root, 'current')

    def test_extra_stale_assembly(self):
        (self.output/'old.dll').write_bytes(b'stale')
        with self.assertRaisesRegex(ValueError, 'file list changed'): release.verify(self.root, 'current')


if __name__ == '__main__': unittest.main()
