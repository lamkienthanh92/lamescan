/* global cv */
import { useState, useRef, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import './App.css';
import { toMatchGray, estimateShift, sharpnessOf, borderIsDark, detectFieldRect, PATCH_CENTERS } from './align.js';
import * as M from './mosaic.js';
import { alignToMosaic, relocalizeCoarse, buildCoarseMosaic, coarseScaleFor } from './anchor.js';
import { fuseMosaic, FUSION_METHODS, medianSharpnessOf, tileQuality } from './fuse.js';
import { optimizePositions } from './optimize.js';
import { drawMinimap, pipSupport, openDocumentPiP } from './minimap.js';
import * as db from './db.js';
import { readbackCanvas } from './canvasutil.js';

const TICK_MS = 200;          // how often a frame is sampled
const MIN_SCORE = 0.32;       // a single patch scoring below this isn't a measurement
const LOST_AFTER = 4;         // consecutive unlocated frames before saying so plainly
// Search radius for the mosaic measurement, as a fraction of the frame. It only
// has to cover the error that has crept in since the last tile, so it can stay
// small — which also keeps the extracted region, and the cost, small.
const ANCHOR_RADIUS_FRAC = 0.12;
const ANCHOR_TOL_PX = 6;
const AGREE_TOL_PX = 6;       // how close two patches must land to count as agreeing
const MIN_AGREE = 2;          // patches that must agree before a frame is accepted
const MIN_STEP_PX = 12;       // don't record a tile until the picture has actually moved
const STEP_FRAC = 0.08;       // ...or this fraction of the frame, whichever is larger
// Patch size as a fraction of the capture region. Deliberately small: the point
// of the patch is to contain specimen and nothing else, and anything large enough
// to be individually convincing is large enough to reach the stationary fixtures
// (halo, dust, overlay) that make the tracker report zero movement.
const PATCH_MIN = 0.04;
const PATCH_MAX = 0.18;
const PATCH_DEFAULT = 0.08;
const BLUR_HISTORY = 30;
const BLUR_MIN_SAMPLES = 5;
const BLUR_RATIO = 0.4;
const DIAG_SIZE = 16;
const CV_TIMEOUT_MS = 25000;

function fmt(n) {
  return (n >= 0 ? '+' : '') + Math.round(n);
}

// Maps the letterboxed video content area inside its container, so drags on the
// preview convert to native video pixels.
function videoRect(container, video) {
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return { x: 0, y: 0, w: cw, h: ch, scale: 1 };
  const scale = Math.min(cw / vw, ch / vh);
  return { x: (cw - vw * scale) / 2, y: (ch - vh * scale) / 2, w: vw * scale, h: vh * scale, scale };
}

function Thumb({ blob }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img src={url} alt="" className="thumb" /> : <div className="thumb" />;
}

export default function App() {
  const [cvReady, setCvReady] = useState(false);
  const [cvFailed, setCvFailed] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [running, setRunning] = useState(false);
  const [tileCount, setTileCount] = useState(0);
  const [dims, setDims] = useState({ w: 0, h: 0, scale: 1 });
  const [status, setStatus] = useState({ text: 'Chưa bắt đầu.', kind: 'idle' });
  const [cropBox, setCropBox] = useState(null);
  const [dragRect, setDragRect] = useState(null);
  const [patchFrac, setPatchFrac] = useState(PATCH_DEFAULT);
  const [diag, setDiag] = useState([]);
  const [blurry, setBlurry] = useState(0);
  const [resume, setResume] = useState(null);
  const [borderWarn, setBorderWarn] = useState(false);
  const [busyLabel, setBusyLabel] = useState(null);
  const [showTiles, setShowTiles] = useState(false);
  const [patchPx, setPatchPx] = useState(0);
  const [lost, setLost] = useState(false);
  const [lastRect, setLastRect] = useState(null); // last tile, marked on the mosaic view
  const [cover, setCover] = useState(null);       // { onceFrac } from the minimap
  const [pipOn, setPipOn] = useState(false);
  const [showCov, setShowCov] = useState(true);
  const showCovRef = useRef(true);
  const [anchor, setAnchor] = useState(true);
  const [fusion, setFusion] = useState('best');
  const [excluded, setExcluded] = useState(() => new Set());
  const excludedRef = useRef(new Set());
  const [fused, setFused] = useState(null); // which method the current mosaic shows
  const [optStats, setOptStats] = useState(null);
  const anchorRef = useRef(true);

  const videoRef = useRef(null);
  const previewRef = useRef(null);
  const canvasRef = useRef(null);
  const workRef = useRef(readbackCanvas()); // cv.imread reads this back every tick
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const miniRef = useRef(null);      // sidebar overview canvas (React-owned)
  // The floating window gets its OWN plain canvas, created imperatively.
  // Re-parenting the sidebar canvas into the other document is what broke the app:
  // React still had that node recorded as a child of its original parent, so the
  // next render called insertBefore against a node that was no longer there
  // ("The node before which the new node is to be inserted is not a child of this
  // node"), which killed the whole tree — the UI froze and stitching stopped.
  // A React-rendered node must never be moved out from under React; drawing the
  // same picture into a second canvas costs nothing and keeps ownership clean.
  const pipCanvasRef = useRef(null);
  const pipRef = useRef(null);
  const pipVideoRef = useRef(null);
  const cropRef = useRef(null);
  const dragStart = useRef(null);
  const patchRef = useRef(PATCH_DEFAULT);
  useEffect(() => { patchRef.current = patchFrac; }, [patchFrac]);
  useEffect(() => { anchorRef.current = anchor; }, [anchor]);
  useEffect(() => { excludedRef.current = excluded; }, [excluded]);
  useEffect(() => { showCovRef.current = showCov; }, [showCov]);

  const S = useRef({
    mosaic: null,
    scale: 1,          // mosaic px -> display canvas px
    tiles: [],         // { x, y, w, h, blob, sharpness, blurry, capturedAt }
    // TWO reference frames, not one.
    //
    // refTile is the last frame that actually became a tile — the accurate
    // anchor, because measuring against it involves no accumulation.
    // refPrev is simply the previous frame, accepted or not.
    //
    // With only refTile, a displacement larger than a patch's reach makes every
    // patch peak at the edge of its search area, the frame is discarded, and
    // because the reference only updates when a tile is accepted, THE REFERENCE
    // NEVER MOVES. The scan then sits still permanently — not until the next
    // frame, but until the slide is dragged back into overlap with a tile placed
    // however long ago. A single jolt past the reach ends the session, and
    // reversing an axis (mechanical backlash, a knock as you change hands) is
    // exactly where that jolt happens.
    //
    // refPrev is at most one tick old, so falling back to it means a lost lock
    // costs one frame instead of the rest of the scan.
    refTile: null,     // { gray, scale, x, y }
    refPrev: null,     // { gray, scale, x, y }
    coarse: null,      // { mat, scale } shrunk mosaic, for relocalising when lost
    busy: false,
    fails: 0,
    blurHistory: [],
    dbOwned: false,
    checkedBorder: false,
  });
  const ui = useRef({ capturing: false });
  useEffect(() => { ui.current.capturing = capturing; }, [capturing]);

  // Redrawn on every mosaic change. Cheap: it blits the already-scaled display
  // canvas down rather than touching the mosaic Mat again.
  const refreshMinimap = useCallback(() => {
    const s = S.current;
    if (!s.mosaic || (!miniRef.current && !pipCanvasRef.current)) return;
    const last = s.tiles.length ? s.tiles[s.tiles.length - 1] : null;
    const opts = {
      sourceCanvas: canvasRef.current,
      lastRect: last ? { x: last.x, y: last.y, w: last.w, h: last.h } : null,
      excluded: excludedRef.current,
      showCoverage: showCovRef.current,
    };
    const r = drawMinimap(miniRef.current, s.mosaic, s.tiles, opts);
    if (pipCanvasRef.current) drawMinimap(pipCanvasRef.current, s.mosaic, s.tiles, opts);
    if (r) setCover({ onceFrac: r.onceFrac });
  }, []);

  // Placed after refreshMinimap, not next to the other ref-syncing effects: a
  // dependency array is evaluated where it is written, so naming a `const`
  // declared further down the component throws "cannot access before
  // initialization" on the very first render.
  useEffect(() => { refreshMinimap(); }, [excluded, showCov, refreshMinimap]);

  const cv_originX = () => (S.current.mosaic ? S.current.mosaic.originX : 0);
  const cv_originY = () => (S.current.mosaic ? S.current.mosaic.originY : 0);

  const log = useCallback((kind, text) => {
    const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    setDiag((prev) => [{ t, kind, text }, ...prev].slice(0, DIAG_SIZE));
  }, []);

  // ---- opencv.js readiness, with a ceiling so a failed load says so ----
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => {
      if (window.cv && window.cv.Mat) {
        clearInterval(id);
        setCvReady(true);
      } else if (Date.now() - started > CV_TIMEOUT_MS) {
        clearInterval(id);
        setCvFailed(true);
      }
    }, 150);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!cvReady) return;
    db.countTiles().then((n) => { if (n > 0) setResume({ count: n }); }).catch(() => {});
  }, [cvReady]);

  // ---- display helpers ----
  const paintAll = useCallback(() => {
    const s = S.current;
    if (!s.mosaic) return;
    s.scale = M.paintFull(s.mosaic, canvasRef.current);
    setDims({ w: s.mosaic.w, h: s.mosaic.h, scale: s.scale });
  }, []);

  const rebuild = useCallback(async () => {
    const s = S.current;
    setBusyLabel('Đang vẽ lại ảnh ghép…');
    M.freeMosaic(s.mosaic);
    s.mosaic = null;
    dropCoarse();
    if (s.tiles.length === 0) {
      if (canvasRef.current) {
        canvasRef.current.width = 1;
        canvasRef.current.height = 1;
      }
      setDims({ w: 0, h: 0, scale: 1 });
      setTileCount(0);
      setBusyLabel(null);
      return;
    }
    s.mosaic = M.createMosaic(s.tiles[0].w, s.tiles[0].h);
    for (const t of s.tiles) {
      M.growFor(s.mosaic, t.x, t.y, t.w, t.h);
      const bmp = await createImageBitmap(t.blob);
      const c = readbackCanvas(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      const mat = cv.imread(c);
      M.paste(s.mosaic, mat, t.x, t.y);
      mat.delete();
    }
    paintAll();
    refreshMinimap();
    setTileCount(s.tiles.length);
    setBusyLabel(null);
  }, [paintAll, refreshMinimap]);

  // ---- capture source ----
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'never' }, audio: false });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        stopAuto();
        setCapturing(false);
        streamRef.current = null;
      });
      setCapturing(true);
      autoCrop();
    } catch (e) {
      setStatus({ text: 'Không mở được nguồn hình: ' + e.message, kind: 'warn' });
    }
  };

  const stop = () => {
    stopAuto();
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCapturing(false);
  };

  // Prefills a capture region well inside the bright field, so the stationary
  // vignette ring is excluded from the start.
  const autoCropForce = () => {
    cropRef.current = null;
    setCropBox(null);
    S.current.checkedBorder = false;
    setBorderWarn(false);
    autoCrop();
  };

  const autoCrop = () => {
    let tries = 0;
    const attempt = () => {
      const v = videoRef.current;
      if (cropRef.current) return;
      if (!v || !v.videoWidth) {
        if (tries++ < 120) requestAnimationFrame(attempt);
        return;
      }
      const c = readbackCanvas(v.videoWidth, v.videoHeight);
      c.getContext('2d').drawImage(v, 0, 0);
      const mat = cv.imread(c);
      const rect = detectFieldRect(mat);
      mat.delete();
      if (rect && !cropRef.current) {
        cropRef.current = rect;
        setCropBox(rect);
        log('info', `tự chọn vùng quét ${rect.w}×${rect.h}px (đã lùi vào trong viền halo)`);
      }
    };
    requestAnimationFrame(attempt);
  };

  // ---- crop selection ----
  const onDown = (e) => {
    if (!capturing) return;
    const r = previewRef.current.getBoundingClientRect();
    dragStart.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    setDragRect({ x: dragStart.current.x, y: dragStart.current.y, w: 0, h: 0 });
  };
  const onMove = (e) => {
    if (!dragStart.current) return;
    const r = previewRef.current.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const s = dragStart.current;
    setDragRect({ x: Math.min(s.x, cx), y: Math.min(s.y, cy), w: Math.abs(cx - s.x), h: Math.abs(cy - s.y) });
  };
  const onUp = () => {
    if (!dragStart.current) return;
    const content = videoRect(previewRef.current, videoRef.current);
    const dr = dragRect;
    dragStart.current = null;
    setDragRect(null);
    if (!dr || dr.w < 12 || dr.h < 12) return;
    const v = videoRef.current;
    const x1 = Math.max(0, (dr.x - content.x) / content.scale);
    const y1 = Math.max(0, (dr.y - content.y) / content.scale);
    const x2 = Math.min(v.videoWidth, (dr.x + dr.w - content.x) / content.scale);
    const y2 = Math.min(v.videoHeight, (dr.y + dr.h - content.y) / content.scale);
    const box = { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
    if (box.w > 40 && box.h > 40) {
      cropRef.current = box;
      setCropBox(box);
      S.current.checkedBorder = false;
      setBorderWarn(false);
      log('info', `vùng quét: ${box.w}×${box.h}px`);
    }
  };

  const grabFrame = () => {
    const v = videoRef.current;
    const c = cropRef.current;
    const sx = c ? c.x : 0;
    const sy = c ? c.y : 0;
    const sw = c ? c.w : v.videoWidth;
    const sh = c ? c.h : v.videoHeight;
    const wc = workRef.current;
    wc.width = sw;
    wc.height = sh;
    wc.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
    const mat = cv.imread(wc);
    const blobPromise = new Promise((res) => wc.toBlob(res, 'image/png'));
    return { mat, w: sw, h: sh, blobPromise };
  };

  const classifyBlur = (value) => {
    const s = S.current;
    let isBlurry = false;
    if (s.blurHistory.length >= BLUR_MIN_SAMPLES) {
      const sorted = [...s.blurHistory].sort((a, b) => a - b);
      if (value < sorted[Math.floor(sorted.length / 2)] * BLUR_RATIO) isBlurry = true;
    }
    if (!isBlurry) {
      s.blurHistory.push(value);
      if (s.blurHistory.length > BLUR_HISTORY) s.blurHistory.shift();
    }
    return isBlurry;
  };

  const freeRef = (r) => {
    if (r && r.gray) r.gray.delete();
  };

  // The shrunk mosaic used for relocalisation is only valid until the mosaic
  // changes, so it is dropped whenever a tile lands or the mosaic is rebuilt.
  const dropCoarse = () => {
    const s = S.current;
    if (s.coarse && s.coarse.mat) s.coarse.mat.delete();
    s.coarse = null;
  };

  const clearRefs = () => {
    const s = S.current;
    freeRef(s.refTile);
    freeRef(s.refPrev);
    s.refTile = null;
    s.refPrev = null;
    dropCoarse();
  };

  const addTile = async (mat, w, h, blobPromise, x, y, sharpness, isBlurry) => {
    const s = S.current;
    const grew = M.growFor(s.mosaic, x, y, w, h);
    const rect = M.paste(s.mosaic, mat, x, y);
    if (grew) {
      const next = M.fitScale(s.mosaic.w, s.mosaic.h, M.DISPLAY_MAX_DIM, M.DISPLAY_MAX_AREA);
      if (next !== s.scale) paintAll();
      else {
        M.shiftDisplay(s.mosaic, canvasRef.current, grew.growLeft, grew.growTop, s.scale);
        setDims({ w: s.mosaic.w, h: s.mosaic.h, scale: s.scale });
      }
    }
    if (!M.paintRegion(s.mosaic, canvasRef.current, rect, s.scale)) paintAll();

    const blob = await blobPromise;
    const index = s.tiles.length;
    const tile = { x, y, w, h, blob, sharpness, blurry: isBlurry, capturedAt: Date.now() };
    s.tiles.push(tile);
    setLastRect({ x, y, w, h });
    db.saveTile({ index, ...tile }).catch((e) =>
      setStatus({ text: 'Cảnh báo: không lưu được vào bộ nhớ tạm (' + e.message + ')', kind: 'warn' })
    );
    if (isBlurry) setBlurry((n) => n + 1);
    setTileCount(s.tiles.length);
    setFused(null); // mosaic no longer matches any reviewed fusion
    dropCoarse();
    refreshMinimap();
    return index;
  };

  // ---- the whole loop ----
  // Grab a frame, correlate a small central patch of the last accepted frame
  // against it, and if the picture moved far enough, paste the frame at the
  // accumulated offset. No confirmation step, no fallback estimate, no second
  // opinion: either the correlation locates the patch or the frame is skipped
  // and the next one is tried 200ms later.
  const tick = useCallback(async () => {
    const s = S.current;
    if (!ui.current.capturing || s.busy) return;
    s.busy = true;
    let mat = null;
    let gray = null;
    let grayOwned = true; // cleared once setRef() takes ownership of it
    try {
      const frame = grabFrame();
      mat = frame.mat;
      const { w, h, blobPromise } = frame;
      const g = toMatchGray(mat);
      gray = g.gray;
      const scale = g.scale;

      // One-off check that the capture region isn't reaching into the vignette.
      // A stationary high-contrast ring inside the correlated area pins the
      // measured displacement at zero, and the scan then simply never advances —
      // with nothing on screen to explain why.
      if (!s.checkedBorder) {
        s.checkedBorder = true;
        if (borderIsDark(gray)) {
          setBorderWarn(true);
          log('warn', 'vùng quét có vẻ chạm viền tối — kéo chọn lại nhỏ hơn, vào giữa vùng sáng');
        }
      }

      const sharp = sharpnessOf(gray);
      const isBlurry = classifyBlur(sharp);

      if (s.tiles.length === 0) {
        if (!s.dbOwned) {
          await db.clearAll().catch(() => {});
          s.dbOwned = true;
          setResume(null);
        }
        s.mosaic = M.createMosaic(w, h);
        await addTile(mat, w, h, blobPromise, 0, 0, sharp, isBlurry);
        clearRefs();
        s.refTile = { gray: gray.clone(), scale, x: 0, y: 0 };
        s.refPrev = { gray, scale, x: 0, y: 0 };
        grayOwned = false;
        s.fails = 0;
        setLost(false);
        log('ok', `ô nền #1 tại (0, 0), ${w}×${h}px`);
        setStatus({ text: 'Ô nền đã đặt — kéo tiêu bản để tiếp tục.', kind: 'ok' });
        return;
      }

      // Tiles exist but there is no reference frame: the session was resumed from
      // disk, or the last tile was undone. Nothing in the pixels tells us where
      // the current view sits, so the documented workflow is to line the specimen
      // back up with the last tile first — and this frame is taken at its word as
      // being that position. Previously this path dereferenced a null reference
      // and threw on the first tick after resuming or undoing.
      if (!s.refTile) {
        const last = s.tiles[s.tiles.length - 1];
        freeRef(s.refPrev);
        s.refTile = { gray: gray.clone(), scale, x: last.x, y: last.y };
        s.refPrev = { gray, scale, x: last.x, y: last.y };
        grayOwned = false;
        s.fails = 0;
        setLost(false);
        log('info', `nối lại từ ô #${s.tiles.length} — coi khung hiện tại là trùng vị trí ô đó`);
        setStatus({
          text: `Đã nối lại từ ô #${s.tiles.length}. Nếu tiêu bản chưa về đúng vị trí ô đó thì ảnh ghép sẽ lệch — bấm "Hoàn tác ô cuối" rồi thử lại.`,
          kind: 'warn',
        });
        return;
      }

      const opts = { minScore: MIN_SCORE, tolPx: AGREE_TOL_PX, minAgree: MIN_AGREE };
      const patchOf = (e) =>
        (e.all || []).map((r) => `${Math.round(r.dx / s.refTile.scale)},${Math.round(r.dy / s.refTile.scale)}`).join(' ');

      // Against the last placed tile first: no accumulated error.
      let est = estimateShift(s.refTile.gray, gray, patchRef.current, opts);
      let base = s.refTile;
      let chained = false;
      if (!est.ok && s.refPrev && s.refPrev !== s.refTile) {
        // Out of reach of the tile, but the previous frame is one tick old, so
        // whatever just happened is almost certainly within reach of that.
        const alt = estimateShift(s.refPrev.gray, gray, patchRef.current, opts);
        if (alt.ok) {
          est = alt;
          base = s.refPrev;
          chained = true;
        }
      }
      setPatchPx(est.pw);

      if (!est.ok) {
        s.fails++;
        if (s.fails >= LOST_AFTER) setLost(true);

        // Lost. Rather than waiting for the operator to line the field back up
        // with the last tile by eye — which is the hard part, since the open edge
        // of a mosaic has no landmark to aim at — search the whole mosaic for this
        // frame. Dragging back to ANY previously scanned area is enough.
        if (s.fails >= LOST_AFTER && s.tiles.length >= 2 && s.fails % 2 === 0) {
          const found = tryRelocalize(s, gray, scale, w, h);
          if (found) {
            freeRef(s.refPrev);
            freeRef(s.refTile);
            s.refTile = { gray: gray.clone(), scale, x: found.x, y: found.y };
            s.refPrev = { gray, scale, x: found.x, y: found.y };
            grayOwned = false;
            s.fails = 0;
            setLost(false);
            log('ok', `đã tự tìm lại vị trí: (${Math.round(found.x)}, ${Math.round(found.y)}) — không cần khớp tay`);
            setStatus({ text: 'Đã tự tìm lại vị trí trong ảnh ghép — cứ kéo tiếp bình thường.', kind: 'ok' });
            return;
          }
        }
        if (est.reason === 'too-far') {
          log('warn', `kéo quá xa (${est.edged}/${est.total} khung dò mất dấu) — kéo chậm lại`);
        } else if (est.reason === 'disagree') {
          // What a stationary fixture inside one patch looks like: that patch
          // says nothing moved, the others disagree, nobody has enough company.
          log('fail', `${est.used}/${est.total} khung dò không khớp nhau · đo được: ${patchOf(est)}`);
        } else {
          log('fail', `không khung dò nào định vị được (điểm cao nhất ${est.bestScore.toFixed(2)} < ${MIN_SCORE})`);
        }
        return;
      }

      const dx = est.dx / base.scale;
      const dy = est.dy / base.scale;
      let x = base.x + dx;
      let y = base.y + dy;

      // Frame-to-frame tracking has produced a prediction. Now measure the frame's
      // position against the mosaic itself, which carries no accumulated error, and
      // use that instead when it succeeds. This is what stops the whole strip from
      // leaning: without it, every tile inherits the sum of all previous
      // measurement errors, so a small consistent bias becomes a visible skew.
      let anchored = null;
      if (anchorRef.current && s.tiles.length >= 2) {
        const radius = Math.max(20, Math.round(Math.min(w, h) * ANCHOR_RADIUS_FRAC));
        const a = alignToMosaic(s.mosaic, gray, scale, w, h, x, y, radius, patchRef.current, ANCHOR_TOL_PX);
        if (a.ok) {
          x = a.x;
          y = a.y;
          anchored = a;
        }
      }

      // The frame is located, so it becomes the previous-frame reference whether
      // or not it earns a tile. This is what keeps the fallback fresh.
      if (s.refPrev !== s.refTile) freeRef(s.refPrev);
      s.refPrev = { gray, scale, x, y };
      grayOwned = false;
      s.fails = 0;
      setLost(false);

      const stepPx = Math.hypot(x - s.refTile.x, y - s.refTile.y);
      const minStep = Math.max(MIN_STEP_PX, Math.min(w, h) * STEP_FRAC);
      if (stepPx < minStep) {
        log('skip', `mới dịch ${Math.round(stepPx)}px (cần ≥ ${Math.round(minStep)}px), ${est.used}/${est.total} khung dò đồng ý`);
        return;
      }

      const index = await addTile(mat, w, h, blobPromise, x, y, sharp, isBlurry);
      freeRef(s.refTile);
      s.refTile = { gray: s.refPrev.gray.clone(), scale, x, y };
      log('ok', `ô #${index + 1} tại (${Math.round(x)}, ${Math.round(y)}) · dịch ${fmt(dx)},${fmt(dy)}` +
        ` · ${est.used}/${est.total} khung dò đồng ý (điểm ${est.score.toFixed(2)})` +
        (chained ? ' · nối qua khung trước' : '') +
        (anchored ? ` · neo vào ảnh ghép (chỉnh ${anchored.correction.toFixed(1)}px)` : ''));
      setStatus({
        text: `Đã ghép ${index + 1} ô. Bước vừa rồi: ${fmt(dx)}, ${fmt(dy)} px — ${est.used}/${est.total} khung dò đồng ý.` +
          (isBlurry ? ' Ô này có thể bị mờ.' : ''),
        kind: isBlurry ? 'warn' : 'ok',
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      stopAuto();
      log('fail', 'lỗi: ' + msg);
      setStatus({ text: 'Đã dừng do lỗi xử lý ảnh: ' + msg + ' — các ô đã chụp vẫn được giữ.', kind: 'warn' });
      // eslint-disable-next-line no-console
      console.error('[panorama] tick failed', err);
    } finally {
      // cv.Mat lives in the WASM heap and is never garbage collected, so both
      // the frame and the grayscale copy must be released on every path —
      // including the exception path, where it's easiest to forget.
      if (mat) mat.delete();
      if (gray && grayOwned) gray.delete();
      s.busy = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paintAll, log]);

  // Coarse search over the whole mosaic, then the same five-patch measurement used
  // everywhere else to confirm it. A false coarse peak cannot survive having to be
  // agreed on by five independent patches at working resolution, so the coarse
  // stage is allowed to be permissive.
  const tryRelocalize = (s, gray, scale, w, h) => {
    if (!s.mosaic) return null;
    try {
      if (!s.coarse) {
        const cs = coarseScaleFor(s.mosaic, scale, w, h);
        s.coarse = { mat: buildCoarseMosaic(s.mosaic, cs), scale: cs };
      }
      const c = relocalizeCoarse(s.mosaic, s.coarse.mat, s.coarse.scale, gray, scale);
      if (!c.ok) return null;
      const radius = Math.max(24, c.uncertaintyPx);
      const fine = alignToMosaic(s.mosaic, gray, scale, w, h, c.x, c.y, radius, patchRef.current, ANCHOR_TOL_PX);
      if (!fine.ok) return null;
      return { x: fine.x, y: fine.y };
    } catch (e) {
      log('warn', 'tìm lại vị trí lỗi: ' + (e && e.message ? e.message : e));
      return null;
    }
  };

  const tickRef = useRef(tick);
  useEffect(() => { tickRef.current = tick; }, [tick]);

  const startAuto = () => {
    if (timerRef.current || !capturing) return;
    S.current.fails = 0;
    timerRef.current = setInterval(() => tickRef.current(), TICK_MS);
    setRunning(true);
    setStatus({
      text: S.current.tiles.length > 0
        ? 'Đang chạy — đưa tiêu bản về gần vị trí ô cuối rồi kéo tiếp.'
        : 'Đang chạy — kéo tiêu bản dưới kính hiển vi.',
      kind: 'ok',
    });
  };

  const stopAuto = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRunning(false);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (!capturing || e.code !== 'Space') return;
      e.preventDefault();
      if (timerRef.current) stopAuto();
      else startAuto();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);

  useEffect(() => () => stopAuto(), []);

  // ---- session actions ----
  const continueSession = async () => {
    const s = S.current;
    try {
      const rows = await db.loadAll();
      s.tiles = rows.map(({ index, ...t }) => t);
      s.blurHistory = s.tiles.filter((t) => !t.blurry && t.sharpness).map((t) => t.sharpness).slice(-BLUR_HISTORY);
      s.dbOwned = true;
      setBlurry(s.tiles.filter((t) => t.blurry).length);
      setResume(null);
      await rebuild();
      // The reference frame can't be restored from disk in a usable way — the
      // slide has moved since. Force a fresh reference on the next tick by
      // dropping it; the first frame after resuming becomes the new anchor, so
      // line the specimen back up with the last tile before starting.
      clearRefs();
      setStatus({
        text: `Đã khôi phục ${s.tiles.length} ô. Đưa tiêu bản về đúng vị trí ô cuối cùng rồi bấm "Bắt đầu" — khung đầu tiên sau khi bắt đầu sẽ được coi là nối tiếp từ ô cuối.`,
        kind: 'ok',
      });
    } catch (e) {
      setStatus({ text: 'Không khôi phục được: ' + e.message, kind: 'warn' });
      setResume(null);
    }
  };

  const discardSession = async () => {
    await db.clearAll().catch(() => {});
    S.current.dbOwned = true;
    setResume(null);
  };

  const undo = async () => {
    const s = S.current;
    if (s.tiles.length === 0 || s.busy) return;
    s.busy = true;
    try {
      const i = s.tiles.length - 1;
      const t = s.tiles.pop();
      if (t.blurry) setBlurry((n) => Math.max(0, n - 1));
      db.deleteFrom(i).catch(() => {});
      clearRefs();
      await rebuild();
      log('info', `đã hoàn tác ô #${i + 1}`);
      setStatus({ text: 'Đã hoàn tác. Đưa tiêu bản về vị trí ô cuối trước khi chạy tiếp.', kind: 'idle' });
    } finally {
      s.busy = false;
    }
  };

  const reset = () => {
    stopAuto();
    const s = S.current;
    M.freeMosaic(s.mosaic);
    s.mosaic = null;
    clearRefs();
    s.tiles = [];
    s.blurHistory = [];
    s.fails = 0;
    s.dbOwned = true;
    s.checkedBorder = false;
    db.clearAll().catch(() => {});
    setBlurry(0);
    setBorderWarn(false);
    setLost(false);
    setLastRect(null);
    setCover(null);
    setExcluded(new Set());
    setFused(null);
    setOptStats(null);
    setTileCount(0);
    setDims({ w: 0, h: 0, scale: 1 });
    setDiag([]);
    if (canvasRef.current) {
      canvasRef.current.width = 1;
      canvasRef.current.height = 1;
    }
    setStatus({ text: 'Đã đặt lại.', kind: 'idle' });
  };

  // ---- floating overview ----
  const closePip = () => {
    pipCanvasRef.current = null;
    if (pipRef.current) {
      try { pipRef.current.close(); } catch { /* window already gone */ }
      pipRef.current = null;
    }
    if (pipVideoRef.current) {
      pipVideoRef.current.pause();
      pipVideoRef.current.srcObject = null;
      pipVideoRef.current = null;
    }
    pipRef.current = null;
    setPipOn(false);
    refreshMinimap();
  };

  const openPip = async () => {
    const mode = pipSupport();
    try {
      if (mode === 'document') {
        // Real DOM in an always-on-top window: the map and its key move across
        // intact, and it keeps updating because it is the same canvas element.
        const wrap = document.createElement('div');
        const c = document.createElement('canvas');
        wrap.append(c);
        const key = document.createElement('div');
        key.className = 'k';
        key.innerHTML =
          'Vùng <b>vàng</b> = mới quét 1 lần, chưa có ô chồng lấn.<br>' +
          'Ô viền <i>xanh</i> = ô mới nhất.<br>' +
          'Chỗ trong suốt = chưa quét.';
        wrap.append(key);
        pipRef.current = await openDocumentPiP(wrap, { onClose: closePip });
        pipCanvasRef.current = c;
        setPipOn(true);
        refreshMinimap();
      } else if (mode === 'video') {
        // No DOM PiP available: stream the canvas into a video instead. Same
        // always-on-top behaviour, just a picture with no caption.
        // Same idea for the video fallback: stream a canvas of our own, not the
        // one React is rendering.
        const c = document.createElement('canvas');
        pipCanvasRef.current = c;
        refreshMinimap();
        const stream = c.captureStream(2);
        const v = document.createElement('video');
        v.muted = true;
        v.srcObject = stream;
        await v.play();
        pipVideoRef.current = v;
        v.addEventListener('leavepictureinpicture', closePip);
        await v.requestPictureInPicture();
        setPipOn(true);
      } else {
        setStatus({
          text: 'Trình duyệt này không hỗ trợ cửa sổ nổi. Bản đồ vẫn dùng được trong thanh bên; hoặc mở app ở cửa sổ nhỏ cạnh cửa sổ camera.',
          kind: 'warn',
        });
      }
    } catch (e) {
      setStatus({ text: 'Không mở được cửa sổ nổi: ' + (e && e.message ? e.message : e), kind: 'warn' });
      closePip();
    }
  };

  // ---- review & fuse before export ----
  const runFusion = async (method) => {
    const s = S.current;
    if (!s.mosaic || s.tiles.length === 0 || busyLabel) return;
    stopAuto();
    try {
      const r = await fuseMosaic(s.mosaic, s.tiles, {
        method,
        excluded,
        onProgress: (done, total) =>
          setBusyLabel(`Đang dựng lại ảnh ghép (${FUSION_METHODS[method].label}) — dải ${done}/${total}…`),
      });
      paintAll();
      refreshMinimap();
      setFused(method);
      const n = excluded.size;
      setStatus({
        text: `Đã dựng lại bằng "${FUSION_METHODS[method].label}" từ ${r.used} ô` +
          (n > 0 ? `, bỏ ${n} ô.` : '.') + ' Xem lại rồi hãy xuất.',
        kind: 'ok',
      });
      log('info', `dựng lại: ${FUSION_METHODS[method].label}, ${r.used} ô, ${r.bands} dải`);
    } catch (e) {
      setStatus({ text: 'Dựng lại thất bại: ' + (e && e.message ? e.message : e), kind: 'warn' });
    } finally {
      setBusyLabel(null);
    }
  };

  // Global optimisation. Measures every overlapping pair and re-solves all
  // positions at once, so drift already baked into the recorded positions gets
  // corrected instead of merely stopped.
  const runOptimize = async () => {
    const s = S.current;
    if (s.tiles.length < 3 || busyLabel) return;
    stopAuto();
    setBusyLabel('Đang đo các cặp ô chồng lấn…');
    try {
      const r = await optimizePositions(s.tiles, {
        onProgress: (done, total, measured) =>
          setBusyLabel(`Đang đo cặp ô chồng lấn ${done}/${total} (đo được ${measured})…`),
      });
      if (!r.ok) {
        setStatus({
          text: r.reason === 'no-pairs'
            ? 'Không tìm thấy cặp ô nào chồng lấn đủ nhiều để tối ưu — các ô cách nhau quá xa.'
            : 'Không đo được cặp ô nào (vùng chồng lấn thiếu chi tiết).',
          kind: 'warn',
        });
        return;
      }
      setBusyLabel('Đang áp vị trí mới…');
      r.positions.forEach((q, i) => {
        s.tiles[i].x = q.x;
        s.tiles[i].y = q.y;
      });
      // Persist the corrected geometry, otherwise resuming would restore the
      // pre-optimisation positions.
      s.tiles.forEach((t, i) => db.saveTile({ index: i, ...t }).catch(() => {}));
      clearRefs(); // reference frames carry old positions
      setOptStats(r);
      setFused(null);
      await rebuild();
      setStatus({
        text: `Đã tối ưu ${s.tiles.length} ô từ ${r.links}/${r.pairs} cặp chồng lấn. ` +
          `Sai lệch trung bình giữa các cặp: ${r.beforeResidual.toFixed(1)}px → ${r.afterResidual.toFixed(1)}px. ` +
          `Ô dịch nhiều nhất ${r.maxMove.toFixed(0)}px.`,
        kind: 'ok',
      });
      log('info', `tối ưu toàn cục: ${r.links}/${r.pairs} cặp, sai lệch ${r.beforeResidual.toFixed(1)}→${r.afterResidual.toFixed(1)}px, bỏ ${r.dropped} cặp lỗi`);
    } catch (e) {
      setStatus({ text: 'Tối ưu thất bại: ' + (e && e.message ? e.message : e), kind: 'warn' });
    } finally {
      setBusyLabel(null);
    }
  };

  const toggleExclude = (i) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
    setFused(null);
  };

  const excludeAllBlurry = () => {
    const s = S.current;
    setExcluded((prev) => {
      const next = new Set(prev);
      s.tiles.forEach((t, i) => { if (t.blurry) next.add(i); });
      return next;
    });
    setFused(null);
  };

  // ---- export ----
  const exportPNG = () => {
    const s = S.current;
    if (!s.mosaic) return;
    let out;
    try {
      out = M.renderForExport(s.mosaic);
    } catch (e) {
      setStatus({ text: 'Không xuất được PNG: ' + e.message + ' — dùng bản xuất ZIP.', kind: 'warn' });
      return;
    }
    out.canvas.toBlob((blob) => {
      if (!blob) {
        setStatus({ text: 'Ảnh ghép quá lớn để tạo PNG — dùng bản xuất ZIP + Fiji.', kind: 'warn' });
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `panorama-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      setStatus({
        text: out.scale < 1
          ? `Đã xuất PNG nhưng thu nhỏ ${Math.round(out.scale * 100)}% (vượt giới hạn canvas). Muốn đủ độ phân giải thì dùng bản ZIP.`
          : 'Đã xuất PNG ở độ phân giải gốc.',
        kind: out.scale < 1 ? 'warn' : 'ok',
      });
    }, 'image/png');
  };

  const exportZip = async () => {
    const s = S.current;
    if (s.tiles.length === 0 || busyLabel) return;
    setBusyLabel('Đang đóng gói…');
    try {
      const zip = new JSZip();
      const pad = Math.max(4, String(s.tiles.length).length);
      const rows = ['index,filename,x_px,y_px,width_px,height_px,blurry,sharpness,quality,excluded,captured_at_iso'];
      const cfg = ['# Define the number of dimensions we are working on', 'dim = 2', '# Define the image coordinates'];
      const medSharp = medianSharpnessOf(s.tiles);
      s.tiles.forEach((t, i) => {
        const name = `tile_${String(i + 1).padStart(pad, '0')}.png`;
        const skip = excluded.has(i);
        // Excluded tiles still ship, flagged in the manifest rather than deleted:
        // the operator's judgement is recorded, not silently applied, so the call
        // can be reviewed later. They are left out of TileConfiguration so Fiji
        // won't place them.
        zip.file(name, t.blob);
        // Coordinates are the integer positions the tiles were actually pasted
        // at, shifted so the top-left of the mosaic is the origin.
        const x = Math.round(t.x) + s.mosaic.originX;
        const y = Math.round(t.y) + s.mosaic.originY;
        rows.push(
          `${i + 1},${name},${x},${y},${t.w},${t.h},${t.blurry ? 1 : 0},${Math.round(t.sharpness || 0)},` +
          `${tileQuality(t, medSharp).toFixed(2)},${skip ? 1 : 0},${new Date(t.capturedAt).toISOString()}`
        );
        if (!skip) cfg.push(`${name}; ; (${x}.0, ${y}.0)`);
      });
      zip.file('manifest.csv', rows.join('\n') + '\n');
      zip.file('TileConfiguration.txt', cfg.join('\n') + '\n');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `anh-goc-${Date.now()}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      setStatus({ text: `Đã xuất ${s.tiles.length} ảnh gốc kèm manifest.csv và TileConfiguration.txt.`, kind: 'ok' });
    } catch (e) {
      setStatus({ text: 'Xuất ZIP thất bại: ' + e.message, kind: 'warn' });
    } finally {
      setBusyLabel(null);
    }
  };

  // ---- overlays ----
  const cropStyle = (() => {
    if (!cropBox || !videoRef.current || !previewRef.current || !videoRef.current.videoWidth) return null;
    const c = videoRect(previewRef.current, videoRef.current);
    return {
      left: c.x + cropBox.x * c.scale,
      top: c.y + cropBox.y * c.scale,
      width: cropBox.w * c.scale,
      height: cropBox.h * c.scale,
    };
  })();

  // The patches actually being correlated, drawn at true size and position. This
  // is the one thing worth looking at before starting: if any yellow square
  // overlaps the halo, a dust speck, or a software overlay, that square will
  // report "nothing moved" and has to be voted down by the others.
  const patchStyles = (() => {
    if (!cropStyle) return [];
    const pw = cropStyle.width * patchFrac;
    const ph = cropStyle.height * patchFrac;
    return PATCH_CENTERS.map(([cx, cy]) => ({
      left: cropStyle.left + cropStyle.width * cx - pw / 2,
      top: cropStyle.top + cropStyle.height * cy - ph / 2,
      width: pw,
      height: ph,
    }));
  })();

  // Shrinks the capture region toward its centre. The fastest fix when fixtures
  // are inside the frame, and it shrinks the patches with it since they are sized
  // relative to the region.
  const shrinkCrop = () => {
    const b = cropRef.current;
    const v = videoRef.current;
    if (!b || !v) return;
    const nw = Math.max(80, Math.round(b.w * 0.9));
    const nh = Math.max(80, Math.round(b.h * 0.9));
    const box = {
      x: Math.round(b.x + (b.w - nw) / 2),
      y: Math.round(b.y + (b.h - nh) / 2),
      w: nw,
      h: nh,
    };
    cropRef.current = box;
    setCropBox(box);
    S.current.checkedBorder = false;
    setBorderWarn(false);
    log('info', `thu nhỏ vùng quét: ${box.w}×${box.h}px`);
  };

  return (
    <>
      {!cvReady && (
        <div className="loading">
          {cvFailed ? (
            <div className="mono warn-text">
              Không tải được <code>/opencv.js</code>. Kiểm tra tab Network xem file có trả về 200 với
              kiểu MIME JavaScript — thường là do build/publish directory bị cấu hình sai.
            </div>
          ) : (
            <div className="mono dim">Đang tải bộ xử lý ảnh (OpenCV.js)…</div>
          )}
        </div>
      )}
      {resume && (
        <div className="banner">
          <span>Tìm thấy phiên quét dở ({resume.count} ô). Tiếp tục hay bắt đầu mới?</span>
          <button className="primary" onClick={continueSession}>Tiếp tục</button>
          <button onClick={discardSession}>Bắt đầu mới</button>
        </div>
      )}

      <header>
        <h1>Ghép Panorama Kính Hiển Vi</h1>
        <span className="sub">Định vị theo pixel trên trục x, y — kéo tiêu bản, app tự ghép</span>
      </header>

      <div className="layout">
        <div className="rail">
          <div className="block">
            <h2>1 · Nguồn hình &amp; vùng quét</h2>
            <div
              className="preview"
              ref={previewRef}
              onMouseDown={onDown}
              onMouseMove={onMove}
              onMouseUp={onUp}
              onMouseLeave={onUp}
              style={{ cursor: capturing ? 'crosshair' : 'default' }}
            >
              <video ref={videoRef} muted playsInline></video>
              {!capturing && <div className="empty">Bấm "Chọn cửa sổ" và chọn cửa sổ phần mềm camera.</div>}
              {cropStyle && <div className="box crop" style={cropStyle}></div>}
              {patchStyles.map((st, i) => (
                <div className="box patch" key={i} style={st}>{i === 0 && <span>khung dò</span>}</div>
              ))}
              {dragRect && <div className="box crop dragging" style={{ left: dragRect.x, top: dragRect.y, width: dragRect.w, height: dragRect.h }}></div>}
            </div>
            <div className="gap" />
            {!capturing ? (
              <button className="primary" disabled={!cvReady} onClick={start}>Chọn cửa sổ / màn hình…</button>
            ) : (
              <button className="danger" onClick={stop}>Dừng ghi</button>
            )}
            {borderWarn && (
              <div className="alert">
                Vùng quét có vẻ đang chạm viền tối (halo). Vòng halo <b>không di chuyển</b> khi bạn kéo
                tiêu bản, nên nếu nó nằm trong khung dò thì phép khớp sẽ luôn báo "không dịch chuyển"
                và ảnh ghép đứng yên. Hãy kéo chọn lại một vùng nhỏ hơn, nằm hẳn trong vùng sáng.
              </div>
            )}
            {capturing && cropBox && (
              <>
                <div className="gap" />
                <div className="row">
                  <button onClick={shrinkCrop}>Thu nhỏ vùng quét 10%</button>
                  <button onClick={autoCropForce}>Dò lại tự động</button>
                </div>
                <div className="note mono">
                  Vùng quét: {cropBox.w}×{cropBox.h}px
                </div>
              </>
            )}
            <div className="alert">
              <b>Đưa con trỏ chuột ra ngoài vùng quét</b> trước khi bắt đầu. Trình duyệt thường bỏ qua
              yêu cầu ẩn con trỏ, nên nó sẽ bị dán vào ảnh ghép; và khi bạn rời tay khỏi chuột để kéo
              tiêu bản, con trỏ đứng yên trở thành một vật cố định trong khung — đúng loại thứ làm lệch
              phép đo dịch chuyển.
            </div>
            <div className="note">
              Khung <b>xanh</b> = vùng ảnh được lưu vào ảnh ghép. 5 khung <b>vàng</b> = khung dò, phần
              thực sự dùng để đo dịch chuyển. Kéo chuột trên khung xem trước để chọn lại vùng quét —
              càng vào giữa vùng sáng càng tốt.
            </div>
          </div>

          <div className="block">
            <h2>2 · Khung dò</h2>
            <div className="slider-row">
              <input
                type="range"
                min={PATCH_MIN * 100}
                max={PATCH_MAX * 100}
                step={1}
                value={Math.round(patchFrac * 100)}
                onChange={(e) => setPatchFrac(Number(e.target.value) / 100)}
              />
              <span className="mono">{Math.round(patchFrac * 100)}%</span>
            </div>
            <div className="note">
              5 khung dò nhỏ, đặt rải trong vùng quét. Mỗi khung đo dịch chuyển độc lập; app chỉ nhận
              kết quả mà <b>ít nhất {MIN_AGREE} khung đồng ý</b> với nhau (lệch dưới {AGREE_TOL_PX}px).
              Nhờ vậy một khung dò vô tình nằm trên vật cố định — bụi, viền halo, overlay — sẽ báo
              "không dịch chuyển", lệch khỏi nhóm, và bị loại; nó không kéo được kết quả đi.
            </div>
            <div className="note">
              Nhỏ thì an toàn hơn với vật cố định <i>và</i> tầm với xa hơn, nhưng cần vùng có chi tiết.
              Chỉ tăng lên khi nhật ký báo "không khung dò nào định vị được".
              {patchPx > 0 && <> Hiện tại mỗi khung dò ≈ <span className="mono">{patchPx}×{patchPx}px</span> ở độ phân giải xử lý.</>}
            </div>
          </div>

          <div className="block">
            <h2>3 · Chống trôi</h2>
            <label className="check">
              <input type="checkbox" checked={anchor} onChange={(e) => setAnchor(e.target.checked)} />
              <span>Neo từng ô vào ảnh ghép</span>
            </label>
            <div className="note">
              Bật (khuyến nghị): vị trí mỗi ô được đo <b>so với ảnh ghép đã dựng</b>, không phải so với ô
              liền trước. Ảnh ghép là hệ quy chiếu cố định nên sai số không cộng dồn — đó là thứ chặn hiện
              tượng cả dải ảnh nghiêng dần. Khi quét zigzag đi ngược lại cạnh một cột cũ, vị trí được đo
              từ chính phần chồng lấn với cột đó, nên vòng quét tự khép lại.
            </div>
            <div className="note">
              Tắt nếu muốn thấy đúng chuỗi đo thô (chỉ để chẩn đoán). Nhật ký ghi
              <code> neo vào ảnh ghép (chỉnh Npx)</code> — N là mức sai số vừa được sửa; N tăng dần theo
              đường quét chính là lượng trôi mà bước này đang bù.
            </div>
          </div>

          <div className="block" style={{ borderColor: running ? 'var(--teal)' : 'var(--line)' }}>
            <h2>4 · Chạy</h2>
            {!running ? (
              <button className="primary" disabled={!cvReady || !capturing} onClick={startAuto}>
                Bắt đầu <span className="kbd">Space</span>
              </button>
            ) : (
              <button className="warn" onClick={stopAuto}>Đang chạy — bấm để dừng <span className="kbd">Space</span></button>
            )}
            {lost && (
              <div className="alert lost">
                <b>Mất dấu — đang tự tìm lại.</b> App đang dò khung hiện tại trong <i>toàn bộ</i> ảnh
                ghép, nên bạn <b>không cần khớp tay với ô cuối</b>.
                <br /><br />
                Chỉ cần kéo tiêu bản về <b>bất kỳ vùng nào đã quét</b> — bất kỳ chỗ nào, không cần đúng
                mép đang để ngỏ. App tự nhận ra vị trí và tiếp tục, không phải bấm gì.
                <br /><br />
                Nếu vẫn không bắt lại: lấy nét lại (ảnh mờ thì không dò được), hoặc thu nhỏ vùng quét —
                có thể một khung dò đang nằm trên vật cố định.
              </div>
            )}
            <div className="note">
              Mỗi {TICK_MS}ms app lấy 1 khung, đo xem ảnh đã dịch bao nhiêu pixel theo x và y, rồi dán
              khung đó vào đúng vị trí. Đo so với ô cuối cùng đã đặt; nếu ngoài tầm với thì so với khung
              ngay trước đó — nên một cú giật khi đổi trục chỉ mất 1 khung, không mất cả phiên.
            </div>
          </div>

          <div className="block">
            <h2>Bản đồ vùng đã quét</h2>
            <div className="mini-box">
              {tileCount === 0 && (
                <div className="note" style={{ marginTop: 0 }}>Chưa có gì để hiện.</div>
              )}
              <canvas ref={miniRef} className="mini" style={{ display: tileCount === 0 ? 'none' : 'block' }}></canvas>
            </div>
            <div className="gap" />
            {!pipOn ? (
              <button onClick={openPip} disabled={tileCount === 0}>Mở cửa sổ nổi (luôn nằm trên)</button>
            ) : (
              <button className="warn" onClick={closePip}>Đóng cửa sổ nổi</button>
            )}
            <label className="check" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={showCov} onChange={(e) => setShowCov(e.target.checked)} />
              <span>Tô vùng chưa hoàn thiện</span>
            </label>
            <div className="note">
              Nền bản đồ là <b>ảnh thật đã quét</b>, thu nhỏ. Bỏ tích ở trên để xem ảnh sạch không lớp phủ.
            </div>
            <div className="note">
              Vùng <span className="amber">vàng</span> = mới quét <b>1 lần</b>, chưa có ô nào chồng lấn:
              đã có ảnh, nhưng không có ô thứ hai để đối chiếu hay để chọn pixel tốt hơn ở khâu hậu kiểm,
              nên chỗ đó xuất ra đúng như khung đã chụp — kể cả phần mép dính halo. Trên một phiên quét
              xong, chỉ viền ngoài cùng nên còn vàng.
              <br />
              Chỗ <b>trong suốt</b> = chưa quét. Ô viền <span style={{ color: 'var(--teal)' }}>xanh</span> = ô mới nhất.
            </div>
            {cover && (
              <div className="note mono">
                {Math.round(cover.onceFrac * 100)}% diện tích đã quét hiện chỉ có 1 ô phủ.
              </div>
            )}
          </div>

          <div className="block">
            <h2>Trạng thái</h2>
            <div className="status">
              <span className={`badge ${lost ? 'warn' : status.kind}`}>
                {lost ? 'Mất dấu' : status.kind === 'ok' ? 'Tốt' : status.kind === 'warn' ? 'Chú ý' : 'Sẵn sàng'}
              </span>
              <div className="gap-s" />
              {busyLabel || status.text}
              <div className="gap-s" />
              Số ô: <b className="mono">{tileCount}</b>
              <br />
              Ảnh ghép: <span className="mono">{dims.w}×{dims.h}px</span>
              {dims.scale < 1 && <span className="dim"> (xem ở {Math.round(dims.scale * 100)}%)</span>}
              {blurry > 0 && <><br /><span className="amber">⚠ {blurry} ô có thể bị mờ</span></>}
            </div>
          </div>

          <div className="block">
            <h2>Nhật ký</h2>
            <div className="log mono">
              {diag.length === 0
                ? <div className="note">Chưa có gì.</div>
                : diag.map((d, i) => (
                    <div className={'log-row ' + d.kind} key={i}>
                      <span className="log-time">{d.t}</span>
                      <span>{d.text}</span>
                    </div>
                  ))}
            </div>
          </div>

          <div className="block">
            <h2>5 · Tối ưu vị trí toàn cục</h2>
            <button className="primary" onClick={runOptimize} disabled={tileCount < 3 || !!busyLabel}>
              Tối ưu vị trí tất cả các ô
            </button>
            <div className="note">
              Trong lúc quét, vị trí mỗi ô được quyết định ngay khi đặt và không đổi nữa — ô nào đã lệch
              3px thì lệch luôn. Bước này đo dịch chuyển giữa <b>mọi cặp ô chồng lấn</b> (kể cả ô ở hàng
              trên, hay cột mà đường quét đang đi ngược lại cạnh nó), coi mỗi phép đo là một ràng buộc có
              độ tin cậy, rồi <b>giải lại toàn bộ vị trí cùng lúc</b> sao cho thoả mãn tất cả tốt nhất.
              Không phép đo nào là tối hậu, nên một phép đo sai bị các ô lân cận áp đảo thay vì lan ra —
              và đường quét vòng lại buộc phải khớp với chính nó.
            </div>
            <div className="note">
              Đây chính là thuật toán Fiji dùng. Bài toán nhỏ (vài trăm ô, vài trăm ràng buộc) nên chạy
              ngay trong trình duyệt, không cần server.
            </div>
            {optStats && (
              <div className="note mono" style={{ color: 'var(--teal)' }}>
                {optStats.links}/{optStats.pairs} cặp đo được · sai lệch trung bình{' '}
                {optStats.beforeResidual.toFixed(1)}px → {optStats.afterResidual.toFixed(1)}px · bỏ{' '}
                {optStats.dropped} cặp lỗi · dịch tối đa {optStats.maxMove.toFixed(0)}px
              </div>
            )}
          </div>

          <div className="block" style={{ borderColor: fused ? 'var(--teal)' : 'var(--amber)' }}>
            <h2>6 · Hậu kiểm pixel trước khi xuất</h2>
            <div className="note" style={{ marginTop: 0 }}>
              Trong lúc quét, ô chụp sau ghi đè ô chụp trước — nhanh, đủ để định vị. Nhưng ở một vị trí
              thường có vài ô chồng lấn, và chúng <b>không tốt như nhau</b> tại vị trí đó: pixel gần
              <b> tâm</b> khung nằm ở vùng phẳng, đều sáng; cùng chi tiết đó nếu lấy từ <b>mép</b> khung
              thì dính vignette, gradient halo và quang sai nặng nhất. Bước này dựng lại cả ảnh ghép và
              quyết định theo từng pixel là tin ô nào.
            </div>
            <div className="gap" />
            {Object.entries(FUSION_METHODS).map(([key, m]) => (
              <label className={'radio' + (fusion === key ? ' on' : '')} key={key}>
                <input type="radio" name="fusion" checked={fusion === key} onChange={() => setFusion(key)} />
                <span>
                  <b>{m.label}</b>
                  <br />
                  <span className="dim">{m.note}</span>
                </span>
              </label>
            ))}
            <div className="gap" />
            <button className="primary" onClick={() => runFusion(fusion)} disabled={tileCount === 0 || !!busyLabel}>
              Dựng lại &amp; xem trước
            </button>
            <div className="note">
              {fused
                ? `Ảnh ghép đang hiển thị bản dựng "${FUSION_METHODS[fused].label}" — xuất ra sẽ đúng như bạn thấy.`
                : 'Ảnh ghép đang hiển thị bản dán lúc quét (ô mới ghi đè). Dựng lại trước khi xuất để dùng bản tốt nhất.'}
            </div>
            {excluded.size > 0 && (
              <div className="note amber">
                Đang bỏ {excluded.size} ô. Chúng vẫn nằm trong bản xuất ZIP nhưng được đánh dấu
                <code> excluded=1</code> trong manifest và không đưa vào TileConfiguration.
              </div>
            )}
          </div>

          <div className="block">
            <h2>Công cụ</h2>
            <div className="row">
              <button onClick={undo} disabled={tileCount === 0}>Hoàn tác ô cuối</button>
              <button onClick={reset} disabled={tileCount === 0}>Đặt lại</button>
            </div>
            <div className="gap" />
            <button className="primary" onClick={exportPNG} disabled={tileCount === 0}>Xuất ảnh ghép (PNG)</button>
            <div className="gap" />
            <button onClick={exportZip} disabled={tileCount === 0 || !!busyLabel}>
              {busyLabel ? 'Đang xử lý…' : 'Xuất ảnh gốc + toạ độ (ZIP)'}
            </button>
            <div className="note">
              Kèm <code>manifest.csv</code> (toạ độ x, y nguyên của từng ảnh) và
              <code> TileConfiguration.txt</code> cho Fiji nếu cần ghép lại chất lượng cao hơn.
              Việc đếm/phân loại vẫn nên làm trên từng ảnh gốc.
            </div>
            <div className="gap" />
            <button onClick={() => setShowTiles((v) => !v)} disabled={tileCount === 0}>
              {showTiles ? 'Ẩn danh sách ô' : 'Hiện danh sách ô'}
            </button>
            {showTiles && (
              <>
                {blurry > 0 && (
                  <>
                    <div className="gap" />
                    <button onClick={excludeAllBlurry}>Bỏ tất cả {blurry} ô mờ</button>
                  </>
                )}
                <div className="tiles">
                  {S.current.tiles.map((t, i) => (
                    <label className={'tile-row' + (excluded.has(i) ? ' off' : '')} key={i}>
                      <input
                        type="checkbox"
                        checked={!excluded.has(i)}
                        onChange={() => toggleExclude(i)}
                        title="Bỏ tích để loại ô này khỏi ảnh ghép"
                      />
                      <span className="mono dim">#{i + 1}</span>
                      <Thumb blob={t.blob} />
                      <span className="mono dim">{Math.round(t.x)}, {Math.round(t.y)}</span>
                      {t.blurry && <span className="badge warn">Mờ</span>}
                    </label>
                  ))}
                </div>
                <div className="note">
                  Bỏ tích ô nào bị halo, nhoè, hoặc lệch. Sau khi bỏ, bấm "Dựng lại &amp; xem trước" ở trên
                  để thấy kết quả — chỗ trống sẽ được các ô chồng lấn còn lại lấp vào.
                </div>
              </>
            )}
          </div>
        </div>

        <div className="stage">
          {tileCount === 0 && (
            <div className="stage-empty">
              Ảnh ghép sẽ hiện ở đây.
              <br />
              Chọn cửa sổ nguồn, kiểm tra khung dò nằm trong vùng sáng, rồi bấm "Bắt đầu".
            </div>
          )}
          {/* Always mounted, hidden while empty. Unmounting it meant the first tile
              was composited into a canvas that did not exist yet — nothing appeared
              until the second tile forced a full repaint, and the overview map had
              no real image to copy from. */}
          <div className="stage-scroll" style={{ display: tileCount === 0 ? 'none' : 'block' }}>
              <div className="stage-frame">
                <canvas ref={canvasRef}></canvas>
                {/* Marks where the newest tile sits. Without it the mosaic gives no
                    clue which edge is the open one, which is exactly what makes
                    manual re-alignment so awkward. */}
                {lastRect && dims.w > 0 && (
                  <div
                    className={'last-tile' + (lost ? ' lost' : '')}
                    style={{
                      left: (lastRect.x + cv_originX()) * dims.scale,
                      top: (lastRect.y + cv_originY()) * dims.scale,
                      width: lastRect.w * dims.scale,
                      height: lastRect.h * dims.scale,
                    }}
                  >
                    <span>ô mới nhất{lost ? ' · đang tìm lại vị trí' : ''}</span>
                  </div>
                )}
              </div>
          </div>
          <div className="footer mono">
            <span>Tương quan pixel trên khung dò · tịnh tiến x, y · không nội suy</span>
            <span>{tileCount} ô</span>
          </div>
        </div>
      </div>
    </>
  );
}
