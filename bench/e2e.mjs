// End-to-end bench: runs the REAL built app in headless Chromium, with the camera
// replaced by a synthetic microscope (canvas.captureStream) whose stage follows a
// scripted path. Nothing in the app is mocked except the video source.
//
//   node bench/e2e.mjs <url> <scenario>
//   scenario: drag   — continuous serpentine at SPEED px/s (default 900)
//             still  — stop-and-go with "Chỉ ghi ô khi tay dừng" on (new build only)
//
// Prints one JSON line: tiles, lost frames, processed ticks per second, main-thread
// busy fraction, and position errors against the known stage path.
// Needs Playwright with Chromium: npm i -D playwright && npx playwright install chromium
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => {
  console.error('Cần Playwright: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
});

const url = process.argv[2] || 'http://localhost:4173/';
const scenario = process.argv[3] || 'drag';
const SPEED = Number(process.env.SPEED || 900);
const COL_LEN = Number(process.env.LEN || 3200);

const fakeCamera = ({ scenario, SPEED, COL_LEN }) => {
  // ---------- synthetic slide ----------
  let seed = 12345;
  const R = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const SW = 4200, SH = COL_LEN + 2400;
  const slide = document.createElement('canvas');
  slide.width = SW; slide.height = SH;
  const g = slide.getContext('2d');
  g.fillStyle = 'rgb(236,200,214)'; g.fillRect(0, 0, SW, SH);
  for (let i = 0; i < (SW * SH) / 6000; i++) { // stroma patches
    g.fillStyle = `rgba(${200 + R() * 40},${120 + R() * 50},${160 + R() * 40},0.35)`;
    g.beginPath(); g.ellipse(R() * SW, R() * SH, 20 + R() * 60, 10 + R() * 40, R() * 3, 0, 7); g.fill();
  }
  g.lineWidth = 1.5;
  for (let i = 0; i < (SW * SH) / 1500; i++) { // fibres
    const x = R() * SW, y = R() * SH, a = R() * 3.14, L = 20 + R() * 70;
    g.strokeStyle = `rgba(${190 + R() * 40},${90 + R() * 50},${140 + R() * 40},0.6)`;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); g.stroke();
  }
  for (let i = 0; i < (SW * SH) / 900; i++) { // nuclei
    g.fillStyle = `rgba(${60 + R() * 50},${40 + R() * 40},${120 + R() * 50},0.9)`;
    g.beginPath(); g.ellipse(R() * SW, R() * SH, 3 + R() * 5, 2 + R() * 4, R() * 3, 0, 7); g.fill();
  }
  // ---------- camera ----------
  const CW = 1600, CH = 1200;
  const cam = document.createElement('canvas');
  cam.width = CW; cam.height = CH;
  const c = cam.getContext('2d');
  const vig = c.createRadialGradient(CW / 2, CH / 2, CH * 0.35, CW / 2, CH / 2, CH * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.92)');
  const noise = document.createElement('canvas');
  noise.width = 256; noise.height = 256;
  const nd = noise.getContext('2d').createImageData(256, 256);
  for (let i = 0; i < nd.data.length; i += 4) { const v = R() * 255; nd.data[i] = nd.data[i + 1] = nd.data[i + 2] = v; nd.data[i + 3] = 255; }
  noise.getContext('2d').putImageData(nd, 0, 0);

  // ---------- stage path: serpentine, 3 columns ----------
  const X0 = 300, Y0 = 300, colStep = 900;
  const pts = [];
  for (let k = 0; k < 3; k++) {
    const x = X0 + k * colStep;
    const [a, b] = k % 2 === 0 ? [Y0, Y0 + COL_LEN] : [Y0 + COL_LEN, Y0];
    pts.push([x, a], [x, b]);
  }
  // Expand into timed segments. 'still' = move 450px, pause 600ms, repeat.
  const segs = []; // {t0, t1, x0, y0, x1, y1}
  let t = 1500, px = pts[0][0], py = pts[0][1];
  const move = (x, y, v) => { const d = Math.hypot(x - px, y - py); if (!d) return; const dt = d / v * 1000; segs.push({ t0: t, t1: t + dt, x0: px, y0: py, x1: x, y1: y }); t += dt; px = x; py = y; };
  const pause = (ms) => { segs.push({ t0: t, t1: t + ms, x0: px, y0: py, x1: px, y1: py, pause: true }); t += ms; };
  pause(0);
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (scenario === 'still') {
      const d = Math.hypot(x - px, y - py); const n = Math.ceil(d / 450);
      const sx = px, sy = py;
      for (let j = 1; j <= n; j++) { move(Math.round(sx + (x - sx) * j / n), Math.round(sy + (y - sy) * j / n), SPEED); pause(600); }
    } else move(x, y, SPEED);
  }
  const tEnd = t;
  window.__bench = { start: null, segs, tEnd, done: false, X0, Y0, colStep, COL_LEN, CW, CH };
  const posAt = (ms) => {
    for (const s of segs) if (ms <= s.t1) { const f = s.t1 > s.t0 ? Math.max(0, (ms - s.t0) / (s.t1 - s.t0)) : 1; return [s.x0 + (s.x1 - s.x0) * f, s.y0 + (s.y1 - s.y0) * f]; }
    return [px, py];
  };
  const draw = () => {
    const now = performance.now();
    const B = window.__bench;
    const ms = B.start == null ? 0 : now - B.start;
    if (B.start != null && ms > tEnd) B.done = true;
    const [x, y] = posAt(ms);
    // Only the visible part of the slide, at a sub-pixel offset.
    const ix = Math.floor(x), iy = Math.floor(y);
    c.setTransform(1, 0, 0, 1, -(x - ix), -(y - iy));
    c.imageSmoothingEnabled = true;
    c.drawImage(slide, ix, iy, CW + 2, CH + 2, 0, 0, CW + 2, CH + 2);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 0.05;
    c.drawImage(noise, -Math.floor(R() * 128), -Math.floor(R() * 128), CW + 256, CH + 256);
    c.globalAlpha = 1;
    c.fillStyle = vig; c.fillRect(0, 0, CW, CH);
  };
  setInterval(draw, 33);
  draw();
  const stream = cam.captureStream(30);
  const fake = async () => stream;
  navigator.mediaDevices.getUserMedia = fake;
  navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'fake', label: 'fake microscope', groupId: 'g' }];

  // ---------- instrumentation ----------
  window.__stats = { imread: 0, longMs: 0, t0: null };
  const hook = setInterval(() => {
    if (window.cv && window.cv.imread && !window.cv.__wrapped) {
      const orig = window.cv.imread;
      window.cv.imread = function (...a) { if (window.__bench.start != null && !window.__bench.done) window.__stats.imread++; return orig.apply(this, a); };
      window.cv.__wrapped = true;
      clearInterval(hook);
    }
  }, 50);
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (window.__bench.start != null && !window.__bench.done) window.__stats.longMs += e.duration;
  }).observe({ entryTypes: ['longtask'] });
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await page.addInitScript(fakeCamera, { scenario, SPEED, COL_LEN });
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(url);
await page.waitForFunction(() => window.cv && window.cv.Mat, null, { timeout: 60000 });
await page.getByRole('button', { name: 'Camera trực tiếp' }).click();
await page.waitForTimeout(1500);
if (scenario === 'still') {
  const box = page.getByLabel('Chỉ ghi ô khi tay dừng');
  if (await box.count()) await box.check(); else throw new Error('no still-mode checkbox in this build');
}
await page.getByRole('button', { name: /Bắt đầu/ }).click();
await page.evaluate(() => { window.__bench.start = performance.now(); window.__bench.dateStart = Date.now(); });
await page.waitForFunction(() => window.__bench.done, null, { timeout: 600000, polling: 500 });
const runMs = await page.evaluate(() => window.__bench.tEnd);
await page.waitForTimeout(800);
const out = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('panorama-simple-db', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const rows = await new Promise((res) => { const q = db.transaction('tiles').objectStore('tiles').getAll(); q.onsuccess = () => res(q.result); });
  rows.sort((a, b) => a.index - b.index);
  const badge = document.querySelector('.badge');
  const logText = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0).map((e) => e.textContent).join('\n');
  const logEl = document.querySelector('.log');
  window.__Tout = window.__T || [];
  return { T: window.__Tout, log: logEl ? logEl.innerText : '', tiles: rows.map((r) => ({ x: r.x, y: r.y, at: r.capturedAt })), stats: window.__stats, B: window.__bench, badge: badge && badge.textContent, lostLines: (logText.match(/mất dấu|kéo quá xa/g) || []).length };
});
await browser.close();

