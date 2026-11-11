#!/usr/bin/env python3
"""Mayın Tarlası 3D için çevrimdışı Android web paketini üretir.

Komutlar:
  python3 tools/package_android.py vendor    # Yalnız açık çağrıda Three.js dosyalarını indirir.
  python3 tools/package_android.py package   # Ağa çıkmadan vendor'ı doğrular ve asset üretir.
  python3 tools/package_android.py check     # Üretilmiş assetlerin güncel olup olmadığını denetler.

Varsayılan komut `package`'tir; hiçbir komut kendiliğinden indirme yapmaz.
Kök `index.html` hiçbir zaman değiştirilmez; Android türevi ayrı asset olarak yazılır.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
ANDROID = ROOT / "android"
VENDOR = ANDROID / "vendor" / "three-0.160.0"
ASSETS = ANDROID / "app" / "src" / "main" / "assets"
THREE_VERSION = "0.160.0"
LOCAL_ASSETS = ("web/progression.js", "web/experience.js", "web/experience.css")
ANDROID_FAVICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
THREE_BASE = f"https://cdn.jsdelivr.net/npm/three@{THREE_VERSION}/"
MANIFEST = VENDOR / "SHA256SUMS.json"
ENTRIES = (
    "build/three.module.js",
    "examples/jsm/geometries/RoundedBoxGeometry.js",
    "examples/jsm/postprocessing/EffectComposer.js",
    "examples/jsm/postprocessing/RenderPass.js",
    "examples/jsm/postprocessing/UnrealBloomPass.js",
    "examples/jsm/postprocessing/OutputPass.js",
    "examples/jsm/postprocessing/ShaderPass.js",
)
ASSET_VENDOR = "vendor/three"
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 24 * 1024 * 1024
ANDROID_CSP = (
    "default-src 'none'; script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; font-src 'self'; "
    "img-src 'self' data: blob:; connect-src 'none'; worker-src blob:; "
    "base-uri 'none'; form-action 'none'"
)
IMPORTMAP = {
    "imports": {
        "three": "./vendor/three/build/three.module.js",
        "three/addons/": "./vendor/three/examples/jsm/",
    }
}
STATIC_IMPORT = re.compile(
    r"""(?m)^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]"""
    r"""|^\s*import\s*['"]([^'"]+)['"]"""
)
DYNAMIC_IMPORT = re.compile(r"""\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)""")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_if_changed(path: Path, data: bytes) -> bool:
    """Dosyayı yalnız içerik değiştiyse atomik olarak yazar."""
    if path.is_file() and path.read_bytes() == data:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return True


def download(path: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", path) or ".." in path.split("/"):
        raise SystemExit(f"geçersiz vendor yolu: {path!r}")
    url = THREE_BASE + urllib.parse.quote(path)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "mayin-tarlasi-3d-package/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise SystemExit(f"indirme başarısız ({response.status}): {url}")
            data = response.read(MAX_FILE_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SystemExit(f"indirilemedi: {url}\n{exc}") from exc
    if len(data) > MAX_FILE_BYTES:
        raise SystemExit(f"dosya beklenenden büyük: {url}")
    if not data:
        raise SystemExit(f"boş dosya: {url}")
    return data


def resolve_import(specifier: str, importer: str) -> str:
    if specifier == "three":
        return "build/three.module.js"
    if specifier.startswith("three/addons/"):
        target = "examples/jsm/" + specifier[len("three/addons/") :]
    elif specifier.startswith("."):
        base = Path(importer).parent
        target = (base / specifier).as_posix()
    else:
        raise SystemExit(f"desteklenmeyen import: {specifier!r} ({importer})")
    parts: list[str] = []
    for part in target.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                raise SystemExit(f"vendor kökü dışına çıkan import: {specifier!r}")
            parts.pop()
        else:
            parts.append(part)
    if not parts or any(p.startswith(".") for p in parts):
        raise SystemExit(f"geçersiz import hedefi: {specifier!r} ({importer})")
    return "/".join(parts)


def discover_closure(fetch: Callable[[str], bytes]) -> dict[str, bytes]:
    """Giriş modüllerinden yalnız gerçekten gereken import kapanışını toplar."""
    files: dict[str, bytes] = {}
    total = 0
    queue = list(ENTRIES)
    while queue:
        path = queue.pop()
        if path in files:
            continue
        data = fetch(path)
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise SystemExit("vendor toplam boyutu beklenenden büyük")
        files[path] = data
        text = data.decode("utf-8")
        specifiers = [first or second for first, second in STATIC_IMPORT.findall(text)]
        specifiers += DYNAMIC_IMPORT.findall(text)
        for specifier in specifiers:
            dependency = resolve_import(specifier, path)
            if dependency not in files:
                queue.append(dependency)
    files["LICENSE"] = fetch("LICENSE")
    return dict(sorted(files.items()))


def load_manifest() -> dict | None:
    if not MANIFEST.is_file():
        return None
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"vendor manifesti okunamadı: {MANIFEST}\n{exc}") from exc
    if manifest.get("version") != THREE_VERSION:
        raise SystemExit(
            f"vendor sürümü uyuşmuyor: {manifest.get('version')!r} != {THREE_VERSION}"
        )
    if manifest.get("algorithm") != "sha256" or not isinstance(manifest.get("files"), dict):
        raise SystemExit(f"vendor manifesti geçersiz: {MANIFEST}")
    for path, digest in manifest["files"].items():
        if (
            not re.fullmatch(r"[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*", path)
            or ".." in Path(path).parts
            or Path(path).is_absolute()
            or not isinstance(digest, str)
            or not re.fullmatch(r"[a-f0-9]{64}", digest)
        ):
            raise SystemExit("vendor manifestinde geçersiz yol veya SHA-256")
    return manifest


def manifest_bytes(files: dict[str, bytes]) -> bytes:
    manifest = {
        "package": "three",
        "version": THREE_VERSION,
        "source": THREE_BASE,
        "algorithm": "sha256",
        "files": {path: sha256(data) for path, data in files.items()},
    }
    return (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")


def verify_vendor(verbose: bool = True) -> dict[str, bytes]:
    """Yerel vendor dosyalarını manifestteki SHA-256 değerleriyle doğrular."""
    manifest = load_manifest()
    if manifest is None:
        raise SystemExit(
            "vendor hazır değil. Açıkça çalıştırın: "
            "python3 tools/package_android.py vendor"
        )
    expected: dict[str, str] = manifest["files"]
    missing_entries = [entry for entry in (*ENTRIES, "LICENSE") if entry not in expected]
    if missing_entries:
        raise SystemExit("vendor manifestinde eksik giriş modülü: " + ", ".join(missing_entries))
    files: dict[str, bytes] = {}
    for path, digest in sorted(expected.items()):
        target = VENDOR / path
        if not target.resolve().is_relative_to(VENDOR.resolve()) or target.is_symlink():
            raise SystemExit("vendor dosyası yerel kaynak kökü dışında")
        if not target.is_file():
            raise SystemExit(f"vendor dosyası eksik: {target.relative_to(ROOT)}")
        if target.stat().st_size > MAX_FILE_BYTES:
            raise SystemExit("vendor dosyası boyut sınırını aşıyor")
        data = target.read_bytes()
        if sha256(data) != digest:
            raise SystemExit(f"vendor SHA-256 uyuşmuyor: {target.relative_to(ROOT)}")
        files[path] = data
    def local_file(path: str) -> bytes:
        if path not in files:
            raise SystemExit(f"vendor import bağımlılığı manifestte yok: {path}")
        return files[path]
    closure = discover_closure(local_file)
    if set(closure) != set(files):
        raise SystemExit("vendor manifesti yalnız gerekli modülleri ve lisansı içermeli")
    if verbose:
        print(f"vendor doğrulandı: {len(files)} dosya, three {THREE_VERSION}")
    return files


def vendor(refresh: bool = False) -> None:
    """Vendor ağacını açık istek üzerine indirir; mevcut manifest varsa hashleri korur."""
    manifest = load_manifest()
    if manifest is None:
        files = discover_closure(download)
        VENDOR.mkdir(parents=True, exist_ok=True)
        for path, data in files.items():
            write_if_changed(VENDOR / path, data)
        write_if_changed(MANIFEST, manifest_bytes(files))
        print(f"vendor hazırlandı: {len(files)} dosya, three {THREE_VERSION}")
        return

    expected: dict[str, str] = manifest["files"]
    changed = 0
    for path, digest in sorted(expected.items()):
        target = VENDOR / path
        local_ok = target.is_file() and sha256(target.read_bytes()) == digest
        if local_ok and not refresh:
            continue
        data = download(path)
        if sha256(data) != digest:
            raise SystemExit(
                f"indirilen içerik manifestle uyuşmuyor: {path}\n"
                "Sürüm sabit olduğu için içerik değişmemeli; manifesti elle onaylamadan güncellemeyin."
            )
        write_if_changed(target, data)
        changed += 1
    verify_vendor()
    print(f"vendor güncel; {changed} dosya yeniden indirildi, ağ dışı paketleme hazır")


def strip_remote_resources(html: str) -> str:
    """Yalnız Android türevinden uzak font/OG/favicon bağlantılarını kaldırır."""
    kept: list[str] = []
    for line in html.splitlines(keepends=True):
        lower = line.lower()
        if "<link" in lower and (
            'rel="preconnect"' in lower
            or "fonts.googleapis.com" in lower
            or 'rel="icon"' in lower
        ):
            continue
        if "<meta" in lower and (
            'property="og:' in lower or 'name="twitter:' in lower
        ):
            continue
        kept.append(line)
    return "".join(kept)


def android_html() -> bytes:
    if not INDEX.is_file():
        raise SystemExit(f"kaynak sayfa bulunamadı: {INDEX}")
    source = INDEX.read_bytes()
    before = sha256(source)
    html = source.decode("utf-8")

    html = strip_remote_resources(html)
    # WebView aksi halde /favicon.ico için gereksiz, engellenen bir istek gönderir.
    html = html.replace('</head>', '<link rel="icon" href="' + ANDROID_FAVICON + '">\n</head>')
    html = html.replace('"Fredoka", ', "")

    csp_pattern = re.compile(
        r"(<meta\s+http-equiv=\"Content-Security-Policy\"\s+content=\")[^\"]*(\">)",
        re.IGNORECASE,
    )
    html, csp_count = csp_pattern.subn(
        lambda match: match.group(1) + ANDROID_CSP + match.group(2), html
    )
    if csp_count != 1:
        raise SystemExit("index.html içinde tam olarak bir CSP meta etiketi bulunamadı")

    importmap_pattern = re.compile(
        r"<script\s+type=\"importmap\">.*?</script>", re.IGNORECASE | re.DOTALL
    )
    importmap = json.dumps(IMPORTMAP, indent=2)
    html, map_count = importmap_pattern.subn(
        lambda _match: f'<script type="importmap">\n{importmap}\n</script>', html
    )
    if map_count != 1:
        raise SystemExit("index.html içinde tam olarak bir importmap bulunamadı")

    if "cdn.jsdelivr.net" in html or "fonts.googleapis.com" in html or "fonts.gstatic.com" in html:
        raise SystemExit("Android türevinde uzak kaynak kaldı")
    if "http://" in html or "https://" in html:
        raise SystemExit("Android türevinde uzak URL kaldı; çevrimdışı koşulu bozuldu")
    if "connect-src 'none'" not in html:
        raise SystemExit("Android türevinde connect-src 'none' korunmadı")

    after = sha256(INDEX.read_bytes())
    if before != after:
        raise SystemExit("kaynak index.html değişti; paketleme yalnız okuma yapmalı")
    return html.encode("utf-8")


def notices(project_license: bytes | None) -> bytes:
    lines = [
        "Mayın Tarlası 3D - Android çevrimdışı paket",
        "",
        "Bu paket ağ üzerinden çalışma zamanı kaynağı yüklemez.",
        "",
        f"Three.js {THREE_VERSION}",
        f"Kaynak: {THREE_BASE}",
        "Lisans: MIT (bkz. licenses/THREE-LICENSE.txt)",
        "",
        "Oyun kaynağı: MIT (bkz. licenses/PROJECT-LICENSE.txt)",
        "",
    ]
    if project_license is None:
        lines[-2] = "Oyun kaynağı: MIT (kök LICENSE dosyası okunamadı)"
    return "\n".join(lines).encode("utf-8")


def build_plan() -> dict[str, bytes]:
    vendor_files = verify_vendor(verbose=False)
    html = android_html()
    verify_page_imports(html.decode("utf-8"), vendor_files)
    plan: dict[str, bytes] = {"index.html": html}
    for relative in LOCAL_ASSETS:
        path = ROOT / relative
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"birinci taraf oyun kaynağı eksik/geçersiz: {relative}")
        plan[relative] = path.read_bytes()
    for raw in re.findall(r'''\b(?:src|href)=["']([^"']+)["']''', html.decode("utf-8")):
        if raw == ANDROID_FAVICON:
            continue
        if raw.removeprefix("./") not in LOCAL_ASSETS:
            raise SystemExit(f"Android sayfasında plan dışı kaynak: {raw}")
    for path, data in vendor_files.items():
        if path == "LICENSE":
            plan[f"licenses/THREE-LICENSE.txt"] = data
        else:
            plan[f"{ASSET_VENDOR}/{path}"] = data
    license_path = ROOT / "LICENSE"
    project_license = license_path.read_bytes() if license_path.is_file() else None
    if project_license is not None:
        plan["licenses/PROJECT-LICENSE.txt"] = project_license
    plan["licenses/THIRD_PARTY_NOTICES.txt"] = notices(project_license)
    return plan


def verify_page_imports(html: str, vendor_files: dict[str, bytes]) -> None:
    """Oyun yeni bir modül isterse eksik vendor ile başarılı paket üretme."""
    modules = re.findall(
        r'<script\b[^>]*\btype=["\']module["\'][^>]*>(.*?)</script>',
        html, re.IGNORECASE | re.DOTALL,
    )
    if not modules:
        raise SystemExit("oyun modül betiği bulunamadı")
    for module in modules:
        specifiers = [first or second for first, second in STATIC_IMPORT.findall(module)]
        dynamic = DYNAMIC_IMPORT.findall(module)
        if len(re.findall(r'\bimport\s*\(', module)) != len(dynamic):
            raise SystemExit("hesaplanan dinamik import çevrimdışı doğrulanamaz")
        for specifier in [*specifiers, *dynamic]:
            if specifier != "three" and not specifier.startswith("three/addons/"):
                raise SystemExit(f"oyunda desteklenmeyen modül importu: {specifier}")
            path = resolve_import(specifier, "index.html")
            if path not in vendor_files:
                raise SystemExit(f"oyunun istediği modül vendor paketinde yok: {specifier}")


def package() -> None:
    plan = build_plan()
    verify_asset_paths(plan)
    changed = 0
    for relative, data in plan.items():
        if write_if_changed(ASSETS / relative, data):
            changed += 1
    print(
        f"package hazır: {len(plan)} dosya ({changed} güncellendi), "
        f"index sha256={sha256(plan['index.html'])[:16]}…"
    )
    print(f"çıktı: {ASSETS.relative_to(ROOT)}")


def check() -> None:
    plan = build_plan()
    verify_asset_paths(plan)
    problems: list[str] = []
    for relative, data in plan.items():
        target = ASSETS / relative
        if not target.is_file():
            problems.append(f"eksik: {target.relative_to(ROOT)}")
        elif target.read_bytes() != data:
            problems.append(f"güncel değil: {target.relative_to(ROOT)}")
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        raise SystemExit(
            "Android assetleri güncel değil; çalıştırın: "
            "python3 tools/package_android.py package"
        )
    print(f"assetler güncel: {len(plan)} dosya")


def verify_asset_paths(plan: dict[str, bytes]) -> None:
    """Bilinmeyen dosyaları silmeden dur; eski/gizli bir dosyayı uygulamaya katma."""
    if not ASSETS.exists():
        return
    for path in ASSETS.rglob("*"):
        if path.is_symlink():
            raise SystemExit("Android asset klasöründe sembolik bağlantı kabul edilmez")
        if path.is_file() and path.relative_to(ASSETS).as_posix() not in plan:
            raise SystemExit("Android asset klasöründe plan dışı dosya var; paketleme durduruldu")


def usage() -> None:
    print(
        "Kullanım:\n"
        "  python3 tools/package_android.py [package]   # çevrimdışı paketleme (varsayılan)\n"
        "  python3 tools/package_android.py vendor [--force]  # Three.js vendor hazırlığı (ağ)\n"
        "  python3 tools/package_android.py check       # üretilmiş assetleri denetle"
    )


def main(argv: list[str]) -> int:
    command = argv[0] if argv else "package"
    if command in {"-h", "--help", "help"}:
        usage()
    elif command == "vendor":
        vendor(refresh="--force" in argv[1:])
    elif command == "package":
        package()
    elif command == "check":
        check()
    else:
        usage()
        raise SystemExit(f"bilinmeyen komut: {command}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
