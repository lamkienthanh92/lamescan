/* global cv */
import { largestAgreeingGroup, PATCH_CENTERS, subpixelPeakOf, PATCH_MIN_PX } from './align.js';

// Chaining each tile onto the one before it means every tile's position is the sum
// of all the measurements before it. Random error in those measurements grows as a
// random walk, but any *systematic* error — a consistent fraction of a pixel
// biased one way, from peak-locking in the subpixel fit, a slight rotation in the
// stage, anisotropic pixels — grows linearly. Over a long column that shows up as
// the whole strip leaning: each row's content is locally aligned with its
// neighbour, yet the column as a whole walks sideways.
//
// The fix is to stop measuring against the previous tile and measure against the
// mosaic that has already been built. The mosaic is a fixed frame of reference
// containing every tile placed so far, so a position measured against it carries
// no accumulated error — and when a serpentine scan comes back alongside an
// earlier column, the overlap with that column is what the position is measured
// from, which closes the loop without any explicit loop-closure machinery.
//
// This reads the mosaic directly rather than maintaining a second downscaled copy
// of it: one region is extracted and scaled per tile, which costs far less than
// keeping a parallel buffer in sync through every growth and paste.

// Fraction of the frame footprint that must already be painted for a mosaic
// measurement to be worth attempting.
const MIN_PAINTED_FRAC = 0.25;

// Three coordinate spaces meet here and getting the mapping wrong produces a
// plausible-looking but steadily wrong answer, so it lives in one testable place:
//   * frame working pixels (the downscaled grayscale the patches come from),
//   * mosaic pixels (full resolution, offset by mosaic.origin),
//   * tile coordinates (what a tile's x/y is recorded in).
// A patch taken from (patchX, patchY) in the frame was found at (foundX, foundY)
// in the scaled mosaic region whose top-left is mosaic pixel (rx, ry).
export function frameOriginFromMatch({ rx, ry, originX, originY, frameScale, patchX, patchY, foundX, foundY }) {
  return {
    x: rx + (foundX - patchX) / frameScale - originX,
    y: ry + (foundY - patchY) / frameScale - originY,
  };
}

