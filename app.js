// صيدتي — offline fish identification for the Arabian Sea coast of Oman
const VER = "202610120859";
const ASSET_CACHE = "samak-assets-v1";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const view = $("#view");
const fmt = new Intl.NumberFormat("ar-OM-u-nu-latn", { maximumFractionDigits: 1 });

const S = {
  species: [], byId: new Map(), nameCount: new Map(), meta: null, groups: [],
  refs: null, refSp: null, text: null, learned: [],
  result: null, ml: null, mlReady: null, pack: { running: false, done: false, pct: 0 },
};

/* ---------- utilities ---------- */
async function getJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }
async function getBin(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + " " + r.status); return r.arrayBuffer(); }
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms);
}
export function normAr(s) {
  return String(s || "").toLowerCase()
    .replace(/[ً-ْـ]/g, "").replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[’'`]/g, "").replace(/\s+/g, " ").trim();
}
const imgUrl = (sp) => (sp.img ? "img/" + sp.img : "");
// a local name shared by many species (e.g. «هامور») is a poor title; fall back to the specific Arabic name
const title = (sp) => (sp.local[0] && (S.nameCount.get(normAr(sp.local[0])) || 0) <= 2 ? sp.local[0] : sp.std || sp.local[0] || sp.en || sp.sci);
function altNames(sp) {
  const t = title(sp);
  return [...sp.local, sp.std].filter((n, i, a) => n && n !== t && a.indexOf(n) === i);
}
const nf = (n) => fmt.format(n);

/* ---------- data ---------- */
async function loadData() {
  const [sp, meta] = await Promise.all([getJSON("data/species.json?v=" + VER), getJSON("data/meta.json?v=" + VER)]);
  S.species = sp; S.meta = meta; S.groups = meta.groups;
  sp.forEach((s, i) => { s.i = i; S.byId.set(s.id, s); });
  S.nameCount = new Map();
  for (const s of sp) for (const n of new Set(s.local.map(normAr))) S.nameCount.set(n, (S.nameCount.get(n) || 0) + 1);
  const buf = await getBin(meta.refs.file + "?v=" + VER);
  S.refs = new Float32Array(buf, 0, meta.refs.n * meta.refs.dim);
  S.refSp = Int16Array.from(meta.refs.species);
  if (meta.text) {
    const tb = await getBin(meta.text.file + "?v=" + VER);
    S.text = new Float32Array(tb, 0, sp.length * meta.refs.dim);
  }
}

/* ---------- catch log (IndexedDB) ---------- */
const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open("samak", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("catches", { keyPath: "id" });
      r.onsuccess = () => res((this._db = r.result));
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction("catches", mode); const st = t.objectStore("catches");
      const out = fn(st); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error);
    });
  },
  add(rec) { return this.tx("readwrite", (st) => st.put(rec)); },
  del(id) { return this.tx("readwrite", (st) => st.delete(id)); },
  all() { return this.tx("readonly", (st) => st.getAll()); },
};
async function loadLearned() {
  try {
    const all = await DB.all();
    S.learned = all.filter((c) => c.emb && S.byId.has(c.sid)).map((c) => ({ si: S.byId.get(c.sid).i, emb: new Float32Array(c.emb) }));
  } catch { S.learned = []; }
}

