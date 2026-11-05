#!/usr/bin/env python3
"""Build and serve locally; watch GPX/config/src files and rebuild on changes."""
import argparse
import json
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from build import ROOT, build

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', action='append', help='Watch a different GPX folder; repeat for multiple folders')
parser.add_argument('--port', type=int, default=8000)
args = parser.parse_args()
local = json.loads((ROOT / 'config.local.json').read_text()) if (ROOT / 'config.local.json').exists() else {}
sources = args.source or local.get('gpxSources') or [str(ROOT / 'data/gpx')]
build(sources)
def signature():
    paths = [p for folder in [*sources, ROOT / 'src', ROOT / 'config', ROOT / 'data'] for p in Path(folder).expanduser().rglob('*') if p.is_file()]
    return tuple(sorted((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in set(paths)))
def watch():
    previous = signature()
    while True:
        time.sleep(3)
        try:
            current = signature()
            if current != previous:
                build(sources); previous = current
        except Exception as exc:
            print(f'Build failed; keeping last working version: {exc}', flush=True)
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path.split('?')[0].endswith(('.json', '.html', '.js', '.css')) or self.path == '/': self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
threading.Thread(target=watch, daemon=True).start()
server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(Handler, directory=str(ROOT / 'dist')))
print(f'Local: http://localhost:{args.port}/ — watching {", ".join(map(str, sources))}', flush=True)
try: server.serve_forever()
except KeyboardInterrupt: server.server_close()
