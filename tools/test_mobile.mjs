#!/usr/bin/env node
// Deterministic tests for the pure save/snapshot helpers in index.html plus a few structural
// checks on the mobile/lifecycle wiring.
//
// Scope note: this runs under Node without a DOM or Three.js. The actual lifecycle contract
// (menu visibility, pointer capture, renderer quality) is only checked structurally; it is
// not exercised in a browser here. Run with: node --test tools/test_mobile.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dataMatch = html.match(/<script id="mt3d-data">([\s\S]*?)<\/script>/);
assert.ok(dataMatch, 'mt3d-data script block must exist');

const sandbox = { window: {} };
vm.runInNewContext(dataMatch[1], sandbox, { filename: 'mt3d-data.js' });
const DATA = sandbox.window.MT3D_DATA;

const W = 8, D = 8, M = 8;           // campaign stage 1
const START = { x: 3, z: 3 };
const idx = (x, z) => z * W + x;
const START_IDX = idx(START.x, START.z);
const TOP_ROW = Array.from({ length: M }, (_, i) => i);

function cells(mines, opts = {}) {
  const grid = Array.from({ length: W * D }, () => ({
    mine: false, revealed: false, flagged: false, crater: false,
  }));
  for (const i of mines) grid[i].mine = true;
  for (const i of opts.revealed || []) grid[i].revealed = true;
  for (const i of opts.flags || []) grid[i].flagged = true;
  for (const i of opts.craters || []) grid[i].crater = true;
  return grid;
}

function input(overrides = {}) {
  return {
    stable: true,
    mode: 'kampanya',
    stage: 0,
    cfg: { w: W, d: D, m: M, theme: 'meadow' },
    start: { ...START },
    player: { x: START.x, z: START.z, dir: [0, 1] },
    lives: 3,
    charges: 3,
    elapsed: 42,
    grid: cells(TOP_ROW, { revealed: [START_IDX], flags: [0] }),
    ...overrides,
  };
}

function validNorm(overrides = {}) {
  return DATA.normalizeSnapshot({
    v: 1,
    mode: 'kampanya',
    stage: 0,
    cfg: { w: W, d: D, m: M, theme: 'meadow' },
    grid: { mines: TOP_ROW, revealed: [START_IDX], flags: [0], craters: [] },
    start: { ...START },
    player: { x: START.x, z: START.z, dir: [0, 1] },
    lives: 3, charges: 3, elapsed: 42,
    ...overrides,
  });
}

test('valid snapshot is accepted and normalized deterministically', () => {
  const snap = DATA.makeSnapshot(input());
  assert.ok(snap);
  assert.equal(snap.v, 1);
  assert.deepEqual([...snap.grid.mines], TOP_ROW);
  assert.deepEqual([...snap.grid.revealed], [START_IDX]);
  assert.deepEqual([...snap.grid.flags], [0]);
  assert.deepEqual([...snap.grid.craters], []);
  assert.deepEqual({ ...snap.start }, START);
  assert.deepEqual({ ...snap.player, dir: [...snap.player.dir] }, { x: 3, z: 3, dir: [0, 1] });
  assert.equal(snap.lives, 3);
  assert.equal(snap.charges, 3);
  assert.equal(snap.elapsed, 42);
  // Serialized payload stays small: index arrays instead of per-cell objects.
  assert.ok(JSON.stringify(snap).length < 1024, 'save payload must stay compact');
});

test('unstable snapshots are refused', () => {
  assert.equal(DATA.makeSnapshot({ ...input(), stable: false }), null);
  assert.equal(DATA.makeSnapshot({ ...input(), stable: undefined }), null);
  assert.equal(DATA.makeSnapshot({ ...input(), grid: [] }), null);
  assert.equal(DATA.makeSnapshot(null), null);
});

test('a mid-step destination is never persisted before it opens', () => {
  // The movement code already sets the logical P.x/P.z to the destination; the destination is
  // still unrevealed at that instant, so the snapshot must be refused.
  const midStep = input({
    player: { x: 3, z: 2, dir: [0, -1] },
    grid: cells(TOP_ROW, { revealed: [START_IDX], flags: [0] }),
  });
  assert.equal(DATA.makeSnapshot(midStep), null);
  // Once arrival reveals that tile, the same position is valid.
  const arrived = input({
    player: { x: 3, z: 2, dir: [0, -1] },
    grid: cells(TOP_ROW, { revealed: [START_IDX, idx(3, 2)], flags: [0] }),
  });
  assert.ok(DATA.makeSnapshot(arrived));
});

