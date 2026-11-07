/* แอปเซ็นเอกสาร
   ทำงานในเครื่องล้วน: อ่านเอกสาร วางลายเซ็นกับข้อความ แล้วรวมเป็นภาพเดียวต่อหน้าตอนบันทึก */
'use strict';

const INK = { blue: '#1c2f86', black: '#151515' };
const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const EXPORT_DPI = 200;
const EXPORT_MAX_SIDE = 2400;

const $ = (id) => document.getElementById(id);
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const state = {
  pages: [],          // {kind:'pdf', pdf, num, wPt, hPt} | {kind:'img', img, wPt, hPt}
  cur: 0,
  place: { x: 0.68, y: 0.8, w: 0.38 },  // ตำแหน่งกลาง เป็นสัดส่วนของหน้า
  perPage: {},        // หน้าที่ลากแยกไว้
  offPages: new Set(),// หน้าที่ไม่เซ็น
  sigs: [],           // {id, name, keep, blob, img}
  selSig: null,
  ink: 'blue',
  pageCanvas: null,   // ภาพหน้าปัจจุบันที่ขนาดจอ
};

/* ---------- ที่เก็บในเครื่อง ---------- */
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('pe.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pe.' + k, JSON.stringify(v)); } catch { /* ไม่เป็นไร */ } },
};

const db = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((res, rej) => {
      let req;
      try { req = indexedDB.open('pang-esign', 1); } catch (e) { rej(e); return; }
      req.onupgradeneeded = () => req.result.createObjectStore('sigs', { keyPath: 'id' });
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return this._p;
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction('sigs', mode);
      const out = fn(t.objectStore('sigs'));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  put(rec) { return this.tx('readwrite', (s) => s.put(rec)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
};

/* ---------- เครื่องมือเล็ก ---------- */
function busy(on, text) {
  $('busy').hidden = !on;
  if (text) $('busyText').textContent = text;
}
function thaiDate(d) {
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
}
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('เปิดรูปไม่ได้'));
    im.src = src;
  });
}
function canvasToBlob(c, type, q) {
  return new Promise((res) => c.toBlob(res, type, q));
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
const seg = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
const gseg = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('th', { granularity: 'grapheme' }) : null;
function splitWords(s) {
  if (seg) return Array.from(seg.segment(s), (x) => x.segment);
  return Array.from(s);
}
function splitGraphemes(s) {
  if (gseg) return Array.from(gseg.segment(s), (x) => x.segment);
  return Array.from(s);
}
/* ตัดบรรทัดภาษาไทยตามคำ ถ้าคำเดียวยาวเกินบรรทัดจะตัดกลางคำ */
function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of splitWords(para)) {
      const test = line + word;
      if (ctx.measureText(test).width <= maxW || line === '') {
        if (ctx.measureText(test).width > maxW) {
          for (const g of splitGraphemes(word)) {
            if (ctx.measureText(line + g).width > maxW && line) { lines.push(line); line = ''; }
            line += g;
          }
        } else line = test;
      } else {
        lines.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    lines.push(line.trimEnd());
  }
  return lines.filter((l, i, a) => l !== '' || a.length === 1);
}

/* ---------- ลบพื้นหลังลายเซ็น ---------- */
/* หาค่าสูงสุดหรือต่ำสุดในหน้าต่างกว้าง 2r+1 ทีละแถว (van Herk ใช้เวลาเท่ากันไม่ว่า r เท่าไร) */
function filter1d(src, dst, n, stride, off, r, isMax) {
  const k = 2 * r + 1;
  const g = new Float32Array(n + k), h = new Float32Array(n + k);
  const pick = isMax ? Math.max : Math.min;
  const pad = isMax ? -Infinity : Infinity;
  const at = (i) => { const j = i - r; return j < 0 || j >= n ? pad : src[off + j * stride]; };
  const len = n + 2 * r;
  for (let i = 0; i < len; i++) g[i] = i % k === 0 ? at(i) : pick(g[i - 1], at(i));
  for (let i = len - 1; i >= 0; i--) h[i] = (i % k === k - 1 || i === len - 1) ? at(i) : pick(h[i + 1], at(i));
  for (let j = 0; j < n; j++) dst[off + j * stride] = pick(h[j], g[j + 2 * r]);
}
function filter2d(src, W, H, r, isMax) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) filter1d(src, tmp, W, 1, y * W, r, isMax);
  for (let x = 0; x < W; x++) filter1d(tmp, out, H, W, x, r, isMax);
  return out;
}

