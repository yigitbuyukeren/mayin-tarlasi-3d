// Pure, DOM-free campaign progression, cosmetics, daily challenge and reward ledger.
// Loaded as a classic script; exposes exactly one global: window.MT3D_PROGRESS.
// tools/test_progression.mjs extracts this file and runs it under Node's vm module.
//
// Persistence is intentionally separate from the board save: the game stores this profile
// under `mt3d-v1-profile`. The existing `mt3d-v1-stars` / `mt3d-v1-unlocked` keys stay
// untouched; the core builds a baseline profile from them exactly once (no retroactive coins).
(function () {
  'use strict';

  const VERSION = 1;
  const PROFILE_KEY = 'mt3d-v1-profile';
  const MAX_COINS = 999999;
  const MAX_SECONDS = 86400;
  const MAX_CELLS = 324;          // largest campaign board is 18x18
  const MAX_STAT = 999999999;
  const MAX_CLEARS = 100000;
  const MAX_RUNS = 128;           // processed run ids kept for idempotency
  const MAX_DAILY_DAYS = 30;
  const MAX_RUN_ID = 64;
  const MIN_DAY_YEAR = 1970;
  const MAX_DAY_YEAR = 2100;

  const MODES = Object.freeze(['kampanya', 'kolay', 'orta', 'zor', 'gunluk']);
  const FREE_MODES = Object.freeze(['kolay', 'orta', 'zor']);
  const THEMES = Object.freeze(['meadow', 'desert', 'snow', 'night']);
  const DEFAULT_SKIN = 'yesil';

  const REGIONS = Object.freeze([
    Object.freeze({ id: 'kesif-hatti', name: 'Keşif Hattı' }),
    Object.freeze({ id: 'firtina-gecidi', name: 'Fırtına Geçidi' }),
    Object.freeze({ id: 'zirve-yolu', name: 'Zirve Yolu' }),
    Object.freeze({ id: 'kara-kusak', name: 'Kara Kuşak' }),
  ]);

  const SKINS = Object.freeze([
    Object.freeze({ id: 'yesil', name: 'Yeşil Uzman', cost: 0, color: '#4fd35a' }),
    Object.freeze({ id: 'kizil', name: 'Kızıl Kâşif', cost: 80, color: '#e05555' }),
    Object.freeze({ id: 'mavi', name: 'Mavi Dedektör', cost: 120, color: '#3d8bfd' }),
    Object.freeze({ id: 'mor', name: 'Mor Hayalet', cost: 180, color: '#a56cff' }),
    Object.freeze({ id: 'altin', name: 'Altın Uzman', cost: 250, color: '#ffcf4d' }),
    Object.freeze({ id: 'buz', name: 'Buz Gezgini', cost: 300, color: '#8fe6ff' }),
  ]);

  const ACHIEVEMENTS = Object.freeze([
    Object.freeze({ id: 'ilk-zafer', title: 'İlk Zafer', description: 'İlk galibiyetini al.' }),
    Object.freeze({ id: 'kusursuz', title: 'Kusursuz', description: 'Bir bölümü can kaybetmeden bitir.' }),
    Object.freeze({ id: 'dedektif', title: 'Dedektif', description: 'Dedektör hedefli bir bölüm kazan.' }),
    Object.freeze({ id: 'gunluk-ilk', title: 'Günün Kahramanı', description: 'Günlük görevi ilk kez kazan.' }),
    Object.freeze({ id: 'seri-3', title: 'Üçlü Seri', description: 'Üst üste 3 zafer kazan.' }),
    Object.freeze({ id: 'seri-7', title: 'Yedili Seri', description: 'Üst üste 7 zafer kazan.' }),
    Object.freeze({ id: 'koleksiyoncu', title: 'Koleksiyoncu', description: '4 görünüme sahip ol.' }),
    Object.freeze({ id: 'zengin', title: 'Kasa Dolu', description: '500 paraya ulaş.' }),
    Object.freeze({ id: 'bolge-uzmani', title: 'Bölge Uzmanı', description: '6 kampanya bölümü kazan.' }),
    Object.freeze({ id: 'tarayici', title: 'Tarayıcı', description: 'Toplam 50 kare tara.' }),
  ]);
  const ACHIEVEMENT_IDS = Object.freeze(ACHIEVEMENTS.map(a => a.id));

  const SECOND = 1;
  const FIRST_CLEAR_BASE = 10;
  const OBJECTIVE_BONUS = 15;
  const RECORD_BONUS = 3;
  const DAILY_WIN_BONUS = 12;
  const DAILY_OBJECTIVE_BONUS = 5;

  function objective(kind, value, label) {
    const obj = { kind, label };
    if (value != null) obj.value = value;
    return Object.freeze(obj);
  }

  // Campaign catalog. Indices 0-7 are byte-for-byte compatible with the original
  // MT3D_DATA.STAGE_CFG order (w, d, m, theme); the 16 new stages are appended after.
  // Regions are six-stage chapters; the fixed original order means chapter 1 contains
  // the original meadow/desert/snow tour.
  const CATALOG = Object.freeze([
    // Keşif Hattı (1-6) — the original eight stages start here.
    Object.freeze({
      id: 'cayir-kapisi', title: 'Çayır Kapısı', region: 'Keşif Hattı',
      description: 'İlk iniş. Çayırın açık karelerinde yürüyerek temel ritmi öğren.',
      w: 8, d: 8, m: 8, theme: 'meadow', parSeconds: 90,
      objective: objective('finish', null, 'Bölümü tamamla'),
    }),
    Object.freeze({
      id: 'ruzgarli-ova', title: 'Rüzgârlı Ova', region: 'Keşif Hattı',
      description: 'Rüzgârın savurduğu otlar arasında daha geniş bir ovayı temizle.',
      w: 10, d: 10, m: 13, theme: 'meadow', parSeconds: 120,
      objective: objective('clean', null, 'Hiç can kaybetmeden bitir'),
    }),
    Object.freeze({
      id: 'kum-tepeleri', title: 'Kum Tepeleri', region: 'Keşif Hattı',
      description: 'İlk çöl sıcağı. Kumun altındaki mayınları dikkatle işaretle.',
      w: 10, d: 10, m: 15, theme: 'desert', parSeconds: 120,
      objective: objective('scanLimit', 2, 'En fazla 2 dedektör hakkı kullan'),
    }),
    Object.freeze({
      id: 'kuru-dere', title: 'Kuru Dere', region: 'Keşif Hattı',
      description: 'Kurumuş dere yatağı boyunca ilerle; süreyi kısa tut.',
      w: 12, d: 12, m: 21, theme: 'desert', parSeconds: 150,
      objective: objective('time', 150, '150 saniye içinde bitir'),
    }),
    Object.freeze({
      id: 'kar-serpintisi', title: 'Kar Serpintisi', region: 'Keşif Hattı',
      description: 'İlk kar. Beyaz zemin mayınları saklıyor; hasarsız bitirmeyi dene.',
      w: 12, d: 12, m: 23, theme: 'snow', parSeconds: 150,
      objective: objective('clean', null, 'Hiç can kaybetmeden bitir'),
    }),
    Object.freeze({
      id: 'buzlu-yamac', title: 'Buzlu Yamaç', region: 'Keşif Hattı',
      description: 'Yamacın buzlu yüzeyinde tempoyu koru ve hedef süreyi yakala.',
      w: 14, d: 14, m: 30, theme: 'snow', parSeconds: 180,
      objective: objective('time', 180, '180 saniye içinde bitir'),
    }),
    // Fırtına Geçidi (7-12) — original stages 7-8 plus four harder fields.
    Object.freeze({
      id: 'gece-devriyesi', title: 'Gece Devriyesi', region: 'Fırtına Geçidi',
      description: 'Karanlıkta devriye. Dedektörü idareli kullanmayı öğren.',
      w: 12, d: 12, m: 22, theme: 'night', parSeconds: 150,
      objective: objective('scanLimit', 2, 'En fazla 2 dedektör hakkı kullan'),
    }),
    Object.freeze({
      id: 'ay-tutulmasi', title: 'Ay Tutulması', region: 'Fırtına Geçidi',
      description: 'Ay ışığı azalırken geniş gece tarlasını tamamen aç.',
      w: 16, d: 16, m: 40, theme: 'night', parSeconds: 210,
      objective: objective('finish', null, 'Bölümü tamamla'),
    }),
    Object.freeze({
      id: 'kum-vadisi', title: 'Kum Vadisi', region: 'Fırtına Geçidi',
      description: 'Vadi tabanındaki yoğun kum hattını süre baskısıyla temizle.',
      w: 16, d: 16, m: 41, theme: 'desert', parSeconds: 210,
      objective: objective('time', 210, '210 saniye içinde bitir'),
    }),
    Object.freeze({
      id: 'beyaz-sirt', title: 'Beyaz Sırt', region: 'Fırtına Geçidi',
      description: 'Sırtın karla kaplı omurgasında tek bir hata bile can götürür.',
      w: 16, d: 16, m: 43, theme: 'snow', parSeconds: 210,
      objective: objective('clean', null, 'Hiç can kaybetmeden bitir'),
    }),
    Object.freeze({
      id: 'ay-isigi', title: 'Ay Işığı', region: 'Fırtına Geçidi',
      description: 'Ay ışığının yetmediği yerde tek dedektör hakkıyla ilerle.',
      w: 16, d: 16, m: 45, theme: 'night', parSeconds: 210,
      objective: objective('scanLimit', 1, 'En fazla 1 dedektör hakkı kullan'),
    }),
    Object.freeze({
      id: 'karanlik-gecit', title: 'Karanlık Geçit', region: 'Fırtına Geçidi',
      description: 'Dar geçitte hız ve dikkat aynı anda sınanıyor.',
      w: 17, d: 17, m: 47, theme: 'night', parSeconds: 230,
      objective: objective('time', 230, '230 saniye içinde bitir'),
    }),
    // Zirve Yolu (13-18) — four new fields carried by snow/desert/night.
    Object.freeze({
      id: 'buz-yarigi', title: 'Buz Yarığı', region: 'Zirve Yolu',
      description: 'Yarığın iki yakasında güvenli koridoru can kaybetmeden koru.',
      w: 16, d: 16, m: 45, theme: 'snow', parSeconds: 210,
      objective: objective('clean', null, 'Hiç can kaybetmeden bitir'),
    }),
    Object.freeze({
      id: 'kayip-kervan', title: 'Kayıp Kervan', region: 'Zirve Yolu',
      description: 'Kervan yolunu yeniden aç; kum fırtınası süreyi kısaltıyor.',
      w: 17, d: 17, m: 47, theme: 'desert', parSeconds: 230,
      objective: objective('time', 230, '230 saniye içinde bitir'),
    }),
    Object.freeze({
      id: 'cig-hatti', title: 'Çığ Hattı', region: 'Zirve Yolu',
      description: 'Çığ hattında iki dedektörden fazlasını harcama.',
      w: 17, d: 17, m: 48, theme: 'snow', parSeconds: 230,
      objective: objective('scanLimit', 2, 'En fazla 2 dedektör hakkı kullan'),
    }),
    Object.freeze({
      id: 'yildizsiz-gece', title: 'Yıldızsız Gece', region: 'Zirve Yolu',
      description: 'Yıldızların olmadığı en karanlık gecede hedef süreye ulaş.',
      w: 18, d: 18, m: 50, theme: 'night', parSeconds: 250,
      objective: objective('time', 250, '250 saniye içinde bitir'),
    }),
    Object.freeze({
      id: 'donmus-gol', title: 'Donmuş Göl', region: 'Zirve Yolu',
      description: 'Buzun üstünde iz bırakmadan, hasarsız bir zafer kazan.',
      w: 16, d: 16, m: 47, theme: 'snow', parSeconds: 210,
      objective: objective('clean', null, 'Hiç can kaybetmeden bitir'),
    }),
    Object.freeze({
      id: 'kizil-col', title: 'Kızıl Çöl', region: 'Zirve Yolu',
      description: 'Ufuk çizgisine kadar kızıllaşan çölde zamanla yarış.',
      w: 18, d: 18, m: 50, theme: 'desert', parSeconds: 250,
      objective: objective('time', 250, '250 saniye içinde bitir'),
    }),
    // Kara Kuşak (19-24) — the final night-heavy gauntlet.
    Object.freeze({
      id: 'sessiz-vadi', title: 'Sessiz Vadi', region: 'Kara Kuşak',
      description: 'Sessizliğin içinde tek dedektörle güvenli yolu bul.',
      w: 17, d: 17, m: 49, theme: 'night', parSeconds: 230,
      objective: objective('scanLimit', 1, 'En fazla 1 dedektör hakkı kullan'),
    }),
    Object.freeze({
      id: 'kara-kule', title: 'Kara Kule', region: 'Kara Kuşak',
      description: 'Kulenin gölgesinde kampanyanın son gece sınavına hazırlan.',
      w: 16, d: 16, m: 48, theme: 'night', parSeconds: 210,
      objective: objective('finish', null, 'Bölümü tamamla'),
    }),
    Object.freeze({
      id: 'kutup-ruzgari', title: 'Kutup Rüzgârı', region: 'Kara Kuşak',
      description: 'Kutup rüzgârı hız kesmeden esiyor; hedef süreyi aşma.',
      w: 17, d: 17, m: 50, theme: 'snow', parSeconds: 230,
      objective: objective('time', 250, '250 saniye içinde bitir'),
    }),
    Object.freeze({
      id: 'toz-bulutu', title: 'Toz Bulutu', region: 'Kara Kuşak',
      description: 'Toz bulutunda görüş düşer; dedektör hakkını idareli kullan.',
      w: 17, d: 17, m: 49, theme: 'desert', parSeconds: 230,
      objective: objective('scanLimit', 2, 'En fazla 2 dedektör hakkı kullan'),
    }),
    Object.freeze({
      id: 'son-nefes', title: 'Son Nefes', region: 'Kara Kuşak',
      description: 'Son nefesini verirken süreyi ve karanlığı birlikte yen.',
      w: 18, d: 18, m: 53, theme: 'night', parSeconds: 250,
      objective: objective('time', 250, '250 saniye içinde bitir'),
    }),
    Object.freeze({
      id: 'kara-ufuk', title: 'Kara Ufuk', region: 'Kara Kuşak',
      description: 'Kara ufkun ötesindeki son tarla; hiç hasar almadan bitir.',
      w: 18, d: 18, m: 55, theme: 'night', parSeconds: 250,
      objective: objective('clean', null, 'Hiç can kaybetmeden bitir'),
    }),
  ]);

  const STAGE_COUNT = CATALOG.length;

  // Daily boards deliberately stay small (9x9 / 12x12) so a phone run is a single sitting.
  const DAILY_CFGS = Object.freeze([
    Object.freeze({ w: 9, d: 9, m: 12, theme: 'meadow', title: 'Çayır Nöbeti', parSeconds: 100 }),
    Object.freeze({ w: 9, d: 9, m: 14, theme: 'desert', title: 'Kum Nöbeti', parSeconds: 110 }),
    Object.freeze({ w: 12, d: 12, m: 20, theme: 'snow', title: 'Kar Nöbeti', parSeconds: 150 }),
    Object.freeze({ w: 12, d: 12, m: 22, theme: 'night', title: 'Gece Nöbeti', parSeconds: 160 }),
  ]);

  const SKIN_IDS = Object.freeze(SKINS.map(s => s.id));

  // ---------- primitive guards ----------

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function boundedInt(value, min, max, fallback) {
    let n = value;
    if (typeof n === 'string' && n.trim() !== '') n = Number(n);
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    n = Math.trunc(n);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function safeBool(value) {
    return value === true;
  }

  function validDayKey(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < MIN_DAY_YEAR || year > MAX_DAY_YEAR) return null;
    const stamp = Date.UTC(year, month - 1, day);
    const date = new Date(stamp);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return value;
  }

  function utcDay(date) {
    let time;
    if (date == null) time = Date.now();
    else if (typeof date === 'number') {
      if (!Number.isFinite(date)) throw new TypeError('gecersiz tarih');
      time = date;
    } else if (Object.prototype.toString.call(date) === '[object Date]') {
      time = date.getTime();
      if (!Number.isFinite(time)) throw new TypeError('gecersiz tarih');
    } else {
      throw new TypeError('gecersiz tarih');
    }
    return new Date(time).toISOString().slice(0, 10);
  }

  function hash32(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function seededRandom(seed) {
    let state = (typeof seed === 'number' && Number.isFinite(seed)) ? (seed >>> 0) : 0;
    return function next() {
      state = (state + 0x6D2B79F5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function dailyChallenge(dayKey) {
    const key = dayKey == null ? utcDay() : validDayKey(dayKey);
    if (!key) throw new TypeError('gecersiz gun anahtari');
    const seed = hash32('mt3d-daily|' + key);
    const configIndex = seed % DAILY_CFGS.length;
    const base = DAILY_CFGS[configIndex];
    const objectiveKinds = ['finish', 'clean', 'scanLimit', 'time'];
    const kind = objectiveKinds[(seed >>> 8) % objectiveKinds.length];
    let obj;
    if (kind === 'finish') obj = objective('finish', null, 'Bölümü tamamla');
    else if (kind === 'clean') obj = objective('clean', null, 'Hiç can kaybetmeden bitir');
    else if (kind === 'scanLimit') obj = objective('scanLimit', 2, 'En fazla 2 dedektör hakkı kullan');
    else obj = objective('time', base.parSeconds, base.parSeconds + ' saniye içinde bitir');
    return {
      dayKey: key,
      seed,
      cfg: { w: base.w, d: base.d, m: base.m, theme: base.theme },
      title: 'Günün Tarlası: ' + base.title,
      objective: obj,
      configIndex,
      parSeconds: base.parSeconds,
    };
  }

  // ---------- profile normalization ----------

  function defaultStatistics() {
    return {
      runs: 0, wins: 0, losses: 0,
      campaignWins: 0, dailyWins: 0, freeWins: 0,
      streak: 0, bestStreak: 0,
      scanned: 0, minesFlagged: 0,
      objectives: 0,
    };
  }

  function defaultProfile() {
    return {
      v: VERSION,
      coins: 0,
      tutorialCompleted: false,
      stageResults: {},
      achievements: [],
      inventory: [DEFAULT_SKIN],
      selectedSkin: DEFAULT_SKIN,
      statistics: defaultStatistics(),
      dailyResults: {},
      processedRuns: [],
    };
  }

  function normalizeStageResults(raw) {
    const out = {};
    if (!isObject(raw)) return out;
    for (let i = 0; i < STAGE_COUNT; i++) {
      const entry = raw[i];
      if (!isObject(entry)) continue;
      const clears = boundedInt(entry.clears, 0, MAX_CLEARS, 0);
      if (clears <= 0) continue; // baseline entries must carry clears >= 1
      // Unknown/migrated entries are treated as already having claimed their one-time record
      // bonuses so old stars can never pay a retroactive reward. Entries written by
      // recordResult carry explicit false flags until a genuine improvement is paid.
      out[i] = {
        clears,
        bestLives: boundedInt(entry.bestLives, 1, 3, 3),
        // A missing/null time means "clear known, time unknown"; negative numbers still clamp to 0.
        bestTime: entry.bestTime == null ? null : boundedInt(entry.bestTime, 0, MAX_SECONDS, 0),
        bestScan: boundedInt(entry.bestScan, 0, 3, 0),
        objectiveMet: safeBool(entry.objectiveMet),
        livesRecordPaid: typeof entry.livesRecordPaid === 'boolean' ? entry.livesRecordPaid : true,
        timeRecordPaid: typeof entry.timeRecordPaid === 'boolean' ? entry.timeRecordPaid : true,
      };
    }
    return out;
  }

  function normalizeStatistics(raw) {
    const stats = defaultStatistics();
    if (!isObject(raw)) return stats;
    for (const key of Object.keys(stats)) stats[key] = boundedInt(raw[key], 0, MAX_STAT, 0);
    if (stats.bestStreak < stats.streak) stats.bestStreak = stats.streak;
    return stats;
  }

  function normalizeAchievements(raw) {
    const owned = new Set();
    if (Array.isArray(raw)) {
      for (const value of raw) if (typeof value === 'string' && ACHIEVEMENT_IDS.includes(value)) owned.add(value);
    }
    return ACHIEVEMENT_IDS.filter(id => owned.has(id));
  }

  function normalizeInventory(raw) {
    const owned = new Set([DEFAULT_SKIN]);
    if (Array.isArray(raw)) {
      for (const value of raw) if (typeof value === 'string' && SKIN_IDS.includes(value)) owned.add(value);
    }
    return SKIN_IDS.filter(id => owned.has(id));
  }

  function normalizeDailyEntry(raw) {
    if (!isObject(raw)) return null;
    const runs = boundedInt(raw.runs, 0, MAX_STAT, 0);
    const wins = boundedInt(raw.wins, 0, MAX_STAT, 0);
    if (runs <= 0 && wins <= 0) return null;
    return {
      runs,
      wins,
      bestLives: wins > 0 ? boundedInt(raw.bestLives, 1, 3, 1) : 0,
      bestTime: wins > 0 ? boundedInt(raw.bestTime, 0, MAX_SECONDS, MAX_SECONDS) : null,
      objectiveMet: safeBool(raw.objectiveMet),
    };
  }

  function normalizeDailyResults(raw) {
    const out = {};
    if (!isObject(raw)) return out;
    const keys = Object.keys(raw).filter(key => validDayKey(key)).sort().reverse();
    for (const key of keys.slice(0, MAX_DAILY_DAYS)) {
      const entry = normalizeDailyEntry(raw[key]);
      if (entry) out[key] = entry;
    }
    return out;
  }

  function normalizeProcessedRuns(raw) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(raw)) return out;
    for (const item of raw) {
      if (!isObject(item)) continue;
      let runId = null;
      if (typeof item.runId === 'string') runId = item.runId;
      else if (typeof item.runId === 'number' && Number.isFinite(item.runId)) runId = String(item.runId);
      if (!runId || runId.length < 1 || runId.length > MAX_RUN_ID) continue;
      if (seen.has(runId)) continue;
      if (!MODES.includes(item.mode)) continue;
      if (!Number.isInteger(item.stageIndex) || item.stageIndex < 0 || item.stageIndex >= STAGE_COUNT) continue;
      const stageIndex = item.stageIndex;
      const dayKey = validDayKey(item.dayKey);
      if (!dayKey) continue;
      seen.add(runId);
      out.push({
        runId,
        dayKey,
        mode: item.mode,
        stageIndex,
        won: safeBool(item.won),
        coins: boundedInt(item.coins, 0, MAX_COINS, 0),
        objectiveMet: safeBool(item.objectiveMet),
        firstClear: safeBool(item.firstClear),
      });
    }
    return out.slice(-MAX_RUNS);
  }

  function normalizeProfile(raw) {
    const profile = defaultProfile();
    if (!isObject(raw)) return profile;
    profile.coins = boundedInt(raw.coins, 0, MAX_COINS, 0);
    profile.tutorialCompleted = safeBool(raw.tutorialCompleted);
    profile.stageResults = normalizeStageResults(raw.stageResults);
    profile.achievements = normalizeAchievements(raw.achievements);
    profile.inventory = normalizeInventory(raw.inventory);
    const selected = typeof raw.selectedSkin === 'string' ? raw.selectedSkin : '';
    profile.selectedSkin = profile.inventory.includes(selected) ? selected : DEFAULT_SKIN;
    profile.statistics = normalizeStatistics(raw.statistics);
    profile.dailyResults = normalizeDailyResults(raw.dailyResults);
    profile.processedRuns = normalizeProcessedRuns(raw.processedRuns);
    return profile;
  }

  // ---------- objectives ----------

  function objectiveMet(obj, run) {
    if (!run.won) return false;
    switch (obj.kind) {
      case 'finish': return true;
      case 'clean': return run.lives === 3;
      case 'scanLimit': return run.chargesUsed <= obj.value;
      case 'time': return run.elapsed <= obj.value;
      default: return false;
    }
  }

  // ---------- achievements ----------

  function grantAchievements(profile, objectiveKind, rewards, flags) {
    const owned = new Set(profile.achievements);
    const add = id => {
      if (owned.has(id)) return;
      owned.add(id);
      profile.achievements.push(id);
      rewards.achievements.push(id);
    };
    const stats = profile.statistics;
    if (stats.wins >= 1) add('ilk-zafer');
    if (flags.cleanCampaignWin) add('kusursuz');
    if (objectiveKind === 'scanLimit' && flags.objectiveJustMet) add('dedektif');
    if (stats.dailyWins >= 1) add('gunluk-ilk');
    if (stats.streak >= 3) add('seri-3');
    if (stats.streak >= 7) add('seri-7');
    if (profile.inventory.length >= 4) add('koleksiyoncu');
    if (profile.coins >= 500) add('zengin');
    if (Object.keys(profile.stageResults).length >= 6) add('bolge-uzmani');
    if (stats.scanned >= 50) add('tarayici');
  }

  // ---------- result recording ----------

  function zeroRewards() {
    return { coins: 0, achievements: [], objectiveMet: false, firstClear: false };
  }

  function reject(profile, reason) {
    return { profile, rewards: zeroRewards(), reason };
  }

  function validRunId(value) {
    if (typeof value === 'string') return value.length >= 1 && value.length <= MAX_RUN_ID ? value : null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      const id = String(value);
      return id.length >= 1 && id.length <= MAX_RUN_ID ? id : null;
    }
    return null;
  }

  function recordResult(profile, result) {
    const base = normalizeProfile(profile);
    if (!isObject(result)) return reject(base, 'invalid-result');

    const runId = validRunId(result.runId);
    if (!runId) return reject(base, 'invalid-run-id');
    if (!MODES.includes(result.mode)) return reject(base, 'invalid-mode');
    if (!Number.isInteger(result.stageIndex) || result.stageIndex < 0 || result.stageIndex >= STAGE_COUNT) {
      return reject(base, 'invalid-stage');
    }
    if (typeof result.won !== 'boolean') return reject(base, 'invalid-won');
    const lives = result.lives;
    if (!Number.isInteger(lives) || lives < 0 || lives > 3) return reject(base, 'invalid-lives');
    if (result.won && lives < 1) return reject(base, 'invalid-lives');
    if (!Number.isInteger(result.elapsed) || result.elapsed < 0 || result.elapsed > MAX_SECONDS) {
      return reject(base, 'invalid-elapsed');
    }
    if (!Number.isInteger(result.chargesUsed) || result.chargesUsed < 0 || result.chargesUsed > 3) {
      return reject(base, 'invalid-charges');
    }
    const scannedRaw = result.scanned == null ? 0 : result.scanned;
    if (!Number.isInteger(scannedRaw) || scannedRaw < 0 || scannedRaw > MAX_CELLS) {
      return reject(base, 'invalid-scanned');
    }
    const flagsRaw = result.flagsPlaced == null ? 0 : result.flagsPlaced;
    if (!Number.isInteger(flagsRaw) || flagsRaw < 0 || flagsRaw > MAX_CELLS) {
      return reject(base, 'invalid-flags');
    }
    const dayKey = result.dayKey == null ? utcDay() : validDayKey(result.dayKey);
    if (!dayKey) return reject(base, 'invalid-day');

    // Idempotency: a run id is paid at most once, even across reloads.
    if (base.processedRuns.some(run => run.runId === runId)) {
      return { profile: base, rewards: zeroRewards(), duplicate: true };
    }

    const mode = result.mode;
    const won = result.won;
    const rewards = zeroRewards();
    const achievementFlags = { cleanCampaignWin: false, objectiveJustMet: false };
    // Once the 30-day daily map is full, a day older than the oldest retained day has no
    // reward history any more. Replaying it may update lifetime stats, but never pays coins.
    let dailyOutsideRetention = false;
    if (mode === 'gunluk') {
      const retained = Object.keys(base.dailyResults);
      if (retained.length >= MAX_DAILY_DAYS) {
        const oldest = retained.reduce((min, key) => (key < min ? key : min), retained[0]);
        if (!base.dailyResults[dayKey] && dayKey < oldest) dailyOutsideRetention = true;
      }
    }
    const run = {
      runId, dayKey, mode, stageIndex: result.stageIndex,
      won, lives, elapsed: result.elapsed, chargesUsed: result.chargesUsed,
      scanned: scannedRaw, flagsPlaced: flagsRaw,
    };

    let objective = null;
    if (mode === 'kampanya') objective = CATALOG[result.stageIndex].objective;
    else if (mode === 'gunluk') objective = dailyChallenge(dayKey).objective;
    const met = objective ? objectiveMet(objective, run) : false;
    rewards.objectiveMet = met;

    if (mode === 'kampanya') {
      const prev = base.stageResults[result.stageIndex];
      const firstClear = won && !prev;
      rewards.firstClear = firstClear;
      if (won) {
        let livesRecordPaid = prev ? prev.livesRecordPaid : false;
        let timeRecordPaid = prev ? prev.timeRecordPaid : false;
        if (firstClear) {
          rewards.coins += FIRST_CLEAR_BASE + result.stageIndex;
        } else {
          if (!livesRecordPaid && lives > prev.bestLives) {
            rewards.coins += RECORD_BONUS;
            livesRecordPaid = true;
          }
          if (prev.bestTime != null && !timeRecordPaid && result.elapsed < prev.bestTime) {
            rewards.coins += RECORD_BONUS;
            timeRecordPaid = true;
          }
        }
        if (met && !(prev && prev.objectiveMet)) {
          rewards.coins += OBJECTIVE_BONUS;
          achievementFlags.objectiveJustMet = true;
          base.statistics.objectives += 1;
        }
        if (lives === 3) achievementFlags.cleanCampaignWin = true;
        const next = {
          clears: (prev ? prev.clears : 0) + 1,
          bestLives: prev ? Math.max(prev.bestLives, lives) : lives,
          // A migrated null time is filled by the first real finish without paying a record bonus.
          bestTime: !prev || prev.bestTime == null ? result.elapsed : Math.min(prev.bestTime, result.elapsed),
          bestScan: prev ? Math.min(prev.bestScan, result.chargesUsed) : result.chargesUsed,
          objectiveMet: (prev && prev.objectiveMet) || met,
          livesRecordPaid,
          timeRecordPaid,
        };
        base.stageResults[result.stageIndex] = next;
      }
    } else if (mode === 'gunluk' && !dailyOutsideRetention) {
      const prevDaily = base.dailyResults[dayKey];
      if (won) {
        if (!prevDaily || prevDaily.wins === 0) rewards.coins += DAILY_WIN_BONUS;
        if (met && !(prevDaily && prevDaily.objectiveMet)) {
          rewards.coins += DAILY_OBJECTIVE_BONUS;
          base.statistics.objectives += 1;
        }
        base.dailyResults[dayKey] = {
          runs: (prevDaily ? prevDaily.runs : 0) + 1,
          wins: (prevDaily ? prevDaily.wins : 0) + 1,
          bestLives: prevDaily && prevDaily.wins > 0 ? Math.max(prevDaily.bestLives, lives) : lives,
          bestTime: prevDaily && prevDaily.wins > 0 ? Math.min(prevDaily.bestTime, result.elapsed) : result.elapsed,
          objectiveMet: (prevDaily && prevDaily.objectiveMet) || met,
        };
      } else {
        base.dailyResults[dayKey] = {
          runs: (prevDaily ? prevDaily.runs : 0) + 1,
          wins: prevDaily ? prevDaily.wins : 0,
          bestLives: prevDaily ? prevDaily.bestLives : 0,
          bestTime: prevDaily ? prevDaily.bestTime : null,
          objectiveMet: prevDaily ? prevDaily.objectiveMet : false,
        };
      }
      trimDaily(base);
    }
    // Free modes deliberately pay no coins; they only update lifetime statistics.

    const stats = base.statistics;
    stats.runs += 1;
    stats.scanned = Math.min(MAX_STAT, stats.scanned + scannedRaw);
    stats.minesFlagged = Math.min(MAX_STAT, stats.minesFlagged + flagsRaw);
    if (won) {
      stats.wins += 1;
      stats.streak += 1;
      if (stats.streak > stats.bestStreak) stats.bestStreak = stats.streak;
      if (mode === 'kampanya') stats.campaignWins += 1;
      else if (mode === 'gunluk') stats.dailyWins += 1;
      else stats.freeWins += 1;
    } else {
      stats.losses += 1;
      stats.streak = 0;
    }

    base.coins = Math.min(MAX_COINS, base.coins + rewards.coins);
    grantAchievements(base, objective ? objective.kind : '', rewards, achievementFlags);

    base.processedRuns.push({
      runId, dayKey, mode, stageIndex: result.stageIndex,
      won, coins: rewards.coins, objectiveMet: met, firstClear: rewards.firstClear,
    });
    if (base.processedRuns.length > MAX_RUNS) base.processedRuns = base.processedRuns.slice(-MAX_RUNS);

    const response = { profile: base, rewards };
    if (dailyOutsideRetention) response.note = 'daily-outside-retention';
    return response;
  }

  function trimDaily(profile) {
    // Rebuild the map in newest-first order so persisted JSON is deterministic even after
    // a day key is re-added following a previous trim.
    const keys = Object.keys(profile.dailyResults).sort().reverse().slice(0, MAX_DAILY_DAYS);
    const next = {};
    for (const key of keys) next[key] = profile.dailyResults[key];
    profile.dailyResults = next;
  }

  // ---------- cosmetic shop ----------

  function findSkin(id) {
    return SKINS.find(skin => skin.id === id) || null;
  }

  function buySkin(profile, skinId) {
    const next = normalizeProfile(profile);
    const skin = typeof skinId === 'string' ? findSkin(skinId) : null;
    if (!skin) return { profile: next, ok: false, reason: 'unknown-skin' };
    if (next.inventory.includes(skin.id)) return { profile: next, ok: false, reason: 'already-owned' };
    if (next.coins < skin.cost) return { profile: next, ok: false, reason: 'insufficient-coins' };
    next.coins -= skin.cost;
    next.inventory.push(skin.id);
    next.inventory = SKIN_IDS.filter(id => next.inventory.includes(id));
    // Collection achievement unlocks at the moment of purchase, not on the next run.
    if (next.inventory.length >= 4 && !next.achievements.includes('koleksiyoncu')) {
      next.achievements.push('koleksiyoncu');
      next.achievements = ACHIEVEMENT_IDS.filter(id => next.achievements.includes(id));
    }
    return { profile: next, ok: true, reason: null };
  }

  function equipSkin(profile, skinId) {
    const next = normalizeProfile(profile);
    const skin = typeof skinId === 'string' ? findSkin(skinId) : null;
    if (!skin) return { profile: next, ok: false, reason: 'unknown-skin' };
    if (!next.inventory.includes(skin.id)) return { profile: next, ok: false, reason: 'not-owned' };
    next.selectedSkin = skin.id;
    return { profile: next, ok: true, reason: null };
  }

  window.MT3D_PROGRESS = Object.freeze({
    VERSION,
    PROFILE_KEY,
    MODES,
    FREE_MODES,
    THEMES,
    CATALOG,
    REGIONS,
    SKINS,
    ACHIEVEMENTS,
    DEFAULT_SKIN,
    MAX_RUNS,
    MAX_DAILY_DAYS,
    defaultProfile,
    normalizeProfile,
    recordResult,
    buySkin,
    equipSkin,
    utcDay,
    dailyChallenge,
    seededRandom,
  });
})();
