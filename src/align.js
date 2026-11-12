/* global cv */
// Pixel-level translation tracking. One mechanism, nothing else.
//
// A slide dragged under a fixed lens only translates. So the entire alignment
// problem is: "how many pixels in x and y did the picture move since the last
// accepted frame?" That is answered directly by normalised cross-correlation of
// a patch of the previous frame against the current one — no keypoints, no
// RANSAC, no per-axis hypotheses, no consensus voting between two estimators.
//
// WHY THE PATCH MUST BE SMALL AND CENTRED
//
// A microscope camera frame contains two kinds of content: the specimen, which
// moves when you drag the slide, and fixtures of the optical path — the vignette
// ring / eyepiece halo, dust on the sensor, any overlay the camera software
// draws — which do NOT move, ever. They are fixed in camera coordinates.
//
// Those fixtures are also, typically, the highest-contrast edges in the frame.
// If they fall inside the region being correlated, the strongest match is the
// one that leaves them where they are, and the estimator confidently reports a
// displacement of zero no matter how far the slide actually travelled. The
// mosaic then never advances. A small patch taken from the middle of the frame,
// well inside the bright field, contains specimen only — which is the whole
// point of keeping it small.

// Working resolution for correlation. Large enough that one pixel of the
// downscaled image is a fraction of a real pixel after subpixel refinement,
// small enough that matchTemplate stays cheap at a few frames per second.
export const MATCH_MAX_DIM = 640;

// Converts a captured RGBA frame to the grayscale copy used for correlation.
// `scale` is the factor from original crop pixels to this copy, so shifts
// measured here can be converted back.
export function toMatchGray(mat, maxDim = MATCH_MAX_DIM) {
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  const scale = Math.min(1, maxDim / Math.max(gray.cols, gray.rows));
  if (scale >= 1) return { gray, scale: 1 };
  const small = new cv.Mat();
  cv.resize(gray, small, new cv.Size(Math.round(gray.cols * scale), Math.round(gray.rows * scale)), 0, 0, cv.INTER_AREA);
  gray.delete();
  return { gray: small, scale };
}

// Parabolic interpolation through the correlation peak and its two neighbours,
// per axis. The peak of a smooth correlation surface almost never sits exactly
// on an integer sample; without this, every step carries up to half a
// working-resolution pixel of error, and those errors accumulate along a scan.
export function subpixelPeakOf(res, loc) {
  const refine = (a, b, c) => {
    const d = a - 2 * b + c;
    if (d === 0) return 0;
    const off = (0.5 * (a - c)) / d;
    return Math.abs(off) <= 1 ? off : 0;
  };
  let ox = 0;
  let oy = 0;
  if (loc.x > 0 && loc.x < res.cols - 1) {
    ox = refine(res.floatAt(loc.y, loc.x - 1), res.floatAt(loc.y, loc.x), res.floatAt(loc.y, loc.x + 1));
  }
  if (loc.y > 0 && loc.y < res.rows - 1) {
    oy = refine(res.floatAt(loc.y - 1, loc.x), res.floatAt(loc.y, loc.x), res.floatAt(loc.y + 1, loc.x));
  }
  return [loc.x + ox, loc.y + oy];
}

// Five small patches, spread out but all kept well inside the frame. This is the
// answer to the problem that a patch large enough to be individually reliable is
// also large enough to swallow the stationary fixtures — vignette ring, sensor
// dust, software overlay — that pin the measured displacement at zero.
//
// A patch small enough to sit entirely in clean specimen is, on its own, easier
// to mismatch: less content means more places in the frame that correlate about
// as well. Measuring the same displacement from several independent small
// patches and keeping only what the majority agrees on fixes that, and it
// happens to fix the fixture problem too — a patch that landed on something
// stationary reports "didn't move" while the others report the real
// displacement, so it falls outside the agreeing group and is dropped. One
// bad patch cannot drag the result, and nothing has to be detected or
// configured for that to work.
export const PATCH_CENTERS = [
  [0.5, 0.5],
  [0.3, 0.3],
  [0.7, 0.3],
  [0.3, 0.7],
  [0.7, 0.7],
];

// Largest subset of measurements that all landed within `tolPx` of one another.
// Kept separate and pure because it is the part that decides whether a frame is
// trusted, and it is the part worth being able to test without a camera.
//
// Deliberately not a median: a median of five values where two came from patches
// sitting on stationary fixtures still sits between the two answers. Requiring
// mutual agreement instead means a wrong answer has to be *reproduced* by an
// independent patch to be believed, and two patches landing on the same wrong
// offset by chance is much less likely than one doing so.
export function largestAgreeingGroup(results, tolPx) {
  let best = [];
  for (const seed of results) {
    const g = results.filter((r) => Math.hypot(r.dx - seed.dx, r.dy - seed.dy) <= tolPx);
    if (g.length > best.length) best = g;
  }
  return best;
}