/* หาความสว่างของกระดาษเป็นช่องๆ แล้วเทียบ จึงลบเงามือถือที่ทอดลงกระดาษได้ด้วย */
function processSignature(img, strength, rotation, keepColor) {
  const maxSide = 1400;
  const sw = img.naturalWidth, sh = img.naturalHeight;
  const sc = Math.min(1, maxSide / Math.max(sw, sh));
  const w0 = Math.round(sw * sc), h0 = Math.round(sh * sc);
  const rot = ((rotation % 360) + 360) % 360;
  const W = rot % 180 ? h0 : w0, H = rot % 180 ? w0 : h0;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  x.translate(W / 2, H / 2); x.rotate(rot * Math.PI / 180);
  x.drawImage(img, -w0 / 2, -h0 / 2, w0, h0);
  x.setTransform(1, 0, 0, 1, 0, 0);
  const id = x.getImageData(0, 0, W, H), px = id.data;
  const N = W * H, L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];

  // ความสว่างกระดาษรายพิกเซล: ถมเส้นหมึกที่บางกว่า 2r ด้วยกระดาษรอบข้าง (closing)
  // ขอบเงาที่คมยังอยู่ครบ จึงลบเงามือถือที่ทอดลงกระดาษได้ทั้งแผ่น
  const r = Math.max(8, Math.round(Math.max(W, H) / 55));
  const bgImg = filter2d(filter2d(L, W, H, r, true), W, H, r, false);
  const bgAt = (xx, yy) => Math.max(30, bgImg[yy * W + xx]);
  // ความสว่างกระดาษทั้งแผ่น (ค่าอันดับ 80%) ใช้ปรับสีตราประทับให้สดเท่าของจริง
  const lh = new Uint32Array(256);
  for (let i = 0; i < N; i++) lh[L[i] | 0]++;
  let paper = 255;
  for (let acc = 0; paper > 60; paper--) { acc += lh[paper]; if (acc >= N * 0.2) break; }

  // ความเข้มของหมึก 0..1 แล้วหาเส้นแบ่งอัตโนมัติ (Otsu)
  const D = new Float32Array(N);
  const dh = new Uint32Array(256);
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    const i = yy * W + xx;
    const d = Math.max(0, Math.min(1, 1 - L[i] / bgAt(xx, yy)));
    D[i] = d; dh[Math.round(d * 255)]++;
  }
  let sum = 0; for (let k = 0; k < 256; k++) sum += k * dh[k];
  let sumB = 0, wB = 0, best = 0, T = 40;
  for (let k = 0; k < 256; k++) {
    wB += dh[k]; if (!wB) continue;
    const wF = N - wB; if (!wF) break;
    sumB += k * dh[k];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; T = k; }
  }
  const t = T / 255;
  const t0 = Math.min(0.5, Math.max(0.05, t * 0.45) + strength * 0.05);
  const t1 = t0 + Math.max(0.12, t * 0.55);

  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let i = 0; i < N; i++) {
    let a = Math.max(0, Math.min(1, (D[i] - t0) / (t1 - t0)));
    if (keepColor) {
      // ตราประทับมีพื้นทึบกว้าง ใช้ความสดของสีช่วย กระดาษกับเงาเป็นสีเทาจึงไม่ติดมา
      const R = px[i * 4], G = px[i * 4 + 1], B = px[i * 4 + 2];
      const mx = Math.max(R, G, B), sat = mx ? (mx - Math.min(R, G, B)) / mx : 0;
      a = Math.max(a, Math.min(1, Math.max(0, (sat - 0.28 - strength * 0.04) / 0.2)));
    }
    const A = Math.round(a * 255);
    if (keepColor) {
      // ตราประทับ ทำสีให้สดขึ้นตามความสว่างกระดาษ
      const k = 255 / paper;
      px[i * 4] = Math.min(255, px[i * 4] * k); px[i * 4 + 1] = Math.min(255, px[i * 4 + 1] * k); px[i * 4 + 2] = Math.min(255, px[i * 4 + 2] * k);
    } else { px[i * 4] = 0; px[i * 4 + 1] = 0; px[i * 4 + 2] = 0; }
    px[i * 4 + 3] = A;
    if (A > 60) {
      const yy = (i / W) | 0, xx = i - yy * W;
      if (xx < minX) minX = xx; if (xx > maxX) maxX = xx;
      if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
    }
  }
  x.putImageData(id, 0, 0);
  if (maxX < 0) return null;
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.03) + 2;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);
  const cwOut = maxX - minX + 1, chOut = maxY - minY + 1;
  const s2 = Math.min(1, 1000 / cwOut);
  const out = document.createElement('canvas');
  out.width = Math.round(cwOut * s2); out.height = Math.round(chOut * s2);
  out.getContext('2d').drawImage(c, minX, minY, cwOut, chOut, 0, 0, out.width, out.height);
  return out;
}

