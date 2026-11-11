#!/usr/bin/env node
// Deterministic tests for web/progression.js. The module is DOM-free and is loaded with
// Node's vm, so these tests exercise the real production API, not a reimplementation.
// Run with: node --test tools/test_progression.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../web/progression.js', import.meta.url)), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { filename: 'progression.js' });
const P = sandbox.window.MT3D_PROGRESS;
assert.ok(P, 'window.MT3D_PROGRESS must be exposed');

const OLD_STAGES = [
  { w: 8, d: 8, m: 8, theme: 'meadow' },
  { w: 10, d: 10, m: 13, theme: 'meadow' },
  { w: 10, d: 10, m: 15, theme: 'desert' },
  { w: 12, d: 12, m: 21, theme: 'desert' },
  { w: 12, d: 12, m: 23, theme: 'snow' },
  { w: 14, d: 14, m: 30, theme: 'snow' },
  { w: 12, d: 12, m: 22, theme: 'night' },
  { w: 16, d: 16, m: 40, theme: 'night' },
];

const clone = value => JSON.parse(JSON.stringify(value));
// vm objects come from another realm, so compare their JSON shape instead of prototypes.
const same = (actual, expected, message) => {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);
};
const run = (overrides = {}) => ({
  runId: 'run-1',
  stageIndex: 0,
  mode: 'kampanya',
  won: true,
  lives: 3,
  chargesUsed: 0,
  elapsed: 40,
  scanned: 0,
  flagsPlaced: 0,
  dayKey: '2026-01-15',
  ...overrides,
});

test('catalog: 24 original stages across 4 regions and frozen readonly data', () => {
  assert.equal(P.CATALOG.length, 24);
  assert.equal(P.REGIONS.length, 4);
  assert.ok(Object.isFrozen(P.CATALOG));
  assert.ok(Object.isFrozen(P.MODES));
  assert.ok(Object.isFrozen(P.SKINS));
  assert.ok(P.MODES.includes('gunluk'), 'daily mode must be part of the core mode list');
  same([...P.MODES].slice(0, 4), ['kampanya', 'kolay', 'orta', 'zor']);

  const ids = new Set();
  const titles = new Set();
  const regionCounts = new Map(P.REGIONS.map(region => [region.name, 0]));
  for (const entry of P.CATALOG) {
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.objective));
    assert.ok(entry.id && entry.title && entry.region && entry.description);
    assert.ok(!ids.has(entry.id), 'duplicate id ' + entry.id);
    assert.ok(!titles.has(entry.title), 'duplicate title ' + entry.title);
    ids.add(entry.id);
    titles.add(entry.title);
    assert.ok(regionCounts.has(entry.region), 'unknown region ' + entry.region);
    regionCounts.set(entry.region, regionCounts.get(entry.region) + 1);
    assert.ok(P.THEMES.includes(entry.theme));
    assert.ok(entry.w <= 18 && entry.d <= 18, entry.id + ' board larger than 18x18');
    assert.ok(entry.m >= 1 && entry.m <= 55, entry.id + ' mine count out of range');
    assert.ok(entry.m <= entry.w * entry.d - 9, entry.id + ' leaves no room for the 3x3 drop zone');
    assert.ok(Number.isInteger(entry.parSeconds) && entry.parSeconds > 0);
    assert.ok(['finish', 'clean', 'scanLimit', 'time'].includes(entry.objective.kind));
    if (entry.objective.kind === 'scanLimit' || entry.objective.kind === 'time') {
      assert.ok(Number.isInteger(entry.objective.value) && entry.objective.value > 0);
    }
    assert.ok(entry.objective.label.length > 0);
  }
  for (const count of regionCounts.values()) assert.equal(count, 6);
});

test('catalog indices 0-7 keep the original eight stage configs exactly', () => {
  for (let i = 0; i < OLD_STAGES.length; i++) {
    const entry = P.CATALOG[i];
    assert.equal(entry.w, OLD_STAGES[i].w, 'stage ' + (i + 1) + ' width');
    assert.equal(entry.d, OLD_STAGES[i].d, 'stage ' + (i + 1) + ' depth');
    assert.equal(entry.m, OLD_STAGES[i].m, 'stage ' + (i + 1) + ' mines');
    assert.equal(entry.theme, OLD_STAGES[i].theme, 'stage ' + (i + 1) + ' theme');
  }
});

