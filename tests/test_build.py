import importlib.util
import tempfile
import unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('build',Path(__file__).parents[1]/'scripts/build.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class BuildTests(unittest.TestCase):
    def test_new_portugal_day_uses_internal_time_and_location(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'new-record.gpx'
            path.write_text('<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="38.71" lon="-9.14"><time>2026-11-06T09:00:00Z</time></trkpt><trkpt lat="38.72" lon="-9.15"><time>2026-11-06T09:01:00Z</time></trkpt></trkseg></trk></gpx>')
            record,payload,_=module.parse_gpx(path,{})
            self.assertEqual(record['group'],'spain');self.assertEqual(record['date'],'2026-11-06');self.assertEqual(record['timezone'],'Europe/Lisbon');self.assertEqual(len(payload['chunks'][0]),2)
    def test_local_midnight_not_filename_controls_day(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'old-name.gpx'
            path.write_text('<gpx><trk><trkseg><trkpt lat="41.4" lon="2.1"><time>2026-11-06T23:30:00Z</time></trkpt><trkpt lat="41.4" lon="2.1"><time>2026-11-06T23:31:00Z</time></trkpt></trkseg></trk></gpx>')
            record,_,_=module.parse_gpx(path,{})
            self.assertEqual(record['date'],'2026-11-07')
if __name__=='__main__':unittest.main()
