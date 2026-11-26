const UI = globalThis.IMDbUI;
const DEF = { showMeta: true, showRT: true, showVotes: false, showCard: true, size: "m", debug: false };
let S = { ...DEF };
const hooks = { onOptions: () => chrome.runtime.sendMessage({ type: "options" }).catch(() => {}) };

// ---------- instellingen ----------
chrome.storage.sync.get(Object.keys(DEF)).then((d) => { S = { ...DEF, ...d }; resetAll(); });
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "sync") return;
  for (const k in c) if (k in DEF) S[k] = c[k].newValue ?? DEF[k];
  resetAll();
});
function resetAll() {
  hideCard();
  document.querySelectorAll(".imdb-badge").forEach((b) => b.remove());
  document.querySelectorAll("[data-imdb-id], [data-imdb-fail]").forEach((e) => { delete e.dataset.imdbId; delete e.dataset.imdbFail; });
  resById.clear();
  scan();
}

// ---------- rating opvragen (fouten worden niet onthouden) ----------
const cache = new Map();
function ask(title, year) {
  const k = title.toLowerCase() + "|" + (year || "");
  if (!cache.has(k)) {
    cache.set(k, chrome.runtime.sendMessage({ type: "rating", title, year })
      .catch(() => ({ error: "ctx" }))
      .then((r) => { r = r || { error: "fetch" }; if (r.error) cache.delete(k); return r; }));
  }
  return cache.get(k);
}

// ---------- Netflix-id -> titel + jaar ----------
// Kaartjes dragen geen betrouwbare titel (aria-label/alt zijn vaak leeg of vertaald),
// maar altijd wel een id in de link. Via de titelpagina halen we naam én jaar op.
const GENERIC = /^(netflix|home|browse|play|afspelen|speel af|more info|meer info|info|my list|mijn lijst|series|films|movies|tv shows|zoeken|search|new & popular|nieuw en populair)$/i;
function cleanTitle(t) {
  t = (t || "").split("|")[0]
    .replace(/\s+[-–—]\s*Netflix.*$/i, "")
    .replace(/^(Watch|Kijk naar|Kijk|Bekijk)\s+/i, "")
    .trim();
  return !t || GENERIC.test(t) ? null : t;
}
const idOf = (href) => ((href || "").match(/\/(?:watch|title)\/(\d{5,})/) || [])[1] || null;

let nfActive = 0; const nfQueue = [];
function nfLimit(fn) {
  return new Promise((res) => {
    nfQueue.push(() => fn().then(res, () => res(null)).finally(() => { nfActive--; nfPump(); }));
    nfPump();
  });
}
function nfPump() { while (nfActive < 3 && nfQueue.length) { nfActive++; nfQueue.shift()(); } }

const nfWhy = new Map();   // id -> reden waarom de Netflix-titelpagina niets opleverde
async function netflixInfo(id) {
  let r;
  try { r = await fetch("/title/" + id, { credentials: "include" }); }
  catch (e) { nfWhy.set(id, "fetch-fout: " + e.message); return null; }
  if (!r.ok) { nfWhy.set(id, "titelpagina status " + r.status); return null; }
  const html = await r.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  let t = null, ly = null;
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j0 = JSON.parse(s.textContent), j = Array.isArray(j0) ? j0[0] : j0;
      if (j && j.name) {
        t = j.name;
        ly = String(j.datePublished || j.dateCreated || j.copyrightYear || "").slice(0, 4) || null;
        break;
      }
    } catch {}
  }
  t = cleanTitle(t || doc.querySelector('meta[property="og:title"]')?.content || doc.title);
  if (!t) { nfWhy.set(id, "geen titel in pagina (titel: " + (doc.title || "leeg") + ")"); return null; }
  const y = ly || (html.match(/"releaseYear"\s*:\s*(\d{4})/) || [])[1];
  return { title: t, year: y ? +y : null };
}

const idCache = new Map();
function infoFromId(id) {
  if (!idCache.has(id)) {
    idCache.set(id, (async () => {
      const k = "n1:" + id;
      try {
        const st = (await chrome.storage.local.get([k]))[k];
        if (st && Date.now() - st.t < 30 * 864e5) return st.v;
      } catch {}
      const v = await nfLimit(() => netflixInfo(id));
      if (v) { try { chrome.storage.local.set({ [k]: { t: Date.now(), v } }); } catch {} }
      else idCache.delete(id);
      return v;
    })());
  }
  return idCache.get(id);
}

