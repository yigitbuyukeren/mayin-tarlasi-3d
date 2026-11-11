# Mayın Tarlası 3D
- Web oyunu tek dosyadır: `index.html`; framework veya ikinci bir oyun sayfası ekleme. Android uygulama kabuğu `android/`, çevrimdışı paketleme ve test araçları `tools/` altında tutulabilir; üretilen oyun sayfasını elle düzenleme.
- Dışarıdan yalnız sürümü sabitlenmiş Three.js (jsdelivr) ve Google Fonts yüklenir; yeni ağ isteği, CDN, analitik veya kullanıcı verisi gönderimi ekleme. `index.html` CSP'sini koru.
- Android sürümü kaynaklarını paket içinde taşımalı ve ağ izni istememeli. Paketleme sırasında doğrulanan sürümü sabit kaynaklar kullanılabilir; Android sayfasının CSP'si yalnız yerel kaynakları kabul etmeli. Kimlik bilgisi, imza anahtarı veya `local.properties` okuma/commit etme.
- Oyun durumu yalnız `localStorage` alanında `mt3d-v1-*` anahtarlarıyla tutulur; gerçek kullanıcı verisi kullanma.
- Mayınlar iniş karesi seçildikten sonra dizilmeli; 3×3 güvenli alan ve bütün güvenli karelerin yürüyerek ulaşılabilirliği korunmalı.
- Kontrol: `python3 tools/check.py`.
- Bu kontrol mobil kayıt birim testlerini, çevrimdışı paketlemeyi ve Android güvenlik sınırlarını da çalıştırır. Mobil davranış değişikliklerinde ayrıca `python3 tools/test_browser.py --url http://127.0.0.1:0 --assets android/app/src/main/assets` çalıştır. Android kabuğu değişikliklerinde `android/` içinde `./gradlew :app:compileDebugJavaWithJavac :app:lintDebug` gerekir; fiziksel cihaz testini bunlarla eşdeğer sayma.
- Canlı site yok; `main` push yalnız GitHub deposunu günceller.
