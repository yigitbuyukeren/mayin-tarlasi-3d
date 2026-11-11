(function () {
  'use strict';

  var VIEWS = ['campaign', 'daily', 'wardrobe', 'settings'];
  var VIEW_LABELS = {
    campaign: 'Kampanya',
    daily: 'Günlük',
    wardrobe: 'Gardırop',
    settings: 'Ayarlar'
  };
  var TAB_IDS = {
    campaign: 'expNavCampaign',
    daily: 'expNavDaily',
    wardrobe: 'expNavWardrobe',
    settings: 'expNavSettings'
  };
  var THEME_NAMES = { meadow: 'Çayır', desert: 'Çöl', snow: 'Kar', night: 'Gece' };
  var STAT_LABELS = {
    runs: 'Oynanan oyun', campaignWins: 'Kampanya zaferi', dailyWins: 'Günlük zafer', freeWins: 'Serbest zafer',
    streak: 'Güncel seri', scanned: 'Dedektör taraması', objectives: 'Hedef madalyası',
    gamesPlayed: 'Oynanan oyun',
    wins: 'Kazanılan',
    losses: 'Kaybedilen',
    winRate: 'Kazanma oranı',
    cellsOpened: 'Açılan kare',
    minesFlagged: 'Konulan bayrak',
    scans: 'Dedektör taraması',
    timePlayed: 'Oynanan süre',
    deaths: 'Mayın isabeti',
    dailyCompleted: 'Tamamlanan günlük',
    tutorialsCompleted: 'Tamamlanan eğitim',
    bestStreak: 'En iyi seri',
    currentStreak: 'Güncel seri'
  };
  var ACH_LABELS = Object.fromEntries(window.MT3D_PROGRESS.ACHIEVEMENTS.map(function (item) { return [item.id, item.title]; }));
  var mounted = false;
  var adapter = {};
  var root = null;
  var nav = null;
  var navButtons = {};
  var panels = {};
  var live = null;
  var coach = null;
  var coachStep = null;
  var coachTitle = null;
  var coachText = null;
  var coachBar = null;
  var coachExit = null;
  var coachTarget = null;
  var rewardRoot = null;
  var rewardPreviousFocus = null;
  var currentView = 'campaign';
  var refs = {};

  function isFn(value) {
    return typeof value === 'function';
  }

  function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function num(value, fallback) {
    var n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function str(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : (fallback || '');
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function safeColor(value) {
    var color = str(value, '');
    if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
    if (/^(rgb|hsl)a?\([0-9.,%\s/+-]+\)$/i.test(color)) return color;
    if (/^[a-z]{3,24}$/i.test(color)) return color;
    return '#c58b3a';
  }

  function formatNumber(value) {
    var n = num(value, 0);
    try {
      return new Intl.NumberFormat('tr-TR').format(n);
    } catch (e) {
      return String(n);
    }
  }

  function formatTime(value) {
    var n = num(value, NaN);
    if (!Number.isFinite(n) || n < 0) return '—';
    var total = Math.floor(n);
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  function formatBest(value) {
    if (value === undefined || value === null || value === '') return '—';
    if (typeof value === 'number') return formatTime(value);
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      if (value.best !== undefined) return formatBest(value.best);
      if (value.time !== undefined) return formatBest(value.time);
      if (value.seconds !== undefined) return formatBest(value.seconds);
    }
    return '—';
  }

  function todayUTC() {
    return new Date().toISOString().slice(0, 10);
  }

  function validISODate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : todayUTC();
  }

  function formatUTCDate(iso) {
    var date = new Date(iso + 'T00:00:00Z');
    if (Number.isNaN(date.getTime())) return iso;
    try {
      return new Intl.DateTimeFormat('tr-TR', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
      }).format(date);
    } catch (e) {
      return iso;
    }
  }

  function firstValue(values) {
    for (var i = 0; i < values.length; i++) {
      var value = values[i];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  function readState() {
    if (!isFn(adapter.getState)) return {};
    try {
      return obj(adapter.getState());
    } catch (e) {
      return {};
    }
  }

  function readSettings(raw) {
    var settings = obj(raw);
    return {
      sound: settings.sound !== false,
      haptics: settings.haptics !== false,
      leftHanded: settings.leftHanded === true,
      confirmUnknown: settings.confirmUnknown === true,
      reduceMotion: settings.reduceMotion === true,
      quality: ['low', 'medium', 'high'].indexOf(settings.quality) >= 0 ? settings.quality : 'medium'
    };
  }

  function applyBodyFlags(settings) {
    document.body.classList.toggle('left-handed', !!settings.leftHanded);
    document.body.classList.toggle('exp-reduce-motion', !!settings.reduceMotion);
    document.body.classList.toggle('reduced-motion', !!settings.reduceMotion);
  }

  function catalogOf(state) {
    return Array.isArray(state.catalog) ? state.catalog.filter(function (item) { return obj(item); }) : [];
  }

  function completedStageCount(profile, catalog) {
    var results = obj(profile.stageResults);
    if (!catalog.length) {
      return Object.keys(results).filter(function (key) { return !!results[key]; }).length;
    }
    return catalog.reduce(function (total, stage, index) {
      var byId = stage && stage.id !== undefined ? results[stage.id] : undefined;
      var byIndex = results[index] !== undefined ? results[index] : results[String(index)];
      return total + (byId || byIndex ? 1 : 0);
    }, 0);
  }

  function achievementLabel(value) {
    var raw = str(value, '');
    if (!raw) return '';
    if (ACH_LABELS[raw]) return ACH_LABELS[raw];
    return raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function achievementList(profile) {
    if (!Array.isArray(profile.achievements)) return [];
    return profile.achievements.map(achievementLabel).filter(Boolean);
  }

  function tutorialCompleted(profile, achievements) {
    if (profile.tutorialCompleted === true) return true;
    var stats = obj(profile.statistics);
    if (num(stats.tutorialsCompleted, 0) > 0 || stats.tutorialCompleted === true || stats.tutorial === true) return true;
    return achievements.some(function (item) {
      return /eğitim|tutorial|ilk adım|first step/i.test(item);
    });
  }

  function activeFocusKey() {
    var active = document.activeElement;
    return active && active.getAttribute ? active.getAttribute('data-exp-key') : null;
  }

  function restoreFocus(key) {
    if (!key || !root) return;
    var nodes = root.querySelectorAll('[data-exp-key]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-exp-key') === key && !nodes[i].disabled) {
        try { nodes[i].focus({ preventScroll: true }); } catch (e) { nodes[i].focus(); }
        return;
      }
    }
  }

  function announce(text) {
    if (!mounted || !live) return;
    var message = str(text, '');
    if (!message) return;
    live.textContent = '';
    live.textContent = message;
  }

  function finishAction(result, okMessage, failMessage) {
    if (result && typeof result.then === 'function') {
      result.then(function () {
        if (okMessage) announce(okMessage);
        render();
      }, function () {
        announce(failMessage || 'İşlem tamamlanamadı.');
        render();
      });
      return;
    }
    if (result === false) announce(failMessage || 'İşlem tamamlanamadı.');
    else if (okMessage) announce(okMessage);
    render();
  }

  function runAction(method, args, okMessage, failMessage) {
    if (!isFn(adapter[method])) {
      announce(failMessage || 'Bu işlem şu anda kullanılamıyor.');
      return;
    }
    var result;
    try {
      result = adapter[method].apply(adapter, args || []);
    } catch (e) {
      announce(failMessage || 'İşlem tamamlanamadı.');
      return;
    }
    finishAction(result, okMessage, failMessage);
  }

  function buildTopbar() {
    var topbar = el('div', 'exp-topbar');
    var brand = el('div', 'exp-brand');
    var icon = el('span', 'exp-brand-icon', '💣');
    icon.setAttribute('aria-hidden', 'true');
    var copy = el('span', 'exp-brand-copy');
    var eyebrow = el('span', 'exp-eyebrow', 'MAYIN TARLASI 3D');
    var title = el('b', 'exp-brand-title', 'Macera');
    var sub = el('small', 'exp-brand-sub', 'Macera günlüğü');
    copy.appendChild(eyebrow);
    copy.appendChild(title);
    copy.appendChild(sub);
    brand.appendChild(icon);
    brand.appendChild(copy);

    var wallet = el('div', 'exp-wallet');
    wallet.setAttribute('role', 'status');
    var walletIcon = el('span', '', '🪙');
    walletIcon.setAttribute('aria-hidden', 'true');
    var walletValue = el('b', 'exp-wallet-value', '0');
    var walletLabel = el('small', '', 'coin');
    wallet.appendChild(walletIcon);
    wallet.appendChild(walletValue);
    wallet.appendChild(walletLabel);

    topbar.appendChild(brand);
    topbar.appendChild(wallet);
    refs.coins = walletValue;
    refs.coinsWrap = wallet;
    refs.brandSub = sub;
    return topbar;
  }

  function buildNav() {
    nav = el('nav', 'exp-nav');
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Ana menü');
    var definitions = [
      ['campaign', '🗺', 'Kampanya'],
      ['daily', '📅', 'Günlük'],
      ['wardrobe', '🧥', 'Gardırop'],
      ['settings', '⚙️', 'Ayarlar']
    ];
    definitions.forEach(function (definition) {
      var view = definition[0];
      var button = el('button', 'exp-nav-btn');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.id = TAB_IDS[view];
      button.setAttribute('aria-controls', 'exp-view-' + view);
      button.setAttribute('aria-selected', view === currentView ? 'true' : 'false');
      button.tabIndex = view === currentView ? 0 : -1;
      var icon = el('span', 'exp-nav-ic', definition[1]);
      icon.setAttribute('aria-hidden', 'true');
      var label = el('span', 'exp-nav-label', definition[2]);
      button.appendChild(icon);
      button.appendChild(label);
      button.addEventListener('click', function () {
        selectView(view, true);
      });
      navButtons[view] = button;
      nav.appendChild(button);
    });

    nav.addEventListener('keydown', function (event) {
      var key = event.key;
      if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'Home' && key !== 'End') return;
      var index = VIEWS.indexOf(currentView);
      if (index < 0) index = 0;
      if (key === 'ArrowRight') index = (index + 1) % VIEWS.length;
      else if (key === 'ArrowLeft') index = (index - 1 + VIEWS.length) % VIEWS.length;
      else if (key === 'Home') index = 0;
      else index = VIEWS.length - 1;
      event.preventDefault();
      var next = VIEWS[index];
      navButtons[next].focus();
      selectView(next, false);
    });
    return nav;
  }

  function buildView(view, labelledBy) {
    var section = el('section', 'exp-view');
    section.id = 'exp-view-' + view;
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-labelledby', labelledBy || TAB_IDS[view]);
    section.tabIndex = 0;
    panels[view] = section;
    return section;
  }

  function buildFirstSteps() {
    var card = el('section', 'exp-firststeps');
    card.setAttribute('aria-labelledby', 'exp-firststeps-title');
    var icon = el('div', 'exp-firststeps-icon', '🧭');
    icon.setAttribute('aria-hidden', 'true');
    var copy = el('div', 'exp-firststeps-copy');
    var eyebrow = el('span', 'exp-eyebrow', 'BAŞLANGIÇ');
    var title = el('h2', '', 'İlk adımlar');
    title.id = 'exp-firststeps-title';
    var text = el('p', '', 'İniş noktasını seç, sayıları oku ve güvenli kareleri aç. Eğitim seni adım adım yönlendirir.');
    var objective = el('p', 'exp-objective');
    copy.appendChild(eyebrow);
    copy.appendChild(title);
    copy.appendChild(text);
    copy.appendChild(objective);
    var action = el('button', 'exp-btn exp-btn-primary', '🎓 Öğreticiyi başlat');
    action.type = 'button';
    action.id = 'expTutorialBtn';
    action.dataset.expKey = 'tutorial';
    action.addEventListener('click', function () {
      runAction('launchTutorial', [], 'Eğitim başlatıldı.', 'Eğitim başlatılamadı.');
    });
    card.appendChild(icon);
    card.appendChild(copy);
    card.appendChild(action);
    refs.firstObjective = objective;
    refs.firstAction = action;
    return card;
  }

  function buildRegions() {
    var regions = el('div', 'exp-regions');
    regions.setAttribute('role', 'list');
    regions.setAttribute('aria-label', 'Bölge rotası');
    refs.regions = regions;
    return regions;
  }

  function buildCampaign() {
    var section = buildView('campaign');
    section.appendChild(buildFirstSteps());
    section.appendChild(buildRegions());
    var core = el('div', 'exp-campaign-core');
    refs.campaignCore = core;
    section.appendChild(core);
    return section;
  }

  function buildDaily() {
    var section = buildView('daily');
    var head = el('div', 'exp-panel-head');
    head.appendChild(el('span', 'exp-eyebrow', 'GÜNLÜK MEYDAN OKUMA'));
    var title = el('h2', '', 'Günün tarlası');
    title.id = 'exp-daily-title';
    head.appendChild(title);
    head.appendChild(el('p', '', 'Herkes için aynı hedef, UTC günü boyunca geçerli.'));
    section.appendChild(head);

    var card = el('article', 'exp-daily-card');
    card.setAttribute('aria-labelledby', 'exp-daily-title');
    var dateRow = el('div', 'exp-daily-date');
    refs.dailyDate = el('b', '', '');
    refs.dailyIso = el('span', '', '');
    dateRow.appendChild(refs.dailyDate);
    dateRow.appendChild(refs.dailyIso);
    card.appendChild(dateRow);

    var objective = el('p', 'exp-daily-objective');
    refs.dailyObjective = objective;
    card.appendChild(objective);

    var meta = el('dl', 'exp-daily-meta');
    var bestGroup = el('div');
    bestGroup.appendChild(el('dt', '', 'En iyi'));
    refs.dailyBest = el('dd', '', '—');
    bestGroup.appendChild(refs.dailyBest);
    var rewardGroup = el('div');
    rewardGroup.appendChild(el('dt', '', 'Ödül'));
    refs.dailyReward = el('dd', '', '—');
    rewardGroup.appendChild(refs.dailyReward);
    meta.appendChild(bestGroup);
    meta.appendChild(rewardGroup);
    card.appendChild(meta);

    refs.dailyStatus = el('p', 'exp-daily-status', '');
    card.appendChild(refs.dailyStatus);

    var start = el('button', 'exp-btn exp-btn-primary', '▶ Günlük oynayışı başlat');
    start.type = 'button';
    start.id = 'expDailyBtn';
    start.dataset.expKey = 'daily-start';
    start.addEventListener('click', function () {
      runAction('launchDaily', [], 'Günlük oynayış başlatıldı.', 'Günlük oynayış başlatılamadı.');
    });
    refs.dailyStart = start;
    card.appendChild(start);
    card.appendChild(el('p', 'exp-note', 'Ödül günde yalnızca bir kez verilir; UTC 00:00’da yenilenir.'));
    section.appendChild(card);
    return section;
  }

  function buildWardrobe() {
    var section = buildView('wardrobe');
    var head = el('div', 'exp-panel-head');
    head.appendChild(el('span', 'exp-eyebrow', 'GARDIROP'));
    head.appendChild(el('h2', '', 'Uzman görünümleri'));
    head.appendChild(el('p', '', 'Coinlerinle yeni görünümler aç ve uzmanını kişiselleştir.'));
    section.appendChild(head);
    var grid = el('div', 'exp-skins');
    grid.setAttribute('role', 'list');
    grid.setAttribute('aria-label', 'Görünüm koleksiyonu');
    refs.skins = grid;
    section.appendChild(grid);
    var empty = el('p', 'exp-empty', 'Henüz görünüm yok. Yeni koleksiyon parçaları yakında eklenecek.');
    empty.hidden = true;
    refs.skinEmpty = empty;
    section.appendChild(empty);
    return section;
  }

  function buildSettings() {
    var section = buildView('settings');
    var head = el('div', 'exp-panel-head');
    head.appendChild(el('span', 'exp-eyebrow', 'AYARLAR'));
    head.appendChild(el('h2', '', 'Deneyimini ayarla'));
    head.appendChild(el('p', '', 'Dokunma, hareket ve oyun akışı tercihlerini buradan yönet.'));
    section.appendChild(head);

    var settingsGroup = el('div', 'exp-settings-group');
    settingsGroup.setAttribute('role', 'group');
    settingsGroup.setAttribute('aria-label', 'Oyun ayarları');
    refs.settings = settingsGroup;
    section.appendChild(settingsGroup);

    var qualityBlock = el('div', 'exp-quality-block');
    qualityBlock.appendChild(el('p', 'exp-note', 'Grafik kalitesi, oyunun mevcut kalite düğmeleriyle ayarlanır.'));
    var qualitySlot = el('div', 'exp-quality-slot');
    refs.qualitySlot = qualitySlot;
    qualityBlock.appendChild(qualitySlot);
    section.appendChild(qualityBlock);

    var profile = el('div', 'exp-profile');

    var achievementsCard = el('section', 'exp-profile-card');
    achievementsCard.setAttribute('aria-labelledby', 'exp-achievements-title');
    var achievementsTitle = el('h3', '', 'Başarımlar');
    achievementsTitle.id = 'exp-achievements-title';
    achievementsCard.appendChild(achievementsTitle);
    refs.achievements = el('div', 'exp-badges');
    achievementsCard.appendChild(refs.achievements);
    profile.appendChild(achievementsCard);

    var statsCard = el('section', 'exp-profile-card');
    statsCard.setAttribute('aria-labelledby', 'exp-stats-title');
    var statsTitle = el('h3', '', 'İstatistikler');
    statsTitle.id = 'exp-stats-title';
    statsCard.appendChild(statsTitle);
    refs.stats = el('dl', 'exp-stat-list');
    statsCard.appendChild(refs.stats);
    profile.appendChild(statsCard);

    section.appendChild(profile);
    return section;
  }

  function buildCoach() {
    coach = el('aside', 'exp-coach');
    coach.id = 'expCoach';
    coach.setAttribute('aria-label', 'Eğitim adımı');
    coach.hidden = true;

    var livePanel = el('div', 'exp-coach-live');
    livePanel.setAttribute('role', 'status');
    livePanel.setAttribute('aria-live', 'polite');
    livePanel.setAttribute('aria-atomic', 'true');
    coachStep = el('span', 'exp-coach-step', '');
    coachTitle = el('b', 'exp-coach-title', '');
    coachText = el('p', 'exp-coach-text', '');
    livePanel.appendChild(coachStep);
    livePanel.appendChild(coachTitle);
    livePanel.appendChild(coachText);
    coach.appendChild(livePanel);

    var bar = el('div', 'exp-coach-bar');
    bar.setAttribute('aria-hidden', 'true');
    coachBar = el('i', '', '');
    bar.appendChild(coachBar);
    coach.appendChild(bar);

    coachExit = el('button', 'exp-coach-exit', 'Eğitimden çık');
    coachExit.type = 'button';
    coachExit.id = 'expExitTutorial';
    coachExit.dataset.expKey = 'coach-exit';
    coachExit.addEventListener('click', function () {
      if (isFn(adapter.exitTutorial)) {
        try { adapter.exitTutorial(); } catch (e) { /* Arayüz yine kapatılır. */ }
      }
      hideTutorial();
      announce('Eğitimden çıkıldı.');
    });
    coach.appendChild(coachExit);
    document.body.appendChild(coach);
  }

  function buildLive() {
    live = el('div', 'exp-sr');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    document.body.appendChild(live);
  }

  function build(card) {
    card.classList.add('exp-card');
    var topbar = buildTopbar();
    card.insertBefore(topbar, card.firstChild);
    var resumeSlot = el('div', 'exp-resume-slot');
    card.insertBefore(resumeSlot, topbar.nextSibling);
    var continuation = card.querySelector('#continueBtn');
    if (continuation) resumeSlot.appendChild(continuation);

    var logo = card.querySelector('.logo');
    var tabs = card.querySelector('.tabs');
    var navAnchor = logo ? logo.nextSibling : tabs;
    var navNode = buildNav();
    if (navAnchor && navAnchor.parentNode === card) card.insertBefore(navNode, navAnchor);
    else card.insertBefore(navNode, tabs || null);

    var moveList = [
      card.querySelector('.row'),
      tabs,
      card.querySelector('#levels'),
      card.querySelector('details.how')
    ];
    var resetButton = card.querySelector('#resetBtn');
    var quality = card.querySelector('.quality');

    var campaign = buildCampaign();
    if (tabs && tabs.parentNode === card) card.insertBefore(campaign, tabs);
    else card.appendChild(campaign);

    moveList.forEach(function (node) {
      if (node && node.parentNode) refs.campaignCore.appendChild(node);
    });

    card.appendChild(buildDaily());
    card.appendChild(buildWardrobe());
    var settings = buildSettings();
    card.appendChild(settings);
    if (resetButton) settings.appendChild(resetButton);
    if (quality) refs.qualitySlot.appendChild(quality);

    buildCoach();
    buildLive();
    applyView();
  }

  function selectView(view, shouldAnnounce) {
    if (VIEWS.indexOf(view) < 0 || view === currentView) {
      if (VIEWS.indexOf(view) >= 0) applyView();
      return;
    }
    currentView = view;
    applyView();
    if (shouldAnnounce) announce(VIEW_LABELS[view] + ' bölümü açıldı.');
  }

  function applyView() {
    VIEWS.forEach(function (view) {
      var button = navButtons[view];
      var panel = panels[view];
      var selected = view === currentView;
      if (button) {
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
        button.tabIndex = selected ? 0 : -1;
      }
      if (panel) panel.hidden = !selected;
    });
  }

  function renderTopbar(state, profile, catalog) {
    var coins = Math.max(0, num(profile.coins, 0));
    refs.coins.textContent = formatNumber(coins);
    refs.coinsWrap.setAttribute('aria-label', 'Toplam ' + formatNumber(coins) + ' coin');
    var total = catalog.length;
    var completed = completedStageCount(profile, catalog);
    refs.brandSub.textContent = total
      ? completed + ' / ' + total + ' bölüm tamamlandı'
      : 'Macera günlüğü';
  }

  function renderFirstSteps(state, profile, catalog, achievements) {
    var stageIndex = num(state.stageIndex, -1);
    var stage = stageIndex >= 0 && stageIndex < catalog.length ? catalog[stageIndex] : null;
    var objective = stage && stage.objective && typeof stage.objective === 'object' ? stage.objective : {};
    var objectiveLabel = str(objective.label, '');
    var objectiveValue = objective.value !== undefined && objective.value !== null ? ' · ' + objective.value : '';
    if (objectiveLabel) {
      refs.firstObjective.textContent = 'Sıradaki hedef: ' + objectiveLabel + objectiveValue;
      refs.firstObjective.hidden = false;
    } else if (stage && stage.title) {
      refs.firstObjective.textContent = 'Sıradaki bölüm: ' + str(stage.title, '');
      refs.firstObjective.hidden = false;
    } else {
      refs.firstObjective.hidden = true;
      refs.firstObjective.textContent = '';
    }
    var done = tutorialCompleted(profile, achievements);
    refs.firstAction.textContent = done ? '🎓 Öğreticiyi yeniden oyna' : '🎓 Öğreticiyi başlat';
    refs.firstAction.disabled = !isFn(adapter.launchTutorial);
  }

  function renderRegions(state, profile, catalog) {
    clear(refs.regions);
    if (!catalog.length) {
      refs.regions.hidden = true;
      return;
    }
    refs.regions.hidden = false;
    var stageIndex = num(state.stageIndex, -1);
    var currentStage = stageIndex >= 0 && stageIndex < catalog.length ? catalog[stageIndex] : null;
    var currentRegion = currentStage ? str(currentStage.region, THEME_NAMES[currentStage.theme] || 'Bölge') : '';
    var groups = [];
    var lookup = {};
    catalog.forEach(function (stage, index) {
      var region = str(stage.region, THEME_NAMES[stage.theme] || 'Bölge');
      if (!lookup[region]) {
        lookup[region] = { name: region, total: 0, done: 0, active: false };
        groups.push(lookup[region]);
      }
      var group = lookup[region];
      group.total += 1;
      var results = obj(profile.stageResults);
      var result = results[stage.id] !== undefined ? results[stage.id] : (results[index] !== undefined ? results[index] : results[String(index)]);
      if (result) group.done += 1;
      if (stage === currentStage || (currentRegion && region === currentRegion)) group.active = true;
    });
    groups.forEach(function (group) {
      var item = el('span', 'exp-region' + (group.active ? ' is-active' : ''));
      item.setAttribute('role', 'listitem');
      if (group.active) item.setAttribute('aria-current', 'step');
      var dot = el('span', 'exp-region-dot');
      dot.setAttribute('aria-hidden', 'true');
      item.appendChild(dot);
      item.appendChild(el('b', '', group.name));
      item.appendChild(el('small', '', group.done + '/' + group.total));
      refs.regions.appendChild(item);
    });
  }

  function renderDaily(state, profile) {
    var daily = obj(state.daily);
    var iso = validISODate(daily.dayKey || daily.date);
    var results = obj(profile.dailyResults);
    var result = results[iso];
    var objective = daily.objective;
    var objectiveLabel = '';
    if (typeof objective === 'string') objectiveLabel = objective;
    else if (objective && typeof objective === 'object') objectiveLabel = str(objective.label, '');
    if (!objectiveLabel) objectiveLabel = str(daily.target, '') || 'Günün hedefini tamamla';
    var best = firstValue([
      daily.best,
      daily.bestTime,
      daily.bestSeconds,
      result && result.best,
      result && result.bestTime,
      result && result.time,
      result && result.seconds
    ]);
    var rewardRaw = firstValue([daily.reward, daily.rewardCoins, daily.coins]);
    var reward = 0;
    if (typeof rewardRaw === 'number') reward = Math.max(0, rewardRaw);
    else if (rewardRaw && typeof rewardRaw === 'object') reward = Math.max(0, num(firstValue([rewardRaw.coins, rewardRaw.amount, rewardRaw.value]), 0));
    var completed = !!(result && result.wins > 0);
    var objectiveDone = !!(result && result.objectiveMet);

    refs.dailyDate.textContent = formatUTCDate(iso);
    refs.dailyIso.textContent = 'UTC · ' + iso;
    refs.dailyObjective.textContent = '';
    refs.dailyObjective.appendChild(el('b', '', 'Hedef: '));
    refs.dailyObjective.appendChild(document.createTextNode(objectiveLabel));
    refs.dailyBest.textContent = formatBest(best);
    refs.dailyReward.textContent = completed ? objectiveDone ? 'Ödüller alındı' : '🪙 +5 hedef bonusu' : '🪙 12 + 5 hedef bonusu';
    refs.dailyStatus.textContent = completed
      ? objectiveDone ? 'Bugünkü ödüller alındı. Yarın yeni bir hedef seni bekliyor.' : 'Zafer ödülü alındı. Hedefi de tamamlayarak +5 altın kazanabilirsin.'
      : 'Bugün açık. Ödül, günün ilk tamamlanmasında verilir.';
    refs.dailyStatus.classList.toggle('is-complete', completed);
    refs.dailyStart.textContent = completed ? '↻ Günlük oynayışı yeniden başlat' : '▶ Günlük oynayışı başlat';
    refs.dailyStart.disabled = !isFn(adapter.launchDaily);
  }

  function renderWardrobe(state, profile) {
    clear(refs.skins);
    var skins = Array.isArray(state.skins) ? state.skins.filter(function (skin) { return obj(skin); }) : [];
    var inventory = Array.isArray(profile.inventory) ? profile.inventory.map(String) : [];
    var selected = str(profile.selectedSkin, '');
    var coins = Math.max(0, num(profile.coins, 0));
    refs.skinEmpty.hidden = skins.length > 0;
    refs.skins.hidden = skins.length === 0;

    skins.forEach(function (skin, index) {
      var id = str(skin.id, 'skin-' + index);
      var name = str(skin.name, id);
      var cost = Math.max(0, num(skin.cost, 0));
      var owned = inventory.indexOf(id) >= 0 || selected === id;
      var isSelected = selected === id;
      var article = el('article', 'exp-skin' + (isSelected ? ' is-selected' : ''));
      article.setAttribute('role', 'listitem');
      var swatch = el('div', 'exp-skin-swatch');
      swatch.style.setProperty('--exp-skin-color', safeColor(skin.color));
      swatch.setAttribute('aria-hidden', 'true');
      article.appendChild(swatch);
      article.appendChild(el('span', 'exp-skin-name', name));
      var meta = el('span', 'exp-skin-meta');
      if (isSelected) meta.textContent = 'Seçili görünüm';
      else if (owned) meta.textContent = 'Koleksiyonunda';
      else meta.textContent = 'Kilitli' + (cost > 0 ? ' · ' + formatNumber(cost) + ' coin' : '');
      article.appendChild(meta);

      var action = el('button', 'exp-skin-action');
      action.type = 'button';
      action.dataset.expKey = 'skin:' + id;
      if (isSelected) {
        action.textContent = '✓ Seçili';
        action.disabled = true;
        action.setAttribute('aria-pressed', 'true');
      } else if (owned) {
        action.textContent = 'Kuşan';
        action.setAttribute('aria-pressed', 'false');
        action.setAttribute('data-equip-skin', id);
        action.disabled = !isFn(adapter.equipSkin);
        action.addEventListener('click', function () {
          runAction('equipSkin', [id], name + ' kuşanıldı.', name + ' kuşanılamadı.');
        });
      } else {
        action.textContent = '🪙 ' + formatNumber(cost) + ' · Satın al';
        action.setAttribute('data-buy-skin', id);
        action.disabled = !isFn(adapter.buySkin);
        if (cost > coins) {
          article.classList.add('is-unaffordable');
          action.setAttribute('aria-label', name + ' görünümünü satın al, ' + formatNumber(cost) + ' coin, bakiye yetersiz');
        }
        action.addEventListener('click', function () {
          runAction('buySkin', [id], name + ' satın alındı.', name + ' satın alınamadı.');
        });
      }
      article.appendChild(action);
      refs.skins.appendChild(article);
    });
  }

  function switchDefinition(key) {
    var definitions = {
      sound: ['Ses', 'Efekt ve ortam sesleri', '🔊'],
      haptics: ['Titreşim', 'Dokunmatik geri bildirim', '📳'],
      leftHanded: ['Solak mod', 'Yön ve eylem tuşlarını ters yerleştir', '🤝'],
      confirmUnknown: ['Temkinli adım', 'Bilinmeyen kare için aynı yöne iki kez dokun', '🛡️'],
      reduceMotion: ['Azaltılmış hareket', 'Animasyonları ve geçişleri sınırla', '🌿']
    };
    return definitions[key];
  }

  function makeSwitch(key, definition, value) {
    var button = el('button', 'exp-switch');
    button.type = 'button';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', value ? 'true' : 'false');
    button.dataset.expKey = 'setting:' + key;
    button.setAttribute('data-setting', key);
    var track = el('span', 'exp-switch-track');
    track.setAttribute('aria-hidden', 'true');
    track.appendChild(el('span', 'exp-switch-dot'));
    var copy = el('span', 'exp-switch-copy');
    copy.appendChild(el('b', '', definition[0]));
    copy.appendChild(el('small', '', definition[1]));
    var state = el('span', 'exp-switch-state', value ? 'Açık' : 'Kapalı');
    button.appendChild(track);
    button.appendChild(copy);
    button.appendChild(state);
    button.disabled = !isFn(adapter.updateSettings);
    button.addEventListener('click', function () {
      var latest = readSettings(readState().settings);
      var next = !latest[key];
      var patch = {};
      patch[key] = next;
      if (key === 'leftHanded') document.body.classList.toggle('left-handed', next);
      if (key === 'reduceMotion') {
        document.body.classList.toggle('exp-reduce-motion', next);
        document.body.classList.toggle('reduced-motion', next);
      }
      var result;
      try {
        result = adapter.updateSettings(patch);
      } catch (e) {
        announce(definition[0] + ' değiştirilemedi.');
        return;
      }
      finishAction(
        result,
        definition[0] + (next ? ' açıldı.' : ' kapatıldı.'),
        definition[0] + ' değiştirilemedi.'
      );
    });
    return button;
  }

  function renderSettings(state, profile, catalog) {
    clear(refs.settings);
    var settings = readSettings(state.settings);
    applyBodyFlags(settings);
    ['sound', 'haptics', 'leftHanded', 'confirmUnknown', 'reduceMotion'].forEach(function (key) {
      var definition = switchDefinition(key);
      if (!definition) return;
      refs.settings.appendChild(makeSwitch(key, definition, settings[key]));
    });

    var achievements = achievementList(profile);
    clear(refs.achievements);
    if (!achievements.length) {
      refs.achievements.appendChild(el('p', 'exp-empty', 'Henüz başarım yok. İlk bölümü tamamlayarak başla.'));
    } else {
      achievements.forEach(function (label) {
        var badge = el('span', 'exp-badge');
        var icon = el('span', '', '🏅');
        icon.setAttribute('aria-hidden', 'true');
        badge.appendChild(icon);
        badge.appendChild(el('span', '', label));
        refs.achievements.appendChild(badge);
      });
    }

    clear(refs.stats);
    var stats = obj(profile.statistics);
    var rows = [];
    var total = catalog.length;
    if (total) rows.push(['Tamamlanan bölüm', completedStageCount(profile, catalog) + ' / ' + total]);
    if (achievements.length) rows.push(['Başarım', formatNumber(achievements.length)]);
    var keys = Object.keys(stats);
    var ordered = Object.keys(STAT_LABELS).filter(function (key) { return keys.indexOf(key) >= 0; });
    keys.forEach(function (key) {
      if (ordered.indexOf(key) < 0 && key.charAt(0) !== '_') ordered.push(key);
    });
    ordered.forEach(function (key) {
      if (rows.length >= 12) return;
      var value = stats[key];
      if (value === null || value === undefined || typeof value === 'object') return;
      var label = STAT_LABELS[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
      label = label.charAt(0).toUpperCase() + label.slice(1);
      var formatted;
      if (typeof value === 'boolean') formatted = value ? 'Evet' : 'Hayır';
      else if (typeof value === 'number') {
        if (/time|duration|played|seconds/i.test(key)) formatted = formatTime(value);
        else if (/rate/i.test(key) && value >= 0 && value <= 1) formatted = Math.round(value * 100) + '%';
        else formatted = formatNumber(value);
      } else formatted = str(value, '—');
      rows.push([label, formatted]);
    });
    if (!rows.length) {
      refs.stats.appendChild(el('p', 'exp-empty', 'Henüz istatistik yok. İlk oyununu oyna.'));
    } else {
      rows.forEach(function (row) {
        var group = el('div', 'exp-stat-row');
        group.appendChild(el('dt', '', row[0]));
        group.appendChild(el('dd', '', row[1]));
        refs.stats.appendChild(group);
      });
    }
  }

  function render() {
    if (!mounted) return;
    var focusKey = activeFocusKey();
    var state = readState();
    var profile = obj(state.profile);
    var catalog = catalogOf(state);
    var achievements = achievementList(profile);
    renderTopbar(state, profile, catalog);
    renderFirstSteps(state, profile, catalog, achievements);
    renderRegions(state, profile, catalog);
    renderDaily(state, profile);
    renderWardrobe(state, profile);
    renderSettings(state, profile, catalog);
    applyView();
    restoreFocus(focusKey);
  }

  function resolveTarget(target) {
    if (!target) return null;
    if (target.nodeType === 1) return target;
    if (typeof target === 'string') {
      try {
        var byId = document.getElementById(target);
        if (byId) return byId;
        return document.querySelector(target);
      } catch (e) {
        return null;
      }
    }
    if (typeof target === 'object') {
      if (target.el && target.el.nodeType === 1) return target.el;
      if (typeof target.selector === 'string') return resolveTarget(target.selector);
    }
    return null;
  }

  function setCoachTarget(target) {
    if (coachTarget) coachTarget.classList.remove('exp-coach-target');
    coachTarget = resolveTarget(target);
    if (coachTarget) coachTarget.classList.add('exp-coach-target');
  }

  function showTutorialStep(data) {
    if (!mounted || !coach) return;
    var stepData = obj(data);
    var step = Math.max(0, num(stepData.step, 0));
    var total = Math.max(0, num(stepData.total, 0));
    var title = str(stepData.title, 'Eğitim');
    var text = str(stepData.text, '');
    coach.hidden = false;
    document.body.classList.add('exp-coaching');
    coachStep.textContent = total > 0 ? 'Adım ' + Math.min(step || 1, total) + ' / ' + total : 'EĞİTİM';
    coachTitle.textContent = title;
    coachText.textContent = text;
    coachText.hidden = !text;
    if (coachBar) coachBar.style.width = total > 0 ? Math.max(0, Math.min(100, (Math.min(step || 1, total) / total) * 100)) + '%' : '0%';
    setCoachTarget(stepData.target);
  }

  function hideTutorial() {
    if (!mounted) return;
    if (coach) coach.hidden = true;
    setCoachTarget(null);
    document.body.classList.remove('exp-coaching');
    if (coachStep) coachStep.textContent = '';
    if (coachTitle) coachTitle.textContent = '';
    if (coachText) {
      coachText.textContent = '';
      coachText.hidden = false;
    }
    if (coachBar) coachBar.style.width = '0%';
  }

  function rewardAchievements(value) {
    if (!Array.isArray(value)) return [];
    return value.map(function (item) {
      if (typeof item === 'string') return achievementLabel(item);
      if (item && typeof item === 'object') return str(item.name, achievementLabel(str(item.id, '')));
      return '';
    }).filter(Boolean);
  }

  function closeRewards(restore) {
    if (!rewardRoot) return;
    document.removeEventListener('keydown', onRewardKey, true);
    if (rewardRoot.parentNode) rewardRoot.parentNode.removeChild(rewardRoot);
    rewardRoot = null;
    document.body.classList.remove('exp-rewards-open');
    if (restore && rewardPreviousFocus && document.contains(rewardPreviousFocus)) {
      try { rewardPreviousFocus.focus({ preventScroll: true }); } catch (e) { rewardPreviousFocus.focus(); }
    }
    rewardPreviousFocus = null;
  }

  function onRewardKey(event) {
    if (!rewardRoot) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRewards(true);
      return;
    }
    if (event.key !== 'Tab') return;
    var focusables = rewardRoot.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function showRewards(data) {
    if (!mounted) return;
    closeRewards(false);
    var reward = obj(data);
    var coinsRaw = reward.coins;
    var coins = typeof coinsRaw === 'number'
      ? coinsRaw
      : (coinsRaw && typeof coinsRaw === 'object' ? num(firstValue([coinsRaw.earned, coinsRaw.amount, coinsRaw.value]), 0) : 0);
    var achievements = rewardAchievements(reward.achievements);
    rewardPreviousFocus = document.activeElement;

    rewardRoot = el('div', 'exp-rewards');
    rewardRoot.setAttribute('role', 'dialog');
    rewardRoot.setAttribute('aria-modal', 'true');
    rewardRoot.setAttribute('aria-labelledby', 'exp-reward-title');
    var panel = el('div', 'exp-rewards-panel');
    var title = el('h2', '', reward.firstClear ? 'Yeni bölüm tamamlandı' : 'Ödüller');
    title.id = 'exp-reward-title';
    panel.appendChild(title);

    var coinLine = el('div', 'exp-reward-coins');
    var coinIcon = el('span', '', '🪙');
    coinIcon.setAttribute('aria-hidden', 'true');
    coinLine.appendChild(coinIcon);
    coinLine.appendChild(el('b', '', (coins >= 0 ? '+' : '') + formatNumber(coins) + ' coin'));
    panel.appendChild(coinLine);

    if (reward.firstClear) {
      var first = el('p', 'exp-reward-flag is-good');
      first.appendChild(el('span', '', '✦'));
      first.appendChild(el('span', '', 'İlk kez tamamlandı'));
      panel.appendChild(first);
    }
    if (typeof reward.objectiveMet === 'boolean') {
      var objective = el('p', 'exp-reward-flag ' + (reward.objectiveMet ? 'is-good' : 'is-bad'));
      objective.appendChild(el('span', '', reward.objectiveMet ? '✓' : '—'));
      objective.appendChild(el('span', '', reward.objectiveMet ? 'Hedef tamamlandı' : 'Hedef tamamlanmadı'));
      panel.appendChild(objective);
    }
    if (achievements.length) {
      var badgeList = el('div', 'exp-reward-badges');
      achievements.forEach(function (label) {
        var badge = el('span', 'exp-badge');
        var icon = el('span', '', '🏅');
        icon.setAttribute('aria-hidden', 'true');
        badge.appendChild(icon);
        badge.appendChild(el('span', '', label));
        badgeList.appendChild(badge);
      });
      panel.appendChild(badgeList);
    }

    var close = el('button', 'exp-btn exp-btn-primary exp-rewards-close', 'Devam');
    close.type = 'button';
    close.addEventListener('click', function () { closeRewards(true); });
    panel.appendChild(close);
    rewardRoot.appendChild(panel);
    rewardRoot.addEventListener('click', function (event) {
      if (event.target === rewardRoot) closeRewards(true);
    });
    document.body.appendChild(rewardRoot);
    document.body.classList.add('exp-rewards-open');
    document.addEventListener('keydown', onRewardKey, true);
    try { close.focus({ preventScroll: true }); } catch (e) { close.focus(); }
  }

  var api = {
    render: render,
    announce: announce,
    showTutorialStep: showTutorialStep,
    hideTutorial: hideTutorial,
    showRewards: showRewards,
    dismissRewards: function () { if (!rewardRoot) return false; closeRewards(true); return true; }
  };

  function mount(nextAdapter) {
    adapter = nextAdapter && typeof nextAdapter === 'object' ? nextAdapter : {};
    if (mounted) {
      render();
      return api;
    }
    var start = document.getElementById('start');
    var card = start ? start.querySelector('.card') : null;
    if (!start || !card || !document.body) return api;
    root = start;
    build(card);
    mounted = true;
    render();
    return api;
  }

  window.MT3D_EXPERIENCE = { mount: mount };
})();