/* ---------- ML worker ---------- */
function ml(op, payload, transfer) {
  if (!S.ml) {
    S.ml = new Worker("ml-worker.js?v=" + VER, { type: "module" });
    S.ml._n = 0; S.ml._p = new Map();
    S.ml.onmessage = (e) => { const p = S.ml._p.get(e.data.id); if (!p) return; S.ml._p.delete(e.data.id); e.data.ok ? p.res(e.data) : p.rej(new Error(e.data.error)); };
    S.ml.onerror = (e) => { for (const p of S.ml._p.values()) p.rej(new Error(e.message || "worker error")); S.ml._p.clear(); };
  }
  const id = ++S.ml._n;
  return new Promise((res, rej) => { S.ml._p.set(id, { res, rej }); S.ml.postMessage({ id, op, ...payload }, transfer || []); });
}
function mlInit() {
  if (!S.mlReady) S.mlReady = ml("init", { meta: S.meta, cache: ASSET_CACHE }).catch((e) => { S.mlReady = null; throw e; });
  return S.mlReady;
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const im = new Image();
    im.onload = () => res({ im, url }); im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("تعذّر فتح الصورة")); };
    im.src = url;
  });
}
function canvasOf(w, h) { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
function baseCanvas(im, maxSide = 1024) {
  const w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = canvasOf(w * k, h * k); const g = c.getContext("2d");
  g.imageSmoothingQuality = "high"; g.drawImage(im, 0, 0, c.width, c.height); return c;
}
// resize (squash or white-pad) into size x size and normalise to CHW float32
function tensorFrom(src, size, mean, std, mode) {
  const c = canvasOf(size, size); const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  if (mode === "pad") {
    g.fillStyle = "#fff"; g.fillRect(0, 0, size, size);
    const k = size / Math.max(src.width, src.height); const w = src.width * k, h = src.height * k;
    g.drawImage(src, (size - w) / 2, (size - h) / 2, w, h);
  } else g.drawImage(src, 0, 0, size, size);
  const d = g.getImageData(0, 0, size, size).data; const n = size * size; const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = (d[i * 4] / 255 - mean[0]) / std[0];
    out[n + i] = (d[i * 4 + 1] / 255 - mean[1]) / std[1];
    out[2 * n + i] = (d[i * 4 + 2] / 255 - mean[2]) / std[2];
  }
  return out;
}
// bounding box of the salient object from a size x size probability mask, in base-canvas pixels
function maskBox(mask, size, W, H) {
  let mx = 0; for (let i = 0; i < mask.length; i++) if (mask[i] > mx) mx = mask[i];
  const th = Math.max(0.2, mx * 0.5);
  let x0 = size, y0 = size, x1 = -1, y1 = -1, cnt = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mask[y * size + x] > th) { cnt++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (cnt < size * size * 0.01) return null;
  const sx = W / size, sy = H / size; const mxp = (x1 - x0) * 0.06 + 2, myp = (y1 - y0) * 0.06 + 2;
  const b = { x: Math.max(0, (x0 - mxp) * sx), y: Math.max(0, (y0 - myp) * sy) };
  b.w = Math.min(W, (x1 + 1 + mxp) * sx) - b.x; b.h = Math.min(H, (y1 + 1 + myp) * sy) - b.y;
  if (b.w * b.h > W * H * 0.92) return null;
  return b;
}
function cutout(base, box, mask, msize) {
  const b = box || { x: 0, y: 0, w: base.width, h: base.height };
  const c = canvasOf(b.w, b.h); const g = c.getContext("2d");
  g.drawImage(base, b.x, b.y, b.w, b.h, 0, 0, c.width, c.height);
  if (mask && S.meta.seg && S.meta.seg.composite) {
    // composite the fish onto white using the (upsampled) soft mask
    const m = canvasOf(msize, msize); const mg = m.getContext("2d"); const md = mg.createImageData(msize, msize);
    for (let i = 0; i < msize * msize; i++) { const a = Math.min(1, Math.max(0, (mask[i] - 0.15) / 0.5)); md.data[i * 4 + 3] = a * 255; }
    mg.putImageData(md, 0, 0);
    const out = canvasOf(c.width, c.height); const og = out.getContext("2d");
    og.fillStyle = "#fff"; og.fillRect(0, 0, out.width, out.height);
    const fish = canvasOf(c.width, c.height); const fg = fish.getContext("2d");
    fg.drawImage(c, 0, 0);
    fg.globalCompositeOperation = "destination-in";
    fg.drawImage(m, (b.x / base.width) * msize, (b.y / base.height) * msize, (b.w / base.width) * msize, (b.h / base.height) * msize, 0, 0, c.width, c.height);
    og.drawImage(fish, 0, 0); return out;
  }
  return c;
}
function l2(v) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; s = Math.sqrt(s) || 1; for (let i = 0; i < v.length; i++) v[i] /= s; return v; }

async function embedCanvas(c) {
  const m = S.meta.model;
  const views = [c];
  if (m.flipTTA) { const f = canvasOf(c.width, c.height); const g = f.getContext("2d"); g.translate(f.width, 0); g.scale(-1, 1); g.drawImage(c, 0, 0); views.push(f); }
  const acc = new Float32Array(S.meta.refs.dim);
  for (const v of views) {
    const inp = tensorFrom(v, m.size, m.mean, m.std, m.resize);
    const r = await ml("embed", { input: inp }, [inp.buffer]);
    const e = l2(new Float32Array(r.emb)); for (let i = 0; i < acc.length; i++) acc[i] += e[i];
  }
  return l2(acc);
}

async function identify(file, manualBox, onStep) {
  const { im, url } = await loadImage(file);
  URL.revokeObjectURL(url);
  onStep && onStep(1);
  await mlInit();
  const base = baseCanvas(im, 1024);
  // the region of interest is the whole photo, or the frame the user drew
  const region = manualBox ? cutout(base, manualBox, null, 0) : base;
  let box = null, mask = null;
  const seg = S.meta.seg;
  if (seg) {
    const inp = tensorFrom(region, seg.size, seg.mean, seg.std, "squash");
    const r = await ml("seg", { input: inp }, [inp.buffer]);
    mask = new Float32Array(r.mask);
    box = maskBox(mask, seg.size, region.width, region.height);
  }
  onStep && onStep(2);
  const fish = cutout(region, box, mask, seg ? seg.size : 0);
  const emb = await embedCanvas(fish);
  onStep && onStep(3);
  const ranked = rank(emb);
  const full = canvasOf(Math.min(base.width, 900), (Math.min(base.width, 900) * base.height) / base.width);
  full.getContext("2d").drawImage(base, 0, 0, full.width, full.height);
  // what the user sees as "your photo": the fish area, without the white cut-out
  const shown = cutout(region, box, null, 0);
  const absBox = box ? { x: box.x + (manualBox ? manualBox.x : 0), y: box.y + (manualBox ? manualBox.y : 0), w: box.w, h: box.h } : manualBox;
  return { file, base, box: absBox, emb, ranked, photo: shown.toDataURL("image/jpeg", 0.85), full: full.toDataURL("image/jpeg", 0.85) };
}