function matchOnePatch(refGray, curGray, cx, cy, pw, ph) {
  const w = refGray.cols;
  const h = refGray.rows;
  const tx = Math.round(cx * w - pw / 2);
  const ty = Math.round(cy * h - ph / 2);
  if (tx < 0 || ty < 0 || tx + pw > w || ty + ph > h) return null;
  if (pw >= curGray.cols || ph >= curGray.rows) return null;
  const tpl = refGray.roi(new cv.Rect(tx, ty, pw, ph));
  const res = new cv.Mat();
  try {
    // TM_CCOEFF_NORMED subtracts the mean of both windows, so a slow overall
    // brightness change (camera auto-exposure) doesn't move the peak and scores
    // stay comparable between frames.
    cv.matchTemplate(curGray, tpl, res, cv.TM_CCOEFF_NORMED);
    const mm = cv.minMaxLoc(res);
    const [sx, sy] = subpixelPeakOf(res, mm.maxLoc);
    // A peak hard against the edge of the search area means the true match is
    // probably outside it — the drag outran this patch's reach — so the number
    // is a floor, not a measurement.
    const atEdge =
      mm.maxLoc.x <= 0 || mm.maxLoc.y <= 0 || mm.maxLoc.x >= res.cols - 1 || mm.maxLoc.y >= res.rows - 1;
    return { score: mm.maxVal, dx: tx - sx, dy: ty - sy, atEdge };
  } finally {
    res.delete();
    tpl.delete();
  }
}

// Measures how far the picture moved between `refGray` (the last accepted frame)
// and `curGray`, both from toMatchGray. Displacement is returned in refGray
// pixels: the same detail sits at (tx, ty) in the reference and (sx, sy) in the
// current frame, so the current frame's origin is offset by (tx-sx, ty-sy).
//
// `patchFrac` sets patch size as a fraction of the frame. Because each patch is
// taken from a fixed position, the largest movement it can still locate is
// roughly the distance from that position to the far edge — so smaller patches
// reach further as well as being safer. `tolPx` is how close two patches must
// land to count as agreeing.
// A patch has to be big enough to be distinctive in absolute pixels, not just as a
// fraction. At 8% of a 444px region a patch is 36x36px — too little content to
// correlate reliably, which showed up as "1/5 patches located" over and over while
// tracking sat still. The fraction controls reach; this floor controls whether
// there is anything to match on.
export const PATCH_MIN_PX = 56;

export function estimateShift(refGray, curGray, patchFrac, { minScore = 0.4, tolPx = 4, minAgree = 2 } = {}) {
  const pw = Math.max(PATCH_MIN_PX, Math.round(refGray.cols * patchFrac));
  const ph = Math.max(PATCH_MIN_PX, Math.round(refGray.rows * patchFrac));
  const total = PATCH_CENTERS.length;
  const info = { patchPx: Math.round(pw / (refGray.cols / 100)) / 100, pw, ph, total };

  const good = [];
  let edged = 0;
  let bestScore = 0;
  for (const [cx, cy] of PATCH_CENTERS) {
    const r = matchOnePatch(refGray, curGray, cx, cy, pw, ph);
    if (!r) continue;
    if (r.score > bestScore) bestScore = r.score;
    if (r.atEdge) { edged++; continue; }
    if (r.score < minScore) continue;
    good.push(r);
  }

  if (good.length === 0) {
    return { ok: false, reason: edged >= 2 ? 'too-far' : 'no-signal', bestScore, used: 0, edged, all: [], ...info };
  }

  const group = largestAgreeingGroup(good, tolPx);
  if (group.length < minAgree) {
    return {
      ok: false, reason: edged >= 2 ? 'too-far' : 'disagree', bestScore, used: good.length, edged,
      all: good.map((r) => ({ dx: r.dx, dy: r.dy, score: r.score })), ...info,
    };
  }

  const all = good.map((r) => ({ dx: r.dx, dy: r.dy, score: r.score }));
  const dx = group.reduce((a, r) => a + r.dx, 0) / group.length;
  const dy = group.reduce((a, r) => a + r.dy, 0) / group.length;
  const score = group.reduce((a, r) => a + r.score, 0) / group.length;
  const spread = Math.max(...group.map((r) => Math.hypot(r.dx - dx, r.dy - dy)));
  return { ok: true, dx, dy, score, spread, all, used: group.length, checked: good.length, edged, ...info };
}

