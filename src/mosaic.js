/* global cv */
// The mosaic is a single RGBA Mat plus an origin offset. Because tiles only ever
// translate, a tile is pasted with a plain block copy at an integer offset —
// there is no warp, no interpolation, and therefore no resampling blur: every
// pixel in the output is a pixel that came off the camera, unmodified, at the
// (x, y) the tracker put it at. That is the whole reason to keep the transform
// model as translation-only.

// Browsers cap canvas size (roughly 16k per side, and a total area limit well
// below what a full slide scan reaches). Past the cap a canvas renders blank
// rather than erroring, so the on-screen view is scaled down when it has to be
// while the Mat keeps full resolution.
export const DISPLAY_MAX_DIM = 8192;
export const DISPLAY_MAX_AREA = 40e6;
export const EXPORT_MAX_DIM = 16000;
export const EXPORT_MAX_AREA = 200e6;
// Grow in chunks: each growth reallocates and copies the whole Mat, so growing
// once every several tiles beats growing a few hundred pixels every tile.
import { readbackCanvas } from './canvasutil.js';

const GROW_CHUNK = 1024;
const INIT_PAD = 32;

export function fitScale(w, h, maxDim, maxArea) {
  if (!w || !h) return 1;
  return Math.min(1, maxDim / Math.max(w, h), Math.sqrt(maxArea / (w * h)));
}

export function createMosaic(tileW, tileH) {
  const w = tileW + INIT_PAD * 2;
  const h = tileH + INIT_PAD * 2;
  return {
    mat: new cv.Mat(h, w, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 0)),
    w,
    h,
    originX: INIT_PAD,
    originY: INIT_PAD,
  };
}

export function freeMosaic(m) {
  if (m && m.mat) {
    m.mat.delete();
    m.mat = null;
  }
}

// Ensures a tile at world (x, y) fits. Returns how much was added on the left
// and top, so a caller can translate what it has already drawn instead of
// redrawing everything.
export function growFor(m, x, y, tileW, tileH) {
  const minX = Math.round(x) + m.originX;
  const minY = Math.round(y) + m.originY;
  let gl = Math.max(0, -minX);
  let gt = Math.max(0, -minY);
  let gr = Math.max(0, minX + tileW - m.w);
  let gb = Math.max(0, minY + tileH - m.h);
  if (!gl && !gt && !gr && !gb) return null;
  if (gl) gl += GROW_CHUNK;
  if (gt) gt += GROW_CHUNK;
  if (gr) gr += GROW_CHUNK;
  if (gb) gb += GROW_CHUNK;

  const nw = m.w + gl + gr;
  const nh = m.h + gt + gb;
  const next = new cv.Mat(nh, nw, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 0));
  const roi = next.roi(new cv.Rect(gl, gt, m.w, m.h));
  m.mat.copyTo(roi);
  roi.delete();
  m.mat.delete();
  m.mat = next;
  m.originX += gl;
  m.originY += gt;
  m.w = nw;
  m.h = nh;
  return { growLeft: gl, growTop: gt };
}

// Pastes a frame at an integer offset. Newest content wins in the overlap: with
// translation-only alignment the two copies of the overlap are the same pixels
// to within the tracker's accuracy, so there is nothing to gain from blending
// them and something to lose — blending two slightly-offset copies of the same
// structures is what produces the doubled, smeared look at tile boundaries.
// Returns the rectangle written, in mosaic coordinates.
export function paste(m, mat, x, y) {
  const rx = Math.round(x) + m.originX;
  const ry = Math.round(y) + m.originY;
  const sx = Math.max(0, -rx);
  const sy = Math.max(0, -ry);
  const dw = Math.min(mat.cols - sx, m.w - Math.max(0, rx));
  const dh = Math.min(mat.rows - sy, m.h - Math.max(0, ry));
  if (dw <= 0 || dh <= 0) return null;
  const src = mat.roi(new cv.Rect(sx, sy, dw, dh));
  const dst = m.mat.roi(new cv.Rect(Math.max(0, rx), Math.max(0, ry), dw, dh));
  src.copyTo(dst);
  src.delete();
  dst.delete();
  return { x: Math.max(0, rx), y: Math.max(0, ry), width: dw, height: dh };
}

