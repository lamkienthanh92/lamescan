/* global cv */
// Wraps the OpenCV.js calls needed to align one captured tile against the previous one.
//
// Physically, a slide dragged under a fixed microscope lens only translates and
// possibly rotates slightly in-plane — there is no perspective/shear distortion
// between two consecutive fields. Fitting a full 8-DOF projective homography to
// that reality is *more* fragile: with repetitive or low-texture image content
// (common on histology/microbiology backgrounds, and on any page with repeated
// UI elements), RANSAC can lock onto a homography that satisfies a handful of
// points while warping/ghosting everything else. Estimating a constrained
// similarity transform (rotation + uniform scale + translation, 4 DOF) is much
// harder to fool and matches what's actually happening physically.
//
// Not every opencv.js build actually exposes estimateAffinePartial2D to JS —
// this is a known gap even in the official docs.opencv.org build, independent
// of whether the C++ function exists. If it's missing, every match would
// otherwise fail unconditionally with no obvious cause, so we detect what's
// actually available once at runtime and fall back gracefully.
let cachedMethod = null;
function detectMethod() {
  if (cachedMethod) return cachedMethod;
  if (typeof cv.estimateAffinePartial2D === 'function') cachedMethod = 'partial';
  else if (typeof cv.estimateAffine2D === 'function') cachedMethod = 'affine';
  else if (typeof cv.findHomography === 'function') cachedMethod = 'homography';
  else cachedMethod = 'none';
  // eslint-disable-next-line no-console
  console.info('[panorama] transform estimation method in use:', cachedMethod);
  return cachedMethod;
}

// Tries to find the bright, in-focus viewing area inside a microscope
// eyepiece/camera frame that has a dark vignette ring around it, and returns
// the largest axis-aligned rectangle that sits safely inside it — a sensible
// default crop box so the vignette itself never reaches feature detection.
//
// Deliberately simple (brightness-profile scan, not contour/circle fitting):
// microscope halos are large, low-frequency, and roughly frame-centered, so a
// coarse scan is both fast and robust to whatever noise/texture sits inside
// the true viewing circle. Returns null when the frame doesn't look vignetted
// at all (plain webcam/screen content), so nothing is auto-cropped by mistake.
export function detectVignetteRect(mat) {
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  const w = gray.cols;
  const h = gray.rows;
  const data = gray.data;

  const patch = Math.max(4, Math.round(Math.min(w, h) * 0.03));
  const avgPatch = (cx, cy) => {
    let sum = 0, n = 0;
    const y0 = Math.max(0, cy - patch), y1 = Math.min(h, cy + patch);
    const x0 = Math.max(0, cx - patch), x1 = Math.min(w, cx + patch);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += data[y * w + x]; n++; }
    return n ? sum / n : 0;
  };

  const centerAvg = avgPatch(w >> 1, h >> 1);
  const cornerAvg =
    (avgPatch(0, 0) + avgPatch(w - 1, 0) + avgPatch(0, h - 1) + avgPatch(w - 1, h - 1)) / 4;

  // No clear dark-corner / bright-center contrast → this isn't a vignetted
  // frame, so don't force a crop on it.
  if (centerAvg - cornerAvg < 25) {
    gray.delete();
    return null;
  }
  const thresh = (centerAvg + cornerAvg) / 2;

  // Brightness profile along the horizontal/vertical center bands, so a few
  // dark or bright specks inside the frame don't skew a single-pixel scan.
  const bandH = Math.max(1, Math.round(h * 0.1));
  const yStart = Math.max(0, Math.floor(h / 2 - bandH / 2));
  const yEnd = Math.min(h, yStart + bandH);
  const colProfile = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = yStart; y < yEnd; y++) s += data[y * w + x];
    colProfile[x] = s / (yEnd - yStart);
  }

  const bandW = Math.max(1, Math.round(w * 0.1));
  const xStart = Math.max(0, Math.floor(w / 2 - bandW / 2));
  const xEnd = Math.min(w, xStart + bandW);
  const rowProfile = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = xStart; x < xEnd; x++) s += data[y * w + x];
    rowProfile[y] = s / (xEnd - xStart);
  }

  const findEdge = (profile, fromStart) => {
    const n = profile.length;
    if (fromStart) {
      for (let i = 0; i < n; i++) if (profile[i] > thresh) return i;
      return 0;
    }
    for (let i = n - 1; i >= 0; i--) if (profile[i] > thresh) return i;
    return n - 1;
  };

  let left = findEdge(colProfile, true);
  let right = findEdge(colProfile, false);
  let top = findEdge(rowProfile, true);
  let bottom = findEdge(rowProfile, false);
  gray.delete();

  // Sanity check: if the detected "bright area" is tiny, the scan probably
  // got fooled by something other than a real vignette — bail rather than
  // handing back a near-empty crop.
  if (right - left < w * 0.3 || bottom - top < h * 0.3) return null;

  // Shrink inward a bit: the halo's edge is a soft gradient, not a hard line.
  const shrinkX = Math.round((right - left) * 0.04);
  const shrinkY = Math.round((bottom - top) * 0.04);
  left += shrinkX; right -= shrinkX; top += shrinkY; bottom -= shrinkY;

  return { x: left, y: top, w: right - left, h: bottom - top };
}

