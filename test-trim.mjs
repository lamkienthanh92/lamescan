// The exported image must be the size of the picture, not the size of the buffer
// the picture happens to live in. Growth over-allocates on purpose, so the trim
// arithmetic is what stands between that and giving up resolution to blank space.
import assert from 'node:assert/strict';
import { contentBounds, fitScale, EXPORT_MAX_DIM, EXPORT_MAX_AREA } from './src/mosaic.js';

let pass = 0;
const t = (n, f) => { f(); pass++; console.log('  ok  ' + n); };

t('bounds are the union of the tiles, not the buffer', () => {
  const b = contentBounds([
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 250, y: -40, w: 100, h: 100 },
  ]);
  assert.deepEqual(b, { minX: 0, minY: -40, maxX: 350, maxY: 100 });
});

t('excluded tiles do not hold the bounds open', () => {
  const tiles = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 5000, y: 0, w: 100, h: 100 }];
  const b = contentBounds(tiles, new Set([1]));
  assert.equal(b.maxX, 100, 'a discarded tile must not keep 5000px of empty canvas');
});

t('no tiles means no bounds rather than Infinity', () => {
  assert.equal(contentBounds([]), null);
  assert.equal(contentBounds([{ x: 0, y: 0, w: 9, h: 9 }], new Set([0])), null);
});

t('trimming can be the difference between a full-resolution export and a reduced one', () => {
  // A scan whose content is 14000x9000 but whose buffer grew to 17000x12000
  // through padding: the padded buffer trips the canvas limit, the content does not.
  const padded = fitScale(17000, 12000, EXPORT_MAX_DIM, EXPORT_MAX_AREA);
  const tight = fitScale(14000, 9000, EXPORT_MAX_DIM, EXPORT_MAX_AREA);
  assert.ok(padded < 1, 'the padded buffer should have forced a downscale');
  assert.equal(tight, 1, 'the actual content fits at full resolution');
});

t('a single tile yields bounds exactly its own size', () => {
  const b = contentBounds([{ x: -12.5, y: 7.5, w: 900, h: 700 }]);
  assert.equal(b.maxX - b.minX, 900);
  assert.equal(b.maxY - b.minY, 700);
});

console.log(`\n${pass} checks passed.`);