// ---------- scoring ----------
const { tiles, stats, B } = out;
// Truth for a tile: its capture time is only known to within the PNG-encode delay
// (capturedAt is stamped after encoding), so only use tiles whose last ~0.6s was
// spent on a VERTICAL move or a pause: there the true x is fixed whatever the
// exact timing, so the x error is pure placement error.
const segAt = (ms) => B.segs.find((s) => ms <= s.t1) || B.segs[B.segs.length - 1];
const xErrs = [];
for (const t of tiles.slice(1)) {
  const ms = t.at - B.dateStart;
  const window = [];
  for (let m = ms - 600; m <= ms; m += 20) window.push(segAt(m));
  const xs = new Set(window.map((s) => s.x0 + '|' + s.x1));
  const sg = window[window.length - 1];
  if (xs.size === 1 && sg.x0 === sg.x1) xErrs.push({ ex: t.x - (sg.x0 - B.X0), y: t.y });
}
const absX = xErrs.map((e) => Math.abs(e.ex));
const res = {
  scenario, speed: SPEED, tiles: tiles.length,
  ticksPerSec: +(stats.imread / (runMs / 1000)).toFixed(1),
  mainThreadBusy: +(stats.longMs / runMs).toFixed(2),
  lostLogLines: out.lostLines, badge: out.badge,
  xErrTiles: xErrs.length,
  xErrMean: absX.length ? +(absX.reduce((a, b) => a + b, 0) / absX.length).toFixed(2) : null,
  xErrMax: absX.length ? +Math.max(...absX).toFixed(2) : null,
};
if (scenario === 'still') {
  // Every pause position is a truth point; match each tile to the nearest pause.
  const pauses = B.segs.filter((s) => s.pause).map((s) => [s.x0 - B.X0, s.y0 - B.Y0]);
  const errs = tiles.map((t) => Math.min(...pauses.map(([px, py]) => Math.hypot(t.x - px, t.y - py))));
  res.pauses = pauses.length;
  res.posErrMean = +(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2);
  res.posErrMax = +Math.max(...errs).toFixed(2);
}
console.log(JSON.stringify(res));
if (process.env.SHOWLOG) console.log(out.log);
if (process.env.SHOWT && out.T.length) {
  const agg = {};
  let prevK = null;
  for (const [k, v] of out.T) { (agg[k] ||= []).push(v); }
  for (const [k, vs] of Object.entries(agg)) { vs.sort((a, b) => a - b); console.log(k.padEnd(22), 'n=' + vs.length, 'med=' + vs[vs.length >> 1].toFixed(1), 'p90=' + vs[Math.floor(vs.length * 0.9)].toFixed(1), 'max=' + vs[vs.length - 1].toFixed(1)); }
}
