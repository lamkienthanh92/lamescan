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
// Places every reachable tile by walking outward from the anchor along the most
// confident links available, which solves a tree exactly and instantly.
//
// This matters more than the iterative solver that follows it. Gauss-Seidel — and
// over-relaxation, and alternating sweep direction — all propagate information
// roughly one tile per sweep along a chain, so a long scan needs on the order of N²
// sweeps to converge. Measured on a 300-tile chain it was still 4600px out. A scan
// is mostly chain with a few cross-links, so solving the chain part directly and
// leaving the iteration to distribute only the loop-closure error turns the hard
// case into the easy one.
export function spanningTreeInit(n, links, anchor) {
  const placed = new Array(n).fill(false);
  const p = new Array(n).fill(null);
  p[0] = { x: anchor.x, y: anchor.y };
  placed[0] = true;
  // Highest confidence first, so the tree is built out of the best measurements.
  const ordered = [...links].sort((a, b) => b.w - a.w);
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of ordered) {
      if (placed[l.i] && !placed[l.j]) {
        p[l.j] = { x: p[l.i].x + l.dx, y: p[l.i].y + l.dy };
        placed[l.j] = true;
        changed = true;
      } else if (placed[l.j] && !placed[l.i]) {
        p[l.i] = { x: p[l.j].x - l.dx, y: p[l.j].y - l.dy };
        placed[l.i] = true;
        changed = true;
      }
    }
  }
  return { positions: p, placed };
}

