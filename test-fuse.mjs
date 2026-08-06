// The fusion step decides, per pixel, which overlapping tile to trust. These check
// the two rules that decision rests on.
import assert from 'node:assert/strict';
import { hannWeights, tileQuality, medianSharpnessOf, FUSION_METHODS } from './src/fuse.js';

let pass = 0;
const t = (n, f) => { f(); pass++; console.log('  ok  ' + n); };

t('weights peak at the centre of a tile and vanish at its border', () => {
  const { wx } = hannWeights(101, 101);
  const mid = wx[50];
  assert.ok(mid > 0.99, `centre weight should be ~1, got ${mid}`);
  assert.ok(wx[0] < 0.01, `edge weight should be ~0, got ${wx[0]}`);
  assert.ok(wx[100] < 0.01);
  // strictly increasing toward the middle: this is what makes a pixel from the
  // flat centre of the field beat the same detail captured near a halo-lit edge
  for (let i = 1; i <= 50; i++) assert.ok(wx[i] > wx[i - 1], `not monotonic at ${i}`);
});

t('a pixel from a tile centre outranks the same pixel from a tile edge', () => {
  const { wx, wy } = hannWeights(200, 200);
  const centre = wx[100] * wy[100];
  const nearEdge = wx[6] * wy[100];
  assert.ok(centre > nearEdge * 20, `centre ${centre} should dominate edge ${nearEdge}`);
});

t('blurry tiles are down-weighted, not discarded', () => {
  const med = 1000;
  const sharp = tileQuality({ sharpness: 1200, blurry: false }, med);
  const soft = tileQuality({ sharpness: 200, blurry: true }, med);
  assert.equal(sharp, 1);
  assert.ok(soft > 0, 'must stay above zero so it can still fill an uncovered gap');
  assert.ok(soft < 0.3, `should be strongly down-weighted, got ${soft}`);
});

t('quality has a floor even for a nearly featureless tile', () => {
  assert.ok(tileQuality({ sharpness: 1, blurry: true }, 5000) >= 0.15);
});

t('median sharpness ignores missing values', () => {
  assert.equal(medianSharpnessOf([{ sharpness: 10 }, { sharpness: 0 }, { sharpness: 30 }, { sharpness: 20 }]), 20);
  assert.equal(medianSharpnessOf([]), 0);
});

t('every offered method is documented', () => {
  for (const [k, m] of Object.entries(FUSION_METHODS)) {
    assert.ok(m.label && m.note, `${k} missing label/note`);
  }
  assert.ok('robust' in FUSION_METHODS && 'best' in FUSION_METHODS);
});

console.log(`\n${pass} checks passed.`);
