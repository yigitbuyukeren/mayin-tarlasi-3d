#!/usr/bin/env python3
"""Mayın Tarlası 3D Android kabuğunu özel QA emülatöründe sınar.

Bu betik yalnızca kendi oluşturduğumuz ``mt3d-qa`` AVD'sinde çalışır. Fiziksel
cihazlara, başka emülatörlere, kullanıcı AVD'lerine veya mevcut adb forward
kayıtlarına dokunmaz. APK üretmez; ``--apk`` açıkça verilirse yalnızca bu özel
AVD'ye kurar.

Kapsam:
  * hedefin gerçek bir ``emulator-*`` ve adb AVD adının ``mt3d-qa`` olduğunu
    doğrular,
  * isteğe bağlı APK kurulumu, yerel Activity başlatma ve ön plan kontrolü,
  * native ekran görüntüsü (PNG) ve ``uiautomator`` XML çıktısı,
  * paketin ``INTERNET`` izni istemediğini denetler (ağ/airplane değiştirmez),
  * debug derlemede WebView DevTools'a yalnız yerel, geçici adb forward ile
    bağlanır; forward'ı yalnız kendisi kaldırır,
  * ``window.mt3dApp`` sözleşmesi, menü aç/kapat, geri tuşu, home/resume ve
    portrait/landscape dönüşü,
  * WebView konsol hataları (yerel Page/Runtime CDP ile).

Durumlar: PASS, FAIL ve SKIP. SKIP "geçti" sayılmaz; genel sonuç INCOMPLETE
olur ve çıkış kodu sıfır olmaz. Eksik bir kontrolü PASS'a çevirmek için sebep
uydurmayın.

Ön koşullar:
  * Linux, KVM erişimi (``/dev/kvm``), Android SDK emulator + platform-tools,
  * kurulu bir system image (ör. ``system-images;android-35;google_apis;x86_64``),
  * ``mt3d-qa`` AVD'si (bkz. android/TESTING.md),
  * ``adb`` (``ANDROID_HOME``/``ANDROID_SDK_ROOT`` veya PATH),
  * WebView testleri için debug APK ve websocket-client:
    ``pip install -r tools/requirements-test.txt``; ayrı tarayıcı indirmek gerekmez, çünkü
    uygulamanın kendi WebView'ine bağlanılır.

Kullanım:
  python3 tools/test_emulator.py --serial emulator-5580
  python3 tools/test_emulator.py --serial emulator-5580 \\
      --apk android/app/build/outputs/apk/debug/app-debug.apk

Çıktılar varsayılan olarak ``/tmp/opencode/mt3d-emulator`` altına yazılır.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit, urlunsplit

AVD_NAME = "mt3d-qa"
DEFAULT_PACKAGE = "com.yigitbuyukeren.mayintarlasi3d"
DEFAULT_OUTPUT = Path("/tmp/opencode/mt3d-emulator")
OUTPUT_ROOT = Path("/tmp/opencode")
SERIAL_RE = re.compile(r"^emulator-[0-9]{4,5}$")
PACKAGE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$")
BOOT_TIMEOUT = 120
ACTIVE_JS = """() => {
  const start = document.querySelector('#start');
  const prog = document.querySelector('#prog');
  return !!start && !start.classList.contains('show')
    && parseFloat(prog?.style.width || '0') > 0
    && document.querySelectorAll('#lives .heart').length > 0;
}"""

PLANNED_CHECKS = [
    "hedef.serial",
    "hedef.cihaz",
    "hedef.avd",
    "hedef.boot",
    "paket.kurulum",
    "paket.internet_izni",
    "uygulama.baslatma",
    "uygulama.on_plan",
    "uygulama.ekran_goruntusu",
    "uygulama.uiautomator",
    "webview.devtools",
    "webview.konsol_hatalari",
    "kopru.mt3dApp",
    "uygulama.menuler",
    "uygulama.geri",
    "uygulama.home_resume",
    "uygulama.yonlendirme",
]


class StopTest(RuntimeError):
    """Ön koşul sağlanamadı; kalan kontroller SKIP olarak raporlanır."""


class Results:
    def __init__(self) -> None:
        self.checks: dict[str, dict[str, str]] = {}
        self.notes: list[str] = []
        self.started = datetime.now(timezone.utc)

    def record(self, name: str, status: str, detail: str = "") -> None:
        assert status in {"PASS", "FAIL", "SKIP"}, status
        if name in self.checks:
            raise RuntimeError(f"kontrol iki kez raporlandı: {name}")
        self.checks[name] = {"status": status, "detail": detail}
        print(f"[{status}] {name}: {detail}".rstrip(), flush=True)

    def note(self, detail: str) -> None:
        self.notes.append(detail)
        print(f"[INFO] {detail}", flush=True)

    def require(self, name: str, condition: bool, detail: str) -> None:
        if condition:
            self.record(name, "PASS", detail)
            return
        self.record(name, "FAIL", detail)
        raise StopTest(detail)

    def finish(self, output: Path, metadata: dict[str, object]) -> tuple[int, str]:
        for name in PLANNED_CHECKS:
            if name not in self.checks:
                self.record(name, "SKIP", "önceki adım tamamlanmadığı için çalıştırılmadı")
        statuses = [item["status"] for item in self.checks.values()]
        if "FAIL" in statuses:
            overall = "FAIL"
            code = 1
        elif "SKIP" in statuses:
            overall = "INCOMPLETE"
            code = 2
        else:
            overall = "PASS"
            code = 0
        finished = datetime.now(timezone.utc)
        report = {
            "overall": overall,
            "started_utc": self.started.isoformat(),
            "finished_utc": finished.isoformat(),
            "duration_seconds": round((finished - self.started).total_seconds(), 1),
            "metadata": metadata,
            "checks": self.checks,
            "notes": self.notes,
        }
        (output / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        lines = [f"Genel sonuç: {overall}"]
        for name, item in self.checks.items():
            lines.append(f"{item['status']:9} {name}: {item['detail']}")
        if self.notes:
            lines.append("Notlar:")
            lines.extend(f"  - {note}" for note in self.notes)
        summary = "\n".join(lines) + "\n"
        (output / "summary.txt").write_text(summary, encoding="utf-8")
        print("\n" + summary, end="", flush=True)
        print(f"Çıktılar: {output}", flush=True)
        return code, overall


class Adb:
    def __init__(self, executable: str, serial: str) -> None:
        self.executable = executable
        self.serial = serial

    def run(self, *args: str, timeout: int = 20, binary: bool = False) -> subprocess.CompletedProcess:
        command = [self.executable, "-s", self.serial, *args]
        try:
            return subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise StopTest(f"adb komutu çalıştırılamadı: {error}") from error

    def text(self, *args: str, timeout: int = 20) -> str:
        result = self.run(*args, timeout=timeout)
        stdout = result.stdout.decode("utf-8", "replace")
        stderr = result.stderr.decode("utf-8", "replace")
        if result.returncode != 0:
            raise StopTest(f"adb {' '.join(args)} başarısız: {(stderr or stdout).strip()}")
        return stdout

    def binary(self, *args: str, timeout: int = 30) -> bytes:
        result = self.run(*args, timeout=timeout, binary=True)
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", "replace").strip()
            raise StopTest(f"adb {' '.join(args)} başarısız: {stderr}")
        return result.stdout


def find_adb() -> str:
    explicit = os.environ.get("ADB")
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    for variable in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        value = os.environ.get(variable)
        if value:
            candidates.append(Path(value) / "platform-tools" / "adb")
    found = shutil.which("adb")
    if found:
        candidates.append(Path(found))
    for path in candidates:
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    raise SystemExit("adb bulunamadı; ANDROID_HOME/platform-tools veya PATH ayarlayın.")


def validate_serial(serial: str) -> None:
    if not SERIAL_RE.fullmatch(serial):
        raise SystemExit(
            "Yalnız emulator-<port> seri numarası kabul edilir; fiziksel cihaz reddedildi."
        )


def output_directory(raw: str) -> Path:
    path = Path(raw).expanduser()
    try:
        resolved = path.resolve()
    except OSError as error:
        raise SystemExit(f"Çıktı dizini çözümlenemedi: {error}") from error
    if not resolved.is_relative_to(OUTPUT_ROOT.resolve()):
        raise SystemExit(f"Çıktı dizini {OUTPUT_ROOT} altında olmalı.")
    resolved.mkdir(parents=True, exist_ok=True)
    if not resolved.is_dir():
        raise SystemExit(f"Çıktı yolu dizin değil: {resolved}")
    return resolved


def sleep(seconds: float) -> None:
    time.sleep(seconds)


def wait_for(predicate, timeout: float, description: str):
    deadline = time.monotonic() + timeout
    last_error = ""
    while time.monotonic() < deadline:
        try:
            value = predicate()
        except (StopTest, OSError, subprocess.SubprocessError) as error:
            last_error = str(error)
            value = None
        if value:
            return value
        sleep(0.5)
    suffix = f" (son hata: {last_error})" if last_error else ""
    raise StopTest(f"zaman aşımı: {description}{suffix}")


def emulator_avd_name(adb: Adb) -> str:
    output = adb.text("emu", "avd", "name", timeout=15)
    lines = [line.strip() for line in output.splitlines() if line.strip() and line.strip() != "OK"]
    return lines[0] if lines else ""


def boot_completed(adb: Adb) -> bool:
    output = adb.text("shell", "getprop", "sys.boot_completed", timeout=10).strip()
    return output == "1"


def wait_for_boot(adb: Adb) -> None:
    deadline = time.monotonic() + BOOT_TIMEOUT
    while time.monotonic() < deadline:
        if boot_completed(adb):
            return
        sleep(2)
    raise StopTest(f"emülatör {BOOT_TIMEOUT} saniye içinde açılmadı (sys.boot_completed != 1)")


def foreground_package(adb: Adb) -> str:
    """Ön plandaki uygulama paketini döndürür; bulunamazsa boş dize."""
    for command in (
        ("shell", "dumpsys", "window", "windows"),
        ("shell", "dumpsys", "activity", "activities"),
    ):
        text = adb.text(*command, timeout=20)
        for line in text.splitlines():
            if "mCurrentFocus" not in line and "mFocusedApp" not in line:
                continue
            match = re.search(r"\b([A-Za-z][A-Za-z0-9_.]*)/(?:[A-Za-z0-9_.$]+)", line)
            if match:
                return match.group(1)
        for line in text.splitlines():
            if "topResumedActivity" not in line and "mResumedActivity" not in line:
                continue
            match = re.search(r"\b([A-Za-z][A-Za-z0-9_.]*)/(?:[A-Za-z0-9_.$]+)", line)
            if match:
                return match.group(1)
    return ""


def resolve_component(adb: Adb, package: str) -> str:
    output = adb.text("shell", "cmd", "package", "resolve-activity", "--brief", package, timeout=20)
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        raise StopTest("launcher Activity çözümlenemedi")
    component = lines[-1]
    if not component.startswith(package + "/"):
        raise StopTest(f"beklenmeyen Activity bileşeni: {component}")
    return component


def package_installed(adb: Adb, package: str) -> bool:
    result = adb.run("shell", "pm", "path", package, timeout=15)
    return result.returncode == 0 and b"package:" in result.stdout


def screenshot(adb: Adb, target: Path) -> tuple[int, int]:
    data = adb.binary("exec-out", "screencap", "-p", timeout=30)
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise StopTest("screencap PNG imzası döndürmedi")
    if len(data) < 1024:
        raise StopTest(f"screencap çok küçük: {len(data)} bayt")
    target.write_bytes(data)
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def uiautomator_dump(adb: Adb, target: Path, remote: str) -> str:
    last_text = ""
    for _ in range(3):
        dump = adb.run("shell", "uiautomator", "dump", remote, timeout=30)
        last_text = (dump.stdout + dump.stderr).decode("utf-8", "replace")
        if dump.returncode == 0 and "dumped" in last_text.lower():
            break
        sleep(1)
    else:
        raise StopTest(f"uiautomator dump başarısız: {last_text.strip()[:200]}")
    xml_bytes = adb.binary("exec-out", "cat", remote, timeout=30)
    if not xml_bytes.startswith(b"<?xml"):
        raise StopTest("uiautomator XML beklenen biçimde değil")
    target.write_bytes(xml_bytes)
    root = ET.fromstring(xml_bytes)
    packages = sorted({node.get('package') for node in root.iter('node') if node.get('package')})
    return next((name for name in packages if name != 'com.android.systemui'), '')


def watch_console_errors(page) -> list[str]:
    """Test boyunca konsol/pageerror hatalarını toplar."""
    errors: list[str] = []

    def on_console(message) -> None:
        if message.type == "error":
            errors.append(f"console: {message.text}")

    def on_page_error(error) -> None:
        errors.append(f"pageerror: {error}")

    page.on("console", on_console)
    page.on("pageerror", on_page_error)
    return errors


def package_debuggable(adb: Adb, package: str) -> bool:
    dump = adb.text("shell", "dumpsys", "package", package, timeout=30)
    return re.search(r"\bDEBUGGABLE\b", dump) is not None


def find_devtools_socket(adb: Adb, package: str) -> str:
    pid_output = adb.text("shell", "pidof", package, timeout=10).strip()
    pid = pid_output.split()[0] if pid_output else ""
    unix = adb.text("shell", "cat", "/proc/net/unix", timeout=10)
    names = []
    for match in re.finditer(r"(?:@)?(webview_devtools_remote[^\s]*)", unix):
        name = match.group(1).lstrip("@")
        if name not in names:
            names.append(name)
    if not names:
        raise StopTest("WebView DevTools soketi bulunamadı (debug derleme gerekli)")
    if pid:
        exact = f"webview_devtools_remote_{pid}"
        for name in names:
            if name == exact:
                return name
    raise StopTest('Hedef uygulamanın WebView DevTools soketi bulunamadı')


def remove_forward(adb: Adb, port: int) -> None:
    result = adb.run("forward", "--remove", f"tcp:{port}", timeout=10)
    if result.returncode != 0:
        print(f"[INFO] kendi forward kaydı kaldırılamadı: tcp:{port}", flush=True)


def cdp_targets(port: int) -> list[dict]:
    url = f"http://127.0.0.1:{port}/json/list"
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            payload = json.load(response)
    except (OSError, ValueError) as error:
        raise StopTest(f"DevTools JSON okunamadı: {error}") from error
    return payload if isinstance(payload, list) else []


def choose_target(targets: list[dict], expected_url: str) -> dict | None:
    pages = [item for item in targets if item.get("type") == "page"]
    for item in pages:
        if item.get("url", "").startswith(expected_url):
            return item
    return None


class CdpPage:
    """WebView'in desteklemediği Browser API'lerini çağırmadan doğrudan Page/Runtime CDP."""

    def __init__(self, url: str):
        import websocket
        self.socket = websocket.create_connection(url, timeout=30, suppress_origin=True)
        self.sequence = 0
        self.listeners: dict[str, list] = {}
        self.command('Page.enable')
        self.command('Runtime.enable')
        self.command('Log.enable')
        self.command('Network.enable')

    def on(self, name, callback):
        self.listeners.setdefault(name, []).append(callback)

    def event(self, message):
        method = message.get('method')
        params = message.get('params', {})
        if method == 'Runtime.exceptionThrown':
            details = params.get('exceptionDetails', {})
            text = details.get('exception', {}).get('description') or details.get('text', 'JavaScript hatası')
            for callback in self.listeners.get('pageerror', []): callback(text)
        elif method == 'Runtime.consoleAPICalled' and params.get('type') == 'error':
            text = ' '.join(str(arg.get('value', arg.get('description', ''))) for arg in params.get('args', []))
            for callback in self.listeners.get('console', []): callback(SimpleNamespace(type='error', text=text))
        elif method == 'Log.entryAdded' and params.get('entry', {}).get('level') == 'error':
            for callback in self.listeners.get('console', []):
                callback(SimpleNamespace(type='error', text=params['entry'].get('text', 'WebView hatası')))
        elif method == 'Network.responseReceived' and params.get('response', {}).get('status', 0) >= 400:
            response = params['response']
            for callback in self.listeners.get('console', []):
                callback(SimpleNamespace(type='error', text=f"HTTP {response['status']}: {response.get('url')}"))

    def command(self, method, params=None):
        self.sequence += 1
        identifier = self.sequence
        self.socket.send(json.dumps({'id': identifier, 'method': method, 'params': params or {}}))
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            message = json.loads(self.socket.recv())
            if message.get('id') == identifier:
                if 'error' in message: raise StopTest(f'CDP {method}: {message["error"]}')
                return message.get('result', {})
            self.event(message)
        raise StopTest(f'CDP zaman aşımı: {method}')

    def evaluate(self, expression):
        result = self.command('Runtime.evaluate', {'expression': '(' + expression + ')()',
                                                  'returnByValue': True, 'awaitPromise': True, 'userGesture': True})
        if result.get('exceptionDetails'):
            raise StopTest(str(result['exceptionDetails']))
        return result.get('result', {}).get('value')

    def wait_for_function(self, expression, timeout=20000):
        return wait_for(lambda: self.evaluate(expression), timeout / 1000, 'WebView JavaScript koşulu')

    def wait_for_timeout(self, milliseconds):
        sleep(milliseconds / 1000)

    def reload(self, **kwargs):
        self.evaluate('() => { window.__mt3dQaReload = true; }')
        self.command('Page.reload', {'ignoreCache': True})
        self.wait_for_function("() => !window.__mt3dQaReload && document.readyState === 'complete'", timeout=kwargs.get('timeout', 20000))

    def screenshot(self, path):
        result = self.command('Page.captureScreenshot', {'format': 'png'})
        Path(path).write_bytes(base64.b64decode(result['data']))

    def close(self):
        self.socket.close()


def install_apk(adb: Adb, apk: Path, results: Results) -> None:
    if not apk.is_file():
        results.require("paket.kurulum", False, f"APK bulunamadı: {apk}")
    if apk.suffix.lower() != ".apk":
        results.require("paket.kurulum", False, f"APK uzantısı değil: {apk.name}")
    result = adb.run("install", "-r", str(apk), timeout=180)
    output = (result.stdout + result.stderr).decode("utf-8", "replace").strip()
    ok = result.returncode == 0 and "Success" in output
    results.require("paket.kurulum", ok, "APK kuruldu" if ok else f"adb install başarısız: {output[:300]}")


def check_internet_permission(adb: Adb, package: str, results: Results) -> None:
    dump = adb.text("shell", "dumpsys", "package", package, timeout=30)
    if f"Package [{package}]" not in dump:
        results.require("paket.internet_izni", False, "paket dökümü okunamadı")
    in_requested = False
    requested: list[str] = []
    for line in dump.splitlines():
        if re.match(r"^ {4}requested permissions:\s*$", line):
            in_requested = True
            continue
        if in_requested:
            # İzin satırları altı boşlukla girintilidir; dört boşluk yeni bölüm.
            if re.match(r"^ {4}\S", line):
                in_requested = False
                continue
            match = re.match(r"^ {6}([A-Za-z][A-Za-z0-9_.]+)\s*$", line)
            if match:
                requested.append(match.group(1))
    has_internet = any(item.endswith("INTERNET") for item in requested)
    results.require(
        "paket.internet_izni",
        not has_internet,
        "INTERNET izni yok"
        if not has_internet
        else f"istenmeyen ağ izni: {', '.join(requested)}",
    )


def check_bridge(page, results: Results) -> None:
    info = page.evaluate(
        """() => {
          const app = window.mt3dApp;
           const experience = window.MT3D_EXPERIENCE;
          return {
            hasApp: !!app,
            functions: app ? ['pause', 'resume', 'back']
              .filter((name) => typeof app[name] === 'function') : [],
            hasExperience: !!experience,
            experienceKeys: experience && typeof experience === 'object'
              ? Object.keys(experience).sort() : [],
          };
        }"""
    )
    required = {"pause", "resume", "back"}
    has_all = bool(info.get("hasApp")) and required.issubset(set(info.get("functions") or []))
    results.require(
        "kopru.mt3dApp",
        has_all and bool(info.get('hasExperience')),
        "window.mt3dApp.pause/resume/back hazır"
        if has_all
        else f"eksik köprü: {info}",
    )
    if info.get("hasExperience"):
        results.note('Mobil deneyim arayüzü hazır')


def wait_active(page, timeout: float = 15.0) -> None:
    try:
        page.wait_for_function(ACTIVE_JS, timeout=int(timeout * 1000))
    except Exception as error:
        raise StopTest(f"oyun etkin duruma gelmedi: {error}") from error


def wait_menu(page, timeout: float = 10.0) -> None:
    try:
        page.wait_for_function(
            "() => document.querySelector('#start')?.classList.contains('show') === true",
            timeout=int(timeout * 1000),
        )
    except Exception as error:
        raise StopTest(f"menü açılmadı: {error}") from error


def click_play(page) -> None:
    clicked = page.evaluate(
        """() => {
          const play = document.querySelector('#playBtn');
          const saved = document.querySelector('#continueBtn');
          const button = saved && getComputedStyle(saved).display !== 'none' && !play.textContent.includes('Devam') ? saved : play;
          if (!button) return false;
          button.click();
          if (document.querySelector('#padFlagLbl')?.textContent === 'İniş') document.querySelector('#padFlag').click();
          return true;
        }"""
    )
    if not clicked:
        raise StopTest("#playBtn bulunamadı")


def check_menus(page, output: Path, results: Results) -> None:
    if not page.evaluate("() => document.querySelector('#start')?.classList.contains('show') === true"):
        page.evaluate("() => window.mt3dApp.pause()")
        wait_menu(page)
    click_play(page)
    wait_active(page)
    page.evaluate("() => window.mt3dApp.pause()")
    wait_menu(page)
    try:
        page.screenshot(path=str(output / "menu.png"))
    except Exception as error:  # sayfa görüntüsü yardımcı çıktıdır; native PNG zaten alındı
        results.note(f"WebView menü görüntüsü alınamadı: {error}")
    resume_text = page.evaluate("() => (document.querySelector('#playBtn')?.textContent || '').trim()")
    click_play(page)
    wait_active(page)
    back_result = page.evaluate("() => window.mt3dApp.back()")
    wait_menu(page)
    click_play(page)
    wait_active(page)
    ok = back_result is True
    results.require(
        "uygulama.menuler",
        ok,
        f"menü aç/kapat, devam düğmesi ({resume_text!r}) ve back() menüsü çalışıyor"
        if ok
        else f"window.mt3dApp.back() beklenen true değil: {back_result!r}",
    )


def check_native_back(adb: Adb, page, package: str, results: Results) -> None:
    adb.text("shell", "input", "keyevent", "KEYCODE_BACK", timeout=15)
    try:
        wait_menu(page)
    except StopTest:
        results.require("uygulama.geri", False, "geri tuşu menüyü açmadı")
        raise
    foreground = foreground_package(adb)
    results.require(
        "uygulama.geri",
        foreground == package,
        "geri tuşu oyunu kapatmadan menüyü açtı" if foreground == package
        else f"geri sonrası ön plan beklenmeyen paket: {foreground or 'bilinmiyor'}",
    )
    click_play(page)
    wait_active(page)


def check_home_resume(adb: Adb, page, component: str, package: str, results: Results) -> None:
    adb.text("shell", "input", "keyevent", "KEYCODE_HOME", timeout=15)
    wait_for(
        lambda: foreground_package(adb) != package,
        15,
        "home sonrası uygulamanın ön plandan çıkması",
    )
    adb.text("shell", "am", "start", "-W", "-n", component, timeout=30)
    wait_for(
        lambda: foreground_package(adb) == package,
        20,
        "am start sonrası uygulamanın öne gelmesi",
    )
    page.wait_for_function("() => !!window.mt3dApp", timeout=20_000)
    wait_menu(page)
    click_play(page)
    wait_active(page)
    results.require(
        "uygulama.home_resume",
        True,
        "home sonrası uygulama yeniden öne geldi, menü ve devam çalıştı",
    )


def rotation_settings(adb: Adb) -> tuple[str, str]:
    auto = adb.text("shell", "settings", "get", "system", "accelerometer_rotation", timeout=10).strip()
    user = adb.text("shell", "settings", "get", "system", "user_rotation", timeout=10).strip()
    return auto, user


def set_rotation(adb: Adb, user_rotation: int) -> None:
    adb.text("shell", "settings", "put", "system", "accelerometer_rotation", "0", timeout=10)
    adb.text("shell", "settings", "put", "system", "user_rotation", str(user_rotation), timeout=10)


def restore_rotation(adb: Adb, original: tuple[str, str]) -> None:
    auto, user = original
    try:
        if auto not in {"", "null"}:
            adb.text("shell", "settings", "put", "system", "accelerometer_rotation", auto, timeout=10)
        if user not in {"", "null"}:
            adb.text("shell", "settings", "put", "system", "user_rotation", user, timeout=10)
    except StopTest as error:
        print(f"[INFO] döndürme ayarları geri yüklenemedi: {error}", flush=True)


def check_orientation(adb: Adb, page, output: Path, package: str, results: Results) -> None:
    original = rotation_settings(adb)
    try:
        set_rotation(adb, 0)
        sleep(1.5)
        width, height = screenshot(adb, output / "portrait.png")
        portrait_ok = height > width
        set_rotation(adb, 1)
        try:
            wait_for(
                lambda: (lambda size: size[0] > size[1])(
                    screenshot(adb, output / "landscape.png")
                ),
                15,
                "yatay ekran görüntüsü",
            )
            landscape_ok = True
        except StopTest:
            landscape_ok = False
        landscape_ok = landscape_ok and foreground_package(adb) == package
        page.wait_for_function("() => !!window.mt3dApp", timeout=15_000)
        try:
            page.wait_for_function(
                "() => window.innerWidth > window.innerHeight", timeout=10_000
            )
            viewport_ok = True
        except Exception:
            viewport_ok = False
        viewport = page.evaluate("() => ({w: window.innerWidth, h: window.innerHeight})")
        results.require(
            "uygulama.yonlendirme",
            portrait_ok and landscape_ok and viewport_ok,
            f"portrait {width}x{height}, yatay görünüm ve WebView {viewport}"
            if portrait_ok and landscape_ok and viewport_ok
            else f"döndürme doğrulanamadı: portrait={portrait_ok}, "
            f"landscape={landscape_ok}, webview={viewport}",
        )
    finally:
        restore_rotation(adb, original)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Mayın Tarlası 3D'yi yalnız mt3d-qa AVD'sinde sınar.",
        epilog="SKIP geçmiş sayılmaz; SKIP varsa çıkış kodu 2 (INCOMPLETE) olur.",
    )
    parser.add_argument("--serial", required=True, help="emulator-<port> (fiziksel cihaz reddedilir)")
    parser.add_argument("--apk", type=Path, help="isteğe bağlı debug APK; yalnız mt3d-qa AVD'sine kurulur")
    parser.add_argument("--package", default=DEFAULT_PACKAGE, help=f"varsayılan: {DEFAULT_PACKAGE}")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help=f"varsayılan: {DEFAULT_OUTPUT}")
    args = parser.parse_args()

    validate_serial(args.serial)
    if not PACKAGE_RE.fullmatch(args.package):
        parser.error("--package geçerli bir Android paket adı olmalı")
    output = output_directory(args.output)
    adb_path = find_adb()
    adb = Adb(adb_path, args.serial)
    results = Results()
    metadata: dict[str, object] = {
        "serial": args.serial,
        "package": args.package,
        "apk": str(args.apk) if args.apk else None,
        "output": str(output),
        "adb": adb_path,
    }
    forward_port: int | None = None
    remote_xml = "/sdcard/mt3d-qa-window.xml"
    try:
        # ---- Hedef ve önyükleme -------------------------------------------------
        state = adb.run("get-state", timeout=10)
        device_ok = state.returncode == 0 and b"device" in state.stdout
        results.require(
            "hedef.serial",
            device_ok,
            f"{args.serial} bağlı" if device_ok else f"adb get-state başarısız: {state.stderr.decode('utf-8', 'replace').strip()}",
        )
        qemu = adb.text("shell", "getprop", "ro.kernel.qemu", timeout=10).strip()
        results.require(
            "hedef.cihaz",
            qemu == "1",
            "ro.kernel.qemu=1 (emülatör)"
            if qemu == "1"
            else f"emülatör doğrulanamadı: ro.kernel.qemu={qemu!r}",
        )
        avd = emulator_avd_name(adb)
        metadata["avd"] = avd
        results.require(
            "hedef.avd",
            avd == AVD_NAME,
            f"AVD {AVD_NAME}" if avd == AVD_NAME else f"yalnız {AVD_NAME} kabul edilir; bulunan: {avd!r}",
        )
        wait_for_boot(adb)
        results.record("hedef.boot", "PASS", "sys.boot_completed=1")

        # ---- Paket --------------------------------------------------------------
        if args.apk is not None:
            install_apk(adb, args.apk, results)
        else:
            installed = package_installed(adb, args.package)
            results.require(
                "paket.kurulum",
                installed,
                "mevcut paket kullanılıyor" if installed else f"{args.package} kurulu değil; --apk verin",
            )
        check_internet_permission(adb, args.package, results)

        # ---- Native başlatma ----------------------------------------------------
        component = resolve_component(adb, args.package)
        metadata["component"] = component
        adb.run("shell", "am", "force-stop", args.package, timeout=15)
        started = adb.run("shell", "am", "start", "-W", "-n", component, timeout=45)
        start_text = (started.stdout + started.stderr).decode("utf-8", "replace")
        start_ok = started.returncode == 0 and "Error" not in start_text and "Status: ok" in start_text
        results.require(
            "uygulama.baslatma",
            start_ok,
            "Activity başlatıldı" if start_ok else f"am start başarısız: {start_text.strip()[:300]}",
        )
        wait_for(
            lambda: foreground_package(adb) == args.package,
            20,
            "uygulamanın ön plana gelmesi",
        )
        results.record("uygulama.on_plan", "PASS", f"ön plan: {args.package}")

        sleep(1.5)  # ilk karenin çizilmesi için sınırlı bekleme
        screenshot(adb, output / "launch.png")
        results.record("uygulama.ekran_goruntusu", "PASS", "launch.png")

        try:
            xml_package = uiautomator_dump(adb, output / "launch.xml", remote_xml)
            xml_ok = xml_package == args.package
            results.require(
                "uygulama.uiautomator",
                xml_ok,
                f"launch.xml ({xml_package or 'paket alanı yok'})"
                if xml_ok
                else f"uiautomator beklenmeyen paket: {xml_package}",
            )
        finally:
            try:
                adb.run("shell", "rm", "-f", remote_xml, timeout=10)
            except StopTest as error:
                print(f"[INFO] uzak XML temizliği: {error}", flush=True)

        # ---- WebView DevTools / CDP --------------------------------------------
        try:
            import websocket  # noqa: F401
        except ImportError as error:
            results.record("webview.devtools", "SKIP", f"websocket-client kurulu değil: {error}")
            raise StopTest("websocket-client yok; WebView kontrolleri çalıştırılamadı") from error

        if not package_debuggable(adb, args.package):
            results.record(
                "webview.devtools",
                "SKIP",
                "paket DEBUGGABLE değil; WebView DevTools için debug APK gerekli",
            )
            raise StopTest("debug olmayan paket: WebView kontrolleri çalıştırılamadı")

        try:
            socket_name = wait_for(
                lambda: find_devtools_socket(adb, args.package),
                20,
                "WebView DevTools soketinin açılması",
            )
        except StopTest as error:
            results.record("webview.devtools", "SKIP", str(error))
            raise
        metadata["devtools_socket"] = socket_name
        forward = adb.run("forward", "tcp:0", f"localabstract:{socket_name}", timeout=15)
        forward_text = (forward.stdout + forward.stderr).decode("utf-8", "replace").strip()
        if forward.returncode != 0 or not forward_text.isdigit():
            results.record("webview.devtools", "SKIP", f"adb forward kurulamadı: {forward_text[:200]}")
            raise StopTest("DevTools forward kurulamadı")
        forward_port = int(forward_text)
        metadata["forward_port"] = forward_port
        try:
            target = choose_target(cdp_targets(forward_port), "https://appassets.androidplatform.net")
        except StopTest as error:
            results.record("webview.devtools", "SKIP", str(error))
            raise
        if target is None:
            results.record("webview.devtools", "SKIP", "CDP hedefi bulunamadı")
            raise StopTest("WebView CDP hedefi yok")
        metadata["devtools_url"] = target.get("url")
        results.record("webview.devtools", "PASS", f"yerel forward tcp:{forward_port}")

        try:
            raw_url = urlsplit(target.get('webSocketDebuggerUrl', ''))
            if raw_url.scheme != 'ws' or not raw_url.path.startswith('/devtools/page/'):
                raise StopTest('Hedef WebView için geçerli Page CDP adresi yok')
            page = CdpPage(urlunsplit(('ws', f'127.0.0.1:{forward_port}', raw_url.path, '', '')))
            try:
                errors = watch_console_errors(page)
                page.reload(wait_until="load", timeout=20_000)
                page.wait_for_function("() => !!window.mt3dApp", timeout=20_000)
                page.wait_for_timeout(1_500)
                check_bridge(page, results)
                screenshot(adb, output / 'ready.png')
                check_menus(page, output, results)
                check_native_back(adb, page, args.package, results)
                check_home_resume(adb, page, component, args.package, results)
                check_orientation(adb, page, output, args.package, results)
                if errors:
                    results.record("webview.konsol_hatalari", "FAIL", "; ".join(errors[:5])[:500])
                    raise StopTest("WebView konsol hatası")
                results.record("webview.konsol_hatalari", "PASS", "konsol/pageerror hatası yok")
            finally:
                page.close()
        except StopTest:
            raise
        except Exception as error:
            raise StopTest(f"WebView/CDP hatası: {type(error).__name__}: {error}") from error
    except StopTest as error:
        print(f"[INFO] test durduruldu: {error}", flush=True)
    except Exception as error:
        results.record("calisma.hata", "FAIL", f"beklenmeyen hata: {type(error).__name__}: {error}")
    finally:
        if forward_port is not None:
            try:
                remove_forward(adb, forward_port)
            except StopTest as error:
                print(f"[INFO] forward temizliği: {error}", flush=True)
        try:
            adb.run("shell", "rm", "-f", remote_xml, timeout=10)
        except StopTest as error:
            print(f"[INFO] uzak XML temizliği: {error}", flush=True)
        code, _ = results.finish(output, metadata)
    return code


if __name__ == "__main__":
    sys.exit(main())
