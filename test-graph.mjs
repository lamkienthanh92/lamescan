// Quick sanity checks for the pure-JS modules (no OpenCV needed).
// Run: node test-graph.mjs
import assert from 'node:assert/strict';
import { addEdge, removeEdgesForTile, rebuildAdjacency, relax, maxRenderedDrift } from './src/graph.js';
import { IDENT, refreshBBoxes, angleOf } from './src/matrix.js';

let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log('  ok  ' + name);
};

const mkTile = (tx, ty) => ({ transform: [1, 0, tx, 0, 1, ty, 0, 0, 1], w: 100, h: 80 });

t('removeEdgesForTile unlinks BOTH endpoints', () => {
  const edges = [];
  const adjacency = [];
  addEdge(edges, adjacency, 0, 1, 50, 0, 0, 30);
  addEdge(edges, adjacency, 1, 2, 50, 0, 0, 30);
  assert.equal(adjacency[1].length, 2);
  removeEdgesForTile(edges, adjacency, 2);
  assert.equal(edges.length, 1);
  // the old bug: adjacency[1] still held the edge pointing at the removed tile 2
  assert.equal(adjacency[1].length, 1, 'neighbour adjacency must not keep the removed edge');
  assert.equal(adjacency[2].length, 0);
});

t('relax() survives an undo (no dangling deref)', () => {
  const edges = [];
  const adjacency = [];
  const tiles = [mkTile(0, 0), mkTile(50, 0), mkTile(100, 0)];
  addEdge(edges, adjacency, 0, 1, 50, 0, 0, 30);
  addEdge(edges, adjacency, 1, 2, 50, 0, 0, 30);
  tiles.pop();
  removeEdgesForTile(edges, adjacency, 2);
  adjacency.length = tiles.length;
  relax(tiles, adjacency, 0, 5); // used to throw on tiles[2].transform
  assert.equal(tiles.length, 2);
});

t('re-capture does not accumulate stale constraints', () => {
  const edges = [];
  const adjacency = [];
  addEdge(edges, adjacency, 0, 1, 50, 0, 0, 30);
  // simulate three successive re-captures of tile 1
  for (let i = 0; i < 3; i++) {
    removeEdgesForTile(edges, adjacency, 1);
    addEdge(edges, adjacency, 0, 1, 50, 0, 0, 30);
  }
  assert.equal(edges.length, 1);
  assert.equal(adjacency[0].length, 1, 'tile 0 must not collect one stale edge per re-capture');
  assert.equal(adjacency[1].length, 1);
});

t('rebuildAdjacency drops edges referring to missing tiles', () => {
  const { edges, adjacency } = rebuildAdjacency(
    [
      { a: 0, b: 1, dx: 10, dy: 0, dtheta: 0, w: 5 },
      { a: 1, b: 9, dx: 10, dy: 0, dtheta: 0, w: 5 }, // tile 9 no longer exists
      { a: 2, b: 2, dx: 0, dy: 0, dtheta: 0, w: 5 }, // self-edge
    ],
    3
  );
  assert.equal(edges.length, 1);
  assert.equal(adjacency[9], undefined);
});

t('relax() pulls a chained tile toward its constraint', () => {
  const edges = [];
  const adjacency = [];
  const tiles = [mkTile(0, 0), mkTile(999, 0)];
  addEdge(edges, adjacency, 0, 1, 50, 0, 0, 30);
  relax(tiles, adjacency, 0, 30);
  assert.ok(Math.abs(tiles[1].transform[2] - 50) < 1e-6, 'tile 1 should settle at x=50');
  assert.equal(tiles[0].transform[2], 0, 'fixed tile must not move');
});

t('refreshBBoxes tracks the current transform', () => {
  const tiles = [mkTile(0, 0)];
  refreshBBoxes(tiles);
  assert.deepEqual([tiles[0].bbox.minX, tiles[0].bbox.maxX], [0, 100]);
  tiles[0].transform[2] = 300; // as relax() would do
  refreshBBoxes(tiles);
  assert.deepEqual([tiles[0].bbox.minX, tiles[0].bbox.maxX], [300, 400]);
});

t('maxRenderedDrift notices a rotation-only change', () => {
  const tile = mkTile(0, 0);
  tile.renderedTx = 0;
  tile.renderedTy = 0;
  tile.renderedTheta = 0;
  assert.equal(maxRenderedDrift([tile]), 0);
  // rotate ~5.7 degrees in place, translation untouched
  const a = 0.1;
  tile.transform[0] = Math.cos(a);
  tile.transform[1] = -Math.sin(a);
  tile.transform[3] = Math.sin(a);
  tile.transform[4] = Math.cos(a);
  assert.ok(Math.abs(angleOf(tile.transform) - a) < 1e-9);
  assert.ok(maxRenderedDrift([tile]) > 5, 'rotation must register as drift so the mosaic gets repainted');
});

t('IDENT is not mutated by the helpers', () => {
  assert.deepEqual(IDENT, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

console.log(`\n${pass} checks passed.`);