// Refines a predicted position by locating the current frame inside the mosaic.
//
// `predX/predY` is the position predicted by frame-to-frame tracking, in tile
// coordinates; `radiusPx` is how far from it to search. Returns
// { ok, x, y, used, total, correction } with x/y in the same tile coordinates.
// `minAgree` and `maxCorrectionPx` exist because this function OVERRIDES the
// frame-to-frame measurement. Two of five patches agreeing is a reasonable bar for
// accepting a measurement; it is a poor bar for overruling one. Histology is
// repetitive, so two small patches finding the same wrong offset is not a remote
// possibility — and the cost of being wrong here is not a skipped frame, it is a
// tile deposited somewhere else entirely, which then becomes the reference for
// everything after it.
//
// A refinement that moves the tile a long way is also, by definition, not a
// refinement. The search radius is not the right limit for that: the radius is how
// far to LOOK, and looking far is fine — accepting an answer from far away is not.
export function alignToMosaic(
  mosaic, frameGray, frameScale, _w, _h, predX, predY, radiusPx, patchFrac, tolPx,
  { minAgree = 3, maxCorrectionPx = null } = {}
) {
  // Each patch is searched for only in its own window of the mosaic — its
  // predicted position ± radiusPx — instead of preparing (alpha split, gray
  // conversion, resize) and searching one region the size of the whole frame plus
  // margins. Same reach, same answers; in WebAssembly that whole-region version
  // cost ~110ms per tile, which on its own was enough to stall the tick long enough
  // for a moderately fast drag to outrun tracking.
  const pw = Math.max(PATCH_MIN_PX, Math.round(frameGray.cols * patchFrac));
  const ph = Math.max(PATCH_MIN_PX, Math.round(frameGray.rows * patchFrac));
  const pwF = Math.ceil(pw / frameScale);
  const phF = Math.ceil(ph / frameScale);
  const r = Math.max(4, Math.round(radiusPx));

  const measurements = [];
  let windows = 0;
  for (const [cx, cy] of PATCH_CENTERS) {
    const tx = Math.round(cx * frameGray.cols - pw / 2);
    const ty = Math.round(cy * frameGray.rows - ph / 2);
    if (tx < 0 || ty < 0 || tx + pw > frameGray.cols || ty + ph > frameGray.rows) continue;
    // Window in full-resolution mosaic pixels around where this patch should be.
    const px = Math.round(predX + tx / frameScale) + mosaic.originX;
    const py = Math.round(predY + ty / frameScale) + mosaic.originY;
    const wx = Math.max(0, px - r);
    const wy = Math.max(0, py - r);
    const ww = Math.min(mosaic.w, px + pwF + r) - wx;
    const wh = Math.min(mosaic.h, py + phF + r) - wy;
    if (ww < pwF + 4 || wh < phF + 4) continue;

    const trash = [];
    const track = (m) => { trash.push(m); return m; };
    try {
      const roi = track(mosaic.mat.roi(new cv.Rect(wx, wy, ww, wh)));
      const chans = track(new cv.MatVector());
      cv.split(roi, chans);
      const alpha = track(chans.get(3));
      const painted = track(new cv.Mat());
      cv.threshold(alpha, painted, 128, 255, cv.THRESH_BINARY);
      // Most of the window must already be scan, or there is nothing to find the
      // patch in — at the leading edge part of the frame's footprint is empty.
      if (cv.countNonZero(painted) < ww * wh * MIN_PAINTED_FRAC) continue;
      windows++;
      // Unpainted mosaic is fully transparent. Left as black it would be a huge
      // high-contrast region for the correlation to latch onto, so it is flattened
      // to the mean of the painted pixels instead — featureless, and therefore
      // unable to produce a peak.
      const gray = track(new cv.Mat());
      cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
      const meanPainted = cv.mean(gray, painted)[0];
      const unpainted = track(new cv.Mat());
      cv.bitwise_not(painted, unpainted);
      gray.setTo(new cv.Scalar(meanPainted), unpainted);
      // Bring the window to the frame's working scale. Explicit fx/fy keeps the
      // scale exactly frameScale rather than whatever rounding the size implies.
      const small = track(new cv.Mat());
      cv.resize(gray, small, new cv.Size(0, 0), frameScale, frameScale, cv.INTER_AREA);
      if (small.cols < pw + 2 || small.rows < ph + 2) continue;
      const tpl = track(frameGray.roi(new cv.Rect(tx, ty, pw, ph)));
      const res = track(new cv.Mat());
      cv.matchTemplate(small, tpl, res, cv.TM_CCOEFF_NORMED);
      const mm = cv.minMaxLoc(res);
      if (mm.maxVal < 0.3) continue;
      const [sx, sy] = subpixelPeakOf(res, mm.maxLoc);
      // The patch sits at (tx, ty) inside the frame and was found at (sx, sy)
      // inside the scaled window whose top-left is mosaic pixel (wx, wy).
      const p = frameOriginFromMatch({
        rx: wx, ry: wy, originX: mosaic.originX, originY: mosaic.originY, frameScale,
        patchX: tx, patchY: ty, foundX: sx, foundY: sy,
      });
      measurements.push({ dx: p.x, dy: p.y, score: mm.maxVal });
    } finally {
      for (let i = trash.length - 1; i >= 0; i--) trash[i].delete();
    }
  }

  if (windows < minAgree) return { ok: false, reason: 'unpainted', used: measurements.length };
  if (measurements.length < minAgree) return { ok: false, reason: 'no-signal', used: measurements.length };
  const group = largestAgreeingGroup(measurements, tolPx);
  if (group.length < minAgree) return { ok: false, reason: 'disagree', used: measurements.length };

  const x = group.reduce((a, m) => a + m.dx, 0) / group.length;
  const y = group.reduce((a, m) => a + m.dy, 0) / group.length;
  const correction = Math.hypot(x - predX, y - predY);
  const limit = maxCorrectionPx == null ? radiusPx : maxCorrectionPx;
  if (correction > limit) return { ok: false, reason: 'implausible', correction, limit };
  return { ok: true, x, y, used: group.length, total: PATCH_CENTERS.length, correction };
}

// ---------- relocalisation after losing track ----------
//
// When tracking is lost, the position is unknown but not unknowable: the mosaic
// already contains everything scanned so far, so the current frame can simply be
// searched for in ALL of it. Requiring the operator to physically re-align the
// field with the last tile is asking them to do by eye what the software can do
// exactly — and it is genuinely hard, because the open edge of a mosaic has no
// visible landmark to aim the optical field at.
//
// Two stages. Coarse: shrink the whole mosaic and the frame by the same factor and
// correlate, which finds the rough position anywhere in the scan for the price of
// one matchTemplate on a small image. Fine: hand that candidate to alignToMosaic,
// which re-measures it at working resolution with the usual five-patch agreement.
// The fine stage is what makes a false coarse peak harmless — a wrong position
// will not survive five independent patches having to agree at it.

