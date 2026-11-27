// Algemene versie voor andere streamingdiensten (Disney+, Videoland, NPO, ...).
// Staat los van content.js (Netflix) zodat de Netflix-versie ongemoeid blijft.
(() => {
"use strict";
const SITE = (globalThis.IMDbSites || []).find((s) => s.hosts.some((h) => location.hostname === h || location.hostname.endsWith("." + h)));
if (!SITE) return;
const UI = globalThis.IMDbUI;
const DEF = { showMeta: true, showRT: true, showVotes: false, showCard: true, showCards: true, showHover: true, showMain: true, language: "en", size: "m", style: "badge", playbackMode: "tiny", debug: false, trailerEnabled: false };
let S = { ...DEF };
const hooks = { onOptions: () => chrome.runtime.sendMessage({ type: "options" }).catch(() => {}) };


chrome.storage.sync.get(Object.keys(DEF)).then((d) => { S = { ...DEF, ...d }; resetAll(); });
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "sync") return;
  for (const k in c) if (k in DEF) S[k] = c[k].newValue ?? DEF[k];
  if (c.apiKey) cache.clear();
  resetAll();
});
function resetAll() {
  hideCard();
  document.querySelectorAll(".imdb-badge").forEach((b) => b.remove());
  document.querySelectorAll("[data-imdb-host], [data-imdb-pending], [data-imdb-no]").forEach((e) => {
    delete e.dataset.imdbHost; delete e.dataset.imdbPending; delete e.dataset.imdbNo;
    e.classList.remove("imdb-host-mini");
  });
  resCache.clear(); resPending.clear(); pageState = {};
  scan();
}
// ---------- rating opvragen (fouten worden niet onthouden) ----------
const cache = new Map();
function ask(title, year, mediaType, strict) {
  const k = title.toLowerCase() + "|" + (year || "") + "|" + (mediaType || "") + "|" + (strict ? "s" : "");
  if (!cache.has(k)) {
    cache.set(k, (async () => {
      let timer;
      try {
        const response = await Promise.race([
          chrome.runtime.sendMessage({ type: "rating", title, year, mediaType, strict }),
          new Promise((resolve) => { timer = setTimeout(() => resolve({ error: "fetch" }), 22000); })
        ]);
        const r = response || { error: "fetch" };
        if (r.error === "fetch" || r.error === "ctx") cache.delete(k);
        return r;
      } catch {
        cache.delete(k);
        return { error: "ctx" };
      } finally { clearTimeout(timer); }
    })());
  }
  return cache.get(k);
}


// =====================================================================
//  Algemene herkenning voor streamingdiensten (zonder inlog te testen)
// =====================================================================
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clean = (t) => (t || "").replace(/[\u2066-\u2069\u200e\u200f]/g, "").replace(/\s+/g, " ").trim();
const normT = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const GENERIC = /^(home|start|startpagina|films?|movies?|series?|shows?|tv shows?|zoeken|search|mijn lijst|my list|watchlist|ontdek|discover|browse|kinderen|kids|sport|live|nieuw|new|trending|populair|popular|play|afspelen|meer info|more info|details|episodes|afleveringen)$/i;
const NAME_RES = SITE.names.map((n) => esc(n));

function cleanTitle(t) {
  t = clean(t);
  if (!t) return null;
  for (const n of NAME_RES) {
    t = t.replace(new RegExp("\\s*[|·•–—-]\\s*" + n + "\\b.*$", "i"), "")
         .replace(new RegExp("\\s+(?:op|on|bij|via|at)\\s+" + n + "\\b.*$", "i"), "");
  }
  t = t.split("|")[0]
    .replace(/^(watch|kijk naar|kijk|bekijk|stream|streaming|now streaming|nu streamen)\s+/i, "")
    .replace(/\s+(online|streamen|kijken|bekijken|watch online|streaming)\s*$/i, "")
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/, "")
    .trim();
  if (!t || t.length > 120 || t.length < 2 || GENERIC.test(t)) return null;
  if (SITE.names.some((n) => n.toLowerCase() === t.toLowerCase())) return null;
  return t;
}
const yearInTitle = (t) => { const m = clean(t).match(/\(((?:19|20)\d{2})\)\s*$/); return m ? +m[1] : null; };
const inView = (r) => r.right > -300 && r.left < innerWidth + 300 && r.bottom > -300 && r.top < innerHeight + 300;
const visible = (el) => !!el && el.getClientRects().length > 0;

