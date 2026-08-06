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
export function estimateShift(refGray, curGray, patchFrac, { minScore = 0.4, tolPx = 4, minAgree = 2 } = {}) {
  const pw = Math.max(14, Math.round(refGray.cols * patchFrac));
  const ph = Math.max(14, Math.round(refGray.rows * patchFrac));
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
export function detectFieldRect(mat, insetFrac = 0.2) {
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
