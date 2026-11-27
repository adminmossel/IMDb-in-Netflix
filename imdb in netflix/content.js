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
  document.querySelectorAll("[data-imdb-id], [data-imdb-fail], [data-imdb-pending], [data-imdb-no-rating], [data-imdb-hover]").forEach((e) => {
    delete e.dataset.imdbId;
    delete e.dataset.imdbFail;
    delete e.dataset.imdbPending;
    delete e.dataset.imdbNoRating;
    delete e.dataset.imdbHover;
    e.classList.remove("imdb-host-mini");
  });
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
const nfTrace = new Map();
async function netflixInfo(id) {
  nfTrace.set(id, []);
  const trace = (message) => {
    const items = nfTrace.get(id) || [];
    if (items.length < 12) items.push("netflix-fetch: " + message);
    nfTrace.set(id, items);
  };
  const fetchPage = async (path) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(path + id, { credentials: "include", signal: controller.signal });
      const finalUrl = new URL(response.url);
      if (!response.ok) {
        trace(path + " HTTP " + response.status + "; eindpad=" + finalUrl.pathname);
        nfWhy.set(id, path + " gaf HTTP " + response.status);
        return null;
      }
      const finalId = idOf(response.url);
      if (finalId !== id) {
        trace(path + " redirect naar " + finalUrl.pathname + "; verwacht ID " + id);
        nfWhy.set(id, path + " werd omgeleid naar een andere URL: " + finalUrl.pathname);
        return null;
      }
      const html = await response.text();
      const scriptCount = (html.match(/<script\b/gi) || []).length;
      trace(path + " HTTP " + response.status + "; eindpad=" + finalUrl.pathname +
        "; tekens=" + html.length + "; scripts=" + scriptCount +
        "; reactContext=" + (/netflix\.reactContext\s*=/.test(html) ? "ja" : "nee") +
        "; h1=" + (/<h1\b/i.test(html) ? "ja" : "nee") +
        "; metadata=" + (/data-uia=["']metadata["']/i.test(html) ? "ja" : "nee"));
      return html;
    } catch (e) {
      const reason = e && e.name === "AbortError" ? "timeout" : (e && e.message || "onbekend");
      trace(path + " fetch-fout=" + reason);
      nfWhy.set(id, "fetch-fout: " + reason);
      return null;
    } finally { clearTimeout(timeout); }
  };

  const lang = String(document.documentElement.lang || "en").toLowerCase().split("-")[0];
  // Begin met de lokale titelpagina. Pas als die geen bruikbare metadata heeft,
  // worden de generieke titel- en watch-routes geprobeerd.
  const primaryHtml = await fetchPage("/" + lang + "/title/");

  const refersToId = (value) => {
    if (typeof value !== "string") return false;
    if (value === id) return true;
    return new RegExp("/(?:title|watch)/" + id + "(?:[/?#]|$)").test(value);
  };

  // Netflix embeds the canonical title payload in netflix.reactContext.
  // This is more reliable than depending on JSON-LD, which is not present
  // in every server-rendered title page.
  const reactContextInfo = (html) => {
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
    trace("scripts=" + scripts.length + "; reactContext-assignment=" +
      (scripts.some(script => /netflix\.reactContext\s*=/.test(script)) ? "ja" : "nee"));
    for (const script of scripts) {
      const match = script.match(/netflix\.reactContext\s*=\s*(\{[\s\S]*?\});\s*<\/script>/i);
      if (!match) continue;
      trace("reactContext assignment-regex=match");
      try {
        const source = match[1].replace(/\\x([0-9a-f]{2})/gi, (_all, hex) => "\\u00" + hex);
        const context = JSON.parse(source);
        trace("reactContext JSON=parse-ok");
        const nm = context?.models?.nmTitleGQL?.data;
        const meta = nm?.metaData || {};
        const exactMetaId = String(meta.videoId || meta.topLevelVideoId || "");
        const nmTitle = cleanTitle(nm?.copy?.title);
        if (exactMetaId === id && nmTitle) {
          trace("reactContext nmTitleGQL exact-ID=hit");
          let graphVideo = null;
          const walk = (node) => {
            if (!node || graphVideo) return;
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (typeof node !== "object") return;
            if (String(node.videoId || "") === id && typeof node.title === "string" &&
                /^(Movie|Show|TVSeries)$/i.test(String(node.__typename || node.type || ""))) {
              graphVideo = node;
              return;
            }
            Object.values(node).forEach(walk);
          };
          walk(context?.models?.graphqlClcs?.data);
          const rawType = String(graphVideo?.__typename || meta.type || "").toLowerCase();
          const mediaType = rawType === "movie" ? "movie"
            : rawType === "show" || rawType === "tvseries" ? "series" : null;
          const year = parseInt(String(graphVideo?.latestYear || nm?.latestYear || meta.latestYear || "").match(/\d{4}/)?.[0], 10) || null;
          return { title: nmTitle, aliases: [], year, mediaType };
        }

        // Some Netflix page variants expose the title only in graphqlClcs.
        let graphVideo = null;
        const walk = (node) => {
          if (!node || graphVideo) return;
          if (Array.isArray(node)) { node.forEach(walk); return; }
          if (typeof node !== "object") return;
          if (String(node.videoId || "") === id && typeof node.title === "string" &&
              /^(Movie|Show|TVSeries)$/i.test(String(node.__typename || node.type || ""))) {
            graphVideo = node;
            return;
          }
          Object.values(node).forEach(walk);
        };
        walk(context?.models?.graphqlClcs?.data);
        if (graphVideo) {
          trace("reactContext graphqlClcs exact-ID=hit");
          const rawType = String(graphVideo.__typename || graphVideo.type || "").toLowerCase();
          return {
            title: cleanTitle(graphVideo.title),
            aliases: [],
            year: parseInt(String(graphVideo.latestYear || "").match(/\d{4}/)?.[0], 10) || null,
            mediaType: rawType === "movie" ? "movie" : "series"
          };
        }
      } catch {
        trace("reactContext JSON=parse-failed");
      }
    }
    return null;
  };

  const pageInfo = (html) => {
    const embedded = reactContextInfo(html);
    if (embedded) return embedded;
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
        const exactRef = refs.some(refersToId);
        const name = cleanTitle(node.name || node.headline);
        if (name) {
          const date = String(node.datePublished || node.dateCreated || node.startDate || node.copyrightYear || "").match(/\d{4}/)?.[0] || null;
          const aliases = [node.alternateName, node.alternateHeadline]
            .flatMap(x => Array.isArray(x) ? x : [x])
            .map(cleanTitle).filter(Boolean);
          typed.push({ title: name, year: date ? +date : null, mediaType: isSeries ? "series" : "movie", aliases, exactRef });
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (key !== "@context" && value && typeof value === "object") visit(value);
      }
    };
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(script.textContent)); } catch {}
    }

    // De response-URL is hierboven al gecontroleerd tegen de aangevraagde Netflix-ID.
    // Paginametadata (Open Graph / title / h1) hoort daardoor bij precies die titel,
    // ook wanneer Netflix het JSON-LD-object geen expliciete URL meegeeft.
    const pageTitles = [
      doc.querySelector('[data-uia="metadata"] h2')?.textContent,
      doc.querySelector('[data-uia="video-title"]')?.textContent,
      doc.querySelector('meta[property="og:title"]')?.content,
      doc.querySelector('meta[name="title"]')?.content,
      doc.querySelector("h1")?.textContent,
      doc.title
    ].map(cleanTitle).filter(Boolean);
    const normalizeTitle = (value) => cleanTitle(value)?.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim() || "";
    const pageTitle = pageTitles[0] || null;
    const pageTitleKeys = new Set(pageTitles.map(normalizeTitle).filter(Boolean));

    const exactTyped = typed.filter(x => x.exactRef);
    const matchingTyped = typed.filter(x => pageTitleKeys.has(normalizeTitle(x.title)));
    const chosen = exactTyped.length === 1 ? exactTyped[0]
      : exactTyped.length > 1 ? null
      : matchingTyped.length === 1 ? matchingTyped[0]
      : matchingTyped.length > 1 ? null
      : typed.length === 1 ? typed[0] : null;

    const ogType = doc.querySelector('meta[property="og:type"]')?.content || "";
    const rawType = (html.match(/"(?:titleType|videoType)"\s*:\s*"(movie|series|tvSeries|tvMiniSeries)"/i) || [])[1];
    const fallbackType = /tv|series|show/i.test(ogType) || /series/i.test(rawType || "") ? "series"
      : /movie|film/i.test(ogType) || /movie/i.test(rawType || "") ? "movie" : null;
    const releaseYear = parseInt((html.match(/"releaseYear"\s*:\s*(\d{4})/) || [])[1], 10) || null;
    const facts = [...doc.querySelectorAll('[data-uia="metadata"] ul li')]
      .map(node => (node.textContent || "").replace(/[\u2066-\u2069]/g, "").trim());
    const factsYear = parseInt(facts.find(value => /^(19|20)\d{2}$/.test(value)) || "", 10) || null;
    const title = chosen?.title || pageTitle;
    if (!title) {
      nfWhy.set(id, "Geen titel in Netflix-metadata; reactContext=" +
        (/netflix\.reactContext\s*=/.test(html) ? "ja" : "nee") +
        "; paginatitels=" + (pageTitles.slice(0, 3).join(" | ") || "geen") +
        "; schema-objecten=" + typed.length);
      return null;
    }
    return {
      title,
      aliases: chosen?.aliases || [],
      year: chosen?.year || releaseYear || factsYear,
      mediaType: chosen?.mediaType || fallbackType
    };
  };

  if (primaryHtml) {
    const result = pageInfo(primaryHtml);
    if (result) return result;
  }
  // Fallbacks alleen ophalen wanneer de gelokaliseerde titelpagina geen titel opleverde.
  for (const path of ["/title/", "/watch/"]) {
    const html = await fetchPage(path);
    if (!html) continue;
    const result = pageInfo(html);
    if (result) return result;
  }
  nfWhy.set(id, nfWhy.get(id) || "Netflix-pagina bevat geen titelmetadata die aan deze titel-ID gekoppeld kon worden");
  return null;
}

