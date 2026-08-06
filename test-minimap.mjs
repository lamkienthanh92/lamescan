// The map's one substantive claim is "this area has only been captured once".
// That claim drives where the operator goes back to, so it gets a test.
import assert from 'node:assert/strict';
import { coverageStats } from './src/minimap.js';

let pass = 0;
const t = (n, f) => { f(); pass++; console.log('  ok  ' + n); };

const mosaic = { w: 400, h: 200, originX: 0, originY: 0 };
const S = 1; // 1 map cell per mosaic pixel keeps the arithmetic exact

t('two tiles perfectly stacked leave nothing single-covered', () => {
  const tiles = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 100 }];
  const r = coverageStats(mosaic, tiles, S, 400, 200);
  assert.equal(r.coveredCells, 100 * 100);
  assert.equal(r.onceCells, 0);
});

t('two tiles that do not touch are entirely single-covered', () => {
  const tiles = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 0, w: 100, h: 100 }];
  const r = coverageStats(mosaic, tiles, S, 400, 200);
  assert.equal(r.onceCells, r.coveredCells);
});

t('half-overlapping tiles: the overlap is fine, the outer halves are not', () => {
  const tiles = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 0, w: 100, h: 100 }];
  const r = coverageStats(mosaic, tiles, S, 400, 200);
  assert.equal(r.coveredCells, 150 * 100);
  assert.equal(r.onceCells, 100 * 100); // two 50-wide strips
  assert.ok(Math.abs(r.onceCells / r.coveredCells - 2 / 3) < 1e-9);
});

t('an excluded tile stops contributing coverage', () => {
  const tiles = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 100 }];
  const r = coverageStats(mosaic, tiles, S, 400, 200, new Set([1]));
  assert.equal(r.onceCells, r.coveredCells, 'excluding one leaves the other alone');
});

t('coverage respects the mosaic origin offset', () => {
  const off = { w: 400, h: 200, originX: 50, originY: 20 };
  const r = coverageStats(off, [{ x: -50, y: -20, w: 100, h: 100 }], S, 400, 200);
  // tile lands at map (0,0); nothing is clipped away
  assert.equal(r.coveredCells, 100 * 100);
});

t('tiles hanging off the map are clipped, not wrapped', () => {
  const r = coverageStats(mosaic, [{ x: 350, y: 0, w: 100, h: 100 }], S, 400, 200);
  assert.equal(r.coveredCells, 50 * 100);
});

console.log(`\n${pass} checks passed.`);