// Laplacian variance — the standard cheap focus measure. Higher is sharper.
// Only meaningful against a running baseline, since "sharp" depends on
// magnification and specimen, so the caller compares it to recent frames.
export function sharpnessOf(gray) {
  const lap = new cv.Mat();
  const mean = new cv.Mat();
  const stddev = new cv.Mat();
  try {
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, stddev);
    return stddev.data64F[0] * stddev.data64F[0];
  } finally {
    lap.delete();
    mean.delete();
    stddev.delete();
  }
}

// Does this image carry real detail at the pixel level, or are its pixels just big
// and soft?
//
// This is the question that matters when the only route to the image is screen
// capture, because the number of pixels tells you nothing on its own. A camera
// program fitting a 2592x1944 sensor into a 700px window has thrown away 3.7x in
// each direction; the capture is then 700px of *resampled* image, and no later step
// recovers what the resampling removed. Meanwhile the same window at 100% zoom shows
// a smaller piece of the field but every pixel is a sensor pixel.
//
// The test: halve the image and put it back. If it carried genuine per-pixel detail
// — including the sensor noise a real 1:1 image always has — that round trip destroys
// a lot of high-frequency energy and the ratio is high. If the image was already a
// smooth interpolation of something smaller, the round trip changes almost nothing
// and the ratio collapses toward zero.
//
// Heuristic, and content-dependent: featureless background scores lower than tissue.
// Useful for comparing two settings on the same field, which is exactly the use.
export function pixelDetailRatio(mat) {
  const size = Math.min(512, mat.cols, mat.rows);
  if (size < 64) return null;
  const rect = new cv.Rect(
    Math.floor((mat.cols - size) / 2),
    Math.floor((mat.rows - size) / 2),
    size, size
  );
  const roi = mat.roi(rect);
  const gray = new cv.Mat();
  const half = new cv.Mat();
  const back = new cv.Mat();
  try {
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
    const full = sharpnessOf(gray);
    if (!(full > 1e-6)) return null;
    cv.resize(gray, half, new cv.Size(Math.round(size / 2), Math.round(size / 2)), 0, 0, cv.INTER_AREA);
    cv.resize(half, back, new cv.Size(size, size), 0, 0, cv.INTER_CUBIC);
    const softened = sharpnessOf(back);
    return Math.max(0, Math.min(1, 1 - softened / full));
  } finally {
    roi.delete();
    gray.delete();
    half.delete();
    back.delete();
  }
}

// Checks whether the chosen capture region is still reaching into the dark
// vignette ring, by comparing a thin border band against the middle. This is
// the failure the small-patch design exists to avoid, and it is silent — the
// scan simply refuses to advance — so it's worth saying out loud.
export function borderIsDark(gray) {
  const w = gray.cols;
  const h = gray.rows;
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.06));
  const inner = gray.roi(new cv.Rect(band, band, w - band * 2, h - band * 2));
  const centre = cv.mean(inner)[0];
  inner.delete();
  const whole = cv.mean(gray)[0];
  // mean(whole) = (mean(inner)*areaInner + mean(border)*areaBorder) / areaTotal
  const areaTotal = w * h;
  const areaInner = (w - band * 2) * (h - band * 2);
  const areaBorder = areaTotal - areaInner;
  if (areaBorder <= 0 || centre <= 1) return false;
  const border = (whole * areaTotal - centre * areaInner) / areaBorder;
  return border < centre * 0.62;
}

