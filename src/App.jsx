/* global cv */
import { useState, useRef, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import './App.css';
import { IDENT, matMul3, translateM, cornersOf, bboxOf, findAnchorTile } from './matrix.js';
import { computeFeatures, matchTiles } from './cvMatch.js';

const INIT_PAD = 40;
const AUTO_INTERVAL_MS = 350; // how often the continuous loop samples a frame
const AUTO_FAIL_WARN = 6; // consecutive unhandled failures before warning the user
const AUTO_MOVE_MIN_PX = 18; // minimum translation (px) before a frame is worth integrating
const AUTO_MOVE_MIN_RATIO = 0.025; // ...as a fraction of frame width, whichever is larger
const ANCHOR_EXCLUDE_COUNT = 8; // don't treat the last N tiles as "revisits" — they're just normal chain overlap
const ANCHOR_MIN_TILES = ANCHOR_EXCLUDE_COUNT + 2;
const EXTRAPOLATE_MIN_PX = 3; // minimum recent motion before it's worth extrapolating a guess

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

  const videoRef = useRef(null);
  const pipVideoRef = useRef(null);
  const previewContainerRef = useRef(null);
  const mosaicCanvasRef = useRef(null);
  const workCanvasRef = useRef(document.createElement('canvas'));
  const streamRef = useRef(null);
  const autoTimerRef = useRef(null);
  const lastFeaturesRef = useRef(null); // cached {kp, desc} for the most recently integrated tile
  const cropRef = useRef(null); // {x,y,w,h} in native video px, read by grabVideoFrame
  const dragStartRef = useRef(null);

  const cv_ = useRef({
    mosaicMat: null,
    originX: INIT_PAD,
    originY: INIT_PAD,
    w: 0,
    h: 0,
    tiles: [], // {transform:[9], w, h, blob, bbox, capturedAt, estimated?}
    autoFails: 0,
    busy: false,
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

  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      if (!mosaicCanvasRef.current || !pipVideoRef.current) return;
      const stream = mosaicCanvasRef.current.captureStream(15);
      pipVideoRef.current.srcObject = stream;
      await pipVideoRef.current.play();
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
    cv.threshold(alpha, mask, 10, 255, cv.THRESH_BINARY);
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

  const setLastFeatures = (feat) => {
    const old = lastFeaturesRef.current;
    if (old) {
      old.kp.delete();
      old.desc.delete();
    }
    lastFeaturesRef.current = feat;
  };

  const clearLastFeatures = () => {
    if (lastFeaturesRef.current) {
      lastFeaturesRef.current.kp.delete();
      lastFeaturesRef.current.desc.delete();
      lastFeaturesRef.current = null;
    }
  };

  const getLastFeatures = useCallback(async () => {
    if (lastFeaturesRef.current) return lastFeaturesRef.current;
    const c = cv_.current;
    const last = c.tiles[c.tiles.length - 1];
    if (!last) return null;
    const mat = await blobToMat(last.blob);
    const feat = computeFeatures(mat);
    mat.delete();
    lastFeaturesRef.current = feat;
    return feat;
  }, [blobToMat]);

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
    }
    paintCanvas(c.mosaicMat);
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
    }
    setDragRect(null);
  };

  const clearCrop = () => {
    cropRef.current = null;
    setCropBox(null);
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
        c.tiles.push({ transform: IDENT, w, h, blob, bbox: tileBBox(IDENT, w, h), capturedAt: Date.now() });
        setLastFeatures(computeFeatures(mat));
        mat.delete();
        c.autoFails = 0;
        setTileCount(1);
        setMatchInfo({ text: 'Ô nền (#1) đã đặt — kéo tiêu bản để tiếp tục.', kind: 'ok' });
        return;
      }

      const prevTile = c.tiles[c.tiles.length - 1];
      const prevFeat = await getLastFeatures();
      const featNew = computeFeatures(mat);
      const m = matchTiles(featNew.kp, featNew.desc, prevFeat.kp, prevFeat.desc);

      if (!m.ok) {
        // Low-texture / motion-blur frame — guess from recent motion instead of stopping.
        let usedGuess = false;
        if (c.tiles.length >= 2) {
          const prev2 = c.tiles[c.tiles.length - 2];
          const dx = prevTile.transform[2] - prev2.transform[2];
          const dy = prevTile.transform[5] - prev2.transform[5];
          if (Math.hypot(dx, dy) > EXTRAPOLATE_MIN_PX) {
            const guessTransform = prevTile.transform.slice();
            guessTransform[2] += dx;
            guessTransform[5] += dy;
            const blob = await blobPromise;
            growCanvasIfNeeded(guessTransform, w, h);
            composite(mat, guessTransform, w, h, c.mosaicMat);
            paintCanvas(c.mosaicMat);
            c.tiles.push({ transform: guessTransform, w, h, blob, bbox: tileBBox(guessTransform, w, h), capturedAt: Date.now(), estimated: true });
            setLastFeatures(featNew);
            c.autoFails = 0;
            setTileCount(c.tiles.length);
            setMatchInfo({ text: 'Vùng ít chi tiết — đã ước lượng vị trí theo hướng di chuyển gần nhất.', kind: 'warn' });
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

      const transform = matMul3(prevTile.transform, m.H);

      // Zigzag/raster loop-closure: if this frame's provisional world position
      // overlaps a tile placed much earlier (e.g. the row above, on the way back),
      // re-register against that tile instead of trusting the drifted chain.
      let finalTransform = transform;
      let usedAnchor = false;
      if (c.tiles.length >= ANCHOR_MIN_TILES) {
        const candBBox = tileBBox(transform, w, h);
        const anchor = findAnchorTile(c.tiles, candBBox, ANCHOR_EXCLUDE_COUNT);
        if (anchor) {
          const anchorMat = await blobToMat(anchor.blob);
          const anchorFeat = computeFeatures(anchorMat);
          anchorMat.delete();
          const am = matchTiles(featNew.kp, featNew.desc, anchorFeat.kp, anchorFeat.desc);
          anchorFeat.kp.delete();
          anchorFeat.desc.delete();
          if (am.ok) {
            finalTransform = matMul3(anchor.transform, am.H);
            usedAnchor = true;
          }
        }
      }

      const blob = await blobPromise;
      growCanvasIfNeeded(finalTransform, w, h);
      composite(mat, finalTransform, w, h, c.mosaicMat);
      paintCanvas(c.mosaicMat);
      c.tiles.push({ transform: finalTransform, w, h, blob, bbox: tileBBox(finalTransform, w, h), capturedAt: Date.now() });
      mat.delete();
      setLastFeatures(featNew);
      c.autoFails = 0;
      setTileCount(c.tiles.length);
      setMatchInfo({
        text: usedAnchor
          ? `Đã tự chỉnh trôi theo điểm tham chiếu trước đó — ${m.inliers}/${m.total} điểm nội.`
          : `Đã nối tự động — ${m.inliers}/${m.total} điểm nội (${Math.round((m.inliers / m.total) * 100)}%).`,
        kind: 'ok',
      });
    } finally {
      c.busy = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composite, ensureMosaic, growCanvasIfNeeded, paintCanvas, getLastFeatures, blobToMat]);

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

  const undoLast = async () => {
    const c = cv_.current;
    if (c.tiles.length === 0) return;
    c.tiles.pop();
    clearLastFeatures();
    await rebuildMosaic();
    setMatchInfo({ text: 'Đã hoàn tác ô cuối.', kind: 'idle' });
  };

  const resetAll = () => {
    stopAuto();
    const c = cv_.current;
    clearLastFeatures();
    if (c.mosaicMat) {
      c.mosaicMat.delete();
      c.mosaicMat = null;
    }
    c.tiles = [];
    c.originX = INIT_PAD;
    c.originY = INIT_PAD;
    c.w = 0;
    c.h = 0;
    c.autoFails = 0;
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
      const manifestRows = ['index,filename,x_px,y_px,width_px,height_px,estimated,captured_at_iso'];

      tiles.forEach((tile, i) => {
        const idx = String(i + 1).padStart(Math.max(4, pad), '0');
        const filename = `tile_${idx}.png`;
        zip.file(filename, tile.blob);
        const xPx = Math.round(tile.bbox.minX + c.originX);
        const yPx = Math.round(tile.bbox.minY + c.originY);
        const iso = new Date(tile.capturedAt || Date.now()).toISOString();
        manifestRows.push(`${i + 1},${filename},${xPx},${yPx},${tile.w},${tile.h},${tile.estimated ? 1 : 0},${iso}`);
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
                  Kéo chuột trực tiếp trên khung xem trước để chọn 1 vùng nhỏ cần quét
                  (không bắt buộc dùng cả cửa sổ). Không chọn gì thì dùng toàn khung.
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
              Cứ kéo tiêu bản bình thường — app tự lấy mẫu, tự ghép, và khi gặp vùng ít
              chi tiết sẽ tự ước lượng vị trí theo hướng di chuyển gần nhất thay vì dừng
              lại hỏi bạn. Những ô ước lượng được đánh dấu riêng trong manifest xuất ra.
            </div>
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
            </div>
          </div>

          <div className="block">
            <h2>Công cụ</h2>
            <div className="row">
              <button onClick={undoLast} disabled={tileCount === 0}>Hoàn tác ô cuối</button>
              <button onClick={resetAll} disabled={tileCount === 0}>Đặt lại</button>
            </div>
            <div style={{ height: 8 }} />
            <button className="primary" onClick={exportPNG} disabled={tileCount === 0}>
              Xuất ảnh ghép (PNG)
            </button>
            <div style={{ height: 8 }} />
            <button onClick={exportAllTilesZip} disabled={tileCount === 0 || exportingZip}>
              {exportingZip ? 'Đang đóng gói…' : 'Xuất toàn bộ ảnh gốc + manifest (ZIP)'}
            </button>
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
              <canvas ref={mosaicCanvasRef}></canvas>
              <div className="tick tl"></div>
              <div className="tick tr"></div>
              <div className="tick bl"></div>
              <div className="tick br"></div>
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
