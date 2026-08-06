// The mosaic measurement crosses three coordinate spaces. This checks the mapping
// by construction: pick a true tile position, work out where a patch of that frame
// must appear in the scaled mosaic region, then confirm the position is recovered.
import assert from 'node:assert/strict';
import { frameOriginFromMatch } from './src/anchor.js';

let pass = 0;
const t = (n, f) => { f(); pass++; console.log('  ok  ' + n); };

// Forward model: where would a patch land, given a known truth?
function forward({ trueX, trueY, originX, originY, rx, ry, frameScale, patchX, patchY }) {
  const tileMosaicX = trueX + originX;
  const tileMosaicY = trueY + originY;
  // patch content sits patchX/frameScale full-res pixels into the frame
  const patchMosaicX = tileMosaicX + patchX / frameScale;
  const patchMosaicY = tileMosaicY + patchY / frameScale;
  return { foundX: (patchMosaicX - rx) * frameScale, foundY: (patchMosaicY - ry) * frameScale };
}

t('recovers a known tile position exactly', () => {
  const g = { trueX: 1000, trueY: 500, originX: 300, originY: 200, rx: 1250, ry: 650, frameScale: 0.5, patchX: 40, patchY: 30 };
  const f = forward(g);
  const r = frameOriginFromMatch({ ...g, ...f });
  assert.equal(r.x, 1000);
  assert.equal(r.y, 500);
});

t('works for every patch position in the grid', () => {
  const g = { trueX: -742, trueY: 2310, originX: 1024, originY: 64, rx: 200, ry: 2300, frameScale: 0.7111 };
  for (const [patchX, patchY] of [[0, 0], [12, 300], [455, 21], [220, 180]]) {
    const f = forward({ ...g, patchX, patchY });
    const r = frameOriginFromMatch({ ...g, patchX, patchY, ...f });
    assert.ok(Math.abs(r.x - g.trueX) < 1e-6, `x off by ${r.x - g.trueX}`);
    assert.ok(Math.abs(r.y - g.trueY) < 1e-6, `y off by ${r.y - g.trueY}`);
  }
});

t('a subpixel shift in the found peak maps to a subpixel shift in position', () => {
  const g = { trueX: 0, trueY: 0, originX: 0, originY: 0, rx: 0, ry: 0, frameScale: 0.5, patchX: 100, patchY: 100 };
  const f = forward(g);
  const a = frameOriginFromMatch({ ...g, ...f });
  const b = frameOriginFromMatch({ ...g, foundX: f.foundX + 0.5, foundY: f.foundY });
  // half a working pixel at scale 0.5 is one full-resolution pixel
  assert.ok(Math.abs(b.x - a.x - 1) < 1e-9, `expected 1px, got ${b.x - a.x}`);
});

t('drift model: chaining accumulates a constant bias, absolute measurement does not', () => {
  // Why this whole file exists. A 0.15px per-step bias in x over 250 steps.
  const BIAS = 0.15;
  let chained = 0;
  for (let i = 0; i < 250; i++) chained += 400 + BIAS;
  const chainedErr = chained - 250 * 400;
  assert.ok(chainedErr > 35, `chained error should be large, got ${chainedErr.toFixed(1)}px`);
  // Measured against the mosaic each step, the error is whatever that single
  // measurement got wrong — it does not carry forward.
  const absoluteErr = BIAS;
  assert.ok(absoluteErr < 1);
});



// --- relocalisation scale selection ---
import { coarseScaleFor } from './src/anchor.js';

t('coarse scale keeps the frame large enough to correlate on', () => {
  // huge mosaic, modest frame: shrinking to fit the mosaic alone would leave the
  // frame a few pixels across and useless
  const mosaic = { w: 40000, h: 30000 };
  const s = coarseScaleFor(mosaic, 0.7, 900, 700);
  assert.ok(700 * s >= 55, `frame short side would be ${(700 * s).toFixed(1)}px`);
});

t('coarse scale never exceeds the frame working scale (no upsampling)', () => {
  assert.ok(coarseScaleFor({ w: 900, h: 700 }, 0.5, 900, 700) <= 0.5);
  assert.ok(coarseScaleFor({ w: 200, h: 200 }, 0.25, 900, 700) <= 0.25);
});

t('coarse scale shrinks a large mosaic toward the search budget', () => {
  const big = coarseScaleFor({ w: 20000, h: 16000 }, 1, 900, 700);
  const small = coarseScaleFor({ w: 2000, h: 1600 }, 1, 900, 700);
  assert.ok(big < small, 'a larger mosaic must be searched at a coarser scale');
});
console.log(`
${pass} checks passed.`);