function rank(emb) {
  const { dim, n } = S.meta.refs; const N = S.species.length; const sc = S.meta.scoring;
  const best = new Float32Array(N).fill(-2);
  const R = S.refs;
  for (let r = 0; r < n; r++) {
    let d = 0; const o = r * dim; for (let k = 0; k < dim; k++) d += emb[k] * R[o + k];
    const s = S.refSp[r]; if (d > best[s]) best[s] = d;
  }
  for (const L of S.learned) {
    let d = 0; for (let k = 0; k < dim; k++) d += emb[k] * L.emb[k];
    d += sc.learnedBonus || 0; if (d > best[L.si]) best[L.si] = d;
  }
  const fused = new Float32Array(N);
  let tz = null;
  if (S.text && sc.wText) {
    const t = new Float32Array(N); let mu = 0;
    for (let s = 0; s < N; s++) { let d = 0; const o = s * dim; for (let k = 0; k < dim; k++) d += emb[k] * S.text[o + k]; t[s] = d; mu += d; }
    mu /= N; let sd = 0; for (let s = 0; s < N; s++) sd += (t[s] - mu) ** 2; sd = Math.sqrt(sd / N) || 1;
    tz = t.map((v) => (v - mu) / sd);
  }
  for (let s = 0; s < N; s++) fused[s] = best[s] < -1 ? -9 : best[s] + (tz ? sc.wText * tz[s] : 0);
  const order = [...fused.keys()].sort((a, b) => fused[b] - fused[a]).slice(0, 30);
  const top = fused[order[0]]; let z = 0; const ex = order.map((s) => { const v = Math.exp((fused[s] - top) / sc.temp); z += v; return v; });
  return order.map((s, j) => ({ s, sim: best[s], score: fused[s], p: ex[j] / z }));
}
function level(r) {
  const sc = S.meta.scoring; const a = r[0], gap = r[0].score - r[1].score;
  if ((gap >= sc.hiGap && a.sim >= sc.hiMin) || (a.sim >= sc.hiSim && gap >= sc.midGap)) return "hi";
  if (gap >= sc.midGap || a.sim >= sc.midSim) return "mid";
  return "lo";
}
const LEVEL_TXT = { hi: "تطابق قوي", mid: "تطابق محتمل", lo: "غير متأكد" };

/* ---------- offline pack ---------- */
async function packCheck() {
  try {
    if (!("caches" in window)) return false;
    const list = await getJSON("data/assets.json?v=" + VER);
    S.pack.list = list;
    const flag = localStorage.getItem("samak-pack") === list.version;
    if (!flag) return false;
    const c = await caches.open(ASSET_CACHE);
    for (const p of list.critical) if (!(await c.match(p))) return false;
    return true;
  } catch { return false; }
}
async function packDownload(onProgress) {
  if (S.pack.running) return; S.pack.running = true;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
  try {
    const list = S.pack.list || (await getJSON("data/assets.json?v=" + VER));
    const c = await caches.open(ASSET_CACHE);
    const todo = []; let have = 0;
    for (const f of list.files) { if (await c.match(f.p)) have += f.s; else todo.push(f); }
    let got = have; const total = list.total;
    onProgress(got / total);
    let i = 0; let failed = 0;
    async function lane() {
      while (i < todo.length) {
        const f = todo[i++];
        for (let a = 0; a < 3; a++) {
          try { const r = await fetch(f.p, { cache: "no-store" }); if (!r.ok) throw new Error(r.status); await c.put(f.p, r); got += f.s; onProgress(got / total); break; }
          catch (e) { if (a === 2) failed++; else await new Promise((r) => setTimeout(r, 800)); }
        }
      }
    }
    await Promise.all([lane(), lane(), lane(), lane()]);
    if (failed) throw new Error(failed + " ملفات لم تكتمل");
    localStorage.setItem("samak-pack", list.version);
    S.pack.done = true; onProgress(1);
  } finally { S.pack.running = false; }
}

/* ---------- views ---------- */
const CAM_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h3.5l2-2.5h7l2 2.5H21v11H3z"/><circle cx="12" cy="13" r="4"/></svg>';
const SEARCH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>';

function spRow(sp, extra = "") {
  const th = imgUrl(sp) ? `<span class="th" style="background-image:url('${imgUrl(sp)}')"></span>` : `<span class="th none">بدون صورة</span>`;
  const alt = altNames(sp).slice(0, 3).join("، ");
  return `<li><a class="sp" href="#/s/${sp.id}">${th}<span class="tx"><span class="nm">${esc(title(sp))}</span>${alt ? `<span class="al">${esc(alt)}</span>` : ""}<span class="sci">${esc(sp.sci)}</span></span>${extra}</a></li>`;
}

