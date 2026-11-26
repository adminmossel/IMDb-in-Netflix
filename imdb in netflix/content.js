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
// De link levert alleen de Netflix-ID. De titel zelf komt uitsluitend uit metadata
// van de bijbehorende Netflix-titelpagina; knoplabels en willekeurige DOM-tekst zijn geen titelbron.
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

const nfWhy = new Map();
async function netflixInfo(id) {
  const fetchPage = async (path) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(path + id, { credentials: "include", signal: controller.signal });
      if (!response.ok) return null;
      const finalId = idOf(response.url);
      if (finalId !== id) return null;
      return await response.text();
    } catch (e) {
      nfWhy.set(id, "fetch-fout: " + (e && e.message || "onbekend"));
      return null;
    } finally { clearTimeout(timeout); }
  };

  const [titleHtml, watchHtml] = await Promise.all([fetchPage("/title/"), fetchPage("/watch/")]);
  const pages = [titleHtml, watchHtml].filter(Boolean);
  if (!pages.length) {
    nfWhy.set(id, nfWhy.get(id) || "Netflix gaf geen metadata voor deze titel-ID");
    return null;
  }

  const refersToId = (value) => {
    if (typeof value !== "string") return false;
    if (value === id) return true;
    return new RegExp("/(?:title|watch)/" + id + "(?:[/?#]|$)").test(value);
  };
  const pageInfo = (html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const typed = [];
    const visit = (node) => {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (typeof node !== "object") return;
      const types = [].concat(node["@type"] || []).map(x => String(x));
      const isSeries = types.some(x => /^(TVSeries|TVMiniSeries|CreativeWorkSeries)$/i.test(x));
      const isMovie = types.some(x => /^Movie$/i.test(x));
      if (isSeries || isMovie) {
        const refs = [node.url, node["@id"], node.mainEntityOfPage]
          .flatMap(v => typeof v === "object" && v ? [v.url, v["@id"]] : [v]);
        const exact = refs.some(refersToId);
        if (exact) {
          const name = cleanTitle(node.name || node.headline);
          if (name) {
            const date = String(node.datePublished || node.dateCreated || node.startDate || node.copyrightYear || "").match(/\d{4}/)?.[0] || null;
            const aliases = [node.alternateName, node.alternateHeadline]
              .flatMap(x => Array.isArray(x) ? x : [x])
              .map(cleanTitle).filter(Boolean);
            typed.push({ title: name, year: date ? +date : null, mediaType: isSeries ? "series" : "movie", aliases });
          }
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (key !== "@context" && value && typeof value === "object") visit(value);
      }
    };
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(script.textContent)); } catch {}
    }

    const exact = typed.find(x => x.year) || typed[0] || null;
    const ogTitle = cleanTitle(doc.querySelector('meta[property="og:title"]')?.content);
    const metaTitle = cleanTitle(doc.querySelector('meta[name="title"]')?.content);
    const title = exact?.title || ogTitle || metaTitle;
    const ogType = doc.querySelector('meta[property="og:type"]')?.content || "";
    const mediaType = exact?.mediaType || (/tv|series|show/i.test(ogType) ? "series" : /movie|film/i.test(ogType) ? "movie" : null);
    if (!title) return null;
    return {
      title,
      aliases: exact?.aliases || [],
      year: exact?.year || null,
      mediaType
    };
  };

  // De /title/{id}-pagina is de primaire bron. /watch/{id} is alleen een reserve.
  for (const html of pages) {
    const result = pageInfo(html);
    if (result) return result;
  }
  nfWhy.set(id, "Netflix-pagina bevat geen titelmetadata die aan deze titel-ID gekoppeld kon worden");
  return null;
}

