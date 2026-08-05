/* global cv */
import { useState, useRef, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import './App.css';
import { IDENT, matMul3, translateM, cornersOf, bboxOf, findAnchorTile, angleOf, applyInverseLinear } from './matrix.js';
import { computeFeatures, matchTiles, computeSharpness, detectVignetteRect } from './cvMatch.js';
import { addEdge, removeEdgesForTile, relax, maxRenderedDrift } from './graph.js';
import * as db from './db.js';

const INIT_PAD = 40;
const AUTO_INTERVAL_MS = 350; // how often the continuous loop samples a frame
const AUTO_FAIL_WARN = 6; // consecutive unhandled failures before warning the user
const AUTO_MOVE_MIN_PX = 18; // minimum translation (px) before a frame is worth integrating
const AUTO_MOVE_MIN_RATIO = 0.025; // ...as a fraction of frame width, whichever is larger
const ANCHOR_EXCLUDE_COUNT = 8; // don't treat the last N tiles as "revisits" — they're just normal chain overlap
const ANCHOR_MIN_TILES = ANCHOR_EXCLUDE_COUNT + 2;
const EXTRAPOLATE_MIN_PX = 3; // minimum recent motion before it's worth extrapolating a guess
const RELAX_ITERS_PER_TICK = 6; // small warm-started relaxation pass, run every tick
const GUESS_EDGE_WEIGHT = 1; // low confidence for extrapolated (unmatched) placements
const REBUILD_DRIFT_PX = 6; // repaint the mosaic once any already-painted tile drifts this much
const REBUILD_MIN_TILES = 25; // ...but don't repaint more often than every N new tiles
const REBUILD_MAX_MS = 8000; // ...or longer than this since the last repaint, if dirty
const SHARPNESS_HISTORY_SIZE = 30; // recent "good" tiles used as the running focus baseline
const SHARPNESS_MIN_SAMPLES = 5; // don't flag anything until we have a baseline
const SHARPNESS_BLUR_RATIO = 0.4; // flag a tile if its sharpness < 40% of the recent median

function tileBBox(transform, w, h) {
  return bboxOf(cornersOf(transform, w, h));
}

// Maps the displayed (CSS-pixel) video content area within its container,
// accounting for object-fit:contain letterboxing, so mouse drags can be
// converted into native video pixel coordinates.
function getVideoContentRect(container, video) {
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return { x: 0, y: 0, w: cw, h: ch, scale: 1 };
  const scale = Math.min(cw / vw, ch / vh);
  const dispW = vw * scale;
  const dispH = vh * scale;
  return { x: (cw - dispW) / 2, y: (ch - dispH) / 2, w: dispW, h: dispH, scale };
}

function TileThumb({ blob }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img src={url} alt="" className="tile-thumb" /> : <div className="tile-thumb" />;
}

function ZStackScrubber({ zstack }) {
  const [idx, setIdx] = useState(0);
  const layer = zstack[Math.min(idx, zstack.length - 1)];
  return (
    <div className="zstack-scrub">
      <TileThumb blob={layer.blob} />
      <input
        type="range"
        min={0}
        max={zstack.length - 1}
        value={idx}
        onChange={(e) => setIdx(Number(e.target.value))}
      />
      <span className="mono" style={{ fontSize: 10, color: 'var(--ink-dim)' }}>
        lớp {idx + 1}/{zstack.length}
      </span>
    </div>
  );
}

export default function App() {
  const [cvReady, setCvReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [tileCount, setTileCount] = useState(0);
  const [matchInfo, setMatchInfo] = useState({ text: 'Chưa có ô nào', kind: 'idle' });
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 });
  const [pipActive, setPipActive] = useState(false);
  const [pipSupported, setPipSupported] = useState(true);
  const [exportingZip, setExportingZip] = useState(false);
  const [cropBox, setCropBox] = useState(null); // {x,y,w,h} in native video px — for rendering the overlay
  const [dragRect, setDragRect] = useState(null); // {x,y,w,h} in container CSS px — live drag feedback
  const [resumePrompt, setResumePrompt] = useState(null); // {count} | null
  const [blurryCount, setBlurryCount] = useState(0);
  const [cropAuto, setCropAuto] = useState(false); // true when the current cropBox came from auto-vignette-detection
  const [showTilePanel, setShowTilePanel] = useState(false);
  const [tilePanelShowAll, setTilePanelShowAll] = useState(false);
  const [tilePanelVersion, setTilePanelVersion] = useState(0); // bump to force the panel list to re-render
  const [recapturingIndex, setRecapturingIndex] = useState(null);
  const [zCaptureIndex, setZCaptureIndex] = useState(null);
  const [zLayers, setZLayers] = useState([]);
  const [targetMode, setTargetMode] = useState(false);
  const [targetWorld, setTargetWorld] = useState(null); // {x,y} in world coords, or null
  const [targetConfirming, setTargetConfirming] = useState(false);

  const videoRef = useRef(null);
  const pipVideoRef = useRef(null);
  const previewContainerRef = useRef(null);
  const mosaicCanvasRef = useRef(null);
  const workCanvasRef = useRef(document.createElement('canvas'));
  const streamRef = useRef(null);
  const autoTimerRef = useRef(null);
  const cropRef = useRef(null); // {x,y,w,h} in native video px, read by grabVideoFrame
  const dragStartRef = useRef(null);

  const cv_ = useRef({
    mosaicMat: null,
    originX: INIT_PAD,
    originY: INIT_PAD,
    w: 0,
    h: 0,
    tiles: [], // {transform:[9], w, h, blob, bbox, capturedAt, estimated?, renderedTx, renderedTy}
    edges: [], // {a, b, dx, dy, w} — pairwise translation observations between tile indices
    adjacency: [], // adjacency[tileIndex] -> list of edges touching that tile
    autoFails: 0,
    busy: false,
    lastRebuildTileCount: 0,
    lastRebuildTime: 0,
    sharpnessHistory: [],
    activeRefIndex: null, // set by manual "confirm target" positioning; overrides the default "chain from last tile"
  });

  const uiRef = useRef({ cvReady: false, capturing: false });
  useEffect(() => { uiRef.current.cvReady = cvReady; }, [cvReady]);
  useEffect(() => { uiRef.current.capturing = capturing; }, [capturing]);

  // ---- load opencv.js (script tag is included in index.html) ----
  useEffect(() => {
    const check = setInterval(() => {
      if (window.cv && window.cv.Mat) {
        clearInterval(check);
        setCvReady(true);
      }
    }, 150);
    return () => clearInterval(check);
  }, []);

  // ---- crash/close recovery: check for a previous session once OpenCV is ready ----
  useEffect(() => {
    if (!cvReady) return;
    (async () => {
      try {
        const count = await db.countTiles();
        if (count > 0) setResumePrompt({ count });
      } catch (e) {
        // IndexedDB unavailable (private browsing, old browser, etc.) — silently
        // proceed without resume support; nothing else depends on it.
      }
    })();
  }, [cvReady]);

  const continueSession = async () => {
    const c = cv_.current;
    try {
      const [tiles, meta] = await Promise.all([db.loadAllTiles(), db.loadMeta()]);
      freeAllTileFeatures(c.tiles);
      c.tiles = tiles.map((t) => ({ ...t, renderedTx: undefined, renderedTy: undefined }));
      c.edges = (meta && meta.edges) || [];
      c.adjacency = [];
      for (const e of c.edges) {
        (c.adjacency[e.a] ||= []).push(e);
        (c.adjacency[e.b] ||= []).push(e);
      }
      c.sharpnessHistory = tiles.filter((t) => !t.blurry && t.sharpness).map((t) => t.sharpness).slice(-SHARPNESS_HISTORY_SIZE);
      c.activeRefIndex = null;
      setBlurryCount(tiles.filter((t) => t.blurry).length);
      setResumePrompt(null);
      setMatchInfo({ text: `Đang khôi phục ${tiles.length} ô từ phiên trước…`, kind: 'idle' });
      await rebuildMosaic();
      setMatchInfo({ text: `Đã khôi phục ${tiles.length} ô. Bấm "Định vị thủ công", chọn điểm cần tiếp tục trên ảnh ghép, rồi xác nhận trước khi quét tiếp — hoặc bấm "Bắt đầu ghép tự động" luôn nếu chắc chắn vẫn đang ở cuối vùng đã quét.`, kind: 'ok' });
    } catch (e) {
      setMatchInfo({ text: 'Không thể khôi phục phiên trước: ' + e.message, kind: 'warn' });
      setResumePrompt(null);
    }
  };

  const discardSession = async () => {
    try {
      await db.clearAll();
    } catch (e) {
      // ignore
    }
    setResumePrompt(null);
  };

  // ---- floating "picture-in-picture" preview window ----
  useEffect(() => {
    const supported = 'pictureInPictureEnabled' in document && typeof HTMLCanvasElement.prototype.captureStream === 'function';
    setPipSupported(supported);
  }, []);

  useEffect(() => {
    const v = pipVideoRef.current;
    if (!v) return;
    const onEnter = () => setPipActive(true);
    const onLeave = () => setPipActive(false);
    v.addEventListener('enterpictureinpicture', onEnter);
    v.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      v.removeEventListener('enterpictureinpicture', onEnter);
      v.removeEventListener('leavepictureinpicture', onLeave);
    };
  }, []);

  const pipStreamRef = useRef(null);

  const ensurePipStream = async () => {
    if (pipStreamRef.current) return; // already set up this session — reuse it
    const stream = mosaicCanvasRef.current.captureStream(15);
    pipStreamRef.current = stream;
    pipVideoRef.current.srcObject = stream;
    await pipVideoRef.current.play();
  };

  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      if (!mosaicCanvasRef.current || !pipVideoRef.current) return;
      await ensurePipStream();
      await pipVideoRef.current.requestPictureInPicture();
    } catch (e) {
      setMatchInfo({ text: 'Không thể mở cửa sổ nổi: ' + e.message, kind: 'warn' });
    }
  };

  const paintCanvas = useCallback((mat) => {
    if (!mosaicCanvasRef.current) return;
    cv.imshow(mosaicCanvasRef.current, mat);
    setCanvasDims({ w: mat.cols, h: mat.rows });
  }, []);

  const ensureMosaic = useCallback((w, h) => {
    const c = cv_.current;
    if (!c.mosaicMat) {
      c.w = w;
      c.h = h;
      c.mosaicMat = new cv.Mat(h, w, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 0));
    }
  }, []);

  const growCanvasIfNeeded = useCallback((transform, tw, th) => {
    const c = cv_.current;
    const corners = cornersOf(matMul3(translateM(c.originX, c.originY), transform), tw, th);
    const { minX, minY, maxX, maxY } = bboxOf(corners);
    const growLeft = Math.max(0, Math.ceil(-minX));
    const growTop = Math.max(0, Math.ceil(-minY));
    const growRight = Math.max(0, Math.ceil(maxX - c.w));
    const growBottom = Math.max(0, Math.ceil(maxY - c.h));
    if (growLeft || growTop || growRight || growBottom) {
      const newW = c.w + growLeft + growRight;
      const newH = c.h + growTop + growBottom;
      const newMat = new cv.Mat(newH, newW, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 0));
      const roi = newMat.roi(new cv.Rect(growLeft, growTop, c.w, c.h));
      c.mosaicMat.copyTo(roi);
      roi.delete();
      c.mosaicMat.delete();
      c.mosaicMat = newMat;
      c.originX += growLeft;
      c.originY += growTop;
      c.w = newW;
      c.h = newH;
      paintCanvas(c.mosaicMat);
    }
  }, [paintCanvas]);

  const composite = useCallback((mat, transform, tw, th, targetMat) => {
    const c = cv_.current;
    const Tc = matMul3(translateM(c.originX, c.originY), transform);
    const Tmat = cv.matFromArray(3, 3, cv.CV_64FC1, Tc);
    const warped = new cv.Mat();
    cv.warpPerspective(mat, warped, Tmat, new cv.Size(c.w, c.h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
    const channels = new cv.MatVector();
    cv.split(warped, channels);
    const alpha = channels.get(3);
    const mask = new cv.Mat();
    // Only trust fully-opaque pixels: near the tile's edge, linear interpolation
    // blends real content with the transparent (black) border, which darkens
    // those pixels even though their alpha isn't quite zero. A loose threshold
    // let that blended ring through, showing up as a thin dark seam at every
    // tile boundary.
    cv.threshold(alpha, mask, 250, 255, cv.THRESH_BINARY);
    // Erode a couple more pixels off the valid region as a safety margin, in
    // case of small misregistration at the boundary too.
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.erode(mask, mask, kernel, new cv.Point(-1, -1), 2);
    kernel.delete();
    warped.copyTo(targetMat, mask);
    Tmat.delete();
    warped.delete();
    channels.delete();
    alpha.delete();
    mask.delete();
  }, []);

  const blobToMat = useCallback(async (blob) => {
    const bitmap = await createImageBitmap(blob);
    const tmp = document.createElement('canvas');
    tmp.width = bitmap.width;
    tmp.height = bitmap.height;
    tmp.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    return cv.imread(tmp);
  }, []);

  // Compares this tile's Laplacian-variance sharpness against the running
  // median of recent "good" tiles, since what counts as "sharp" depends on
  // scene/magnification. Only non-blurry tiles feed the baseline, so a run of
  // blur doesn't drag the threshold down with it.
  const classifySharpness = (value) => {
    const c = cv_.current;
    let blurry = false;
    if (c.sharpnessHistory.length >= SHARPNESS_MIN_SAMPLES) {
      const sorted = [...c.sharpnessHistory].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (value < median * SHARPNESS_BLUR_RATIO) blurry = true;
    }
    if (!blurry) {
      c.sharpnessHistory.push(value);
      if (c.sharpnessHistory.length > SHARPNESS_HISTORY_SIZE) c.sharpnessHistory.shift();
    }
    return blurry;
  };

  const evaluateSharpness = (mat) => {
    const value = computeSharpness(mat);
    return { value, blurry: classifySharpness(value) };
  };

  // Fire-and-forget: don't block the real-time capture loop on disk I/O, but
  // do surface a warning if IndexedDB writes start failing (e.g. quota).
  const persistTile = (index, tile) => {
    const record = {
      index, transform: tile.transform, w: tile.w, h: tile.h, blob: tile.blob,
      bbox: tile.bbox, capturedAt: tile.capturedAt, estimated: !!tile.estimated,
      sharpness: tile.sharpness, blurry: !!tile.blurry,
    };
    if (tile.zstack) record.zstack = tile.zstack;
    db.saveTile(record).catch((e) => {
      setMatchInfo({ text: 'Cảnh báo: không lưu được ảnh vào bộ nhớ tạm (' + e.message + ') — mất dữ liệu nếu tab bị đóng.', kind: 'warn' });
    });
  };

  const persistMeta = () => {
    const c = cv_.current;
    db.saveMeta({ edges: c.edges, tileCount: c.tiles.length, updatedAt: Date.now() }).catch(() => {});
  };

  // Every tile permanently caches its own ORB features (kp/desc) once computed,
  // instead of the old single-slot "last tile only" cache. This matters a lot
  // for anchor/loop-closure checks and relocalization, which compare the
  // current frame against arbitrary OLDER tiles, not just the most recent one
  // — without this, every such check was re-decoding the tile's PNG blob and
  // re-running ORB detection from scratch, every single time, even for tiles
  // checked repeatedly (e.g. a busy anchor spot revisited across a zigzag).
  const getTileFeatures = async (tile) => {
    if (tile._kp && tile._desc) return { kp: tile._kp, desc: tile._desc };
    const mat = await blobToMat(tile.blob);
    const feat = computeFeatures(mat);
    mat.delete();
    tile._kp = feat.kp;
    tile._desc = feat.desc;
    return feat;
  };

  // cv.Mat isn't garbage-collected — any tile we discard (undo, replace via
  // recapture, reset, or overwritten by import/resume) must explicitly free
  // its cached features or the WASM heap leaks over a long session.
  const freeTileFeatures = (tile) => {
    if (tile._kp) {
      tile._kp.delete();
      tile._kp = null;
    }
    if (tile._desc) {
      tile._desc.delete();
      tile._desc = null;
    }
  };

  const freeAllTileFeatures = (tiles) => {
    for (const t of tiles) freeTileFeatures(t);
  };

  const rebuildMosaic = useCallback(async () => {
    const c = cv_.current;
    if (c.mosaicMat) {
      c.mosaicMat.delete();
      c.mosaicMat = null;
    }
    c.originX = INIT_PAD;
    c.originY = INIT_PAD;
    const first = c.tiles[0];
    c.w = (first ? first.w : 800) + INIT_PAD * 2;
    c.h = (first ? first.h : 600) + INIT_PAD * 2;
    c.mosaicMat = new cv.Mat(c.h, c.w, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 0));
    for (const tile of c.tiles) {
      growCanvasIfNeeded(tile.transform, tile.w, tile.h);
      const mat = await blobToMat(tile.blob);
      composite(mat, tile.transform, tile.w, tile.h, c.mosaicMat);
      mat.delete();
      tile.renderedTx = tile.transform[2];
      tile.renderedTy = tile.transform[5];
    }
    paintCanvas(c.mosaicMat);
    c.lastRebuildTileCount = c.tiles.length;
    c.lastRebuildTime = Date.now();
    setTileCount(c.tiles.length);
  }, [composite, blobToMat, growCanvasIfNeeded, paintCanvas]);

  // ---- screen capture ----
  const startCapture = async () => {
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
      detectVignetteOnStart();
    } catch (e) {
      setMatchInfo({ text: 'Không thể bắt đầu ghi màn hình: ' + e.message, kind: 'warn' });
    }
  };

  const stopCapture = () => {
    stopAuto();
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCapturing(false);
  };

  // Waits for the shared window's video to actually have frames, then runs
  // vignette detection once and prefills the crop box — only if the user
  // hasn't already dragged a manual crop in the meantime.
  const detectVignetteOnStart = () => {
    let attempts = 0;
    const tryDetect = () => {
      const v = videoRef.current;
      if (cropRef.current) return; // user already picked one manually — don't override
      if (!v || !v.videoWidth) {
        if (attempts++ < 120) requestAnimationFrame(tryDetect); // ~2s ceiling at 60fps
        return;
      }
      const wc = document.createElement('canvas');
      wc.width = v.videoWidth;
      wc.height = v.videoHeight;
      wc.getContext('2d').drawImage(v, 0, 0);
      const mat = cv.imread(wc);
      const rect = detectVignetteRect(mat);
      mat.delete();
      if (rect && !cropRef.current) {
        cropRef.current = rect;
        setCropBox(rect);
        setCropAuto(true);
      }
    };
    requestAnimationFrame(tryDetect);
  };

  // ---- crop region selection (drag directly on the live preview) ----
  const onPreviewMouseDown = (e) => {
    if (!capturing) return;
    const rect = previewContainerRef.current.getBoundingClientRect();
    dragStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragRect({ x: dragStartRef.current.x, y: dragStartRef.current.y, w: 0, h: 0 });
  };

  const onPreviewMouseMove = (e) => {
    if (!dragStartRef.current) return;
    const rect = previewContainerRef.current.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const s = dragStartRef.current;
    setDragRect({ x: Math.min(s.x, cx), y: Math.min(s.y, cy), w: Math.abs(cx - s.x), h: Math.abs(cy - s.y) });
  };

  const onPreviewMouseUp = () => {
    if (!dragStartRef.current) return;
    const container = previewContainerRef.current;
    const video = videoRef.current;
    const content = getVideoContentRect(container, video);
    const dr = dragRect;
    dragStartRef.current = null;
    if (!dr || dr.w < 12 || dr.h < 12) {
      setDragRect(null);
      return;
    }
    const nx1 = Math.max(0, (dr.x - content.x) / content.scale);
    const ny1 = Math.max(0, (dr.y - content.y) / content.scale);
    const nx2 = Math.min(video.videoWidth, (dr.x + dr.w - content.x) / content.scale);
    const ny2 = Math.min(video.videoHeight, (dr.y + dr.h - content.y) / content.scale);
    const box = { x: Math.round(nx1), y: Math.round(ny1), w: Math.round(nx2 - nx1), h: Math.round(ny2 - ny1) };
    if (box.w > 20 && box.h > 20) {
      cropRef.current = box;
      setCropBox(box);
      setCropAuto(false);
    }
    setDragRect(null);
  };

  const clearCrop = () => {
    cropRef.current = null;
    setCropBox(null);
    setCropAuto(false);
  };

  // Overlay rect (CSS px) representing the currently-locked crop box, recomputed
  // from native video coords each render so it tracks the preview's live size.
  const cropOverlayStyle = (() => {
    if (!cropBox || !videoRef.current || !previewContainerRef.current) return null;
    const content = getVideoContentRect(previewContainerRef.current, videoRef.current);
    return {
      left: content.x + cropBox.x * content.scale,
      top: content.y + cropBox.y * content.scale,
      width: cropBox.w * content.scale,
      height: cropBox.h * content.scale,
    };
  })();

  const grabVideoFrame = () => {
    const v = videoRef.current;
    const crop = cropRef.current;
    const sx = crop ? crop.x : 0;
    const sy = crop ? crop.y : 0;
    const sw = crop ? crop.w : v.videoWidth;
    const sh = crop ? crop.h : v.videoHeight;
    const wc = workCanvasRef.current;
    wc.width = sw;
    wc.height = sh;
    wc.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
    const mat = cv.imread(wc);
    // toBlob encodes a snapshot of the canvas taken at call time, so it's safe
    // even if wc gets redrawn again before this promise resolves.
    const blobPromise = new Promise((resolve) => wc.toBlob(resolve, 'image/png'));
    return { mat, w: sw, h: sh, blobPromise };
  };

  // ---- continuous, fully autonomous stitch loop ----
  // Never asks for confirmation: on a confident feature match it integrates
  // directly; when matching fails (low-texture region) it falls back to
  // extrapolating the last known motion instead of stopping to ask the user.
  const autoTick = useCallback(async () => {
    const c = cv_.current;
    if (!uiRef.current.capturing || c.busy) return;
    c.busy = true;
    try {
      const { mat, w, h, blobPromise } = grabVideoFrame();

      if (c.tiles.length === 0) {
        ensureMosaic(w + INIT_PAD * 2, h + INIT_PAD * 2);
        composite(mat, IDENT, w, h, c.mosaicMat);
        paintCanvas(c.mosaicMat);
        const blob = await blobPromise;
        const sharp = evaluateSharpness(mat);
        const baseTile = {
          transform: IDENT.slice(), w, h, blob, bbox: tileBBox(IDENT, w, h), capturedAt: Date.now(),
          renderedTx: 0, renderedTy: 0, sharpness: sharp.value, blurry: sharp.blurry,
        };
        c.tiles.push(baseTile);
        persistTile(0, baseTile);
        persistMeta();
        if (sharp.blurry) setBlurryCount((n) => n + 1);
        const baseFeat = computeFeatures(mat);
        baseTile._kp = baseFeat.kp;
        baseTile._desc = baseFeat.desc;
        mat.delete();
        c.autoFails = 0;
        c.lastRebuildTileCount = 1;
        c.activeRefIndex = 0;
        c.lastRebuildTime = Date.now();
        setTileCount(1);
        setMatchInfo({ text: 'Ô nền (#1) đã đặt — kéo tiêu bản để tiếp tục.', kind: 'ok' });
        return;
      }

      let prevIndex = c.activeRefIndex !== null ? c.activeRefIndex : c.tiles.length - 1;
      let prevTile = c.tiles[prevIndex];
      const prevFeat = await getTileFeatures(prevTile);
      const featNew = computeFeatures(mat);
      let m = matchTiles(featNew.kp, featNew.desc, prevFeat.kp, prevFeat.desc);

      // Runs the shared warm-started relaxation pass, then checks whether any
      // already-painted tile drifted enough (or enough time/tiles have passed)
      // to justify the cost of a full mosaic repaint.
      const relaxAndMaybeRebuild = async () => {
        relax(c.tiles, c.adjacency, 0, RELAX_ITERS_PER_TICK);
        const drift = maxRenderedDrift(c.tiles);
        const dueForRebuild =
          drift > REBUILD_DRIFT_PX &&
          (c.tiles.length - c.lastRebuildTileCount >= REBUILD_MIN_TILES || Date.now() - c.lastRebuildTime >= REBUILD_MAX_MS);
        if (dueForRebuild) {
          await rebuildMosaic();
        }
      };

      if (!m.ok) {
        // Low-texture / motion-blur frame — guess from recent motion instead of stopping.
        let usedGuess = false;
        if (c.tiles.length >= 2) {
          const prev2 = c.tiles[prevIndex - 1];
          const dx = prevTile.transform[2] - prev2.transform[2];
          const dy = prevTile.transform[5] - prev2.transform[5];
          if (Math.hypot(dx, dy) > EXTRAPOLATE_MIN_PX) {
            const guessTransform = prevTile.transform.slice();
            guessTransform[2] += dx;
            guessTransform[5] += dy;
            const blob = await blobPromise;
            const sharp = evaluateSharpness(mat);
            growCanvasIfNeeded(guessTransform, w, h);
            composite(mat, guessTransform, w, h, c.mosaicMat);
            paintCanvas(c.mosaicMat);
            const newIndex = c.tiles.length;
            const guessTile = {
              transform: guessTransform, w, h, blob, bbox: tileBBox(guessTransform, w, h), capturedAt: Date.now(),
              estimated: true, renderedTx: guessTransform[2], renderedTy: guessTransform[5],
              sharpness: sharp.value, blurry: sharp.blurry,
            };
            c.tiles.push(guessTile);
            guessTile._kp = featNew.kp;
            guessTile._desc = featNew.desc;
            persistTile(newIndex, guessTile);
            if (sharp.blurry) setBlurryCount((n) => n + 1);
            // Low-weight edge: a rough guess, easily outweighed by any real match later.
            // dx/dy were extrapolated in world space, so convert into prevTile's own
            // local frame to match what real edges store; dtheta=0 since a guess
            // assumes no rotation change.
            const [gdx, gdy] = applyInverseLinear(prevTile.transform, dx, dy);
            addEdge(c.edges, c.adjacency, prevIndex, newIndex, gdx, gdy, 0, GUESS_EDGE_WEIGHT);
            persistMeta();
            c.autoFails = 0;
            c.activeRefIndex = newIndex;
            await relaxAndMaybeRebuild();
            setTileCount(c.tiles.length);
            setMatchInfo({ text: 'Vùng ít chi tiết — đã ước lượng vị trí theo hướng di chuyển gần nhất.' + (sharp.blurry ? ' (ô này có thể bị mờ)' : ''), kind: 'warn' });
            usedGuess = true;
          }
        }
        if (!usedGuess) {
          featNew.kp.delete();
          featNew.desc.delete();
          c.autoFails += 1;
          if (m.unsupported) {
            setMatchInfo({ text: 'Trình duyệt/bản OpenCV.js hiện tại thiếu hàm cần thiết để so khớp ảnh — không thể ghép tự động. Thử lại bằng Chrome/Edge bản mới nhất.', kind: 'warn' });
          } else if (c.autoFails >= AUTO_FAIL_WARN) {
            setMatchInfo({ text: 'Mất khớp liên tục — kéo chậm lại một chút để lấy nét ổn định.', kind: 'warn' });
          }
        }
        mat.delete();
        return;
      }

      const moveMag = Math.hypot(m.H[2], m.H[5]);
      const threshold = Math.max(AUTO_MOVE_MIN_PX, w * AUTO_MOVE_MIN_RATIO);
      if (moveMag < threshold) {
        featNew.kp.delete();
        featNew.desc.delete();
        mat.delete();
        c.autoFails = 0;
        return;
      }

      // Chain-based placement — this is the tile's initial position estimate.
      const transform = matMul3(prevTile.transform, m.H);
      const newIndex = c.tiles.length;
      const blob = await blobPromise;
      const sharp = evaluateSharpness(mat);
      growCanvasIfNeeded(transform, w, h);
      composite(mat, transform, w, h, c.mosaicMat);
      paintCanvas(c.mosaicMat);
      const newTile = {
        transform, w, h, blob, bbox: tileBBox(transform, w, h), capturedAt: Date.now(),
        renderedTx: transform[2], renderedTy: transform[5], sharpness: sharp.value, blurry: sharp.blurry,
      };
      c.tiles.push(newTile);
      newTile._kp = featNew.kp;
      newTile._desc = featNew.desc;
      persistTile(newIndex, newTile);
      if (sharp.blurry) setBlurryCount((n) => n + 1);
      // m.H is already the local match: new tile's offset/rotation expressed in
      // prevTile's own frame — exactly what the pose graph edge should store.
      addEdge(c.edges, c.adjacency, prevIndex, newIndex, m.H[2], m.H[5], angleOf(m.H), m.inliers);
      mat.delete();
      c.autoFails = 0;
      c.activeRefIndex = newIndex;

      // Zigzag/raster loop-closure: if this frame's provisional world position
      // overlaps a tile placed much earlier (e.g. the row above, on the way back),
      // ALSO record that as an independent edge — both observations feed the
      // same relaxation pass rather than one overriding the other.
      let usedAnchor = false;
      if (c.tiles.length >= ANCHOR_MIN_TILES) {
        const candBBox = tileBBox(transform, w, h);
        const anchor = findAnchorTile(c.tiles.slice(0, newIndex), candBBox, ANCHOR_EXCLUDE_COUNT);
        if (anchor) {
          const anchorIndex = c.tiles.indexOf(anchor);
          const anchorFeat = await getTileFeatures(anchor);
          const am = matchTiles(featNew.kp, featNew.desc, anchorFeat.kp, anchorFeat.desc);
          if (am.ok) {
            // Same as the chain edge above: am.H is already local to the anchor's frame.
            addEdge(c.edges, c.adjacency, anchorIndex, newIndex, am.H[2], am.H[5], angleOf(am.H), am.inliers);
            usedAnchor = true;
          }
        }
      }

      await relaxAndMaybeRebuild();
      persistMeta();
      setTileCount(c.tiles.length);
      setMatchInfo({
        text:
          (usedAnchor
            ? `Đã nối tự động, phát hiện trùng vùng cũ — đang điều hoà toàn cục (${m.inliers}/${m.total} điểm nội).`
            : `Đã nối tự động — ${m.inliers}/${m.total} điểm nội (${Math.round((m.inliers / m.total) * 100)}%).`) +
          (sharp.blurry ? ' Ô này có thể bị mờ — xem trong "Ô đã chụp".' : ''),
        kind: sharp.blurry ? 'warn' : 'ok',
      });
    } finally {
      c.busy = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composite, ensureMosaic, growCanvasIfNeeded, paintCanvas, blobToMat, rebuildMosaic]);

  const autoTickRef = useRef(autoTick);
  useEffect(() => { autoTickRef.current = autoTick; }, [autoTick]);

  const startAuto = () => {
    if (autoTimerRef.current || !uiRef.current.capturing) return;
    cv_.current.autoFails = 0;
    setMatchInfo({ text: 'Đang ghép tự động — kéo tiêu bản dưới kính hiển vi.', kind: 'ok' });
    autoTimerRef.current = setInterval(() => {
      autoTickRef.current();
    }, AUTO_INTERVAL_MS);
    setAutoRunning(true);
  };

  const stopAuto = () => {
    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    setAutoRunning(false);
  };

  // Re-verifies a single tile against its immediate neighbors (both before and
  // after it in the sequence) and replaces it in place — no need to undo
  // everything captured after it, unlike a plain "undo last".
  // ---- manual targeting: click a point on the mosaic, then confirm alignment ----
  // Replaces the old automatic "search everything" relocalization: the user
  // already knows visually where the gap/point of interest is, so the search
  // only needs to check tiles near THAT point — fast and much less prone to
  // false-positive matches on repetitive textures.
  const onMosaicClick = (e) => {
    if (!targetMode || !mosaicCanvasRef.current) return;
    const canvas = mosaicCanvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const canvasX = (e.clientX - rect.left) * scaleX;
    const canvasY = (e.clientY - rect.top) * scaleY;
    const c = cv_.current;
    setTargetWorld({ x: canvasX - c.originX, y: canvasY - c.originY });
  };

  const clearTarget = () => {
    setTargetWorld(null);
  };

  const toggleTargetMode = () => {
    setTargetMode((v) => !v);
    setTargetWorld(null);
  };

  const confirmTarget = async () => {
    const c = cv_.current;
    if (!targetWorld || !uiRef.current.capturing || c.busy || targetConfirming) return;
    setTargetConfirming(true);
    c.busy = true;
    try {
      setMatchInfo({ text: 'Đang so khớp quanh vị trí đã chọn…', kind: 'idle' });
      const { mat, w, h, blobPromise } = grabVideoFrame();
      const featNew = computeFeatures(mat);

      // Only check the tiles nearest the clicked point (by bbox-center distance)
      // — not the whole tile set.
      const NEAR_K = 8;
      const nearest = c.tiles
        .map((t, i) => {
          const cx = (t.bbox.minX + t.bbox.maxX) / 2;
          const cy = (t.bbox.minY + t.bbox.maxY) / 2;
          return { i, d: Math.hypot(cx - targetWorld.x, cy - targetWorld.y) };
        })
        .sort((a, b) => a.d - b.d)
        .slice(0, NEAR_K);

      let best = null;
      for (const { i } of nearest) {
        const cand = c.tiles[i];
        const candFeat = await getTileFeatures(cand);
        const mm = matchTiles(featNew.kp, featNew.desc, candFeat.kp, candFeat.desc);
        if (mm.ok && (!best || mm.inliers > best.m.inliers)) best = { index: i, m: mm };
      }

      if (!best) {
        featNew.kp.delete();
        featNew.desc.delete();
        mat.delete();
        setMatchInfo({ text: 'Không khớp được với vùng quanh điểm đã chọn — chỉnh lại kính hiển vi rồi thử lại, hoặc chọn điểm khác.', kind: 'warn' });
        return;
      }

      const refTile = c.tiles[best.index];
      const transform = matMul3(refTile.transform, best.m.H);
      const newIndex = c.tiles.length;
      const blob = await blobPromise;
      const sharp = evaluateSharpness(mat);
      growCanvasIfNeeded(transform, w, h);
      composite(mat, transform, w, h, c.mosaicMat);
      paintCanvas(c.mosaicMat);
      const newTile = {
        transform, w, h, blob, bbox: tileBBox(transform, w, h), capturedAt: Date.now(),
        renderedTx: transform[2], renderedTy: transform[5], sharpness: sharp.value, blurry: sharp.blurry,
      };
      c.tiles.push(newTile);
      newTile._kp = featNew.kp;
      newTile._desc = featNew.desc;
      persistTile(newIndex, newTile);
      if (sharp.blurry) setBlurryCount((n) => n + 1);
      addEdge(c.edges, c.adjacency, best.index, newIndex, best.m.H[2], best.m.H[5], angleOf(best.m.H), best.m.inliers);
      persistMeta();
      c.autoFails = 0;
      c.activeRefIndex = newIndex; // continuous scanning will now chain from here
      relax(c.tiles, c.adjacency, 0, RELAX_ITERS_PER_TICK);
      setTileCount(c.tiles.length);
      setTargetMode(false);
      setTargetWorld(null);
      setMatchInfo({
        text: `Đã xác nhận vị trí — khớp với ô #${best.index + 1} (${best.m.inliers} điểm nội). Sẵn sàng "Bắt đầu ghép tự động" để tiếp tục.`,
        kind: 'ok',
      });
    } catch (e) {
      setMatchInfo({ text: 'Xác nhận vị trí thất bại: ' + e.message, kind: 'warn' });
    } finally {
      c.busy = false;
      setTargetConfirming(false);
    }
  };

  const recaptureTile = async (index) => {
    const c = cv_.current;
    if (c.busy || !uiRef.current.capturing) return;
    c.busy = true;
    setRecapturingIndex(index);
    try {
      const { mat, w, h, blobPromise } = grabVideoFrame();
      const featNew = computeFeatures(mat);
      const sharp = evaluateSharpness(mat);

      const neighbors = [];
      if (index > 0) neighbors.push(c.tiles[index - 1]);
      if (index < c.tiles.length - 1) neighbors.push(c.tiles[index + 1]);

      let bestTransform = c.tiles[index].transform;
      let matchedAny = false;
      const newEdges = [];
      for (const neighbor of neighbors) {
        const neighborFeat = await getTileFeatures(neighbor);
        const mm = matchTiles(featNew.kp, featNew.desc, neighborFeat.kp, neighborFeat.desc);
        if (mm.ok) {
          const t = matMul3(neighbor.transform, mm.H);
          if (!matchedAny) bestTransform = t;
          matchedAny = true;
          const neighborIndex = c.tiles.indexOf(neighbor);
          newEdges.push({ a: neighborIndex, b: index, dx: mm.H[2], dy: mm.H[5], dtheta: angleOf(mm.H), w: mm.inliers });
        }
      }

      const blob = await blobPromise;
      removeEdgesForTile(c.edges, c.adjacency, index);
      for (const e of newEdges) addEdge(c.edges, c.adjacency, e.a, e.b, e.dx, e.dy, e.dtheta, e.w);

      const oldTile = c.tiles[index];
      if (oldTile.blurry) setBlurryCount((n) => Math.max(0, n - 1));
      freeTileFeatures(oldTile);
      c.tiles[index] = {
        ...oldTile,
        transform: bestTransform,
        blob,
        bbox: tileBBox(bestTransform, w, h),
        capturedAt: Date.now(),
        estimated: !matchedAny,
        sharpness: sharp.value,
        blurry: sharp.blurry,
        renderedTx: undefined,
        renderedTy: undefined,
        _kp: featNew.kp,
        _desc: featNew.desc,
        zstack: undefined,
      };
      if (sharp.blurry) setBlurryCount((n) => n + 1);
      persistTile(index, c.tiles[index]);
      persistMeta();
      mat.delete();
      if (newEdges.length > 0) relax(c.tiles, c.adjacency, 0, 60);
      await rebuildMosaic();
      setTilePanelVersion((v) => v + 1);
      setMatchInfo({
        text: matchedAny
          ? `Đã chụp lại ô #${index + 1}, khớp với ${newEdges.length} ô lân cận.`
          : `Đã chụp lại ô #${index + 1} nhưng không khớp được với ô lân cận — giữ nguyên vị trí cũ, chỉ thay ảnh.`,
        kind: matchedAny ? 'ok' : 'warn',
      });
    } catch (e) {
      setMatchInfo({ text: 'Chụp lại thất bại: ' + e.message, kind: 'warn' });
    } finally {
      c.busy = false;
      setRecapturingIndex(null);
    }
  };

  // ---- Z-stack: capture several manually-focused layers at the same x,y position ----
  // The stage/lens don't move between layers (only the focus knob), so unlike
  // recaptureTile there's no need to re-verify x,y — but the operator might
  // still nudge the slide slightly by hand, so we still cross-check against
  // neighbors once, using whichever layer turns out sharpest.
  const startZCapture = (index) => {
    if (cv_.current.busy) return;
    setZCaptureIndex(index);
    setZLayers([]);
  };

  const captureZLayer = async () => {
    const c = cv_.current;
    if (!uiRef.current.capturing || c.busy || zCaptureIndex === null) return;
    c.busy = true;
    try {
      const { mat, w, h, blobPromise } = grabVideoFrame();
      const blob = await blobPromise;
      mat.delete();
      setZLayers((prev) => [...prev, { blob, w, h }]);
    } finally {
      c.busy = false;
    }
  };

  const cancelZCapture = () => {
    setZCaptureIndex(null);
    setZLayers([]);
  };

  const finishZCapture = async () => {
    const c = cv_.current;
    const index = zCaptureIndex;
    const layers = zLayers;
    if (index === null || layers.length === 0 || c.busy) {
      cancelZCapture();
      return;
    }
    c.busy = true;
    try {
      setMatchInfo({ text: `Đang xử lý ${layers.length} lớp Z…`, kind: 'idle' });
      let best = null;
      const scored = [];
      for (const layer of layers) {
        const mat = await blobToMat(layer.blob);
        const value = computeSharpness(mat);
        mat.delete();
        const scoredLayer = { blob: layer.blob, w: layer.w, h: layer.h, sharpness: value };
        scored.push(scoredLayer);
        if (!best || value > best.sharpness) best = scoredLayer;
      }

      const bestMat = await blobToMat(best.blob);
      const featNew = computeFeatures(bestMat);
      bestMat.delete();

      const neighbors = [];
      if (index > 0) neighbors.push(c.tiles[index - 1]);
      if (index < c.tiles.length - 1) neighbors.push(c.tiles[index + 1]);
      let bestTransform = c.tiles[index].transform;
      let matchedAny = false;
      const newEdges = [];
      for (const neighbor of neighbors) {
        const neighborFeat = await getTileFeatures(neighbor);
        const mm = matchTiles(featNew.kp, featNew.desc, neighborFeat.kp, neighborFeat.desc);
        if (mm.ok) {
          const t = matMul3(neighbor.transform, mm.H);
          if (!matchedAny) bestTransform = t;
          matchedAny = true;
          const neighborIndex = c.tiles.indexOf(neighbor);
          newEdges.push({ a: neighborIndex, b: index, dx: mm.H[2], dy: mm.H[5], dtheta: angleOf(mm.H), w: mm.inliers });
        }
      }

      removeEdgesForTile(c.edges, c.adjacency, index);
      for (const e of newEdges) addEdge(c.edges, c.adjacency, e.a, e.b, e.dx, e.dy, e.dtheta, e.w);

      const oldTile = c.tiles[index];
      if (oldTile.blurry) setBlurryCount((n) => Math.max(0, n - 1));
      freeTileFeatures(oldTile);
      const blurryFlag = classifySharpness(best.sharpness);
      c.tiles[index] = {
        ...oldTile,
        transform: bestTransform,
        blob: best.blob,
        w: best.w,
        h: best.h,
        bbox: tileBBox(bestTransform, best.w, best.h),
        capturedAt: Date.now(),
        estimated: !matchedAny,
        sharpness: best.sharpness,
        blurry: blurryFlag,
        renderedTx: undefined,
        renderedTy: undefined,
        _kp: featNew.kp,
        _desc: featNew.desc,
        zstack: scored.map((l) => ({ blob: l.blob, sharpness: l.sharpness })),
      };
      if (blurryFlag) setBlurryCount((n) => n + 1);
      persistTile(index, c.tiles[index]);
      persistMeta();
      if (newEdges.length > 0) relax(c.tiles, c.adjacency, 0, 60);
      await rebuildMosaic();
      setTilePanelVersion((v) => v + 1);
      setMatchInfo({
        text: `Đã lưu ${layers.length} lớp Z cho ô #${index + 1} — dùng lớp nét nhất để ghép` +
          (matchedAny ? '.' : ' (không khớp được vị trí với ô lân cận, giữ nguyên vị trí cũ).'),
        kind: 'ok',
      });
    } catch (e) {
      setMatchInfo({ text: 'Quét lớp Z thất bại: ' + e.message, kind: 'warn' });
    } finally {
      c.busy = false;
      cancelZCapture();
    }
  };

  const undoLast = async () => {
    const c = cv_.current;
    if (c.tiles.length === 0) return;
    const removedIndex = c.tiles.length - 1;
    const removedTile = c.tiles.pop();
    removeEdgesForTile(c.edges, c.adjacency, removedIndex);
    freeTileFeatures(removedTile);
    if (removedTile.blurry) setBlurryCount((n) => Math.max(0, n - 1));
    db.deleteTilesFrom(removedIndex).catch(() => {});
    db.saveMeta({ edges: c.edges, tileCount: c.tiles.length, updatedAt: Date.now() }).catch(() => {});
    await rebuildMosaic();
    setMatchInfo({ text: 'Đã hoàn tác ô cuối.', kind: 'idle' });
  };

  const resetAll = () => {
    stopAuto();
    const c = cv_.current;
    freeAllTileFeatures(c.tiles);
    if (c.mosaicMat) {
      c.mosaicMat.delete();
      c.mosaicMat = null;
    }
    c.tiles = [];
    c.edges = [];
    c.adjacency = [];
    c.originX = INIT_PAD;
    c.originY = INIT_PAD;
    c.w = 0;
    c.h = 0;
    c.autoFails = 0;
    c.lastRebuildTileCount = 0;
    c.lastRebuildTime = 0;
    c.sharpnessHistory = [];
    c.activeRefIndex = null;
    setBlurryCount(0);
    db.clearAll().catch(() => {});
    setTileCount(0);
    setCanvasDims({ w: 0, h: 0 });
    if (mosaicCanvasRef.current) {
      const ctx = mosaicCanvasRef.current.getContext('2d');
      mosaicCanvasRef.current.width = 1;
      mosaicCanvasRef.current.height = 1;
      ctx.clearRect(0, 0, 1, 1);
    }
    setMatchInfo({ text: 'Đã đặt lại toàn bộ.', kind: 'idle' });
  };

  const forceOptimize = async () => {
    const c = cv_.current;
    if (c.tiles.length < 2 || exportingZip || c.busy) return;
    c.busy = true;
    try {
      relax(c.tiles, c.adjacency, 0, 200); // run to near-full convergence
      setMatchInfo({ text: 'Đang vẽ lại ảnh ghép sau khi tối ưu…', kind: 'idle' });
      await rebuildMosaic();
      setMatchInfo({ text: 'Đã tối ưu vị trí toàn cục và vẽ lại ảnh ghép.', kind: 'ok' });
    } finally {
      c.busy = false;
    }
  };

  const exportPNG = () => {
    const canvas = mosaicCanvasRef.current;
    if (!canvas || !canvas.width) return;
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `panorama-lame-${Date.now()}.png`;
      a.click();
    }, 'image/png');
  };

  const exportAllTilesZip = async () => {
    const c = cv_.current;
    const tiles = c.tiles;
    if (tiles.length === 0 || exportingZip) return;
    setExportingZip(true);
    setMatchInfo({ text: `Đang đóng gói 0/${tiles.length} ảnh gốc…`, kind: 'idle' });
    try {
      const zip = new JSZip();
      const pad = String(tiles.length).length;
      const manifestRows = [
        'index,filename,x_px,y_px,width_px,height_px,estimated,blurry,sharpness,t_a,t_b,t_tx,t_c,t_d,t_ty,captured_at_iso',
      ];

      tiles.forEach((tile, i) => {
        const idx = String(i + 1).padStart(Math.max(4, pad), '0');
        const filename = `tile_${idx}.png`;
        zip.file(filename, tile.blob);
        const xPx = Math.round(tile.bbox.minX + c.originX);
        const yPx = Math.round(tile.bbox.minY + c.originY);
        const iso = new Date(tile.capturedAt || Date.now()).toISOString();
        const t = tile.transform;
        manifestRows.push(
          `${i + 1},${filename},${xPx},${yPx},${tile.w},${tile.h},${tile.estimated ? 1 : 0},${tile.blurry ? 1 : 0},` +
          `${tile.sharpness || 0},${t[0]},${t[1]},${t[2]},${t[3]},${t[4]},${t[5]},${iso}`
        );
      });

      zip.file('manifest.csv', manifestRows.join('\n'));

      const blob = await zip.generateAsync(
        { type: 'blob', compression: 'STORE' },
        (meta) => {
          const done = Math.round((meta.percent / 100) * tiles.length);
          setMatchInfo({ text: `Đang đóng gói ${done}/${tiles.length} ảnh gốc…`, kind: 'idle' });
        }
      );

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `anh-goc-lame-${Date.now()}.zip`;
      a.click();
      setMatchInfo({ text: `Đã xuất ${tiles.length} ảnh gốc kèm manifest.csv.`, kind: 'ok' });
    } catch (e) {
      setMatchInfo({ text: 'Xuất ảnh gốc thất bại: ' + e.message, kind: 'warn' });
    } finally {
      setExportingZip(false);
    }
  };

  const fileInputRef = useRef(null);

  const importFromZip = async (file) => {
    const c = cv_.current;
    if (c.tiles.length > 0) {
      const proceed = window.confirm(`Đang có ${c.tiles.length} ô trong phiên hiện tại. Nhập file sẽ THAY THẾ toàn bộ. Tiếp tục?`);
      if (!proceed) return;
    }
    setMatchInfo({ text: 'Đang đọc file ZIP…', kind: 'idle' });
    try {
      const zip = await JSZip.loadAsync(file);
      const manifestEntry = zip.file('manifest.csv');
      if (!manifestEntry) throw new Error('Không tìm thấy manifest.csv trong file này');
      const csv = await manifestEntry.async('string');
      const lines = csv.trim().split('\n').slice(1); // skip header

      const tiles = [];
      for (let i = 0; i < lines.length; i++) {
        const cols = lines[i].split(',');
        const [, filename, , , wStr, hStr, estimatedStr, blurryStr, sharpnessStr, ta, tb, ttx, tc, td, tty, capturedAtIso] = cols;
        const entry = zip.file(filename);
        if (!entry) continue;
        const blob = await entry.async('blob');
        const w = parseInt(wStr, 10);
        const h = parseInt(hStr, 10);
        const transform = [parseFloat(ta), parseFloat(tb), parseFloat(ttx), parseFloat(tc), parseFloat(td), parseFloat(tty), 0, 0, 1];
        tiles.push({
          transform, w, h, blob,
          bbox: tileBBox(transform, w, h),
          capturedAt: capturedAtIso ? Date.parse(capturedAtIso) : Date.now(),
          estimated: estimatedStr === '1',
          blurry: blurryStr === '1',
          sharpness: parseFloat(sharpnessStr) || 0,
        });
        setMatchInfo({ text: `Đang nạp lại ${i + 1}/${lines.length} ô…`, kind: 'idle' });
      }

      if (tiles.length === 0) throw new Error('manifest.csv không có ô nào hợp lệ');

      // Original per-pair match confidence isn't stored in the manifest — rebuild
      // a simple sequential chain (moderate default weight) so the session is at
      // least resumable/optimizable; richer loop-closure edges will re-form
      // naturally as scanning continues past old tiles.
      c.edges = [];
      c.adjacency = [];
      for (let i = 1; i < tiles.length; i++) {
        const worldDx = tiles[i].transform[2] - tiles[i - 1].transform[2];
        const worldDy = tiles[i].transform[5] - tiles[i - 1].transform[5];
        const [ldx, ldy] = applyInverseLinear(tiles[i - 1].transform, worldDx, worldDy);
        const dtheta = angleOf(tiles[i].transform) - angleOf(tiles[i - 1].transform);
        addEdge(c.edges, c.adjacency, i - 1, i, ldx, ldy, dtheta, 20);
      }
      freeAllTileFeatures(c.tiles);
      c.tiles = tiles;
      c.sharpnessHistory = tiles.filter((t) => !t.blurry && t.sharpness).map((t) => t.sharpness).slice(-SHARPNESS_HISTORY_SIZE);
      c.activeRefIndex = null;
      setBlurryCount(tiles.filter((t) => t.blurry).length);

      await rebuildMosaic();

      // Persist the reimported session to IndexedDB so it's protected going forward too.
      await db.clearAll().catch(() => {});
      for (let i = 0; i < tiles.length; i++) persistTile(i, tiles[i]);
      persistMeta();

      setMatchInfo({ text: `Đã nhập lại ${tiles.length} ô từ file ZIP. Chọn cửa sổ nguồn, bấm "Định vị thủ công" và chọn đúng điểm cần tiếp tục trên ảnh ghép trước khi quét tiếp.`, kind: 'ok' });
    } catch (e) {
      setMatchInfo({ text: 'Nhập file thất bại: ' + e.message, kind: 'warn' });
    }
  };

  // Space toggles the auto-stitch loop; no other manual capture step exists.
  useEffect(() => {
    const onKey = (e) => {
      if (!uiRef.current.cvReady || !uiRef.current.capturing) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (autoTimerRef.current) stopAuto();
        else startAuto();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => stopAuto(), []);

  return (
    <>
      {!cvReady && (
        <div className="loading-cv">
          <div className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
            Đang tải bộ xử lý ảnh (OpenCV.js)…
          </div>
          <div className="bar"><div className="fill"></div></div>
        </div>
      )}
      {resumePrompt && (
        <div className="resume-banner">
          <span>
            Tìm thấy phiên quét dở từ trước ({resumePrompt.count} ô đã lưu). Tiếp tục hay bắt đầu mới?
          </span>
          <button className="primary" onClick={continueSession}>Tiếp tục phiên cũ</button>
          <button onClick={discardSession}>Bắt đầu mới (xoá phiên cũ)</button>
        </div>
      )}
      <video
        ref={pipVideoRef}
        muted
        playsInline
        style={{ position: 'fixed', width: 1, height: 1, opacity: 0, pointerEvents: 'none', left: -9999 }}
      ></video>
      <header className="app-head">
        <h1>Ghép Panorama Kính Hiển Vi</h1>
        <span className="sub">Kéo tiêu bản liên tục — app tự tích luỹ &amp; ghép thành 1 ảnh scan lame, không cần xác nhận từng bước</span>
      </header>
      <div className="layout">
        <div className="rail">
          <div className="block">
            <h2>1 · Nguồn hình ảnh &amp; vùng chụp</h2>
            <div
              className="preview-wrap"
              ref={previewContainerRef}
              onMouseDown={onPreviewMouseDown}
              onMouseMove={onPreviewMouseMove}
              onMouseUp={onPreviewMouseUp}
              onMouseLeave={onPreviewMouseUp}
              style={{ cursor: capturing ? 'crosshair' : 'default' }}
            >
              <video ref={videoRef} muted playsInline></video>
              {capturing && (
                <div className="rec-dot">
                  <span className="d"></span>Đang ghi
                </div>
              )}
              {!capturing && (
                <div className="preview-empty">
                  Chưa chọn cửa sổ nào.
                  <br />
                  Bấm "Chọn cửa sổ" bên dưới, rồi chọn đúng cửa sổ phần mềm camera kính hiển vi.
                </div>
              )}
              {cropOverlayStyle && <div className="crop-box" style={cropOverlayStyle}></div>}
              {dragRect && (
                <div className="crop-box dragging" style={{ left: dragRect.x, top: dragRect.y, width: dragRect.w, height: dragRect.h }}></div>
              )}
            </div>
            <div style={{ height: 10 }} />
            {!capturing ? (
              <button className="primary" disabled={!cvReady} onClick={startCapture}>
                Chọn cửa sổ / màn hình…
              </button>
            ) : (
              <button className="danger" onClick={stopCapture}>
                Dừng ghi
              </button>
            )}
            {capturing && (
              <>
                <div style={{ height: 8 }} />
                <div className="row">
                  <button className="ghost" onClick={clearCrop} disabled={!cropBox}>
                    Xoá vùng chọn
                  </button>
                </div>
                <div className="note" style={{ marginTop: 6 }}>
                  {cropAuto && cropBox
                    ? 'Đã tự động chọn vùng nhìn (loại bỏ viền tối quanh thị kính) — kéo chuột lại nếu cần chỉnh.'
                    : 'Kéo chuột trực tiếp trên khung xem trước để chọn 1 vùng nhỏ cần quét (không bắt buộc dùng cả cửa sổ). Không chọn gì thì dùng toàn khung.'}
                </div>
              </>
            )}
          </div>

          <div className="block">
            <h2>Cửa sổ theo dõi (nổi trên cùng)</h2>
            {pipSupported ? (
              <>
                <button onClick={togglePip} disabled={!cvReady}>
                  {pipActive ? 'Đóng cửa sổ nổi' : 'Mở cửa sổ nổi'}
                </button>
                <div className="note" style={{ marginTop: 8 }}>
                  Tách khung ảnh ghép ra 1 cửa sổ nhỏ nổi trên mọi cửa sổ khác — để bạn vừa
                  thao tác phần mềm camera vừa theo dõi ảnh ghép cập nhật trực tiếp.
                </div>
              </>
            ) : (
              <div className="note">Trình duyệt này không hỗ trợ cửa sổ nổi (Picture-in-Picture).</div>
            )}
          </div>

          <div className="block" style={{ borderColor: autoRunning ? 'var(--teal)' : 'var(--line)' }}>
            <h2>2 · Ghép tự động (kéo &amp; thả)</h2>
            {!autoRunning ? (
              <button className="primary" disabled={!cvReady || !capturing} onClick={startAuto}>
                Bắt đầu ghép tự động <span className="kbd">Space</span>
              </button>
            ) : (
              <button className="warn" onClick={stopAuto}>
                <span className="rec-dot" style={{ position: 'static', display: 'inline-flex', marginRight: 6 }}>
                  <span className="d"></span>
                </span>
                Đang ghép tự động — bấm để dừng <span className="kbd">Space</span>
              </button>
            )}
            <div className="note" style={{ marginTop: 8 }}>
              Cứ kéo tiêu bản bình thường — app tự lấy mẫu, tự ghép, và <b>liên tục điều
              hoà vị trí toàn bộ các ô</b> (không chỉ ô mới nhất) mỗi khi phát hiện trùng
              vùng đã quét trước đó, để giảm trôi tích luỹ ở các đường quét dài/zigzag.
              Ảnh ghép sẽ tự vẽ lại định kỳ khi có điều chỉnh đáng kể. Vùng ít chi tiết sẽ
              được ước lượng theo hướng di chuyển gần nhất thay vì dừng lại hỏi bạn.
            </div>
          </div>

          <div className="block" style={{ borderColor: targetMode ? 'var(--amber)' : 'var(--line)' }}>
            <h2>Định vị thủ công (khi tiếp tục phiên)</h2>
            {!targetMode ? (
              <button onClick={toggleTargetMode} disabled={tileCount === 0 || autoRunning}>
                Định vị thủ công
              </button>
            ) : (
              <>
                <div className="note">
                  Bấm vào đúng điểm cần tiếp tục trên ảnh ghép bên phải (vùng còn thiếu, hoặc
                  chỗ cần chụp bù). Sau đó tìm và ướm đúng vị trí đó dưới kính hiển vi, rồi bấm
                  "Xác nhận vị trí".
                </div>
                <div style={{ height: 8 }} />
                <div className="row">
                  <button
                    className="primary"
                    onClick={confirmTarget}
                    disabled={!targetWorld || !capturing || targetConfirming}
                  >
                    {targetConfirming ? 'Đang xác nhận…' : 'Xác nhận vị trí'}
                  </button>
                  <button onClick={clearTarget} disabled={!targetWorld}>Bỏ chọn điểm</button>
                  <button className="ghost" onClick={toggleTargetMode}>Thoát</button>
                </div>
              </>
            )}
          </div>

          <div className="block">
            <h2>Trạng thái</h2>
            <div className="status-line">
              <span className={`badge ${matchInfo.kind}`}>
                {matchInfo.kind === 'ok' ? 'Tốt' : matchInfo.kind === 'warn' ? 'Chú ý' : 'Sẵn sàng'}
              </span>
              <div style={{ height: 6 }} />
              {matchInfo.text}
              <div style={{ height: 8 }} />
              Số ô đã ghép: <b className="mono">{tileCount}</b>
              <br />
              Kích thước ảnh ghép: <span className="mono">{canvasDims.w}×{canvasDims.h}px</span>
              {blurryCount > 0 && (
                <>
                  <br />
                  <span style={{ color: 'var(--amber)' }}>⚠ {blurryCount} ô có thể bị mờ</span>
                </>
              )}
            </div>
          </div>

          <div className="block">
            <h2>Ô đã chụp</h2>
            <div className="row">
              <button onClick={() => setShowTilePanel((s) => !s)}>
                {showTilePanel ? 'Ẩn danh sách' : 'Hiện danh sách'}
              </button>
              <button onClick={() => setTilePanelShowAll((s) => !s)} disabled={!showTilePanel}>
                {tilePanelShowAll ? 'Chỉ hiện ô mờ' : 'Hiện tất cả'}
              </button>
            </div>
            {showTilePanel && (
              <>
                <div style={{ height: 8 }} />
                <div className="tile-list">
                  {(() => {
                    const rows = cv_.current.tiles
                      .map((t, i) => ({ t, i }))
                      .filter(({ t }) => tilePanelShowAll || t.blurry);
                    if (rows.length === 0) {
                      return <div className="note">Không có ô nào {tilePanelShowAll ? 'đã chụp' : 'bị đánh dấu mờ'}.</div>;
                    }
                    return rows.map(({ t, i }) => (
                      <div className="tile-row" key={i} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="idx mono">#{i + 1}</span>
                          <TileThumb blob={t.blob} />
                          {t.blurry && <span className="badge warn">Mờ</span>}
                          {t.estimated && <span className="badge warn">Ước lượng</span>}
                          {t.zstack && <span className="badge ok">{t.zstack.length} lớp Z</span>}
                          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                            <button
                              onClick={() => recaptureTile(i)}
                              disabled={!capturing || recapturingIndex !== null || zCaptureIndex !== null}
                              style={{ width: 'auto', flex: 'none' }}
                            >
                              {recapturingIndex === i ? 'Đang chụp…' : 'Chụp lại'}
                            </button>
                            <button
                              onClick={() => startZCapture(i)}
                              disabled={!capturing || recapturingIndex !== null || zCaptureIndex !== null}
                              style={{ width: 'auto', flex: 'none' }}
                            >
                              Quét Z
                            </button>
                          </div>
                        </div>
                        {t.zstack && t.zstack.length > 1 && <ZStackScrubber zstack={t.zstack} />}
                        {zCaptureIndex === i && (
                          <div className="zcapture-panel">
                            <div className="note">
                              Chỉnh tiêu cự rồi bấm "Chụp thêm lớp" — lặp lại cho mỗi độ cao tiêu điểm cần lấy.
                              Không di chuyển tiêu bản theo x,y trong lúc này.
                            </div>
                            <div className="row" style={{ marginTop: 6 }}>
                              <button onClick={captureZLayer} disabled={!capturing}>
                                Chụp thêm lớp ({zLayers.length})
                              </button>
                              <button className="primary" onClick={finishZCapture} disabled={zLayers.length === 0}>
                                Xong — lưu {zLayers.length} lớp
                              </button>
                              <button className="ghost" onClick={cancelZCapture}>Huỷ</button>
                            </div>
                            {zLayers.length > 0 && (
                              <div className="zlayer-thumbs">
                                {zLayers.map((l, li) => (
                                  <TileThumb blob={l.blob} key={li} />
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ));
                  })()}
                </div>
                <div className="note" style={{ marginTop: 6 }}>
                  Đưa kính hiển vi về đúng vị trí của ô cần sửa rồi bấm "Chụp lại" — ảnh và vị trí
                  của riêng ô đó sẽ được thay thế, không ảnh hưởng các ô khác.
                </div>
              </>
            )}
          </div>

          <div className="block">
            <h2>Công cụ</h2>
            <div className="row">
              <button onClick={undoLast} disabled={tileCount === 0}>Hoàn tác ô cuối</button>
              <button onClick={resetAll} disabled={tileCount === 0}>Đặt lại</button>
            </div>
            <div style={{ height: 8 }} />
            <button onClick={forceOptimize} disabled={tileCount < 2}>
              Tối ưu &amp; vẽ lại ngay
            </button>
            <div style={{ height: 8 }} />
            <button className="primary" onClick={exportPNG} disabled={tileCount === 0}>
              Xuất ảnh ghép (PNG)
            </button>
            <div style={{ height: 8 }} />
            <button onClick={exportAllTilesZip} disabled={tileCount === 0 || exportingZip}>
              {exportingZip ? 'Đang đóng gói…' : 'Xuất toàn bộ ảnh gốc + manifest (ZIP)'}
            </button>
            <div style={{ height: 8 }} />
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files && e.target.files[0];
                if (file) importFromZip(file);
                e.target.value = '';
              }}
            />
            <button onClick={() => fileInputRef.current && fileInputRef.current.click()}>
              Nhập lại từ file ZIP đã xuất…
            </button>
            <div className="note" style={{ marginTop: 6 }}>
              Dùng khi đã xuất ảnh, xem lại sau đó mới phát hiện 1 ô bị lỗi — nạp lại đúng
              file ZIP đã xuất, rồi chọn cửa sổ nguồn và dùng "Chụp lại" trong panel "Ô đã
              chụp" ở trên để quét bù đúng vị trí đó.
            </div>
          </div>

          <div className="note">
            Cách dùng: chọn cửa sổ phần mềm camera → (tuỳ chọn) kéo chọn vùng cần quét trên
            khung xem trước → bấm "Bắt đầu ghép tự động" → kéo tiêu bản liên tục, kể cả
            theo kiểu zigzag. Ô đầu tiên luôn được đặt làm gốc ngay khi bắt đầu.
          </div>
        </div>

        <div className="stage-area">
          <div className="stage-scroll">
            {tileCount === 0 && (
              <div className="stage-empty">
                Vùng ghép ảnh sẽ hiện ở đây.
                <br />
                <b>Chưa có ô nào được chụp.</b>
                <br />
                Chọn cửa sổ nguồn ở bên trái, rồi bấm "Bắt đầu ghép tự động".
              </div>
            )}
            <div className="stage-frame" style={{ display: tileCount > 0 ? 'block' : 'none' }}>
              <canvas
                ref={mosaicCanvasRef}
                onClick={onMosaicClick}
                style={{ cursor: targetMode ? 'crosshair' : 'default' }}
              ></canvas>
              <div className="tick tl"></div>
              <div className="tick tr"></div>
              <div className="tick bl"></div>
              <div className="tick br"></div>
              {targetWorld && (
                <div
                  className="target-marker"
                  style={{
                    left: targetWorld.x + cv_.current.originX - 16,
                    top: targetWorld.y + cv_.current.originY - 16,
                  }}
                ></div>
              )}
            </div>
          </div>
          <div className="footer-bar mono">
            <span>ORB + RANSAC similarity transform · tự ước lượng khi mất khớp</span>
            <span className="tiles">{tileCount} ô</span>
          </div>
        </div>
      </div>
    </>
  );
}
