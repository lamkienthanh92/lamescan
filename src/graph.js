// Continuous global position refinement for the tile mosaic.
//
// Each tile's rotation/scale is trusted from its own pairwise match (physically,
// a slide translating under a fixed lens shouldn't rotate/scale between frames,
// so this is a safe simplification). Only the (x, y) translation is treated as
// uncertain and globally optimized — turning this into a small linear
// least-squares problem instead of full nonlinear bundle adjustment.
//
// Edges are pairwise translation observations: "tiles[b].pos - tiles[a].pos ≈
// (dx, dy)", each with a confidence weight (inlier count from the match that
// produced it). Multiple independent observations between different tile pairs
// (chain matches AND loop-closure/anchor matches) are kept side by side rather
// than one overriding another, and relax() reconciles them.

export function addEdge(edges, adjacency, a, b, dx, dy, w) {
  const edge = { a, b, dx, dy, w };
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

// Runs `iterations` passes of Gauss-Seidel relaxation over tile translations.
// `tiles[i].transform` is a flat 9-element row-major 3x3 matrix; only indices
// 2 and 5 (tx, ty) are read/written here — rotation/scale (indices 0,1,3,4)
// are left untouched. `fixedIndex` (normally 0, the base tile) is never moved,
// anchoring the whole graph so it can't drift/slide as a rigid body.
// Designed to be called with a small `iterations` count repeatedly (warm start:
// positions persist between calls), so the solution keeps converging over many
// ticks rather than needing one expensive full solve.
export function relax(tiles, adjacency, fixedIndex, iterations) {
  for (let iter = 0; iter < iterations; iter++) {
    for (let idx = 0; idx < tiles.length; idx++) {
      if (idx === fixedIndex) continue;
      const adj = adjacency[idx];
      if (!adj || adj.length === 0) continue;
      let sumX = 0;
      let sumY = 0;
      let sumW = 0;
      for (const e of adj) {
        if (e.a === idx) {
          sumX += (tiles[e.b].transform[2] - e.dx) * e.w;
          sumY += (tiles[e.b].transform[5] - e.dy) * e.w;
        } else {
          sumX += (tiles[e.a].transform[2] + e.dx) * e.w;
          sumY += (tiles[e.a].transform[5] + e.dy) * e.w;
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