const idCache = new Map();
function infoFromId(id) {
  if (!idCache.has(id)) {
    idCache.set(id, (async () => {
      const k = "n14:" + id;
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
    return { rating: null, dbg: { q: "(geen betrouwbare Netflix-titel)", y: null,
      steps: ["id " + id, "netflix: " + (nfWhy.get(id) || "geen titelmetadata"), ...(nfTrace.get(id) || [])] } };
  }

  const candidates = [info.title, ...(info.aliases || [])]
    .map(cleanTitle)
    .filter((title, index, all) => title && all.findIndex(x => x.toLowerCase() === title.toLowerCase()) === index);

  const failedCandidates = [];
  for (const title of candidates) {
    const result = await ask(title, info.year, info.mediaType);
    if (result.error) return result;
    const rating = Number(result.rating);
    if (result.verified === true && Number.isFinite(rating) && rating >= 0 && rating <= 10 && /^tt\d{5,}$/.test(result.id || "")) {
      return result;
    }
    const detail = result && result.dbg;
    failedCandidates.push("kandidaat: " + title);
    if (detail && Array.isArray(detail.steps)) failedCandidates.push(...detail.steps);
    else failedCandidates.push("geen score of bevestigde IMDb-ID ontvangen");
  }
  return {
    rating: null,
    dbg: {
      q: info.title,
      y: info.year,
      steps: [
        "Netflix-ID: " + id,
        "type: " + (info.mediaType || "onbekend"),
        ...failedCandidates
      ]
    }
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
function render(host, id, extra) {
  if (!host || !id) return;
  if (host.dataset.imdbId === id && (
    host.querySelector(":scope > .imdb-badge") ||
    host.dataset.imdbPending === id ||
    host.dataset.imdbNoRating === id
  )) return;

  host.querySelector(":scope > .imdb-badge")?.remove();
  host.dataset.imdbId = id;
  host.dataset.imdbPending = id;
  delete host.dataset.imdbNoRating;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";

  lookup(id).then((res) => {
    if (host.dataset.imdbId !== id || host.dataset.imdbPending !== id) return;
    delete host.dataset.imdbPending;
    saveNetflixDiagnostic(id, res);
    host.querySelector(":scope > .imdb-badge")?.remove();
    const badge = build(res, null, extra) || buildDebugBadge(res, null, extra);
    if (badge) host.appendChild(badge);
    else host.dataset.imdbNoRating = id;
  }).catch(() => {
    if (host.dataset.imdbId === id && host.dataset.imdbPending === id) {
      delete host.dataset.imdbPending;
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
  const hasOnlyThisTitle = (node) => {
    const links = [...node.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]')];
    const ids = new Set(links.map((link) => idOf(link.getAttribute("href"))).filter(Boolean));
    return ids.size === 1 && ids.has(id);
  };

  // Netflix' card root. This keeps artwork, title links and hover controls together.
  const titleCard = a.closest(".title-card");
  if (titleCard && titleCard.getBoundingClientRect().width <= 620 &&
      titleCard.getBoundingClientRect().width >= 64 &&
      titleCard.querySelector(POSTER_SELECTOR) && hasOnlyThisTitle(titleCard)) {
    return titleCard;
  }

  // DOM variants without .title-card: use the nearest small container that holds
  // both a poster and this one Netflix ID. Never climb up to an entire row.
  for (let node = a.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
    const r = node.getBoundingClientRect();
    if (r.width > 620) break;
    if (r.width < 64 || r.height < r.width * 0.38 || r.height > r.width * 2.2 || !inView(r)) continue;
    if (node.tagName === "A") continue;
    const hasPoster = node.matches(POSTER_SELECTOR) || !!node.querySelector(POSTER_SELECTOR);
    if (hasPoster && hasOnlyThisTitle(node)) return node;
  }
  return null;
}

function scanCards() {
  if (!S.showCards || currentId()) return;
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
  if (!S.showHover || currentId()) return;
  document.querySelectorAll('[data-uia*="play"], button[aria-label]').forEach((el) => {
    const label = el.getAttribute("aria-label") || "";
    if (!(PLAY.test(label) || /play-button/.test(el.getAttribute("data-uia") || ""))) return;
    if (!el.offsetParent) return;

    // Alleen de echte Netflix-preview-modal gebruiken. Geen willekeurige ancestors
    // of rijcontainers: die veroorzaakten badges op vreemde en dubbele plekken.
    const modal = el.closest(".focus-trap-wrapper.previewModal--wrapper.mini-modal, .previewModal--wrapper.mini-modal");
    if (!modal) return;
    const links = [...modal.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]')];
    const ids = new Set(links.map(link => idOf(link.getAttribute("href"))).filter(Boolean));
    if (ids.size !== 1) return;
    const id = [...ids][0];

    const host = modal.querySelector(".previewModal--info") ||
      modal.querySelector('[data-uia="metadata"]') || modal;
    if (!host || host.tagName === "A") return;
    if (host.dataset.imdbId === id && (
      host.querySelector(":scope > .imdb-badge") ||
      host.dataset.imdbPending === id ||
      host.dataset.imdbNoRating === id
    )) return;

    host.dataset.imdbHover = "1";
    render(host, id, "imdb-hover");
  });
}

// ---------- grote badge op een echte titelpagina ----------
function currentId() {
  // Geen jbv-queryparameter gebruiken: die kan op browse-/previewpagina's wisselen.
  const match = location.pathname.match(/^\/(?:[a-z]{2}(?:-[A-Z]{2})\/)?title\/(\d{5,})(?:\/|$)/i);
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
  if (!S.showMain || currentId() !== id) return;
  saveNetflixDiagnostic(id, res);
  const badge = build(res, BIGGER[S.size] || "l") || buildDebugBadge(res, BIGGER[S.size] || "l");
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
