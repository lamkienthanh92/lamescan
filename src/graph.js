// Continuous global position+rotation refinement for the tile mosaic (a small
// 2D pose-graph solved by warm-started Gauss-Seidel, not full bundle adjustment).
//
// Each pairwise match gives a *local* observation: "from tile a's own frame,
// tile b sits at local offset (dx, dy) and is rotated by dtheta relative to a".
// Both the rotation and the (x, y) translation are treated as uncertain and
// globally optimized — a single noisy pairwise match should never get to
// permanently fix a tile's orientation, or small per-frame rotation errors
// compound linearly as a scan chains through many tiles (visible as the whole
// mosaic curling/skewing along the scan direction).
//
// Each edge has a confidence weight (inlier count from the match that produced
// it). Multiple independent observations between different tile pairs (chain
// matches AND loop-closure/anchor matches) are kept side by side rather than
// one overriding another, and relax() reconciles them.

import { angleOf, scaleOf, setLinear, applyLinear } from './matrix.js';

export function addEdge(edges, adjacency, a, b, dx, dy, dtheta, w) {
  const edge = { a, b, dx, dy, dtheta, w };
  edges.push(edge);
  (adjacency[a] ||= []).push(edge);
  (adjacency[b] ||= []).push(edge);
  return edge;
}

// Removes every edge touching tile index `idx` (used when undoing the last tile).
export function removeEdgesForTile(edges, adjacency, idx) {
  for (let i = edges.length - 1; i >= 0; i--) {
    if (edges[i].a === idx || edges[i].b === idx) edges.splice(i, 1);
  }
  adjacency[idx] = [];
}

// Runs `iterations` passes of Gauss-Seidel relaxation over tile rotation AND
// translation. `fixedIndex` (normally 0, the base tile) is never moved,
// anchoring the whole graph so it can't drift/rotate as a rigid body.
// Designed to be called with a small `iterations` count repeatedly (warm start:
// the transforms persist between calls), so the solution keeps converging over
// many ticks rather than needing one expensive full solve.
//
// Each iteration has two passes:
//   1. Rotation — each tile's angle is set to the weighted circular mean of what
//      its neighbors imply ("tile b's angle minus edge dtheta", or "tile a's
//      angle plus edge dtheta"). Scale is left as whatever it already was —
//      only orientation is being reconciled here.
//   2. Translation — same idea as before, except an edge's local offset
//      (dx, dy) is rotated/scaled through its reference tile's *current*
//      orientation before being applied, instead of treating it as a
//      frozen world-space delta. This is what keeps translation consistent
//      once rotation is no longer fixed.
export function relax(tiles, adjacency, fixedIndex, iterations) {
  for (let iter = 0; iter < iterations; iter++) {
    // Pass 1: rotation.
    for (let idx = 0; idx < tiles.length; idx++) {
      if (idx === fixedIndex) continue;
      const adj = adjacency[idx];
      if (!adj || adj.length === 0) continue;
      let sumC = 0;
      let sumS = 0;
      let sumW = 0;
      for (const e of adj) {
        const targetTheta =
          e.a === idx ? angleOf(tiles[e.b].transform) - e.dtheta : angleOf(tiles[e.a].transform) + e.dtheta;
        sumC += Math.cos(targetTheta) * e.w;
        sumS += Math.sin(targetTheta) * e.w;
        sumW += e.w;
      }
      if (sumW > 0) {
        const theta = Math.atan2(sumS, sumC);
        setLinear(tiles[idx].transform, theta, scaleOf(tiles[idx].transform));
      }
    }

    // Pass 2: translation.
    for (let idx = 0; idx < tiles.length; idx++) {
      if (idx === fixedIndex) continue;
      const adj = adjacency[idx];
      if (!adj || adj.length === 0) continue;
      let sumX = 0;
      let sumY = 0;
      let sumW = 0;
      for (const e of adj) {
        if (e.a === idx) {
          const [ox, oy] = applyLinear(tiles[idx].transform, e.dx, e.dy);
          sumX += (tiles[e.b].transform[2] - ox) * e.w;
          sumY += (tiles[e.b].transform[5] - oy) * e.w;
        } else {
          const [ox, oy] = applyLinear(tiles[e.a].transform, e.dx, e.dy);
          sumX += (tiles[e.a].transform[2] + ox) * e.w;
          sumY += (tiles[e.a].transform[5] + oy) * e.w;
        }
        sumW += e.w;
      }
      if (sumW > 0) {
        tiles[idx].transform[2] = sumX / sumW;
        tiles[idx].transform[5] = sumY / sumW;
      }
    }
  }
}

// Scans for tiles whose position has drifted from what's currently painted in
// the mosaic by more than `thresholdPx`, since relax() may have retroactively
// nudged older tiles that were already composited at their old spot.
export function maxRenderedDrift(tiles) {
  let max = 0;
  for (const t of tiles) {
    if (t.renderedTx === undefined) continue;
    const d = Math.hypot(t.transform[2] - t.renderedTx, t.transform[5] - t.renderedTy);
    if (d > max) max = d;
  }
  return max;
}