test('achievement labels match the tracked behaviour', () => {
  const byId = Object.fromEntries(P.ACHIEVEMENTS.map(item => [item.id, item]));
  assert.equal(byId['seri-7'].title, 'Yedili Seri');
  assert.equal(byId['ilk-zafer'].description, 'İlk galibiyetini al.');
});

test('default profile has schema v1 and the tutorial flag', () => {
  const profile = P.defaultProfile();
  assert.equal(P.PROFILE_KEY, 'mt3d-v1-profile');
  assert.equal(profile.v, 1);
  assert.equal(profile.coins, 0);
  assert.equal(profile.tutorialCompleted, false);
  same(profile.stageResults, {});
  same(profile.achievements, []);
  same(profile.inventory, ['yesil']);
  assert.equal(profile.selectedSkin, 'yesil');
  same(profile.statistics, {
    runs: 0, wins: 0, losses: 0,
    campaignWins: 0, dailyWins: 0, freeWins: 0,
    streak: 0, bestStreak: 0,
    scanned: 0, minesFlagged: 0,
    objectives: 0,
  });
  same(profile.dailyResults, {});
  same(profile.processedRuns, []);
  const second = P.defaultProfile();
  second.coins = 5;
  assert.equal(profile.coins, 0, 'defaultProfile must return independent objects');
});

test('tutorialCompleted only accepts a real boolean', () => {
  assert.equal(P.normalizeProfile({ tutorialCompleted: true }).tutorialCompleted, true);
  assert.equal(P.normalizeProfile({ tutorialCompleted: false }).tutorialCompleted, false);
  assert.equal(P.normalizeProfile({ tutorialCompleted: 'true' }).tutorialCompleted, false);
  assert.equal(P.normalizeProfile({ tutorialCompleted: 1 }).tutorialCompleted, false);
  assert.equal(P.normalizeProfile(null).tutorialCompleted, false);
});

test('malformed and hostile profiles fall back to bounded safe values', () => {
  same(P.normalizeProfile(null), P.defaultProfile());
  same(P.normalizeProfile('nope'), P.defaultProfile());
  same(P.normalizeProfile([]), P.defaultProfile());

  const coinProfile = P.normalizeProfile({ coins: -500 });
  assert.equal(coinProfile.coins, 0);
  assert.equal(P.normalizeProfile({ coins: NaN }).coins, 0);
  assert.equal(P.normalizeProfile({ coins: Infinity }).coins, 0);
  assert.equal(P.normalizeProfile({ coins: 1e12 }).coins, 999999);
  assert.equal(P.normalizeProfile({ coins: '42' }).coins, 42);

  const stageResults = P.normalizeProfile({
    stageResults: {
      0: { clears: 2, bestLives: 9, bestTime: -4, bestScan: 7, objectiveMet: 1 },
      1: { clears: 0, bestLives: 3 },
      99: { clears: 10 },
      bad: { clears: 10 },
    },
  });
  same(Object.keys(stageResults.stageResults), ['0']);
  assert.equal(stageResults.stageResults[0].clears, 2);
  assert.equal(stageResults.stageResults[0].bestLives, 3);
  assert.equal(stageResults.stageResults[0].bestTime, 0);
  assert.equal(stageResults.stageResults[0].bestScan, 3);
  assert.equal(stageResults.stageResults[0].objectiveMet, false);

  const collection = P.normalizeProfile({
    achievements: ['zengin', 'hile', 'zengin', 42],
    inventory: ['mor', 'hile', 'mor'],
    selectedSkin: 'altin',
    statistics: { runs: -1, wins: NaN, streak: 4, bestStreak: 2, scanned: 1e12 },
  });
  same(collection.achievements, ['zengin']);
  same(collection.inventory, ['yesil', 'mor']);
  assert.equal(collection.selectedSkin, 'yesil');
  assert.equal(collection.statistics.runs, 0);
  assert.equal(collection.statistics.wins, 0);
  assert.equal(collection.statistics.streak, 4);
  assert.equal(collection.statistics.bestStreak, 4);
  assert.equal(collection.statistics.scanned, 999999999);
});

