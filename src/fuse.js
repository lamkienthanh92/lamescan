// Pre-export fusion.
//
// While scanning, each frame is simply pasted over whatever was there — fast, and
// fine for navigating. But at a given position several tiles usually overlap, and
// they are not equally good at that position: a pixel near the CENTRE of a frame
// sits in the flat, evenly-lit part of the field, while the same specimen detail
// captured near the EDGE of another frame carries vignette falloff, the halo
// gradient, and the worst of the optical aberration. Last-writer-wins picks
// between them arbitrarily.
//
// So before export the mosaic is rebuilt from all tiles at once, deciding per
// pixel which tile's copy to trust. That decision is what Fiji calls the fusion
// method, and the same trade-off applies here: keeping one original pixel
// preserves detail exactly but leaves visible seams, while combining several
// smooths the seams at the risk of blurring anything the alignment got slightly
// wrong.

export const FUSION_METHODS = {
  best: {
    label: 'Chọn pixel tốt nhất',
    note:
      'Ở mỗi vị trí, lấy pixel từ ô có điểm chất lượng cao nhất — ưu tiên pixel gần tâm khung ' +
      '(vùng phẳng, đều sáng, ít halo) và ô nét. Pixel giữ nguyên gốc, không trộn, nên không nhoè. ' +
      'Đánh đổi: có thể còn thấy đường ranh giữa các ô.',
  },
  blend: {
    label: 'Trộn có trọng số',
    note:
      'Trung bình có trọng số bằng chính điểm chất lượng đó, trọng số giảm dần về 0 ở biên khung. ' +
      'Ranh giới giữa các ô mượt nhất. Đánh đổi: nếu định vị lệch dù chỉ 1–2px, chi tiết nhỏ sẽ hơi nhoè.',
  },
  robust: {
    label: 'Trộn loại nhiễu',
    note:
      'Như trên nhưng chạy 2 lượt: lượt đầu tính giá trị trung bình, lượt sau bỏ những ô lệch quá xa ' +
      'giá trị đó rồi tính lại. Đây là cách xoá con trỏ chuột, bụi, mép halo và ô mờ đơn lẻ — chúng lệch ' +
      'khỏi phần đa số nên bị loại. Cần ít nhất 3 ô chồng lấn mới có tác dụng rõ.',
  },
  newest: {
    label: 'Ô mới nhất (như lúc quét)',
    note: 'Không hậu kiểm gì — ô chụp sau ghi đè ô chụp trước. Nhanh nhất, để so sánh.',
  },
};

// How far a pixel may deviate from the first-pass mean before 'robust' drops it.
const CLIP_LEVELS = 30;
// Weight floor, so a tile is never given exactly zero say and a pixel covered by
// only one tile still comes through.
const MIN_W = 0.02;

// Raised-cosine (Hann) window over the tile. Peaks at the centre and falls to
// zero at the border, which is exactly the shape wanted here: it prefers the
// middle of the field where illumination is flat, and it feathers the join.
export function hannWeights(w, h) {
  const wx = new Float32Array(w);
  const wy = new Float32Array(h);
  for (let i = 0; i < w; i++) wx[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / w);
  for (let j = 0; j < h; j++) wy[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (j + 0.5)) / h);
  return { wx, wy };
}

async function decodeTile(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { data: img.data, w: c.width, h: c.height };
}

// Small LRU so a tile straddling two bands is decoded twice rather than every
// band, without holding all tiles in memory at once (300 tiles of raw RGBA is
// several hundred megabytes).
function makeCache(limit) {
  const map = new Map();
  return async (index, blob) => {
    const hit = map.get(index);
    if (hit) {
      map.delete(index);
      map.set(index, hit);
      return hit;
    }
    const decoded = await decodeTile(blob);
    map.set(index, decoded);
    if (map.size > limit) map.delete(map.keys().next().value);
    return decoded;
  };
}

// Per-tile quality multiplier: how much this tile's pixels are trusted anywhere.
// Blurry tiles are down-weighted rather than dropped, so they still fill a gap no
// sharp tile covers instead of leaving a hole.
export function tileQuality(tile, medianSharpness) {
  if (!medianSharpness || !tile.sharpness) return tile.blurry ? 0.35 : 1;
  const r = tile.sharpness / medianSharpness;
  return Math.max(0.15, Math.min(1, r));
}