// Longer-side target for the downscaled grayscale copy kept for the
// independent pixel cross-correlation check (see crossCorrelateAxis below).
const CROSSCHECK_MAX_DIM = 300;

export function computeFeatures(mat) {
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  const orb = new cv.ORB(1500);
  const kp = new cv.KeyPointVector();
  const desc = new cv.Mat();
  const none = new cv.Mat();
  orb.detectAndCompute(gray, none, kp, desc);
  none.delete();
  orb.delete();

  // A small downscaled grayscale copy, kept purely so matchTiles can run an
  // independent (non-keypoint) pixel cross-correlation check — cheap to
  // store and cheap to matchTemplate on, and computed here so it costs no
  // extra image decode beyond what ORB already needed.
  const scale = CROSSCHECK_MAX_DIM / Math.max(gray.cols, gray.rows);
  const small = new cv.Mat();
  if (scale < 1) {
    cv.resize(gray, small, new cv.Size(Math.round(gray.cols * scale), Math.round(gray.rows * scale)), 0, 0, cv.INTER_AREA);
  } else {
    gray.copyTo(small);
  }
  gray.delete();
  return { kp, desc, small };
}

// Laplacian variance: a standard, cheap focus/blur metric. Higher = sharper.
// Not an absolute threshold on its own — the caller compares it against a
// running baseline from recent tiles, since "sharp" is scene/magnification
// dependent.
export function computeSharpness(mat) {
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  const lap = new cv.Mat();
  cv.Laplacian(gray, lap, cv.CV_64F);
  const mean = new cv.Mat();
  const stddev = new cv.Mat();
  cv.meanStdDev(lap, mean, stddev);
  const variance = stddev.data64F[0] * stddev.data64F[0];
  gray.delete();
  lap.delete();
  mean.delete();
  stddev.delete();
  return variance;
}

