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

// Removes every edge touching tile index `idx` (used when undoing the last tile,
// and when a tile is re-captured and needs its constraints rebuilt from scratch).
//
// Both endpoints must be unlinked. Clearing only adjacency[idx] leaves the
// *neighbour's* adjacency list still holding the very same edge objects — which
// then (a) makes relax() dereference a tile index that no longer exists after an
// undo, and (b) silently keeps stale constraints alive after a re-capture, so
// every re-capture piles another obsolete pull toward the tile's old position on
// top of the new one.
export function removeEdgesForTile(edges, adjacency, idx) {
  for (let i = edges.length - 1; i >= 0; i--) {
    const e = edges[i];
    if (e.a !== idx && e.b !== idx) continue;
    const other = e.a === idx ? e.b : e.a;
    const list = adjacency[other];
    if (list) {
      const j = list.indexOf(e);
      if (j >= 0) list.splice(j, 1);
    }
    edges.splice(i, 1);
  }
  adjacency[idx] = [];
}

// Drops any edge referring to a tile index that no longer exists, and rebuilds
// the adjacency index from scratch. Used after loading a session from disk (the
// persisted edge list can outlive the tiles it referenced, e.g. if the last
// action before a crash was an undo) so a stale record can never crash relax().
export function rebuildAdjacency(edges, tileCount) {
  const kept = edges.filter(
    (e) => Number.isInteger(e.a) && Number.isInteger(e.b) && e.a >= 0 && e.b >= 0 && e.a < tileCount && e.b < tileCount && e.a !== e.b
  );
  const adjacency = [];
  for (const e of kept) {
    (adjacency[e.a] ||= []).push(e);
    (adjacency[e.b] ||= []).push(e);
  }
  return { edges: kept, adjacency };
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
        const other = tiles[e.a === idx ? e.b : e.a];
        if (!other) continue; // dangling edge (shouldn't happen, but never crash the scan over it)
        const targetTheta = e.a === idx ? angleOf(other.transform) - e.dtheta : angleOf(other.transform) + e.dtheta;
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
        const other = tiles[e.a === idx ? e.b : e.a];
        if (!other) continue;
        if (e.a === idx) {
          const [ox, oy] = applyLinear(tiles[idx].transform, e.dx, e.dy);
          sumX += (other.transform[2] - ox) * e.w;
          sumY += (other.transform[5] - oy) * e.w;
        } else {
          const [ox, oy] = applyLinear(other.transform, e.dx, e.dy);
          sumX += (other.transform[2] + ox) * e.w;
          sumY += (other.transform[5] + oy) * e.w;
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
    let d = Math.hypot(t.transform[2] - t.renderedTx, t.transform[5] - t.renderedTy);
    if (t.renderedTheta !== undefined) {
      // A tile can keep the same origin yet have been rotated away from the
      // orientation it was actually painted at, so translation alone can
      // report "nothing moved" while the mosaic visibly no longer lines up.
      // Convert the angular change into its worst-case corner displacement.
      let dth = angleOf(t.transform) - t.renderedTheta;
      while (dth > Math.PI) dth -= 2 * Math.PI;
      while (dth < -Math.PI) dth += 2 * Math.PI;
      d += (Math.abs(dth) * Math.hypot(t.w || 0, t.h || 0)) / 2;
    }
    if (d > max) max = d;
  }
  return max;
}
