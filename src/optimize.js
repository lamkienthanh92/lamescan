/* global cv */
import { subpixelPeakOf } from './align.js';
import { readbackCanvas } from './canvasutil.js';

// Global position optimisation — the one thing Fiji's Grid/Collection stitching
// does that sequential tracking cannot.
//
// While scanning, a tile's position comes from measuring it against what came
// before. Even measured against the whole mosaic rather than just the previous
// tile, the decision is final the moment it is made: a tile placed 3px off stays
// 3px off, and everything measured against it afterwards inherits that.
//
// Fiji works the other way round. It measures the displacement between EVERY pair
// of overlapping tiles, treats each measurement as a soft constraint with a
// confidence, and then solves for the set of positions that satisfies all of them
// as well as possible at once. No single measurement is authoritative, so a bad
// one gets outvoted by its neighbours instead of propagating, and a scan that
// loops back on itself is forced to agree with itself.
//
// That is a weighted least-squares problem, and it is small: a few hundred tiles
// and a few hundred constraints. There is no reason it needs a server.

// ---------- pure geometry / solver (no OpenCV; unit-tested) ----------

// Every pair of tiles whose footprints overlap by at least `minFrac` of a tile.
// Sequential tracking only ever used one link per tile; the extra links — a tile
// against the row above it, against the column it is returning alongside — are
// what let the solve detect and correct drift at all.
export function findOverlappingPairs(tiles, minFrac = 0.12) {
  const pairs = [];
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i];
      const b = tiles[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox <= 0 || oy <= 0) continue;
      const frac = (ox * oy) / Math.min(a.w * a.h, b.w * b.h);
      if (frac < minFrac) continue;
      pairs.push({ i, j, frac });
    }
  }
  return pairs;
}

// Solves for positions minimising sum over links of w * ||(p_j - p_i) - d|| ^2,
// with tile 0 held fixed so the solution isn't free to slide as a whole.
//
// Gauss-Seidel rather than a matrix solve: the system is sparse and diagonally
// dominant, it converges in a few hundred cheap sweeps, and it needs no linear
// algebra dependency. `robustRounds` re-weights links by how badly they disagree
// with the current solution and solves again — so one mismeasured pair gets
// discounted instead of dragging its neighbours, which is what makes the result
// trustworthy on real data where some overlaps are featureless.
export function globalSolve(positions, links, { sweeps = 400, robustRounds = 3 } = {}) {
  const n = positions.length;
  const p = positions.map((q) => ({ x: q.x, y: q.y }));
  if (n === 0 || links.length === 0) return { positions: p, residual: 0, dropped: 0 };

  // Index attached up front: the inner sweep runs sweeps * n * degree times, and
  // looking a link's index up by search in there would dominate everything else.
  const L = links.map((l, k) => ({ ...l, k }));
  const adj = Array.from({ length: n }, () => []);
  for (const l of L) {
    adj[l.i].push(l);
    adj[l.j].push(l);
  }
  const scale = L.map(() => 1);

  const residualOf = (l) =>
    Math.hypot(p[l.j].x - p[l.i].x - l.dx, p[l.j].y - p[l.i].y - l.dy);

  for (let round = 0; round <= robustRounds; round++) {
    for (let s = 0; s < sweeps; s++) {
      for (let k = 1; k < n; k++) { // tile 0 is the fixed anchor
        let sx = 0;
        let sy = 0;
        let sw = 0;
        for (const l of adj[k]) {
          const w = l.w * scale[l.k];
          if (w <= 0) continue;
          if (l.j === k) {
            sx += (p[l.i].x + l.dx) * w;
            sy += (p[l.i].y + l.dy) * w;
          } else {
            sx += (p[l.j].x - l.dx) * w;
            sy += (p[l.j].y - l.dy) * w;
          }
          sw += w;
        }
        if (sw > 0) {
          p[k].x = sx / sw;
          p[k].y = sy / sw;
        }
      }
    }
    if (round === robustRounds) break;
    // Re-weight: a link whose residual is far above the typical one is probably a
    // mismeasurement, not evidence.
    const res = L.map(residualOf);
    const sorted = [...res].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 1;
    const cutoff = Math.max(2, med * 3);
    for (let k = 0; k < L.length; k++) {
      scale[k] = res[k] <= cutoff ? 1 : Math.max(0.02, (cutoff / res[k]) ** 2);
    }
  }

  const res = L.map(residualOf);
  const residual = res.reduce((a, b) => a + b, 0) / res.length;
  const dropped = scale.filter((v) => v < 0.5).length;
  return { positions: p, residual, dropped };
}

// ---------- pairwise measurement (needs OpenCV) ----------

const OPT_SCALE_MAX_DIM = 480; // working size per tile for pair measurement
const SEARCH_MARGIN = 24;      // px at working scale to search around the current guess
const MIN_PAIR_SCORE = 0.35;

async function grayAt(blob, maxDim) {
  const bmp = await createImageBitmap(blob);
  const c = readbackCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  const mat = cv.imread(c);
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  mat.delete();
  const scale = Math.min(1, maxDim / Math.max(gray.cols, gray.rows));
  if (scale >= 1) return { gray, scale };
  const small = new cv.Mat();
  cv.resize(gray, small, new cv.Size(Math.round(gray.cols * scale), Math.round(gray.rows * scale)), 0, 0, cv.INTER_AREA);
  gray.delete();
  return { gray: small, scale };
}