/* ---------- ลายเซ็นเปลี่ยนสี ---------- */
const tintCache = new Map();
function tinted(sig, color) {
  // ตราประทับคงสีเดิม แต่ยังทำเป็น canvas เพื่อให้ย่อแบบนุ่มได้เหมือนกัน
  const key = sig.keep ? sig.id : sig.id + color;
  if (tintCache.has(key)) return tintCache.get(key);
  const c = document.createElement('canvas');
  c.width = sig.img.naturalWidth; c.height = sig.img.naturalHeight;
  const x = c.getContext('2d');
  x.drawImage(sig.img, 0, 0);
  if (!sig.keep) {
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
  }
  tintCache.set(key, c);
  return c;
}

/* ย่อทีละครึ่งจนใกล้ขนาดจริง เส้นหมึกบางจะไม่ขาดเป็นจุดๆ ตอนย่อเล็ก */
const halfCache = new WeakMap();
function drawScaled(ctx, src, x, y, w, h) {
  let s = src;
  while (s.width > w * 2 && s.width > 8) {
    let half = halfCache.get(s);
    if (!half) {
      half = document.createElement('canvas');
      half.width = Math.ceil(s.width / 2); half.height = Math.ceil(s.height / 2);
      const hx = half.getContext('2d');
      hx.imageSmoothingQuality = 'high';
      hx.drawImage(s, 0, 0, half.width, half.height);
      halfCache.set(s, half);
    }
    s = half;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(s, x, y, w, h);
}

/* ---------- จัดวางบล็อกลายเซ็นกับข้อความ ---------- */
function blockOptions() {
  return {
    copy: $('optCopy').checked,
    purpose: $('optPurpose').checked && $('purpose').value.trim() ? $('purpose').value.trim() : '',
    date: $('optDate').checked ? $('dateText').value.trim() : '',
    sig: state.sigs.find((s) => s.id === state.selSig) || null,
    color: INK[state.ink],
  };
}

/* วาดบล็อกโดยให้จุดกลางอยู่ที่ (cx, cy) กว้าง W พิกเซล คืนกรอบที่วาดไป
   ถ้า measure เป็นจริง จะวัดขนาดอย่างเดียว ไม่วาด */
function drawBlock(ctx, cx, cy, W, opt, preview, measure) {
  const f = W * 0.085;
  const lh = 1.45;
  const parts = [];
  let y = 0;
  ctx.save();
  if (opt.copy) {
    ctx.font = `600 ${f * 1.2}px Sarabun`;
    parts.push({ t: 'text', s: 'สำเนาถูกต้อง', font: ctx.font, y: y + f * 1.2 });
    y += f * 1.2 * lh;
  }
  let sw = 0, sh = 0;
  if (opt.sig) {
    const im = opt.sig.img;
    const asp = im.naturalHeight / im.naturalWidth;
    sw = W * 0.8; sh = sw * asp;
    if (sh > W * 0.42) { sh = W * 0.42; sw = sh / asp; }
  } else if (preview) { sw = W * 0.7; sh = W * 0.25; }
  if (sh) { parts.push({ t: 'sig', y, w: sw, h: sh }); y += sh; }
  if (opt.purpose) {
    ctx.font = `400 ${f}px Sarabun`;
    const lines = wrapText(ctx, `ใช้สำหรับ${opt.purpose} เท่านั้น`, W);
    if (sh) y -= sh * 0.1; // ทับปลายลายเซ็นนิดหน่อย กันตัดลายเซ็นไปใช้ที่อื่น
    for (const l of lines) { parts.push({ t: 'text', s: l, font: ctx.font, y: y + f }); y += f * lh; }
  }
  if (opt.date) {
    ctx.font = `400 ${f}px Sarabun`;
    parts.push({ t: 'text', s: opt.date, font: ctx.font, y: y + f });
    y += f * lh;
  }
  const H = Math.max(y, f);
  const left = cx - W / 2, top = cy - H / 2;
  if (measure) { ctx.restore(); return { x: left, y: top, w: W, h: H }; }
  ctx.fillStyle = opt.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const p of parts) {
    if (p.t === 'text') { ctx.font = p.font; ctx.fillText(p.s, cx, top + p.y); }
    else if (opt.sig) drawScaled(ctx, tinted(opt.sig, opt.color), cx - p.w / 2, top + p.y, p.w, p.h);
    else {
      ctx.setLineDash([6, 5]); ctx.strokeStyle = '#d6336c'; ctx.lineWidth = 2;
      ctx.strokeRect(cx - p.w / 2, top + p.y, p.w, p.h);
      ctx.setLineDash([]); ctx.fillStyle = '#d6336c'; ctx.font = `400 ${f * 0.8}px Sarabun`;
      ctx.fillText('ยังไม่ได้เลือกลายเซ็น', cx, top + p.y + p.h / 2 + f * 0.3);
      ctx.fillStyle = opt.color;
    }
  }
  ctx.restore();
  return { x: left, y: top, w: W, h: H };
}

