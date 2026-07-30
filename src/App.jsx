/* global cv */
import { useState, useRef, useEffect, useCallback } from 'react';
import './App.css';
import { IDENT, matMul3, translateM, cornersOf, bboxOf } from './matrix.js';
import { computeFeatures, matchTiles } from './cvMatch.js';

const INIT_PAD = 40;
const NUDGE_STEP = 6;

export default function App() {
  const [cvReady, setCvReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [pending, setPending] = useState(false);
  const [tileCount, setTileCount] = useState(0);
  const [matchInfo, setMatchInfo] = useState({ text: 'Chưa có ô nào', kind: 'idle' });
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 });

  const videoRef = useRef(null);
  const mosaicCanvasRef = useRef(null);
  const workCanvasRef = useRef(document.createElement('canvas'));
  const streamRef = useRef(null);

  // persistent OpenCV-side state, kept out of React state to avoid re-render churn on Mats
  const cv_ = useRef({
    mosaicMat: null,
    originX: INIT_PAD,
    originY: INIT_PAD,
    w: 0,
    h: 0,
    tiles: [], // {transform:[9], w, h, dataURL}
    pending: null, // {mat, w, h, dataURL, transformBase, nudgeX, nudgeY}
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

  const dataURLToMat = useCallback((dataURL) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const tmp = document.createElement('canvas');
        tmp.width = img.width;
        tmp.height = img.height;
        tmp.getContext('2d').drawImage(img, 0, 0);
        resolve(cv.imread(tmp));
      };
      img.src = dataURL;
    });
  }, []);

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
      const mat = await dataURLToMat(tile.dataURL);
      composite(mat, tile.transform, tile.w, tile.h, c.mosaicMat);
      mat.delete();
    }
    paintCanvas(c.mosaicMat);
    setTileCount(c.tiles.length);
  }, [composite, dataURLToMat, growCanvasIfNeeded, paintCanvas]);

  // ---- screen capture ----
  const startCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'never' }, audio: false });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        setCapturing(false);
        streamRef.current = null;
      });
      setCapturing(true);
    } catch (e) {
      setMatchInfo({ text: 'Không thể bắt đầu ghi màn hình: ' + e.message, kind: 'warn' });
    }
  };

  const stopCapture = () => {
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
    return { mat: cv.imread(wc), w, h, dataURL: wc.toDataURL('image/png') };
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
    c.tiles.push({ transform: final, w: p.w, h: p.h, dataURL: p.dataURL });
    p.mat.delete();
    c.pending = null;
    setPending(false);
    setTileCount(c.tiles.length);
    setMatchInfo((prev) => ({ text: prev.text + ' — đã ghép.', kind: prev.kind }));
  };

  const discardPending = () => {
    const c = cv_.current;
    if (c.pending) {
      c.pending.mat.delete();
      c.pending = null;
    }
    paintCanvas(c.mosaicMat);
    setPending(false);
    setMatchInfo({ text: 'Đã huỷ — chụp lại ô này.', kind: 'idle' });
  };

  const captureFrame = () => {
    if (!uiRef.current.cvReady || !uiRef.current.capturing || uiRef.current.pending) return;
    const c = cv_.current;
    const { mat, w, h, dataURL } = grabVideoFrame();

    if (c.tiles.length === 0) {
      ensureMosaic(w + INIT_PAD * 2, h + INIT_PAD * 2);
      composite(mat, IDENT, w, h, c.mosaicMat);
      paintCanvas(c.mosaicMat);
      c.tiles.push({ transform: IDENT, w, h, dataURL });
      mat.delete();
      setTileCount(1);
      setMatchInfo({ text: 'Ô nền (#1) đã đặt — đây là gốc toạ độ.', kind: 'ok' });
      return;
    }

    const prevTile = c.tiles[c.tiles.length - 1];
    (async () => {
      const prevMat = await dataURLToMat(prevTile.dataURL);
      const featNew = computeFeatures(mat);
      const featPrev = computeFeatures(prevMat);
      const m = matchTiles(featNew.kp, featNew.desc, featPrev.kp, featPrev.desc);
      featNew.kp.delete();
      featNew.desc.delete();
      featPrev.kp.delete();
      featPrev.desc.delete();
      prevMat.delete();

      let transformBase;
      let info;
      if (m.ok) {
        transformBase = matMul3(prevTile.transform, m.H);
        info = { text: `Khớp: ${m.inliers}/${m.total} điểm nội. Kiểm tra rồi xác nhận.`, kind: m.inliers >= 8 ? 'ok' : 'warn' };
      } else {
        transformBase = prevTile.transform;
        info = { text: `Không đủ điểm khớp (${m.inliers}/${m.total}). Dùng phím mũi tên để canh tay.`, kind: 'warn' };
      }

      c.pending = { mat, w, h, dataURL, transformBase, nudgeX: 0, nudgeY: 0 };
      setMatchInfo(info);
      renderPending();

      if (autoConfirmRef.current && m.ok && m.inliers >= 8) {
        confirmTile();
      } else {
        setPending(true);
      }
    })();
  };

  const nudge = (dx, dy) => {
    const c = cv_.current;
    if (!c.pending) return;
    c.pending.nudgeX += dx;
    c.pending.nudgeY += dy;
    renderPending();
  };

  const undoLast = async () => {
    const c = cv_.current;
    if (c.pending) discardPending();
    if (c.tiles.length === 0) return;
    c.tiles.pop();
    await rebuildMosaic();
    setMatchInfo({ text: 'Đã hoàn tác ô cuối.', kind: 'idle' });
  };

  const resetAll = () => {
    const c = cv_.current;
    if (c.pending) {
      c.pending.mat.delete();
      c.pending = null;
      setPending(false);
    }
    if (c.mosaicMat) {
      c.mosaicMat.delete();
      c.mosaicMat = null;
    }
    c.tiles = [];
    c.originX = INIT_PAD;
    c.originY = INIT_PAD;
    c.w = 0;
    c.h = 0;
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
      <header className="app-head">
        <h1>Ghép Panorama Kính Hiển Vi</h1>
        <span className="sub">Chụp từng trường nhìn khi kéo tiêu bản, tự động ghép thành 1 ảnh scan lame</span>
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
            <h2>2 · Chụp &amp; ghép</h2>
            <button className="primary" disabled={!cvReady || !capturing || pending} onClick={captureFrame}>
              Chụp ô hiện tại <span className="kbd">Space</span>
            </button>
            <div style={{ height: 8 }} />
            <label className="status-line" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />
              Tự động xác nhận khi khớp tốt (≥8 điểm nội)
            </label>
          </div>

          {pending && (
            <div className="block" style={{ borderColor: 'var(--amber)' }}>
              <h2>3 · Canh chỉnh &amp; xác nhận</h2>
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
              Xuất ảnh PNG
            </button>
          </div>

          <div className="note">
            Cách dùng: chọn đúng cửa sổ phần mềm camera kính hiển vi, kéo tiêu bản một chút cho mỗi bước
            (chồng lấn ~20–30% giữa các ô), rồi chụp từng ô một. Ô đầu tiên luôn được đặt trực tiếp làm gốc.
            Nếu vùng ảnh ít chi tiết (khó khớp), dùng phím mũi tên để canh tay trước khi xác nhận.
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
                Bắt đầu bằng cách chọn cửa sổ nguồn ở bên trái, sau đó chụp ô đầu tiên.
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
            <span>ORB + RANSAC homography · ghép chuỗi khung liền kề</span>
            <span className="tiles">{tileCount} ô</span>
          </div>
        </div>
      </div>
    </>
  );
}