// Titels uit de zichtbare pagina zelf (logo-alt, kaart-label, fallback-tekst): vangnet als de titelpagina niets geeft
function domTitles(host) {
  const out = [];
  const add = (t) => { t = cleanTitle(t); if (t && t.length < 90 && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t); };
  if (!host) return out;
  add(host.getAttribute && host.getAttribute("aria-label"));
  host.querySelectorAll('img[alt], .fallback-text, [data-uia*="title"]').forEach((e) => add(e.alt || e.textContent));
  return out;
}

const resById = new Map();   // id -> gevonden resultaat (hergebruik overal)
async function lookup(id, host, extra) {
  if (resById.has(id)) return resById.get(id);
  const r = await lookup1(id, host, extra);
  if (r && r.rating != null) resById.set(id, r);
  return r;
}
async function lookup1(id, host, extra) {
  const info = await infoFromId(id);
  const yr = info && info.year;
  const cands = [];
  const push = (t, src, y) => { if (t && !cands.some((c) => c.t.toLowerCase() === t.toLowerCase())) cands.push({ t, src, y }); };
  if (info && info.title) push(info.title, "netflix-pagina", yr);
  domTitles(host).forEach((t) => push(t, "pagina-dom", yr));
  (extra || []).forEach((t) => push(cleanTitle(t), "pagina-meta", yr));

  const why = nfWhy.get(id) || "";
  if (!cands.length) return { rating: null, dbg: { q: "(geen titel gevonden)", y: null, steps: ["id " + id, "netflix: " + (why || "onbekend")] } };
  let last;
  for (const c of cands.slice(0, 3)) {
    const r = await ask(c.t, c.y);
    if (r.error || r.rating != null) return r;
    last = { ...r, dbg: { ...(r.dbg || { q: c.t, y: c.y, steps: [] }), steps: [...((r.dbg && r.dbg.steps) || []), "bron:" + c.src] } };
  }
  return last;
}

// ---------- hover-infokaart ----------
let card;
function hideCard() { if (card) { card.remove(); card = null; } }
function showCard(badge, res) {
  hideCard();
  card = UI.buildCard(res);
  document.body.appendChild(card);
  const r = badge.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  const left = Math.min(r.left, window.innerWidth - w - 10);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h - 6);
  card.style.left = Math.max(10, left) + "px";
  card.style.top = top + "px";
}
window.addEventListener("scroll", hideCard, { passive: true });

function build(res, size, extra) {
  const b = UI.makeBadge(res, { ...S, size: size || S.size }, hooks);
  if (extra) b.classList.add(extra);
  if (res && res.rating && S.showCard) {
    b.addEventListener("mouseenter", () => showCard(b, res));
    b.addEventListener("mouseleave", hideCard);
  }
  return b;
}

// Zet een badge in `host` voor Netflix-id `id`. Mislukte opzoekingen blijven stil (tenzij Foutopsporing aan staat).
function render(host, id, extra) {
  host.querySelector(":scope > .imdb-badge")?.remove();
  host.dataset.imdbId = id;
  delete host.dataset.imdbFail;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  host.appendChild(UI.makeBadge({ loading: true }, S));
  lookup(id, host).then((res) => {
    if (host.dataset.imdbId !== id) return;
    host.querySelector(":scope > .imdb-badge")?.remove();
    const useful = res && (res.rating != null || res.id || ["no-key", "bad-key", "limit"].includes(res.error));
    if (!useful && !S.debug) { host.dataset.imdbFail = id; return; }
    host.appendChild(build(res, null, extra));
  });
}
const inView = (r) => r.right > -300 && r.left < innerWidth + 300 && r.bottom > -300 && r.top < innerHeight + 300;