// Finds the bright viewing circle inside a vignetted frame and returns a
// rectangle comfortably INSIDE it. The inset is deliberately generous: the
// halo's edge is a soft gradient many pixels wide, and a rectangle that merely
// touches the nominal boundary still contains enough of the stationary ring to
// pin the correlation at zero.
// insetFrac was 0.2, which was a mistake with real consequences: it shrank the
// CAPTURE region — the pixels that end up in the mosaic — by 40% in each direction
// to protect the detection patches from the halo. But the patches are now a small
// fraction of the region and sit near its centre, so they are already far from the
// edge. The inset only needs to keep actual halo pixels out of the saved image.
// On a 550px bright field the old value gave a 330px capture region; this gives
// ~480px, which is 2.1x the pixel count for the same slide area.
export function detectFieldRect(mat, insetFrac = 0.06) {
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  const w = gray.cols;
  const h = gray.rows;
  const data = gray.data;

  const patch = Math.max(4, Math.round(Math.min(w, h) * 0.03));
  const avgPatch = (cx, cy) => {
    let sum = 0;
    let n = 0;
    const y0 = Math.max(0, cy - patch), y1 = Math.min(h, cy + patch);
    const x0 = Math.max(0, cx - patch), x1 = Math.min(w, cx + patch);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += data[y * w + x]; n++; }
    return n ? sum / n : 0;
  };

  const centre = avgPatch(w >> 1, h >> 1);
  const corners = (avgPatch(0, 0) + avgPatch(w - 1, 0) + avgPatch(0, h - 1) + avgPatch(w - 1, h - 1)) / 4;
  if (centre - corners < 25) { gray.delete(); return null; } // not a vignetted frame
  const thresh = (centre + corners) / 2;

  const profile = (len, other, get) => {
    const out = new Float64Array(len);
    const bandStart = Math.max(0, Math.floor(other / 2 - other * 0.05));
    const bandEnd = Math.min(other, bandStart + Math.max(1, Math.round(other * 0.1)));
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let j = bandStart; j < bandEnd; j++) s += get(i, j);
      out[i] = s / (bandEnd - bandStart);
    }
    return out;
  };
  const cols = profile(w, h, (x, y) => data[y * w + x]);
  const rows = profile(h, w, (y, x) => data[y * w + x]);
  gray.delete();

  const edge = (p, fromStart) => {
    if (fromStart) { for (let i = 0; i < p.length; i++) if (p[i] > thresh) return i; return 0; }
    for (let i = p.length - 1; i >= 0; i--) if (p[i] > thresh) return i;
    return p.length - 1;
  };
  let left = edge(cols, true), right = edge(cols, false);
  let top = edge(rows, true), bottom = edge(rows, false);
  if (right - left < w * 0.3 || bottom - top < h * 0.3) return null;

  const ix = Math.round((right - left) * insetFrac);
  const iy = Math.round((bottom - top) * insetFrac);
  left += ix; right -= ix; top += iy; bottom -= iy;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// ---------- coarse-to-fine tracking ----------
//
// estimateShift above searches the WHOLE working frame for each of five patches.
// In opencv.js (WebAssembly, no threads) one matchTemplate of a 56px patch over a
// 640px frame costs ~25ms, so a single estimate is ~130ms and a tick that needs
// the previous-frame fallback is ~260ms — longer than the 200ms tick, so ticks
// were silently skipped and the effective sampling rate fell to 2–3 Hz. At that
// rate the slide moves a long way between samples, which is exactly what makes
// tracking drop out unless the operator drags slowly.
//
// The fix is the standard pyramid: find each patch roughly on a small copy of
// the frame (where a full search is cheap), then measure it precisely at working
// resolution inside a small window around that rough answer. Reach is unchanged —
// the coarse search still covers the whole frame — and the precise measurement
// and the five-patch agreement are the same as before. Cost drops ~10x.

export const COARSE_MAX_DIM = 200;
const COARSE_PATCH_MIN_PX = 20;
const COARSE_MIN_SCORE = 0.25;
const COARSE_TOL_PX = 2;

// Coarse copy of a working-resolution gray frame. `k` maps working px -> coarse px.
export function toCoarse(gray, maxDim = COARSE_MAX_DIM) {
  const k = Math.min(1, maxDim / Math.max(gray.cols, gray.rows));
  const coarse = new cv.Mat();
  cv.resize(gray, coarse, new cv.Size(Math.max(8, Math.round(gray.cols * k)), Math.max(8, Math.round(gray.rows * k))), 0, 0, cv.INTER_AREA);
  return coarse;
}

// Where each patch roughly went, from the coarse copies. Returns the agreed shift in
// WORKING pixels, or null if the coarse level can't say.
function coarseShift(refC, curC, k, patchFrac) {
  const pw = Math.max(COARSE_PATCH_MIN_PX, Math.round(refC.cols * patchFrac));
  const ph = Math.max(COARSE_PATCH_MIN_PX, Math.round(refC.rows * patchFrac));
  const found = [];
  for (const [cx, cy] of PATCH_CENTERS) {
    const r = matchOnePatch(refC, curC, cx, cy, pw, ph);
    if (!r || r.atEdge || r.score < COARSE_MIN_SCORE) continue;
    found.push(r);
  }
  if (found.length < 2) return null;
  const group = largestAgreeingGroup(found, COARSE_TOL_PX);
  if (group.length < 2) return null;
  const dx = group.reduce((a, r) => a + r.dx, 0) / group.length;
  const dy = group.reduce((a, r) => a + r.dy, 0) / group.length;
  return { dx: dx / k, dy: dy / k };
}