function typeFromHref(href) {
  const p = String(href || "");
  const mv = /(\/|-)(movie|movies|film|films)(\/|-|$)/i.test(p);
  const sr = /(\/|-)(series|serie|show|shows|programma|programmas|tv-show)(\/|-|$)/i.test(p);
  return mv && !sr ? "movie" : sr && !mv ? "series" : null;
}

// ---------- lookup ----------
const resCache = new Map();
const resPending = new Map();
async function lookup(req) {
  if (resCache.has(req.key)) return resCache.get(req.key);
  if (resPending.has(req.key)) return resPending.get(req.key);
  const p = (async () => {
    const failed = [];
    for (const title of req.titles) {
      const result = await ask(title, req.year, req.mediaType, req.strict);
      if (result.error) return result;
      const rating = Number(result.rating);
      if (result.verified === true && Number.isFinite(rating) && rating >= 0 && rating <= 10 && /^tt\d{5,}$/.test(result.id || "")) return result;
      failed.push("kandidaat: " + title);
      if (result.dbg && Array.isArray(result.dbg.steps)) failed.push(...result.dbg.steps);
    }
    return { rating: null, dbg: { q: req.titles[0] || "(geen titel)", y: req.year || null, steps: ["site: " + SITE.id, "type: " + (req.mediaType || "onbekend"), ...failed] } };
  })().then((r) => { if (!r || !["fetch", "ctx"].includes(r.error)) resCache.set(req.key, r); return r; })
    .finally(() => resPending.delete(req.key));
  resPending.set(req.key, p);
  return p;
}

function loadingBadge(size, extra) {
  const b = UI.makeBadge({ loading: true }, { ...S, size: size || S.size }, hooks);
  if (extra) b.classList.add(extra);
  return b;
}

// ---------- titelpagina ----------
const BAD_ZONE = "nav, header, footer, [role='navigation'], [role='contentinfo'], [data-imdb-host]";

function visibleTitleTexts() {
  const out = [];
  document.querySelectorAll("h1").forEach((h) => {
    if (!visible(h) || h.closest(BAD_ZONE.replace("header, ", ""))) return;
    out.push(h.textContent);
    const img = h.querySelector("img[alt]");
    if (img) out.push(img.getAttribute("alt"));
  });
  out.push(document.title);
  return out.map(clean).filter(Boolean);
}

// Gestructureerde data (JSON-LD / og:type) in single-page apps kan verouderd zijn na navigatie.
// Daarom telt hij alleen mee als de naam ook in de zichtbare titel (h1 / tabtitel) voorkomt.
function structuredInfo(visibleKeys) {
  const found = [];
  const visit = (n) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (typeof n !== "object") return;
    const types = [].concat(n["@type"] || []).map(String);
    const isS = types.some((x) => /^(TVSeries|TVMiniSeries|CreativeWorkSeries)$/i.test(x));
    const isM = types.some((x) => /^Movie$/i.test(x));
    const isE = types.some((x) => /^(TVEpisode|Episode)$/i.test(x));
    if (isS || isM) {
      const name = cleanTitle(n.name || n.headline);
      const y = String(n.datePublished || n.dateCreated || n.startDate || "").match(/\d{4}/);
      if (name) found.push({ title: name, year: y ? +y[0] : null, mediaType: isS ? "series" : "movie" });
    } else if (isE && n.partOfSeries) {
      const name = cleanTitle(n.partOfSeries.name);
      if (name) found.push({ title: name, year: null, mediaType: "series" });
    }
    for (const [k, v] of Object.entries(n)) if (k !== "@context" && v && typeof v === "object") visit(v);
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { visit(JSON.parse(s.textContent)); } catch {} });
  return found.filter((f) => {
    const k = normT(f.title);
    return k.length >= 2 && visibleKeys.some((v) => v.includes(k));
  });
}

function leafMeta() {
  let year = null, mediaType = null;
  const base = scrollY;
  for (const e of document.querySelectorAll("main span, main div, main li, main p, span, li, p")) {
    if (e.childElementCount > 0 || e.closest(BAD_ZONE)) continue;
    const t = clean(e.textContent);
    if (!t || t.length > 60) continue;
    if (!visible(e) || e.getBoundingClientRect().top + base > 1800) continue;
    if (!year && !/©|copyright/i.test(t)) {
      const m = t.match(/(?:^|[\s•·|,(])((?:19|20)\d{2})(?:$|[\s•·|,)])/);
      if (m) year = +m[1];
    }
    if (!mediaType && t.length <= 25) {
      if (/^(films?|movies?)$/i.test(t) || /^\d+\s?(h|u|uur)(\s?\d+\s?(m|min))?$/i.test(t) || /^\d+\s?min$/i.test(t)) mediaType = "movie";
      else if (/^(serie|series|show|tv series|tv-serie)$/i.test(t) || /^\d+\s?(seasons?|seizoenen|seizoen|parts?|delen)$/i.test(t)) mediaType = "series";
    }
    if (year && mediaType) break;
  }
  return { year, mediaType };
}

