const UI = globalThis.IMDbUI;
const DEF = { showMeta: true, showRT: true, showVotes: false, showCard: true, showCards: true, showHover: true, showMain: true, language: "en", size: "m", style: "badge", playbackMode: "tiny", debug: false, trailerEnabled: false };
let S = { ...DEF };
const hooks = { onOptions: () => chrome.runtime.sendMessage({ type: "options" }).catch(() => {}) };

// ---------- instellingen ----------
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
  document.querySelectorAll("[data-imdb-id], [data-imdb-fail]").forEach((e) => { delete e.dataset.imdbId; delete e.dataset.imdbFail; });
  resById.clear();
  idCache.clear();
  pendingById.clear();
  scan();
}

// ---------- rating opvragen (fouten worden niet onthouden) ----------
const cache = new Map();
function ask(title, year, mediaType) {
  const k = title.toLowerCase() + "|" + (year || "") + "|" + (mediaType || "");
  if (!cache.has(k)) {
    cache.set(k, (async () => {
      let timer;
      try {
        const response = await Promise.race([
          chrome.runtime.sendMessage({ type: "rating", title, year, mediaType }),
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
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try { r = await fetch("/title/" + id, { credentials: "include", signal: controller.signal }); }
    finally { clearTimeout(timeout); }
  } catch (e) { nfWhy.set(id, "fetch-fout: " + e.message); return null; }
  if (!r.ok) {
    try { r = await fetch("/watch/" + id, { credentials: "include" }); }
    catch (e) { nfWhy.set(id, "titelpagina status " + r.status + "; watch-fout: " + e.message); return null; }
  }
  if (!r.ok) { nfWhy.set(id, "titelpagina/watch status " + r.status); return null; }
  let html = await r.text();
  if (!/application\/ld\+json|og:title|titleType|releaseYear/i.test(html)) {
    try {
      const alt = await fetch("/watch/" + id, { credentials: "include" });
      if (alt.ok) {
        const altHtml = await alt.text();
        if (altHtml.length > html.length) html = altHtml;
      }
    } catch {}
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  let t = null, ly = null, mediaType = null;
  const aliases = [];
  const addAlias = (v) => {
    if (typeof v === "string") {
      const x = cleanTitle(v);
      if (x && x.length < 100 && !aliases.some((a) => a.toLowerCase() === x.toLowerCase())) aliases.push(x);
    }
  };
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== "object") return;
    if (node["@graph"]) visit(node["@graph"]);
    const schemaType = [].concat(node["@type"] || []).join(" ");
    if (/TVSeries|TVMiniSeries|CreativeWorkSeries/i.test(schemaType)) mediaType = "series";
    else if (/\bMovie\b/i.test(schemaType) && !mediaType) mediaType = "movie";
    if (!t && node.name && (mediaType || /TVSeries|TVMiniSeries|Movie/i.test(schemaType))) t = node.name;
    addAlias(node.alternateName);
    addAlias(node.alternateHeadline);
    if (!ly) ly = String(node.datePublished || node.dateCreated || node.copyrightYear || "").slice(0, 4) || null;
    Object.keys(node).forEach((k) => {
      if (k !== "@context" && k !== "@graph" && node[k] && typeof node[k] === "object") visit(node[k]);
    });
  };
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent)); } catch {}
    if (t && ly) break;
  }
  t = cleanTitle(t || doc.querySelector('meta[property="og:title"]')?.content ||
    doc.querySelector('meta[name="title"]')?.content || doc.querySelector("h1")?.textContent || doc.title);
  if (!t) { nfWhy.set(id, "geen titel in pagina (titel: " + (doc.title || "leeg") + ")"); return null; }
  const ogType = doc.querySelector('meta[property="og:type"]')?.content || "";
  if (!mediaType && /tv|series|show/i.test(ogType)) mediaType = "series";
  else if (!mediaType && /movie|film/i.test(ogType)) mediaType = "movie";
  const rawType = (html.match(/"(?:titleType|videoType)"\s*:\s*"(movie|series|tvSeries|tvMiniSeries)"/i) || [])[1];
  if (!mediaType && rawType) mediaType = /series/i.test(rawType) ? "series" : "movie";
  const y = ly || (html.match(/"releaseYear"\s*:\s*(\d{4})/) || [])[1];
  return { title: t, aliases, year: y ? +y : null, mediaType };
}

const idCache = new Map();
function infoFromId(id) {
  if (!idCache.has(id)) {
    idCache.set(id, (async () => {
      const k = "n5:" + id;
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
  const add = (t) => {
    t = cleanTitle(t);
    if (t && t.length < 90 && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  if (!host) return out;
  add(host.getAttribute && host.getAttribute("aria-label"));
  for (let p=host.parentElement,n=0;p&&n<3;p=p.parentElement,n++){add(p.getAttribute&&p.getAttribute("aria-label"));add(p.getAttribute&&p.getAttribute("data-title"));add(p.getAttribute&&p.getAttribute("title"));}
  add(host.getAttribute && host.getAttribute("title"));
  add(host.getAttribute && host.getAttribute("data-title"));
  host.querySelectorAll('img[alt], .fallback-text, h1, h2, h3, [data-uia*="title"], [aria-label], [title]').forEach((e) => {
    add(e.alt || e.getAttribute("aria-label") || e.getAttribute("title") || e.textContent);
  });
  return out;
}

const resById = new Map();   // id -> herbruikbaar resultaat, ook als er geen rating is
const pendingById = new Map();

async function lookup(id, host, extra) {
  if (resById.has(id)) return resById.get(id);
  if (pendingById.has(id)) return pendingById.get(id);
  const p = lookup1(id, host, extra).then((r) => {
    if (r && !["fetch", "ctx"].includes(r.error)) resById.set(id, r);
    return r;
  }).finally(() => pendingById.delete(id));
  pendingById.set(id, p);
  return p;
}
async function lookup1(id, host, extra) {
  const info = await infoFromId(id);
  const yr = info && info.year;
  const mediaType = info && info.mediaType;
  const cands = [];
  const push = (t, src, y) => {
    t = cleanTitle(t);
    if (t && !cands.some((c) => c.t.toLowerCase() === t.toLowerCase())) cands.push({ t, src, y });
  };
  if (info && info.title) push(info.title, "netflix-pagina", yr);
  (info && info.aliases || []).forEach((t) => push(t, "alternatieve-titel", yr));
  domTitles(host).forEach((t) => push(t, "pagina-dom", yr));
  (extra || []).forEach((t) => push(t, "pagina-meta", yr));
  const why = nfWhy.get(id) || "";
  if (!cands.length) return { rating: null, dbg: { q: "(geen titel gevonden)", y: null, steps: ["id " + id, "netflix: " + (why || "onbekend")] } };
  let fallback = null;
  for (const c of cands.slice(0, 6)) {
    const r = await ask(c.t, c.y, mediaType);
    if (r.error) return r;
    if (r.rating != null) return r;
    if (r.id && !fallback) {
      fallback = { ...r, dbg: { ...(r.dbg || { q: c.t, y: c.y, steps: [] }), steps: [...((r.dbg && r.dbg.steps) || []), "bron:" + c.src] } };
    }
  }
  return fallback || { rating: null, dbg: { q: cands[0].t, y: cands[0].y, steps: ["Geen betrouwbare match gevonden", ...cands.slice(0, 6).map((c) => "titelbron:" + c.src)] } };
}

// ---------- hover-infokaart ----------
let card;
function hideCard() { if (card) { card.remove(); card = null; } }
function showCard(badge, res) {
  hideCard();
  card = UI.buildCard(res, S.language);
  document.body.appendChild(card);
  card.addEventListener("mouseleave", hideCard);
  if (S.trailerEnabled && res && res.verified && res.id) {
    const currentCard=card;
    chrome.runtime.sendMessage({type:"trailer",imdbId:res.id,title:res.title,year:res.year,mediaType:res.type==="series"?"series":"movie"})
      .then(trailer=>{if(trailer&&card===currentCard&&currentCard.isConnected)UI.addTrailer(currentCard,trailer,S.language);}).catch(()=>{});
  }
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
  const displayRes = res && !S.debug ? { ...res, dbg: null } : res;
  const b = UI.makeBadge(displayRes, { ...S, size: size || S.size }, hooks);
  if (extra) b.classList.add(extra);
  if (res && S.showCard && (res.rating != null || res.id || res.title || res.plot)) {
    b.addEventListener("mouseenter", () => showCard(b, res));
    b.addEventListener("mouseleave", e => { if (!card || !card.contains(e.relatedTarget)) hideCard(); });
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
    host.appendChild(build(res, null, extra));
  }).catch(() => {
    if (host.dataset.imdbId !== id) return;
    host.querySelector(":scope > .imdb-badge")?.remove();
    host.appendChild(build({ error: "fetch" }, null, extra));
  });
}
const inView = (r) => r.right > -300 && r.left < innerWidth + 300 && r.bottom > -300 && r.top < innerHeight + 300;

// ---------- badges op de kaartjes in de rijen ----------
function scanCards() {
  if (!S.showCards) return;
  document.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]').forEach((a) => {
    if (a.closest("[data-imdb-hover]")) return;
    const id = idOf(a.getAttribute("href"));
    if (!id) return;

    // Alleen echte poster-/titelkaarten. Gewone navigatielinks mogen nooit een overlay krijgen:
    // dat kan Netflix' eigen hover- en schaalanimaties verstoren.
    const poster = a.querySelector('img, video, [data-uia*="boxart"], [class*="boxart"], [style*="background-image"]');
    if (!poster) return;

    const r = a.getBoundingClientRect();
    if (r.width < 64 || r.width > 620 || r.height < r.width * 0.38 || !inView(r)) return;
    a.classList.toggle("imdb-host-mini", r.width < 140);
    if (a.dataset.imdbId === id && a.querySelector(":scope > .imdb-badge")) return;
    render(a, id);
  });
}

// ---------- badge op Netflix' hover-voorbeeldkaart (Play / + / duim) ----------
const PLAY = /^(play|afspelen|speel af|resume|hervat|doorgaan|continue)/i;
function scanHover() {
  if (!S.showHover) return;
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
  if (!S.showMain || !id) { existing?.remove(); return; }
  if (existing && existing.dataset.id === id && existing.isConnected) return;
  existing?.remove();
  if (pending === id) return;
  pending = id;
  const meta = /^\/title\//.test(location.pathname)
    ? [document.querySelector('meta[property="og:title"]')?.content, document.title] : [];
  const loader = UI.makeBadge({ loading: true }, { ...S, size: BIGGER[S.size] || "l" });
  loader.classList.add("imdb-main");
  loader.dataset.id = id;
  place(loader);
  let res;
  try { res = await lookup(id, document.querySelector('[role="dialog"], .previewModal--info, .detail-modal'), meta); }
  catch { res = { error: "fetch" }; }
  pending = null;
  if (!S.showMain || currentId() !== id) return;
  document.querySelector(".imdb-main")?.remove();
  const badge = build(res, BIGGER[S.size] || "l");
  badge.classList.add("imdb-main");
  badge.dataset.id = id;
  place(badge);
}

function syncPlayback() {
  const fullscreen = !!document.fullscreenElement;
  const playing = [...document.querySelectorAll("video")].some((v) => {
    const r = v.getBoundingClientRect();
    const mainPlayer = r.width >= innerWidth * 0.65 && r.height >= innerHeight * 0.42;
    return !v.paused && v.readyState >= 2 && (fullscreen || mainPlayer);
  });
  document.documentElement.classList.toggle("imdb-playback-tiny", playing && S.playbackMode === "tiny");
  document.documentElement.classList.toggle("imdb-playback-hidden", playing && S.playbackMode === "hide");
}
document.addEventListener("play", syncPlayback, true);
document.addEventListener("pause", syncPlayback, true);
function scan() { scanHover(); scanCards(); updateMain(); syncPlayback(); }
let scanTimer;
function queueScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, 120);
}
document.addEventListener("scroll", queueScan, true);
window.addEventListener("resize", queueScan, { passive: true });

let timer;
new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 250); })
  .observe(document.body, { childList: true, subtree: true });
setInterval(scan, 1800);
scan();