function packBlock() {
  if (S.pack.done) return `<div class="pack done" id="pack">جاهز للعمل بدون إنترنت</div>`;
  const mb = S.pack.list ? Math.round(S.pack.list.total / 1048576) : 130;
  return `<div class="pack" id="pack"><strong>نزّل بيانات التطبيق مرة واحدة</strong>حتى يتعرّف على الأسماك في البحر بدون إنترنت. الحجم حوالي ${nf(mb)} ميغابايت، يُفضّل على الواي فاي.
    <div class="row"><span class="bar"><i id="packBar" style="width:${Math.round(S.pack.pct * 100)}%"></i></span><button id="packBtn"${S.pack.running ? " disabled" : ""}>${S.pack.running ? "جارٍ التنزيل…" : "تنزيل"}</button></div></div>`;
}
function bindPack() {
  const b = $("#packBtn"); if (!b) return;
  b.onclick = async () => {
    if (!navigator.onLine) { toast("اتصل بالإنترنت لتنزيل البيانات"); return; }
    b.disabled = true; b.textContent = "جارٍ التنزيل…";
    try {
      await packDownload((p) => { S.pack.pct = p; const bar = $("#packBar"); if (bar) bar.style.width = Math.round(p * 100) + "%"; });
      const el = $("#pack"); if (el) el.outerHTML = packBlock();
      toast("اكتمل التنزيل. التطبيق يعمل الآن بدون إنترنت");
    } catch (e) {
      toast("توقف التنزيل: " + e.message + ". اضغط تنزيل للمتابعة");
      const el = $("#pack"); if (el) { el.outerHTML = packBlock(); bindPack(); }
    }
  };
}

const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const STANDALONE = (navigator.standalone === true) || matchMedia("(display-mode: standalone)").matches;
function installCard() {
  if (!IOS || STANDALONE) return "";
  return `<div class="pack"><strong>ثبّته أولاً على الشاشة الرئيسية</strong>اضغط زر المشاركة <svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:-3px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M12 3v12M8 7l4-4 4 4M5 11v9h14v-9"/></svg> في Safari، ثم «إضافة إلى الشاشة الرئيسية». بعدها افتح «صيدتي» من الشاشة الرئيسية ونزّل البيانات من هناك.</div>`;
}
function viewHome() {
  view.innerHTML = `
    ${installCard()}
    <p class="lead">صوّر السمكة التي اصطدتها، ويطابقها التطبيق مع ${nf(S.species.length)} نوعاً من أطلس أسماك بحر العرب في عُمان.</p>
    <button class="shoot" id="shoot">${CAM_SVG}<span>صوّر السمكة</span></button>
    <button class="alt" id="pick">اختر صورة من الألبوم</button>
    ${IOS && !STANDALONE ? "" : packBlock()}
    <h2 class="mark">لنتيجة أدق</h2>
    <ul class="tips">
      <li>صوّر السمكة كاملة من جانبها، من الرأس إلى الذيل.</li>
      <li>ضعها على سطح بلون واحد، وابعد اليد والأشياء الأخرى قدر الإمكان.</li>
      <li>صوّر في ضوء النهار، وافرد الزعانف إن استطعت.</li>
      <li>إذا ظهرت أشياء كثيرة في الصورة، استخدم «ضبط الإطار» بعد النتيجة.</li>
    </ul>
    <p class="src"><a href="#/about">عن التطبيق ومصدر البيانات</a></p>`;
  $("#shoot").onclick = () => $("#camInput").click();
  $("#pick").onclick = () => $("#libInput").click();
  bindPack();
}

function groupCount(g) { return S.species.filter((s) => s.group === g).length; }
function viewBrowse(q = "") {
  view.innerHTML = `
    <div class="search" style="margin-top:0">${SEARCH_SVG}<input id="q" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="ابحث بالاسم: هامور، كنعد، شعري، Tuna" value="${esc(q)}"></div>
    <div id="res"></div>`;
  const inp = $("#q"); const res = $("#res");
  const draw = () => {
    const v = inp.value.trim();
    history.replaceState(null, "", v ? "#/browse?q=" + encodeURIComponent(v) : "#/browse");
    if (!v) {
      res.innerHTML = `<h2 class="mark">تصفّح حسب النوع</h2><div class="groups">${S.groups.map((g) => {
        const rep = S.byId.get(g.rep); return `<a class="gt" href="#/g/${g.id}"><span class="ph" style="background-image:url('${rep ? imgUrl(rep) : ""}')"></span><b>${esc(g.ar)}</b><small>${nf(groupCount(g.id))} نوعاً</small></a>`;
      }).join("")}</div>`;
      return;
    }
    const hits = search(v);
    res.innerHTML = hits.length
      ? `<p class="count" style="margin-top:14px">${nf(hits.length)} نتيجة</p><ul class="list">${hits.slice(0, 80).map((s) => spRow(s)).join("")}</ul>`
      : `<div class="empty">لا يوجد اسم يطابق «${esc(v)}». جرّب جزءاً من الاسم أو الاسم الإنجليزي.</div>`;
  };
  let t; inp.oninput = () => { clearTimeout(t); t = setTimeout(draw, 120); };
  draw();
}
function search(q) {
  const toks = normAr(q).split(" ").filter(Boolean);
  if (!toks.length) return [];
  const out = [];
  for (const s of S.species) {
    let ok = true; let score = 0;
    for (const t of toks) {
      const t2 = t.startsWith("ال") && t.length > 3 ? t.slice(2) : t;
      if (s.q.includes(t)) score += 1; else if (s.q.includes(t2)) score += 0.8; else { ok = false; break; }
    }
    if (!ok) continue;
    const nq = normAr(q);
    const names = [...s.local, s.std].map(normAr);
    if (names.some((n) => n === nq || n === "ال" + nq)) score += 5;
    else if (names.some((n) => n.startsWith(nq) || n.startsWith("ال" + nq))) score += 3;
    if (s.local.map(normAr).some((n) => n.includes(nq))) score += 1;
    if (s.en.toLowerCase().startsWith(q.toLowerCase())) score += 2;
    out.push([score, s]);
  }
  return out.sort((a, b) => b[0] - a[0]).map((x) => x[1]);
}