test('daily history is bounded to 30 valid UTC days and polluted keys are ignored', () => {
  const raw = {};
  for (let i = 0; i < 40; i++) {
    const date = new Date(Date.UTC(2026, 0, 1 + i));
    raw[P.utcDay(date)] = { runs: 1, wins: 1, bestLives: 3, bestTime: 50, objectiveMet: i % 2 === 0 };
  }
  raw['2026-02-30'] = { runs: 1, wins: 1 };
  raw['31-12-2026'] = { runs: 1, wins: 1 };
  raw.__proto__ = { runs: 1, wins: 1 };
  const daily = P.normalizeProfile({ dailyResults: raw }).dailyResults;
  const keys = Object.keys(daily);
  assert.equal(keys.length, 30);
  assert.equal(keys[0], '2026-02-09'); // newest of 40 days
  assert.ok(!keys.includes('2026-02-30'));
  assert.ok(!keys.includes('31-12-2026'));
  assert.ok(!Object.prototype.hasOwnProperty.call(daily, '__proto__'));
});

test('processed run ledger is finite, deduplicated and bounded to 128 entries', () => {
  const raw = [];
  for (let i = 0; i < 200; i++) {
    raw.push({
      runId: 'r' + i, dayKey: '2026-01-01', mode: 'kampanya', stageIndex: 0,
      won: true, coins: 1, objectiveMet: false, firstClear: false,
    });
  }
  raw.push({ runId: 'r0', dayKey: '2026-01-01', mode: 'kampanya', stageIndex: 0, won: true });
  raw.push({ runId: 'bad-stage', dayKey: '2026-01-01', mode: 'kampanya', stageIndex: 999 });
  raw.push({ runId: 'bad-mode', dayKey: '2026-01-01', mode: 'hile', stageIndex: 0 });
  raw.push({ runId: 'bad-day', dayKey: '2026-02-30', mode: 'kampanya', stageIndex: 0 });
  const ledger = P.normalizeProfile({ processedRuns: raw }).processedRuns;
  assert.equal(ledger.length, 128);
  assert.equal(ledger[0].runId, 'r72');
  assert.equal(ledger[127].runId, 'r199');
  assert.equal(new Set(ledger.map(item => item.runId)).size, 128);
});

test('first campaign clear pays once and reports objective/first-clear rewards', () => {
  const before = P.defaultProfile();
  const result = P.recordResult(before, run());
  assert.equal(result.rewards.firstClear, true);
  assert.equal(result.rewards.objectiveMet, true);
  assert.equal(result.rewards.coins, 25); // 10 first clear + 15 finish objective
  assert.ok(result.rewards.achievements.includes('ilk-zafer'));
  assert.equal(result.profile.stageResults[0].clears, 1);
  assert.equal(result.profile.stageResults[0].bestLives, 3);
  assert.equal(result.profile.stageResults[0].bestTime, 40);
  assert.equal(result.profile.statistics.wins, 1);
  assert.equal(result.profile.statistics.campaignWins, 1);
  assert.equal(result.profile.statistics.runs, 1);
  assert.equal(before.coins, 0, 'recordResult must not mutate the input profile');
});

test('duplicate run ids across reloads never pay twice', () => {
  const first = P.recordResult(P.defaultProfile(), run());
  const duplicate = P.recordResult(first.profile, run());
  assert.equal(duplicate.duplicate, true);
  same(duplicate.rewards, {
    coins: 0, achievements: [], objectiveMet: false, firstClear: false,
  });
  same(duplicate.profile, first.profile);

  // Reload scenario: the same original profile is handed in again.
  const reloaded = P.recordResult(P.defaultProfile(), run());
  assert.equal(reloaded.rewards.coins, 25);
  assert.equal(reloaded.profile.processedRuns.length, 1);
});

test('repeat wins cannot farm first-clear or objective coins', () => {
  let profile = P.recordResult(P.defaultProfile(), run()).profile;
  const coinsAfterFirst = profile.coins;
  for (let i = 0; i < 12; i++) {
    const result = P.recordResult(profile, run({ runId: 'repeat-' + i }));
    profile = result.profile;
    assert.equal(result.rewards.coins, 0, 'identical repeat win must not pay');
    assert.equal(result.rewards.firstClear, false);
  }
  assert.equal(profile.coins, coinsAfterFirst);
  assert.equal(profile.stageResults[0].clears, 13);
  assert.equal(profile.processedRuns.length, 13);
});