/* ---------- เอกสาร ---------- */
async function addDocFiles(files) {
  busy(true, 'กำลังเปิดเอกสาร...');
  const pages = [];
  try {
    for (const file of files) {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        for (let n = 1; n <= pdf.numPages; n++) {
          const vp = (await pdf.getPage(n)).getViewport({ scale: 1 });
          pages.push({ kind: 'pdf', pdf, num: n, wPt: vp.width, hPt: vp.height });
        }
      } else {
        const url = URL.createObjectURL(file);
        const img = await loadImage(url);
        const wPt = 595.28; // กว้างเท่า A4
        pages.push({ kind: 'img', img, wPt, hPt: wPt * img.naturalHeight / img.naturalWidth });
      }
    }
  } catch (e) {
    busy(false);
    $('docInfo').textContent = 'เปิดไฟล์นี้ไม่ได้ ลองไฟล์อื่น (' + e.message + ')';
    return;
  }
  state.pages = pages;
  state.cur = 0;
  state.perPage = {};
  state.offPages = new Set();
  $('docInfo').textContent = `${files.length} ไฟล์ รวม ${pages.length} หน้า`;
  await showPage();
  busy(false);
}

async function renderPage(i, pxWidth) {
  const p = state.pages[i];
  const sc = pxWidth / p.wPt;
  const c = document.createElement('canvas');
  c.width = Math.round(p.wPt * sc); c.height = Math.round(p.hPt * sc);
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  if (p.kind === 'pdf') {
    const page = await p.pdf.getPage(p.num);
    await page.render({ canvasContext: x, viewport: page.getViewport({ scale: sc }) }).promise;
  } else {
    x.drawImage(p.img, 0, 0, c.width, c.height);
  }
  return c;
}

function stageSize() {
  const p = state.pages[state.cur];
  const wrapW = $('stage').parentElement.clientWidth;
  const maxH = window.innerHeight * 0.65;
  let w = wrapW, h = w * p.hPt / p.wPt;
  if (h > maxH) { h = maxH; w = h * p.wPt / p.hPt; }
  return { w: Math.floor(w), h: Math.floor(h) };
}