function viewGroup(id) {
  const g = S.groups.find((x) => x.id === id); if (!g) return viewBrowse();
  const list = S.species.filter((s) => s.group === id).sort((a, b) => (a.familyAr + a.sci).localeCompare(b.familyAr + b.sci, "ar"));
  let html = `<h1 class="hero-name" style="margin-top:0">${esc(g.ar)}</h1><p class="count">${nf(list.length)} نوعاً</p>`;
  let fam = null; let open = false;
  for (const s of list) {
    if (s.family !== fam) {
      if (open) html += "</ul>";
      fam = s.family; html += `<h2 class="mark">${esc(s.familyAr || s.family)} <span class="sub sci" style="font-weight:400">${esc(s.family)}</span></h2><ul class="list">`; open = true;
    }
    html += spRow(s);
  }
  if (open) html += "</ul>";
  view.innerHTML = html;
}

function tapeHTML(sz) {
  if (!sz || !sz.max) return "";
  const max = sz.max; const com = sz.common && sz.common < max ? sz.common : null;
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500];
  const span = max * 1.12; const major = steps.find((s) => span / s <= 6) || 1000;
  const L = Math.ceil(span / major) * major;
  const pct = (v) => (v / L) * 100;
  let labels = ""; for (let v = major; v < L; v += major) labels += `<span style="right:${pct(v)}%">${v}</span>`;
  const minor = major / 5;
  return `<div class="tape" style="--major:${pct(major)}%;--minor:${pct(minor)}%">
    <div class="rule">${labels}${com ? `<i class="mk com" style="right:${pct(com)}%"></i>` : ""}<i class="mk max" style="right:${pct(max)}%"></i></div>
    <div class="legend">${com ? `<span><b style="background:var(--sea)"></b>الطول الشائع ${nf(com)} سم</span>` : ""}<span><b style="background:var(--buoy)"></b>أقصى طول ${nf(max)} سم</span></div></div>`;
}
const MEAS = { TL: "الطول الكلي", SL: "الطول القياسي", FL: "حتى تفرّع الذيل", WD: "عرض القرص", DW: "عرض القرص" };

function viewSpecies(id, fromResult) {
  const sp = S.byId.get(id); if (!sp) return viewHome();
  const r = fromResult && S.result ? S.result : null;
  const sz = sp.size || {};
  const sizeBits = [];
  if (sz.max) sizeBits.push(`أقصى طول ${nf(sz.max)} سم${MEAS[sz.maxType] ? ` (${MEAS[sz.maxType]})` : ""}`);
  if (sz.common) sizeBits.push(`الطول الشائع ${nf(sz.common)} سم`);
  if (sz.weight) sizeBits.push(`أقصى وزن مسجّل ${nf(sz.weight)} ${sz.weightUnit}`);
  if (sz.age) sizeBits.push(`أقصى عمر مسجّل ${nf(sz.age)} سنة`);
  const alts = altNames(sp);
  view.innerHTML = `
    ${r ? `<div class="plate" style="margin-top:0"><figure><img src="${r.photo}" alt="صورتك"><figcaption>صورتك</figcaption></figure><figure>${sp.img ? `<img src="${imgUrl(sp)}" alt="صورة الأطلس">` : ""}<figcaption>${sp.img ? "صورة الأطلس" : "لا توجد صورة في الأطلس"}</figcaption></figure></div>`
        : `<div class="sp-hero">${sp.img ? `<img src="${imgUrl(sp)}" alt="${esc(title(sp))}">` : `<div class="noimg">لا توجد صورة لهذا النوع في الأطلس</div>`}</div>`}
    <div class="names">
      <h1 class="hero-name">${esc(title(sp))}</h1>
      ${alts.length ? `<div class="chips">${alts.map((a) => `<span class="chip">${esc(a)}</span>`).join("")}</div>` : ""}
      <div class="hero-sci"><bdi dir="ltr"><span class="sci">${esc(sp.sci)}</span> ${esc(sp.author)}</bdi></div>
      ${sp.en ? `<div class="hero-alt"><bdi dir="ltr">${esc(sp.en)}</bdi></div>` : ""}
    </div>
    ${r ? `<div class="actions"><button class="btn ok" id="yes">هذه سمكتي، احفظها</button></div>` : ""}
    ${sz.max ? `<h2 class="mark">الحجم</h2>${tapeHTML(sz)}` : ""}
    <h2 class="mark">معلومات</h2>
    <dl class="facts">
      <dt>الفصيلة</dt><dd>${esc(sp.familyAr || "")} <span class="sci sub">${esc(sp.family)}</span></dd>
      ${sizeBits.length ? `<dt>الحجم</dt><dd>${sizeBits.map(esc).join("<br>")}</dd>` : ""}
      ${sp.env.length ? `<dt>البيئة</dt><dd>${esc(sp.env.join("، "))}</dd>` : ""}
      ${sp.depth.length ? `<dt>العمق</dt><dd>${esc(sp.depth.join("، "))}</dd>` : ""}
      ${sp.climate ? `<dt>المناخ</dt><dd>${esc(sp.climate)}</dd>` : ""}
      ${sp.region ? `<dt>الانتشار</dt><dd>${esc(sp.region)}، ومنها سواحل بحر العرب في عُمان</dd>` : ""}
      <dt>الرتبة</dt><dd><span class="sci">${esc(sp.order)}</span></dd>
    </dl>
    <details class="more"><summary>التوزيع الجغرافي كما في الأطلس (بالإنجليزية)</summary><p class="dist">${esc(sp.dist)}</p></details>
    <details class="more"><summary>النص الأصلي للحجم والبيئة</summary><p class="dist">${esc(sp.sizeRaw)}<br>${esc(sp.envRaw)}<br>${esc(sp.climateRaw)}</p></details>
    <p class="src">الأطلس الميداني لأسماك سواحل بحر العرب في سلطنة عُمان، صفحة ${sp.pages.map(nf).join(" و")}.</p>`;
  const y = $("#yes"); if (y) y.onclick = () => saveCatch(sp, r);
}