test('region expert needs six distinct campaign stages, not six repeats', () => {
  let repeated = P.defaultProfile();
  for (let i = 0; i < 6; i++) {
    repeated = P.recordResult(repeated, run({ runId: 'same-stage-' + i, stageIndex: 0 })).profile;
  }
  assert.equal(Object.keys(repeated.stageResults).length, 1);
  assert.ok(!repeated.achievements.includes('bolge-uzmani'));

  let distinct = P.defaultProfile();
  for (let i = 0; i < 5; i++) {
    distinct = P.recordResult(distinct, run({ runId: 'distinct-' + i, stageIndex: i })).profile;
  }
  assert.ok(!distinct.achievements.includes('bolge-uzmani'));
  distinct = P.recordResult(distinct, run({ runId: 'distinct-5', stageIndex: 5 })).profile;
  assert.equal(Object.keys(distinct.stageResults).length, 6);
  assert.ok(distinct.achievements.includes('bolge-uzmani'));
});

test('record-improvement bonuses are paid at most once per stage', () => {
  let profile = P.recordResult(P.defaultProfile(), run({ runId: 'rec-0', elapsed: 100 })).profile;
  let result = P.recordResult(profile, run({ runId: 'rec-1', elapsed: 80 }));
  assert.equal(result.rewards.coins, 3);
  profile = result.profile;
  assert.equal(profile.stageResults[0].timeRecordPaid, true);

  result = P.recordResult(profile, run({ runId: 'rec-2', elapsed: 60 }));
  assert.equal(result.rewards.coins, 0);
  assert.equal(result.profile.stageResults[0].bestTime, 60);
  assert.equal(result.profile.stageResults[0].timeRecordPaid, true);
});

test('losses pay nothing and do not create a first clear', () => {
  const result = P.recordResult(P.defaultProfile(), run({
    stageIndex: 1, won: false, lives: 0, elapsed: 300, chargesUsed: 3,
  }));
  same(result.rewards, {
    coins: 0, achievements: [], objectiveMet: false, firstClear: false,
  });
  same(result.profile.stageResults, {});
  assert.equal(result.profile.statistics.losses, 1);
  assert.equal(result.profile.statistics.streak, 0);
  assert.equal(result.profile.processedRuns.length, 1);
});

test('clean, scan-limit and time objectives are bonus medals, paid once', () => {
  // Stage 2 (index 1) objective: finish without losing a life.
  let profile = P.defaultProfile();
  let result = P.recordResult(profile, run({ runId: 'clean-a', stageIndex: 1, lives: 2 }));
  assert.equal(result.rewards.firstClear, true);
  assert.equal(result.rewards.objectiveMet, false);
  const firstClearCoins = result.rewards.coins;
  assert.equal(firstClearCoins, 11); // 10 + index 1, no objective bonus

  result = P.recordResult(result.profile, run({ runId: 'clean-b', stageIndex: 1, lives: 3 }));
  assert.equal(result.rewards.objectiveMet, true);
  assert.equal(result.rewards.firstClear, false);
  assert.equal(result.rewards.coins, 18); // 15 objective + 3 improved lives

  const afterObjective = result.profile.coins;
  result = P.recordResult(result.profile, run({ runId: 'clean-c', stageIndex: 1, lives: 3 }));
  assert.equal(result.rewards.objectiveMet, true);
  assert.equal(result.rewards.coins, 0);
  assert.equal(result.profile.coins, afterObjective);

  // Stage 3 (index 2) objective: at most two detector charges.
  profile = P.recordResult(P.defaultProfile(), run({
    runId: 'scan-a', stageIndex: 2, chargesUsed: 3,
  })).profile;
  result = P.recordResult(profile, run({ runId: 'scan-b', stageIndex: 2, chargesUsed: 2 }));
  assert.equal(result.rewards.objectiveMet, true);
  assert.ok(result.rewards.coins >= 15);

  // Stage 4 (index 3) objective: 150 seconds.
  profile = P.recordResult(P.defaultProfile(), run({
    runId: 'time-a', stageIndex: 3, elapsed: 200,
  })).profile;
  result = P.recordResult(profile, run({ runId: 'time-b', stageIndex: 3, elapsed: 140 }));
  assert.equal(result.rewards.objectiveMet, true);
  assert.ok(result.rewards.coins >= 15);
});

