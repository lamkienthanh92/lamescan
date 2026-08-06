// The agreement rule is what makes small patches safe to use, so it gets a test.
import assert from 'node:assert/strict';
import { largestAgreeingGroup } from './src/align.js';

let pass = 0;
const t = (n, f) => { f(); pass++; console.log('  ok  ' + n); };
const P = (dx, dy) => ({ dx, dy, score: 0.8 });

t('one patch stuck on a stationary fixture is outvoted', () => {
  // Real movement is (+180, +2). One patch sat on the halo and reports no motion.
  const g = largestAgreeingGroup([P(180, 2), P(0, 0), P(181, 1), P(179, 3), P(180.5, 2)], 4);
  assert.equal(g.length, 4);
  assert.ok(g.every((r) => r.dx > 100), 'the stuck patch must not be in the group');
});

t('two independent patches are enough to establish a measurement', () => {
  const g = largestAgreeingGroup([P(240, -5), P(0, 0), P(241, -4)], 4);
  assert.equal(g.length, 2);
});

t('total disagreement yields no usable group', () => {
  const g = largestAgreeingGroup([P(0, 0), P(120, 0), P(-90, 40)], 4);
  assert.equal(g.length, 1, 'a lone measurement must not clear a minAgree of 2');
});

t('ALL patches stuck on fixtures agree on zero — caller must reject via min step', () => {
  // The failure mode this whole design exists for. Agreement alone cannot catch
  // it (they genuinely agree), which is why the caller also requires a minimum
  // step before recording a tile — so the scan stalls visibly instead of
  // stacking every frame at the same spot.
  const g = largestAgreeingGroup([P(0, 0), P(0, 0), P(0.5, 0), P(0, 0.5)], 4);
  assert.equal(g.length, 4);
  assert.ok(Math.hypot(g[0].dx, g[0].dy) < 12, 'zero-motion consensus stays below the min step');
});

t('tolerance is a distance, not per-axis', () => {
  assert.equal(largestAgreeingGroup([P(0, 0), P(3, 3)], 4).length, 1); // hypot 4.24 > 4
  assert.equal(largestAgreeingGroup([P(0, 0), P(2, 2)], 4).length, 2); // hypot 2.83 <= 4
});

t('empty input is safe', () => {
  assert.deepEqual(largestAgreeingGroup([], 4), []);
});



// --- how many must agree, and why the number is not 2 ---

t('two patches on the same wrong offset can carry a frame when minAgree is 2', () => {
  // Repetitive tissue: real motion is (+300, 0), but two small patches locked onto
  // a repeated structure one row over and agree with each other on (+300, -95).
  const results = [P(300, 0), P(300, -95), P(301, -94)];
  const g = largestAgreeingGroup(results, 6);
  assert.equal(g.length, 2, 'the wrong pair forms the largest group');
  assert.ok(g[0].dy < -50, 'and it is the wrong answer that wins');
  // With minAgree 3 this frame is refused instead of misplacing a tile.
  assert.ok(g.length < 3);
});

t('a clean frame has all five patches agreeing, so 3 is not a demanding bar', () => {
  const g = largestAgreeingGroup([P(300, 1), P(299, 0), P(300, 0), P(301, 1), P(300, -1)], 6);
  assert.equal(g.length, 5);
});

t('three still tolerates two bad patches', () => {
  // two patches stuck on fixtures, three good
  const g = largestAgreeingGroup([P(0, 0), P(412, 3), P(0, 0), P(411, 2), P(413, 4)], 6);
  assert.equal(g.length, 3);
  assert.ok(g.every((r) => r.dx > 400));
});
console.log(`
${pass} checks passed.`);