// `sweeps` scales with the number of tiles because plain Gauss-Seidel propagates
// information about one tile per sweep: a fixed 400 sweeps converges a 20-tile
// chain but leaves a 300-tile one visibly short of the solution, which is exactly
// the case that needed correcting. Over-relaxation and alternating sweep direction
// both attack the same slowness — a chain is the worst case for this method, and a
// long scan is mostly chain.
export function globalSolve(positions, links, { sweeps = null, robustRounds = 3, omega = 1.8 } = {}) {
  const n = positions.length;
  let p = positions.map((q) => ({ x: q.x, y: q.y }));
  if (n === 0 || links.length === 0) return { positions: p, residual: 0, dropped: 0 };

  // Start from the exact tree solution rather than from the recorded positions:
  // the recorded ones already contain the accumulated error this is meant to
  // remove, and iterating out of them is what left long chains unconverged.
  // Tiles no link reaches keep whatever position they had.
  const tree = spanningTreeInit(n, links, p[0]);
  p = p.map((q, i) => (tree.placed[i] ? tree.positions[i] : q));

  // Index attached up front: the inner sweep runs sweeps * n * degree times, and
  // looking a link's index up by search in there would dominate everything else.
  const L = links.map((l, k) => ({ ...l, k }));
  const adj = Array.from({ length: n }, () => []);
  for (const l of L) {
    adj[l.i].push(l);
    adj[l.j].push(l);
  }
  const scale = L.map(() => 1);

  const nSweeps = sweeps === null ? Math.max(400, n * 12) : sweeps;
  const residualOf = (l) =>
    Math.hypot(p[l.j].x - p[l.i].x - l.dx, p[l.j].y - p[l.i].y - l.dy);

  for (let round = 0; round <= robustRounds; round++) {
    for (let s = 0; s < nSweeps; s++) {
      // Alternating direction: a forward-only sweep pushes corrections one way
      // along a chain, so the far end lags badly.
      const forward = s % 2 === 0;
      for (let step = 1; step < n; step++) {
        const k = forward ? step : n - step; // tile 0 is the fixed anchor
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
          // Over-relaxation: step past the immediate average, which converges far
          // faster on long chains than moving exactly onto it.
          p[k].x += omega * (sx / sw - p[k].x);
          p[k].y += omega * (sy / sw - p[k].y);
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

// Angle between the direction the stage actually moves the picture and the image
// axes, measured from the recorded steps.
//
// This is the explanation for a mosaic that leans even though the operator only
// ever moved along one axis. The camera is mounted on the eyepiece tube and its
// sensor axes are almost never square with the stage's mechanical axes — two or
// three degrees is ordinary. Dragging along stage-X then moves the picture by
// (L·cos θ, L·sin θ): at θ = 3° and a 700px step that is 37px sideways per step,
// which after twenty steps is 730px of lean.
//
// Nothing is wrong when that happens. The tiles are placed exactly where their
// content is, the content is continuous, and no amount of solving will "fix" it
// because there is nothing to fix — the scan really did travel diagonally across
// the sensor. Only the outline is skewed. Distinguishing this from genuine drift
// matters, because the two need opposite responses: drift needs more overlap and
// a global solve, tilt needs the finished image rotated once.
//
// Steps are folded into ±45° because either axis is an equally valid reference:
// an X run and a Y run on the same misaligned camera report angles 90° apart.
export function scanAxisTilt(tiles, minStep = 20) {
  const q = Math.PI / 2;
  const angles = [];
  for (let i = 1; i < tiles.length; i++) {
    const dx = tiles[i].x - tiles[i - 1].x;
    const dy = tiles[i].y - tiles[i - 1].y;
    if (Math.hypot(dx, dy) < minStep) continue;
    let a = Math.atan2(dy, dx);
    a -= q * Math.round(a / q);
    angles.push(a);
  }
  if (angles.length < 3) return null;
  const sorted = [...angles].sort((a, b) => a - b);
  const rad = sorted[Math.floor(sorted.length / 2)];
  // Median absolute deviation: a real camera tilt is the SAME on every step, so a
  // small spread means the angle is a property of the setup rather than noise.
  const dev = angles.map((a) => Math.abs(a - rad)).sort((a, b) => a - b);
  const madDeg = (dev[Math.floor(dev.length / 2)] * 180) / Math.PI;
  return { rad, deg: (rad * 180) / Math.PI, n: angles.length, madDeg };
}

// Connected components of the link graph.
//
// Fiji's optimiser does this explicitly (identifyConnectedGraphs) and keeps only the
// largest component, logging the size of each. It matters because a split graph is
// invisible in the result but fully explains it: two groups of tiles with no
// measured link between them have no defined position relative to each other, so
// whatever the recorded positions happened to be is what you get, and one group can
// sit anywhere. That is what a mosaic with a block of tiles dumped in the wrong
// place looks like.
export function connectedComponents(n, links) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (const l of links) {
    const ra = find(l.i);
    const rb = find(l.j);
    if (ra !== rb) parent[ra] = rb;
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const comps = [...groups.values()].sort((a, b) => b.length - a.length);
  return { count: comps.length, largest: comps[0] ? comps[0].length : 0, components: comps };
}

// Top `count` local maxima of a correlation surface, at least `minSep` apart.
//
// This is the mechanism Fiji has and my first version did not. Fiji's stitcher
// investigates the five highest peaks of the phase correlation and then decides
// between them by measuring the actual cross-correlation of the overlap at each
// offset, rather than trusting the tallest peak. On repetitive tissue the tallest
// peak is regularly the wrong one — a structure one row over matches slightly
// better than the true position — and taking the single argmax is exactly how a
// confident wrong constraint gets manufactured.
export function findPeaks(data, w, h, count = 5, minSep = 4) {
  const peaks = [];
  const taken = [];
  const far = (x, y) => taken.every((p) => Math.hypot(p.x - x, p.y - y) >= minSep);
  // Candidate list of local maxima, then greedily take the highest that are apart.
  const cands = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v = data[y * w + x];
      if (
        v >= data[y * w + x - 1] && v >= data[y * w + x + 1] &&
        v >= data[(y - 1) * w + x] && v >= data[(y + 1) * w + x]
      ) {
        cands.push({ x, y, v });
      }
    }
  }
  cands.sort((a, b) => b.v - a.v);
  for (const c of cands) {
    if (peaks.length >= count) break;
    if (!far(c.x, c.y)) continue;
    peaks.push(c);
    taken.push(c);
  }
  return peaks;
}

// ---------- pairwise measurement (needs OpenCV) ----------

const OPT_SCALE_MAX_DIM = 480; // working size per tile for pair measurement
// How far around the currently-recorded position to search for the true match.
//
// This was 24px, which quietly defeated the whole step. Global optimisation exists
// to correct accumulated error, and by the time two tiles from different columns
// are compared that error can be hundreds of pixels — far outside a 24px window.
// The measurement then either failed or locked onto whatever sat at the edge of
// the window, so exactly the long-range links that carry the correction were the
// ones that never survived. The search has to be wide enough to contain the error
// it is meant to find, so it scales with the tile and with how far apart in the
// capture order the two tiles are.
const SEARCH_MARGIN_FRAC = 0.22;   // of the smaller tile dimension, at working scale
const SEARCH_MARGIN_MIN = 40;
const SEARCH_MARGIN_MAX = 220;
const MIN_PAIR_SCORE = 0.35;
const PEAK_CANDIDATES = 5; // Fiji's stitcher investigates 5; same reasoning applies here

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
function measurePair(a, b, ga, gb, scale, indexGap = 1) {
  // Overlap in tile coordinates, per current positions.
  const ox0 = Math.max(a.x, b.x);
  const oy0 = Math.max(a.y, b.y);
  const ox1 = Math.min(a.x + a.w, b.x + b.w);
  const oy1 = Math.min(a.y + a.h, b.y + b.h);
  const ow = Math.floor((ox1 - ox0) * scale);
  const oh = Math.floor((oy1 - oy0) * scale);
  if (ow < 32 || oh < 32) return null;

  // Tiles captured far apart in time have had more chance to drift relative to
  // each other, so they need a wider search.
  const margin = Math.round(
    Math.min(
      SEARCH_MARGIN_MAX,
      Math.max(
        SEARCH_MARGIN_MIN,
        Math.min(ga.cols, ga.rows) * SEARCH_MARGIN_FRAC * (indexGap > 1 ? 2 : 1)
      )
    )
  );

  // Template from the middle of A's share of the overlap, inset so there is room
  // to search around it inside B.
  // The template is the shared region itself, inset only a little. The margin
  // widens the SEARCH WINDOW in B — subtracting it from the template instead
  // would shrink the template to nothing as the margin grew, leaving almost no
  // content to correlate on precisely when the search needed to be widest.
  const tw = Math.max(24, ow - 16);
  const th = Math.max(24, oh - 16);
  const ax = Math.round((ox0 - a.x) * scale) + Math.floor((ow - tw) / 2);
  const ay = Math.round((oy0 - a.y) * scale) + Math.floor((oh - th) / 2);
  if (ax < 0 || ay < 0 || ax + tw > ga.cols || ay + th > ga.rows) return null;

  const bx = Math.round((ox0 - b.x) * scale) + Math.floor((ow - tw) / 2) - margin;
  const by = Math.round((oy0 - b.y) * scale) + Math.floor((oh - th) / 2) - margin;
  const sx0 = Math.max(0, bx);
  const sy0 = Math.max(0, by);
  const sw = Math.min(gb.cols, bx + tw + margin * 2) - sx0;
  const sh = Math.min(gb.rows, by + th + margin * 2) - sy0;
  if (sw <= tw || sh <= th) return null;

  const tpl = ga.roi(new cv.Rect(ax, ay, tw, th));
  const win = gb.roi(new cv.Rect(sx0, sy0, sw, sh));
  const res = new cv.Mat();
  try {
    cv.matchTemplate(win, tpl, res, cv.TM_CCOEFF_NORMED);

    // Consider several peaks and let an independent measurement choose between
    // them, instead of trusting the tallest. The tallest peak of a correlation
    // surface over repetitive tissue is regularly not the true position.
    const peaks = findPeaks(res.data32F, res.cols, res.rows, PEAK_CANDIDATES, 4);
    if (peaks.length === 0) return null;
    let bestPeak = null;
    for (const pk of peaks) {
      if (pk.v < MIN_PAIR_SCORE * 0.6) continue; // clearly hopeless
      // Verification: how well do the two tiles actually agree if placed at this
      // offset? Measured on the whole shared region, not on the template window,
      // so it is not the same computation that produced the peak.
      const vscore = verifyOffset(a, b, ga, gb, scale, ax, ay, sx0 + pk.x, sy0 + pk.y);
      if (vscore === null) continue;
      if (!bestPeak || vscore > bestPeak.vscore) bestPeak = { pk, vscore };
    }
    if (!bestPeak || bestPeak.vscore < MIN_PAIR_SCORE) return null;
    const mm = { maxVal: bestPeak.vscore, maxLoc: { x: bestPeak.pk.x, y: bestPeak.pk.y } };
    // A peak pinned to the edge of the search window means the real match is
    // probably outside it, so the number is a bound rather than a measurement.
    // Accepting it would feed the solver a confident-looking wrong constraint,
    // which is worse than having no constraint for this pair at all.
    if (
      mm.maxLoc.x <= 0 || mm.maxLoc.y <= 0 ||
      mm.maxLoc.x >= res.cols - 1 || mm.maxLoc.y >= res.rows - 1
    ) {
      return null;
    }
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

// Normalised cross-correlation of the two tiles' shared region when the template
// found at (foundX, foundY) is taken to be the true match. Equal-sized windows make
// matchTemplate return a single value, which is exactly the correlation coefficient.
//
// Independent of the surface that produced the peak: that surface came from one
// template window, this uses everything the two tiles share under the proposed
// offset. A peak that wins on the template but loses here was matching a repeat.
function verifyOffset(a, b, ga, gb, scale, ax, ay, bx, by) {
  // Offset between the two tiles' origins, in working pixels.
  const ox = ax - bx;
  const oy = ay - by;
  // Shared region in A's pixel space under that offset.
  const x0 = Math.max(0, -ox);
  const y0 = Math.max(0, -oy);
  const x1 = Math.min(ga.cols, gb.cols - ox);
  const y1 = Math.min(ga.rows, gb.rows - oy);
  const w = Math.floor(x1 - x0);
  const h = Math.floor(y1 - y0);
  if (w < 24 || h < 24) return null;
  const ra = ga.roi(new cv.Rect(Math.floor(x0), Math.floor(y0), w, h));
  const rb = gb.roi(new cv.Rect(Math.floor(x0 + ox), Math.floor(y0 + oy), w, h));
  const out = new cv.Mat();
  const contA = new cv.Mat();
  const contB = new cv.Mat();
  try {
    ra.copyTo(contA);
    rb.copyTo(contB);
    cv.matchTemplate(contA, contB, out, cv.TM_CCOEFF_NORMED);
    return out.data32F[0];
  } catch {
    return null;
  } finally {
    ra.delete();
    rb.delete();
    out.delete();
    contA.delete();
    contB.delete();
  }
}

// Solve, then drop the single worst link and solve again, repeating while the fit
// looks like it is being held hostage by one bad measurement.
//
// This is Fiji's rule rather than mine. I had iterative re-weighting (IRLS), which
// softens every suspect link at once; Fiji removes exactly one — the match with the
// largest displacement — and redoes the whole optimisation, looping. The trigger is
// a comparison of the worst error against the average: `avg * 2.5 < max` with `max`
// above about a pixel, or an average error above 3.5px outright. The reasoning is
// that a single wrong constraint distorts the average as well as the maximum, so
// discounting proportionally leaves some of its pull in place, whereas removing it
// and re-solving tells you whether it was the culprit.
const REL_THRESHOLD = 2.5;   // max error this many times the average = one bad link
const ABS_THRESHOLD = 3.5;   // px; an average this bad means something is wrong anyway
const MIN_MAX_ERROR = 0.95;  // px; below this nothing is worth chasing

export function solveWithPruning(positions, links, { maxRemoved = null } = {}) {
  let active = links.map((l, k) => ({ ...l, k }));
  const removed = [];
  const cap = maxRemoved == null ? Math.max(3, Math.floor(links.length * 0.2)) : maxRemoved;
  let out = globalSolve(positions, active, { robustRounds: 0 });
  for (let pass = 0; pass < cap; pass++) {
    const errs = active.map((l) =>
      Math.hypot(
        out.positions[l.j].x - out.positions[l.i].x - l.dx,
        out.positions[l.j].y - out.positions[l.i].y - l.dy
      )
    );
    if (errs.length === 0) break;
    const avg = errs.reduce((s, e) => s + e, 0) / errs.length;
    let worst = 0;
    for (let i = 1; i < errs.length; i++) if (errs[i] > errs[worst]) worst = i;
    const max = errs[worst];
    const holdingHostage = avg * REL_THRESHOLD < max && max > MIN_MAX_ERROR;
    if (!holdingHostage && avg <= ABS_THRESHOLD) break;
    if (active.length <= 1) break;
    removed.push({ ...active[worst], error: max });
    active = active.filter((_, i) => i !== worst);
    out = globalSolve(positions, active, { robustRounds: 0 });
  }
  const errs = active.map((l) =>
    Math.hypot(
      out.positions[l.j].x - out.positions[l.i].x - l.dx,
      out.positions[l.j].y - out.positions[l.i].y - l.dy
    )
  );
  return {
    positions: out.positions,
    links: active,
    removed,
    avgError: errs.length ? errs.reduce((s, e) => s + e, 0) / errs.length : 0,
    maxError: errs.length ? Math.max(...errs) : 0,
  };
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
      const m = measurePair(tiles[i], tiles[j], ga.gray, gb.gray, Math.min(ga.scale, gb.scale), j - i);
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
  const solved = solveWithPruning(before, links);
  const comps = connectedComponents(tiles.length, solved.links);
  const moved = solved.positions.map((q, i) => Math.hypot(q.x - before[i].x, q.y - before[i].y));
  // Links between tiles that were NOT captured one after the other are the only
  // ones that can correct accumulated drift: a chain of consecutive links has no
  // way to know the chain as a whole has bent. If this count is near zero the
  // scan has no cross-links to solve against, and no amount of solving will
  // straighten it — the columns need to overlap each other.
  const crossLinks = solved.links.filter((l) => l.j - l.i > 1).length;
  return {
    ok: true,
    positions: solved.positions,
    pairs: pairs.length,
    links: links.length,
    crossLinks,
    beforeResidual,
    afterResidual: solved.avgError,
    maxError: solved.maxError,
    dropped: solved.removed.length,
    components: comps.count,
    largestComponent: comps.largest,
    maxMove: Math.max(...moved),
    meanMove: moved.reduce((a, b) => a + b, 0) / moved.length,
  };
}