test('campaign wins and daily results stay bounded under volume', () => {
  let profile = P.defaultProfile();
  for (let i = 0; i < 160; i++) {
    profile = P.recordResult(profile, run({ runId: 'volume-' + i })).profile;
  }
  assert.equal(profile.statistics.runs, 160);
  assert.equal(profile.statistics.wins, 160);
  assert.equal(profile.processedRuns.length, P.MAX_RUNS);
  assert.ok(profile.processedRuns.length <= 128);

  for (let i = 0; i < 40; i++) {
    const dayKey = P.utcDay(new Date(Date.UTC(2026, 0, 1 + i)));
    profile = P.recordResult(profile, run({
      runId: 'daily-' + i, mode: 'gunluk', stageIndex: 0, dayKey,
    })).profile;
  }
  assert.equal(Object.keys(profile.dailyResults).length, P.MAX_DAILY_DAYS);
  assert.equal(Object.keys(profile.dailyResults)[0], '2026-02-09');
});

test('buySkin and equipSkin are immutable, bounded and report explicit reasons', () => {
  const base = P.normalizeProfile({ coins: 1000 });
  const snapshot = clone(base);

  same(P.buySkin(base, 'yok').reason, 'unknown-skin');
  same(P.buySkin(base, 'yesil').reason, 'already-owned');

  const poor = P.normalizeProfile({ coins: 10 });
  assert.equal(P.buySkin(poor, 'kizil').ok, false);
  assert.equal(P.buySkin(poor, 'kizil').reason, 'insufficient-coins');

  const bought = P.buySkin(base, 'kizil');
  assert.equal(bought.ok, true);
  assert.equal(bought.reason, null);
  assert.equal(bought.profile.coins, 920);
  assert.ok(bought.profile.inventory.includes('kizil'));
  same(base, snapshot, 'buySkin must not mutate its input');

  assert.equal(P.equipSkin(bought.profile, 'altin').reason, 'not-owned');
  assert.equal(P.equipSkin(bought.profile, 'yok').reason, 'unknown-skin');
  const equipped = P.equipSkin(bought.profile, 'kizil');
  assert.equal(equipped.ok, true);
  assert.equal(equipped.profile.selectedSkin, 'kizil');
  assert.equal(bought.profile.selectedSkin, 'yesil');
  same(bought.profile.inventory, ['yesil', 'kizil']);

  const exact = P.buySkin(P.normalizeProfile({ coins: 80 }), 'kizil');
  assert.equal(exact.ok, true);
  assert.equal(exact.profile.coins, 0);

  // The fourth owned look unlocks the collector achievement during the purchase itself.
  let collector = P.normalizeProfile({ coins: 1000 });
  collector = P.buySkin(collector, 'kizil').profile;
  collector = P.buySkin(collector, 'mavi').profile;
  assert.ok(!collector.achievements.includes('koleksiyoncu'));
  const fourth = P.buySkin(collector, 'mor');
  assert.equal(fourth.ok, true);
  assert.equal(fourth.reason, null);
  assert.equal(fourth.profile.inventory.length, 4);
  assert.ok(fourth.profile.achievements.includes('koleksiyoncu'));
  assert.equal(collector.achievements.includes('koleksiyoncu'), false, 'input stays untouched');
});

test('UTC day keys and daily challenges are deterministic and local-only', () => {
  assert.equal(P.utcDay(new Date(Date.UTC(2026, 0, 1, 23, 30))), '2026-01-01');
  assert.equal(P.utcDay(Date.UTC(2026, 5, 9, 0, 5)), '2026-06-09');
  assert.throws(() => P.utcDay(new Date('nope')), error => error && error.name === 'TypeError');
  assert.throws(() => P.dailyChallenge('2026-02-30'), error => error && error.name === 'TypeError');

  const a = P.dailyChallenge('2026-01-01');
  const b = P.dailyChallenge('2026-01-01');
  same(a, b);
  assert.equal(a.dayKey, '2026-01-01');
  assert.ok(Number.isInteger(a.seed) && a.seed >= 0 && a.seed <= 0xFFFFFFFF);
  assert.ok((a.cfg.w === 9 && a.cfg.d === 9) || (a.cfg.w === 12 && a.cfg.d === 12));
  assert.ok(P.THEMES.includes(a.cfg.theme));
  assert.ok(a.cfg.m >= 1 && a.cfg.m <= a.cfg.w * a.cfg.d - 9);
  assert.match(a.title, /^Günün Tarlası:/);
  assert.ok(['finish', 'clean', 'scanLimit', 'time'].includes(a.objective.kind));

  const c = P.dailyChallenge('2026-01-02');
  assert.notEqual(a.seed, c.seed);
  assert.throws(() => P.dailyChallenge('31-12-2026'), error => error && error.name === 'TypeError');
});