function pageInfo() {
  const visTexts = visibleTitleTexts();
  const visKeys = visTexts.map(normT);
  const st = structuredInfo(visKeys);
  const titles = [];
  const add = (v) => { const t = cleanTitle(v); if (t && !titles.some((x) => x.toLowerCase() === t.toLowerCase())) titles.push(t); };
  st.forEach((s) => add(s.title));
  visTexts.forEach(add);
  const meta = leafMeta();
  const ogType = (document.querySelector('meta[property="og:type"]') || {}).content || "";
  const ogMedia = /movie/i.test(ogType) ? "movie" : /tv_show|series/i.test(ogType) ? "series" : null;
  return {
    titles,
    year: (st[0] && st[0].year) || meta.year || null,
    mediaType: (st[0] && st[0].mediaType) || meta.mediaType || typeFromHref(location.pathname) || (st.length ? ogMedia : null),
    structured: st.length > 0
  };
}

const PLAY_RE = /^(play|afspelen|speel af|speel|kijk|bekijk|watch|stream|resume|hervat|continue|ga door|start|nu kijken|watch now)/i;
function findPlay() {
  const nodes = document.querySelectorAll('button, a[href], [role="button"]');
  for (const el of nodes) {
    if (!visible(el) || el.closest(".imdb-badge") || el.closest("[data-imdb-host], nav, header, footer")) continue;
    const label = clean(el.getAttribute("aria-label") || el.textContent);
    if (!label || label.length > 40 || /trailer/i.test(label) || !PLAY_RE.test(label)) continue;
    const r = el.getBoundingClientRect();
    if (r.top > innerHeight * 1.5 || r.bottom < 0) continue;
    return el;
  }
  return null;
}

let pageState = {};
function placePage(badge) {
  const play = findPlay();
  if (play && play.parentElement && play.parentElement.children.length >= 2) {
    badge.classList.add("imdb-inline");
    play.parentElement.appendChild(badge);
    return true;
  }
  const h1 = [...document.querySelectorAll("h1")].find((h) => visible(h) && !h.closest(BAD_ZONE.replace("header, ", "")));
  if (h1) { badge.classList.add("imdb-main-inline"); h1.insertAdjacentElement("afterend", badge); return true; }
  return false;
}
const PAGE_SIZE = { s: "m", m: "l", l: "xl" };

function mountPage(key, res) {
  document.querySelectorAll('.imdb-badge[data-surface="page"]').forEach((b) => b.remove());
  const badge = build(res, PAGE_SIZE[S.size] || "l") || buildDebugBadge(res, PAGE_SIZE[S.size] || "l");
  if (!badge) { pageState.no = true; return; }
  badge.dataset.surface = "page";
  badge.dataset.key = key;
  if (!placePage(badge)) badge.remove();
}

function updatePage() {
  const old = [...document.querySelectorAll('.imdb-badge[data-surface="page"]')];
  const info = pageInfo();
  const detail = SITE.detail.test(location.pathname) || info.structured;
  if (!S.showMain || !detail || !info.titles.length) { old.forEach((b) => b.remove()); return; }

  const key = ["p", location.pathname, info.titles[0], info.year || "", info.mediaType || ""].join("|");
  if (pageState.key !== key) { old.forEach((b) => b.remove()); pageState = { key, seenAt: Date.now() }; }
  if (old.length > 1) old.slice(1).forEach((b) => b.remove());
  if (old[0] && old[0].dataset.key === key && old[0].isConnected) return;
  if (pageState.no || pageState.pending) return;
  if (resCache.has(key)) { mountPage(key, resCache.get(key)); return; }
  if (Date.now() - pageState.seenAt < 600) { setTimeout(queueScan, 650); return; }

  pageState.pending = true;
  const lb = loadingBadge(PAGE_SIZE[S.size] || "l");
  lb.dataset.surface = "page"; lb.dataset.key = key;
  if (!placePage(lb)) lb.remove();
  lookup({ key, titles: info.titles, year: info.year, mediaType: info.mediaType, strict: !info.year })
    .then((res) => {
      pageState.pending = false;
      if (pageState.key !== key) return;
      saveNetflixDiagnostic(key, res);
      mountPage(key, res);
    }).catch(() => { pageState.pending = false; pageState.no = true; document.querySelectorAll('.imdb-badge[data-surface="page"]').forEach((b) => b.remove()); });
}

