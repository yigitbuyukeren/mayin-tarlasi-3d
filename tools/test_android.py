#!/usr/bin/env python3
"""Android güvenlik sınırlarını ve hazırlanmış çevrimdışı sayfayı denetler."""
from pathlib import Path
import json
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from check import Page
import package_android

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / 'android'
ASSETS = ANDROID / 'app/src/main/assets'
NS = '{http://schemas.android.com/apk/res/android}'


class AndroidSafetyTests(unittest.TestCase):
    def test_missing_game_import_is_rejected(self):
        html = '<script type="module">import { X } from "three/addons/Missing.js";</script>'
        with self.assertRaises(SystemExit):
            package_android.verify_page_imports(html, {'build/three.module.js': b'fixture'})

    def test_unmapped_or_computed_import_is_rejected(self):
        for code in ('import X from "unknown";', 'import(variable);'):
            with self.subTest(code=code), self.assertRaises(SystemExit):
                package_android.verify_page_imports('<script type="module">' + code + '</script>', {})

    def test_unknown_asset_is_rejected_without_deleting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unexpected = root / 'unexpected.txt'
            unexpected.write_text('fixture')
            with patch.object(package_android, 'ASSETS', root):
                with self.assertRaises(SystemExit):
                    package_android.verify_asset_paths({'index.html': b'fixture'})
            self.assertTrue(unexpected.is_file())

    def test_asset_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'link').symlink_to(root / 'missing')
            with patch.object(package_android, 'ASSETS', root):
                with self.assertRaises(SystemExit):
                    package_android.verify_asset_paths({})

    def test_manifest_cannot_escape_vendor_root(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / 'SHA256SUMS.json'
            manifest.write_text(json.dumps({'version': '0.160.0', 'algorithm': 'sha256',
                                            'files': {'../outside.txt': 'a' * 64}}))
            with patch.object(package_android, 'MANIFEST', manifest):
                with self.assertRaises(SystemExit):
                    package_android.load_manifest()

    def test_manifest_has_no_network_or_dangerous_permissions_or_backup(self):
        manifest = ET.parse(ANDROID / 'app/src/main/AndroidManifest.xml').getroot()
        permissions = {element.get(NS + 'name') for element in manifest.findall('uses-permission')}
        self.assertEqual(permissions, {'android.permission.VIBRATE'})
        application = manifest.find('application')
        self.assertIsNotNone(application)
        self.assertEqual(application.get(NS + 'usesCleartextTraffic'), 'false')
        self.assertEqual(application.get(NS + 'allowBackup'), 'false')
        self.assertNotEqual(application.get(NS + 'debuggable'), 'true')
        activities = application.findall('activity')
        self.assertEqual(len(activities), 1)
        self.assertEqual(activities[0].get(NS + 'exported'), 'true')
        self.assertTrue(activities[0].findall('intent-filter'))

    def test_no_native_javascript_bridge(self):
        sources = list((ANDROID / 'app/src/main').rglob('*.java'))
        self.assertTrue(sources, 'Java uygulama kaynağı bulunamadı')
        text = '\n'.join(path.read_text() for path in sources)
        self.assertNotRegex(text, r'\baddJavascriptInterface\s*\(')
        self.assertNotIn('handler.proceed()', text)
        self.assertIn('MIXED_CONTENT_NEVER_ALLOW', text)
        self.assertIn('WebViewAssetLoader', text)
        self.assertRegex(text, r'setAllowFileAccess\(false\)')
        self.assertRegex(text, r'setAllowContentAccess\(false\)')

    def test_packaging_does_not_modify_web_source(self):
        source = (ROOT / 'index.html').read_text()
        self.assertIn('https://cdn.jsdelivr.net/npm/three@0.160.0/', source)
        self.assertIn("connect-src 'none'", source)
        self.assertIn('fonts.googleapis.com', source)

    def test_native_back_returns_boolean_not_double_encoded_json(self):
        source = next((ANDROID / 'app/src/main').rglob('MainActivity.java')).read_text()
        declaration = re.search(r'private static final String JS_BACK\s*=\s*(.*?);\n', source, re.S)
        self.assertIsNotNone(declaration)
        expression = ''.join(json.loads(value) for value in re.findall(r'"(?:[^"\\]|\\.)*"', declaration[1]))
        script = (
            'const expression = ' + json.dumps(expression) + ';'
            'for (const result of [true, false]) {'
            ' globalThis.window = {mt3dApp: {back: () => result}};'
            ' if (eval(expression) !== result) throw Error("Geri sonucu boolean değil");'
            '}'
        )
        subprocess.run(['node', '-e', script], check=True, capture_output=True, text=True)

    def test_packaged_page_is_local_only(self):
        path = ASSETS / 'index.html'
        self.assertTrue(path.is_file(), 'Önce tools/package_android.py çalıştırılmalı')
        source = path.read_text()
        page = Page()
        page.feed(source)
        self.assertIn("connect-src 'none'", source)
        policies = re.findall(r'<meta[^>]+http-equiv=["\']Content-Security-Policy["\'][^>]+>', source, re.I)
        self.assertEqual(len(policies), 1)
        self.assertNotRegex(policies[0], r'https?://|\*')
        self.assertFalse([url for url in page.urls if re.match(r'(?:https?:)?//', url)])
        maps = [json.loads(body)['imports'] for attrs, body in page.scripts if attrs.get('type') == 'importmap']
        self.assertEqual(len(maps), 1)
        for name, target in maps[0].items():
            self.assertNotRegex(target, r'^(?:[a-z]+:|//)', name)
            resolved = (ASSETS / target).resolve()
            self.assertTrue(resolved.is_relative_to(ASSETS.resolve()), name)
            self.assertTrue(resolved.exists(), name)


if __name__ == '__main__':
    unittest.main()