// ---------- badges op de kaartjes in de rijen ----------
function scanCards() {
  document.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]').forEach((a) => {
    if (a.closest("[data-imdb-hover]")) return;
    const id = idOf(a.getAttribute("href"));
    if (!id || !a.querySelector("img")) return;
    const r = a.getBoundingClientRect();
    if (r.width < 100 || r.width > 520 || r.height < r.width * 0.45 || !inView(r)) return;   // kaartje, geen hero/logo
    if (a.dataset.imdbFail === id) return;
    if (a.dataset.imdbId === id && a.querySelector(":scope > .imdb-badge")) return;
    render(a, id);
  });
}

// ---------- badge op Netflix' hover-voorbeeldkaart (Play / + / duim) ----------
const PLAY = /^(play|afspelen|speel af|resume|hervat|doorgaan|continue)/i;
function scanHover() {
  document.querySelectorAll('[data-uia*="play"], button[aria-label], a[aria-label]').forEach((el) => {
    const label = el.getAttribute("aria-label") || "";
    if (!(PLAY.test(label) || /play-button/.test(el.getAttribute("data-uia") || ""))) return;
    if (!el.offsetParent || el.closest('[role="dialog"], .previewModal--container, .detail-modal')) return;
    // klim op tot de grootste omhullende die nog bij precies één titel hoort (= de hele mini-kaart)
    let best = null, c = el.parentElement;
    for (let n = 0; c && n < 14; n++, c = c.parentElement) {
      if (c.getBoundingClientRect().width > 720) break;
      if (c.getBoundingClientRect().width >= 250 && c.querySelector("img, video")) {
        const ids = new Set([...c.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]')]
          .map((x) => idOf(x.getAttribute("href"))).filter(Boolean));
        if (ids.size > 1) break;
        best = c;
      }
    }
    if (!best || best.querySelector(".imdb-main")) return;
    const link = best.querySelector('a[href*="/watch/"], a[href*="/title/"]') || (el.matches("a[href]") ? el : null);
    const id = idOf(link && link.getAttribute("href"));
    if (!id) return;
    if (best.dataset.imdbFail === id) return;
    if (best.dataset.imdbId === id && best.querySelector(":scope > .imdb-badge")) return;
    best.dataset.imdbHover = "1";
    best.querySelectorAll("a > .imdb-badge").forEach((b) => b.remove());   // geen dubbele badge
    render(best, id, "imdb-hover");
  });
}

// ---------- grote badge op de titelpagina / modal ----------
function currentId() {
  const u = new URL(location.href);
  return u.searchParams.get("jbv") || idOf(location.pathname);
}
function place(badge) {
  // kies de grootste zichtbare Play-knop (niet zomaar de eerste in de pagina)
  const area = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight ? r.width * r.height : 0; };
  const play = [...document.querySelectorAll('[data-uia="play-button"], a[href*="/watch/"], button')]
    .filter((el) => el.offsetParent && !el.querySelector("img") && (el.textContent || "").length < 30 &&
                    /play|next episode|afspelen|volgende/i.test(el.textContent || "") && area(el) > 0)
    .sort((a, b) => area(b) - area(a))[0];
  if (play && play.parentElement) {
    badge.classList.add("imdb-inline");
    play.parentElement.appendChild(badge);
  } else {
    badge.classList.add("imdb-float");
    document.body.appendChild(badge);
  }
}
const BIGGER = { s: "m", m: "l", l: "xl" };
let pending = null;
async function updateMain() {
  const id = currentId();
  const existing = document.querySelector(".imdb-main");
  if (!id) { existing?.remove(); return; }
  if (existing && existing.dataset.id === id && existing.isConnected) return;
  existing?.remove();
  if (pending === id) return;
  pending = id;
  const meta = /^\/title\//.test(location.pathname)
    ? [document.querySelector('meta[property="og:title"]')?.content, document.title] : [];
  const res = await lookup(id, document.querySelector('[role="dialog"], .previewModal--info, .detail-modal'), meta);
  pending = null;
  if (currentId() !== id) return;
  document.querySelector(".imdb-main")?.remove();
  const badge = build(res, BIGGER[S.size] || "l");
  badge.classList.add("imdb-main");
  badge.dataset.id = id;
  place(badge);
}

function scan() { scanHover(); scanCards(); updateMain(); }

let timer;
new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 250); })
  .observe(document.body, { childList: true, subtree: true });
setInterval(scan, 1500);
scan();