// ---------- kaartjes in rijen ----------
const POSTER = 'img, video, picture, [style*="background-image"]';
function cardHost(a) {
  const href = a.getAttribute("href");
  const sameOnly = (node) => {
    const hs = new Set([...node.querySelectorAll(SITE.card)].map((l) => l.getAttribute("href")));
    if (node.matches && node.matches(SITE.card)) hs.add(node.getAttribute("href"));
    return hs.size === 1 && hs.has(href);
  };
  const okSize = (node) => {
    const r = node.getBoundingClientRect();
    return r.width >= 64 && r.width <= 420 && r.height >= r.width * 0.38 && r.height <= r.width * 2.4;
  };
  const good = [];
  for (let n = a, depth = 0; n && depth < 6; n = n.parentElement, depth++) {
    if (n === document.body || n.getBoundingClientRect().width > 420) break;
    if (okSize(n) && (n.matches(POSTER) || n.querySelector(POSTER)) && sameOnly(n)) good.push(n);
  }
  if (!good.length) return null;
  // liever een niet-<a>-element als houder (geen link in een link)
  return good.find((n) => n.tagName !== "A") || good[0];
}

function cardTitles(a, host) {
  const out = [];
  const add = (v) => { const t = cleanTitle(v); if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t); };
  add(a.getAttribute("aria-label")); add(a.getAttribute("title"));
  const img = host.querySelector("img[alt]"); if (img) add(img.getAttribute("alt"));
  const tn = host.querySelector('[class*="title" i], [data-testid*="title" i]');
  if (tn && clean(tn.textContent).length < 80) add(tn.textContent);
  if (clean(a.textContent).length < 80) add(a.textContent);
  return out;
}

function renderCard(host, a) {
  const href = a.getAttribute("href");
  const titles = cardTitles(a, host);
  if (!titles.length) return;
  const mediaType = typeFromHref(href);
  const year = yearInTitle(a.getAttribute("aria-label") || "") || yearInTitle((host.querySelector("img[alt]") || {}).alt || "");
  const key = ["c", normT(titles[0]), year || "", mediaType || ""].join("|");

  if (host.dataset.imdbHost && host.dataset.imdbHost !== key) {
    host.querySelectorAll(':scope > .imdb-badge[data-surface="card"]').forEach((b) => b.remove());
    delete host.dataset.imdbPending; delete host.dataset.imdbNo;
  }
  if (host.dataset.imdbHost === key && (host.querySelector(':scope > .imdb-badge[data-surface="card"]') ||
      host.dataset.imdbPending === key || host.dataset.imdbNo === key)) return;

  host.dataset.imdbHost = key;
  host.dataset.imdbPending = key;
  delete host.dataset.imdbNo;
  host.classList.toggle("imdb-host-mini", host.getBoundingClientRect().width < 140);
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const lb = loadingBadge(null, "imdb-card-badge");
  lb.dataset.surface = "card"; lb.dataset.key = key;
  host.appendChild(lb);

  lookup({ key, titles, year, mediaType, strict: true }).then((res) => {
    if (host.dataset.imdbHost !== key) return;
    delete host.dataset.imdbPending;
    host.querySelectorAll(':scope > .imdb-badge[data-surface="card"]').forEach((b) => b.remove());
    const badge = build(res, null, "imdb-card-badge") || buildDebugBadge(res, null, "imdb-card-badge");
    if (!badge) { host.dataset.imdbNo = key; return; }
    badge.dataset.surface = "card"; badge.dataset.key = key;
    host.appendChild(badge);
  }).catch(() => {
    if (host.dataset.imdbHost === key) {
      delete host.dataset.imdbPending; host.dataset.imdbNo = key;
      host.querySelectorAll(':scope > .imdb-badge[data-surface="card"]').forEach((b) => b.remove());
    }
  });
}

function scanCards() {
  if (!S.showCards) return;
  document.querySelectorAll(SITE.card).forEach((a) => {
    if (a.closest(".imdb-badge") || !inView(a.getBoundingClientRect())) return;
    const host = cardHost(a);
    if (!host) return;
    const outer = host.parentElement && host.parentElement.closest("[data-imdb-host]");
    if (outer && outer !== host) return;
    if (host.querySelector("[data-imdb-host]")) return;
    renderCard(host, a);
  });
}

