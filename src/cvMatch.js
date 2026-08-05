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

export function computeFeatures(mat) {
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  const orb = new cv.ORB(1500);
  const kp = new cv.KeyPointVector();
  const desc = new cv.Mat();
  const none = new cv.Mat();
  orb.detectAndCompute(gray, none, kp, desc);
  gray.delete();
  none.delete();
  orb.delete();
  return { kp, desc };
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

// Returns { ok, inliers, total, H? } where H is a flat 3x3 row-major array
// mapping points from the "new" tile's pixel space into the "prev" tile's pixel space.
export function matchTiles(kpNew, descNew, kpPrev, descPrev) {
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
    bf.delete();
    matches.delete();
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
    bf.delete();
    matches.delete();
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
  bf.delete();
  matches.delete();
  return result;
}

