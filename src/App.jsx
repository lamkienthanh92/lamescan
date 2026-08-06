/* global cv */
import { useState, useRef, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import './App.css';
import { IDENT, matMul3, translateM, cornersOf, bboxOf, findAnchorTile, findCandidateTiles, angleOf, applyInverseLinear, refreshBBoxes } from './matrix.js';
import { computeFeatures, freeFeatures, matchTiles, computeSharpness, detectVignetteRect, CROSSCHECK_MAX_DIM } from './cvMatch.js';
import { addEdge, removeEdgesForTile, rebuildAdjacency, relax, maxRenderedDrift } from './graph.js';
import * as db from './db.js';

const INIT_PAD = 40;
const AUTO_INTERVAL_MS = 350; // how often the continuous loop samples a frame
const AUTO_FAIL_WARN = 6; // consecutive unhandled failures before warning the user
const AUTO_MOVE_MIN_PX = 18; // minimum translation (px) before a frame is worth integrating
const AUTO_MOVE_MIN_RATIO = 0.025; // ...as a fraction of frame width, whichever is larger
const ANCHOR_EXCLUDE_COUNT = 8; // don't treat the last N tiles as "revisits" — they're just normal chain overlap
const ANCHOR_MIN_TILES = ANCHOR_EXCLUDE_COUNT + 2;
const EXTRAPOLATE_MIN_PX = 3; // minimum recent motion before it's worth extrapolating a guess
const RELAX_ITERS_PER_TICK = 20; // small warm-started relaxation pass, run every tick — needs more than a handful now that rotation is solved too (coupled rotation+translation converges slower than translation alone), still cheap since it's plain arithmetic over edges
const GUESS_EDGE_WEIGHT = 1; // low confidence for extrapolated (unmatched) placements
const MAX_CONSECUTIVE_GUESSES = 2; // stop auto-accepting guesses after this many in a row without a real match confirming them
const CANDIDATE_POOL_SIZE = 2; // how many nearby-by-prediction tiles a capture is tried against, not just the last one — kept small since each candidate costs a full match
const REBUILD_DRIFT_PX = 20; // repaint the mosaic once any already-painted tile drifts this much — a few px of residual jitter from iterative relax isn't worth a full expensive repaint; only real loop-closure corrections should trigger one
const REBUILD_MIN_TILES = 25; // ...but don't repaint more often than every N new tiles
const REBUILD_MAX_MS = 8000; // ...or longer than this since the last repaint, if dirty
const SHARPNESS_HISTORY_SIZE = 30; // recent "good" tiles used as the running focus baseline
const SHARPNESS_MIN_SAMPLES = 5; // don't flag anything until we have a baseline
const SHARPNESS_BLUR_RATIO = 0.4; // flag a tile if its sharpness < 40% of the recent median

// Browsers cap how big a <canvas> can be — roughly 16384px per side, and a total
// area limit well under what a 300-field WHO slide scan reaches (a 15000x11250
// mosaic is ~170 megapixels). Past the cap the canvas silently goes blank
// instead of erroring, so the on-screen mosaic is kept inside these bounds and
// downscaled when it has to be. The full-resolution pixels always stay in the
// OpenCV Mat; only the *display* copy is reduced.
const DISPLAY_MAX_DIM = 8192;
const DISPLAY_MAX_AREA = 40e6;
// Export can afford to be closer to the real browser ceiling than the live view.
const EXPORT_MAX_DIM = 16000;
const EXPORT_MAX_AREA = 200e6;
// Grow the mosaic in generous chunks rather than by exactly what the newest tile
// needs: every growth reallocates the whole mosaic Mat and forces the display
// canvas to be rebuilt, so growing once per several tiles is much cheaper than
// growing a few hundred pixels at a time on every single capture.
const GROW_CHUNK_PX = 1024;
// Cap on how many tiles keep their ORB features cached in the WASM heap at once
// (~180KB each). Caching is what makes repeated anchor checks fast, but an
// uncapped cache grows without bound across a long scan.
const MAX_CACHED_FEATURES = 120;
const FEATURE_CACHE_PROTECT_RECENT = 12; // newest N tiles are never evicted
const CV_LOAD_TIMEOUT_MS = 25000; // give up waiting for opencv.js and say so

// Largest dimension the display canvas may have for a given mosaic size, as a
// scale factor <= 1.
function fitScale(w, h, maxDim, maxArea) {
  if (!w || !h) return 1;
  return Math.min(1, maxDim / Math.max(w, h), Math.sqrt(maxArea / (w * h)));
}

// Matching strictness presets. The original code hard-coded the "strict" numbers,
// which assume a mechanical stage moving along exactly one axis at a time with
// no rotation. That assumption is what makes the repetitive-texture defence work,
// but if the slide is nudged by hand — or the stage has any play in it — a step
// with a few px of off-axis motion fails BOTH axis hypotheses and is rejected
// outright, and the scan stalls with nothing accepted. Being able to switch is
// the difference between diagnosing that in a minute and guessing at it.
const MATCH_MODES = {
  strict: {
    label: 'Chặt (bàn cơ 2 trục)',
    note: 'Chỉ nhận bước tịnh tiến thuần theo 1 trục. Chống nhiễu texture lặp tốt nhất, nhưng trượt nếu kéo lệch chéo.',
    axisLock: true, minInliers: 15, minRatio: 0.22, axisTolPx: 5, crossCheckVetoScore: 0.3,
  },
  balanced: {
    label: 'Vừa (khuyến nghị)',
    note: 'Vẫn khoá trục, nhưng nới dung sai lệch chéo và không để phép tương quan pixel bác bỏ khớp khi chính nó cũng không chắc.',
    axisLock: true, minInliers: 15, minRatio: 0.10, axisTolPx: 9, crossCheckVetoScore: 0.55,
  },
  loose: {
    label: 'Linh hoạt (kéo tay)',
    note: 'Bỏ khoá trục — nhận tịnh tiến 2 chiều và xoay nhẹ, có kiểm tra hợp lý so với vị trí dự đoán. Dùng khi chế độ trên liên tục mất khớp.',
    axisLock: false, minInliers: 14, minRatio: 0.08, axisTolPx: 12, crossCheckVetoScore: 0.65,
  },
};
// Sanity limits applied to a match from the unconstrained estimator in 'loose'
// mode, since it has no built-in defence against repetitive-texture aliasing.
const LOOSE_MAX_ROT_RAD = 0.12; // ~7 degrees
const LOOSE_SCALE_TOL = 0.08;
const LOOSE_MAX_OFFSET_FRAC = 0.6; // vs. predicted position, as a fraction of tile size
const DIAG_LOG_SIZE = 14;

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
  const [cvLoadFailed, setCvLoadFailed] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [tileCount, setTileCount] = useState(0);
  const [matchInfo, setMatchInfo] = useState({ text: 'Chưa có ô nào', kind: 'idle' });
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0, scale: 1 });
  const [pipActive, setPipActive] = useState(false);
  const [pipSupported, setPipSupported] = useState(true);
  const [exportingZip, setExportingZip] = useState(false);
  const [cropBox, setCropBox] = useState(null); // {x,y,w,h} in native video px — for rendering the overlay
  const [dragRect, setDragRect] = useState(null); // {x,y,w,h} in container CSS px — live drag feedback
  const [resumePrompt, setResumePrompt] = useState(null); // {count} | null
  const [blurryCount, setBlurryCount] = useState(0);
  const [cropAuto, setCropAuto] = useState(false); // true when the current cropBox came from auto-vignette-detection
  const [ghostUrl, setGhostUrl] = useState(null); // object URL of the current reference tile's image, for the nav ghost overlay
  useEffect(() => {
    const c = cv_.current;
    const idx = c.activeRefIndex !== null ? c.activeRefIndex : c.tiles.length - 1;
    const tile = idx >= 0 ? c.tiles[idx] : null;
    if (!tile) {
      setGhostUrl(null);
      return;
    }
    const url = URL.createObjectURL(tile.blob);
    setGhostUrl(url);
    return () => URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileCount]);
  const [showTilePanel, setShowTilePanel] = useState(false);
  const [tilePanelShowAll, setTilePanelShowAll] = useState(false);
  const [tilePanelVersion, setTilePanelVersion] = useState(0); // bump to force the panel list to re-render
  const [recapturingIndex, setRecapturingIndex] = useState(null);
  const [zCaptureIndex, setZCaptureIndex] = useState(null);
  const [zLayers, setZLayers] = useState([]);
  const [targetMode, setTargetMode] = useState(false);
  const [targetWorld, setTargetWorld] = useState(null); // {x,y} in world coords, or null
  const [targetConfirming, setTargetConfirming] = useState(false);
  const [matchMode, setMatchMode] = useState('balanced');
  const [showDiag, setShowDiag] = useState(false);
  const [diagLog, setDiagLog] = useState([]);

  const videoRef = useRef(null);
  const pipVideoRef = useRef(null);
  const previewContainerRef = useRef(null);
  const mosaicCanvasRef = useRef(null);
  const workCanvasRef = useRef(document.createElement('canvas'));
  const quickCanvasRef = useRef(document.createElement('canvas')); // scratch canvas for the cheap pre-capture overlap check
  const regionCanvasRef = useRef(document.createElement('canvas')); // scratch canvas for incremental mosaic blits
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
    displayScale: 1, // mosaic px -> display canvas px (see DISPLAY_MAX_*)
    dbCleared: false, // has IndexedDB been cleared for THIS session yet?
    featSeq: 0, // monotonic counter for feature-cache LRU eviction
    lastRebuildTileCount: 0,
    lastRebuildTime: 0,
    sharpnessHistory: [],
    activeRefIndex: null, // set by manual "confirm target" positioning; overrides the default "chain from last tile"
    justResumed: false, // true right after (re)starting auto-match — requires one real match before guessing is allowed again
    consecutiveGuesses: 0, // extrapolated (unmatched) placements in a row since the last real match
  });

  const uiRef = useRef({ cvReady: false, capturing: false, matchMode: 'balanced' });
  useEffect(() => { uiRef.current.cvReady = cvReady; }, [cvReady]);
  useEffect(() => { uiRef.current.capturing = capturing; }, [capturing]);
  useEffect(() => { uiRef.current.matchMode = matchMode; }, [matchMode]);

  // Rolling log of what each tick actually decided. Without this, a stalled scan
  // is indistinguishable from a broken one: the status line only ever showed the
  // last message, so "no tile was added" gave no clue whether the frame was
  // skipped as not-yet-moved, found too few inliers, was vetoed by the pixel
  // cross-check, or was rejected for having no valid axis hypothesis at all.
  const logDiag = (kind, text) => {
    const entry = { t: new Date().toLocaleTimeString('vi-VN', { hour12: false }), kind, text };
    setDiagLog((prev) => [entry, ...prev].slice(0, DIAG_LOG_SIZE));
  };

  // ---- load opencv.js (script tag is included in index.html) ----
  // Polling with no ceiling meant a failed script load (404 from a misconfigured
  // publish directory, blocked response, corrupted asset) left the page sitting
  // on "loading image processor…" forever with nothing to act on. Give up after
  // a bounded wait and say what actually went wrong.
  useEffect(() => {
    const started = Date.now();
    const check = setInterval(() => {
      if (window.cv && window.cv.Mat) {
        clearInterval(check);
        setCvReady(true);
      } else if (Date.now() - started > CV_LOAD_TIMEOUT_MS) {
        clearInterval(check);
        setCvLoadFailed(true);
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
      c.tiles = tiles.map((t) => ({ ...t, renderedTx: undefined, renderedTy: undefined, renderedTheta: undefined }));

      // Per-tile records are written once, at capture time, with the transform
      // the tile had *before* global relaxation touched it. The meta record is
      // rewritten continuously and carries the current (post-relax) transforms,
      // so prefer those — otherwise resuming silently threw away every
      // loop-closure correction earned during the previous session.
      const savedTransforms = meta && meta.transforms;
      if (Array.isArray(savedTransforms) && savedTransforms.length === c.tiles.length) {
        c.tiles.forEach((t, i) => {
          const m = savedTransforms[i];
          if (Array.isArray(m) && m.length === 9) t.transform = m.slice();
        });
      }

      // A persisted edge list can outlive the tiles it referenced (e.g. the last
      // action before the tab died was an undo), so validate before trusting it.
      const graph = rebuildAdjacency((meta && meta.edges) || [], c.tiles.length);
      c.edges = graph.edges;
      c.adjacency = graph.adjacency;
      refreshBBoxes(c.tiles);
      c.sharpnessHistory = tiles.filter((t) => !t.blurry && t.sharpness).map((t) => t.sharpness).slice(-SHARPNESS_HISTORY_SIZE);
      c.activeRefIndex = null;
      c.dbCleared = true; // we're continuing this DB content, not replacing it
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
    cv_.current.dbCleared = true;
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

  // ---- display canvas ----
  // The mosaic Mat is the source of truth at full resolution; the <canvas> is
  // only a view of it. Two things follow from that:
  //   * the view is downscaled when the mosaic outgrows what a browser canvas
  //     can hold (past that limit a canvas silently renders blank), and
  //   * it is updated *incrementally*. `cv.imshow` walks and converts every
  //     pixel of whatever Mat it is handed, so repainting the entire mosaic on
  //     every captured tile made per-tile cost grow with total scan area —
  //     quadratic overall, and by a few hundred tiles slow enough to stall the
  //     live loop on its own.
  const paintFull = useCallback(() => {
    const c = cv_.current;
    const canvas = mosaicCanvasRef.current;
    if (!canvas || !c.mosaicMat) return;
    const scale = fitScale(c.w, c.h, DISPLAY_MAX_DIM, DISPLAY_MAX_AREA);
    c.displayScale = scale;
    if (scale < 1) {
      const dw = Math.max(1, Math.round(c.w * scale));
      const dh = Math.max(1, Math.round(c.h * scale));
      const small = new cv.Mat();
      cv.resize(c.mosaicMat, small, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
      cv.imshow(canvas, small);
      small.delete();
    } else {
      cv.imshow(canvas, c.mosaicMat);
    }
    setCanvasDims({ w: c.w, h: c.h, scale });
  }, []);

  // Repaints just one rectangle of the mosaic (in mosaic pixel coords) onto the
  // display canvas, scaled into place.
  const paintRegion = useCallback((rect) => {
    const c = cv_.current;
    const canvas = mosaicCanvasRef.current;
    if (!canvas || !c.mosaicMat || !rect) return;
    if (rect.width <= 0 || rect.height <= 0) return;
    const s = c.displayScale || 1;
    // The display canvas must already be sized for the current mosaic, otherwise
    // a partial blit would land at the wrong place (this is the case on the very
    // first tile, when the canvas is still at its default 300x150). Fall back to a
    // full render whenever that invariant doesn't hold.
    if (canvas.width !== Math.max(1, Math.round(c.w * s)) || canvas.height !== Math.max(1, Math.round(c.h * s))) {
      paintFull();
      return;
    }
    const roi = c.mosaicMat.roi(new cv.Rect(rect.x, rect.y, rect.width, rect.height));
    // An ROI shares its parent's row stride, which imshow would misread — copy
    // it into a continuous Mat first.
    const cont = new cv.Mat();
    roi.copyTo(cont);
    roi.delete();
    const tmp = regionCanvasRef.current;
    cv.imshow(tmp, cont);
    cont.delete();

    const dx = Math.floor(rect.x * s);
    const dy = Math.floor(rect.y * s);
    const dw = Math.max(1, Math.ceil(rect.width * s));
    const dh = Math.max(1, Math.ceil(rect.height * s));
    const ctx = canvas.getContext('2d');
    // clear first: drawImage composites source-over, and unpainted mosaic area
    // must stay transparent so the empty-area backdrop shows through.
    ctx.clearRect(dx, dy, dw, dh);
    ctx.drawImage(tmp, 0, 0, rect.width, rect.height, dx, dy, dw, dh);
  }, [paintFull]);

  // Resizes the display canvas after the mosaic grew, translating the pixels
  // already on it instead of re-converting the whole mosaic. Setting
  // canvas.width/height wipes the canvas, so the old content is copied aside
  // first and blitted back at its new offset.
  const shiftDisplayCanvas = useCallback((growLeft, growTop) => {
    const c = cv_.current;
    const canvas = mosaicCanvasRef.current;
    if (!canvas) return;
    const s = c.displayScale;
    const newW = Math.max(1, Math.round(c.w * s));
    const newH = Math.max(1, Math.round(c.h * s));
    const hadContent = canvas.width > 1 && canvas.height > 1;
    let keep = null;
    if (hadContent) {
      keep = document.createElement('canvas');
      keep.width = canvas.width;
      keep.height = canvas.height;
      keep.getContext('2d').drawImage(canvas, 0, 0);
    }
    canvas.width = newW;
    canvas.height = newH;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, newW, newH);
    if (keep) ctx.drawImage(keep, Math.round(growLeft * s), Math.round(growTop * s));
    setCanvasDims({ w: c.w, h: c.h, scale: s });
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
    let growLeft = Math.max(0, Math.ceil(-minX));
    let growTop = Math.max(0, Math.ceil(-minY));
    let growRight = Math.max(0, Math.ceil(maxX - c.w));
    let growBottom = Math.max(0, Math.ceil(maxY - c.h));
    if (!growLeft && !growTop && !growRight && !growBottom) return false;

    // Pad whichever sides had to grow. Each growth reallocates and copies the
    // entire mosaic Mat and rebuilds the display canvas, so growing by a
    // generous chunk once every several tiles is far cheaper than growing by
    // the exact few hundred pixels the newest tile needed, every single tile.
    if (growLeft) growLeft += GROW_CHUNK_PX;
    if (growTop) growTop += GROW_CHUNK_PX;
    if (growRight) growRight += GROW_CHUNK_PX;
    if (growBottom) growBottom += GROW_CHUNK_PX;

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

    if (!c.suppressPaint) {
      // If growing pushed the mosaic across a display-scale threshold the whole
      // view has to be re-rendered at the new scale; otherwise the existing
      // pixels are still valid and only need translating.
      const newScale = fitScale(c.w, c.h, DISPLAY_MAX_DIM, DISPLAY_MAX_AREA);
      if (newScale !== c.displayScale) paintFull();
      else shiftDisplayCanvas(growLeft, growTop);
    }
    return true;
  }, [paintFull, shiftDisplayCanvas]);

  // Blends one tile into `targetMat` and returns the mosaic-space rectangle it
  // touched (or null if it fell entirely outside), so the caller can repaint
  // just that region of the display canvas.
  const composite = useCallback((mat, transform, tw, th, targetMat) => {
    const c = cv_.current;
    const Tc = matMul3(translateM(c.originX, c.originY), transform);

    // Bound the work to this tile's own footprint in mosaic coordinates.
    const corners = cornersOf(Tc, tw, th);
    const { minX, minY, maxX, maxY } = bboxOf(corners);
    const rx = Math.max(0, Math.floor(minX));
    const ry = Math.max(0, Math.floor(minY));
    const rw = Math.min(c.w, Math.ceil(maxX)) - rx;
    const rh = Math.min(c.h, Math.ceil(maxY)) - ry;
    if (rw <= 0 || rh <= 0) return null;

    // Warp straight into that footprint by folding the (-rx, -ry) shift into the
    // transform, rather than warping into a full mosaic-sized buffer and then
    // taking an ROI out of it. Warping mosaic-sized allocated width*height*4
    // bytes per tile — on a 300-field slide that is a ~675MB temporary Mat for
    // every single capture, on top of the mosaic itself, which exhausts the WASM
    // heap and aborts the page long before the scan finishes. Cost is now
    // proportional to tile size and independent of how far the scan has grown.
    const Toffset = matMul3(translateM(-rx, -ry), Tc);
    const Tmat = cv.matFromArray(3, 3, cv.CV_64FC1, Toffset);
    const warped = new cv.Mat();
    cv.warpPerspective(mat, warped, Tmat, new cv.Size(rw, rh), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
    Tmat.delete();

    // Every cv.Mat/MatVector allocated below gets pushed here and deleted once
    // at the end — with this many temporaries, tracking deletes inline is
    // error-prone and this runs on every captured tile, so leaks add up fast.
    const trash = [warped];
    const track = (m) => { trash.push(m); return m; };

    const rect = new cv.Rect(rx, ry, rw, rh);
    const warpedRoi = warped; // already exactly the footprint
    const targetRoi = track(targetMat.roi(rect));

    const channels = track(new cv.MatVector());
    cv.split(warpedRoi, channels);
    const [srcB, srcG, srcR, srcA] = [0, 1, 2, 3].map((i) => track(channels.get(i)));
    const mask = track(new cv.Mat());
    // Only trust fully-opaque pixels: near the tile's edge, linear interpolation
    // blends real content with the transparent (black) border, which darkens
    // those pixels even though their alpha isn't quite zero. A loose threshold
    // let that blended ring through, showing up as a thin dark seam at every
    // tile boundary.
    cv.threshold(srcA, mask, 250, 255, cv.THRESH_BINARY);
    // Erode a couple more pixels off the valid region as a safety margin, in
    // case of small misregistration at the boundary too.
    const eKernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    cv.erode(mask, mask, eKernel, new cv.Point(-1, -1), 2);

    const targetChannels = track(new cv.MatVector());
    cv.split(targetRoi, targetChannels);
    const [dstB, dstG, dstR, dstA] = [0, 1, 2, 3].map((i) => track(targetChannels.get(i)));
    const targetMask = track(new cv.Mat());
    cv.threshold(dstA, targetMask, 250, 255, cv.THRESH_BINARY);

    const overlapMask = track(new cv.Mat());
    cv.bitwise_and(mask, targetMask, overlapMask);
    const overlapCount = cv.countNonZero(overlapMask);
    const MIN_OVERLAP_PX = 400; // below this, per-channel means are too noisy to trust

    // ---- exposure/color gain compensation ----
    // Where this tile overlaps content already painted, nudge its brightness
    // per channel to match what's already there before blending it in — the
    // camera commonly auto-adjusts exposure/white-balance slightly frame to
    // frame, and without this a tile boundary shows up as a hard visible seam.
    const srcChans = [srcB, srcG, srcR];
    const dstChans = [dstB, dstG, dstR];
    if (overlapCount > MIN_OVERLAP_PX) {
      for (let i = 0; i < 3; i++) {
        const srcMean = cv.mean(srcChans[i], overlapMask)[0];
        const dstMean = cv.mean(dstChans[i], overlapMask)[0];
        if (srcMean > 1) {
          // Clamp: correct real exposure drift, not gross mismatches — those
          // more likely mean a bad overlap match than a lighting difference.
          const gain = Math.min(1.6, Math.max(0.6, dstMean / srcMean));
          srcChans[i].convertTo(srcChans[i], -1, gain, 0);
        }
      }
    }

    // ---- feather blend at the seam ----
    // Fade this tile in near its own edges (by distance from the mask
    // boundary) instead of a hard cutoff, so the transition into already-
    // painted content is gradual. Where there's no existing content at all
    // (targetMask empty), the formula collapses back to full opacity — brand
    // new mosaic area is still painted at full strength, nothing changes there.
    // Kept narrow on purpose: matching is never pixel-perfect, so blending
    // over a wide band mixes two slightly-misregistered copies of the same
    // structures — visible as blur/ghosting at the seam. A few px is enough
    // to erase the hard 1px cutoff from erosion above without exposing that
    // misregistration; color/exposure mismatch itself is already handled by
    // gain compensation above, so feathering isn't carrying that job too.
    const FEATHER_PX = 8;
    const dist = track(new cv.Mat());
    cv.distanceTransform(mask, dist, cv.DIST_L2, 3);
    const feather = track(new cv.Mat());
    dist.convertTo(feather, cv.CV_32F, 1 / FEATHER_PX, 0);
    cv.threshold(feather, feather, 1, 1, cv.THRESH_TRUNC); // clamp to <= 1

    const maskF = track(new cv.Mat());
    mask.convertTo(maskF, cv.CV_32F, 1 / 255);
    const targetMaskF = track(new cv.Mat());
    targetMask.convertTo(targetMaskF, cv.CV_32F, 1 / 255);
    const onesSingle = track(new cv.Mat(feather.rows, feather.cols, cv.CV_32F, new cv.Scalar(1)));
    const oneMinusFeather = track(new cv.Mat());
    cv.subtract(onesSingle, feather, oneMinusFeather);
    const oneMinusTargetMaskF = track(new cv.Mat());
    cv.subtract(onesSingle, targetMaskF, oneMinusTargetMaskF);

    // blendAlpha = feather + (1-feather)*(1-targetMaskF), then masked to this tile's footprint.
    const term = track(new cv.Mat());
    cv.multiply(oneMinusFeather, oneMinusTargetMaskF, term);
    const blendAlpha = track(new cv.Mat());
    cv.add(feather, term, blendAlpha);
    cv.multiply(blendAlpha, maskF, blendAlpha);
    const oneMinusAlpha = track(new cv.Mat());
    cv.subtract(onesSingle, blendAlpha, oneMinusAlpha);

    const outChannels = track(new cv.MatVector());
    for (let i = 0; i < 3; i++) {
      const s32 = track(new cv.Mat());
      srcChans[i].convertTo(s32, cv.CV_32F);
      const d32 = track(new cv.Mat());
      dstChans[i].convertTo(d32, cv.CV_32F);
      const a = track(new cv.Mat());
      cv.multiply(s32, blendAlpha, a);
      const b = track(new cv.Mat());
      cv.multiply(d32, oneMinusAlpha, b);
      const sum = track(new cv.Mat());
      cv.add(a, b, sum);
      const outCh = track(new cv.Mat());
      sum.convertTo(outCh, cv.CV_8U);
      outChannels.push_back(outCh);
    }
    // Alpha channel of the result: stay opaque wherever this tile is opaque
    // OR the mosaic already had content there.
    const outAlpha = track(new cv.Mat());
    cv.max(mask, dstA, outAlpha);
    outChannels.push_back(outAlpha);

    const blended = track(new cv.Mat());
    cv.merge(outChannels, blended);
    // Only actually touch pixels this tile's (eroded) mask covers — outside
    // that, the mosaic is left exactly as it was.
    blended.copyTo(targetRoi, mask);

    trash.forEach((m) => m.delete());
    return { x: rx, y: ry, width: rw, height: rh };
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

  // Also snapshots the current transforms. Per-tile records are only written
  // once, at capture time, so without this the globally-relaxed positions were
  // never saved anywhere and resuming a session silently reverted to the raw
  // chained placements. Nine numbers per tile is negligible next to the blobs.
  const persistMeta = () => {
    const c = cv_.current;
    db.saveMeta({
      edges: c.edges,
      transforms: c.tiles.map((t) => Array.from(t.transform)),
      tileCount: c.tiles.length,
      updatedAt: Date.now(),
    }).catch(() => {});
  };

  // Every tile permanently caches its own ORB features (kp/desc) once computed,
  // instead of the old single-slot "last tile only" cache. This matters a lot
  // for anchor/loop-closure checks and relocalization, which compare the
  // current frame against arbitrary OLDER tiles, not just the most recent one
  // — without this, every such check was re-decoding the tile's PNG blob and
  // re-running ORB detection from scratch, every single time, even for tiles
  // checked repeatedly (e.g. a busy anchor spot revisited across a zigzag).
  // Hands a freshly-computed feature set over to a tile. Ownership transfers:
  // the tile is now responsible for freeing it (via freeTileFeatures or cache
  // eviction), and the caller must not free it.
  const attachFeatures = (tile, feat) => {
    const c = cv_.current;
    tile._kp = feat.kp;
    tile._desc = feat.desc;
    tile._small = feat.small;
    tile._featSeq = ++c.featSeq;
  };

  const getTileFeatures = async (tile) => {
    const c = cv_.current;
    if (tile._kp && tile._desc && tile._small) {
      tile._featSeq = ++c.featSeq;
      return { kp: tile._kp, desc: tile._desc, small: tile._small };
    }
    const mat = await blobToMat(tile.blob);
    const feat = computeFeatures(mat);
    mat.delete();
    attachFeatures(tile, feat);
    return feat;
  };

  // Caching every tile's features forever is what makes revisiting an old anchor
  // fast, but it is also ~180KB of non-GC'd WASM heap per tile with no ceiling.
  // Keep the most recently used ones and drop the rest; anything evicted is
  // simply recomputed from its blob the next time it's needed. The newest tiles
  // and the active reference are pinned, since those are certain to be used
  // again on the very next tick.
  const evictFeatureCache = () => {
    const c = cv_.current;
    const cached = [];
    const protectFrom = c.tiles.length - FEATURE_CACHE_PROTECT_RECENT;
    for (let i = 0; i < c.tiles.length; i++) {
      const t = c.tiles[i];
      if (!t._desc) continue;
      if (i >= protectFrom || i === c.activeRefIndex) continue;
      cached.push({ i, seq: t._featSeq || 0 });
    }
    const total = c.tiles.reduce((n, t) => n + (t._desc ? 1 : 0), 0);
    let over = total - MAX_CACHED_FEATURES;
    if (over <= 0) return;
    cached.sort((a, b) => a.seq - b.seq);
    for (const { i } of cached) {
      if (over <= 0) break;
      freeTileFeatures(c.tiles[i]);
      over--;
    }
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
    if (tile._small) {
      tile._small.delete();
      tile._small = null;
    }
    tile._featSeq = 0;
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
    // Every tile is about to be repainted anyway, so skip the per-tile display
    // updates growCanvasIfNeeded would otherwise trigger and paint once at the end.
    c.suppressPaint = true;
    try {
      for (const tile of c.tiles) {
        growCanvasIfNeeded(tile.transform, tile.w, tile.h);
        const mat = await blobToMat(tile.blob);
        composite(mat, tile.transform, tile.w, tile.h, c.mosaicMat);
        mat.delete();
        tile.renderedTx = tile.transform[2];
        tile.renderedTy = tile.transform[5];
        tile.renderedTheta = angleOf(tile.transform);
      }
    } finally {
      c.suppressPaint = false;
    }
    paintFull();
    c.lastRebuildTileCount = c.tiles.length;
    c.lastRebuildTime = Date.now();
    setTileCount(c.tiles.length);
  }, [composite, blobToMat, growCanvasIfNeeded, paintFull]);

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

  // ---- navigation aid: outer guide frame + "ghost" of the last tile's
  // leading edge, both drawn live on the video while scanning ----
  // Inner frame = the crop box above (what's actually used for matching).
  // Outer frame here is a purely visual guide, expanded around it, with a
  // translucent ghost of the edge of the last captured tile pinned to
  // whichever side you're moving toward — drag until the live picture there
  // visually lines up with the ghost, and you know there's enough overlap
  // for the next capture to match. No pixel-precise tracking involved, this
  // is just an eyeballing aid — the actual matching still runs independently
  // on the captured frame afterward.
  const NAV_MARGIN_FRAC = 0.35; // outer frame = crop box expanded by this fraction on each side
  const GHOST_STRIP_FRAC = 0.3; // how much of the last tile's edge is shown as a ghost
  const navOverlay = (() => {
    if (!capturing || !videoRef.current || !previewContainerRef.current || !videoRef.current.videoWidth) return null;
    const content = getVideoContentRect(previewContainerRef.current, videoRef.current);
    const base = cropBox
      ? { x: cropBox.x, y: cropBox.y, w: cropBox.w, h: cropBox.h }
      : { x: 0, y: 0, w: videoRef.current.videoWidth, h: videoRef.current.videoHeight };
    const mx = base.w * NAV_MARGIN_FRAC;
    const my = base.h * NAV_MARGIN_FRAC;
    const outerNative = { x: base.x - mx, y: base.y - my, w: base.w + mx * 2, h: base.h + my * 2 };
    const outerStyle = {
      left: content.x + outerNative.x * content.scale,
      top: content.y + outerNative.y * content.scale,
      width: outerNative.w * content.scale,
      height: outerNative.h * content.scale,
    };

    // Direction from the last real step, so we know which edge of the last
    // tile to ghost and which side of the outer frame to pin it to.
    const c = cv_.current;
    const refIdx = c.activeRefIndex !== null ? c.activeRefIndex : c.tiles.length - 1;
    const refTile = refIdx >= 0 ? c.tiles[refIdx] : null;
    let dir = null;
    if (refTile && refIdx >= 1) {
      const prev2 = c.tiles[refIdx - 1];
      const dx = refTile.transform[2] - prev2.transform[2];
      const dy = refTile.transform[5] - prev2.transform[5];
      if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
        dir = Math.abs(dy) >= Math.abs(dx) ? { axis: 'y', sign: dy >= 0 ? 1 : -1 } : { axis: 'x', sign: dx >= 0 ? 1 : -1 };
      }
    }
    return { outerStyle, refTile, dir };
  })();

  const ghostOverlay = (() => {
    if (!navOverlay || !navOverlay.refTile || !navOverlay.dir || !ghostUrl) return null;
    const { refTile, dir, outerStyle } = navOverlay;
    const content = getVideoContentRect(previewContainerRef.current, videoRef.current);
    const tileCssW = refTile.w * content.scale;
    const tileCssH = refTile.h * content.scale;

    let wrapStyle, imgStyle, label;
    if (dir.axis === 'y') {
      const stripCssH = tileCssH * GHOST_STRIP_FRAC;
      wrapStyle = {
        left: outerStyle.left + (outerStyle.width - tileCssW) / 2,
        width: tileCssW,
        height: stripCssH,
        top: dir.sign >= 0 ? outerStyle.top : outerStyle.top + outerStyle.height - stripCssH,
      };
      imgStyle = { width: tileCssW, height: tileCssH, left: 0, top: dir.sign >= 0 ? -(tileCssH - stripCssH) : 0 };
      label = dir.sign >= 0 ? 'Mép dưới, lần chụp trước' : 'Mép trên, lần chụp trước';
    } else {
      const stripCssW = tileCssW * GHOST_STRIP_FRAC;
      wrapStyle = {
        top: outerStyle.top + (outerStyle.height - tileCssH) / 2,
        height: tileCssH,
        width: stripCssW,
        left: dir.sign >= 0 ? outerStyle.left : outerStyle.left + outerStyle.width - stripCssW,
      };
      imgStyle = { width: tileCssW, height: tileCssH, top: 0, left: dir.sign >= 0 ? -(tileCssW - stripCssW) : 0 };
      label = dir.sign >= 0 ? 'Mép phải, lần chụp trước' : 'Mép trái, lần chụp trước';
    }
    return { wrapStyle, imgStyle, label };
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

  // ---- cheap pre-capture check: is now actually worth capturing? ----
  // The nav-box/ghost overlay shows you the reference tile's leading edge so
  // you can eyeball overlap — this reuses the exact same signal (leading-edge
  // strip vs. reference tile) but puts it to work deciding *when* the real
  // pipeline below should even run, instead of blindly running the full
  // ORB + candidate-pool match every single timer tick regardless of whether
  // you've moved. Deliberately cheap: a small downscaled grab + one
  // matchTemplate call, no ORB, no candidate pool, no PNG encode. Only ever
  // used to SKIP a tick early (fail open on any uncertainty) — it never
  // blocks or delays a capture that the real pipeline would've accepted.
  const MIN_MOVE_FRAC = 0.12; // skip capturing while less than this fraction of the tile has been traversed since the reference
  const quickOverlapCheck = () => {
    const c = cv_.current;
    const refIdx = c.activeRefIndex !== null ? c.activeRefIndex : c.tiles.length - 1;
    const refTile = refIdx >= 0 ? c.tiles[refIdx] : null;
    if (!refTile || refIdx < 1 || !refTile._small) return null; // not enough history yet — always capture
    const prev2 = c.tiles[refIdx - 1];
    const dx = refTile.transform[2] - prev2.transform[2];
    const dy = refTile.transform[5] - prev2.transform[5];
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
    const dir = Math.abs(dy) >= Math.abs(dx) ? { axis: 'y', sign: dy >= 0 ? 1 : -1 } : { axis: 'x', sign: dx >= 0 ? 1 : -1 };

    const v = videoRef.current;
    const crop = cropRef.current;
    const sx = crop ? crop.x : 0, sy = crop ? crop.y : 0;
    const sw = crop ? crop.w : v.videoWidth, sh = crop ? crop.h : v.videoHeight;
    if (!sw || !sh) return null;

    // Must match the scale computeFeatures used for the cached `_small` copies:
    // template-matching a 220px-wide live frame against a 300px-wide reference is
    // correlating two different magnifications of the same scene, which scores
    // below threshold essentially always — so the gate never fired and the
    // expensive full pipeline ran on every tick regardless.
    const scale = Math.min(1, CROSSCHECK_MAX_DIM / Math.max(sw, sh));
    const qw = Math.max(8, Math.round(sw * scale));
    const qh = Math.max(8, Math.round(sh * scale));
    const qc = quickCanvasRef.current;
    qc.width = qw;
    qc.height = qh;
    qc.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, qw, qh);

    const liveMat = cv.imread(qc);
    const liveGray = new cv.Mat();
    cv.cvtColor(liveMat, liveGray, cv.COLOR_RGBA2GRAY);
    liveMat.delete();

    const dim = dir.axis === 'y' ? qh : qw;
    const templateLen = Math.max(6, Math.round(dim * 0.2));
    const refSmall = refTile._small;
    if (refSmall.rows < templateLen + 1 || refSmall.cols < templateLen + 1 || qh < templateLen + 1 || qw < templateLen + 1) {
      liveGray.delete();
      return null;
    }

    let template;
    if (dir.axis === 'y') {
      template = dir.sign > 0 ? liveGray.roi(new cv.Rect(0, 0, qw, templateLen)) : liveGray.roi(new cv.Rect(0, qh - templateLen, qw, templateLen));
    } else {
      template = dir.sign > 0 ? liveGray.roi(new cv.Rect(0, 0, templateLen, qh)) : liveGray.roi(new cv.Rect(qw - templateLen, 0, templateLen, qh));
    }
    const result = new cv.Mat();
    let movedFrac = null;
    try {
      cv.matchTemplate(refSmall, template, result, cv.TM_CCOEFF_NORMED);
      const mm = cv.minMaxLoc(result);
      if (mm.maxVal >= 0.25) {
        const off = dir.axis === 'y' ? mm.maxLoc.y : mm.maxLoc.x;
        const refDim = dir.axis === 'y' ? refSmall.rows : refSmall.cols;
        const tSmall = dir.sign > 0 ? off : off - (refDim - templateLen);
        movedFrac = Math.min(1, Math.abs(tSmall) / refDim);
      }
    } finally {
      result.delete();
      template.delete();
      liveGray.delete();
    }
    return movedFrac;
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
      // Cheap gate: don't even grab a full-res frame if we clearly haven't
      // moved far enough yet — returns null (proceed normally) on any
      // uncertainty, so this only ever skips clear-cut "barely moved" ticks.
      const movedFrac = quickOverlapCheck();
      if (movedFrac !== null && movedFrac < MIN_MOVE_FRAC) {
        logDiag('skip', `bỏ qua: mới di chuyển ${Math.round(movedFrac * 100)}% khung (cần ≥ ${Math.round(MIN_MOVE_FRAC * 100)}%)`);
        return;
      }

      const { mat, w, h, blobPromise } = grabVideoFrame();

      if (c.tiles.length === 0) {
        // Starting a genuinely new scan: wipe whatever a previous session left in
        // IndexedDB first. Otherwise, if the user dismissed nothing and simply
        // ignored the "unfinished session found" banner, the old records at
        // higher indices survive, new tiles overwrite the low indices, and a
        // later crash-resume loads a spliced-together mixture of two scans.
        if (!c.dbCleared) {
          await db.clearAll().catch(() => {});
          c.dbCleared = true;
          setResumePrompt(null);
        }
        ensureMosaic(w + INIT_PAD * 2, h + INIT_PAD * 2);
        const rect0 = composite(mat, IDENT, w, h, c.mosaicMat);
        paintRegion(rect0);
        const blob = await blobPromise;
        const sharp = evaluateSharpness(mat);
        const baseTile = {
          transform: IDENT.slice(), w, h, blob, bbox: tileBBox(IDENT, w, h), capturedAt: Date.now(),
          renderedTx: 0, renderedTy: 0, renderedTheta: 0, sharpness: sharp.value, blurry: sharp.blurry,
        };
        c.tiles.push(baseTile);
        persistTile(0, baseTile);
        persistMeta();
        if (sharp.blurry) setBlurryCount((n) => n + 1);
        attachFeatures(baseTile, computeFeatures(mat));
        mat.delete();
        c.autoFails = 0;
        c.lastRebuildTileCount = 1;
        c.activeRefIndex = 0;
        c.lastRebuildTime = Date.now();
        setTileCount(1);
        logDiag('ok', `đặt ô nền #1 (${w}×${h}px)`);
        setMatchInfo({ text: 'Ô nền (#1) đã đặt — kéo tiêu bản để tiếp tục.', kind: 'ok' });
        return;
      }

      // ---- reference search: try a small pool of tiles ranked by predicted
      // position, not just the last one captured ----
      // The chronologically-previous tile isn't always the geometrically
      // closest one right now — right after a scan direction change, the
      // true nearest tile can be from an earlier row/column, not the one
      // captured a second ago. Searching a small ranked pool instead of a
      // single fixed reference is what actually fixes losing track at a
      // direction change, rather than just reacting to it afterward.
      const primaryIndex = c.activeRefIndex !== null ? c.activeRefIndex : c.tiles.length - 1;
      const primaryTile = c.tiles[primaryIndex];

      // Predicted placement, extrapolated the same way the guess-fallback
      // below already does — used only to rank candidates and compute each
      // candidate's own local expected offset, not to place anything directly.
      let predWorldDX = 0, predWorldDY = 0;
      if (primaryIndex >= 1) {
        const prev2 = c.tiles[primaryIndex - 1];
        predWorldDX = primaryTile.transform[2] - prev2.transform[2];
        predWorldDY = primaryTile.transform[5] - prev2.transform[5];
      }
      const predictedTransform = primaryTile.transform.slice();
      predictedTransform[2] += predWorldDX;
      predictedTransform[5] += predWorldDY;
      const predictedBBox = tileBBox(predictedTransform, w, h);

      const featNew = computeFeatures(mat);
      const candidates = findCandidateTiles(c.tiles, predictedBBox, [], CANDIDATE_POOL_SIZE, 0.05);
      // Always guarantee the chronological tile gets tried even if it didn't
      // rank in the bbox-overlap pool (e.g. barely dragged yet, so bboxes
      // only just touch) — it's still the single most likely match.
      if (!candidates.some((cand) => cand.index === primaryIndex)) {
        candidates.push({ index: primaryIndex, tile: primaryTile, ratio: 0 });
      }

      let m = null;
      let prevIndex = null;
      let prevTile = null;
      const mode = MATCH_MODES[uiRef.current.matchMode] || MATCH_MODES.balanced;
      const tuning = {
        minInliers: mode.minInliers, minRatio: mode.minRatio,
        axisTolPx: mode.axisTolPx, crossCheckVetoScore: mode.crossCheckVetoScore,
      };
      const failures = [];
      // Pass 1 (cheap): ORB-only fit for every candidate, no cross-correlation —
      // just enough to rank them.
      const trialResults = [];
      for (const cand of candidates) {
        const candFeat = await getTileFeatures(cand.tile);
        const [localExpDX, localExpDY] = applyInverseLinear(
          cand.tile.transform,
          predictedTransform[2] - cand.tile.transform[2],
          predictedTransform[5] - cand.tile.transform[5]
        );
        const trial = matchTiles(featNew.kp, featNew.desc, candFeat.kp, candFeat.desc, {
          ...tuning, axisLock: mode.axisLock, expectedDX: localExpDX, expectedDY: localExpDY, skipCrossCheck: true,
        });
        if (trial.ok) trialResults.push({ cand, candFeat, localExpDX, localExpDY, inliers: trial.inliers });
        else failures.push(`ô #${cand.index + 1}: ${trial.reason || 'không khớp'}`);
      }
      trialResults.sort((a, b) => b.inliers - a.inliers);
      // Pass 2 (only as many as needed): re-check the top candidate(s) with
      // the pixel cross-correlation consensus enabled, falling through to the
      // next-best only if the leader doesn't actually pass it — so on a
      // normal tick this runs the expensive check exactly once, not once per
      // candidate.
      for (const r of trialResults) {
        const verified = matchTiles(featNew.kp, featNew.desc, r.candFeat.kp, r.candFeat.desc, {
          ...tuning, axisLock: mode.axisLock, expectedDX: r.localExpDX, expectedDY: r.localExpDY,
          newSmall: featNew.small, prevSmall: r.candFeat.small, tileW: w, tileH: h,
        });
        if (!verified.ok) {
          failures.push(`ô #${r.cand.index + 1} (xác nhận): ${verified.reason || 'không khớp'}`);
          continue;
        }
        // In loose mode the unconstrained estimator is doing the work, and it has
        // no built-in guard against locking onto a repeated structure — so check
        // the result is physically plausible before accepting it.
        if (!mode.axisLock) {
          const rot = Math.abs(angleOf(verified.H));
          const sc = Math.hypot(verified.H[0], verified.H[3]);
          const offErr = Math.hypot(verified.H[2] - r.localExpDX, verified.H[5] - r.localExpDY);
          const maxOff = Math.max(w, h) * LOOSE_MAX_OFFSET_FRAC;
          if (rot > LOOSE_MAX_ROT_RAD || Math.abs(sc - 1) > LOOSE_SCALE_TOL || offErr > maxOff) {
            failures.push(
              `ô #${r.cand.index + 1}: kết quả bất hợp lý (xoay ${((rot * 180) / Math.PI).toFixed(1)}°, ` +
              `tỉ lệ ${sc.toFixed(2)}, lệch dự đoán ${Math.round(offErr)}px)`
            );
            continue;
          }
        }
        m = verified;
        prevIndex = r.cand.index;
        prevTile = r.cand.tile;
        break;
      }
      if (!m) m = { ok: false, inliers: 0, total: 0, reason: failures[0] };
      if (prevIndex === null) {
        prevIndex = primaryIndex;
        prevTile = primaryTile;
      }

      // Runs the shared warm-started relaxation pass, then checks whether any
      // already-painted tile drifted enough (or enough time/tiles have passed)
      // to justify the cost of a full mosaic repaint.
      const relaxAndMaybeRebuild = async () => {
        relax(c.tiles, c.adjacency, 0, RELAX_ITERS_PER_TICK);
        // relax() moves tiles, so the cached world-space bboxes every overlap
        // search and the ZIP export read from are now out of date.
        refreshBBoxes(c.tiles);
        evictFeatureCache();
        const drift = maxRenderedDrift(c.tiles);
        const dueForRebuild =
          drift > REBUILD_DRIFT_PX &&
          (c.tiles.length - c.lastRebuildTileCount >= REBUILD_MIN_TILES || Date.now() - c.lastRebuildTime >= REBUILD_MAX_MS);
        if (dueForRebuild) {
          await rebuildMosaic();
          // A full repaint can take a while (every tile is re-warped/re-blended
          // from scratch), during which live frames are silently skipped (autoTick
          // bails out early while c.busy is set) — the slide may have moved well
          // past where matching was left off by the time this finishes. Treat it
          // the same as an explicit pause: require one genuine match before
          // trusting extrapolation again, instead of risking a bad guess anchor.
          c.justResumed = true;
          c.consecutiveGuesses = 0;
        }
        persistMeta(); // snapshot the post-relax transforms, not the raw chained ones
      };

      if (!m.ok) {
        // Low-texture / motion-blur frame — normally guess from recent motion
        // instead of stopping. But right after a pause (justResumed) or after
        // several guesses in a row with no real match confirming them, the
        // "recent motion" we'd extrapolate from is no longer trustworthy —
        // the physical position could be anywhere — so require a genuine
        // match before placing anything in that situation instead of risking
        // a bad anchor that every later tile then chains from.
        let usedGuess = false;
        // prevIndex >= 1 matters independently of tiles.length: the reference the
        // candidate search settled on can be tile 0, which has no predecessor to
        // extrapolate a motion vector from.
        const guessAllowed = !c.justResumed && c.consecutiveGuesses < MAX_CONSECUTIVE_GUESSES;
        if (guessAllowed && c.tiles.length >= 2 && prevIndex >= 1) {
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
            const rectG = composite(mat, guessTransform, w, h, c.mosaicMat);
            paintRegion(rectG);
            const newIndex = c.tiles.length;
            const guessTile = {
              transform: guessTransform, w, h, blob, bbox: tileBBox(guessTransform, w, h), capturedAt: Date.now(),
              estimated: true, renderedTx: guessTransform[2], renderedTy: guessTransform[5],
              renderedTheta: angleOf(guessTransform),
              sharpness: sharp.value, blurry: sharp.blurry,
            };
            c.tiles.push(guessTile);
            attachFeatures(guessTile, featNew); // ownership transfers; not freed below
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
            c.consecutiveGuesses += 1;
            c.activeRefIndex = newIndex;
            logDiag('guess', `ước lượng vị trí (không khớp được: ${m.reason || 'không rõ'})`);
            await relaxAndMaybeRebuild();
            setTileCount(c.tiles.length);
            setMatchInfo({ text: 'Vùng ít chi tiết — đã ước lượng vị trí theo hướng di chuyển gần nhất.' + (sharp.blurry ? ' (ô này có thể bị mờ)' : ''), kind: 'warn' });
            usedGuess = true;
          }
        }
        if (!usedGuess) {
          // Nothing took ownership of these features, so free all three Mats.
          // Freeing only kp/desc here leaked `small` (~90KB of WASM heap) on
          // what is one of the two most frequently taken paths in the loop.
          freeFeatures(featNew);
          c.autoFails += 1;
          logDiag('fail', 'không đặt được ô — ' + (m.reason || 'không khớp'));
          if (m.unsupported) {
            setMatchInfo({ text: 'Trình duyệt/bản OpenCV.js hiện tại thiếu hàm cần thiết để so khớp ảnh — không thể ghép tự động. Thử lại bằng Chrome/Edge bản mới nhất.', kind: 'warn' });
          } else if (c.justResumed) {
            setMatchInfo({ text: 'Chưa khớp lại được sau khi tiếp tục — đưa tiêu bản về gần vị trí ô cuối cùng đã chụp (xem "Ô đã chụp"), hoặc dùng "Định vị thủ công".', kind: 'warn' });
          } else if (!guessAllowed) {
            setMatchInfo({ text: 'Mất khớp nhiều lần liên tiếp — dừng tự ước lượng để tránh lệch chồng chất. Kéo chậm lại hoặc dùng "Định vị thủ công" để khớp lại.', kind: 'warn' });
          } else if (c.autoFails >= AUTO_FAIL_WARN) {
            setMatchInfo({ text: 'Mất khớp liên tục — kéo chậm lại một chút để lấy nét ổn định.', kind: 'warn' });
          }
        }
        mat.delete();
        return;
      }

      // A genuine match against the current reference — whatever pause or
      // string of guesses came before is now confirmed resolved.
      c.justResumed = false;
      c.consecutiveGuesses = 0;

      const moveMag = Math.hypot(m.H[2], m.H[5]);
      const threshold = Math.max(AUTO_MOVE_MIN_PX, w * AUTO_MOVE_MIN_RATIO);
      if (moveMag < threshold) {
        logDiag('skip', `khớp được nhưng chỉ dịch ${Math.round(moveMag)}px (cần ≥ ${Math.round(threshold)}px)`);
        freeFeatures(featNew); // same leak as above — `small` was never released here
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
      const rectN = composite(mat, transform, w, h, c.mosaicMat);
      paintRegion(rectN);
      const newTile = {
        transform, w, h, blob, bbox: tileBBox(transform, w, h), capturedAt: Date.now(),
        renderedTx: transform[2], renderedTy: transform[5], renderedTheta: angleOf(transform),
        sharpness: sharp.value, blurry: sharp.blurry,
      };
      c.tiles.push(newTile);
      attachFeatures(newTile, featNew);
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
            // Unlike the axisLock chain match above, this general (free
            // rotation/scale) estimator has no built-in defense against
            // repetitive-texture aliasing — RANSAC can still pick a cluster
            // of points matched onto a neighboring identical-looking
            // structure, especially on very regular tissue, and there's
            // nothing in estimateGeneralTransform to catch that. But both
            // tiles are already placed in the mosaic, so we know
            // approximately what am.H's translation *should* be — sanity
            // check the actual result against that, and reject anything
            // wildly off instead of wiring a misaligned loop-closure into
            // the pose graph (which visibly shows up as "same physical area,
            // content doesn't actually line up" once revisited later).
            const [expLdx, expLdy] = applyInverseLinear(
              anchor.transform, transform[2] - anchor.transform[2], transform[5] - anchor.transform[5]
            );
            const offErr = Math.hypot(am.H[2] - expLdx, am.H[5] - expLdy);
            const maxOffErr = Math.max(w, h) * 0.5;
            if (offErr <= maxOffErr) {
              // Same as the chain edge above: am.H is already local to the anchor's frame.
              addEdge(c.edges, c.adjacency, anchorIndex, newIndex, am.H[2], am.H[5], angleOf(am.H), am.inliers);
              usedAnchor = true;
            }
          }
        }
      }

      await relaxAndMaybeRebuild();
      persistMeta();
      setTileCount(c.tiles.length);
      logDiag(
        'ok',
        `đặt ô #${newIndex + 1} theo trục ${m.axis || 'tự do'}, ${m.inliers}/${m.total} điểm nội` +
          (m.crossChecked ? ', đã đối chiếu pixel' : '') +
          (usedAnchor ? ', có điểm neo' : '')
      );
      setMatchInfo({
        text:
          (usedAnchor
            ? `Phát hiện trùng vùng đã quét trước đó — đang chỉnh lại vị trí các ô liên quan cho khớp hơn (bình thường, không phải lỗi). ${m.inliers}/${m.total} điểm nội.`
            : `Đã nối tự động — ${m.inliers}/${m.total} điểm nội (${Math.round((m.inliers / m.total) * 100)}%).`) +
          (sharp.blurry ? ' Ô này có thể bị mờ — xem trong "Ô đã chụp".' : ''),
        kind: sharp.blurry ? 'warn' : 'ok',
      });
    } catch (err) {
      // Without this, any exception in here (an OpenCV abort, a WASM allocation
      // failure, a bug like the ones above) became an unhandled promise
      // rejection: the timer kept firing, the status block kept showing the last
      // successful message, and the scan simply stopped recording tiles with no
      // indication anything was wrong. For a tool someone is relying on mid-slide
      // that is the worst possible failure mode — stop loudly instead.
      stopAuto();
      const msg = err && err.message ? err.message : String(err);
      setMatchInfo({
        text: 'Đã dừng ghép tự động do lỗi xử lý ảnh: ' + msg +
          ' — dữ liệu đã chụp vẫn được giữ. Thử bấm "Tối ưu & vẽ lại ngay", hoặc xuất ZIP để giữ kết quả rồi tải lại trang.',
        kind: 'warn',
      });
      logDiag('fail', 'lỗi: ' + msg);
      // eslint-disable-next-line no-console
      console.error('[panorama] autoTick failed', err);
    } finally {
      c.busy = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composite, ensureMosaic, growCanvasIfNeeded, paintFull, paintRegion, blobToMat, rebuildMosaic]);

  const autoTickRef = useRef(autoTick);
  useEffect(() => { autoTickRef.current = autoTick; }, [autoTick]);

  const startAuto = () => {
    if (autoTimerRef.current || !uiRef.current.capturing) return;
    const c = cv_.current;
    c.autoFails = 0;
    // Require one genuine feature match before any extrapolated "guess"
    // placement is allowed — after a pause, the slide/lens may have moved
    // arbitrarily far from the last captured tile, so trusting the pre-pause
    // motion to extrapolate a new position is unsafe and can plant a wrong
    // tile that everything afterward then chains from.
    c.justResumed = true;
    c.consecutiveGuesses = 0;
    setMatchInfo({
      text: c.tiles.length > 1
        ? 'Đang tiếp tục — đưa tiêu bản về gần vị trí ô cuối cùng đã chụp để khớp lại.'
        : 'Đang ghép tự động — kéo tiêu bản dưới kính hiển vi.',
      kind: 'ok',
    });
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
    // Two separate scales are in play: CSS layout size vs. canvas backing store,
    // and canvas backing store vs. the full-resolution mosaic (the display canvas
    // is downscaled once the mosaic outgrows the browser's canvas limits). Both
    // have to be undone to land on a mosaic pixel.
    const canvasX = ((e.clientX - rect.left) * canvas.width) / rect.width;
    const canvasY = ((e.clientY - rect.top) * canvas.height) / rect.height;
    const c = cv_.current;
    const s = c.displayScale || 1;
    setTargetWorld({ x: canvasX / s - c.originX, y: canvasY / s - c.originY });
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
        freeFeatures(featNew); // `small` was leaking here too
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
      const rectT = composite(mat, transform, w, h, c.mosaicMat);
      paintRegion(rectT);
      const newTile = {
        transform, w, h, blob, bbox: tileBBox(transform, w, h), capturedAt: Date.now(),
        renderedTx: transform[2], renderedTy: transform[5], renderedTheta: angleOf(transform),
        sharpness: sharp.value, blurry: sharp.blurry,
      };
      c.tiles.push(newTile);
      attachFeatures(newTile, featNew);
      persistTile(newIndex, newTile);
      if (sharp.blurry) setBlurryCount((n) => n + 1);
      addEdge(c.edges, c.adjacency, best.index, newIndex, best.m.H[2], best.m.H[5], angleOf(best.m.H), best.m.inliers);
      persistMeta();
      c.autoFails = 0;
      c.activeRefIndex = newIndex; // continuous scanning will now chain from here
      relax(c.tiles, c.adjacency, 0, RELAX_ITERS_PER_TICK);
      refreshBBoxes(c.tiles);
      persistMeta();
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
        // Old position is still a good prior for where this tile should be
        // relative to this neighbor — recapture usually just refines a very
        // similar spot, so it's a reasonable tie-breaker on repetitive texture.
        // matchTiles expects the offset in the *neighbour's own* frame (that's
        // what its axis hypotheses are compared against), so the world-space
        // delta has to be rotated back through the neighbour's linear part.
        const [expectedDX, expectedDY] = applyInverseLinear(
          neighbor.transform,
          c.tiles[index].transform[2] - neighbor.transform[2],
          c.tiles[index].transform[5] - neighbor.transform[5]
        );
        const mm = matchTiles(featNew.kp, featNew.desc, neighborFeat.kp, neighborFeat.desc, {
          axisLock: true, expectedDX, expectedDY,
          newSmall: featNew.small, prevSmall: neighborFeat.small, tileW: w, tileH: h,
        });
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
        _small: featNew.small,
        zstack: undefined,
      };
      if (sharp.blurry) setBlurryCount((n) => n + 1);
      persistTile(index, c.tiles[index]);
      persistMeta();
      mat.delete();
      if (newEdges.length > 0) {
        relax(c.tiles, c.adjacency, 0, 60);
        refreshBBoxes(c.tiles);
        persistMeta();
      }
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
        // Same prior as recaptureTile, in the neighbour's own frame. `tileW`/
        // `tileH` come from the chosen layer: there is no `w`/`h` in this scope
        // (unlike the other capture paths, which destructure them from
        // grabVideoFrame), so referencing them threw a ReferenceError and made
        // the whole Z-stack feature fail every single time it was used.
        const [expectedDX, expectedDY] = applyInverseLinear(
          neighbor.transform,
          c.tiles[index].transform[2] - neighbor.transform[2],
          c.tiles[index].transform[5] - neighbor.transform[5]
        );
        const mm = matchTiles(featNew.kp, featNew.desc, neighborFeat.kp, neighborFeat.desc, {
          axisLock: true, expectedDX, expectedDY,
          newSmall: featNew.small, prevSmall: neighborFeat.small, tileW: best.w, tileH: best.h,
        });
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
        _small: featNew.small,
        zstack: scored.map((l) => ({ blob: l.blob, sharpness: l.sharpness })),
      };
      if (blurryFlag) setBlurryCount((n) => n + 1);
      persistTile(index, c.tiles[index]);
      if (newEdges.length > 0) {
        relax(c.tiles, c.adjacency, 0, 60);
        refreshBBoxes(c.tiles);
      }
      persistMeta();
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
    if (c.tiles.length === 0 || c.busy) return;
    c.busy = true;
    try {
      const removedIndex = c.tiles.length - 1;
      const removedTile = c.tiles.pop();
      removeEdgesForTile(c.edges, c.adjacency, removedIndex);
      c.adjacency.length = c.tiles.length;
      freeTileFeatures(removedTile);
      if (removedTile.blurry) setBlurryCount((n) => Math.max(0, n - 1));

      // The active reference is set to each new tile's index as it's captured, so
      // after popping the last tile it points one past the end. Left dangling, the
      // very next auto tick dereferenced tiles[undefined] and threw on every
      // subsequent tick — i.e. a single "undo" silently ended the scan session.
      if (c.activeRefIndex === null || c.activeRefIndex >= c.tiles.length) {
        c.activeRefIndex = c.tiles.length > 0 ? c.tiles.length - 1 : null;
      }
      // Anything extrapolated from motion around the removed tile is no longer
      // trustworthy — require a real match before guessing again.
      c.justResumed = true;
      c.consecutiveGuesses = 0;

      db.deleteTilesFrom(removedIndex).catch(() => {});
      refreshBBoxes(c.tiles);
      persistMeta();
      await rebuildMosaic();
      setTilePanelVersion((v) => v + 1);
      setMatchInfo({ text: 'Đã hoàn tác ô cuối.', kind: 'idle' });
    } catch (e) {
      setMatchInfo({ text: 'Hoàn tác thất bại: ' + (e && e.message ? e.message : e), kind: 'warn' });
    } finally {
      c.busy = false;
    }
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
    c.justResumed = true;
    c.consecutiveGuesses = 0;
    c.displayScale = 1;
    c.dbCleared = true; // we just cleared it below
    c.suppressPaint = false;
    setBlurryCount(0);
    db.clearAll().catch(() => {});
    setTileCount(0);
    setCanvasDims({ w: 0, h: 0, scale: 1 });
    setTargetMode(false);
    setTargetWorld(null);
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
      refreshBBoxes(c.tiles);
      persistMeta();
      setMatchInfo({ text: 'Đang vẽ lại ảnh ghép sau khi tối ưu…', kind: 'idle' });
      await rebuildMosaic();
      setMatchInfo({ text: 'Đã tối ưu vị trí toàn cục và vẽ lại ảnh ghép.', kind: 'ok' });
    } finally {
      c.busy = false;
    }
  };

  // Renders straight from the full-resolution mosaic Mat rather than reading back
  // the display canvas — the on-screen canvas is deliberately downscaled once the
  // mosaic outgrows what a browser canvas can hold, so exporting it would quietly
  // hand back a reduced image. Only falls back to downscaling if the mosaic is
  // larger than a canvas can represent at all, and says so when it does.
  const exportPNG = () => {
    const c = cv_.current;
    if (!c.mosaicMat || !c.w || !c.h) return;
    const scale = fitScale(c.w, c.h, EXPORT_MAX_DIM, EXPORT_MAX_AREA);
    const tmp = document.createElement('canvas');
    try {
      if (scale < 1) {
        const dw = Math.max(1, Math.round(c.w * scale));
        const dh = Math.max(1, Math.round(c.h * scale));
        const small = new cv.Mat();
        cv.resize(c.mosaicMat, small, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
        cv.imshow(tmp, small);
        small.delete();
      } else {
        cv.imshow(tmp, c.mosaicMat);
      }
    } catch (e) {
      setMatchInfo({ text: 'Không xuất được ảnh ghép: ' + (e && e.message ? e.message : e) + ' — dùng "Xuất ảnh gốc + toạ độ cho Fiji (ZIP)" để giữ toàn bộ dữ liệu ở độ phân giải gốc.', kind: 'warn' });
      return;
    }
    tmp.toBlob((blob) => {
      if (!blob) {
        setMatchInfo({ text: 'Không tạo được file PNG (ảnh ghép quá lớn cho trình duyệt) — hãy dùng bản xuất ZIP + Fiji.', kind: 'warn' });
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `panorama-lame-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      setMatchInfo(
        scale < 1
          ? {
              text: `Đã xuất ảnh ghép, nhưng đã thu nhỏ về ${Math.round(scale * 100)}% (${c.w}×${c.h}px vượt giới hạn canvas của trình duyệt). Muốn đủ độ phân giải gốc thì dùng bản xuất ZIP + ghép lại bằng Fiji.`,
              kind: 'warn',
            }
          : { text: 'Đã xuất ảnh ghép ở độ phân giải gốc.', kind: 'ok' }
      );
    }, 'image/png');
  };

  const exportAllTilesZip = async () => {
    const c = cv_.current;
    const tiles = c.tiles;
    if (tiles.length === 0 || exportingZip) return;
    setExportingZip(true);
    setMatchInfo({ text: `Đang đóng gói 0/${tiles.length} ảnh gốc…`, kind: 'idle' });
    // Belt and braces: derive every exported coordinate from the tile's current
    // transform. The manifest is the only link between a counted object and where
    // it sat on the slide, so it must never describe a pre-optimization layout
    // that disagrees with the mosaic that was exported alongside it.
    refreshBBoxes(tiles);
    try {
      const zip = new JSZip();
      const pad = String(tiles.length).length;
      const manifestRows = [
        'index,filename,x_px,y_px,width_px,height_px,estimated,blurry,sharpness,t_a,t_b,t_tx,t_c,t_d,t_ty,captured_at_iso',
      ];
      // Fiji ("Grid/Collection Stitching" → Positions from file → Defined by
      // TileConfiguration) format: this app's already-computed (rough, live)
      // tile positions become the *starting point* Fiji refines from, instead
      // of it registering blind — meaningfully more robust on repetitive
      // texture, since it only has to search near a known-plausible position.
      const tileConfigRows = ['# Define the number of dimensions we are working on', 'dim = 2', '# Define the image coordinates'];

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
        tileConfigRows.push(`${filename}; ; (${xPx}.0, ${yPx}.0)`);
      });

      zip.file('manifest.csv', manifestRows.join('\n'));
      zip.file('TileConfiguration.txt', tileConfigRows.join('\n') + '\n');

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
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      setMatchInfo({
        text: `Đã xuất ${tiles.length} ảnh gốc kèm manifest.csv và TileConfiguration.txt (dùng cho Fiji: Plugins → Stitching → Grid/Collection stitching → Positions from file → Defined by TileConfiguration).`,
        kind: 'ok',
      });
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
      const importedEdges = [];
      for (let i = 1; i < tiles.length; i++) {
        const worldDx = tiles[i].transform[2] - tiles[i - 1].transform[2];
        const worldDy = tiles[i].transform[5] - tiles[i - 1].transform[5];
        const [ldx, ldy] = applyInverseLinear(tiles[i - 1].transform, worldDx, worldDy);
        const dtheta = angleOf(tiles[i].transform) - angleOf(tiles[i - 1].transform);
        importedEdges.push({ a: i - 1, b: i, dx: ldx, dy: ldy, dtheta, w: 20 });
      }
      const graph = rebuildAdjacency(importedEdges, tiles.length);
      c.edges = graph.edges;
      c.adjacency = graph.adjacency;
      freeAllTileFeatures(c.tiles);
      c.tiles = tiles;
      refreshBBoxes(c.tiles);
      c.sharpnessHistory = tiles.filter((t) => !t.blurry && t.sharpness).map((t) => t.sharpness).slice(-SHARPNESS_HISTORY_SIZE);
      c.activeRefIndex = null;
      c.justResumed = true;
      c.consecutiveGuesses = 0;
      c.dbCleared = true; // this import now owns the IndexedDB contents
      setBlurryCount(tiles.filter((t) => t.blurry).length);
      setResumePrompt(null);

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
          {cvLoadFailed ? (
            <div className="mono" style={{ fontSize: 12, color: 'var(--amber)', maxWidth: 520, lineHeight: 1.6 }}>
              Không tải được bộ xử lý ảnh (<code>/opencv.js</code>).
              <br />
              Thường do build/publish directory bị cấu hình sai (server trả file nguồn thay vì thư mục{' '}
              <code>dist/</code>), hoặc file <code>public/opencv.js</code> bị thiếu. Kiểm tra tab Network
              của trình duyệt xem <code>/opencv.js</code> trả về 200 và có kiểu MIME JavaScript, rồi tải lại trang.
            </div>
          ) : (
            <>
              <div className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
                Đang tải bộ xử lý ảnh (OpenCV.js)…
              </div>
              <div className="bar"><div className="fill"></div></div>
            </>
          )}
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
              {navOverlay && <div className="nav-box" style={navOverlay.outerStyle}></div>}
              {ghostOverlay && (
                <div className="ghost-strip" style={ghostOverlay.wrapStyle}>
                  <img src={ghostUrl} style={ghostOverlay.imgStyle} alt="" />
                  <span className="ghost-label">{ghostOverlay.label}</span>
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
                <div className="note" style={{ marginTop: 6 }}>
                  Khung <b>xanh lá đứt nét</b> (trong) = vùng thật sự dùng để ghép ảnh.
                  Khung <b>vàng đứt nét</b> (ngoài) chỉ để định hướng: mảng mờ vàng dán vào
                  đó là mép ảnh của lần chụp trước, theo đúng hướng bạn vừa kéo — cứ kéo tới
                  khi hình sống chồng khớp lên mảng mờ đó là đủ độ chồng lấn.
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
            <h2>Độ chặt khi so khớp</h2>
            <div className="row">
              {Object.entries(MATCH_MODES).map(([key, cfg]) => (
                <button
                  key={key}
                  className={matchMode === key ? 'primary' : ''}
                  onClick={() => setMatchMode(key)}
                  style={{ fontSize: 11 }}
                >
                  {cfg.label}
                </button>
              ))}
            </div>
            <div className="note" style={{ marginTop: 8 }}>
              {MATCH_MODES[matchMode].note}
            </div>
            <div className="note" style={{ marginTop: 6 }}>
              Đổi được ngay trong lúc đang quét. Nếu ảnh ghép không nhích lên, hãy mở
              "Chẩn đoán" bên dưới để xem app đang từ chối vì lý do gì rồi mới đổi chế độ —
              chế độ càng linh hoạt thì càng dễ nhận khớp sai ở vùng texture lặp.
            </div>
          </div>

          <div className="block">
            <h2>Chẩn đoán</h2>
            <div className="row">
              <button onClick={() => setShowDiag((s) => !s)}>
                {showDiag ? 'Ẩn chẩn đoán' : 'Hiện chẩn đoán'}
              </button>
              <button className="ghost" onClick={() => setDiagLog([])} disabled={diagLog.length === 0}>
                Xoá log
              </button>
            </div>
            {showDiag && (
              <>
                <div style={{ height: 8 }} />
                <div className="diag-log mono">
                  {diagLog.length === 0 ? (
                    <div className="note">Chưa có gì — bấm "Bắt đầu ghép tự động" rồi kéo tiêu bản.</div>
                  ) : (
                    diagLog.map((d, i) => (
                      <div className={'diag-row ' + d.kind} key={i}>
                        <span className="diag-time">{d.t}</span>
                        <span>{d.text}</span>
                      </div>
                    ))
                  )}
                </div>
                <div className="note" style={{ marginTop: 6 }}>
                  Dòng mới nhất ở trên. "bỏ qua" = chưa di chuyển đủ (bình thường).
                  "không đặt được ô" kèm lý do = chỗ cần chú ý.
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
              {canvasDims.scale < 1 && (
                <>
                  <br />
                  <span style={{ color: 'var(--ink-dim)' }}>
                    Khung xem đang thu nhỏ {Math.round(canvasDims.scale * 100)}% (ảnh gốc vẫn giữ đủ độ phân giải khi xuất).
                  </span>
                </>
              )}
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
                <div className="tile-list" key={tilePanelVersion}>
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
              {exportingZip ? 'Đang đóng gói…' : 'Xuất ảnh gốc + toạ độ cho Fiji (ZIP)'}
            </button>
            <div className="note" style={{ marginTop: 6 }}>
              Kèm <code>manifest.csv</code> và <code>TileConfiguration.txt</code> (định dạng Fiji) —
              nạp vào Fiji: Plugins → Stitching → Grid/Collection stitching → Type: "Positions from
              file" → Order: "Defined by TileConfiguration", chọn file này. Fiji sẽ dùng toạ độ đã
              có làm điểm khởi đầu rồi tự tinh chỉnh + blend lại cho ảnh cuối chất lượng cao hơn.
            </div>
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
                    left: (targetWorld.x + cv_.current.originX) * canvasDims.scale - 16,
                    top: (targetWorld.y + cv_.current.originY) * canvasDims.scale - 16,
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
