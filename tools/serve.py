#!/usr/bin/env python3
"""Yalnız oyuna ait izinli kaynakları sunar; depo kökünü dışarı açmaz."""
import argparse
from pathlib import Path
from http.server import ThreadingHTTPServer
from test_browser import WhitelistHandler

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--android', action='store_true', help='Hazırlanmış çevrimdışı Android kaynaklarını sun')
    args = parser.parse_args()
    base = ROOT / 'android/app/src/main/assets' if args.android else ROOT
    if not (base / 'index.html').is_file():
        parser.error('Önce python3 tools/package_android.py package çalıştırın')
    handler = type('GameHandler', (WhitelistHandler,), {'base_dir': base, 'assets_mode': args.android})
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f'Oyun: http://{args.bind}:{server.server_address[1]}/ (yalnız izinli kaynaklar)', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