let renderToken = 0;
async function showPage() {
  const has = state.pages.length > 0;
  $('stageEmpty').hidden = has;
  $('pager').hidden = state.pages.length < 2;
  if (!has) return;
  const tok = ++renderToken;
  const { w } = stageSize();
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const c = await renderPage(state.cur, w * dpr);
  if (tok !== renderToken) return;
  state.pageCanvas = c;
  $('pageLabel').textContent = `หน้า ${state.cur + 1}/${state.pages.length}`;
  $('prevPage').disabled = state.cur === 0;
  $('nextPage').disabled = state.cur === state.pages.length - 1;
  $('optOnPage').checked = !state.offPages.has(state.cur);
  draw();
}

/* ตำแหน่งของหน้า i โดยดันบล็อกให้อยู่ในหน้ากระดาษทั้งก้อน ข้อความจะไม่ตกขอบ */
const measureCtx = document.createElement('canvas').getContext('2d');
function placeOf(i) {
  const pl = state.perPage[i] || state.place;
  const p = state.pages[i];
  if (!p) return pl;
  const pw = 1000, ph = 1000 * p.hPt / p.wPt;
  const box = drawBlock(measureCtx, 0, 0, pl.w * pw, blockOptions(), true, true);
  const hw = Math.min(0.5, pl.w / 2), hh = Math.min(0.5, box.h / ph / 2);
  return { w: pl.w, x: Math.min(1 - hw, Math.max(hw, pl.x)), y: Math.min(1 - hh, Math.max(hh, pl.y)) };
}

let lastBox = null;
function draw() {
  const st = $('stage');
  if (!state.pageCanvas) return;
  const { w, h } = stageSize();
  const dpr = state.pageCanvas.width / w;
  st.style.width = w + 'px'; st.style.height = h + 'px';
  st.width = state.pageCanvas.width; st.height = Math.round(h * dpr);
  const x = st.getContext('2d');
  x.drawImage(state.pageCanvas, 0, 0, st.width, st.height);
  lastBox = null;
  if (state.offPages.has(state.cur)) return;
  const pl = placeOf(state.cur);
  const box = drawBlock(x, pl.x * st.width, pl.y * st.height, pl.w * st.width, blockOptions(), true);
  x.save();
  x.setLineDash([8 * dpr, 6 * dpr]); x.strokeStyle = 'rgba(214,51,108,.7)'; x.lineWidth = 1.5 * dpr;
  x.strokeRect(box.x - 4 * dpr, box.y - 4 * dpr, box.w + 8 * dpr, box.h + 8 * dpr);
  x.restore();
  lastBox = { x: box.x / st.width, y: box.y / st.height, w: box.w / st.width, h: box.h / st.height };
  $('sizeRange').value = Math.round(pl.w * 100);
}

/* ---------- ลากและถ่างนิ้ว ---------- */
const ptrs = new Map();
let gesture = null;
function fracPoint(e) {
  const r = $('stage').getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}
function setPlace(p) {
  const pl = { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)), w: Math.min(0.95, Math.max(0.1, p.w)) };
  state.place = pl;
  state.perPage[state.cur] = pl;
  draw();
}
function startGesture() {
  const pts = [...ptrs.values()];
  const pl = placeOf(state.cur);
  if (pts.length === 1) gesture = { kind: 'drag', from: pts[0], start: { ...pl } };
  else if (pts.length >= 2) {
    const r = $('stage').getBoundingClientRect();
    const d = Math.hypot((pts[0].x - pts[1].x) * r.width, (pts[0].y - pts[1].y) * r.height);
    gesture = { kind: 'pinch', d, mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, start: { ...pl } };
  }
}
$('stage').addEventListener('pointerdown', (e) => {
  if (!state.pages.length || state.offPages.has(state.cur)) return;
  try { $('stage').setPointerCapture(e.pointerId); } catch { /* บางเครื่องไม่ยอม ลากต่อได้ */ }
  const p = fracPoint(e);
  ptrs.set(e.pointerId, p);
  if (ptrs.size === 1 && lastBox && !(p.x >= lastBox.x && p.x <= lastBox.x + lastBox.w && p.y >= lastBox.y && p.y <= lastBox.y + lastBox.h)) {
    // แตะนอกกรอบ ย้ายบล็อกไปตรงนั้นเลย
    const pl = placeOf(state.cur);
    setPlace({ ...pl, x: p.x, y: p.y });
  }
  startGesture();
});
$('stage').addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId) || !gesture) return;
  ptrs.set(e.pointerId, fracPoint(e));
  const pts = [...ptrs.values()];
  if (gesture.kind === 'drag' && pts.length === 1) {
    setPlace({ ...gesture.start, x: gesture.start.x + pts[0].x - gesture.from.x, y: gesture.start.y + pts[0].y - gesture.from.y });
  } else if (gesture.kind === 'pinch' && pts.length >= 2) {
    const r = $('stage').getBoundingClientRect();
    const d = Math.hypot((pts[0].x - pts[1].x) * r.width, (pts[0].y - pts[1].y) * r.height);
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    setPlace({ x: gesture.start.x + mid.x - gesture.mid.x, y: gesture.start.y + mid.y - gesture.mid.y, w: gesture.start.w * d / Math.max(10, gesture.d) });
  }
});
function endPtr(e) {
  if (!ptrs.delete(e.pointerId)) return;
  gesture = null;
  if (ptrs.size) startGesture();
}
$('stage').addEventListener('pointerup', endPtr);
$('stage').addEventListener('pointercancel', endPtr);
$('stage').addEventListener('wheel', (e) => {
  if (!state.pages.length) return;
  e.preventDefault();
  const pl = placeOf(state.cur);
  setPlace({ ...pl, w: pl.w * (e.deltaY < 0 ? 1.06 : 1 / 1.06) });
}, { passive: false });
$('sizeRange').addEventListener('input', (e) => {
  if (!state.pages.length) return;
  setPlace({ ...placeOf(state.cur), w: e.target.value / 100 });
});

