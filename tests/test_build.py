import importlib.util
import tempfile
import unittest
import json
from pathlib import Path
spec=importlib.util.spec_from_file_location('build',Path(__file__).parents[1]/'scripts/build.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class BuildTests(unittest.TestCase):
    def test_recent_selection_ignores_filename_mtime_and_export_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            older=root/'9999-future-name.gpx'
            newer=root/'0000-old-name.gpx'
            untimed=root/'no-time.gpx'
            older.write_text('<gpx><metadata><time>2099-01-01T00:00:00Z</time></metadata><trk><trkseg><trkpt lat="37" lon="127"><time>2026-11-01T10:00:00Z</time></trkpt></trkseg></trk></gpx>')
            newer.write_text('<gpx><trk><trkseg><trkpt lat="37" lon="127"><time>2026-11-06T10:00:00Z</time></trkpt></trkseg></trk></gpx>')
            untimed.write_text('<gpx><trk><trkseg><trkpt lat="37" lon="127"/></trkseg></trk></gpx>')
            self.assertEqual(module.select_recent_paths([older,newer,untimed],1),[newer])
            self.assertEqual(len(module.select_recent_paths([older,newer,untimed],None)),3)

    def test_local_keeps_all_and_pages_rolls_forward_with_new_gpx(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); source=root/'source'; source.mkdir()
            def write(name,date):
                (source/name).write_text(f'<gpx><trk><trkseg><trkpt lat="41.4" lon="2.1"><time>{date}T10:00:00Z</time></trkpt><trkpt lat="41.4" lon="2.1"><time>{date}T10:01:00Z</time></trkpt></trkseg></trk></gpx>')
            for day in range(1,23):write(f'{23-day:02}.gpx',f'2026-10-{day:02}')
            local=module.build([source],root/'local')
            pages=module.build([source],root/'pages',recent_limit=20)
            self.assertEqual(local['counts']['files'],22)
            self.assertEqual(pages['counts']['files'],20)
            self.assertEqual(min(r['date'] for r in pages['records']),'2026-10-03')
            write('new-day.gpx','2026-11-06')
            updated=module.build([source],root/'pages',recent_limit=20)
            self.assertEqual(updated['counts']['files'],20)
            self.assertEqual(updated['buildPolicy']['sourceFiles'],23)
            self.assertEqual(min(r['date'] for r in updated['records']),'2026-10-04')
            self.assertIn('new-day.gpx',[r['name'] for r in updated['records']])
            self.assertEqual(len(list(source.glob('*.gpx'))),23)
            published=json.loads((root/'pages/data/index.json').read_text())
            expected={r['id']+'.json' for r in published['records'] if not r['duplicateOf'] and r['group']!='empty'}
            self.assertEqual({p.name for p in (root/'pages/data/records').glob('*.json')},expected)

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
