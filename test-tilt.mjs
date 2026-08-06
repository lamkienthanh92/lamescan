// A mosaic can lean for two completely different reasons that look identical, and
// they need opposite responses. These checks are what tells them apart.
import assert from 'node:assert/strict';
import { scanAxisTilt } from './src/optimize.js';

let pass = 0;
const t = (n, f) => { f(); pass++; console.log('  ok  ' + n); };
const D = (deg) => (deg * Math.PI) / 180;

// A perfectly straight drag along stage-X, on a camera rotated by `deg`.
function tiltedRun(deg, n = 12, step = 700) {
  const tiles = [{ x: 0, y: 0, w: 900, h: 700 }];
  for (let i = 1; i < n; i++) {
    tiles.push({ x: i * step * Math.cos(D(deg)), y: i * step * Math.sin(D(deg)), w: 900, h: 700 });
  }
  return tiles;
}

t('recovers the camera tilt from a straight single-axis run', () => {
  const r = scanAxisTilt(tiltedRun(3));
  assert.ok(Math.abs(r.deg - 3) < 0.01, `expected 3deg, got ${r.deg.toFixed(3)}`);
  assert.ok(r.madDeg < 0.01, 'a fixed camera tilt must show almost no spread');
});

t('an X run and a Y run on the same camera report the same tilt', () => {
  const x = tiltedRun(2.5);
  // same setup, dragged along stage-Y instead: displacement rotated by 90 degrees
  const y = x.map((tt) => ({ x: -tt.y, y: tt.x, w: tt.w, h: tt.h }));
  const rx = scanAxisTilt(x);
  const ry = scanAxisTilt(y);
  assert.ok(Math.abs(rx.deg - ry.deg) < 0.01, `${rx.deg} vs ${ry.deg} — folding into +/-45 should make these agree`);
});

t('a serpentine of straight runs still reports one tilt', () => {
  const tiles = [];
  const deg = 4;
  let x = 0, y = 0;
  for (let col = 0; col < 3; col++) {
    for (let i = 0; i < 6; i++) {
      tiles.push({ x, y, w: 900, h: 700 });
      const dir = col % 2 === 0 ? 1 : -1;      // down, then up
      x += dir * 500 * -Math.sin(D(deg));
      y += dir * 500 * Math.cos(D(deg));
    }
    x += 600 * Math.cos(D(deg));               // step across
    y += 600 * Math.sin(D(deg));
  }
  const r = scanAxisTilt(tiles);
  assert.ok(Math.abs(r.deg - deg) < 0.2, `expected ~${deg}deg, got ${r.deg.toFixed(2)}`);
  assert.ok(r.madDeg < 0.5, `spread ${r.madDeg.toFixed(2)} should stay small`);
});

t('random wandering gives a large spread, so tilt is not claimed', () => {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const tiles = [{ x: 0, y: 0, w: 900, h: 700 }];
  for (let i = 1; i < 20; i++) {
    const a = rnd() * Math.PI * 2;
    tiles.push({ x: tiles[i - 1].x + 600 * Math.cos(a), y: tiles[i - 1].y + 600 * Math.sin(a), w: 900, h: 700 });
  }
  const r = scanAxisTilt(tiles);
  assert.ok(r.madDeg > 5, `expected a wide spread, got ${r.madDeg.toFixed(2)}`);
});

t('too few real steps means no answer rather than a guess', () => {
  assert.equal(scanAxisTilt([{ x: 0, y: 0, w: 9, h: 9 }]), null);
  // steps below the minimum length carry no reliable direction
  assert.equal(scanAxisTilt(tiltedRun(3, 12, 2)), null);
});

console.log(`\n${pass} checks passed.`);