test('corrupt or hostile saves are rejected', () => {
  assert.equal(DATA.normalizeSnapshot(null), null);
  assert.equal(DATA.normalizeSnapshot('nope'), null);
  assert.equal(validNorm({ v: 2 }), null);
  assert.equal(validNorm({ mode: 'hile' }), null);
  assert.equal(validNorm({ stage: 99 }), null);
  assert.equal(validNorm({ cfg: { w: 5, d: 5, m: 8, theme: 'meadow' } }), null);
  assert.equal(validNorm({ cfg: { w: W, d: D, m: M, theme: 'uzay' } }), null);
  assert.equal(validNorm({ stage: 1 }), null); // campaign cfg must match stage
  assert.equal(validNorm({ grid: { mines: TOP_ROW.slice(1), revealed: [START_IDX], flags: [], craters: [] } }), null);
  assert.equal(validNorm({ grid: { mines: [...TOP_ROW, 8], revealed: [START_IDX], flags: [], craters: [] } }), null);
  assert.equal(validNorm({ grid: { mines: [...TOP_ROW, 8], revealed: [START_IDX], flags: [], craters: [] } }), null);
  assert.equal(validNorm({ lives: 0 }), null);
  assert.equal(validNorm({ lives: 4 }), null);
  assert.equal(validNorm({ charges: 4 }), null);
  assert.equal(validNorm({ elapsed: 999999 }), null);
  assert.equal(validNorm({ player: { x: -1, z: 3, dir: [0, 1] } }), null);
  assert.equal(validNorm({ player: { x: 3, z: 3, dir: [0, 0] } }), null);
});

test('high-volume and duplicate arrays are rejected before allocation damage', () => {
  const huge = Array.from({ length: 1000 }, (_, i) => i % 64);
  assert.equal(validNorm({ grid: { mines: TOP_ROW, revealed: huge, flags: [], craters: [] } }), null);
  assert.equal(validNorm({ grid: { mines: TOP_ROW, revealed: [START_IDX], flags: huge, craters: [] } }), null);
  assert.equal(validNorm({ grid: { mines: [0, 0, 1, 2, 3, 4, 5, 6], revealed: [START_IDX], flags: [], craters: [] } }), null);
  assert.equal(validNorm({ grid: { mines: TOP_ROW, revealed: [START_IDX, START_IDX], flags: [], craters: [] } }), null);
  assert.equal(validNorm({ grid: { mines: TOP_ROW, revealed: [999], flags: [], craters: [] } }), null);
});

test('3x3 drop zone and all-safe reachability are preserved', () => {
  // A mine inside the guaranteed 3x3 landing zone must never be restored.
  const safeZoneMine = [idx(2, 2), 0, 1, 2, 3, 4, 5, 6];
  assert.equal(validNorm({ grid: { mines: safeZoneMine, revealed: [START_IDX], flags: [], craters: [] } }), null);
  // A full row of 8 mines cuts the bottom two rows off from the start.
  const cut = Array.from({ length: 8 }, (_, i) => idx(i, 5));
  assert.equal(DATA.safeReachable({ w: W, d: D }, cut, START_IDX, W * D), false);
  assert.equal(validNorm({ grid: { mines: cut, revealed: [START_IDX], flags: [], craters: [] } }), null);
  assert.equal(DATA.safeReachable({ w: W, d: D }, TOP_ROW, START_IDX, W * D), true);
});

test('life, crater and player consistency is enforced', () => {
  assert.equal(validNorm({ lives: 2 }), null); // one life lost must have one crater
  const craterIdx = 0;
  const withCrater = {
    lives: 2,
    player: { x: 3, z: 3, dir: [0, 1] },
    grid: { mines: TOP_ROW, revealed: [START_IDX], flags: [], craters: [craterIdx] },
  };
  assert.ok(validNorm(withCrater));
  // A crater must belong to a mine.
  assert.equal(validNorm({ lives: 2, grid: { mines: TOP_ROW, revealed: [START_IDX], flags: [], craters: [8] } }), null);
  // Standing on an untouched mine is impossible; standing on a crater is possible.
  assert.equal(validNorm({ player: { x: 0, z: 0, dir: [0, 1] } }), null);
  assert.ok(validNorm({ lives: 2, player: { x: 0, z: 0, dir: [0, 1] },
    grid: { mines: TOP_ROW, revealed: [START_IDX], flags: [], craters: [0] } }));
  // Player must stand on an opened or cratered tile.
  assert.equal(validNorm({ player: { x: 5, z: 5, dir: [0, 1] } }), null);
});

test('flags cannot share a tile with revealed or cratered cells', () => {
  assert.equal(validNorm({ grid: { mines: TOP_ROW, revealed: [START_IDX], flags: [START_IDX], craters: [] } }), null);
  assert.equal(validNorm({ lives: 2, grid: { mines: TOP_ROW, revealed: [START_IDX], flags: [0], craters: [0] } }), null);
});

test('finished boards are not restorable', () => {
  const revealedAllSafe = Array.from({ length: W * D }, (_, i) => i).filter(i => !TOP_ROW.includes(i));
  assert.equal(validNorm({ grid: { mines: TOP_ROW, revealed: revealedAllSafe, flags: [], craters: [] } }), null);
});

test('mobile/lifecycle wiring is present in index.html', () => {
  assert.match(html, /window\.mt3dApp\s*=\s*Object\.freeze/);
  assert.match(html, /visibilitychange/);
  assert.match(html, /pagehide/);
  assert.match(html, /resume\(\)\s*\{\s*return false/);
  assert.match(html, /mt3d-v1-save/);
  assert.match(html, /mt3d-v1-quality/);
  assert.match(html, /lostpointercapture/);
  assert.match(html, /pointercancel/);
  assert.match(html, /prefers-reduced-motion/);
  // The timer must remain visible on phones.
  assert.doesNotMatch(html, /#timeChip\s*\{\s*display:\s*none/);
});
