/* global cv */
import { largestAgreeingGroup, PATCH_CENTERS, subpixelPeakOf } from './align.js';

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
export function alignToMosaic(mosaic, frameGray, frameScale, w, h, predX, predY, radiusPx, patchFrac, tolPx) {
  const rx0 = Math.round(predX) + mosaic.originX - radiusPx;
  const ry0 = Math.round(predY) + mosaic.originY - radiusPx;
  const rx = Math.max(0, rx0);
  const ry = Math.max(0, ry0);
  const rw = Math.min(mosaic.w, rx0 + w + radiusPx * 2) - rx;
  const rh = Math.min(mosaic.h, ry0 + h + radiusPx * 2) - ry;
  if (rw < w * 0.5 || rh < h * 0.5) return { ok: false, reason: 'edge' };

  const trash = [];
  const track = (m) => { trash.push(m); return m; };
  try {
    const roi = track(mosaic.mat.roi(new cv.Rect(rx, ry, rw, rh)));
    const chans = track(new cv.MatVector());
    cv.split(roi, chans);
    const alpha = track(chans.get(3));

    // Unpainted mosaic is fully transparent. Left as black it would be a huge
    // high-contrast region for the correlation to latch onto, so it is flattened
    // to the mean of the painted pixels instead — featureless, and therefore
    // unable to produce a peak.
    const painted = track(new cv.Mat());
    cv.threshold(alpha, painted, 128, 255, cv.THRESH_BINARY);
    const gray = track(new cv.Mat());
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
    const meanPainted = cv.mean(gray, painted)[0];
    const unpainted = track(new cv.Mat());
    cv.bitwise_not(painted, unpainted);
    gray.setTo(new cv.Scalar(meanPainted), unpainted);

    // Bring the mosaic region to the same scale the frame's patches are at.
    const sw = Math.max(8, Math.round(rw * frameScale));
    const sh = Math.max(8, Math.round(rh * frameScale));
    const small = track(new cv.Mat());
    cv.resize(gray, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
    const smallPainted = track(new cv.Mat());
    cv.resize(painted, smallPainted, new cv.Size(sw, sh), 0, 0, cv.INTER_NEAREST);

    // Enough of the frame's own footprint must already exist in the mosaic for
    // this to mean anything — at the leading edge of a scan most of it is empty.
    const fw = Math.round(w * frameScale);
    const fh = Math.round(h * frameScale);
    const fx = Math.round((Math.round(predX) + mosaic.originX - rx) * frameScale);
    const fy = Math.round((Math.round(predY) + mosaic.originY - ry) * frameScale);
    const ix = Math.max(0, fx);
    const iy = Math.max(0, fy);
    const iw = Math.min(sw, fx + fw) - ix;
    const ih = Math.min(sh, fy + fh) - iy;
    if (iw <= 0 || ih <= 0) return { ok: false, reason: 'edge' };
    const foot = track(smallPainted.roi(new cv.Rect(ix, iy, iw, ih)));
    if (cv.countNonZero(foot) < fw * fh * MIN_PAINTED_FRAC) {
      return { ok: false, reason: 'unpainted' };
    }

    const pw = Math.max(14, Math.round(frameGray.cols * patchFrac));
    const ph = Math.max(14, Math.round(frameGray.rows * patchFrac));
    if (pw >= sw || ph >= sh) return { ok: false, reason: 'edge' };

    const measurements = [];
    for (const [cx, cy] of PATCH_CENTERS) {
      const tx = Math.round(cx * frameGray.cols - pw / 2);
      const ty = Math.round(cy * frameGray.rows - ph / 2);
      if (tx < 0 || ty < 0 || tx + pw > frameGray.cols || ty + ph > frameGray.rows) continue;
      const tpl = frameGray.roi(new cv.Rect(tx, ty, pw, ph));
      const res = new cv.Mat();
      try {
        cv.matchTemplate(small, tpl, res, cv.TM_CCOEFF_NORMED);
        const mm = cv.minMaxLoc(res);
        if (mm.maxVal < 0.3) continue;
        const [sx, sy] = subpixelPeakOf(res, mm.maxLoc);
        // The patch sits at (tx, ty) inside the frame and was found at (sx, sy)
        // inside the scaled mosaic region, so the frame's origin is at
        // (sx - tx, sy - ty) there. Convert back to full mosaic pixels, then to
        // tile coordinates.
        const p = frameOriginFromMatch({
          rx, ry, originX: mosaic.originX, originY: mosaic.originY, frameScale,
          patchX: tx, patchY: ty, foundX: sx, foundY: sy,
        });
        measurements.push({ dx: p.x, dy: p.y, score: mm.maxVal });
      } finally {
        res.delete();
        tpl.delete();
      }
    }

    if (measurements.length < 2) return { ok: false, reason: 'no-signal', used: measurements.length };
    const group = largestAgreeingGroup(measurements, tolPx);
    if (group.length < 2) return { ok: false, reason: 'disagree', used: measurements.length };

    const x = group.reduce((a, m) => a + m.dx, 0) / group.length;
    const y = group.reduce((a, m) => a + m.dy, 0) / group.length;
    const correction = Math.hypot(x - predX, y - predY);
    // A measurement that disagrees with the prediction by more than the search
    // radius cannot be a refinement of it; treat it as a mismatch rather than
    // teleporting the tile.
    if (correction > radiusPx) return { ok: false, reason: 'implausible', correction };
    return { ok: true, x, y, used: group.length, total: PATCH_CENTERS.length, correction };
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i].delete();
  }
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