const idCache = new Map();
function infoFromId(id) {
  if (!idCache.has(id)) {
    idCache.set(id, (async () => {
      const k = "n7:" + id;
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

const resById = new Map();
const pendingById = new Map();

async function lookup(id) {
  if (resById.has(id)) return resById.get(id);
  if (pendingById.has(id)) return pendingById.get(id);
  const p = lookup1(id).then((result) => {
    if (!result || !["fetch", "ctx"].includes(result.error)) resById.set(id, result);
    return result;
  }).finally(() => pendingById.delete(id));
  pendingById.set(id, p);
  return p;
}

async function lookup1(id) {
  const info = await infoFromId(id);
  if (!info || !info.title) {
    return { rating: null, dbg: { q: "(geen betrouwbare Netflix-titel)", y: null, steps: ["id " + id, "netflix: " + (nfWhy.get(id) || "geen titelmetadata")] } };
  }

  const candidates = [info.title, ...(info.aliases || [])]
    .map(cleanTitle)
    .filter((title, index, all) => title && all.findIndex(x => x.toLowerCase() === title.toLowerCase()) === index);

  for (const title of candidates) {
    const result = await ask(title, info.year, info.mediaType);
    if (result.error) return result;
    const rating = Number(result.rating);
    if (result.verified === true && Number.isFinite(rating) && rating >= 0 && rating <= 10 && /^tt\d{5,}$/.test(result.id || "")) {
      return result;
    }
  }
  return {
    rating: null,
    dbg: { q: info.title, y: info.year, steps: ["Geen unieke, bevestigde IMDb-match", "type:" + (info.mediaType || "onbekend"), "Netflix-ID:" + id] }
  };
}

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

// Alleen een badge plaatsen wanneer een score echt aan een IMDb-ID is bevestigd.
// Geen laad-balkjes of "geen score"-labels over de hele Netflix-pagina.
function render(host, id, extra) {
  if (!host || !id) return;
  if (host.dataset.imdbId === id && (host.querySelector(":scope > .imdb-badge") || host.dataset.imdbNoRating === id)) return;
  host.querySelector(":scope > .imdb-badge")?.remove();
  host.dataset.imdbId = id;
  delete host.dataset.imdbNoRating;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";

  lookup(id).then((res) => {
    if (host.dataset.imdbId !== id) return;
    host.querySelector(":scope > .imdb-badge")?.remove();
    const badge = build(res, null, extra);
    if (badge) host.appendChild(badge);
    else host.dataset.imdbNoRating = id;
  }).catch(() => {
    if (host.dataset.imdbId === id) {
      host.querySelector(":scope > .imdb-badge")?.remove();
      host.dataset.imdbNoRating = id;
    }
  });
}

const inView = (r) => r.right > -300 && r.left < innerWidth + 300 && r.bottom > -300 && r.top < innerHeight + 300;

// ---------- badges op de kaartjes in de rijen ----------
// Netflix wisselt regelmatig de DOM-opbouw: soms zit de poster in de link,
// soms staat de afbeelding als buur-element in dezelfde kaartcontainer.
const POSTER_SELECTOR = 'img, video, [data-uia*="boxart"], [class*="boxart"], [style*="background-image"]';
function cardHostForLink(a, id) {
  let node = a;
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    const r = node.getBoundingClientRect();
    if (r.width < 64 || r.width > 620 || r.height < r.width * 0.38 || !inView(r)) continue;
    const hasPoster = node.matches(POSTER_SELECTOR) || !!node.querySelector(POSTER_SELECTOR);
    if (!hasPoster) continue;

    const links = [...node.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]')];
    if (node.matches('a[href*="/watch/"], a[href*="/title/"]')) links.unshift(node);
    const ids = new Set(links.map((link) => idOf(link.getAttribute("href"))).filter(Boolean));
    // Een container met meerdere verschillende titels is een rij, geen individuele kaart.
    if (ids.size === 1 && ids.has(id)) return node;
  }
  return null;
}

function scanCards() {
  if (!S.showCards) return;
  document.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]').forEach((a) => {
    if (a.closest("[data-imdb-hover]")) return;
    const id = idOf(a.getAttribute("href"));
    if (!id) return;

    const host = cardHostForLink(a, id);
    if (!host) return;
    const r = host.getBoundingClientRect();
    host.classList.toggle("imdb-host-mini", r.width < 140);
    if (host.dataset.imdbId === id && host.querySelector(":scope > .imdb-badge")) return;
    render(host, id);
  });
}

// ---------- badge op Netflix' hover-voorbeeldkaart (Play / + / duim) ----------
const PLAY = /^(play|afspelen|speel af|resume|hervat|doorgaan|continue)/i;
function scanHover() {
  if (!S.showHover) return;
  document.querySelectorAll('[data-uia*="play"], button[aria-label], a[aria-label]').forEach((el) => {
    const label = el.getAttribute("aria-label") || "";
    if (!(PLAY.test(label) || /play-button/.test(el.getAttribute("data-uia") || ""))) return;
    // Ook preview-modals meenemen: Netflix plaatst de hover-preview vaak in een dialog/container.
    if (!el.offsetParent) return;
    // klim op tot de grootste omhullende die nog bij precies één titel hoort (= de hele mini-kaart)
    let best = null, c = el.parentElement;
    for (let n = 0; c && n < 14; n++, c = c.parentElement) {
      if (c.getBoundingClientRect().width > 720) break;
      if (c.getBoundingClientRect().width >= 250 && c.querySelector("img, video")) {
        const ids = new Set([...c.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]')]
          .map((x) => idOf(x.getAttribute("href"))).filter(Boolean));
        if (ids.size > 1) break;
        if (ids.size === 1) best = c;
      }
    }
    if (!best || best.querySelector(".imdb-main")) return;
    const link = best.querySelector('a[href*="/watch/"], a[href*="/title/"]') || (el.matches("a[href]") ? el : null);
    const id = idOf(link && link.getAttribute("href"));
    if (!id) return;
    if (best.dataset.imdbId === id && (best.querySelector(":scope > .imdb-badge") || best.dataset.imdbNoRating === id)) return;
    best.dataset.imdbHover = "1";
    best.querySelectorAll("a > .imdb-badge").forEach((b) => b.remove());   // geen dubbele badge
    render(best, id, "imdb-hover");
  });
}

// ---------- grote badge op een echte titelpagina ----------
function currentId() {
  // Geen jbv-queryparameter gebruiken: die kan op browse-/previewpagina's wisselen.
  const match = location.pathname.match(/^\/title\/(\d{5,})(?:\/|$)/);
  return match ? match[1] : null;
}
function place(badge) {
  const area = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight ? r.width * r.height : 0;
  };
  const play = [...document.querySelectorAll('[data-uia="play-button"], button, a[href*="/watch/"]')]
    .filter((el) => el.offsetParent && !el.querySelector("img") && (el.textContent || "").length < 30 &&
      /play|next episode|afspelen|volgende/i.test(el.textContent || "") && area(el) > 0)
    .sort((a, b) => area(b) - area(a))[0];

  if (play && play.parentElement) {
    badge.classList.add("imdb-inline");
    play.parentElement.appendChild(badge);
    return true;
  }
  const heading = document.querySelector('h1, [data-uia="video-title"]');
  if (heading && heading.isConnected) {
    badge.classList.add("imdb-main-inline");
    heading.insertAdjacentElement("afterend", badge);
    return true;
  }
  return false;
}
const BIGGER = { s: "m", m: "l", l: "xl" };
let pendingMain = null;
async function updateMain() {
  const id = currentId();
  const existing = document.querySelector(".imdb-main");
  if (!S.showMain || !id) { existing?.remove(); return; }
  if (existing && existing.dataset.id === id && existing.isConnected) return;
  existing?.remove();
  if (pendingMain === id) return;
  pendingMain = id;
  let res = null;
  try { res = await lookup(id); } catch {}
  finally { if (pendingMain === id) pendingMain = null; }
  if (!S.showMain || currentId() !== id || !isVerifiedRating(res)) return;
  const badge = build(res, BIGGER[S.size] || "l");
  if (!badge) return;
  badge.classList.add("imdb-main");
  badge.dataset.id = id;
  if (!place(badge)) badge.remove();
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
