# Android emülatör testi

Bu belge, `tools/test_emulator.py` betiğinin yalnız özel `mt3d-qa` AVD'sinde
nasıl çalıştırılacağını ve hangi sonuçları ürettiğini açıklar. Betik APK
üretmez; `--apk` açıkça verilmedikçe kurulum da yapmaz. APK üretimi, imzalama
ve yayın ayrı açık talimat gerektirir.

## Sınırlar

- Hedef yalnızca `emulator-<port>` seri numarası olabilir. Fiziksel cihazlar
  reddedilir.
- AVD adı `adb emu avd name` ile doğrulanır; yalnızca `mt3d-qa` kabul edilir.
- Başka emülatörler, kullanıcı AVD'leri ve bağlı cihazlar durdurulmaz.
- `--apk` verilmedikçe mevcut paket test edilir; kurulu değilse test geçmez.
- APK kurulumu yalnızca `--apk` açıkça verildiğinde ve AVD adı `mt3d-qa`
  doğrulandıktan sonra yapılır.
- Mevcut adb forward kayıtları silinmez. Betik yalnızca kendi açtığı geçici
  `tcp:0` forward'ını, işi bitince `adb forward --remove tcp:<port>` ile kaldırır.
- Uçak modu, ağ ayarları veya kullanıcı verileri değiştirilmez. Ağ sınırı
  `dumpsys package` içinde `INTERNET` izni aranarak denetlenir.
- Ekran görüntüsü ve `uiautomator` XML çıktıları yalnızca temiz QA AVD'sinden
  alınır; gerçek kullanıcı verisi kullanılmaz.

## Platform gereksinimleri

Teşhis edilen ve desteklenen ortam:

| Bileşen | Değer |
| --- | --- |
| İşletim sistemi | Linux |
| Sanallaştırma | KVM (`/dev/kvm` okunur/yazılır) |
| Android Emulator | 36.5.10 |
| Platform-tools | adb 37.0.0 |
| System image | `system-images;android-35;google_apis;x86_64` |
| AVD cihaz profili | `pixel_6` |
| Play Store | Yok (`google_apis`, oturum açma gerekmez) |

Yazılım GPU için emülatör `-gpu swiftshader` ile çalıştırılır. Donanım GPU,
masaüstü oturumu veya ses aygıtı gerekmez.

Python tarafı:

- Python 3.10+
- `adb` (`ANDROID_HOME/platform-tools/adb` veya `PATH`)
- WebView kontrolleri için `pip install -r tools/requirements-test.txt`

Bu betik `websocket-client` ile uygulamanın Page/Runtime CDP ucuna bağlanır.
WebView'in desteklemediği Browser bağlamı/indirme API'lerini çağırmaz. Ayrı Chromium
kurulumu bu betik için gerekmez; masaüstü mobil regresyonları Playwright kullanır.

## AVD oluşturma

Önce mevcut AVD'leri kontrol edin:

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
"$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" list avd
```

`mt3d-qa` zaten varsa ve bu betik için oluşturulduğu kesin değilse **dokunmayın**;
sahibinin kim olduğu belirsizse kullanıcıya sorun. Aynı adlı AVD'yi silmeyin
veya üzerine yazmayın.

Yoksa, kurulu image ile yalnızca bu özel AVD'yi oluşturun:

```sh
echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
  --name mt3d-qa \
  --package 'system-images;android-35;google_apis;x86_64' \
  --device pixel_6
```

Bazı SDK kurulumlarında `devices.xml` uyarısı görülebilir; AVD yine de
oluşturulur. Oluşturma sonrası `avdmanager list avd` ile `mt3d-qa` ve
`google_apis/x86_64` satırlarını doğrulayın.

## Emülatörü başlatma

Boş bir port seçin; bu projede örnek olarak `5580` kullanılır. Emülatör
`5580` konsol portunu, adb ise `5581` portunu kullanır. Önce portların boş
olduğunu kontrol edin:

```sh
ss -ltnp | grep -E ':(5580|5581)\b' || true
"$ANDROID_HOME/platform-tools/adb" devices -l
```

Başlatma:

```sh
"$ANDROID_HOME/emulator/emulator" \
  -avd mt3d-qa \
  -port 5580 \
  -no-window -no-audio -no-boot-anim \
  -gpu swiftshader \
  -no-snapshot -no-metrics