// Measures the true displacement between one pair of overlapping tiles by
// correlating their shared region, starting from the positions already recorded.
// Returns a link { i, j, dx, dy, w } in tile coordinates, or null.
function measurePair(a, b, ga, gb, scale) {
  // Overlap in tile coordinates, per current positions.
  const ox0 = Math.max(a.x, b.x);
  const oy0 = Math.max(a.y, b.y);
  const ox1 = Math.min(a.x + a.w, b.x + b.w);
  const oy1 = Math.min(a.y + a.h, b.y + b.h);
  const ow = Math.floor((ox1 - ox0) * scale);
  const oh = Math.floor((oy1 - oy0) * scale);
  if (ow < 32 || oh < 32) return null;

  // Template from the middle of A's share of the overlap, inset so there is room
  // to search around it inside B.
  const tw = Math.max(24, ow - SEARCH_MARGIN * 2);
  const th = Math.max(24, oh - SEARCH_MARGIN * 2);
  const ax = Math.round((ox0 - a.x) * scale) + Math.floor((ow - tw) / 2);
  const ay = Math.round((oy0 - a.y) * scale) + Math.floor((oh - th) / 2);
  if (ax < 0 || ay < 0 || ax + tw > ga.cols || ay + th > ga.rows) return null;

  const bx = Math.round((ox0 - b.x) * scale) + Math.floor((ow - tw) / 2) - SEARCH_MARGIN;
  const by = Math.round((oy0 - b.y) * scale) + Math.floor((oh - th) / 2) - SEARCH_MARGIN;
  const sx0 = Math.max(0, bx);
  const sy0 = Math.max(0, by);
  const sw = Math.min(gb.cols, bx + tw + SEARCH_MARGIN * 2) - sx0;
  const sh = Math.min(gb.rows, by + th + SEARCH_MARGIN * 2) - sy0;
  if (sw <= tw || sh <= th) return null;

  const tpl = ga.roi(new cv.Rect(ax, ay, tw, th));
  const win = gb.roi(new cv.Rect(sx0, sy0, sw, sh));
  const res = new cv.Mat();
  try {
    cv.matchTemplate(win, tpl, res, cv.TM_CCOEFF_NORMED);
    const mm = cv.minMaxLoc(res);
    if (mm.maxVal < MIN_PAIR_SCORE) return null;
    const [fx, fy] = subpixelPeakOf(res, mm.maxLoc);
    // The template's content sits at (ax, ay) in A and at (sx0+fx, sy0+fy) in B.
    // A point at tile-local (u, v) in A is at world a.x+u; the same point in B is
    // at world b.x + its local position. Equating gives the displacement that
    // SHOULD hold between the two tile origins.
    const dx = (ax - (sx0 + fx)) / scale;
    const dy = (ay - (sy0 + fy)) / scale;
    // Confidence: correlation peak, scaled by how much area supported it.
    const w = mm.maxVal * mm.maxVal * Math.min(1, (tw * th) / (200 * 200));
    return { dx, dy, w: Math.max(0.01, w), score: mm.maxVal };
  } finally {
    res.delete();
    win.delete();
    tpl.delete();
  }
}

// Full pass: measure every overlapping pair, then solve. `tiles` needs x, y, w, h
// and blob. Returns new positions plus statistics for reporting.
export async function optimizePositions(tiles, { minFrac = 0.12, onProgress } = {}) {
  const pairs = findOverlappingPairs(tiles, minFrac);
  if (pairs.length === 0) return { ok: false, reason: 'no-pairs' };

  // Decode lazily with a cache: pairs are generated in index order, so a small
  // cache gets a high hit rate without holding every tile in memory.
  const cache = new Map();
  const getGray = async (idx) => {
    const hit = cache.get(idx);
    if (hit) {
      cache.delete(idx);
      cache.set(idx, hit);
      return hit;
    }
    const g = await grayAt(tiles[idx].blob, OPT_SCALE_MAX_DIM);
    cache.set(idx, g);
    if (cache.size > 40) {
      const oldestKey = cache.keys().next().value;
      cache.get(oldestKey).gray.delete();
      cache.delete(oldestKey);
    }
    return g;
  };

  const links = [];
  let measured = 0;
  try {
    for (let k = 0; k < pairs.length; k++) {
      const { i, j } = pairs[k];
      const ga = await getGray(i);
      const gb = await getGray(j);
      const m = measurePair(tiles[i], tiles[j], ga.gray, gb.gray, Math.min(ga.scale, gb.scale));
      if (m) {
        links.push({ i, j, dx: m.dx, dy: m.dy, w: m.w });
        measured++;
      }
      if (onProgress && k % 5 === 0) {
        onProgress(k + 1, pairs.length, measured);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    for (const g of cache.values()) g.gray.delete();
  }

  if (links.length === 0) return { ok: false, reason: 'no-links', pairs: pairs.length };

  const before = tiles.map((t) => ({ x: t.x, y: t.y }));
  const beforeResidual =
    links.reduce((a, l) => a + Math.hypot(before[l.j].x - before[l.i].x - l.dx, before[l.j].y - before[l.i].y - l.dy), 0) /
    links.length;
  const solved = globalSolve(before, links);
  const moved = solved.positions.map((q, i) => Math.hypot(q.x - before[i].x, q.y - before[i].y));
  return {
    ok: true,
    positions: solved.positions,
    pairs: pairs.length,
    links: links.length,
    beforeResidual,
    afterResidual: solved.residual,
    dropped: solved.dropped,
    maxMove: Math.max(...moved),
    meanMove: moved.reduce((a, b) => a + b, 0) / moved.length,
  };
}