/* ---------- คลังลายเซ็น ---------- */
function renderSigList() {
  const box = $('sigList');
  box.textContent = '';
  for (const s of state.sigs) {
    const card = document.createElement('div');
    card.className = 'sig-card' + (s.id === state.selSig ? ' on' : '');
    const im = document.createElement('img');
    im.alt = s.name;
    im.src = tinted(s, INK[state.ink]).toDataURL ? tinted(s, INK[state.ink]).toDataURL() : s.img.src;
    const nm = document.createElement('div');
    nm.className = 'name'; nm.textContent = s.name;
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'del'; del.textContent = 'ลบ';
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      // แตะสองครั้งกันลบพลาด
      if (!del.classList.contains('armed')) {
        del.classList.add('armed'); del.textContent = 'แตะอีกครั้งเพื่อลบ';
        setTimeout(() => { del.classList.remove('armed'); del.textContent = 'ลบ'; }, 3000);
        return;
      }
      try { await db.del(s.id); } catch { /* ลบในจอต่อ */ }
      state.sigs = state.sigs.filter((x) => x.id !== s.id);
      if (state.selSig === s.id) state.selSig = state.sigs[0] ? state.sigs[0].id : null;
      prefs.set('selSig', state.selSig);
      renderSigList(); draw();
    });
    card.append(del, im, nm);
    card.addEventListener('click', () => {
      state.selSig = s.id; prefs.set('selSig', s.id);
      renderSigList(); draw();
    });
    box.append(card);
  }
}

async function loadSigs() {
  let recs = [];
  try { recs = await db.all(); } catch { recs = []; }
  recs.sort((a, b) => a.created - b.created);
  for (const r of recs) {
    try { r.img = await loadImage(URL.createObjectURL(r.blob)); state.sigs.push(r); } catch { /* ข้ามรูปเสีย */ }
  }
  const sel = prefs.get('selSig', null);
  state.selSig = state.sigs.some((s) => s.id === sel) ? sel : (state.sigs[0] ? state.sigs[0].id : null);
  renderSigList();
}

