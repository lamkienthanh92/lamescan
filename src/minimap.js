// Overview map for navigating a scan in progress.
//
// While scanning you are looking at the camera software, not at this app, so the
// mosaic being visible somewhere behind three other windows is no help. The point
// of this is to be small and to be on top.
//
// It shows more than "where there are pixels", because that is not the question
// being asked. The question is which parts still need work, and there are two
// different answers to it:
//
//   * nothing captured yet — transparent, obvious.
//   * captured exactly once — captured, but with no second tile overlapping it.
//     Those pixels cannot be cross-checked or chosen between during fusion, so
//     whatever the frame gave there is what the export gets, halo-lit edge and
//     all. On a finished scan this should only be the outer border.
//
// The second case is the one that is invisible on the mosaic itself and the one
// that quietly degrades the result, so it gets the highlight.

const MAX_DIM = 260;

// How many tiles cover each cell of the map, capped at 2 — the only distinction
// that matters is none / exactly one / more than one. Kept pure and separate from
// the drawing so the thing the map is actually claiming can be tested.
export function coverageStats(mosaic, tiles, scale, cw, ch, excluded) {
  const cov = new Uint8Array(cw * ch);
  for (let i = 0; i < tiles.length; i++) {
    if (excluded && excluded.has(i)) continue;
    const t = tiles[i];
    const x0 = Math.max(0, Math.floor((t.x + mosaic.originX) * scale));
    const y0 = Math.max(0, Math.floor((t.y + mosaic.originY) * scale));
    const x1 = Math.min(cw, Math.ceil((t.x + t.w + mosaic.originX) * scale));
    const y1 = Math.min(ch, Math.ceil((t.y + t.h + mosaic.originY) * scale));
    for (let y = y0; y < y1; y++) {
      const row = y * cw;
      for (let x = x0; x < x1; x++) {
        if (cov[row + x] < 2) cov[row + x]++;
      }
    }
  }
  let onceCells = 0;
  let coveredCells = 0;
  for (let p = 0; p < cov.length; p++) {
    if (cov[p] === 0) continue;
    coveredCells++;
    if (cov[p] === 1) onceCells++;
  }
  return { cov, onceCells, coveredCells };
}
let overlayCanvas = null;

export const COVERAGE_COLOURS = {
  none: 'trong suốt — chưa quét',
  once: 'vàng — chỉ quét 1 lần, chưa có ô chồng lấn',
  ok: 'không tô — đã có ≥2 ô chồng lấn',
};

// `sourceCanvas` is the live display canvas: it already holds a scaled copy of the
// whole mosaic, so blitting it down is a GPU operation rather than another pass
// over the mosaic Mat.
export function drawMinimap(canvas, mosaic, tiles, { sourceCanvas, lastRect, excluded, maxDim = MAX_DIM } = {}) {
  if (!canvas || !mosaic || !mosaic.w || !mosaic.h) return null;
  const scale = Math.min(maxDim / mosaic.w, maxDim / mosaic.h);
  const cw = Math.max(1, Math.round(mosaic.w * scale));
  const ch = Math.max(1, Math.round(mosaic.h * scale));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  if (sourceCanvas && sourceCanvas.width > 1) {
    ctx.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, 0, 0, cw, ch);
  }

  const { cov, onceCells, coveredCells } = coverageStats(mosaic, tiles, scale, cw, ch, excluded);

  if (!overlayCanvas) overlayCanvas = document.createElement('canvas');
  if (overlayCanvas.width !== cw || overlayCanvas.height !== ch) {
    overlayCanvas.width = cw;
    overlayCanvas.height = ch;
  }
  const octx = overlayCanvas.getContext('2d');
  const img = octx.createImageData(cw, ch);
  for (let p = 0; p < cov.length; p++) {
    if (cov[p] !== 1) continue;
    const d = p * 4;
    img.data[d] = 199;      // amber, matching the app's warning colour
    img.data[d + 1] = 125;
    img.data[d + 2] = 20;
    img.data[d + 3] = 150;
  }
  octx.putImageData(img, 0, 0);
  ctx.drawImage(overlayCanvas, 0, 0);

  if (lastRect) {
    ctx.strokeStyle = '#3FB8A0';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      (lastRect.x + mosaic.originX) * scale,
      (lastRect.y + mosaic.originY) * scale,
      Math.max(2, lastRect.w * scale),
      Math.max(2, lastRect.h * scale)
    );
  }

  return {
    scale,
    w: cw,
    h: ch,
    onceFrac: coveredCells > 0 ? onceCells / coveredCells : 0,
  };
}

// ---- floating window ----
//
// Document Picture-in-Picture puts real DOM in an always-on-top window, which is
// what this needs — it can sit over the camera software while the app itself is
// behind it. Where that isn't available, a canvas capture stream in a video PiP
// gets the same always-on-top behaviour with a picture instead of DOM.

export function pipSupport() {
  if ('documentPictureInPicture' in window) return 'document';
  if (typeof HTMLVideoElement !== 'undefined' && 'requestPictureInPicture' in HTMLVideoElement.prototype) {
    return 'video';
  }
  return 'none';
}

// Opens the DOM node in a floating window. Returns the window, or null.
// `onClose` fires when the user dismisses it, so the caller can put the node back.
export async function openDocumentPiP(node, { width = 300, height = 340, onClose } = {}) {
  const pip = await window.documentPictureInPicture.requestWindow({ width, height });
  // Style rules don't follow the node across documents, so the ones it needs are
  // written inline here rather than copying the app's whole stylesheet.
  const style = pip.document.createElement('style');
  style.textContent = `
    body{margin:0;background:#0E1417;color:#E6EDF0;
      font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:10px;padding:8px;}
    canvas{display:block;max-width:100%;height:auto;border:1px solid #243036;
      background:repeating-conic-gradient(#171F22 0% 25%, #141A1C 0% 50%) 50% / 10px 10px;}
    .k{margin-top:6px;line-height:1.6;color:#8A9AA3;}
    .k b{color:#C77D14;font-weight:400;}
    .k i{color:#3FB8A0;font-style:normal;}
  `;
  pip.document.head.append(style);
  pip.document.body.append(node);
  pip.addEventListener('pagehide', () => onClose && onClose());
  return pip;
}
