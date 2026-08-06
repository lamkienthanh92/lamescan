// 3x3 row-major homogeneous matrix helpers used for panorama compositing.

export const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function matMul3(A, B) {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++)
        r[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return r;
}

export function translateM(tx, ty) {
  return [1, 0, tx, 0, 1, ty, 0, 0, 1];
}

export function applyH(M, x, y) {
  const w = M[6] * x + M[7] * y + M[8];
  return [(M[0] * x + M[1] * y + M[2]) / w, (M[3] * x + M[4] * y + M[5]) / w];
}

// -- Rotation/scale helpers for similarity transforms (M is assumed to carry
// no shear/perspective in its linear part: indices 0,1,3,4 = scale*[[cos,-sin],[sin,cos]]).

export function angleOf(M) {
  return Math.atan2(M[3], M[0]);
}

export function scaleOf(M) {
  return Math.hypot(M[0], M[3]);
}

// Rewrites just the rotation+scale part of M (indices 0,1,3,4) in place from an
// angle/scale pair, leaving translation (2,5) and the bottom row untouched.
export function setLinear(M, angle, scale) {
  const c = Math.cos(angle) * scale;
  const s = Math.sin(angle) * scale;
  M[0] = c; M[1] = -s;
  M[3] = s; M[4] = c;
}

// Applies just the linear (rotation+scale) part of M to a vector — no translation.
export function applyLinear(M, x, y) {
  return [M[0] * x + M[1] * y, M[3] * x + M[4] * y];
}

// Inverse of applyLinear: given a world-space vector, returns it expressed in
// M's own (unrotated, unscaled) local frame.
export function applyInverseLinear(M, x, y) {
  const scale2 = M[0] * M[0] + M[3] * M[3];
  if (!scale2) return [0, 0];
  return [(M[0] * x + M[3] * y) / scale2, (M[1] * x + M[4] * y) / scale2];
}

export function cornersOf(M, w, h) {
  return [applyH(M, 0, 0), applyH(M, w, 0), applyH(M, w, h), applyH(M, 0, h)];
}

export function bboxOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  pts.forEach(([x, y]) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  return { minX, minY, maxX, maxY };
}

export function bboxOverlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const iy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  const interArea = ix * iy;
  const areaA = (a.maxX - a.minX) * (a.maxY - a.minY);
  if (areaA <= 0) return 0;
  return interArea / areaA;
}

// Finds an already-placed tile (excluding the most recent `excludeCount` tiles,
// which are trivially adjacent in the capture sequence) whose world-space bounding
// box overlaps `candidateBBox` the most. Used to detect when a zigzag/raster scan
// has looped back near a previously-scanned row, so we can re-register against it
// instead of letting accumulated drift carry through.
export function findAnchorTile(tiles, candidateBBox, excludeCount, minOverlap = 0.2) {
  let best = null;
  let bestRatio = minOverlap;
  const n = tiles.length - excludeCount;
  for (let i = 0; i < n; i++) {
    const ratio = bboxOverlapRatio(candidateBBox, tiles[i].bbox);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = tiles[i];
    }
  }
  return best;
}

// Like findAnchorTile, but returns up to `maxCandidates` tiles ranked by
// overlap with `candidateBBox` instead of just the single best — used to
// match a new capture against a small pool of "wherever it's predicted to
// be" tiles rather than being locked into exactly one reference. This is
// what lets matching recover its bearings right at a scan-direction change:
// the chronologically-previous tile isn't always the geometrically-closest
// one at that moment (e.g. the start of a new zigzag row sits right next to
// the *end* of a much earlier row, not next to the tile captured a second
// ago), and searching only that one tile has no way to notice.
export function findCandidateTiles(tiles, candidateBBox, excludeIndices, maxCandidates = 4, minOverlap = 0.05) {
  const excluded = excludeIndices instanceof Set ? excludeIndices : new Set(excludeIndices || []);
  const scored = [];
  for (let i = 0; i < tiles.length; i++) {
    if (excluded.has(i)) continue;
    const ratio = bboxOverlapRatio(candidateBBox, tiles[i].bbox);
    if (ratio > minOverlap) scored.push({ index: i, tile: tiles[i], ratio });
  }
  scored.sort((a, b) => b.ratio - a.ratio);
  return scored.slice(0, maxCandidates);
}