async function saveCatch(sp, r) {
  try {
    const thumb = await (await fetch(r.photo)).blob();
    await DB.add({ id: Date.now(), ts: Date.now(), sid: sp.id, thumb, emb: Array.from(r.emb) });
    await loadLearned();
    toast("حُفظت في سجلّك. سيتعرّف التطبيق على هذا النوع أسرع في المرة القادمة");
    location.hash = "#/log";
  } catch (e) { toast("تعذّر الحفظ: " + e.message); }
}

/* ---------- identify flow ---------- */
async function startIdentify(file, manualBox) {
  S.busy = true; S.result = null;
  if (location.hash !== "#/result") location.hash = "#/result";
  const url = URL.createObjectURL(file);
  view.innerHTML = `<div class="analyzing"><img src="${url}" alt=""><div class="spin"></div>
    <ul class="steps"><li id="st1" class="on">فتح الصورة</li><li id="st2">تحديد مكان السمكة</li><li id="st3">المقارنة مع صور الأطلس</li></ul></div>`;
  const mark = (n) => { for (let i = 1; i <= 3; i++) { const el = $("#st" + i); if (el) el.className = i < n + 1 ? "ok" : i === n + 1 ? "on" : ""; } };
  try {
    if (!navigator.onLine && !(await packCheck())) {
      const cached = await caches.open(ASSET_CACHE).then((c) => c.match(S.meta.model.parts[0])).catch(() => null);
      if (!cached) throw new Error("NOPACK");
    }
    const r = await identify(file, manualBox, mark);
    URL.revokeObjectURL(url);
    S.busy = false; S.result = r;
    if (location.hash.startsWith("#/result")) renderResult();
  } catch (e) {
    S.busy = false;
    console.error(e);
    view.innerHTML = e.message === "NOPACK"
      ? `<div class="empty"><p>بيانات التعرّف لم تُنزَّل بعد على هذا الجهاز.</p><p>اتصل بالإنترنت مرة واحدة واضغط «تنزيل» في الصفحة الرئيسية، وبعدها يعمل التطبيق في البحر بدون إنترنت.</p><a class="btn pri" href="#/">الصفحة الرئيسية</a></div>`
      : `<div class="empty"><p>تعذّر تحليل الصورة.</p><p class="sub en">${esc(e.message)}</p><a class="btn" href="#/">رجوع</a></div>`;
  }
}

// when the top candidates agree on a family, say so: the family is often clear even when the species is not
function famHint(ranked, top) {
  const share = new Map();
  for (const c of ranked) { const f = S.species[c.s].family; share.set(f, (share.get(f) || 0) + c.p); }
  const [fam, p] = [...share.entries()].sort((a, b) => b[1] - a[1])[0];
  if (p < 0.6) return "";
  const f = S.species.find((x) => x.family === fam);
  return `<p class="sub" style="margin:8px 0 0">من فصيلة ${esc(f.familyAr || fam)} <bdi dir="ltr" class="sci">${esc(fam)}</bdi> على الأرجح.</p>`;
}