export function medianSharpnessOf(tiles) {
  const vals = tiles.map((t) => t.sharpness).filter((v) => v > 0).sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length / 2)] : 0;
}

// Rebuilds `mosaic.mat` from `tiles` using the chosen method. Processes the mosaic
// in horizontal bands so peak memory stays bounded regardless of scan size.
//
// `excluded` is a Set of tile indices to leave out entirely — the manual half of
// the review step, for tiles the operator judged unusable.
export async function fuseMosaic(mosaic, tiles, { method = 'best', excluded = new Set(), onProgress } = {}) {
  const use = tiles.map((t, i) => ({ t, i })).filter(({ i }) => !excluded.has(i));
  if (use.length === 0) return { bands: 0, used: 0 };

  const medSharp = medianSharpnessOf(use.map(({ t }) => t));
  const maxTileH = Math.max(...use.map(({ t }) => t.h));
  const mw = mosaic.w;
  // Cap band area so the float accumulators stay in the tens of megabytes.
  const bandH = Math.max(maxTileH, Math.min(mosaic.h, Math.floor(4e6 / Math.max(1, mw))));
  const cache = makeCache(48);
  const windows = new Map(); // keyed by "wxh"; usually a single entry

  const out = new Uint8ClampedArray(mw * bandH * 4);
  const acc = new Float32Array(mw * bandH * 3);
  const wsum = new Float32Array(mw * bandH);
  const bestW = new Float32Array(mw * bandH);
  // Allocated once, not per band: at a 4-megapixel band this buffer is ~48MB and
  // re-allocating it every band would thrash the heap for no reason.
  const ref = method === 'robust' ? new Float32Array(mw * bandH * 3) : null;

  const bandCount = Math.ceil(mosaic.h / bandH);
  const dst = mosaic.mat.data; // Uint8Array view into the WASM heap

  for (let b = 0; b < bandCount; b++) {
    const y0 = b * bandH;
    const bh = Math.min(bandH, mosaic.h - y0);
    const n = mw * bh;
    out.fill(0, 0, n * 4);
    acc.fill(0, 0, n * 3);
    wsum.fill(0, 0, n);
    bestW.fill(0, 0, n);

    const hits = use.filter(({ t }) => {
      const ty = Math.round(t.y) + mosaic.originY;
      return ty < y0 + bh && ty + t.h > y0;
    });

    // Newest-wins needs no accumulation, just ordered overwrites.
    if (method === 'newest') {
      for (const { t, i } of hits) {
        const src = await cache(i, t.blob);
        const tx = Math.round(t.x) + mosaic.originX;
        const ty = Math.round(t.y) + mosaic.originY;
        for (let sy = 0; sy < t.h; sy++) {
          const my = ty + sy - y0;
          if (my < 0 || my >= bh) continue;
          for (let sx = 0; sx < t.w; sx++) {
            const mx = tx + sx;
            if (mx < 0 || mx >= mw) continue;
            const s = (sy * t.w + sx) * 4;
            const d = (my * mw + mx) * 4;
            out[d] = src.data[s];
            out[d + 1] = src.data[s + 1];
            out[d + 2] = src.data[s + 2];
            out[d + 3] = 255;
          }
        }
      }
    } else {
      // Pass 1: weighted accumulation (and, for 'best', the running argmax).
      for (const { t, i } of hits) {
        const src = await cache(i, t.blob);
        const key = t.w + 'x' + t.h;
        if (!windows.has(key)) windows.set(key, hannWeights(t.w, t.h));
        const { wx, wy } = windows.get(key);
        const q = tileQuality(t, medSharp);
        const tx = Math.round(t.x) + mosaic.originX;
        const ty = Math.round(t.y) + mosaic.originY;
        for (let sy = 0; sy < t.h; sy++) {
          const my = ty + sy - y0;
          if (my < 0 || my >= bh) continue;
          const rowW = wy[sy] * q;
          for (let sx = 0; sx < t.w; sx++) {
            const mx = tx + sx;
            if (mx < 0 || mx >= mw) continue;
            const w = Math.max(MIN_W, rowW * wx[sx]);
            const s = (sy * t.w + sx) * 4;
            const p = my * mw + mx;
            const a = p * 3;
            acc[a] += src.data[s] * w;
            acc[a + 1] += src.data[s + 1] * w;
            acc[a + 2] += src.data[s + 2] * w;
            wsum[p] += w;
            if (method === 'best' && w > bestW[p]) {
              bestW[p] = w;
              const d = p * 4;
              out[d] = src.data[s];
              out[d + 1] = src.data[s + 1];
              out[d + 2] = src.data[s + 2];
              out[d + 3] = 255;
            }
          }
        }
      }

      if (method === 'best') {
        // out already holds the winning original pixels; nothing more to do.
      } else if (method === 'blend') {
        for (let p = 0; p < n; p++) {
          const s = wsum[p];
          if (s <= 0) continue;
          const a = p * 3;
          const d = p * 4;
          out[d] = acc[a] / s;
          out[d + 1] = acc[a + 1] / s;
          out[d + 2] = acc[a + 2] / s;
          out[d + 3] = 255;
        }
      } else {
        // 'robust': the first pass gave a reference value per pixel; now
        // re-accumulate, skipping any tile that disagrees with it too strongly.
        // A mouse cursor, a dust speck or a halo edge appears in only one of the
        // overlapping tiles, so it is exactly what this discards.
        ref.fill(0, 0, n * 3);
        for (let p = 0; p < n; p++) {
          const s = wsum[p];
          if (s <= 0) continue;
          const a = p * 3;
          ref[a] = acc[a] / s;
          ref[a + 1] = acc[a + 1] / s;
          ref[a + 2] = acc[a + 2] / s;
        }
        acc.fill(0, 0, n * 3);
        wsum.fill(0, 0, n);
        for (const { t, i } of hits) {
          const src = await cache(i, t.blob);
          const { wx, wy } = windows.get(t.w + 'x' + t.h);
          const q = tileQuality(t, medSharp);
          const tx = Math.round(t.x) + mosaic.originX;
          const ty = Math.round(t.y) + mosaic.originY;
          for (let sy = 0; sy < t.h; sy++) {
            const my = ty + sy - y0;
            if (my < 0 || my >= bh) continue;
            const rowW = wy[sy] * q;
            for (let sx = 0; sx < t.w; sx++) {
              const mx = tx + sx;
              if (mx < 0 || mx >= mw) continue;
              const s = (sy * t.w + sx) * 4;
              const p = my * mw + mx;
              const a = p * 3;
              const dev =
                Math.abs(src.data[s] - ref[a]) +
                Math.abs(src.data[s + 1] - ref[a + 1]) +
                Math.abs(src.data[s + 2] - ref[a + 2]);
              if (dev > CLIP_LEVELS * 3) continue;
              const w = Math.max(MIN_W, rowW * wx[sx]);
              acc[a] += src.data[s] * w;
              acc[a + 1] += src.data[s + 1] * w;
              acc[a + 2] += src.data[s + 2] * w;
              wsum[p] += w;
            }
          }
        }
        for (let p = 0; p < n; p++) {
          const a = p * 3;
          const d = p * 4;
          const s = wsum[p];
          if (s > 0) {
            out[d] = acc[a] / s;
            out[d + 1] = acc[a + 1] / s;
            out[d + 2] = acc[a + 2] / s;
            out[d + 3] = 255;
          } else if (ref[a] || ref[a + 1] || ref[a + 2]) {
            // Every tile got clipped here — fall back to the first-pass value
            // rather than punching a hole in the image.
            out[d] = ref[a];
            out[d + 1] = ref[a + 1];
            out[d + 2] = ref[a + 2];
            out[d + 3] = 255;
          }
        }
      }
    }

    dst.set(out.subarray(0, n * 4), y0 * mw * 4);
    if (onProgress) onProgress(b + 1, bandCount);
    // Yield so the progress text actually repaints between bands.
    await new Promise((r) => setTimeout(r, 0));
  }

  return { bands: bandCount, used: use.length };
}