const COARSE_MOSAIC_MAX_DIM = 1400;
const COARSE_FRAME_MIN_SHORT = 56; // frame must stay big enough to correlate on
const COARSE_TEMPLATE_FRAC = 0.7;  // frame may hang off the edge of the scan
const COARSE_MIN_SCORE = 0.3;

// Scale to run the coarse search at, in mosaic pixels per coarse pixel.
export function coarseScaleFor(mosaic, frameScale, w, h) {
  const byMosaic = Math.min(1, COARSE_MOSAIC_MAX_DIM / Math.max(mosaic.w, mosaic.h));
  const byFrame = COARSE_FRAME_MIN_SHORT / Math.max(1, Math.min(w, h));
  return Math.min(frameScale, Math.max(byMosaic, byFrame));
}

// Grayscale, shrunk copy of the whole mosaic for the coarse search. Unpainted area
// is flattened to the mean of the painted area — left black it is a huge
// high-contrast region that the correlation would prefer over any real match.
// Cache this: it only changes when a tile is added.
export function buildCoarseMosaic(mosaic, coarse) {
  const cw = Math.max(8, Math.round(mosaic.w * coarse));
  const ch = Math.max(8, Math.round(mosaic.h * coarse));
  const chans = new cv.MatVector();
  const gray = new cv.Mat();
  const painted = new cv.Mat();
  const unpainted = new cv.Mat();
  const out = new cv.Mat();
  try {
    cv.split(mosaic.mat, chans);
    const alpha = chans.get(3);
    cv.threshold(alpha, painted, 128, 255, cv.THRESH_BINARY);
    alpha.delete();
    cv.cvtColor(mosaic.mat, gray, cv.COLOR_RGBA2GRAY);
    const mean = cv.mean(gray, painted)[0];
    cv.bitwise_not(painted, unpainted);
    gray.setTo(new cv.Scalar(mean), unpainted);
    cv.resize(gray, out, new cv.Size(cw, ch), 0, 0, cv.INTER_AREA);
    return out;
  } catch (e) {
    out.delete();
    throw e;
  } finally {
    chans.delete();
    gray.delete();
    painted.delete();
    unpainted.delete();
  }
}

// Coarse search for the current frame anywhere in the mosaic. Returns a candidate
// position in tile coordinates, to be verified by alignToMosaic.
export function relocalizeCoarse(mosaic, coarseMat, coarse, frameGray, frameScale) {
  const k = coarse / frameScale; // frameGray -> coarse scale
  const cfw = Math.max(8, Math.round(frameGray.cols * k));
  const cfh = Math.max(8, Math.round(frameGray.rows * k));
  const small = new cv.Mat();
  const res = new cv.Mat();
  let tpl = null;
  try {
    cv.resize(frameGray, small, new cv.Size(cfw, cfh), 0, 0, cv.INTER_AREA);
    const tw = Math.max(24, Math.round(cfw * COARSE_TEMPLATE_FRAC));
    const th = Math.max(24, Math.round(cfh * COARSE_TEMPLATE_FRAC));
    if (tw >= coarseMat.cols || th >= coarseMat.rows) return { ok: false, reason: 'small-mosaic' };
    const tx = Math.floor((cfw - tw) / 2);
    const ty = Math.floor((cfh - th) / 2);
    tpl = small.roi(new cv.Rect(tx, ty, tw, th));
    cv.matchTemplate(coarseMat, tpl, res, cv.TM_CCOEFF_NORMED);
    const mm = cv.minMaxLoc(res);
    if (mm.maxVal < COARSE_MIN_SCORE) return { ok: false, reason: 'no-signal', score: mm.maxVal };
    // Template sits at (tx, ty) in the coarse frame and was found at maxLoc in the
    // coarse mosaic, so the frame origin is at maxLoc - (tx, ty) there.
    return {
      ok: true,
      score: mm.maxVal,
      x: (mm.maxLoc.x - tx) / coarse - mosaic.originX,
      y: (mm.maxLoc.y - ty) / coarse - mosaic.originY,
      uncertaintyPx: Math.ceil(2 / coarse),
    };
  } finally {
    if (tpl) tpl.delete();
    small.delete();
    res.delete();
  }
}

