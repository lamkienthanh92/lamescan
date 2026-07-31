/* global cv */
import { useState, useRef, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import './App.css';
import { IDENT, matMul3, translateM, cornersOf, bboxOf, findAnchorTile } from './matrix.js';
import { computeFeatures, matchTiles } from './cvMatch.js';

const INIT_PAD = 40;
const NUDGE_STEP = 6;
const AUTO_INTERVAL_MS = 350; // how often the continuous loop samples a frame
const AUTO_FAIL_WARN = 6; // consecutive failed matches before warning the user
const AUTO_MOVE_MIN_PX = 18; // minimum translation (px) before a frame is worth integrating
const AUTO_MOVE_MIN_RATIO = 0.025; // ...as a fraction of frame width, whichever is larger
const ANCHOR_EXCLUDE_COUNT = 8; // don't treat the last N tiles as "revisits" — they're just normal chain overlap
const ANCHOR_MIN_TILES = ANCHOR_EXCLUDE_COUNT + 2;

function tileBBox(transform, w, h) {
  return bboxOf(cornersOf(transform, w, h));
}

export default function App() {
  const [cvReady, setCvReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [pending, setPending] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [tileCount, setTileCount] = useState(0);
  const [matchInfo, setMatchInfo] = useState({ text: 'Chưa có ô nào', kind: 'idle' });
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 });
  const [pipActive, setPipActive] = useState(false);
  const [pipSupported, setPipSupported] = useState(true);
  const [exportingZip, setExportingZip] = useState(false);

  const videoRef = useRef(null);
  const pipVideoRef = useRef(null);
  const mosaicCanvasRef = useRef(null);
  const workCanvasRef = useRef(document.createElement('canvas'));
  const streamRef = useRef(null);
  const autoTimerRef = useRef(null);
  const lastFeaturesRef = useRef(null); // cached {kp, desc} for the most recently integrated tile

  // persistent OpenCV-side state, kept out of React state to avoid re-render churn on Mats
  const cv_ = useRef({
    mosaicMat: null,
    originX: INIT_PAD,
    originY: INIT_PAD,
    w: 0,
    h: 0,
    tiles: [], // {transform:[9], w, h, blob, bbox, capturedAt}
    pending: null, // {mat, w, h, blob, transformBase, nudgeX, nudgeY, kp, desc}
    autoFails: 0,
    busy: false, // shared mutex between manual capture and the auto loop
  });

  const uiRef = useRef({ cvReady: false, pending: false, capturing: false });
  useEffect(() => { uiRef.current.cvReady = cvReady; }, [cvReady]);
  useEffect(() => { uiRef.current.pending = pending; }, [pending]);
  useEffect(() => { uiRef.current.capturing = capturing; }, [capturing]);
  const autoConfirmRef = useRef(false);
  useEffect(() => { autoConfirmRef.current = autoConfirm; }, [autoConfirm]);

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

  // Returns cached ORB features for the last integrated tile, computing (and caching)
  // them from its stored image if the cache is empty (e.g. right after an undo).
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

  const grabVideoFrame = () => {
    const v = videoRef.current;
    const w = v.videoWidth;
    const h = v.videoHeight;
    const wc = workCanvasRef.current;
    wc.width = w;
    wc.height = h;
    wc.getContext('2d').drawImage(v, 0, 0, w, h);
    const mat = cv.imread(wc);
    // toBlob encodes a snapshot of the canvas taken at call time, so it's safe
    // even if wc gets redrawn again before this promise resolves.
    const blobPromise = new Promise((resolve) => wc.toBlob(resolve, 'image/png'));
    return { mat, w, h, blobPromise };
  };

  const renderPending = useCallback(() => {
    const c = cv_.current;
    const p = c.pending;
    if (!p) return;
    const final = matMul3(translateM(p.nudgeX, p.nudgeY), p.transformBase);
    growCanvasIfNeeded(final, p.w, p.h);
    const preview = c.mosaicMat.clone();
    composite(p.mat, final, p.w, p.h, preview);
    paintCanvas(preview);
    preview.delete();
  }, [composite, growCanvasIfNeeded, paintCanvas]);

  const confirmTile = () => {
    const c = cv_.current;
    const p = c.pending;
    if (!p) return;
    const final = matMul3(translateM(p.nudgeX, p.nudgeY), p.transformBase);
    growCanvasIfNeeded(final, p.w, p.h);
    composite(p.mat, final, p.w, p.h, c.mosaicMat);
    paintCanvas(c.mosaicMat);
    c.tiles.push({ transform: final, w: p.w, h: p.h, blob: p.blob, bbox: tileBBox(final, p.w, p.h), capturedAt: Date.now() });
    p.mat.delete();
    setLastFeatures({ kp: p.kp, desc: p.desc }); // adopt candidate features, no recompute needed
    c.pending = null;
    setPending(false);
    setTileCount(c.tiles.length);
    setMatchInfo((prev) => ({ text: prev.text + ' — đã ghép.', kind: prev.kind }));
  };

  const discardPending = () => {
    const c = cv_.current;
    if (c.pending) {
      c.pending.mat.delete();
      c.pending.kp.delete();
      c.pending.desc.delete();
      c.pending = null;
    }
    paintCanvas(c.mosaicMat);
    setPending(false);
    setMatchInfo({ text: 'Đã huỷ — chụp lại ô này.', kind: 'idle' });
  };

  // ---- manual single-shot capture (fallback tool: review + nudge + confirm) ----
  const captureFrame = async () => {
    const c = cv_.current;
    if (!uiRef.current.cvReady || !uiRef.current.capturing || uiRef.current.pending || c.busy) return;
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
        setTileCount(1);
        setMatchInfo({ text: 'Ô nền (#1) đã đặt — đây là gốc toạ độ.', kind: 'ok' });
        return;
      }

      const prevTile = c.tiles[c.tiles.length - 1];
      const prevFeat = await getLastFeatures();
      const featNew = computeFeatures(mat);
      const m = matchTiles(featNew.kp, featNew.desc, prevFeat.kp, prevFeat.desc);
      const blob = await blobPromise;

      let transformBase;
      let info;
      if (m.ok) {
        transformBase = matMul3(prevTile.transform, m.H);
        info = { text: `Khớp: ${m.inliers}/${m.total} điểm nội (${Math.round((m.inliers / m.total) * 100)}%). Kiểm tra rồi xác nhận.`, kind: 'ok' };
      } else {
        transformBase = prevTile.transform;
        info = { text: `Không đủ điểm khớp tin cậy (${m.inliers}/${m.total}). Dùng phím mũi tên để canh tay.`, kind: 'warn' };
      }

      c.pending = { mat, w, h, blob, transformBase, nudgeX: 0, nudgeY: 0, kp: featNew.kp, desc: featNew.desc };
      setMatchInfo(info);
      renderPending();

      if (autoConfirmRef.current && m.ok) {
        confirmTile();
      } else {
        setPending(true);
      }
    } finally {
      c.busy = false;
    }
  };

  const nudge = (dx, dy) => {
    const c = cv_.current;
    if (!c.pending) return;
    c.pending.nudgeX += dx;
    c.pending.nudgeY += dy;
    renderPending();
  };

  // ---- continuous auto-stitch loop: sample frames while dragging, integrate automatically ----
  const autoTick = useCallback(async () => {
    const c = cv_.current;
    if (!uiRef.current.capturing || c.pending || c.busy) return;
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
        featNew.kp.delete();
        featNew.desc.delete();
        mat.delete();
        c.autoFails += 1;
        if (c.autoFails >= AUTO_FAIL_WARN) {
          setMatchInfo({ text: 'Mất khớp liên tục — kéo chậm lại, hoặc dùng "Chụp thủ công" để canh tay tại đây.', kind: 'warn' });
        }
        return;
      }

      const moveMag = Math.hypot(m.H[2], m.H[5]);
      const threshold = Math.max(AUTO_MOVE_MIN_PX, w * AUTO_MOVE_MIN_RATIO);
      if (moveMag < threshold) {
        // essentially stationary — nothing new to add, don't waste a tile slot
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
    if (c.pending) discardPending();
    if (c.tiles.length === 0) return;
    c.tiles.pop();
    clearLastFeatures(); // will be recomputed lazily from the new last tile on next match
    await rebuildMosaic();
    setMatchInfo({ text: 'Đã hoàn tác ô cuối.', kind: 'idle' });
  };

  const resetAll = () => {
    stopAuto();
    const c = cv_.current;
    if (c.pending) {
      c.pending.mat.delete();
      c.pending.kp.delete();
      c.pending.desc.delete();
      c.pending = null;
      setPending(false);
    }
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
      const manifestRows = ['index,filename,x_px,y_px,width_px,height_px,captured_at_iso'];

      tiles.forEach((tile, i) => {
        const idx = String(i + 1).padStart(Math.max(4, pad), '0');
        const filename = `tile_${idx}.png`;
        zip.file(filename, tile.blob);
        const xPx = Math.round(tile.bbox.minX + c.originX);
        const yPx = Math.round(tile.bbox.minY + c.originY);
        const iso = new Date(tile.capturedAt || Date.now()).toISOString();
        manifestRows.push(`${i + 1},${filename},${xPx},${yPx},${tile.w},${tile.h},${iso}`);
      });

      zip.file('manifest.csv', manifestRows.join('\n'));

      const blob = await zip.generateAsync(
        { type: 'blob', compression: 'STORE' }, // PNGs are already compressed — skip re-deflating
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

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e) => {
      if (!uiRef.current.cvReady) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (uiRef.current.pending) confirmTile();
        else captureFrame();
      } else if (e.code === 'Enter') {
        if (uiRef.current.pending) {
          e.preventDefault();
          confirmTile();
        }
      } else if (e.code === 'Escape') {
        if (uiRef.current.pending) discardPending();
      } else if (uiRef.current.pending && e.code.startsWith('Arrow')) {
        e.preventDefault();
        if (e.code === 'ArrowLeft') nudge(-NUDGE_STEP, 0);
        if (e.code === 'ArrowRight') nudge(NUDGE_STEP, 0);
        if (e.code === 'ArrowUp') nudge(0, -NUDGE_STEP);
        if (e.code === 'ArrowDown') nudge(0, NUDGE_STEP);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // stop the auto loop on unmount
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
        <span className="sub">Kéo tiêu bản liên tục — app tự tích luỹ &amp; ghép thành 1 ảnh scan lame</span>
      </header>
      <div className="layout">
        <div className="rail">
          <div className="block">
            <h2>1 · Nguồn hình ảnh</h2>
            <div className="preview-wrap">
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
                Bắt đầu ghép tự động
              </button>
            ) : (
              <button className="warn" onClick={stopAuto}>
                <span className="rec-dot" style={{ position: 'static', display: 'inline-flex', marginRight: 6 }}>
                  <span className="d"></span>
                </span>
                Đang ghép tự động — bấm để dừng
              </button>
            )}
            <div className="note" style={{ marginTop: 8 }}>
              Cứ kéo tiêu bản bình thường — app tự lấy mẫu ~3 lần/giây, tự bỏ qua khung
              gần như đứng yên, chỉ ghép khi phát hiện đủ di chuyển.
            </div>
          </div>

          <div className="block">
            <h2>3 · Chụp thủ công (dự phòng)</h2>
            <button disabled={!cvReady || !capturing || pending} onClick={captureFrame}>
              Chụp 1 ô tại đây <span className="kbd">Space</span>
            </button>
            <div style={{ height: 8 }} />
            <label className="status-line" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />
              Tự động xác nhận khi khớp đủ tin cậy
            </label>
            <div className="note" style={{ marginTop: 6 }}>
              Dùng khi ghép tự động bị mất khớp liên tục ở một điểm khó — tạm dừng
              ghép tự động, chụp 1 ô rồi canh tay bằng mũi tên nếu cần.
            </div>
          </div>

          {pending && (
            <div className="block" style={{ borderColor: 'var(--amber)' }}>
              <h2>Canh chỉnh &amp; xác nhận</h2>
              <div className="nudge-grid">
                <span></span>
                <button onClick={() => nudge(0, -NUDGE_STEP)}>↑</button>
                <span></span>
                <button onClick={() => nudge(-NUDGE_STEP, 0)}>←</button>
                <button className="ghost" style={{ opacity: 0.3 }} disabled>•</button>
                <button onClick={() => nudge(NUDGE_STEP, 0)}>→</button>
                <span></span>
                <button onClick={() => nudge(0, NUDGE_STEP)}>↓</button>
                <span></span>
              </div>
              <div style={{ height: 10 }} />
              <div className="row">
                <button className="primary" onClick={confirmTile}>
                  Xác nhận <span className="kbd">Enter/Space</span>
                </button>
                <button className="ghost" onClick={discardPending}>
                  Huỷ <span className="kbd">Esc</span>
                </button>
              </div>
            </div>
          )}

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
            Cách dùng: chọn đúng cửa sổ phần mềm camera kính hiển vi → bấm "Bắt đầu ghép tự động"
            → kéo tiêu bản liên tục như bình thường, không cần dừng lại để chụp. Ô đầu tiên luôn
            được đặt làm gốc. Nếu một vùng ít chi tiết khiến app báo "mất khớp liên tục", tạm dừng
            ghép tự động và dùng "Chụp thủ công" + phím mũi tên để canh qua điểm đó, rồi bật lại
            ghép tự động.
          </div>
        </div>

        <div className="stage-area">
          <div className="stage-scroll">
            {tileCount === 0 && !pending && (
              <div className="stage-empty">
                Vùng ghép ảnh sẽ hiện ở đây.
                <br />
                <b>Chưa có ô nào được chụp.</b>
                <br />
                Chọn cửa sổ nguồn ở bên trái, rồi bấm "Bắt đầu ghép tự động".
              </div>
            )}
            <div className="stage-frame" style={{ display: tileCount > 0 || pending ? 'block' : 'none' }}>
              <canvas ref={mosaicCanvasRef}></canvas>
              <div className="tick tl"></div>
              <div className="tick tr"></div>
              <div className="tick bl"></div>
              <div className="tick br"></div>
            </div>
          </div>
          <div className="footer-bar mono">
            <span>ORB + RANSAC similarity transform · ghép chuỗi khung liền kề</span>
            <span className="tiles">{tileCount} ô</span>
          </div>
        </div>
      </div>
    </>
  );
}
