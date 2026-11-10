#!/usr/bin/env python3
"""Mayın Tarlası 3D tek dosyalık sayfayı denetler.

- Zorunlu meta etiketlerini, başlığı ve benzersiz id'leri kontrol eder.
- Dış istekleri izinli ve sürümü sabitlenmiş kaynaklarla sınırlar.
- Satır içi JavaScript'i `node --check` ile sözdizimsel olarak doğrular.
- Gizli anahtar benzeri metin ve beklenmeyen ağ hedefi arar.

Kullanım: python3 tools/check.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
THREE_VERSION = "0.160.0"
ALLOWED_HOSTS = {"cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"}
SECRET = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}"
)
REQUIRED = {
    'lang="tr"': '<html lang="tr">',
    'type="importmap"': 'Three.js içe aktarma haritası',
    'name="viewport"': "mobil görünüm",
    'name="description"': "sayfa açıklaması",
    "Content-Security-Policy": "içerik güvenlik politikası",
    "<title>": "sayfa başlığı",
    "<h1": "ana başlık",
}


class Page(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: list[str] = []
        self.urls: list[str] = []
        self.scripts: list[tuple[dict[str, str], str]] = []
        self._script_attrs: dict[str, str] | None = None
        self._script_body: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key: value or "" for key, value in attrs}
        if values.get("id"):
            self.ids.append(values["id"])
        for key in ("href", "src"):
            if values.get(key):
                self.urls.append(values[key])
        if tag == "script":
            self._script_attrs = values
            self._script_body = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._script_attrs is not None:
            self.scripts.append((self._script_attrs, "".join(self._script_body)))
            self._script_attrs = None
            self._script_body = []

    def handle_data(self, data: str) -> None:
        if self._script_attrs is not None:
            self._script_body.append(data)


def check_urls(page: Page) -> list[str]:
    errors: list[str] = []
    for raw in page.urls:
        url = urlparse(raw if not raw.startswith("//") else "https:" + raw)
        if url.scheme not in {"http", "https"} or not url.netloc:
            continue
        if url.hostname not in ALLOWED_HOSTS:
            errors.append(f"izin verilmeyen ağ hedefi: {raw}")
        elif "cdn.jsdelivr.net" in raw and f"three@{THREE_VERSION}" not in raw:
            errors.append(f"Three.js sürümü sabit değil: {raw}")
    return errors


def check_scripts(page: Page) -> list[str]:
    errors: list[str] = []
    importmap: dict[str, str] | None = None
    for attrs, body in page.scripts:
        kind = attrs.get("type", "")
        if attrs.get("src"):
            errors.append(f"harici betik yasak: {attrs['src']}")
            continue
        if kind == "importmap":
            try:
                importmap = json.loads(body)["imports"]
            except (json.JSONDecodeError, KeyError, TypeError) as exc:
                errors.append(f"importmap okunamadı: {exc}")
                continue
            for name, target in importmap.items():
                if not target.startswith("https://cdn.jsdelivr.net/npm/three@" + THREE_VERSION):
                    errors.append(f"importmap hedefi beklenmiyor: {name} -> {target}")
            continue
        if not body.strip():
            continue
        suffix = ".mjs" if kind == "module" else ".js"
        with tempfile.NamedTemporaryFile("w", suffix=suffix, encoding="utf-8") as temp:
            temp.write(body)
            temp.flush()
            result = subprocess.run(
                ["node", "--check", temp.name], capture_output=True, text=True
            )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip().splitlines()
            errors.append("betik sözdizimi: " + (detail[-1] if detail else "bilinmeyen hata"))
    if importmap is None:
        errors.append("importmap bulunamadı")
    else:
        for name in ("three", "three/addons/"):
            if name not in importmap:
                errors.append(f"importmap eksik: {name}")
    return errors


def main() -> int:
    if not INDEX.is_file():
        print(f"HATA: {INDEX.name} bulunamadı", file=sys.stderr)
        return 1
    source = INDEX.read_text(encoding="utf-8")
    page = Page()
    page.feed(source)
    page.close()

    errors: list[str] = []
    for marker, label in REQUIRED.items():
        if marker not in source:
            errors.append(f"eksik {label} ({marker})")
    if "connect-src 'none'" not in source:
        errors.append("CSP connect-src 'none' içermeli")
    for key, count in Counter(page.ids).items():
        if count > 1:
            errors.append(f"tekrarlanan id: {key}")
    errors += check_urls(page)
    errors += check_scripts(page)
    if SECRET.search(source):
        errors.append("gizli anahtar benzeri metin var")
    if "mt3d-v1-" not in source:
        errors.append("beklenen localStorage anahtar öneki (mt3d-v1-) yok")

    if errors:
        for error in errors:
            print(f"HATA: {error}", file=sys.stderr)
        return 1
    print(
        f"OK index.html: {len(page.ids)} id, {len(page.scripts)} betik, "
        f"{len(set(page.ids))} benzersiz kimlik"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
