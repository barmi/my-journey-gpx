#!/usr/bin/env python3
"""Compile GPX sources into a static site. Python standard library only."""
import argparse
import fcntl
import hashlib
import json
import math
import shutil
import statistics
import unicodedata
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
GROUPS = {
    'spain': {'name': '2026 스페인·포르투갈', 'zone': 'Europe/Madrid'},
    'qingdao': {'name': '2026 칭다오', 'zone': 'Asia/Shanghai'},
    'greece': {'name': '2025 그리스·튀르키예', 'zone': 'Europe/Athens'},
    'australia': {'name': '2024 시드니 일대', 'zone': 'Australia/Sydney'},
    'canada': {'name': '2023 캐나다·시애틀', 'zone': 'America/Vancouver'},
    'osaka': {'name': '2023 오사카', 'zone': 'Asia/Tokyo'},
    'geneva': {'name': '2022 제네바', 'zone': 'Europe/Zurich'},
    'amsterdam': {'name': '2022 암스테르담', 'zone': 'Europe/Amsterdam'},
    'vladivostok': {'name': '2018 블라디보스토크', 'zone': 'Asia/Vladivostok'},
    'shanghai': {'name': '2017 항저우·상하이', 'zone': 'Asia/Shanghai'},
    'korea': {'name': '한국의 산책과 일상', 'zone': 'Asia/Seoul'},
    'other': {'name': '기타 기록', 'zone': 'UTC'},
}

def group_for(lat, lon):
    if -11 < lon < 4 and 35 < lat < 44: return 'spain'
    if 125 < lon < 130 and 33 < lat < 40: return 'korea'
    if 119 < lon < 123 and 28 < lat < 38: return 'qingdao' if lat > 34 else 'shanghai'
    if 131 < lon < 133 and 42 < lat < 45: return 'vladivostok'
    if 5 < lon < 7 and 45 < lat < 48: return 'geneva'
    if 4 < lon < 5 and 51 < lat < 53: return 'amsterdam'
    if 134 < lon < 137 and 33 < lat < 36: return 'osaka'
    if -125 < lon < -110 and 45 < lat < 56: return 'canada'
    if 145 < lon < 155 and -38 < lat < -28: return 'australia'
    if 20 < lon < 38 and 35 < lat < 43: return 'greece'
    return 'other'

def first_recorded_time(path):
    """Read just the first timed track point; ignore export/metadata timestamps."""
    point_kind = None
    waypoint_time = None
    try:
        with path.open('rb') as stream:
            for event, elem in ET.iterparse(stream, events=('start', 'end')):
                tag = elem.tag.rsplit('}', 1)[-1]
                if event == 'start' and tag in ('trkpt', 'rtept', 'wpt'):
                    point_kind = tag
                elif event == 'end':
                    if tag == 'time' and point_kind and elem.text:
                        try:
                            dt = datetime.fromisoformat(elem.text.strip().replace('Z', '+00:00'))
                            if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
                            timestamp = dt.timestamp()
                            if point_kind != 'wpt': return timestamp
                            if waypoint_time is None: waypoint_time = timestamp
                        except (ValueError, OverflowError):
                            pass
                    if tag in ('trkpt', 'rtept', 'wpt'): point_kind = None
                    elem.clear()
    except (ET.ParseError, OSError):
        return None
    return waypoint_time

def select_recent_paths(paths, limit):
    if limit is None: return paths
    if limit <= 0: raise ValueError('recent_limit must be a positive integer')
    dated = [(first_recorded_time(path), path) for path in paths]
    dated = [(timestamp, path) for timestamp, path in dated if timestamp is not None]
    dated.sort(key=lambda item: (-item[0], unicodedata.normalize('NFC', str(item[1]))))
    return [path for _, path in dated[:limit]]