// ---------- full-resolution refinement at tile placement ----------
//
// Tracking and alignToMosaic both measure at WORKING resolution (frames shrunk to
// ~640px). With a 2000px camera frame, one working pixel is ~3 sensor pixels, so
// the sub-pixel fit's small systematic error (peak-locking) is ~3x larger in the
// mosaic than it needs to be — and a systematic error is exactly what accumulates
// linearly along a scan into a leaning strip.
//
// This runs once per TILE (not per tick), so it can afford full resolution: a grid
// of patches from the full-res frame is located in the full-res mosaic, each
// inside a small window around the position already measured. Patches whose
// window isn't fully painted are skipped, so it uses whatever overlap exists —
// the previous tile at the leading edge, an earlier column on a serpentine return.
// The result must be agreed on by several patches and may only nudge the tile.

const REFINE_GRID = [0.22, 0.5, 0.78];

export function refineOnMosaic(mosaic, fullGray, x, y, {
  patchPx = 112, radiusPx = 6, minAgree = 3, tolPx = 1.5, minScore = 0.5, maxCorrectionPx = 6,
} = {}) {
  const w = fullGray.cols;
  const h = fullGray.rows;
  const pw = Math.min(patchPx, Math.floor(w / 4));
  const ph = Math.min(patchPx, Math.floor(h / 4));
  if (pw < 24 || ph < 24) return { ok: false, reason: 'small' };
  const r = Math.max(2, Math.round(radiusPx));
  const found = [];
  let tried = 0;
  for (const fy of REFINE_GRID) {
    for (const fx of REFINE_GRID) {
      const px = Math.round(fx * w - pw / 2);
      const py = Math.round(fy * h - ph / 2);
      // Predicted mosaic position of this patch, then a window around it.
      const mx = x + px + mosaic.originX;
      const my = y + py + mosaic.originY;
      const wx = Math.floor(mx) - r;
      const wy = Math.floor(my) - r;
      const ww = pw + 2 * r + 1;
      const wh = ph + 2 * r + 1;
      if (wx < 0 || wy < 0 || wx + ww > mosaic.w || wy + wh > mosaic.h) continue;
      const roi = mosaic.mat.roi(new cv.Rect(wx, wy, ww, wh));
      const chans = new cv.MatVector();
      const gray = new cv.Mat();
      const res = new cv.Mat();
      const tpl = fullGray.roi(new cv.Rect(px, py, pw, ph));
      try {
        cv.split(roi, chans);
        const alpha = chans.get(3);
        const minA = cv.minMaxLoc(alpha).minVal;
        alpha.delete();
        if (minA < 255) continue; // window not fully painted
        tried++;
        cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
        cv.matchTemplate(gray, tpl, res, cv.TM_CCOEFF_NORMED);
        const mm = cv.minMaxLoc(res);
        if (mm.maxVal < minScore) continue;
        if (mm.maxLoc.x <= 0 || mm.maxLoc.y <= 0 || mm.maxLoc.x >= res.cols - 1 || mm.maxLoc.y >= res.rows - 1) continue;
        const [sx, sy] = subpixelPeakOf(res, mm.maxLoc);
        found.push({
          dx: wx + sx - px - mosaic.originX, // implied frame origin, tile coords
          dy: wy + sy - py - mosaic.originY,
          score: mm.maxVal,
        });
      } finally {
        tpl.delete();
        res.delete();
        gray.delete();
        chans.delete();
        roi.delete();
      }
    }
  }
  if (found.length < minAgree) return { ok: false, reason: tried < minAgree ? 'unpainted' : 'no-signal', used: found.length, tried };
  const group = largestAgreeingGroup(found, tolPx);
  if (group.length < minAgree) return { ok: false, reason: 'disagree', used: group.length, tried };
  const rx = group.reduce((a, m) => a + m.dx, 0) / group.length;
  const ry = group.reduce((a, m) => a + m.dy, 0) / group.length;
  const correction = Math.hypot(rx - x, ry - y);
  if (correction > maxCorrectionPx) return { ok: false, reason: 'implausible', correction };
  return { ok: true, x: rx, y: ry, used: group.length, tried, correction };
}
