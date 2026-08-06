// Global optimisation is the piece that separates "sequential tracking" from what
// Fiji does, so it gets the closest test: build a scan with known truth, corrupt
// the recorded positions the way drift corrupts them, and check the solve recovers.
import assert from 'node:assert/strict';
import { findOverlappingPairs, globalSolve } from './src/optimize.js';

let pass = 0;
const t = (n, f) => { f(); pass++; console.log('  ok  ' + n); };

const W = 400, H = 300, STEP_X = 280, STEP_Y = 210;

// A 6x5 serpentine scan — the shape that makes loop closure matter, because each
// row ends up alongside the row before it.
function truth() {
  const tiles = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 6; c++) {
      const col = r % 2 === 0 ? c : 5 - c;
      tiles.push({ x: col * STEP_X, y: r * STEP_Y, w: W, h: H });
    }
  }
  return tiles;
}

t('overlapping pairs include cross-row neighbours, not just consecutive ones', () => {
  const tiles = truth();
  const pairs = findOverlappingPairs(tiles, 0.12);
  const consecutive = pairs.filter((p) => p.j === p.i + 1).length;
  assert.ok(pairs.length > consecutive * 1.5,
    `expected many non-consecutive links, got ${pairs.length} total vs ${consecutive} consecutive`);
});

t('recovers truth from positions corrupted by accumulated drift', () => {
  const tiles = truth();
  const pairs = findOverlappingPairs(tiles, 0.12);
  // Perfect pairwise measurements (what correlating the overlaps would give).
  const links = pairs.map(({ i, j }) => ({
    i, j, w: 1,
    dx: tiles[j].x - tiles[i].x,
    dy: tiles[j].y - tiles[i].y,
  }));
  // Recorded positions: each tile inherits a 0.4px/step bias, as chaining does.
  const drifted = tiles.map((tt, i) => ({ x: tt.x + i * 0.4, y: tt.y + i * 0.15 }));
  const driftErr = Math.max(...drifted.map((q, i) => Math.hypot(q.x - tiles[i].x, q.y - tiles[i].y)));
  assert.ok(driftErr > 10, `drift should start large, got ${driftErr.toFixed(1)}px`);

  const out = globalSolve(drifted, links);
  const err = Math.max(...out.positions.map((q, i) => Math.hypot(q.x - tiles[i].x, q.y - tiles[i].y)));
  assert.ok(err < 0.05, `expected sub-pixel recovery, got ${err.toFixed(3)}px`);
  assert.ok(out.residual < 0.05);
});

t('one badly mismeasured pair is outvoted, not propagated', () => {
  const tiles = truth();
  const pairs = findOverlappingPairs(tiles, 0.12);
  const links = pairs.map(({ i, j }) => ({
    i, j, w: 1,
    dx: tiles[j].x - tiles[i].x,
    dy: tiles[j].y - tiles[i].y,
  }));
  // Corrupt one link by 60px — a plausible false correlation peak.
  links[Math.floor(links.length / 2)].dx += 60;
  const out = globalSolve(tiles.map((tt) => ({ x: tt.x, y: tt.y })), links);
  const err = Math.max(...out.positions.map((q, i) => Math.hypot(q.x - tiles[i].x, q.y - tiles[i].y)));
  assert.ok(err < 3, `a single bad link should not move anything far, got ${err.toFixed(2)}px`);
  assert.ok(out.dropped >= 1, 'the bad link should have been down-weighted');
});

t('tile 0 is held fixed so the solution cannot slide as a whole', () => {
  const tiles = truth();
  const links = findOverlappingPairs(tiles, 0.12).map(({ i, j }) => ({
    i, j, w: 1, dx: tiles[j].x - tiles[i].x, dy: tiles[j].y - tiles[i].y,
  }));
  const shifted = tiles.map((tt) => ({ x: tt.x + 500, y: tt.y - 300 }));
  const out = globalSolve(shifted, links);
  assert.equal(out.positions[0].x, 500);
  assert.equal(out.positions[0].y, -300);
  // everything else lands in the right place relative to it
  const rel = Math.max(...out.positions.map((q, i) => Math.hypot(q.x - 500 - tiles[i].x, q.y + 300 - tiles[i].y)));
  assert.ok(rel < 0.05, `relative geometry off by ${rel.toFixed(3)}px`);
});

t('no links means no change rather than a crash', () => {
  const out = globalSolve([{ x: 0, y: 0 }, { x: 5, y: 5 }], []);
  assert.deepEqual(out.positions[1], { x: 5, y: 5 });
});

console.log(`\n${pass} checks passed.`);
