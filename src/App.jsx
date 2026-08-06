/* global cv */
import { useState, useRef, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import './App.css';
import { toMatchGray, estimateShift, sharpnessOf, borderIsDark, detectFieldRect } from './align.js';
import * as M from './mosaic.js';
import * as db from './db.js';

const TICK_MS = 200;          // how often a frame is sampled
const MIN_SCORE = 0.35;       // correlation below this isn't a measurement
const MIN_STEP_PX = 12;       // don't record a tile until the picture has actually moved
const STEP_FRAC = 0.10;       // ...or this fraction of the frame, whichever is larger
const BLUR_HISTORY = 30;
const BLUR_MIN_SAMPLES = 5;
const BLUR_RATIO = 0.4;
const DIAG_SIZE = 16;
const CV_TIMEOUT_MS = 25000;

const PATCH_PRESETS = [
  { key: 0.22, label: 'Nhỏ (22%)', note: 'Tầm với xa nhất (±39% khung/bước), an toàn nhất với viền halo. Cần vùng có chi tiết.' },
  { key: 0.30, label: 'Vừa (30%)', note: 'Cân bằng: ±35% khung mỗi bước, đủ nội dung để điểm khớp ổn định.' },
  { key: 0.42, label: 'Lớn (42%)', note: 'Điểm khớp chắc nhất trên vùng thưa chi tiết, nhưng chỉ còn ±29% khung và dễ chạm viền.' },
];

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
  const [patchFrac, setPatchFrac] = useState(0.30);
  const [diag, setDiag] = useState([]);
  const [blurry, setBlurry] = useState(0);
  const [resume, setResume] = useState(null);
  const [borderWarn, setBorderWarn] = useState(false);
  const [busyLabel, setBusyLabel] = useState(null);
  const [showTiles, setShowTiles] = useState(false);

  const videoRef = useRef(null);
  const previewRef = useRef(null);
  const canvasRef = useRef(null);
  const workRef = useRef(document.createElement('canvas'));
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const cropRef = useRef(null);
  const dragStart = useRef(null);
  const patchRef = useRef(0.30);
  useEffect(() => { patchRef.current = patchFrac; }, [patchFrac]);

  const S = useRef({
    mosaic: null,
    scale: 1,          // mosaic px -> display canvas px
    tiles: [],         // { x, y, w, h, blob, sharpness, blurry, capturedAt }
    refGray: null,     // grayscale copy of the last accepted frame
    refScale: 1,       // original crop px -> refGray px
    busy: false,
    fails: 0,
    blurHistory: [],
    dbOwned: false,
    checkedBorder: false,
  });
  const ui = useRef({ capturing: false });
  useEffect(() => { ui.current.capturing = capturing; }, [capturing]);

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
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      const mat = cv.imread(c);
      M.paste(s.mosaic, mat, t.x, t.y);
      mat.delete();
    }
    paintAll();
    setTileCount(s.tiles.length);
    setBusyLabel(null);
  }, [paintAll]);

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
  const autoCrop = () => {
    let tries = 0;
    const attempt = () => {
      const v = videoRef.current;
      if (cropRef.current) return;
      if (!v || !v.videoWidth) {
        if (tries++ < 120) requestAnimationFrame(attempt);
        return;
      }
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
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

  const setRef = (gray, scale) => {
    const s = S.current;
    if (s.refGray) s.refGray.delete();
    s.refGray = gray;
    s.refScale = scale;
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
    db.saveTile({ index, ...tile }).catch((e) =>
      setStatus({ text: 'Cảnh báo: không lưu được vào bộ nhớ tạm (' + e.message + ')', kind: 'warn' })
    );
    if (isBlurry) setBlurry((n) => n + 1);
    setTileCount(s.tiles.length);
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
        setRef(gray, scale);
        grayOwned = false;
        s.fails = 0;
        log('ok', `ô nền #1 tại (0, 0), ${w}×${h}px`);
        setStatus({ text: 'Ô nền đã đặt — kéo tiêu bản để tiếp tục.', kind: 'ok' });
        return;
      }

      const est = estimateShift(s.refGray, gray, patchRef.current);
      if (!est) {
        log('warn', 'khung dò lớn hơn khung ảnh — chọn kích thước nhỏ hơn');
        return;
      }

      if (est.score < MIN_SCORE) {
        s.fails++;
        log('fail', `điểm khớp ${est.score.toFixed(2)} < ${MIN_SCORE} — không định vị được`);
        if (s.fails >= 4) {
          setStatus({
            text: 'Không định vị được: vùng quét thiếu chi tiết, ảnh mờ, hoặc đã kéo quá xa giữa hai khung. Kéo chậm lại, lấy nét, hoặc chọn khung dò nhỏ hơn.',
            kind: 'warn',
          });
        }
        return;
      }

      const last = s.tiles[s.tiles.length - 1];
      // est is measured in refGray pixels; convert back to crop pixels.
      const dx = est.dx / s.refScale;
      const dy = est.dy / s.refScale;
      const stepPx = Math.hypot(dx, dy);
      const minStep = Math.max(MIN_STEP_PX, w * STEP_FRAC);

      if (est.atEdge) {
        s.fails++;
        log('warn', `đã kéo quá xa (≥${Math.round(est.reachX / s.refScale)}px) — kéo chậm lại hoặc chọn khung dò nhỏ hơn`);
        return;
      }

      if (stepPx < minStep) {
        s.fails = 0;
        log('skip', `mới dịch ${Math.round(stepPx)}px (cần ≥ ${Math.round(minStep)}px), điểm ${est.score.toFixed(2)}`);
        return;
      }

      const x = last.x + dx;
      const y = last.y + dy;
      const index = await addTile(mat, w, h, blobPromise, x, y, sharp, isBlurry);
      // The accepted frame becomes the reference for the next step. Only accepted
      // frames do, so no error from a skipped frame can enter the chain.
      setRef(gray, scale);
      grayOwned = false;
      s.fails = 0;
      log('ok', `ô #${index + 1} tại (${Math.round(x)}, ${Math.round(y)}) · dịch ${fmt(dx)},${fmt(dy)} · điểm ${est.score.toFixed(2)}`);
      setStatus({
        text: `Đã ghép ${index + 1} ô. Bước vừa rồi: ${fmt(dx)}, ${fmt(dy)} px (điểm khớp ${est.score.toFixed(2)}).` +
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
      if (s.refGray) { s.refGray.delete(); s.refGray = null; }
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
      if (s.refGray) { s.refGray.delete(); s.refGray = null; }
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
    if (s.refGray) { s.refGray.delete(); s.refGray = null; }
    s.tiles = [];
    s.blurHistory = [];
    s.fails = 0;
    s.dbOwned = true;
    s.checkedBorder = false;
    db.clearAll().catch(() => {});
    setBlurry(0);
    setBorderWarn(false);
    setTileCount(0);
    setDims({ w: 0, h: 0, scale: 1 });
    setDiag([]);
    if (canvasRef.current) {
      canvasRef.current.width = 1;
      canvasRef.current.height = 1;
    }
    setStatus({ text: 'Đã đặt lại.', kind: 'idle' });
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
      const rows = ['index,filename,x_px,y_px,width_px,height_px,blurry,sharpness,captured_at_iso'];
      const cfg = ['# Define the number of dimensions we are working on', 'dim = 2', '# Define the image coordinates'];
      s.tiles.forEach((t, i) => {
        const name = `tile_${String(i + 1).padStart(pad, '0')}.png`;
        zip.file(name, t.blob);
        // Coordinates are the integer positions the tiles were actually pasted
        // at, shifted so the top-left of the mosaic is the origin.
        const x = Math.round(t.x) + s.mosaic.originX;
        const y = Math.round(t.y) + s.mosaic.originY;
        rows.push(`${i + 1},${name},${x},${y},${t.w},${t.h},${t.blurry ? 1 : 0},${Math.round(t.sharpness || 0)},${new Date(t.capturedAt).toISOString()}`);
        cfg.push(`${name}; ; (${x}.0, ${y}.0)`);
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

  // The patch actually being correlated, drawn so it's obvious whether it clears
  // the halo — this is the one setting that decides whether tracking works.
  const patchStyle = (() => {
    if (!cropStyle) return null;
    const pw = cropStyle.width * patchFrac;
    const ph = cropStyle.height * patchFrac;
    return {
      left: cropStyle.left + (cropStyle.width - pw) / 2,
      top: cropStyle.top + (cropStyle.height - ph) / 2,
      width: pw,
      height: ph,
    };
  })();

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
              {patchStyle && <div className="box patch" style={patchStyle}><span>khung dò</span></div>}
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
            <div className="note">
              Khung <b>xanh</b> = vùng ảnh được lưu. Khung <b>vàng</b> ở giữa = khung dò, phần thực sự
              dùng để đo dịch chuyển. Kéo chuột trên khung xem trước để chọn lại vùng quét.
            </div>
          </div>

          <div className="block">
            <h2>2 · Khung dò</h2>
            <div className="row">
              {PATCH_PRESETS.map((p) => (
                <button key={p.key} className={patchFrac === p.key ? 'primary' : ''} onClick={() => setPatchFrac(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="note">{PATCH_PRESETS.find((p) => p.key === patchFrac).note}</div>
          </div>

          <div className="block" style={{ borderColor: running ? 'var(--teal)' : 'var(--line)' }}>
            <h2>3 · Chạy</h2>
            {!running ? (
              <button className="primary" disabled={!cvReady || !capturing} onClick={startAuto}>
                Bắt đầu <span className="kbd">Space</span>
              </button>
            ) : (
              <button className="warn" onClick={stopAuto}>Đang chạy — bấm để dừng <span className="kbd">Space</span></button>
            )}
            <div className="note">
              Mỗi {TICK_MS}ms app lấy 1 khung, đo xem ảnh đã dịch bao nhiêu pixel theo x và y, rồi dán
              khung đó vào đúng vị trí. Không có bước xác nhận, không ước lượng bù: khung nào không đo
              được thì bỏ qua, thử lại khung sau.
            </div>
          </div>

          <div className="block">
            <h2>Trạng thái</h2>
            <div className="status">
              <span className={`badge ${status.kind}`}>
                {status.kind === 'ok' ? 'Tốt' : status.kind === 'warn' ? 'Chú ý' : 'Sẵn sàng'}
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
              <div className="tiles">
                {S.current.tiles.map((t, i) => (
                  <div className="tile-row" key={i}>
                    <span className="mono dim">#{i + 1}</span>
                    <Thumb blob={t.blob} />
                    <span className="mono dim">{Math.round(t.x)}, {Math.round(t.y)}</span>
                    {t.blurry && <span className="badge warn">Mờ</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="stage">
          {tileCount === 0 ? (
            <div className="stage-empty">
              Ảnh ghép sẽ hiện ở đây.
              <br />
              Chọn cửa sổ nguồn, kiểm tra khung dò nằm trong vùng sáng, rồi bấm "Bắt đầu".
            </div>
          ) : (
            <div className="stage-scroll">
              <div className="stage-frame"><canvas ref={canvasRef}></canvas></div>
            </div>
          )}
          <div className="footer mono">
            <span>Tương quan pixel trên khung dò · tịnh tiến x, y · không nội suy</span>
            <span>{tileCount} ô</span>
          </div>
        </div>
      </div>
    </>
  );
}