function scan() {
  try { updatePage(); } catch (e) { console.debug("[imdb] page", e); }
  try { scanCards(); } catch (e) { console.debug("[imdb] cards", e); }
}
let scanTimer;
function queueScan() { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 150); }
document.addEventListener("scroll", queueScan, true);
window.addEventListener("resize", queueScan, { passive: true });
// ---------- hover-infokaart ----------
let card = null;
let cardBadge = null;
let cardHideTimer = null;

function cancelCardHide() {
  if (cardHideTimer) clearTimeout(cardHideTimer);
  cardHideTimer = null;
}
function hideCard() {
  cancelCardHide();
  if (card) card.remove();
  card = null;
  cardBadge = null;
}
function scheduleHideCard() {
  cancelCardHide();
  cardHideTimer = setTimeout(() => {
    const badgeHovered = cardBadge && cardBadge.matches(":hover");
    const cardHovered = card && card.matches(":hover");
    if (!badgeHovered && !cardHovered) hideCard();
  }, 450);
}
function showCard(badge, res) {
  if (!S.showCard || !isVerifiedRating(res)) return;
  cancelCardHide();
  if (card && card.isConnected && cardBadge === badge) return;
  hideCard();
  card = UI.buildCard(res, S.language);
  cardBadge = badge;
  document.body.appendChild(card);
  card.addEventListener("mouseenter", cancelCardHide);
  card.addEventListener("mouseleave", scheduleHideCard);
  if (S.trailerEnabled && res.id) {
    const currentCard = card;
    chrome.runtime.sendMessage({ type: "trailer", imdbId: res.id, title: res.title, year: res.year, mediaType: res.type === "series" ? "series" : "movie" })
      .then(trailer => {
        if (trailer && card === currentCard && currentCard.isConnected) UI.addTrailer(currentCard, trailer, S.language);
      }).catch(() => {});
  }

  const r = badge.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  const left = Math.max(10, Math.min(r.left, window.innerWidth - w - 10));
  let top = r.bottom;
  if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h);
  card.style.left = left + "px";
  card.style.top = top + "px";
}
window.addEventListener("scroll", hideCard, { passive: true });

function isVerifiedRating(res) {
  const rating = Number(res && res.rating);
  return !!(res && res.verified === true && Number.isFinite(rating) && rating >= 0 && rating <= 10 && /^tt\d{5,}$/.test(res.id || ""));
}

function saveNetflixDiagnostic(id, res) {
  const verified = isVerifiedRating(res);
  const detail = res && res.dbg || {};
  const snapshot = {
    time: Date.now(),
    netflixId: id,
    title: verified ? res.title : (detail.q || null),
    year: verified ? (res.year || detail.y || null) : (detail.y || null),
    imdbId: verified ? res.id : null,
    rating: verified ? Number(res.rating) : null,
    error: res && res.error || null,
    steps: verified
      ? ["Bevestigde IMDb-match: " + res.title, "IMDb-ID: " + res.id, "Score: " + res.rating]
      : (Array.isArray(detail.steps) ? detail.steps : [])
  };
  chrome.storage.local.set({ lastNetflixDebug: snapshot }).catch(() => {});
}

function build(res, size, extra) {
  if (!isVerifiedRating(res)) return null;
  const displayRes = { ...res, dbg: S.debug ? res.dbg : null };
  const b = UI.makeBadge(displayRes, { ...S, size: size || S.size }, hooks);
  if (extra) b.classList.add(extra);
  if (S.showCard) {
    b.addEventListener("mouseenter", () => showCard(b, res));
    b.addEventListener("mouseleave", scheduleHideCard);
  }
  return b;
}
function buildDebugBadge(res, size, extra) {
  if (!S.debug) return null;
  const debugResult = { ...(res || {}), rating: null, rt: null, metascore: null, verified: false };
  const b = UI.makeBadge(debugResult, { ...S, size: size || S.size }, hooks);
  b.classList.add("imdb-debug");
  if (extra) b.classList.add(extra);
  return b;
}

// Alleen een badge plaatsen wanneer een score echt aan een IMDb-ID is bevestigd.
// Geen laad-balkjes of "geen score"-labels over de hele Netflix-pagina.

let mutTimer;
new MutationObserver(() => { clearTimeout(mutTimer); mutTimer = setTimeout(scan, 300); })
  .observe(document.body, { childList: true, subtree: true });
setInterval(scan, 2000);
scan();
})();