// Same contract and return shape as estimateShift, but `ref` and `cur` are
// { gray, coarse } pairs. Falls back to the full search when the coarse level
// finds nothing usable, so it is never less capable than estimateShift — only
// faster in the common case.
export function estimateShiftFast(ref, cur, patchFrac, { minScore = 0.4, tolPx = 4, minAgree = 2 } = {}) {
  const refGray = ref.gray;
  const curGray = cur.gray;
  const k = ref.coarse.cols / refGray.cols;
  const c = coarseShift(ref.coarse, cur.coarse, k, patchFrac);
  if (!c) return { ...estimateShift(refGray, curGray, patchFrac, { minScore, tolPx, minAgree }), path: 'full' };

  const pw = Math.max(PATCH_MIN_PX, Math.round(refGray.cols * patchFrac));
  const ph = Math.max(PATCH_MIN_PX, Math.round(refGray.rows * patchFrac));
  const total = PATCH_CENTERS.length;
  const info = { patchPx: Math.round(pw / (refGray.cols / 100)) / 100, pw, ph, total, path: 'fast' };
  // Window half-size: a couple of coarse pixels of slack, in working pixels.
  const rad = Math.ceil(2.5 / k) + 3;

  const good = [];
  let edged = 0;
  let bestScore = 0;
  for (const [cx, cy] of PATCH_CENTERS) {
    const tx = Math.round(cx * refGray.cols - pw / 2);
    const ty = Math.round(cy * refGray.rows - ph / 2);
    if (tx < 0 || ty < 0 || tx + pw > refGray.cols || ty + ph > refGray.rows) continue;
    // Predicted top-left of this patch in the current frame.
    const px = Math.round(tx - c.dx);
    const py = Math.round(ty - c.dy);
    const wx = Math.max(0, px - rad);
    const wy = Math.max(0, py - rad);
    const wr = Math.min(curGray.cols, px + pw + rad);
    const wb = Math.min(curGray.rows, py + ph + rad);
    if (wr - wx < pw + 2 || wb - wy < ph + 2) { edged++; continue; } // patch has left the frame
    const tpl = refGray.roi(new cv.Rect(tx, ty, pw, ph));
    const win = curGray.roi(new cv.Rect(wx, wy, wr - wx, wb - wy));
    const res = new cv.Mat();
    try {
      cv.matchTemplate(win, tpl, res, cv.TM_CCOEFF_NORMED);
      const mm = cv.minMaxLoc(res);
      if (mm.maxVal > bestScore) bestScore = mm.maxVal;
      // A peak on the window's edge means the coarse guess was off by more than
      // the slack — not a measurement. (An edge that is the frame's own edge is
      // the same situation as the full search's atEdge.)
      const atEdge = mm.maxLoc.x <= 0 || mm.maxLoc.y <= 0 || mm.maxLoc.x >= res.cols - 1 || mm.maxLoc.y >= res.rows - 1;
      if (atEdge) { edged++; continue; }
      if (mm.maxVal < minScore) continue;
      const [sx, sy] = subpixelPeakOf(res, mm.maxLoc);
      good.push({ score: mm.maxVal, dx: tx - (wx + sx), dy: ty - (wy + sy) });
    } finally {
      res.delete();
      win.delete();
      tpl.delete();
    }
  }

  if (good.length === 0) {
    return { ok: false, reason: edged >= 2 ? 'too-far' : 'no-signal', bestScore, used: 0, edged, all: [], ...info };
  }
  const group = largestAgreeingGroup(good, tolPx);
  const all = good.map((r) => ({ dx: r.dx, dy: r.dy, score: r.score }));
  if (group.length < minAgree) {
    return { ok: false, reason: edged >= 2 ? 'too-far' : 'disagree', bestScore, used: good.length, edged, all, ...info };
  }
  const dx = group.reduce((a, r) => a + r.dx, 0) / group.length;
  const dy = group.reduce((a, r) => a + r.dy, 0) / group.length;
  const score = group.reduce((a, r) => a + r.score, 0) / group.length;
  const spread = Math.max(...group.map((r) => Math.hypot(r.dx - dx, r.dy - dy)));
  return { ok: true, dx, dy, score, spread, all, used: group.length, checked: good.length, edged, ...info };
}