```

Bu komut uzun süre çalışır; ayrı bir terminalde veya arka planda çalıştırın.
Hazır olma koşulu:

```sh
"$ANDROID_HOME/platform-tools/adb" -s emulator-5580 shell getprop sys.boot_completed
# 1 dönmeli
"$ANDROID_HOME/platform-tools/adb" -s emulator-5580 emu avd name
# mt3d-qa dönmeli
```

Yalnızca kendi AVD'nizi kapatmak için:

```sh
"$ANDROID_HOME/platform-tools/adb" -s emulator-5580 emu kill
```

Başka bir emülatörü veya kullanıcı AVD'sini kapatmayın.

## APK

Betik APK üretmez. Test için hazır bir **debug** APK yolu verilmelidir. APK
üretimi ayrı açık onay gerektirir; bu belge üretim adımını otomatikleştirmez.
Gerekirse proje kökünde:

```sh
cd android
JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew :app:assembleDebug
```

Debug derleme, WebView DevTools'un açık olması için gereklidir. Release APK'da
DevTools kapalıdır; betik bunu SKIP olarak raporlar ve genel sonuç
`INCOMPLETE` olur. Bu, testin geçtiği anlamına gelmez.

## Testi çalıştırma

Mevcut kurulu paketi test etmek için:

```sh
python3 tools/test_emulator.py --serial emulator-5580
```

APK'yı yalnızca `mt3d-qa` AVD'sine kurup test etmek için:

```sh
python3 tools/test_emulator.py \
  --serial emulator-5580 \
  --apk android/app/build/outputs/apk/debug/app-debug.apk
```

Varsayılanlar:

- paket: `com.yigitbuyukeren.mayintarlasi3d`
- çıktı: `/tmp/opencode/mt3d-emulator`
- çıktı dizini `/tmp/opencode` altında olmalıdır

## Kontroller

| Kontrol | Açıklama |
| --- | --- |
| `hedef.serial` | adb hedefi bağlı ve `emulator-*` |
| `hedef.cihaz` | `ro.kernel.qemu=1` |
| `hedef.avd` | adb AVD adı `mt3d-qa` |
| `hedef.boot` | `sys.boot_completed=1` (en fazla 120 sn) |
| `paket.kurulum` | APK kurulumu veya mevcut paket |
| `paket.internet_izni` | `INTERNET` izni yok |
| `uygulama.baslatma` | launcher Activity `am start -W` ile açılır |
| `uygulama.on_plan` | `dumpsys` ön planında uygulama paketi |
| `uygulama.ekran_goruntusu` | native `screencap` PNG |
| `uygulama.uiautomator` | `uiautomator dump` XML |
| `webview.devtools` | yalnız yerel geçici forward ile CDP |
| `webview.konsol_hatalari` | reload ve etkileşimlerde konsol/pageerror |
| `kopru.mt3dApp` | `pause/resume/back` fonksiyonları |
| `uygulama.menuler` | menü aç/kapat ve devam düğmesi |
| `uygulama.geri` | native geri tuşu menüyü açar, oyun kapanmaz |
| `uygulama.home_resume` | home sonrası yeniden ön plan ve menü |
| `uygulama.yonlendirme` | portrait/landscape ve WebView viewport |

Oyun sözleşmesinin yanında `window.MT3D_EXPERIENCE` arayüzünün yüklenmesi de
zorunludur. HTML öğreticisi ve ödül senaryoları ayrıca `tools/test_experience.py`
ile gerçek tarayıcı dokunuşları üzerinden doğrulanır.

## Sonuçlar

- `PASS`: kontrol geçti.
- `FAIL`: kontrol veya ön koşul başarısız.
- `SKIP`: kontrol çalıştırılamadı (ör. websocket-client yok, release APK'da DevTools
  kapalı, emülatör döndürmedi). **SKIP geçmiş sayılmaz.**

Genel sonuç:

- `PASS` → çıkış kodu `0`
- `FAIL` → çıkış kodu `1`
- `INCOMPLETE` (en az bir SKIP) → çıkış kodu `2`

Üretilen dosyalar:

- `report.json` — makine okunabilir tam rapor
- `summary.txt` — kısa insan okunabilir özet
- `launch.png` (ilk kare), `ready.png` (arayüz hazır), `menu.png`, `portrait.png`, `landscape.png`
- `launch.xml` — `uiautomator` hiyerarşisi

Rapor, testin geçmediği kontrolleri açıkça gösterir. Eksik bir kontrolü
`PASS`'a çevirmek veya testi yalnızca "emülatör açıldı" diye başarılı saymak
doğru değildir.
