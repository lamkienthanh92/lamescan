// Tracking tests that run the real opencv.js (the same WebAssembly the app loads)
// on a synthetic textured slide with known sub-pixel offsets.
//
// Checks: the coarse-to-fine estimator agrees with the full search and is much
// cheaper; the windowed anchor and the full-resolution refinement land on the
// known position; and the guards (implausible correction, unpainted mosaic) hold.
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
let passed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

// public/opencv.js is a UMD bundle with the wasm inlined; load it as CommonJS.
const cv = await new Promise((resolve) => {
  const file = join(here, 'public', 'opencv.js');
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', '__dirname', '__filename', readFileSync(file, 'utf8'))(
    mod, mod.exports, createRequire(import.meta.url), dirname(file), file);
  const m = mod.exports;
  m.onRuntimeInitialized = () => {
    delete m.then; // Module is a thenable; resolving with it would loop forever
    resolve(m);
  };
});
globalThis.cv = cv;
const A = await import('./src/align.js');
const AN = await import('./src/anchor.js');
const M = await import('./src/mosaic.js');

// ---- synthetic slide ----
let seed = 99;
const R = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const SW = 2600, SH = 2600;
const slide = new cv.Mat(SH, SW, cv.CV_8UC1, new cv.Scalar(190));
for (let i = 0; i < (SW * SH) / 1500; i++) {
  const x = R() * SW, y = R() * SH, a = R() * Math.PI, L = 20 + R() * 70;
  cv.line(slide, new cv.Point(x, y), new cv.Point(x + Math.cos(a) * L, y + Math.sin(a) * L), new cv.Scalar(120 + R() * 60), 2, cv.LINE_AA);
}
for (let i = 0; i < (SW * SH) / 900; i++) {
  cv.ellipse(slide, new cv.Point(R() * SW, R() * SH), new cv.Size(3 + R() * 5, 2 + R() * 4), R() * 180, 0, 360, new cv.Scalar(60 + R() * 50), -1, cv.LINE_AA);
}
cv.GaussianBlur(slide, slide, new cv.Size(0, 0), 1.0);

const FW = 1200, FH = 900;
// Camera frame at slide position (X, Y), sub-pixel, as RGBA like the app's capture.
function frameAt(X, Y) {
  const T = cv.matFromArray(2, 3, cv.CV_64F, [1, 0, -X, 0, 1, -Y]);
  const g = new cv.Mat();
  cv.warpAffine(slide, g, T, new cv.Size(FW, FH), cv.INTER_LANCZOS4, cv.BORDER_REFLECT);
  T.delete();
  const rgba = new cv.Mat();
  cv.cvtColor(g, rgba, cv.COLOR_GRAY2RGBA);
  g.delete();
  return rgba;
}
function refOf(rgba) {
  const { gray, scale } = A.toMatchGray(rgba);
  return { gray, coarse: A.toCoarse(gray), scale };
}
const opts = { minScore: 0.32, tolPx: 6, minAgree: 3 };

// ---- coarse-to-fine vs full search ----
const f0 = frameAt(300, 300);
const r0 = refOf(f0);
let maxDiff = 0;
let fastMs = 0;
let fullMs = 0;
let allOk = true;
let fastPath = 0;
const shifts = [[37.3, 211.6], [-180.4, 95.2], [250.7, -40.1], [5.5, -330.8], [-300.2, -120.9]];
for (const [dx, dy] of shifts) {
  const f = frameAt(300 + dx, 300 + dy);
  const r = refOf(f);
  let t = performance.now();
  const a = A.estimateShiftFast(r0, r, 0.08, opts);
  fastMs += performance.now() - t;
  t = performance.now();
  const b = A.estimateShift(r0.gray, r.gray, 0.08, opts);
  fullMs += performance.now() - t;
  if (!a.ok || !b.ok) allOk = false;
  else {
    if (a.path === 'fast') fastPath++;
    const ex = a.dx / r0.scale - dx;
    const ey = a.dy / r0.scale - dy;
    maxDiff = Math.max(maxDiff, Math.hypot(ex, ey));
  }
  f.delete(); r.gray.delete(); r.coarse.delete();
}
check('coarse-to-fine locates every shift', allOk);
check('it takes the fast path, not the fallback', fastPath === shifts.length, `${fastPath}/${shifts.length}`);
check('it is within 0.5px of the true shift', maxDiff < 0.5, maxDiff.toFixed(3) + 'px');
check('it is at least 4x cheaper than the full search', fastMs * 4 < fullMs, `${fastMs.toFixed(0)}ms vs ${fullMs.toFixed(0)}ms`);

// A frame from somewhere else entirely must not be "located".
{
  const far = frameAt(1500, 1600);
  const r = refOf(far);
  const a = A.estimateShiftFast(r0, r, 0.08, opts);
  check('an unrelated frame is rejected', !a.ok, JSON.stringify({ ok: a.ok, dx: a.dx, dy: a.dy }));
  far.delete(); r.gray.delete(); r.coarse.delete();
}

// ---- mosaic: two tiles at integer positions, then locate a third frame ----
const mosaic = M.createMosaic(FW, FH);
M.paste(mosaic, f0, 0, 0);
const f1 = frameAt(300, 700); // tile 2 at (0, 400) exactly
M.growFor(mosaic, 0, 400, FW, FH);
M.paste(mosaic, f1, 0, 400);
const trueX = 2.37, trueY = 803.61;
const f2 = frameAt(300 + trueX, 300 + trueY);
const r2 = refOf(f2);
const fullGray = new cv.Mat();
cv.cvtColor(f2, fullGray, cv.COLOR_RGBA2GRAY);

{
  const radius = Math.round(Math.min(FW, FH) * 0.12);
  const t = performance.now();
  const a = AN.alignToMosaic(mosaic, r2.gray, r2.scale, FW, FH, trueX + 9, trueY - 7, radius, 0.08, 6, { minAgree: 3, maxCorrectionPx: 40 });
  const ms = performance.now() - t;
  check('anchor finds the frame from a prediction 11px off', a.ok && Math.hypot(a.x - trueX, a.y - trueY) < 1.0,
    a.ok ? `${a.x.toFixed(2)},${a.y.toFixed(2)}` : a.reason);
  check('windowed anchor is cheap', ms < 60, ms.toFixed(0) + 'ms');
  const bad = AN.alignToMosaic(mosaic, r2.gray, r2.scale, FW, FH, trueX + 70, trueY, radius, 0.08, 6, { minAgree: 3, maxCorrectionPx: 30 });
  check('a correction beyond the limit is refused, not applied', !bad.ok && bad.reason === 'implausible', JSON.stringify(bad));

  const rf = AN.refineOnMosaic(mosaic, fullGray, trueX + 2.2, trueY - 1.8, { radiusPx: 6, maxCorrectionPx: 8 });
  const err = rf.ok ? Math.hypot(rf.x - trueX, rf.y - trueY) : Infinity;
  check('full-resolution refinement lands within 0.15px', err < 0.15, rf.ok ? err.toFixed(3) + 'px' : rf.reason);
  check('refinement uses several agreeing patches', rf.ok && rf.used >= 3, rf.ok ? String(rf.used) : '');
}
{
  // Where nothing has been painted yet there is nothing to refine against.
  const rf = AN.refineOnMosaic(mosaic, fullGray, trueX + 5000, trueY, {});
  check('refinement over unpainted mosaic declines', !rf.ok);
}

console.log(`\n${passed} checks passed.` + (failed ? ` ${failed} FAILED.` : ''));
if (failed) process.exit(1);