function renderResult() {
  const r = S.result; if (!r) { location.hash = "#/"; return; }
  const top = r.ranked[0]; const sp = S.species[top.s]; const lv = level(r.ranked);
  const others = r.ranked.slice(1, 8);
  view.innerHTML = `
    <div class="plate"><figure><img src="${r.photo}" alt="صورتك"><figcaption>صورتك</figcaption></figure>
      <figure>${sp.img ? `<img src="${imgUrl(sp)}" alt="">` : ""}<figcaption>الأقرب في الأطلس</figcaption></figure></div>
    <div class="verdict"><span class="lvl ${lv}">${LEVEL_TXT[lv]}</span></div>
    <a href="#/s/${sp.id}?r=1" style="color:inherit"><h1 class="hero-name">${esc(title(sp))}</h1></a>
    ${altNames(sp).length ? `<div class="hero-alt">${esc(altNames(sp).slice(0, 4).join("، "))}</div>` : ""}
    <div class="hero-sci"><bdi dir="ltr"><span class="sci">${esc(sp.sci)}</span></bdi>${sp.en ? ` <span class="sub">–</span> <bdi dir="ltr">${esc(sp.en)}</bdi>` : ""}</div>
    ${famHint(r.ranked, sp)}
    <div class="actions"><button class="btn ok" id="yes">هذه هي ✓</button><a class="btn" href="#/s/${sp.id}?r=1">التفاصيل</a></div>
    ${lv !== "hi" ? `<div class="note">${lv === "mid" ? "قارن صورتك بصورة الأطلس، وراجع الاحتمالات الأخرى في الأسفل قبل أن تعتمد الاسم." : "الصورة لا تطابق نوعاً واحداً بوضوح. جرّب صورة جانبية للسمكة كاملة، أو اضبط الإطار حول السمكة."}</div>` : ""}
    <h2 class="mark">احتمالات أخرى</h2>
    <ul class="list cands">${others.map((o) => { const s = S.species[o.s]; const w = Math.max(4, Math.round((o.score - r.ranked[7].score) / Math.max(1e-6, top.score - r.ranked[7].score) * 100)); return spRow(s, `<span class="meter"><i><b style="width:${w}%"></b></i></span>`).replace(`href="#/s/${s.id}"`, `href="#/s/${s.id}?r=1"`); }).join("")}</ul>
    <div class="actions"><button class="btn" id="recrop">ضبط الإطار</button><button class="btn" id="again">صورة أخرى</button></div>
    <p class="src">ليست في القائمة؟ <a href="#/browse">ابحث بالاسم أو تصفّح الأنواع</a>.</p>`;
  $("#yes").onclick = () => saveCatch(sp, r);
  $("#again").onclick = () => $("#camInput").click();
  $("#recrop").onclick = () => cropUI();
}

function cropUI() {
  const r = S.result; if (!r) return;
  const W = r.base.width, H = r.base.height;
  const b0 = r.box || { x: W * 0.05, y: H * 0.05, w: W * 0.9, h: H * 0.9 };
  view.innerHTML = `<h2 class="mark" style="margin-top:0">حرّك الزوايا حول السمكة</h2>
    <div class="cropwrap" id="cw"><img src="${r.full}" alt=""><div class="cropbox" id="cb"><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i></div></div>
    <div class="actions"><button class="btn pri" id="go">أعد التعرّف</button><button class="btn" id="cancel">إلغاء</button></div>`;
  const cw = $("#cw"), cb = $("#cb");
  let b = { ...b0 };
  const place = () => { const k = cw.clientWidth / W; Object.assign(cb.style, { left: b.x * k + "px", top: b.y * k + "px", width: b.w * k + "px", height: b.h * k + "px" }); };
  const img = $("img", cw); img.onload = place; place();
  let drag = null;
  cw.addEventListener("pointerdown", (e) => {
    const h = e.target.dataset && e.target.dataset.h; const k = cw.clientWidth / W;
    drag = { h: h || (e.target === cb ? "move" : null), x: e.clientX, y: e.clientY, b: { ...b }, k };
    if (!drag.h) drag = null; else cw.setPointerCapture(e.pointerId);
  });
  cw.addEventListener("pointermove", (e) => {
    if (!drag) return; const dx = (e.clientX - drag.x) / drag.k, dy = (e.clientY - drag.y) / drag.k; const o = drag.b; const min = 40;
    let { x, y, w, h } = o;
    if (drag.h === "move") { x = Math.min(Math.max(0, o.x + dx), W - o.w); y = Math.min(Math.max(0, o.y + dy), H - o.h); }
    else {
      if (drag.h.includes("w")) { x = Math.min(Math.max(0, o.x + dx), o.x + o.w - min); w = o.x + o.w - x; }
      if (drag.h.includes("e")) { w = Math.min(Math.max(min, o.w + dx), W - o.x); }
      if (drag.h.includes("n")) { y = Math.min(Math.max(0, o.y + dy), o.y + o.h - min); h = o.y + o.h - y; }
      if (drag.h.includes("s")) { h = Math.min(Math.max(min, o.h + dy), H - o.y); }
    }
    b = { x, y, w, h }; place();
  });
  const end = () => (drag = null); cw.addEventListener("pointerup", end); cw.addEventListener("pointercancel", end);
  $("#cancel").onclick = () => renderResult();
  $("#go").onclick = () => startIdentify(r.file, b);
}