const sheet = { img: null, strength: 0, rot: 0, out: null };
function refreshSheet() {
  sheet.out = processSignature(sheet.img, sheet.strength, sheet.rot, $('sigKeepColor').checked);
  const pv = $('sigPreview');
  if (!sheet.out) {
    pv.width = 300; pv.height = 80;
    const x = pv.getContext('2d');
    x.font = '18px Sarabun'; x.fillStyle = '#a61e4d'; x.textAlign = 'center';
    x.fillText('ไม่เห็นเส้นลายเซ็น ลองกด คืนเส้นบาง', 150, 46);
    $('sigSave').disabled = true;
    return;
  }
  $('sigSave').disabled = false;
  pv.width = sheet.out.width; pv.height = sheet.out.height;
  const x = pv.getContext('2d');
  x.drawImage(sheet.out, 0, 0);
  if (!$('sigKeepColor').checked) {
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = INK[state.ink]; x.fillRect(0, 0, pv.width, pv.height);
  }
}
$('sigInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  busy(true, 'กำลังลบพื้นหลัง...');
  try { sheet.img = await loadImage(URL.createObjectURL(f)); } catch { busy(false); return; }
  sheet.strength = 0; sheet.rot = 0;
  $('sigKeepColor').checked = false;
  $('sigName').value = '';
  $('sigSheet').hidden = false;
  await new Promise((r) => setTimeout(r, 30));
  refreshSheet();
  busy(false);
});
function sheetStep(fn) {
  busy(true, 'กำลังปรับ...');
  setTimeout(() => { fn(); refreshSheet(); busy(false); }, 30);
}
$('sigMore').addEventListener('click', () => sheetStep(() => { sheet.strength = Math.min(6, sheet.strength + 1); }));
$('sigLess').addEventListener('click', () => sheetStep(() => { sheet.strength = Math.max(-2, sheet.strength - 1); }));
$('sigRotate').addEventListener('click', () => sheetStep(() => { sheet.rot = (sheet.rot + 90) % 360; }));
$('sigKeepColor').addEventListener('change', () => sheetStep(() => {}));
$('sigCancel').addEventListener('click', () => { $('sigSheet').hidden = true; });
$('sigSave').addEventListener('click', async () => {
  if (!sheet.out) return;
  const name = $('sigName').value.trim() || `ลายเซ็น ${state.sigs.length + 1}`;
  const blob = await canvasToBlob(sheet.out, 'image/png');
  const rec = { id: 's' + Date.now(), name, keep: $('sigKeepColor').checked, blob, created: Date.now() };
  let saved = true;
  try { await db.put(rec); } catch { saved = false; }
  rec.img = await loadImage(URL.createObjectURL(blob));
  state.sigs.push(rec);
  state.selSig = rec.id; prefs.set('selSig', rec.id);
  $('sigSheet').hidden = true;
  renderSigList(); draw();
  if (!saved) $('saveInfo').textContent = 'เครื่องนี้ไม่ยอมให้จำลายเซ็น ใช้ได้รอบนี้รอบเดียว';
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
});

/* ---------- ตัวเลือกอื่น ---------- */
document.querySelectorAll('#inkSeg button').forEach((b) => b.addEventListener('click', () => {
  state.ink = b.dataset.ink; prefs.set('ink', state.ink);
  document.querySelectorAll('#inkSeg button').forEach((x) => x.classList.toggle('on', x === b));
  renderSigList(); draw();
}));
['optCopy', 'optPurpose', 'optDate'].forEach((id) => $(id).addEventListener('change', () => { prefs.set(id, $(id).checked); draw(); }));
$('purpose').addEventListener('input', () => { prefs.set('purpose', $('purpose').value); draw(); });
$('dateText').addEventListener('input', draw);
$('optOnPage').addEventListener('change', (e) => {
  if (e.target.checked) state.offPages.delete(state.cur); else state.offPages.add(state.cur);
  draw();
});
$('applyAll').addEventListener('click', () => {
  state.place = { ...placeOf(state.cur) };
  state.perPage = {};
  state.offPages = new Set();
  $('optOnPage').checked = true;
  $('saveInfo').textContent = `วางตำแหน่งเดียวกันครบ ${state.pages.length} หน้าแล้ว`;
  draw();
});
$('prevPage').addEventListener('click', () => { if (state.cur > 0) { state.cur--; showPage(); } });
$('nextPage').addEventListener('click', () => { if (state.cur < state.pages.length - 1) { state.cur++; showPage(); } });
$('docInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) addDocFiles(files);
});
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(showPage, 200); });