// Independent, non-ORB confirmation of an axis translation estimate:
// template-matches a strip of raw pixel intensities from the leading edge of
// the new tile against a window of the previous tile *centered on where the
// ORB estimate `t` predicts it should be* (plus a margin) — not a generic
// fixed region. Centering the search on the prediction (rather than e.g.
// always searching "the far 60% of the tile") is what makes this correct
// regardless of how much you actually dragged: a small drag has a small true
// t, and searching around that small t is what finds it; searching a fixed
// distant region would simply miss it.
// Because this is a completely different signal (pixel correlation, not
// keypoint descriptors), it isn't fooled by the exact repetitive-texture
// ambiguity that can trip up ORB in the same way — so requiring the two to
// agree is a genuine second, independent opinion on the same claim, not just
// the same idea run twice. Works on the small downscaled copy from
// computeFeatures; `origDim` (the real tile height for axis='y', width for
// axis='x') is used to convert to/from that same small-image scale.
function crossCorrelateAxis(newSmall, prevSmall, axis, t, origDim) {
  const w = newSmall.cols, h = newSmall.rows;
  const dim = axis === 'y' ? h : w;
  const scale = dim / origDim;
  const tSmall = t * scale;

  const TEMPLATE_FRAC = 0.22;
  const MARGIN_FRAC = 0.25;
  const templateLen = Math.max(6, Math.round(dim * TEMPLATE_FRAC));
  const marginPx = Math.max(templateLen, Math.round(dim * MARGIN_FRAC));

  let template, searchStart, searchLen, predictedStart;
  if (axis === 'y') {
    if (t > 0) {
      template = newSmall.roi(new cv.Rect(0, 0, w, templateLen));
      predictedStart = tSmall;
    } else {
      template = newSmall.roi(new cv.Rect(0, h - templateLen, w, templateLen));
      predictedStart = h - templateLen + tSmall;
    }
    searchStart = Math.max(0, Math.min(h - templateLen, Math.round(predictedStart - marginPx)));
    searchLen = Math.min(h - searchStart, templateLen + marginPx * 2);
  } else {
    if (t > 0) {
      template = newSmall.roi(new cv.Rect(0, 0, templateLen, h));
      predictedStart = tSmall;
    } else {
      template = newSmall.roi(new cv.Rect(w - templateLen, 0, templateLen, h));
      predictedStart = w - templateLen + tSmall;
    }
    searchStart = Math.max(0, Math.min(w - templateLen, Math.round(predictedStart - marginPx)));
    searchLen = Math.min(w - searchStart, templateLen + marginPx * 2);
  }
  if (searchLen <= templateLen) {
    template.delete();
    return null;
  }

  const searchRoi = axis === 'y' ? new cv.Rect(0, searchStart, w, searchLen) : new cv.Rect(searchStart, 0, searchLen, h);
  const search = prevSmall.roi(searchRoi);
  const result = new cv.Mat();
  cv.matchTemplate(search, template, result, cv.TM_CCOEFF_NORMED);
  const mm = cv.minMaxLoc(result);
  result.delete();
  template.delete();
  search.delete();

  const off = axis === 'y' ? mm.maxLoc.y : mm.maxLoc.x;
  const matchedStart = searchStart + off;
  const tSmallFound =
    axis === 'y'
      ? (t > 0 ? matchedStart : matchedStart - (h - templateLen))
      : (t > 0 ? matchedStart : matchedStart - (w - templateLen));
  return { t: tSmallFound / scale, score: mm.maxVal };
}

// Exhaustive (not random-sampled — the point count is capped low enough that
// this is cheap and deterministic) 1-parameter robust fit for "pure
// translation along one fixed axis, no rotation/scale": tries every point's
// own along-axis offset as a candidate translation, keeps whichever explains
// the most *other* points within `threshold` on both the along-axis residual
// and the (should-be-near-zero) perpendicular residual, then refines with
// the median over that inlier set.
//
// This is the actual fix for repetitive-texture aliasing (parallel fiber
// bundles etc.): a cluster of points mismatched onto a neighboring identical
// stripe all agree with each other under a free rotation+scale+XY model (so
// general RANSAC accepts them as a large, "confident" inlier set), but they
// do NOT agree once perpendicular displacement is required to be ~zero — so
// they're excluded from consideration here, rather than accepted and only
// corrected after the fact.
function fitAxisTranslation(pts, axis, threshold, expectedT, maxDeviation) {
  const n = pts.length;
  // Score every seed candidate's inlier support (not just track a running
  // best) — repetitive/striped texture reliably produces several distinct,
  // similarly-well-supported translation clusters: the true match, plus one
  // for each neighboring stripe it could plausibly have aliased onto, each
  // roughly a stripe-period apart. Inlier count alone can't tell these
  // clusters apart (an aliased cluster can legitimately out-vote the true
  // one on very regular texture) — but recent motion history can, since a
  // wrong-by-one-stripe offset is never close to what the last couple of
  // steps predicted, so it's used as a tie-breaker below.
  const candidates = [];
  for (let seed = 0; seed < n; seed++) {
    const [sx, sy, dx0, dy0] = pts[seed];
    const t = axis === 'x' ? dx0 - sx : dy0 - sy;
    // Hard bound, not just a preference: a candidate whose offset is wildly
    // outside where recent motion says it should be is never even entered
    // into consideration, regardless of how many points happen to agree with
    // it — this is what actually stops a distant, well-supported repeated-
    // stripe cluster from ever winning, rather than merely being disfavored.
    if (expectedT != null && maxDeviation != null && Math.abs(t - expectedT) > maxDeviation) continue;
    let inliers = 0;
    for (let i = 0; i < n; i++) {
      const [x, y, dx1, dy1] = pts[i];
      const along = axis === 'x' ? dx1 - x : dy1 - y;
      const perp = axis === 'x' ? dy1 - y : dx1 - x;
      if (Math.abs(perp) < threshold && Math.abs(along - t) < threshold) inliers++;
    }
    candidates.push({ t, inliers });
  }
  if (!candidates.length) return null;
  const maxInliers = Math.max(...candidates.map((cand) => cand.inliers));
  if (maxInliers === 0) return null;

  // Candidates within this fraction of the best-supported cluster's vote
  // count are all "plausible" fits — among those, prefer the one closest to
  // what recent motion predicted, rather than always taking the single
  // highest vote count.
  const CLOSE_ENOUGH_RATIO = 0.85;
  const pool = candidates.filter((cand) => cand.inliers >= maxInliers * CLOSE_ENOUGH_RATIO);
  const best =
    expectedT != null && pool.length > 1
      ? pool.reduce((a, b) => (Math.abs(b.t - expectedT) < Math.abs(a.t - expectedT) ? b : a))
      : pool.reduce((a, b) => (b.inliers > a.inliers ? b : a));

  const vals = [];
  for (let i = 0; i < n; i++) {
    const [x, y, dx1, dy1] = pts[i];
    const along = axis === 'x' ? dx1 - x : dy1 - y;
    const perp = axis === 'x' ? dy1 - y : dx1 - x;
    if (Math.abs(perp) < threshold && Math.abs(along - best.t) < threshold) vals.push(along);
  }
  vals.sort((a, b) => a - b);
  return { inliers: best.inliers, t: vals.length ? vals[Math.floor(vals.length / 2)] : best.t };
}

