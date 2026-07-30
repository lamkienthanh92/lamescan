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

// Returns { ok, inliers, total, H? } where H is a flat 3x3 row-major array
// (translation row padded with [0,0,1]) mapping points from the "new" tile's
// pixel space into the "prev" tile's pixel space.
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

  if (typeof cv.estimateAffinePartial2D !== 'function') {
    srcMat.delete();
    dstMat.delete();
    inlierMask.delete();
    bf.delete();
    matches.delete();
    return { ok: false, inliers: 0, total: keep.length, unsupported: true };
  }

  let M;
  try {
    // Similarity transform only: rotation + uniform scale + translation.
    M = cv.estimateAffinePartial2D(srcMat, dstMat, inlierMask, cv.RANSAC, 4, 3000, 0.99, 10);
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
    const a = Array.from(M.data64F); // [a,b,tx, c,d,ty] (2x3 row-major)
    result = { ok: true, inliers, total: keep.length, H: [a[0], a[1], a[2], a[3], a[4], a[5], 0, 0, 1] };
  }

  M.delete();
  srcMat.delete();
  dstMat.delete();
  inlierMask.delete();
  bf.delete();
  matches.delete();
  return result;
}
