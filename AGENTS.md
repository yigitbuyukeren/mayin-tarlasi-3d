# Mayın Tarlası 3D
- Tek dosya: `index.html`; framework, build adımı veya ikinci bir sayfa ekleme.
- Dışarıdan yalnız sürümü sabitlenmiş Three.js (jsdelivr) ve Google Fonts yüklenir; yeni ağ isteği, CDN, analitik veya kullanıcı verisi gönderimi ekleme. `index.html` CSP'sini koru.
- Oyun durumu yalnız `localStorage` alanında `mt3d-v1-*` anahtarlarıyla tutulur; gerçek kullanıcı verisi kullanma.
- Mayınlar iniş karesi seçildikten sonra dizilmeli; 3×3 güvenli alan ve bütün güvenli karelerin yürüyerek ulaşılabilirliği korunmalı.
- Kontrol: `python3 tools/check.py`.
- Canlı site yok; `main` push yalnız GitHub deposunu günceller.