test('seededRandom is deterministic, seedable and stays in [0, 1)', () => {
  const sequence = seed => {
    const random = P.seededRandom(seed);
    return Array.from({ length: 8 }, () => random());
  };
  same(sequence(12345), sequence(12345));
  assert.notEqual(JSON.stringify(sequence(12345)), JSON.stringify(sequence(54321)));
  for (const value of sequence(0)) assert.ok(value >= 0 && value < 1);
  assert.equal(typeof P.seededRandom(NaN), 'function');
});

test('gunluk mode pays the first daily win and objective once per UTC day', () => {
  const dayKey = '2026-03-10';
  const challenge = P.dailyChallenge(dayKey);
  const dailyRun = overrides => run({
    runId: 'daily-1', mode: 'gunluk', stageIndex: 0, dayKey,
    lives: 3, chargesUsed: 0, elapsed: 1, ...overrides,
  });

  let result = P.recordResult(P.defaultProfile(), dailyRun({}));
  assert.equal(result.rewards.firstClear, false);
  assert.equal(result.rewards.objectiveMet, true);
  assert.ok(result.rewards.coins >= 12, 'daily win must pay');
  assert.equal(result.profile.dailyResults[dayKey].wins, 1);
  assert.equal(result.profile.statistics.dailyWins, 1);
  assert.equal(result.profile.stageResults[0], undefined, 'daily runs are not campaign clears');

  const firstCoins = result.rewards.coins;
  assert.equal(firstCoins, 12 + 5); // win + first-time daily objective

  const repeat = P.recordResult(result.profile, dailyRun({ runId: 'daily-2' }));
  assert.equal(repeat.rewards.coins, 0);
  assert.equal(repeat.profile.dailyResults[dayKey].wins, 2);

  const nextDay = P.recordResult(repeat.profile, dailyRun({
    runId: 'daily-3', dayKey: '2026-03-11',
  }));
  assert.ok(nextDay.rewards.coins >= 12);
  assert.equal(nextDay.profile.dailyResults['2026-03-11'].wins, 1);

  const loss = P.recordResult(P.defaultProfile(), dailyRun({
    runId: 'daily-loss', dayKey: '2026-03-12', won: false, lives: 0,
  }));
  assert.equal(loss.rewards.coins, 0);
  assert.equal(loss.profile.dailyResults['2026-03-12'].runs, 1);
  assert.equal(loss.profile.dailyResults['2026-03-12'].wins, 0);

  assert.ok(challenge.objective.kind);
});

test('migrated baseline stage results never pay retroactive campaign coins', () => {
  const migrated = P.normalizeProfile({
    coins: 0,
    stageResults: {
      0: { clears: 1, bestLives: 2, bestTime: 120, bestScan: 2, objectiveMet: true },
      1: { clears: 1 }, // only the clear is known
    },
  });
  assert.equal(migrated.stageResults[0].clears, 1);
  assert.equal(migrated.stageResults[1].clears, 1);
  assert.equal(migrated.stageResults[1].bestLives, 3);

  const first = P.recordResult(migrated, run({
    runId: 'migrated-a', stageIndex: 0, lives: 2, elapsed: 120, chargesUsed: 2,
  }));
  assert.equal(first.rewards.firstClear, false);
  assert.equal(first.rewards.coins, 0);

  const second = P.recordResult(first.profile, run({
    runId: 'migrated-b', stageIndex: 1, lives: 3, elapsed: 100,
  }));
  assert.equal(second.rewards.firstClear, false);
  // The migrated entry only knew "cleared", so the objective medal can still be earned by
  // this genuine new win; the migration itself paid nothing and no first-clear bonus is due.
  assert.equal(second.rewards.coins, 15);
  assert.equal(second.rewards.objectiveMet, true);
});