/* ---------- บันทึก ---------- */
async function composePage(i) {
  const p = state.pages[i];
  let px = p.wPt * EXPORT_DPI / 72;
  const maxSide = Math.max(p.wPt, p.hPt) * EXPORT_DPI / 72;
  if (maxSide > EXPORT_MAX_SIDE) px *= EXPORT_MAX_SIDE / maxSide;
  const c = await renderPage(i, px);
  if (!state.offPages.has(i)) {
    const pl = placeOf(i);
    drawBlock(c.getContext('2d'), pl.x * c.width, pl.y * c.height, pl.w * c.width, blockOptions(), false);
  }
  return c;
}
function canSave() {
  if (!state.pages.length) { $('saveInfo').textContent = 'เลือกเอกสารก่อน'; return false; }
  const o = blockOptions();
  if (!o.sig && !o.copy && !o.purpose && !o.date) { $('saveInfo').textContent = 'ยังไม่มีอะไรให้วาง เลือกลายเซ็นหรือข้อความก่อน'; return false; }
  return true;
}
async function deliver(files) {
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return 'ส่งต่อแล้ว'; } catch (e) {
      if (e.name === 'AbortError') return 'ยกเลิกการส่ง ไฟล์ยังไม่ได้บันทึก';
    }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    await new Promise((r) => setTimeout(r, 300));
  }
  return `บันทึกแล้ว ${files.length} ไฟล์ ดูในโฟลเดอร์ดาวน์โหลด`;
}
$('savePdf').addEventListener('click', async () => {
  if (!canSave()) return;
  try {
    const { jsPDF } = window.jspdf;
    let doc = null;
    for (let i = 0; i < state.pages.length; i++) {
      busy(true, `กำลังรวมหน้า ${i + 1}/${state.pages.length}...`);
      const p = state.pages[i];
      const orient = p.wPt > p.hPt ? 'l' : 'p';
      if (!doc) doc = new jsPDF({ unit: 'pt', format: [p.wPt, p.hPt], orientation: orient, compress: true });
      else doc.addPage([p.wPt, p.hPt], orient);
      const c = await composePage(i);
      doc.addImage(c.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, p.wPt, p.hPt, undefined, 'FAST');
      c.width = c.height = 0;
    }
    const blob = doc.output('blob');
    const file = new File([blob], `เซ็นแล้ว-${stamp()}.pdf`, { type: 'application/pdf' });
    busy(false);
    $('saveInfo').textContent = await deliver([file]);
  } catch (e) {
    busy(false);
    $('saveInfo').textContent = 'บันทึกไม่สำเร็จ: ' + e.message;
  }
});
$('saveImg').addEventListener('click', async () => {
  if (!canSave()) return;
  try {
    const files = [];
    const n = state.pages.length;
    for (let i = 0; i < n; i++) {
      busy(true, `กำลังทำรูปหน้า ${i + 1}/${n}...`);
      const c = await composePage(i);
      const blob = await canvasToBlob(c, 'image/jpeg', 0.9);
      files.push(new File([blob], `เซ็นแล้ว-${stamp()}${n > 1 ? '-หน้า' + (i + 1) : ''}.jpg`, { type: 'image/jpeg' }));
      c.width = c.height = 0;
    }
    busy(false);
    $('saveInfo').textContent = await deliver(files);
  } catch (e) {
    busy(false);
    $('saveInfo').textContent = 'บันทึกไม่สำเร็จ: ' + e.message;
  }
});

/* ---------- เริ่ม ---------- */
(async function init() {
  state.ink = prefs.get('ink', 'blue') === 'black' ? 'black' : 'blue';
  document.querySelectorAll('#inkSeg button').forEach((x) => x.classList.toggle('on', x.dataset.ink === state.ink));
  ['optCopy', 'optPurpose', 'optDate'].forEach((id) => { $(id).checked = prefs.get(id, true); });
  $('purpose').value = prefs.get('purpose', '');
  $('dateText').value = thaiDate(new Date());
  try { await Promise.all([document.fonts.load('600 40px Sarabun', 'สำเนาถูกต้อง'), document.fonts.load('400 40px Sarabun', 'ใช้สำหรับ')]); } catch { /* ใช้ฟอนต์เครื่อง */ }
  await loadSigs();
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (ios && !standalone && !prefs.get('installClosed', false)) $('installTip').hidden = false;
  $('installClose').addEventListener('click', () => { $('installTip').hidden = true; prefs.set('installClosed', true); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