// The general (unconstrained rotation + uniform scale + translation) RANSAC
// fit — used both as the only path for non-axisLock matches, and as a
// fallback for axisLock matches when neither pure-axis hypothesis fits.
function estimateGeneralTransform(keep, kpNew, kpPrev) {
  const src = [];
  const dst = [];
  keep.forEach((m) => {
    const p1 = kpNew.get(m.queryIdx).pt;
    const p2 = kpPrev.get(m.trainIdx).pt;
    src.push(p1.x, p1.y);
    dst.push(p2.x, p2.y);
  });

  const srcMat = cv.matFromArray(keep.length, 1, cv.CV_32FC2, src);
  const dstMat = cv.matFromArray(keep.length, 1, cv.CV_32FC2, dst);
  const inlierMask = new cv.Mat();
  const method = detectMethod();

  if (method === 'none') {
    srcMat.delete();
    dstMat.delete();
    inlierMask.delete();
    return { ok: false, inliers: 0, total: keep.length, unsupported: true };
  }

  let M;
  try {
    if (method === 'partial') {
      // Rotation + uniform scale + translation only (4 DOF) — the tightest fit.
      M = cv.estimateAffinePartial2D(srcMat, dstMat, inlierMask, cv.RANSAC, 4, 3000, 0.99, 10);
    } else if (method === 'affine') {
      // Adds shear/non-uniform scale (6 DOF) — still no perspective distortion.
      M = cv.estimateAffine2D(srcMat, dstMat, inlierMask, cv.RANSAC, 4, 3000, 0.99, 10);
    } else {
      // Last resort: full projective homography (8 DOF).
      M = cv.findHomography(srcMat, dstMat, cv.RANSAC, 5, inlierMask);
    }
  } catch (e) {
    srcMat.delete();
    dstMat.delete();
    inlierMask.delete();
    return { ok: false, inliers: 0, total: keep.length };
  }

  let inliers = 0;
  for (let i = 0; i < inlierMask.rows; i++) if (inlierMask.data[i]) inliers++;
  const ratio = inliers / keep.length;

  // Require both a reasonable absolute count AND a reasonable proportion of
  // inliers before trusting the fit — a handful of inliers out of hundreds of
  // matches is usually noise, not a real alignment.
  let result;
  if (M.empty() || inliers < 15 || ratio < 0.25) {
    result = { ok: false, inliers, total: keep.length };
  } else {
    const a = Array.from(M.data64F);
    // findHomography already returns a full 3x3 matrix; the affine estimators
    // return 2x3, which we pad into the same 3x3 homogeneous form.
    const H = method === 'homography' ? a : [a[0], a[1], a[2], a[3], a[4], a[5], 0, 0, 1];
    result = { ok: true, inliers, total: keep.length, H };
  }

  M.delete();
  srcMat.delete();
  dstMat.delete();
  inlierMask.delete();
  return result;
}

