#!/usr/bin/env python3
"""Mayın Tarlası 3D için gerçek tarayıcı sözleşme testi.

Neden: `tools/check.py` yalnız statik kontroldür. Bu betik Chromium'da
mobil/dokunmatik dar bir görünümde oyunu açar; DOM/JS durumunu gerçekten
sınar. Testte sahte localStorage değerleriyle "snapshot geçerli" demek
yerine kayıt sonrası sayfa yenilenir, devam UI'ı tıklanır ve oyunun
gerçekten kaldığı yerden sürdüğü doğrulanır.

Kapsam:
  * sayfa hatasız açılır, beklenen başlangıç arayüzü görünür,
  * yeni oyun + dokunmatik güvenli iniş (3x3 güvenli alan),
  * mobil kontroller görünür ve viewport içinde,
  * `window.mt3dApp.pause/resume/back` sözleşmesi ve duraklatılmış süre,
  * `mt3d-v1-*` kaydı, reload sonrası semantik "devam" arayüzü ve
    tıklanınca oyunun gerçekten sürmesi,
  * bozuk kayıtla güvenli açılış + yeni oyun,
  * portrait/landscape kontrol yerleşimi ve çakışma kontrolü.

Kullanım:
  python3 tools/test_browser.py
  python3 tools/test_browser.py --url http://127.0.0.1:8766
  python3 tools/test_browser.py --assets /yol/android/assets

Varsayılan olarak betik kendi yerel sunucusunu açar ve yalnızca
index.html (veya --assets klasöründeki beyaz listedeki dosyaları) servis
eder. `.git`, `.env`, gizli dosyalar ve proje kökünün geri kalanı
sunulmaz. --no-serve ile dışarıda çalışan bir sunucu kullanılabilir;
bu durumda beyaz liste garantisi testin değil çağıranın sorumluluğundadır.

CDN/Google Fonts gibi dış kaynaklara erişilemezse test SKIP/PASS olmaz;
açıkça FAIL eder. --assets modunda ayrıca bütün HTTP(S) isteklerinin
yalnızca yerel origin'e gitmesi zorunludur (vendor modülleri).

Gereksinimler (CI):
  * Python 3.10+
  * `pip install playwright`
  * `python3 -m playwright install --with-deps chromium`
  * Chromium'un SwiftShader/WebGL yazılım rasterizasyonu kullanılabilir
    olmalı; betik gerekli bayrakları kendisi verir.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import sys
import threading
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INDEX = ROOT / "index.html"
DEFAULT_URL = "http://127.0.0.1:8766"
ALLOWED_EXTERNAL_HOSTS = {
    "cdn.jsdelivr.net",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
}
LOCK_KEYS = re.compile(r"^(mt3d-v1-(unlocked|stars|muted|mode|night|best-))")
DENY_PARTS = {
    ".git",
    ".env",
    ".env.local",
    ".claude",
    "claude.md",
    "pb_data",
    ".ops-state",
    ".local-admin.json",
}
SNAPSHOT_HINT = re.compile(r"(save|game|state|snap|resume|progress|oyun|kayit|kayıt)", re.I)
CONTINUE_TEXT = re.compile(r"(devam|sürdür|kaldığın\s+yerden)", re.I)

ACTIVE_JS = """() => {
  const start = document.querySelector('#start');
  const prog = document.querySelector('#prog');
  const width = parseFloat(prog?.style.width || '0') || 0;
  const hearts = document.querySelectorAll('#lives .heart').length;
  return !!start && !start.classList.contains('show') && width > 0 && hearts > 0;
}"""


class TestFailure(RuntimeError):
    pass


def check(condition: object, message: str) -> None:
    if not condition:
        raise TestFailure(message)


class WhitelistHandler(SimpleHTTPRequestHandler):
    """Yalnız index dosyasını veya --assets kökünü servis eder."""

    server_version = "mt3d-test/1.0"
    base_dir: Path = ROOT
    index_rel: str = "index.html"
    assets_mode: bool = False

    def log_message(self, fmt: str, *args: object) -> None:  # sunucu gürültüsünü kapat
        pass

    def do_GET(self) -> None:  # noqa: N802 (stdlib adı)
        self._serve(head=False)

    def do_HEAD(self) -> None:  # noqa: N802
        self._serve(head=True)

    def _allowed_rel(self) -> str | None:
        path = unquote(urlsplit(self.path).path).replace("\\", "/")
        if "\x00" in path or not path.startswith("/"):
            return None
        rel = path.lstrip("/")
        parts = PurePosixPath(rel).parts if rel else ()
        for part in parts:
            if part in {"", ".", ".."} or part.startswith("."):
                return None
            if part.lower() in DENY_PARTS:
                return None
        if not self.assets_mode:
            # Varsayılan modda proje kökündeki başka hiçbir dosya sunulmaz.
            return "" if rel in {"", self.index_rel} else None
        if rel == "":
            return ""
        target = (self.base_dir / rel).resolve()
        try:
            target.relative_to(self.base_dir)
        except ValueError:
            return None
        if target.is_dir() or not target.is_file():
            return None
        return rel

    def _serve(self, head: bool) -> None:
        rel = self._allowed_rel()
        if rel is None:
            self.send_error(404, "Not found")
            return
        target = (self.base_dir / (rel or self.index_rel)).resolve()
        try:
            target.relative_to(self.base_dir)
        except ValueError:
            self.send_error(404, "Not found")
            return
        if not target.is_file():
            self.send_error(404, "Not found")
            return
        data = target.read_bytes()
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix in {".js", ".mjs"}:
            ctype = "text/javascript; charset=utf-8"
        elif target.suffix in {".html", ".htm"}:
            ctype = "text/html; charset=utf-8"
        elif target.suffix == ".json":
            ctype = "application/json; charset=utf-8"
        elif target.suffix == ".css":
            ctype = "text/css; charset=utf-8"
        elif target.suffix == ".wasm":
            ctype = "application/wasm"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not head:
            self.wfile.write(data)


def start_server(
    host: str, port: int, base_dir: Path, index_rel: str, assets_mode: bool
) -> tuple[ThreadingHTTPServer, int]:
    handler = type(
        "BoundWhitelistHandler",
        (WhitelistHandler,),
        {
            "base_dir": base_dir,
            "index_rel": index_rel,
            "assets_mode": assets_mode,
        },
    )
    try:
        server = ThreadingHTTPServer((host, port), handler)
    except OSError as exc:
        raise TestFailure(
            f"yerel test sunucusu {host}:{port} üzerinde açılamadı: {exc}; "
            "portu boşaltın veya --url http://127.0.0.1:0 kullanın"
        ) from exc
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, int(server.server_address[1])


class RuntimeLog:
    def __init__(self, page, local_origin: str, assets_mode: bool) -> None:
        self.page = page
        self.local_origin = local_origin
        self.assets_mode = assets_mode
        self.page_errors: list[str] = []
        self.console_errors: list[str] = []
        self.failed_requests: list[tuple[str, str]] = []
        self.bad_responses: list[tuple[str, int]] = []
        self.external_requests: list[str] = []
        page.on("pageerror", lambda exc: self.page_errors.append(str(exc)))
        page.on("console", self._on_console)
        page.on("request", self._on_request)
        page.on("requestfailed", self._on_failed)
        page.on("response", self._on_response)

    def _on_console(self, msg) -> None:
        if msg.type == "error":
            self.console_errors.append(msg.text)

    def _on_request(self, request) -> None:
        parsed = urlsplit(request.url)
        if parsed.scheme not in {"http", "https"}:
            return
        origin = f"{parsed.scheme}://{parsed.netloc}".lower()
        if origin == self.local_origin:
            return
        host = (parsed.hostname or "").lower()
        if self.assets_mode or host not in ALLOWED_EXTERNAL_HOSTS:
            self.external_requests.append(request.url)

    def _on_failed(self, request) -> None:
        failure = request.failure or "bilinmeyen"
        self.failed_requests.append((request.url, failure))

    def _on_response(self, response) -> None:
        if response.status >= 400:
            self.bad_responses.append((response.url, response.status))

    def assert_clean(self, stage: str) -> None:
        problems: list[str] = []
        if self.page_errors:
            problems.append("sayfa hataları: " + " | ".join(self.page_errors))
        if self.console_errors:
            problems.append("konsol hataları: " + " | ".join(self.console_errors))
        if self.failed_requests:
            problems.append(
                "başarısız istekler: "
                + " | ".join(f"{url} ({why})" for url, why in self.failed_requests)
            )
        if self.bad_responses:
            problems.append(
                "HTTP hataları: "
                + " | ".join(f"{url} -> {status}" for url, status in self.bad_responses)
            )
        if self.external_requests:
            problems.append(
                "yerel origin dışı istekler: " + " | ".join(self.external_requests)
            )
        if not problems:
            return
        message = f"{stage}: " + "\n  ".join(problems)
        if any("cdn.jsdelivr.net" in url for url, _ in self.failed_requests) or any(
            "cdn.jsdelivr.net" in url for url, _ in self.bad_responses
        ):
            message += (
                "\n  NOT: CDN erişilemiyor. Bu bir runtime bağımlılığıdır; "
                "test SKIP/PASS sayılmaz. Çevrimdışı doğrulama için --assets kullanın."
            )
        raise TestFailure(message)

    def clear(self) -> None:
        self.page_errors.clear()
        self.console_errors.clear()
        self.failed_requests.clear()
        self.bad_responses.clear()
        self.external_requests.clear()


def wait_for(page, predicate, timeout_ms: int, message: str, interval_ms: int = 100) -> None:
    deadline = time.monotonic() + timeout_ms / 1000
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            if predicate():
                return
        except Exception as exc:  # sayfa geçişi sırasında görülebilir
            last_error = exc
        page.wait_for_timeout(interval_ms)
    suffix = f" (son hata: {last_error})" if last_error else ""
    raise TestFailure(message + suffix)


def app_call(page, name: str, *args: object):
    return page.evaluate(
        """async ({name, args}) => {
            const app = window.mt3dApp;
            if (!app || typeof app[name] !== 'function') {
                throw new Error('window.mt3dApp.' + name + ' yok');
            }
            return await app[name](...args);
        }""",
        {"name": name, "args": list(args)},
    )


def get_store(page) -> dict[str, str]:
    return page.evaluate(
        """() => {
            const out = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                out[key] = localStorage.getItem(key);
            }
            return out;
        }"""
    )


def timer_seconds(text: str) -> int:
    match = re.fullmatch(r"\s*(\d+):(\d{1,2})\s*", text or "")
    if not match:
        return -1
    return int(match.group(1)) * 60 + int(match.group(2))


def read_timer(page) -> int:
    return timer_seconds(page.locator("#time").inner_text())


def wait_active_game(page, timeout_ms: int = 20000) -> None:
    page.wait_for_function(ACTIVE_JS, timeout=timeout_ms)


def tap(page, selector: str) -> None:
    locator = page.locator(selector).first
    locator.wait_for(state="visible", timeout=10000)
    locator.tap(timeout=10000)


def ensure_mobile_controls(page) -> None:
    check(page.locator("#pad").is_visible(), "#pad dokunmatik kontroller görünmüyor")
    count = page.locator("#pad button").count()
    check(count >= 9, f"#pad içinde yeterli kontrol yok ({count})")


def find_continuation(page):
    """Semantik metinle görünür devam kontrolü bul (ID'ye bağımlı değil)."""
    locator = page.locator("button:visible, a:visible, [role=button]:visible").filter(
        has_text=CONTINUE_TEXT
    )
    if locator.count():
        return locator.first
    # Bazı uygulamalar tıklanabilir div / bölüm düğmesi kullanabilir.
    locator = page.locator("[onclick]:visible, .lv:visible").filter(
        has_text=CONTINUE_TEXT
    )
    if locator.count():
        return locator.first
    return None


def assert_controls_layout(page, label: str) -> None:
    viewport = page.viewport_size
    check(viewport is not None, f"{label}: viewport bilinmiyor")
    width, height = viewport["width"], viewport["height"]
    check(page.locator("#pad").is_visible(), f"{label}: #pad görünmüyor")
    boxes = page.evaluate(
        """() => {
            const nodes = [...document.querySelectorAll('#pad button, #menuBtn')];
            return nodes
              .filter(el => {
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden'
                  && rect.width > 0 && rect.height > 0;
              })
              .map(el => {
                const rect = el.getBoundingClientRect();
                return {
                  label: el.id || el.dataset.dir || el.textContent.trim().slice(0, 12),
                  left: rect.left, top: rect.top,
                  right: rect.right, bottom: rect.bottom
                };
              });
        }"""
    )
    check(len(boxes) >= 10, f"{label}: görünür kontrol sayısı beklenenden az ({len(boxes)})")
    for box in boxes:
        check(
            box["left"] >= -0.5
            and box["top"] >= -0.5
            and box["right"] <= width + 0.5
            and box["bottom"] <= height + 0.5,
            f"{label}: '{box['label']}' viewport dışında "
            f"({box['left']:.1f},{box['top']:.1f})-({box['right']:.1f},{box['bottom']:.1f})",
        )
    for index, first in enumerate(boxes):
        for second in boxes[index + 1 :]:
            overlap_x = max(0.0, min(first["right"], second["right"]) - max(first["left"], second["left"]))
            overlap_y = max(0.0, min(first["bottom"], second["bottom"]) - max(first["top"], second["top"]))
            check(
                overlap_x * overlap_y <= 0.5,
                f"{label}: '{first['label']}' ile '{second['label']}' kontrolleri çakışıyor",
            )


def run(args: argparse.Namespace) -> int:
    assets_mode = bool(args.assets)
    server = None
    if assets_mode:
        assets_dir = Path(args.assets).expanduser().resolve()
        check(assets_dir.is_dir(), f"--assets klasörü yok: {assets_dir}")
        candidates = [
            assets_dir / "index.html",
            assets_dir / "www" / "index.html",
            assets_dir / "public" / "index.html",
        ]
        index_path = next((path for path in candidates if path.is_file()), None)
        check(index_path is not None,
              f"--assets içinde index.html yok (denenen: {', '.join(map(str, candidates))})")
        base_dir = index_path.parent
        index_rel = index_path.name
    else:
        base_dir = ROOT
        index_path = Path(args.index).expanduser().resolve() if args.index else DEFAULT_INDEX
        check(index_path.is_file(), f"index dosyası yok: {index_path}")
        index_rel = index_path.name
        base_dir = index_path.parent

    parsed = urlsplit(args.url)
    check(parsed.scheme in {"http", "https"} and parsed.hostname, f"geçersiz --url: {args.url}")
    loopback = (parsed.hostname or "").lower() in {"127.0.0.1", "localhost", "::1"}
    page_url = args.url
    if args.serve and loopback:
        check(parsed.port is not None, "--url localhost için port belirtin (örn. :8766 veya :0)")
        host = parsed.hostname or "127.0.0.1"
        server, actual_port = start_server(host, int(parsed.port), base_dir, index_rel, assets_mode)
        netloc_host = f"[{host}]" if ":" in host else host
        page_url = urlunsplit(
            (parsed.scheme, f"{netloc_host}:{actual_port}", parsed.path or "/", parsed.query, "")
        )
    elif assets_mode:
        check(
            loopback,
            "--assets yalnız yerel origin ile kullanılabilir; "
            "CDN/uzak sunucu testi yerel vendor sözleşmesini doğrulamaz",
        )
    local_origin = f"{urlsplit(page_url).scheme}://{urlsplit(page_url).netloc}".lower()

    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise TestFailure(
            "Python Playwright kurulu değil. `pip install playwright` ve "
            "`python3 -m playwright install chromium` gerekir."
        )

    started = time.monotonic()
    print(f"URL: {page_url}")
    print(f"Servis: {'assets whitelist' if assets_mode else 'yalnız index.html'}"
          f" ({'açık' if server else 'kapalı'})")
    try:
        with sync_playwright() as playwright:
            try:
                browser = playwright.chromium.launch(
                    headless=not args.headed,
                    args=[
                        "--use-gl=angle",
                        "--use-angle=swiftshader",
                        "--enable-unsafe-swiftshader",
                        "--ignore-gpu-blocklist",
                        "--disable-dev-shm-usage",
                        "--disable-gpu-sandbox",
                        "--no-sandbox",
                    ],
                )
            except Exception as exc:
                raise TestFailure(
                    "Chromium başlatılamadı; `python3 -m playwright install --with-deps chromium` "
                    f"gerekir: {exc}"
                ) from exc

            try:
                context = browser.new_context(
                    viewport={"width": 360, "height": 640},
                    is_mobile=True,
                    has_touch=True,
                    device_scale_factor=2,
                    locale="tr-TR",
                )
                page = context.new_page()
                runtime = RuntimeLog(page, local_origin, assets_mode)

                # 1) Hatasız açılış ve sözleşme nesnesi
                try:
                    page.goto(page_url, wait_until="load", timeout=45000)
                    page.locator("#c").wait_for(state="visible", timeout=30000)
                    page.locator("#start.show").wait_for(state="visible", timeout=30000)
                    page.wait_for_function(
                        """() => {
                            const app = window.mt3dApp;
                            return !!app && ['pause', 'resume', 'back'].every(
                                name => typeof app[name] === 'function');
                        }""",
                        timeout=30000,
                    )
                except PlaywrightTimeoutError as exc:
                    runtime.assert_clean("sayfa açılamadı")
                    raise TestFailure(
                        f"sayfa/uygulama zaman aşımına uğradı: {exc}"
                    ) from exc
                canvas_box = page.locator("#c").bounding_box()
                check(canvas_box and canvas_box["width"] >= 200 and canvas_box["height"] >= 200,
                      "3D canvas görünür ve yeterli boyutta değil")
                webgl = page.evaluate(
                    """() => {
                        const canvas = document.createElement('canvas');
                        return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
                    }"""
                )
                check(webgl, "WebGL bağlamı yok; Chromium SwiftShader/WebGL kurulumu gerekli")
                runtime.assert_clean("açılış")

                initial_store = get_store(page)

                # 2) Yeni oyun + güvenli iniş + mobil kontroller
                tap(page, "#playBtn")
                page.locator("#start").wait_for(state="hidden", timeout=10000)
                ensure_mobile_controls(page)
                tap(page, "#padFlag")
                wait_active_game(page)
                hearts_total = page.locator("#lives .heart").count()
                hearts_left = page.locator("#lives .heart:not(.lost)").count()
                check(hearts_total >= 3, f"can göstergesi beklenmedik ({hearts_total})")
                check(hearts_left == hearts_total,
                      f"güvenli inişte can kaybı var ({hearts_left}/{hearts_total})")
                progress = page.evaluate(
                    "() => parseFloat(document.querySelector('#prog').style.width) || 0"
                )
                check(progress > 0, "güvenli iniş sonrası ilerleme/alan açılmadı")
                mines_text = page.locator("#mines").inner_text().strip()
                check(re.fullmatch(r"-?\d+", mines_text) is not None,
                      f"kalan mayın sayısı okunamadı: {mines_text!r}")
                level_before = page.locator("#lvlName").inner_text().strip()
                check(page.locator("#pad").is_visible(), "iniş sonrası mobil kontroller kayboldu")
                runtime.assert_clean("yeni oyun ve iniş")

                # 3) Süre gerçekten işliyor; pause() süreyi dondurup kayıt bırakıyor
                wait_for(page, lambda: read_timer(page) > 0, 6000, "oyun süresi başlamadı")
                running_a = read_timer(page)
                page.wait_for_timeout(1400)
                running_b = read_timer(page)
                check(running_b > running_a, "oyun süresi ilerlemiyor; oyun gerçekten çalışmıyor")

                app_call(page, "pause")
                page.wait_for_timeout(500)
                paused_a = read_timer(page)
                page.wait_for_timeout(1400)
                paused_b = read_timer(page)
                check(paused_a == paused_b,
                      f"pause() süreyi durdurmadı ({paused_a} -> {paused_b})")

                store_after_pause = get_store(page)
                new_keys = set(store_after_pause) - set(initial_store)
                snapshot_keys = [
                    key for key in store_after_pause
                    if key.startswith("mt3d-v1-") and not LOCK_KEYS.match(key)
                ]
                hinted_keys = [key for key in snapshot_keys if SNAPSHOT_HINT.search(key)]
                check(
                    hinted_keys or new_keys,
                    "pause() sonrası mt3d-v1-* kaydı bulunamadı; "
                    f"anahtarlar: {sorted(store_after_pause)}",
                )
                paused_at = read_timer(page)

                # 4) back(): menüde false, oyunda true + menü açılır
                if not page.locator("#start").is_visible():
                    tap(page, "#menuBtn")
                page.locator("#start").wait_for(state="visible", timeout=10000)
                back_in_menu = app_call(page, "back")
                check(back_in_menu is False,
                      f"back() menü açıkken false döndürmeliydi ({back_in_menu!r})")

                tap(page, "#playBtn")
                page.locator("#start").wait_for(state="hidden", timeout=10000)
                wait_active_game(page)
                back_in_game = app_call(page, "back")
                check(back_in_game is True,
                      f"back() oyun içinde true döndürmeliydi ({back_in_game!r})")
                page.locator("#start").wait_for(state="visible", timeout=10000)

                # resume() kendiliğinden oyunu sürdürmemeli: süre ilerlememeli.
                app_call(page, "resume")
                page.wait_for_timeout(500)
                resume_a = read_timer(page)
                page.wait_for_timeout(1400)
                resume_b = read_timer(page)
                check(resume_a == resume_b,
                      f"resume() oyunu kendiliğinden başlattı; süre ilerledi ({resume_a} -> {resume_b})")
                runtime.assert_clean("pause/resume/back")

                # 5) Reload sonrası gerçek kayıt devamı
                before_reload_store = get_store(page)
                check(any(key.startswith("mt3d-v1-") for key in before_reload_store),
                      "reload öncesi mt3d-v1-* kaydı yok")
                runtime.clear()
                page.reload(wait_until="load", timeout=45000)
                page.locator("#c").wait_for(state="visible", timeout=30000)
                page.wait_for_function(
                    "() => !!window.mt3dApp && typeof window.mt3dApp.resume === 'function'",
                    timeout=30000,
                )
                wait_for(
                    page,
                    lambda: find_continuation(page) is not None,
                    10000,
                    "reload sonrası 'Devam' içeren görünür kayıt devam arayüzü yok",
                )
                reload_a = read_timer(page)
                page.wait_for_timeout(1400)
                reload_b = read_timer(page)
                check(reload_a == reload_b,
                      f"reload sonrası oyun kendiliğinden sürdü; süre ilerledi ({reload_a} -> {reload_b})")
                continuation = find_continuation(page)
                check(continuation is not None,
                      "reload sonrası devam arayüzü bulunamadı")
                # resume() burada da kendiliğinden oyuna girmemeli.
                app_call(page, "resume")
                page.wait_for_timeout(500)
                post_resume_a = read_timer(page)
                page.wait_for_timeout(1400)
                post_resume_b = read_timer(page)
                check(post_resume_a == post_resume_b,
                      f"reload sonrası resume() oyunu başlattı ({post_resume_a} -> {post_resume_b})")
                continuation = find_continuation(page)
                check(continuation is not None,
                      "resume() sonrası devam arayüzü kayboldu")
                continuation.tap(timeout=10000)
                page.locator("#start").wait_for(state="hidden", timeout=10000)
                wait_active_game(page)
                level_after = page.locator("#lvlName").inner_text().strip()
                check(level_after == level_before,
                      f"devam edilen bölüm değişti ({level_before!r} -> {level_after!r})")
                progress_after = page.evaluate(
                    "() => parseFloat(document.querySelector('#prog').style.width) || 0"
                )
                check(progress_after >= progress - 0.5,
                      f"devam edilen tahta ilerlemesi kayboldu ({progress:.1f}% -> {progress_after:.1f}%)")
                hearts_after = page.locator("#lives .heart").count()
                check(hearts_after == hearts_total,
                      f"devam edilen oyunda can göstergesi değişti ({hearts_after})")
                timer_after_resume = read_timer(page)
                check(timer_after_resume >= max(0, paused_at - 2),
                      f"devam edilen süre kayboldu ({paused_at} -> {timer_after_resume})")
                page.wait_for_timeout(1500)
                check(read_timer(page) > timer_after_resume,
                      "devam ettirilen oyunda süre yeniden işlemiyor")
                runtime.assert_clean("reload ve kayıt devamı")

                # Aynı ilerleme yüzdesi farklı bir tahtadan da gelebilir: gerçek kayıt içeriğini karşılaştır.
                app_call(page, "pause")
                restored = json.loads(get_store(page)["mt3d-v1-save"])
                original = json.loads(before_reload_store["mt3d-v1-save"])
                for field in ("mode", "stage", "cfg", "grid", "start", "player", "lives", "charges"):
                    check(restored[field] == original[field], f"restore sonrası {field} değişti")

                # Kalite seçimi gerçek canvas çözünürlüğünü değiştirmeli.
                tap(page, '[data-q="high"]')
                high_width = page.locator("#c").evaluate("canvas => canvas.width")
                tap(page, '[data-q="low"]')
                low_width = page.locator("#c").evaluate("canvas => canvas.width")
                check(high_width > low_width, "kalite seçimi render çözünürlüğünü değiştirmedi")
                tap(page, "#playBtn")

                # Çok kısa dokunuş rAF'ten önce bitse bile bir adım kaybolmamalı.
                x, z = restored["player"]["x"], restored["player"]["z"]
                known = set(restored["grid"]["revealed"] + restored["grid"]["craters"])
                width, depth = restored["cfg"]["w"], restored["cfg"]["d"]
                moves = [(name, dx, dz) for name, dx, dz in
                         (("up", 0, -1), ("down", 0, 1), ("left", -1, 0), ("right", 1, 0))
                         if 0 <= x + dx < width and 0 <= z + dz < depth
                         and (z + dz) * width + x + dx in known]
                check(moves, "dokunmatik adım testi için bilinen komşu yok")
                direction, dx, dz = moves[0]
                tap(page, '#pad [data-dir="' + direction + '"]')
                page.wait_for_timeout(700)
                app_call(page, "pause")
                moved = json.loads(get_store(page)["mt3d-v1-save"])
                check((moved["player"]["x"], moved["player"]["z"]) == (x + dx, z + dz),
                      "kısa dokunma beklenen tek adımı üretmedi")
                tap(page, "#playBtn")

                # 6) Portrait + landscape kontrol yerleşimi
                page.set_viewport_size({"width": 360, "height": 640})
                page.wait_for_timeout(500)
                assert_controls_layout(page, "portrait 360x640")
                page.set_viewport_size({"width": 640, "height": 360})
                page.wait_for_timeout(500)
                assert_controls_layout(page, "landscape 640x360")
                page.set_viewport_size({"width": 360, "height": 640})
                page.wait_for_timeout(300)
                runtime.assert_clean("orientation")

                # Sıfırlama bellekteki eski tarlayı tekrar kayda döndürmemeli.
                app_call(page, "pause")
                page.evaluate("localStorage.setItem('mt3d-v1-stars', JSON.stringify({'0': 1}))")
                page.reload(wait_until="load")
                page.wait_for_function("() => !!window.mt3dApp")
                page.once("dialog", lambda dialog: dialog.accept())
                tap(page, "#resetBtn")
                app_call(page, "pause")
                check("mt3d-v1-save" not in get_store(page), "sıfırlama eski kaydı geri getirdi")
                check(not page.locator("#continueBtn").is_visible(), "sıfırlama sonrası eski devam düğmesi kaldı")
                runtime.assert_clean("ilerleme sıfırlama")

                # 7) Bozuk snapshot ile güvenli açılış
                context2 = browser.new_context(
                    viewport={"width": 360, "height": 640},
                    is_mobile=True,
                    has_touch=True,
                    device_scale_factor=2,
                    locale="tr-TR",
                )
                corrupt_page = context2.new_page()
                corrupt_runtime = RuntimeLog(corrupt_page, local_origin, assets_mode)
                corrupt_keys = [
                    key for key in (hinted_keys or snapshot_keys)
                    if key.startswith("mt3d-v1-") and not LOCK_KEYS.match(key)
                ] or [
                    key for key in before_reload_store
                    if key.startswith("mt3d-v1-") and not LOCK_KEYS.match(key)
                ]
                if not corrupt_keys:
                    corrupt_keys = ["mt3d-v1-save"]
                corrupt_store: dict[str, str] = {}
                for index, key in enumerate(corrupt_keys):
                    corrupt_store[key] = (
                        '{"bozuk": ' if index % 2 == 0
                        else json.dumps({"v": 1, "state": "play", "cfg": {"w": -3}, "grid": [None]})
                    )
                corrupt_store["mt3d-v1-save"] = '{"bozuk": '
                corrupt_store["mt3d-v1-unlocked"] = "-5"
                corrupt_store["mt3d-v1-stars"] = "null"
                corrupt_store["mt3d-v1-mode"] = json.dumps({"beklenmeyen": True})
                corrupt_page.add_init_script(
                    """((values) => {
                        for (const [key, value] of Object.entries(values)) {
                            localStorage.setItem(key, value);
                        }
                    })(""" + json.dumps(corrupt_store) + ");",
                )
                corrupt_page.goto(page_url, wait_until="load", timeout=45000)
                try:
                    corrupt_page.locator("#c").wait_for(state="visible", timeout=30000)
                    corrupt_page.locator("#start").wait_for(state="visible", timeout=30000)
                    corrupt_page.wait_for_function(
                        "() => !!window.mt3dApp && typeof window.mt3dApp.pause === 'function'",
                        timeout=30000,
                    )
                except PlaywrightTimeoutError as exc:
                    corrupt_runtime.assert_clean("bozuk snapshot açılışı")
                    raise TestFailure(
                        f"bozuk snapshot ile açılış zaman aşımı: {exc}"
                    ) from exc
                tap(corrupt_page, "#playBtn")
                corrupt_page.locator("#start").wait_for(state="hidden", timeout=10000)
                ensure_mobile_controls(corrupt_page)
                tap(corrupt_page, "#padFlag")
                wait_active_game(corrupt_page)
                corrupt_runtime.assert_clean("bozuk snapshot ile açılış/yeni oyun")
                context2.close()

                elapsed = time.monotonic() - started
                print(
                    "PASS: açılış, yeni oyun/güvenli iniş, mobil kontroller, "
                    "pause/resume/back, reload kayıt devamı, bozuk snapshot, "
                    f"kalite, kısa dokunma, sıfırlama, portrait/landscape ({elapsed:.1f}s)"
                )
                if assets_mode:
                    print("PASS: --assets modunda yalnız yerel origin istekleri gözlendi")
            finally:
                browser.close()
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Mayın Tarlası 3D gerçek tarayıcı testi")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"sayfa URL'si (varsayılan {DEFAULT_URL})")
    parser.add_argument(
        "--assets",
        default=None,
        help="Android üretilmiş asset klasörü; index.html ve vendor dosyalarını beyaz listeyle servis eder",
    )
    parser.add_argument("--index", default=None, help="test edilecek index.html yolu (varsayılan proje kökü)")
    parser.add_argument(
        "--no-serve",
        dest="serve",
        action="store_false",
        help="yerel sunucu açma; --url adresindeki mevcut sunucuyu kullan",
    )
    parser.set_defaults(serve=True)
    parser.add_argument("--headed", action="store_true", help="tarayıcıyı görünür çalıştır")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        return run(args)
    except TestFailure as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    except Exception:
        print("FAIL: beklenmeyen hata", file=sys.stderr)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