test('migrated null bestTime stays null and is filled without a record bonus', () => {
  const migrated = P.normalizeProfile({
    stageResults: {
      0: { clears: 1, bestLives: 3, bestTime: null, objectiveMet: true },
      1: { clears: 1 },
      2: { clears: 1, bestTime: -4 },
    },
  });
  assert.equal(migrated.stageResults[0].bestTime, null);
  assert.equal(migrated.stageResults[1].bestTime, null);
  assert.equal(migrated.stageResults[2].bestTime, 0);

  const filled = P.recordResult(migrated, run({
    runId: 'fill-time', stageIndex: 0, lives: 3, elapsed: 100,
  }));
  assert.equal(filled.rewards.firstClear, false);
  assert.equal(filled.rewards.coins, 0);
  assert.equal(filled.profile.stageResults[0].bestTime, 100);
  assert.equal(filled.profile.stageResults[0].timeRecordPaid, true);
});

test('old daily days cannot farm rewards after the 30-day map is full', () => {
  let profile = P.defaultProfile();
  // 31 days fills the map and drops the oldest day (2026-01-01).
  for (let i = 0; i < 31; i++) {
    const dayKey = P.utcDay(new Date(Date.UTC(2026, 0, 1 + i)));
    profile = P.recordResult(profile, run({
      runId: 'retention-' + i, mode: 'gunluk', stageIndex: 0,
      dayKey, lives: 3, chargesUsed: 0, elapsed: 1,
    })).profile;
  }
  const keys = Object.keys(profile.dailyResults);
  assert.equal(keys.length, P.MAX_DAILY_DAYS);
  assert.ok(!keys.includes('2026-01-01'));
  assert.ok(keys.includes('2026-01-31'));

  const coinsBefore = profile.coins;
  const winsBefore = profile.statistics.dailyWins;
  const runsBefore = profile.statistics.runs;
  const replay = P.recordResult(profile, run({
    runId: 'retention-replay-old', mode: 'gunluk', stageIndex: 0,
    dayKey: '2026-01-01', lives: 3, chargesUsed: 0, elapsed: 1,
  }));
  assert.equal(replay.note, 'daily-outside-retention');
  assert.equal(replay.rewards.coins, 0);
  assert.equal(replay.profile.coins, coinsBefore);
  assert.equal(replay.profile.statistics.dailyWins, winsBefore + 1);
  assert.equal(replay.profile.statistics.runs, runsBefore + 1);
  assert.ok(!Object.keys(replay.profile.dailyResults).includes('2026-01-01'));
  assert.equal(Object.keys(replay.profile.dailyResults).length, P.MAX_DAILY_DAYS);
});

test('invalid result payloads are rejected explicitly, not silently awarded', () => {
  const base = P.defaultProfile();
  const cases = [
    ['null', null, 'invalid-result'],
    ['run-id', run({ runId: '' }), 'invalid-run-id'],
    ['run-id-type', run({ runId: {} }), 'invalid-run-id'],
    ['mode', run({ mode: 'hile' }), 'invalid-mode'],
    ['stage', run({ stageIndex: 24 }), 'invalid-stage'],
    ['won', run({ won: 'yes' }), 'invalid-won'],
    ['lives', run({ lives: 9 }), 'invalid-lives'],
    ['elapsed', run({ elapsed: -1 }), 'invalid-elapsed'],
    ['charges', run({ chargesUsed: 4 }), 'invalid-charges'],
    ['scanned', run({ scanned: -1 }), 'invalid-scanned'],
    ['flags', run({ flagsPlaced: 999 }), 'invalid-flags'],
    ['day', run({ dayKey: '2026-02-30' }), 'invalid-day'],
  ];
  for (const [name, input, reason] of cases) {
    const result = P.recordResult(base, input);
    assert.equal(result.reason, reason, name);
    same(result.rewards, {
      coins: 0, achievements: [], objectiveMet: false, firstClear: false,
    }, name);
    same(result.profile, base, name);
  }
});
