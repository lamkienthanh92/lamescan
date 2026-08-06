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



// --- what the solve can and cannot fix ---

t('a pure chain cannot detect its own bend, however well it converges', () => {
  // 20 tiles in one straight line, consecutive links only.
  const tiles = [];
  for (let i = 0; i < 20; i++) tiles.push({ x: i * STEP_X, y: 0, w: W, h: H });
  const links = [];
  for (let i = 1; i < tiles.length; i++) {
    // Each measurement is wrong by the same 0.5px in y — a systematic bias.
    links.push({ i: i - 1, j: i, dx: STEP_X, dy: 0.5, w: 1 });
  }
  const out = globalSolve(tiles.map(() => ({ x: 0, y: 0 })), links);
  assert.ok(out.residual < 1e-9, `the solve satisfies every link exactly, residual ${out.residual}`);
  // ...and is exactly wrong: the last tile is 19 * 0.5px off in y, and nothing in
  // the data says otherwise. A perfect residual is not a correct answer.
  assert.ok(Math.abs(out.positions[19].y - 9.5) < 1e-9,
    `chain bias must accumulate unchecked, got ${out.positions[19].y}`);
  assert.equal(links.filter((l) => l.j - l.i > 1).length, 0, 'no cross-links exist to catch it');
});

t('one cross-link closing the loop removes the accumulated bias', () => {
  const tiles = [];
  for (let i = 0; i < 20; i++) tiles.push({ x: i * STEP_X, y: 0, w: W, h: H });
  const links = [];
  for (let i = 1; i < tiles.length; i++) links.push({ i: i - 1, j: i, dx: STEP_X, dy: 0.5, w: 1 });
  // The scan came back and overlapped tile 0 again: a single correct long link.
  links.push({ i: 0, j: 19, dx: 19 * STEP_X, dy: 0, w: 1 });
  const out = globalSolve(tiles.map(() => ({ x: 0, y: 0 })), links);
  assert.ok(Math.abs(out.positions[19].y) < 1.0,
    `the closing link should pull the end back, got ${out.positions[19].y.toFixed(2)}px`);
});

t('a 300-tile chain converges exactly, not approximately', () => {
  // Iterating from the recorded positions with plain Gauss-Seidel left this case
  // 4600px short: information travels about one tile per sweep along a chain, so a
  // long scan needs ~N^2 sweeps. Solving the tree directly makes it exact.
  const N = 300;
  const links = [];
  for (let i = 1; i < N; i++) links.push({ i: i - 1, j: i, dx: STEP_X, dy: 0.5, w: 1 });
  const out = globalSolve(Array.from({ length: N }, () => ({ x: 0, y: 0 })), links);
  const err = Math.abs(out.positions[N - 1].x - (N - 1) * STEP_X);
  assert.ok(err < 1e-6, `end of a 300-tile chain off by ${err.toFixed(1)}px`);
});

t('one closing link straightens a 300-tile chain', () => {
  const N = 300;
  const links = [];
  for (let i = 1; i < N; i++) links.push({ i: i - 1, j: i, dx: STEP_X, dy: 0.5, w: 1 });
  links.push({ i: 0, j: N - 1, dx: (N - 1) * STEP_X, dy: 0, w: 1 });
  const out = globalSolve(Array.from({ length: N }, () => ({ x: 0, y: 0 })), links);
  assert.ok(Math.abs(out.positions[N - 1].y) < 2,
    `expected the 149.5px accumulated bias to be pulled out, got ${out.positions[N - 1].y.toFixed(1)}px`);
});

t('tiles no link reaches keep the position they had', () => {
  const links = [{ i: 0, j: 1, dx: 100, dy: 0, w: 1 }];
  const out = globalSolve([{ x: 0, y: 0 }, { x: 999, y: 999 }, { x: 42, y: 7 }], links);
  assert.deepEqual(out.positions[2], { x: 42, y: 7 });
});
console.log(`
${pass} checks passed.`);
