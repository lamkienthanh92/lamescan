/* global cv */
// Wraps the OpenCV.js calls needed to align one captured tile against the previous one.

export function computeFeatures(mat) {
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  const orb = new cv.ORB(1200);
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
  const keep = arr.slice(0, Math.max(12, Math.floor(n * 0.6)));

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
  const mask = new cv.Mat();
  let H;
  try {
    H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 5, mask);
  } catch (e) {
    srcMat.delete();
    dstMat.delete();
    mask.delete();
    bf.delete();
    matches.delete();
    return { ok: false, inliers: 0, total: n };
  }

  let inliers = 0;
  for (let i = 0; i < mask.rows; i++) if (mask.data[i]) inliers++;

  let result;
  if (H.empty() || inliers < 4) {
    result = { ok: false, inliers, total: keep.length };
  } else {
    result = { ok: true, inliers, total: keep.length, H: Array.from(H.data64F) };
  }

  H.delete();
  srcMat.delete();
  dstMat.delete();
  mask.delete();
  bf.delete();
  matches.delete();
  return result;
}