async function viewLog() {
  let all = [];
  try { all = (await DB.all()).sort((a, b) => b.ts - a.ts); } catch {}
  if (!all.length) {
    view.innerHTML = `<h1 class="hero-name" style="margin-top:0">سجلّي</h1><div class="empty"><p>لم تحفظ أي صيدة بعد.</p><p>بعد التعرّف على سمكة اضغط «هذه هي ✓» لتُحفظ هنا مع التاريخ، ويتعلّم التطبيق من صورتك.</p><button class="btn pri" id="go">صوّر سمكة</button></div>`;
    $("#go").onclick = () => $("#camInput").click(); return;
  }
  const df = new Intl.DateTimeFormat("ar-OM-u-nu-latn", { dateStyle: "medium", timeStyle: "short" });
  const urls = [];
  view.innerHTML = `<h1 class="hero-name" style="margin-top:0">سجلّي</h1><p class="count">${nf(all.length)} صيدة محفوظة</p>
    <ul class="list log">${all.map((c) => { const sp = S.byId.get(c.sid); const u = c.thumb ? URL.createObjectURL(c.thumb) : ""; urls.push(u);
      return `<li><a class="sp" href="#/s/${c.sid}"><span class="th" style="background-image:url('${u}')"></span><span class="tx"><span class="nm">${esc(sp ? title(sp) : c.sid)}</span><span class="sci">${esc(sp ? sp.sci : "")}</span><span class="when">${esc(df.format(new Date(c.ts)))}</span></span></a>
      <button class="linkish danger" data-del="${c.id}" style="margin:0 12px 8px">حذف</button></li>`; }).join("")}</ul>`;
  $$("[data-del]").forEach((b) => (b.onclick = async () => { await DB.del(Number(b.dataset.del)); await loadLearned(); viewLog(); }));
}

function viewAbout() {
  view.innerHTML = `<h1 class="hero-name" style="margin-top:0">عن التطبيق</h1>
    <p>كل بيانات الأسماك وصورها مأخوذة من «الأطلس الميداني لأسماك سواحل بحر العرب في سلطنة عُمان» الصادر عن وزارة الزراعة والثروة السمكية (2018)، ويضم ${nf(S.species.length)} نوعاً.</p>
    <p>عند تصوير سمكة يحدد التطبيق مكانها في الصورة، ثم يقارن شكلها وألوانها بصور الأطلس داخل الهاتف نفسه، بدون إنترنت ودون إرسال صورتك لأي جهة.</p>
    <p>النتيجة اقتراح يساعدك، لذلك يعرض صورتك بجانب صورة الأطلس وأقرب الاحتمالات الأخرى. الأنواع المتقاربة جداً (مثل بعض أنواع الهامور والشعري) قد تحتاج تأكيداً بالعين.</p>
    <p>كلما حفظت صيدة بالضغط على «هذه هي ✓» أضاف التطبيق صورتك كمرجع إضافي لذلك النوع على هاتفك.</p>
    <p class="src">الإصدار ${esc(VER)}</p>`;
}

/* ---------- router ---------- */
function setTab(t) { $$(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === t)); }
function route() {
  const h = location.hash || "#/";
  const [path, qs] = h.slice(1).split("?"); const params = new URLSearchParams(qs || "");
  const parts = path.split("/").filter(Boolean);
  const root = !parts.length || ["browse", "log"].includes(parts[0]) && parts.length === 1;
  $("#backBtn").hidden = root;
  window.scrollTo(0, 0);
  if (!parts.length) { setTab("home"); return viewHome(); }
  switch (parts[0]) {
    case "browse": setTab("browse"); return viewBrowse(params.get("q") || "");
    case "g": setTab("browse"); return viewGroup(parts[1]);
    case "s": setTab(params.get("r") ? "home" : "browse"); return viewSpecies(parts[1], !!params.get("r"));
    case "result": setTab("home"); if (S.busy) return; if (S.result) return renderResult(); location.replace("#/"); return;
    case "log": setTab("log"); return viewLog();
    case "about": setTab("home"); return viewAbout();
    default: location.hash = "#/";
  }
}

function netBadge() {
  const n = $("#netState"); n.hidden = false;
  n.classList.toggle("off", !navigator.onLine);
  n.textContent = navigator.onLine ? "متصل" : "بدون إنترنت";
}

async function main() {
  $("#backBtn").onclick = () => (history.length > 1 ? history.back() : (location.hash = "#/"));
  for (const id of ["camInput", "libInput"]) {
    $("#" + id).addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) startIdentify(f); });
  }
  addEventListener("online", netBadge); addEventListener("offline", netBadge); netBadge();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  view.innerHTML = `<div class="analyzing"><div class="spin"></div></div>`;
  try { await loadData(); }
  catch (e) { view.innerHTML = `<div class="empty"><p>تعذّر تحميل البيانات.</p><p class="sub">افتح التطبيق مرة واحدة وأنت متصل بالإنترنت.</p></div>`; return; }
  S.pack.done = await packCheck();
  await loadLearned();
  addEventListener("hashchange", route);
  route();
  // warm the model in the background once the pack is on the device
  if (S.pack.done) setTimeout(() => mlInit().catch(() => {}), 1500);
}
main();