def parse_gpx(path, overrides):
    root = ET.parse(path).getroot()
    tag = lambda e: e.tag.rsplit('}', 1)[-1]
    parents = [e for e in root.iter() if tag(e) in ('trkseg', 'rte')]
    if not parents: parents = [root]
    chunks, originals, untimed, jumps = [], [], 0, 0
    for parent in parents:
        pts = []
        for e in parent.iter():
            if tag(e) not in ('trkpt', 'rtept', 'wpt'): continue
            lat, lon = float(e.get('lat')), float(e.get('lon'))
            if not math.isfinite(lat + lon) or not (-90 <= lat <= 90 and -180 <= lon <= 180): continue
            t = next((v.text for v in e if tag(v) == 'time'), None)
            if not t:
                untimed += 1
                originals.append((lat, lon, None))
                continue
            dt = datetime.fromisoformat(t.replace('Z', '+00:00'))
            if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
            p = [round(lat, 6), round(lon, 6), int(dt.timestamp())]
            pts.append(p); originals.append(tuple(p))
        pts.sort(key=lambda p: p[2])
        if not pts: continue
        # Keep segment boundaries. Median 15-second bins suppress stationary GPS jitter.
        bins = {}
        for p in pts: bins.setdefault(p[2] // 15, []).append(p)
        sampled = []
        for key, bucket in sorted(bins.items()):
            sampled.append([round(statistics.median(p[0] for p in bucket), 6), round(statistics.median(p[1] for p in bucket), 6), round(statistics.median(p[2] for p in bucket))])
        sampled[0] = pts[0]; sampled[-1] = pts[-1]
        if len(sampled) > 1: chunks.append(sampled)
    name = unicodedata.normalize('NFC', path.name)
    content_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    rec = {'id': hashlib.sha256((name + content_hash).encode()).hexdigest()[:16], 'contentHash': content_hash, 'name': name, 'pointCount': len(originals), 'untimed': untimed, 'duplicateOf': None}
    if not originals:
        return {**rec, 'group': 'empty', 'error': '좌표 없음'}, None, set()
    lat = statistics.median(p[0] for p in originals); lon = statistics.median(p[1] for p in originals)
    custom = overrides.get(name, {})
    group = custom.get('group', group_for(lat, lon))
    zone = custom.get('timezone', 'Europe/Lisbon' if group == 'spain' and lon < -7.5 else 'Europe/Istanbul' if group == 'greece' and lon > 26 else GROUPS.get(group, GROUPS['other'])['zone'])
    times = [p[2] for p in originals if p[2] is not None]
    date = datetime.fromtimestamp(min(times), ZoneInfo(zone)).strftime('%Y-%m-%d') if times else '날짜 없음'
    rec.update(group=group, timezone=zone, date=date, start=min(times) if times else None, end=max(times) if times else None,
               center=[round(lat, 5), round(lon, 5)], chunkCount=len(chunks))
    keys = set((p[0], p[1], p[2]) for p in originals if p[2] is not None)
    return rec, {'record': rec, 'chunks': chunks, 'overrides': custom.get('intervals', [])}, keys

def _build(sources=None, output=None, recent_limit=None):
    out = Path(output or ROOT / 'dist')
    sources = sources or [ROOT / 'data/gpx']
    overrides_file = ROOT / 'config/overrides.json'
    overrides = json.loads(overrides_file.read_text()) if overrides_file.exists() else {}
    rows, payloads, keys, seen = [], {}, {}, set()
    paths = sorted({p.resolve() for src in sources for p in Path(src).expanduser().rglob('*') if p.is_file() and p.suffix.lower() == '.gpx'})
    source_count = len(paths)
    # Select before coordinate conversion and overlap detection, to avoid processing older files.
    for path in select_recent_paths(paths, recent_limit):
        try:
            rec, payload, points = parse_gpx(path, overrides)
        except (ET.ParseError, ValueError, KeyError, OverflowError) as e:
            rec = {'id': hashlib.sha256(str(path).encode()).hexdigest()[:16], 'name': unicodedata.normalize('NFC', path.name), 'group': 'empty', 'pointCount': 0, 'error': f'읽기 오류: {e}', 'duplicateOf': None}
            payload, points = None, set()
        # Exactly identical exports in multiple watched source folders are one file.
        if rec['id'] in seen: continue
        seen.add(rec['id']); rows.append(rec); keys[rec['id']] = points
        if payload: payloads[rec['id']] = payload
    for a in rows:
        if not keys[a['id']]: continue
        candidates = [b for b in rows if b['group'] == a['group'] and b['pointCount'] > a['pointCount'] and len(keys[a['id']] & keys[b['id']]) / len(keys[a['id']]) > .98]
        if candidates: a['duplicateOf'] = max(candidates, key=lambda b: b['pointCount'])['id']
    # Assemble in a temporary sibling, so an active local page never sees half a build.
    staging = out.with_name(out.name + '-next')
    if staging.exists(): shutil.rmtree(staging)
    shutil.copytree(ROOT / 'src', staging)
    (staging / 'data/records').mkdir(parents=True)
    for id, payload in payloads.items():
        if payload['record']['duplicateOf'] is None:
            (staging / f'data/records/{id}.json').write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
    plan = json.loads((ROOT / 'data/itinerary.json').read_text())
    policy = {'recentLimit': recent_limit, 'sourceFiles': source_count, 'selectedBy': 'first-recorded-time' if recent_limit is not None else 'all'}
    fingerprint = hashlib.sha256(json.dumps([[(r['id'], r['duplicateOf']) for r in rows], overrides, plan, policy], sort_keys=True).encode()).hexdigest()[:16]
    index = {'version': fingerprint, 'generatedAt': datetime.now(timezone.utc).isoformat(), 'groups': GROUPS, 'records': rows, 'plan': plan,
             'buildPolicy': policy,
             'counts': {'files': len(rows), 'duplicates': sum(r['duplicateOf'] is not None for r in rows), 'empty': sum(r['group'] == 'empty' for r in rows)}}
    (staging / 'data/index.json').write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')))
    if out.exists(): shutil.rmtree(out)
    staging.rename(out)
    scope = f'latest {recent_limit} of {source_count}' if recent_limit is not None else f'all {source_count}'
    print(f'Built {len(rows)} GPX files ({scope}) → {out} ({index["counts"]["duplicates"]} overlapping, {index["counts"]["empty"]} empty)', flush=True)
    return index

def build(sources=None, output=None, recent_limit=None):
    (ROOT / '.cache').mkdir(exist_ok=True)
    with (ROOT / '.cache/build.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _build(sources, output, recent_limit)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', action='append', help='GPX source folder (repeatable; default data/gpx)')
    parser.add_argument('--output')
    parser.add_argument('--recent-limit', type=int, help='Include only N most recent GPX files by their first recorded point time; default all')
    args = parser.parse_args()
    if args.recent_limit is not None and args.recent_limit <= 0: parser.error('--recent-limit must be greater than zero')
    build(args.source, args.output, args.recent_limit)
