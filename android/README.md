# Mayın Tarlası 3D — Android kabuğu

Bu proje ayrı bir Gradle projesidir. Kök `index.html` değiştirilmez; Android için
türev çevrimdışı asset üretilir. Ağ izni yoktur, JavaScript köprüsü yoktur.

## Sürümler

| Bileşen | Sürüm | Doğrulama |
| --- | --- | --- |
| Android Gradle Plugin | 8.13.2 | [AGP 8.13 sürüm notları](https://developer.android.com/build/releases/past-releases/agp-8-13-0-release-notes): API 36.1'e kadar, Gradle 8.13+, JDK 17+ |
| Gradle | 8.14.3 | AGP 8.13 uyumlu; wrapper dağıtımı resmî SHA-256 ile sabitlendi |
| compileSdk / targetSdk | 36 / 36 | Yerel `platforms/android-36` |
| Build Tools | 36.0.0 | Yerel `build-tools/36.0.0` |
| JDK | 21 (daemon) | Gradle 8.14.3 JDK 27'yi çalıştırmaz; `gradle/gradle-daemon-jvm.properties` JDK 21 seçer |
| androidx.webkit | 1.14.0 | `WebViewAssetLoader`; yerel Gradle cache'inde mevcut kararlı sürüm |

Sistem varsayılanı JDK 27 ise doğrudan `./gradlew` çalıştırmayın; daemon dosyası
JDK 21 ister. Gerekirse:

```sh
JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew :app:assembleDebug
```

`local.properties` oluşturulmadı; `ANDROID_HOME="$HOME/Android/Sdk"` veya
kendi SDK yolunuzla kullanın.

`applicationId` başlangıç değeri `com.yigitbuyukeren.mayintarlasi3d` olarak
tanımlıdır. İlk mağaza yayını öncesinde bu kalıcı kimliği, uygulama adını ve
sürüm numaralarını doğrulayın. Mevcut launcher simgesi temel bir vektördür;
mağaza tanıtım görselleri ve imzalama anahtarı bu depoda tutulmaz.

## Çevrimdışı web assetleri

```sh
# Yalnız açık istekte: three 0.160.0 import kapanışını indirir ve SHA-256 manifesti yazar.
python3 tools/package_android.py vendor

# Ağa çıkmadan vendor'ı doğrular, index.html türevini ve lisansları üretir.
python3 tools/package_android.py package

# Üretilen assetler güncel mi?
python3 tools/package_android.py check
```

`package` varsayılan komuttur. Gradle `preBuild` görevi `package` komutunu çağırır;
böylece kaynak `index.html` ile asset arasında sürüklenme olmaz. `vendor` asla
kendiliğinden çalışmaz. Vendor dosyaları `android/vendor/three-0.160.0/` altında,
SHA-256 manifestiyle birlikte tutulur; yalnız gerekli 13 dosya (12 modül + MIT
lisansı) vardır.

Android türevinde:

- Google Fonts bağlantıları ve OG/favicon uzak referansları kaldırılır; sistem
  fontu kullanılır.
- CSP yalnız yerel kaynaklara izin verir; `connect-src 'none'` korunur.
- Importmap `./vendor/three/...` yerel yollarına çevrilir.
- Three.js MIT lisansı ve proje lisansı `assets/licenses/` altında paketlenir.

## Güvenlik ve yaşam döngüsü sözleşmesi

- Origin: `https://appassets.androidplatform.net/assets/` (`WebViewAssetLoader`).
- `INTERNET` izni yok; `allowBackup=false`, `usesCleartextTraffic=false`, cleartext
  kapalı network security config.
- Harici navigasyon ve asset origin dışı istekler 403 ile engellenir; `file://`,
  `content://`, dosya/universal erişim kapalı; mixed content `NEVER_ALLOW`.
- JavaScript köprüsü (`addJavascriptInterface`) yok. WebView debug yalnız
  `BuildConfig.DEBUG` derlemesinde açılır.
- `onPause`: `mt3dApp.pause()`, `WebView.onPause()`, `pauseTimers()`.
- `onResume`: `resumeTimers()`, `WebView.onResume()`, `mt3dApp.resume()`; `resume()`
  oyunu kendiliğinden başlatmaz.
- Geri: `mt3dApp.back()` JSON sonucu yalnız `false` ise native çıkış onayı gösterir.
  Android 13+ `OnBackInvokedCallback`, öncesinde `onBackPressed` kullanılır.
- Ana çerçeve yüklenemezse veya renderer kapanırsa boş ekran yerine yerel hata ve
  "Yeniden dene" arayüzü gösterilir.

## Kapsam dışı

APK/AAB üretimi, imzalama, cihaz kurulumu ve yayın ayrı açık talimat gerektirir.
Kaynak doğrulaması için `:app:compileDebugJavaWithJavac` ve `:app:lintDebug`
görevleri kullanılabilir; bunlar APK/AAB üretmez.