// ---- display ----

export function paintFull(m, canvas) {
  if (!canvas || !m || !m.mat) return 1;
  const scale = fitScale(m.w, m.h, DISPLAY_MAX_DIM, DISPLAY_MAX_AREA);
  if (scale < 1) {
    const small = new cv.Mat();
    cv.resize(m.mat, small, new cv.Size(Math.max(1, Math.round(m.w * scale)), Math.max(1, Math.round(m.h * scale))), 0, 0, cv.INTER_AREA);
    cv.imshow(canvas, small);
    small.delete();
  } else {
    cv.imshow(canvas, m.mat);
  }
  return scale;
}

// Redraws only the rectangle that changed. cv.imshow converts every pixel of
// whatever Mat it's given, so handing it the entire mosaic on every capture
// makes per-tile cost grow with total scan area.
// Reused across calls: allocating a canvas per repaint is needless GC churn on a
// path that runs several times a second.
let regionCanvas = null;

export function paintRegion(m, canvas, rect, scale) {
  if (!canvas || !m || !m.mat || !rect || rect.width <= 0 || rect.height <= 0) return false;
  if (canvas.width !== Math.max(1, Math.round(m.w * scale)) || canvas.height !== Math.max(1, Math.round(m.h * scale))) {
    return false; // canvas isn't sized for this mosaic yet — caller should paintFull
  }
  const roi = m.mat.roi(new cv.Rect(rect.x, rect.y, rect.width, rect.height));
  const cont = new cv.Mat();
  roi.copyTo(cont); // an ROI shares its parent's stride, which imshow would misread
  roi.delete();
  if (!regionCanvas) regionCanvas = readbackCanvas(); // cv.imshow writes, drawImage reads
  const tmp = regionCanvas;
  cv.imshow(tmp, cont);
  cont.delete();
  const ctx = canvas.getContext('2d');
  const dx = Math.floor(rect.x * scale);
  const dy = Math.floor(rect.y * scale);
  const dw = Math.max(1, Math.ceil(rect.width * scale));
  const dh = Math.max(1, Math.ceil(rect.height * scale));
  ctx.clearRect(dx, dy, dw, dh);
  ctx.drawImage(tmp, 0, 0, rect.width, rect.height, dx, dy, dw, dh);
  return true;
}

// After the mosaic grew, translate what's on the canvas instead of re-converting
// the whole Mat. Setting canvas.width wipes it, hence the copy aside.
export function shiftDisplay(m, canvas, growLeft, growTop, scale) {
  if (!canvas) return;
  const nw = Math.max(1, Math.round(m.w * scale));
  const nh = Math.max(1, Math.round(m.h * scale));
  let keep = null;
  if (canvas.width > 1 && canvas.height > 1) {
    keep = document.createElement('canvas');
    keep.width = canvas.width;
    keep.height = canvas.height;
    keep.getContext('2d').drawImage(canvas, 0, 0);
  }
  canvas.width = nw;
  canvas.height = nh;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, nw, nh);
  if (keep) ctx.drawImage(keep, Math.round(growLeft * scale), Math.round(growTop * scale));
}

// Renders the mosaic to an offscreen canvas for PNG export, at full resolution
// unless it exceeds what a canvas can hold. Returns { canvas, scale }.
export function renderForExport(m) {
  const scale = fitScale(m.w, m.h, EXPORT_MAX_DIM, EXPORT_MAX_AREA);
  const canvas = document.createElement('canvas');
  if (scale < 1) {
    const small = new cv.Mat();
    cv.resize(m.mat, small, new cv.Size(Math.max(1, Math.round(m.w * scale)), Math.max(1, Math.round(m.h * scale))), 0, 0, cv.INTER_AREA);
    cv.imshow(canvas, small);
    small.delete();
  } else {
    cv.imshow(canvas, m.mat);
  }
  return { canvas, scale };
}