// Returns { ok, inliers, total, H? } where H is a flat 3x3 row-major array
// mapping points from the "new" tile's pixel space into the "prev" tile's pixel space.
//
// `axisLock`: the caller guarantees the physical stage/slide only ever moves
// along a single axis at a time (pure X or pure Y, never diagonal, and no
// rotation) between the two frames being matched — true for consecutive-
// capture matches, but NOT for anchor/loop-closure or manual relocalization
// matches, where the two tiles can be far apart in the scan and legitimately
// offset/rotated relative to each other. When set, this fits a constrained
// "translation along one fixed axis only" model (see fitAxisTranslation
// above) — baking the axis-only assumption into which points get to vote as
// inliers in the first place, which is what actually defeats repetitive-
// texture aliasing, not just clamping the result after the fact. If neither
// axis fits well, the match is rejected outright (ok: false) rather than
// falling back to an unconstrained fit — every accepted axisLock match is
// guaranteed pure X or pure Y, no exceptions. In exchange, a frame captured
// exactly while the hand/stage is transitioning between axes may fail to
// match here and the scan will pause for it (see the caller's guess/
// "just resumed" handling) rather than silently accepting a diagonal step.
//
// `expectedDX`/`expectedDY`: the caller's best guess (typically extrapolated
// from the last one or two real steps) of how far this step should have
// moved along each axis. Used two ways: as a hard bound (candidates too far
// from it are never considered at all, see fitAxisTranslation) when
// `tileW`/`tileH` are also given, and as a tie-breaker for which axis to
// trust. On strongly repetitive texture (parallel fiber bundles etc.)
// there's often more than one plausible-looking offset a stripe-period
// apart, and inlier count alone can't distinguish the real one from an
// aliased neighbor. All optional — omit them and the fit falls back to
// plain highest-vote-count with no window, as before.
//
// `newSmall`/`prevSmall`/`tileW`/`tileH`: when all four are given, an
// accepted axis fit is additionally cross-checked against an independent,
// non-keypoint pixel correlation (see crossCorrelateAxis) — the match is
// only accepted if both agree. This is the "two independent frames must
// agree" consensus check: ORB keypoint matching and whole-strip pixel
// correlation fail in different ways, so requiring both catches mistakes
// neither alone reliably would.
// `skipCrossCheck`: when true, skips the pixel cross-correlation consensus
// step even if newSmall/prevSmall are supplied — used by callers doing their
// own multi-candidate search, so the (relatively expensive) cross-check only
// has to run once on the winning candidate afterward, not on every candidate
// during selection.
export function matchTiles(
  kpNew, descNew, kpPrev, descPrev,
  { axisLock = false, expectedDX = null, expectedDY = null, newSmall = null, prevSmall = null, tileW = null, tileH = null, skipCrossCheck = false } = {}
) {
  if (descNew.rows < 4 || descPrev.rows < 4) return { ok: false, inliers: 0, total: 0 };

  const bf = new cv.BFMatcher(cv.NORM_HAMMING, true);
  const matches = new cv.DMatchVector();
  bf.match(descNew, descPrev, matches);
  const n = matches.size();
  if (n < 8) {
    bf.delete();
    matches.delete();
    return { ok: false, inliers: 0, total: n };
  }

  const arr = [];
  for (let i = 0; i < n; i++) arr.push(matches.get(i));
  arr.sort((a, b) => a.distance - b.distance);
  // Cap how many matches we feed the estimator: keeping only the best matches
  // (rather than up to 60% of all of them) keeps obviously-bad far-distance
  // matches out of the pool RANSAC has to sift through.
  const keep = arr.slice(0, Math.min(200, Math.max(20, Math.floor(n * 0.5))));
  bf.delete();
  matches.delete();

  if (axisLock) {
    const pts = keep.map((m) => {
      const p1 = kpNew.get(m.queryIdx).pt;
      const p2 = kpPrev.get(m.trainIdx).pt;
      return [p1.x, p1.y, p2.x, p2.y];
    });
    const AXIS_THRESH_PX = 7;
    // Half the tile's own dimension is a generous window — genuine matches
    // need real overlap to work at all, so the true offset is essentially
    // never more than about half the tile size, while a repeated-stripe
    // alias is typically much further away than that.
    const maxDevX = tileW != null ? tileW * 0.65 : null;
    const maxDevY = tileH != null ? tileH * 0.65 : null;
    const rx = fitAxisTranslation(pts, 'x', AXIS_THRESH_PX, expectedDX, maxDevX);
    const ry = fitAxisTranslation(pts, 'y', AXIS_THRESH_PX, expectedDY, maxDevY);
    // Which axis to trust when BOTH hypotheses find a plausible fit. Naively
    // taking whichever has more inliers sounds reasonable, but ties (or near-
    // ties from a noisy/low-texture frame) need a tie-break rule — and
    // "highest wins, ties go to X" quietly favors X on every near-tie. Over a
    // long straight-down (pure Y) scan, that alone is enough to occasionally
    // misclassify a step as X motion and nudge the whole scan sideways one
    // small step at a time — exactly the kind of slow systematic drift that's
    // easy to miss until much later. Bias toward whichever axis recent motion
    // predicts instead, requiring a real inlier lead (not just any lead) for
    // the other axis to override it.
    let best;
    if (rx && ry) {
      const expectedAxis =
        expectedDX != null && expectedDY != null
          ? (Math.abs(expectedDY) >= Math.abs(expectedDX) ? 'y' : 'x')
          : null;
      if (!expectedAxis) {
        best = rx.inliers >= ry.inliers ? { axis: 'x', ...rx } : { axis: 'y', ...ry };
      } else {
        const SWITCH_MARGIN = 1.15; // the other axis needs >=15% more inliers to override the expected one
        best =
          expectedAxis === 'y'
            ? (rx.inliers > ry.inliers * SWITCH_MARGIN ? { axis: 'x', ...rx } : { axis: 'y', ...ry })
            : (ry.inliers > rx.inliers * SWITCH_MARGIN ? { axis: 'y', ...ry } : { axis: 'x', ...rx });
      }
    } else if (rx) {
      best = { axis: 'x', ...rx };
    } else if (ry) {
      best = { axis: 'y', ...ry };
    } else {
      best = null;
    }
    const ratio = best ? best.inliers / pts.length : 0;
    if (!best || best.inliers < 15 || ratio < 0.25) {
      return { ok: false, inliers: best ? best.inliers : 0, total: pts.length };
    }

    // Second, independent opinion — the "outer frame": pixel cross-
    // correlation on whole edge strips, not keypoints, searched around where
    // the ORB estimate above predicts (see crossCorrelateAxis). Only run
    // when the caller supplied the downscaled tile copies; skipped (not
    // rejected) otherwise so callers without them still work.
    let finalT = best.t;
    if (!skipCrossCheck && newSmall && prevSmall) {
      const origDim = best.axis === 'x' ? tileW : tileH;
      const cc = origDim ? crossCorrelateAxis(newSmall, prevSmall, best.axis, best.t, origDim) : null;
      const AGREEMENT_PX = 25;
      const MIN_SCORE = 0.18;
      if (cc && cc.score >= MIN_SCORE && Math.abs(cc.t - best.t) <= AGREEMENT_PX) {
        // Both agree — average for a touch more precision than either alone.
        finalT = (best.t + cc.t) / 2;
      } else if (cc) {
        // Both ran, but disagree — this is the actual "outer frame catches a
        // bad inner-frame match" case. Reject rather than silently keeping
        // the ORB-only answer.
        return { ok: false, inliers: best.inliers, total: pts.length, disagreement: true };
      }
      // cc === null (e.g. degenerate tile size): fall through and trust ORB alone.
    }

    const H =
      best.axis === 'x' ? [1, 0, finalT, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, 1, finalT, 0, 0, 1];
    return { ok: true, inliers: best.inliers, total: pts.length, H };
  }

  return estimateGeneralTransform(keep, kpNew, kpPrev);
}

