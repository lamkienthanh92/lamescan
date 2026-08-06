/* global cv */
import { useState, useRef, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import './App.css';
import { toMatchGray, estimateShift, sharpnessOf, borderIsDark, detectFieldRect, pixelDetailRatio, PATCH_CENTERS, PATCH_MIN_PX } from './align.js';
import * as M from './mosaic.js';
import { alignToMosaic, relocalizeCoarse, buildCoarseMosaic, coarseScaleFor } from './anchor.js';
import { fuseMosaic, FUSION_METHODS, medianSharpnessOf, tileQuality } from './fuse.js';
import { optimizePositions, scanAxisTilt } from './optimize.js';
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
// Three of five, not two. Every patch measures the same physical translation, so
// on a clean frame all five agree; needing three still tolerates two patches
// landing on a fixture or on featureless background. Two was weak enough that a
// pair of small patches finding the same wrong offset on repetitive tissue could
// carry a frame, and a wrongly placed tile then becomes the reference for
// everything after it. A skipped frame costs 200ms; a wrong one costs the scan.
const MIN_AGREE = 3;
const MIN_STEP_PX = 12;       // don't record a tile until the picture has actually moved
// How far the picture must move before a tile is recorded, as a fraction of the
// frame. This was 0.08 — a tile every 8% of a frame, i.e. 92% overlap, so 82 tiles
// covered barely three fields of view. Overlap does not reduce resolution, but it
// does mean an enormous number of tiles for a tiny area of slide, and it is why a
// long scan produced a small image.
//
// 0.4 keeps 60% overlap, which is still generous, and stays inside a patch's reach
// so each tile can be measured against the previous TILE rather than chained
// through intermediate frames. Larger steps cover more slide per tile but rely on
// frame-to-frame chaining, which accumulates more error.
const STEP_PRESETS = [
  { frac: 0.30, label: 'Dày (70% chồng)', note: 'Nhiều ô nhất, an toàn nhất khi định vị. Ảnh ghép lớn chậm.' },
  { frac: 0.45, label: 'Vừa (55% chồng)', note: 'Cân bằng — mặc định. Vẫn đo trực tiếp được với ô trước.' },
  { frac: 0.65, label: 'Thưa (35% chồng)', note: 'Ít ô, phủ nhiều lame nhất. Dựa vào nối qua khung trước nên sai số nhiều hơn.' },
];
const STEP_DEFAULT = 0.45;
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
  const [tilt, setTilt] = useState(null);        // camera-vs-stage axis angle
  const [detail, setDetail] = useState(null);    // per-pixel detail ratio of the source
  const [pipOn, setPipOn] = useState(false);
  const [showCov, setShowCov] = useState(true);
  const [stepFrac, setStepFrac] = useState(STEP_DEFAULT);
  const stepRef = useRef(STEP_DEFAULT);
  const [sourceMode, setSourceMode] = useState('camera');
  const [cameras, setCameras] = useState([]);
  const [deviceId, setDeviceId] = useState('');
  const [srcInfo, setSrcInfo] = useState(null);   // negotiated track settings
  const [locked, setLocked] = useState(null);     // which camera controls got fixed
  const showCovRef = useRef(true);
  const [anchor, setAnchor] = useState(true);
  const [fusion, setFusion] = useState('best');
  const [excluded, setExcluded] = useState(() => new Set());
  const excludedRef = useRef(new Set());
  const [fused, setFused] = useState(null); // which method the current mosaic shows
  const [optStats, setOptStats] = useState(null);
  const [straighten, setStraighten] = useState(true);
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
  useEffect(() => { stepRef.current = stepFrac; }, [stepFrac]);

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
    navigator.mediaDevices
      .enumerateDevices()
      .then((devs) => {
        const cams = devs.filter((d) => d.kind === 'videoinput');
        setCameras(cams);
        if (cams.length > 0) setDeviceId((prev) => prev || cams[0].deviceId);
      })
      .catch(() => {});
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
    // Every position is known here, so allocate the exact size instead of growing
    // into it — no padding is created, so none has to be trimmed away later.
    s.mosaic = M.createMosaicFor(s.tiles);
    for (const t of s.tiles) {
      M.growFor(s.mosaic, t.x, t.y, t.w, t.h); // safety net; should never fire

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
  //
  // Where the image quality is actually decided. Everything downstream is
  // lossless — tiles are stored as PNG, pasted at integer offsets with no
  // interpolation, and exported straight from the mosaic — so nothing after this
  // point can recover detail that was not captured here.
  //
  // Screen capture is the convenient option and the lossy one. It records the
  // camera software's *window*, so if a 2592x1944 sensor is being previewed in a
  // 900x700 panel, 87% of the pixels are gone before this app sees anything; the
  // capture pipeline then re-encodes what is left. Reading the camera directly
  // skips all of that.
  const attachStream = async (stream, mode) => {
    streamRef.current = stream;
    videoRef.current.srcObject = stream;
    await videoRef.current.play();
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => {
      stopAuto();
      setCapturing(false);
      streamRef.current = null;
    });
    const st = track.getSettings ? track.getSettings() : {};
    setSrcInfo({ w: st.width || 0, h: st.height || 0, fps: Math.round(st.frameRate || 0), mode });
    setCapturing(true);
    setSourceMode(mode);
    log('info', `nguồn ${mode === 'camera' ? 'camera' : 'màn hình'}: ${st.width || '?'}×${st.height || '?'} @ ${Math.round(st.frameRate || 0)}fps`);
    autoCrop();
  };

  const listCameras = async () => {
    try {
      // Device labels stay blank until camera permission has been granted at
      // least once, so ask first, then enumerate.
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      /* permission refused: enumerate anyway, labels will be empty */
    }
    const devs = await navigator.mediaDevices.enumerateDevices();
    const cams = devs.filter((d) => d.kind === 'videoinput');
    setCameras(cams);
    if (cams.length > 0 && !deviceId) setDeviceId(cams[0].deviceId);
    return cams;
  };

  const startCamera = async (id) => {
    try {
      // Ask for far more than any microscope camera will give, so the browser
      // negotiates the sensor's own maximum rather than a 640x480 default.
      // resizeMode 'none' tells it not to helpfully rescale on the way out.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(id ? { deviceId: { exact: id } } : {}),
          width: { ideal: 4096 },
          height: { ideal: 4096 },
          frameRate: { ideal: 10, max: 15 },
          resizeMode: 'none',
        },
        audio: false,
      });
      await attachStream(stream, 'camera');
      if (!cameras.length) listCameras().catch(() => {});
    } catch (e) {
      setStatus({
        text: 'Không mở được camera: ' + e.message + '. Nếu phần mềm camera đang giữ thiết bị thì hãy đóng nó, hoặc dùng chế độ ghi màn hình.',
        kind: 'warn',
      });
    }
  };

  const startScreen = async () => {
    try {
      // getDisplayMedia ignores most constraints, but asking for a large frame
      // does stop Chrome capping the capture below the window's own size.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'never', width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 10 }, resizeMode: 'none' },
        audio: false,
      });
      await attachStream(stream, 'screen');
    } catch (e) {
      setStatus({ text: 'Không mở được nguồn hình: ' + e.message, kind: 'warn' });
    }
  };

  // Auto exposure and auto white balance are why tiles differ in brightness and
  // why the joins show as bands: the camera re-decides its levels between frames.
  // Fixing them at their current value costs nothing and removes the cause rather
  // than blending over the symptom.
  const lockCamera = async () => {
    const stream = streamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track.getCapabilities) {
      setStatus({ text: 'Trình duyệt không cho điều khiển camera từ web — hãy tắt auto-exposure/auto-WB trong phần mềm camera.', kind: 'warn' });
      return;
    }
    const caps = track.getCapabilities();
    const advanced = [];
    const got = [];
    if (caps.exposureMode && caps.exposureMode.includes('manual')) { advanced.push({ exposureMode: 'manual' }); got.push('phơi sáng'); }
    if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('manual')) { advanced.push({ whiteBalanceMode: 'manual' }); got.push('cân bằng trắng'); }
    if (caps.focusMode && caps.focusMode.includes('manual')) { advanced.push({ focusMode: 'manual' }); got.push('lấy nét'); }
    if (advanced.length === 0) {
      setLocked([]);
      setStatus({ text: 'Camera này không cho khoá phơi sáng/cân bằng trắng qua web — hãy tắt chế độ tự động trong phần mềm camera.', kind: 'warn' });
      return;
    }
    try {
      await track.applyConstraints({ advanced });
      setLocked(got);
      log('info', 'đã khoá: ' + got.join(', '));
      setStatus({ text: 'Đã khoá ' + got.join(', ') + ' — các ô sẽ đồng nhất về sáng/màu hơn.', kind: 'ok' });
    } catch (e) {
      setStatus({ text: 'Không khoá được: ' + e.message, kind: 'warn' });
    }
  };

  const stop = () => {
    stopAuto();
    setSrcInfo(null);
    setLocked(null);
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
    setTilt(scanAxisTilt(s.tiles));
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
      // Measured on the full-resolution frame, not the downscaled working copy:
      // the question is specifically about per-pixel detail.
      if (s.tiles.length === 0 || s.tiles.length % 10 === 0) {
        const d = pixelDetailRatio(mat);
        if (d !== null) setDetail(d);
      }

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
        // Anchoring corrects accumulated error, which is small per step. Allowing it
        // to move a tile by the full search radius let a false match relocate the
        // tile instead of nudging it.
        const a = alignToMosaic(s.mosaic, gray, scale, w, h, x, y, radius, patchRef.current, ANCHOR_TOL_PX, {
          minAgree: MIN_AGREE,
          maxCorrectionPx: Math.max(12, Math.round(Math.min(w, h) * 0.04)),
        });
        if (a.ok) {
          x = a.x;
          y = a.y;
          anchored = a;
        } else if (a.reason === 'implausible') {
          log('warn', `bỏ neo vào ảnh ghép: lệch dự đoán ${a.correction.toFixed(0)}px > ${a.limit}px — giữ kết quả đo trực tiếp`);
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
      const minStep = Math.max(MIN_STEP_PX, Math.min(w, h) * stepRef.current);
      if (stepPx < minStep) {
        log('skip', `mới dịch ${Math.round(stepPx)}px (cần ≥ ${Math.round(minStep)}px), ${est.used}/${est.total} khung dò đồng ý`);
        return;
      }

      const index = await addTile(mat, w, h, blobPromise, x, y, sharp, isBlurry);
      freeRef(s.refTile);
      s.refTile = { gray: s.refPrev.gray.clone(), scale, x, y };
      log('ok', `ô #${index + 1} tại (${Math.round(x)}, ${Math.round(y)}) · dịch ${fmt(dx)},${fmt(dy)}` +
        ` · ${est.used}/${est.total} khung dò đồng ý (điểm ${est.score.toFixed(2)}, tán ${est.spread.toFixed(1)}px)` +
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
      // Relocalisation moves the tile anywhere in the scan, so it has to clear a
      // higher bar than an ordinary measurement: four of five patches, not three.
      const fine = alignToMosaic(s.mosaic, gray, scale, w, h, c.x, c.y, radius, patchRef.current, ANCHOR_TOL_PX, {
        minAgree: 4,
      });
      if (!fine.ok) {
        log('skip', `ứng viên tìm lại vị trí bị loại (${fine.reason})`);
        return null;
      }
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
    setTilt(null);
    setDetail(null);
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

  // Anything that produces output starts here. During a scan the mosaic carries a
  // deliberate empty margin from chunked growth; every output step wants the
  // picture, not the buffer it lives in.
  const trimToContent = () => {
    const s = S.current;
    if (!s.mosaic || s.tiles.length === 0) return false;
    const before = `${s.mosaic.w}×${s.mosaic.h}`;
    if (!M.trimMosaic(s.mosaic, s.tiles, excluded)) return false;
    dropCoarse();
    paintAll();
    refreshMinimap();
    log('info', `cắt viền trống: ${before} → ${s.mosaic.w}×${s.mosaic.h}`);
    return true;
  };

  // ---- review & fuse before export ----
  const runFusion = async (method) => {
    const s = S.current;
    if (!s.mosaic || s.tiles.length === 0 || busyLabel) return;
    stopAuto();
    trimToContent();
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
      await rebuild(); // re-allocates the mosaic exactly around the new positions
      // The honest headline is not the residual, it is whether there were any
      // cross-links at all: a chain of consecutive links cannot tell that the
      // chain as a whole has bent, so with none of them the solve can converge
      // beautifully and still leave the scan just as skewed as before.
      const noCross = r.crossLinks < Math.max(2, r.links * 0.1);
      setStatus({
        text: noCross
          ? `Đã tối ưu nhưng chỉ có ${r.crossLinks} cặp "chéo" (giữa các ô không chụp liền nhau) trên ${r.links} cặp. ` +
            'Đó là loại cặp duy nhất sửa được trôi tích luỹ — không có chúng thì chuỗi ô không có cách nào biết là nó đã bị bẻ cong. ' +
            'Cần quét sao cho các cột/hàng chồng lấn lên nhau, rồi chạy lại.'
          : `Đã tối ưu ${s.tiles.length} ô từ ${r.links}/${r.pairs} cặp (${r.crossLinks} cặp chéo). ` +
            `Sai lệch trung bình: ${r.beforeResidual.toFixed(1)}px → ${r.afterResidual.toFixed(1)}px. ` +
            `Ô dịch nhiều nhất ${r.maxMove.toFixed(0)}px.`,
        kind: noCross ? 'warn' : 'ok',
      });
      log('info', `tối ưu: ${r.links}/${r.pairs} cặp (${r.crossLinks} chéo), sai lệch ${r.beforeResidual.toFixed(1)}→${r.afterResidual.toFixed(1)}px, bỏ ${r.dropped} cặp lỗi`);
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
    trimToContent();
    let out;
    try {
      out = M.renderForExport(s.mosaic, { straightenRad: straighten && tilt ? tilt.rad : 0 });
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
        text: (out.rotated ? `Đã xoay thẳng trục ${tilt.deg.toFixed(1)}°. ` : '') + (out.scale < 1
          ? `Đã xuất PNG nhưng thu nhỏ ${Math.round(out.scale * 100)}% (vượt giới hạn canvas). Muốn đủ độ phân giải thì dùng bản ZIP.`
          : `Đã xuất PNG ${out.w}×${out.h} ở độ phân giải gốc.`),
        kind: out.scale < 1 ? 'warn' : 'ok',
      });
    }, 'image/png');
  };

  const exportZip = async () => {
    const s = S.current;
    if (s.tiles.length === 0 || busyLabel) return;
    setBusyLabel('Đang đóng gói…');
    // Trim first so the manifest coordinates are relative to the top-left of the
    // exported mosaic, not to a buffer origin that no output file describes.
    trimToContent();
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
      // Tile coordinates in the manifest are in the UNROTATED frame — the one the
      // tiles were actually measured in. Straightening is a transform applied to
      // the exported PNG after the fact, so the angle is recorded here rather than
      // baked into numbers that would no longer match the tile images.
      zip.file(
        'scan_info.txt',
        [
          `tiles: ${s.tiles.length}`,
          `excluded: ${excluded.size}`,
          `mosaic_px: ${s.mosaic.w}x${s.mosaic.h}`,
          tilt ? `scan_axis_tilt_deg: ${tilt.deg.toFixed(3)}` : 'scan_axis_tilt_deg: unknown',
          tilt ? `scan_axis_tilt_spread_deg: ${tilt.madDeg.toFixed(3)}` : '',
          'note: manifest.csv coordinates are in the unrotated frame',
          'note: straightening, if used, applies to the exported PNG only',
          `exported_at: ${new Date().toISOString()}`,
        ].filter(Boolean).join('\n') + '\n'
      );
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
              <>
                <div className="row">
                  <button className="primary" disabled={!cvReady} onClick={() => startCamera(deviceId)}>
                    Camera trực tiếp
                  </button>
                  <button disabled={!cvReady} onClick={startScreen}>Ghi màn hình</button>
                </div>
                <div className="gap" />
                <div className="row">
                  <select
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                    disabled={cameras.length === 0}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    {cameras.length === 0 ? (
                      <option value="">— chưa dò camera —</option>
                    ) : (
                      cameras.map((c, i) => (
                        <option key={c.deviceId} value={c.deviceId}>
                          {c.label || `Camera ${i + 1}`}
                        </option>
                      ))
                    )}
                  </select>
                  <button onClick={() => listCameras().catch(() => {})} style={{ flex: 'none', width: 'auto' }}>
                    Dò
                  </button>
                </div>
                <div className="note">
                  <b>Camera trực tiếp</b> đọc thẳng từ cảm biến, nhưng phần lớn camera kính 3 mắt <b>không
                  xuất hiện như thiết bị UVC</b> cho trình duyệt — phần mềm của hãng giữ độc quyền. Nếu vậy
                  thì ghi màn hình là đường duy nhất, và vẫn kéo được chất lượng lên rất nhiều.
                </div>
                <div className="alert">
                  <b>Ghi màn hình: đặt zoom phần mềm camera về 100% (1:1).</b>
                  <br /><br />
                  Đây là đòn bẩy lớn nhất và nó phản trực giác. Nếu phần mềm đang thu ảnh 2592×1944 cho vừa
                  cửa sổ 700px, thì mỗi pixel bạn chụp được là kết quả nội suy của 3.7 pixel cảm biến — chi
                  tiết đã mất và không bước nào lấy lại được. Ở zoom 100%, cùng cửa sổ đó chỉ hiện <i>một
                  phần</i> quang trường, nhưng <b>mỗi pixel là một pixel cảm biến thật</b>.
                  <br /><br />
                  Quang trường nhỏ hơn không phải vấn đề — <b>app này ghép ảnh</b>. Bạn chỉ cần kéo tiêu bản
                  nhiều hơn. Một trường nhỏ mà sắc nét thì luôn tốt hơn một trường rộng đã bị thu nhỏ:
                  trường hợp đầu ghép lại thành ảnh lớn và nét, trường hợp sau thì mềm ở mọi mức phóng đại.
                  <br /><br />
                  Ba việc kèm theo: chọn <b>cửa sổ camera</b> trong hộp chọn của trình duyệt (không chọn
                  "toàn màn hình"); phóng cửa sổ đó <b>to hết mức</b> trên màn hình lớn nhất bạn có; và tắt
                  mọi bộ lọc làm mịn/sharpen trong phần mềm camera.
                  <br /><br />
                  Chỉ số <b>Chi tiết mức pixel</b> ở trên là cách kiểm chứng: đổi zoom rồi xem con số đó
                  tăng hay không. Trên 55% là nguồn đang tốt.
                </div>
              </>
            ) : (
              <>
                <div className="row">
                  <button className="danger" onClick={stop}>Dừng ghi</button>
                  {sourceMode === 'camera' && (
                    <button onClick={lockCamera}>Khoá phơi sáng / WB</button>
                  )}
                </div>
                {srcInfo && (
                  <div className={'note mono' + (srcInfo.w > 0 && srcInfo.w < 1280 ? ' amber' : '')}>
                    Nguồn {srcInfo.mode === 'camera' ? 'camera' : 'màn hình'}:{' '}
                    <b>{srcInfo.w}×{srcInfo.h}</b> @ {srcInfo.fps}fps
                    {cropBox && <> · vùng quét {cropBox.w}×{cropBox.h}</>}
                    {srcInfo.w > 0 && srcInfo.w < 1280 && (
                      <>
                        <br />
                        Nguồn khá nhỏ. Nếu đang ghi màn hình, hãy phóng to cửa sổ camera và đặt zoom 1:1,
                        hoặc chuyển sang Camera trực tiếp.
                      </>
                    )}
                  </div>
                )}
                {srcInfo && cropBox && (() => {
                  // The whole resolution question in three numbers. A tile's pixel
                  // count sets the ceiling for everything: no later step adds
                  // detail, and a mosaic is roughly tileMP * tiles * step^2.
                  const tileMP = (cropBox.w * cropBox.h) / 1e6;
                  const srcMP = (srcInfo.w * srcInfo.h) / 1e6;
                  const cropFrac = srcMP > 0 ? (cropBox.w * cropBox.h) / (srcInfo.w * srcInfo.h) : 0;
                  const per100 = tileMP * 100 * stepFrac * stepFrac;
                  const thin = tileMP < 0.5;
                  return (
                    <div className={'note mono' + (thin ? ' alert' : '')}>
                      Mỗi ô: <b>{cropBox.w}×{cropBox.h}</b> = {tileMP.toFixed(2)} MP
                      <span className="dim"> ({Math.round(cropFrac * 100)}% diện tích nguồn)</span>
                      <br />
                      Với bước hiện tại, 100 ô ≈ <b>{per100.toFixed(0)} MP</b> ảnh ghép.
                      {thin && (
                        <>
                          <br /><br />
                          Vùng quét quá nhỏ — đây là thứ chặn độ phân giải, không phải bước xuất. Không có
                          bước nào sau lúc chụp thêm được chi tiết.
                          {srcInfo.mode === 'screen' && (
                            <>
                              {' '}Bạn đang ghi màn hình ở {srcInfo.w}×{srcInfo.h}, tức toàn bộ màn hình —
                              cửa sổ camera chỉ chiếm một phần trong đó. Chuyển sang <b>Camera trực tiếp</b>{' '}
                              để đọc thẳng cảm biến: một camera 2592×1944 cho ô ~2000×1600 = 3.2 MP, gấp{' '}
                              {(3.2 / Math.max(tileMP, 0.01)).toFixed(0)}× hiện tại.
                            </>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}
                {detail !== null && (
                  <div className={'note mono' + (detail < 0.35 ? ' alert' : '')}>
                    Chi tiết mức pixel: <b>{Math.round(detail * 100)}%</b>
                    {detail >= 0.55 ? (
                      <span style={{ color: 'var(--teal)' }}> — ảnh sắc đến từng pixel, nguồn đang tốt.</span>
                    ) : detail >= 0.35 ? (
                      <span className="dim"> — tạm được, còn dư địa nếu tăng zoom camera lên 100%.</span>
                    ) : (
                      <>
                        {' '}— <b>ảnh đã bị nội suy/làm mềm</b>. Số pixel đang nhiều hơn lượng chi tiết thật:
                        phần mềm camera đang thu ảnh cảm biến cho vừa cửa sổ, và app chỉ nhận được bản đã
                        resample đó. Xem hướng dẫn ở dưới.
                      </>
                    )}
                  </div>
                )}
                {locked && locked.length > 0 && (
                  <div className="note mono" style={{ color: 'var(--teal)' }}>Đã khoá: {locked.join(', ')}</div>
                )}
              </>
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
              kết quả mà <b>ít nhất {MIN_AGREE}/5 khung đồng ý</b> với nhau (lệch dưới {AGREE_TOL_PX}px).
              Bước tìm lại vị trí sau khi mất dấu đòi 4/5, vì nó dịch ô đi xa nên cần chứng cứ mạnh hơn.
              Nhờ vậy một khung dò vô tình nằm trên vật cố định — bụi, viền halo, overlay — sẽ báo
              "không dịch chuyển", lệch khỏi nhóm, và bị loại; nó không kéo được kết quả đi.
            </div>
            <div className="note">
              Nhỏ thì an toàn hơn với vật cố định <i>và</i> tầm với xa hơn, nhưng cần vùng có chi tiết.
              Có <b>sàn tuyệt đối {PATCH_MIN_PX}px</b>: ở 8% của một vùng quét 444px thì khung dò chỉ
              36×36px — quá ít nội dung để tương quan, và biểu hiện đúng là dòng "1/5 khung dò định vị
              được" lặp lại mãi trong lúc ảnh ghép đứng im. Tỉ lệ quyết định tầm với; sàn này quyết định
              có gì để khớp hay không.
              {patchPx > 0 && <> Hiện tại mỗi khung dò ≈ <span className="mono">{patchPx}×{patchPx}px</span> ở độ phân giải xử lý.</>}
            </div>
          </div>

          <div className="block">
            <h2>3 · Mật độ ô</h2>
            <div className="row">
              {STEP_PRESETS.map((p) => (
                <button key={p.frac} className={stepFrac === p.frac ? 'primary' : ''} onClick={() => setStepFrac(p.frac)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="note">{STEP_PRESETS.find((p) => p.frac === stepFrac).note}</div>
            <div className="note">
              Một ô được ghi khi ảnh đã dịch được phần này của khung. Trước đây nó cố định ở 8% — tức
              <b> 92% chồng lấn</b>, nên 82 ô chỉ phủ vừa hơn ba khung nhìn. Chồng lấn nhiều không làm giảm
              độ phân giải, nhưng nó khiến một phiên quét dài vẫn cho ra ảnh nhỏ.
            </div>
          </div>

          <div className="block">
            <h2>4 · Chống trôi</h2>
            <label className="check">
              <input type="checkbox" checked={anchor} onChange={(e) => setAnchor(e.target.checked)} />
              <span>Neo từng ô vào ảnh ghép</span>
            </label>
            <div className="note">
              Bật (khuyến nghị): vị trí mỗi ô được đo <b>so với ảnh ghép đã dựng</b>, không phải so với ô
              liền trước.
            </div>
            <div className="note amber">
              Nhưng nó <b>không chặn được trôi ở mép đang quét</b>, và tôi đã nói quá điều này ở bản trước.
              Ngay tại mép, thứ duy nhất có trong ảnh ghép quanh khung mới là chính ô vừa đặt — nên "neo vào
              ảnh ghép" ở đó không khác gì neo vào ô liền trước, và sai số vẫn cộng dồn. Nó chỉ thật sự giúp
              khi khung mới chồng lên <i>nhiều</i> ô cũ, tức khi đường quét đi ngược lại cạnh một cột đã quét.
              <br /><br />
              Thứ sửa được trôi đã tích luỹ là bước <b>Tối ưu vị trí toàn cục</b> ở dưới — và nó cần các
              cột/hàng <b>chồng lấn lên nhau</b> mới có ràng buộc để giải.
            </div>
            <div className="note">
              Tắt nếu muốn thấy đúng chuỗi đo thô (chỉ để chẩn đoán). Nhật ký ghi
              <code> neo vào ảnh ghép (chỉnh Npx)</code> — N là mức sai số vừa được sửa; N tăng dần theo
              đường quét chính là lượng trôi mà bước này đang bù.
            </div>
          </div>

          <div className="block" style={{ borderColor: running ? 'var(--teal)' : 'var(--line)' }}>
            <h2>5 · Chạy</h2>
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
              {(() => {
                // The buffer is larger than the picture while scanning, by design.
                // Say so, so the number above isn't mistaken for the export size.
                const b = tileCount > 0 ? M.contentBounds(S.current.tiles, excluded) : null;
                if (!b) return null;
                const cwPx = Math.ceil(b.maxX) - Math.floor(b.minX);
                const chPx = Math.ceil(b.maxY) - Math.floor(b.minY);
                if (cwPx === dims.w && chPx === dims.h) return null;
                return (
                  <>
                    <br />
                    <span className="dim">
                      Nội dung thật: <span className="mono">{cwPx}×{chPx}px</span> — viền trống sẽ được
                      cắt tự động khi xuất.
                    </span>
                  </>
                );
              })()}
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
            <h2>6 · Tối ưu vị trí toàn cục</h2>
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
            {tilt && (
              <div className={'note' + (Math.abs(tilt.deg) > 0.5 && tilt.madDeg < 1.5 ? ' alert' : '')}>
                Trục quét lệch <b className="mono">{tilt.deg.toFixed(1)}°</b> so với trục ảnh
                <span className="dim"> (tán {tilt.madDeg.toFixed(1)}°, {tilt.n} bước)</span>.
                {Math.abs(tilt.deg) > 0.5 && tilt.madDeg < 1.5 ? (
                  <>
                    <br /><br />
                    Tán nhỏ nghĩa là góc này <b>giống nhau ở mọi bước</b> — nó là đặc tính của bộ thiết bị
                    chứ không phải sai số tích luỹ: cảm biến camera không thẳng trục với bàn cơ. Kéo thuần
                    trục X thì ảnh vẫn dịch chéo {tilt.deg.toFixed(1)}°, ở bước 700px là{' '}
                    {Math.abs(700 * Math.sin(tilt.rad)).toFixed(0)}px lệch ngang mỗi bước.
                    <br /><br />
                    <b>Không có gì sai ở đây.</b> Các ô được đặt đúng chỗ nội dung của chúng, ảnh liền mạch,
                    chỉ đường viền là méo. Tối ưu toàn cục không "sửa" được vì không có gì để sửa — cách xử
                    lý là xoay ảnh thành phẩm một lần, bằng tuỳ chọn dưới đây.
                  </>
                ) : (
                  <>
                    <br />
                    Tán lớn nghĩa là hướng đi thay đổi giữa các bước, nên đây <i>không</i> phải lệch trục cố
                    định — nếu ảnh méo thì là trôi tích luỹ, hãy xem số cặp chéo ở dưới.
                  </>
                )}
              </div>
            )}
            <label className="check" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={straighten} onChange={(e) => setStraighten(e.target.checked)} />
              <span>Xoay thẳng trục khi xuất PNG{tilt ? ` (${tilt.deg.toFixed(1)}°)` : ''}</span>
            </label>
            <div className="note">
              Xoay <b>một lần cho cả ảnh</b> ở bước xuất, không xoay từng ô — mức nội suy ít nhất có thể,
              và là chỗ duy nhất trong toàn bộ đường đi có nội suy. Góc xoay được ghi vào
              <code> scan_info.txt</code> trong bản ZIP.
            </div>
            {optStats && (
              <div className="note mono" style={{ color: 'var(--teal)' }}>
                {optStats.links}/{optStats.pairs} cặp đo được, trong đó{' '}
                <b style={{ color: optStats.crossLinks < 2 ? 'var(--amber)' : 'var(--teal)' }}>
                  {optStats.crossLinks} cặp chéo
                </b>{' '}
                · sai lệch trung bình {optStats.beforeResidual.toFixed(1)}px →{' '}
                {optStats.afterResidual.toFixed(1)}px · bỏ {optStats.dropped} cặp lỗi · dịch tối đa{' '}
                {optStats.maxMove.toFixed(0)}px
              </div>
            )}
          </div>

          <div className="block" style={{ borderColor: fused ? 'var(--teal)' : 'var(--amber)' }}>
            <h2>7 · Hậu kiểm pixel trước khi xuất</h2>
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
            {tileCount > 0 && (() => {
              // Told before clicking, not after: the only step in the whole
              // pipeline that can reduce resolution is a mosaic too large for a
              // browser canvas, and it is worth knowing that in advance.
              //
              // Measured on the CONTENT bounds, not on dims — dims is the buffer,
              // which carries the empty growth margin. Reporting the buffer here
              // would predict a downscale that trimming then makes unnecessary.
              const b = M.contentBounds(S.current.tiles, excluded);
              if (!b) return null;
              const cwPx = Math.ceil(b.maxX) - Math.floor(b.minX);
              const chPx = Math.ceil(b.maxY) - Math.floor(b.minY);
              const es = M.fitScale(cwPx, chPx, M.EXPORT_MAX_DIM, M.EXPORT_MAX_AREA);
              const mp = (cwPx * chPx) / 1e6;
              const dims = { w: cwPx, h: chPx };
              return es < 1 ? (
                <div className="note mono amber">
                  Ảnh ghép {dims.w}×{dims.h} ({mp.toFixed(0)} MP) vượt giới hạn canvas của trình duyệt —
                  PNG sẽ bị thu nhỏ còn {Math.round(es * 100)}%. Muốn giữ đủ độ phân giải thì dùng bản
                  xuất ZIP: ảnh gốc từng ô là PNG không mất dữ liệu.
                </div>
              ) : (
                <div className="note mono">
                  PNG sẽ xuất ở đúng {dims.w}×{dims.h} ({mp.toFixed(1)} MP), không mất dữ liệu.
                </div>
              );
            })()}
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
