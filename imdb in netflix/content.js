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
  document.querySelectorAll("[data-imdb-key], [data-imdb-host], [data-imdb-pending], [data-imdb-no]").forEach((e) => {
    delete e.dataset.imdbKey;
    delete e.dataset.imdbHost;
    delete e.dataset.imdbPending;
    delete e.dataset.imdbNo;
    e.classList.remove("imdb-host-mini");
  });
  resCache.clear();
  resPending.clear();
  idCache.clear();
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
const GENERIC = /^(netflix|home|browse|play|afspelen|speel af|more info|meer info|info|my list|mijn lijst|series|films|movies|tv shows|zoeken|search|new & popular|nieuw en populair|more like this|meer zoals dit|episodes|afleveringen|trailers|modal|dialog|venster|top 10)$/i;
function cleanTitle(t) {
  t = (t || "").replace(/[\u2066-\u2069\u200e\u200f]/g, "").split("|")[0]
    .replace(/\s+[-–—]\s*Netflix.*$/i, "")
    .replace(/^(Watch|Kijk naar|Kijk|Bekijk|About|Over)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return !t || t.length > 120 || GENERIC.test(t) ? null : t;
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
  let resolvedId = id;   // wordt het serie-ID als Netflix een aflevering doorstuurt
  const trace = (message) => {
    const items = nfTrace.get(id) || [];
    if (items.length < 12) items.push("netflix-fetch: " + message);
    nfTrace.set(id, items);
  };
  const fetchPage = async (path) => {
    resolvedId = id;
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
        // Een aflevering-ID (bv. van de "Next Episode"-knop) wordt door Netflix naar de
        // bovenliggende serie omgeleid: /title/<aflevering> -> /title/<serie>. Dat is
        // juist de titel die we zoeken, dus accepteren we het (alleen via /title/).
        const isShowRedirect = path === "/title/" && !!finalId &&
          /^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?title\/\d{5,}\/?$/i.test(finalUrl.pathname);
        if (!isShowRedirect) {
          trace(path + " redirect naar " + finalUrl.pathname + "; verwacht ID " + id);
          nfWhy.set(id, path + " werd omgeleid naar een andere URL: " + finalUrl.pathname);
          return null;
        }
        resolvedId = finalId;
        trace(path + " aflevering " + id + " -> serie " + finalId);
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
  // Gebruik eerst de canonieke Netflix-route. In sommige taalinstellingen
  // stuurt Netflix /en/title/{id} door naar /NotFound, terwijl /title/{id} wel werkt.
  const primaryHtml = await fetchPage("/title/");

  const refersToId = (value) => {
    if (typeof value !== "string") return false;
    if (value === resolvedId) return true;
    return new RegExp("/(?:title|watch)/" + resolvedId + "(?:[/?#]|$)").test(value);
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

        const models = context && typeof context === "object" ? (context.models || {}) : {};
        const modelKeys = Object.keys(models);
        const nmData = models?.nmTitleGQL?.data;
        trace("models=" + (modelKeys.slice(0, 12).join(",") || "geen") +
          "; nmTitleGQL-data=" + (!!nmData) +
          "; nm-copy-title=" + (!!cleanTitle(nmData?.copy?.title)) +
          "; nm-metaData=" + (!!nmData?.metaData) +
          "; graphqlClcs-data=" + (!!models?.graphqlClcs?.data));

        // Netflix title data appears in two related shapes:
        // nmTitleGQL: metaData.videoId + copy.title
        // graphqlClcs: videoId + title, nested below query/componentTree nodes.
        // Walk the complete models object and accept only records whose own ID
        // (or paired metadata ID) exactly equals the requested Netflix ID.
        const exactRecords = [];
        const seen = new Set();
        const walkExact = (node) => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) {
            node.forEach(walkExact);
            return;
          }
          if (seen.has(node)) return;
          seen.add(node);

          const meta = node.metaData && typeof node.metaData === "object" ? node.metaData : {};
          const rawId = node.videoId ?? node.topLevelVideoId ?? meta.videoId ?? meta.topLevelVideoId;
          const rawTitle = cleanTitle(node.title || node.copy?.title || node.copy?.name);
          if (String(rawId ?? "") === resolvedId && rawTitle) {
            const rawType = String(node.__typename || node.type || meta.type || "").toLowerCase();
            const mediaType = rawType === "movie" ? "movie"
              : rawType === "show" || rawType === "tvseries" || rawType === "tvminiseries" ? "series" : null;
            const year = parseInt(String(node.latestYear || node.dateCreated || node.releaseYear ||
              meta.latestYear || meta.releaseYear || "").match(/\d{4}/)?.[0], 10) || null;
            exactRecords.push({ title: rawTitle, year, mediaType });
          }
          Object.values(node).forEach(walkExact);
        };
        walkExact(models);

        const titleNames = [...new Set(exactRecords.map(record => record.title))];
        trace("exact-ID-titelrecords=" + exactRecords.length +
          "; unieke-titels=" + (titleNames.length ? titleNames.join(" | ") : "geen"));
        if (titleNames.length === 1) {
          const matching = exactRecords.filter(record => record.title === titleNames[0]);
          matching.sort((left, right) =>
            Number(!!right.year) + Number(!!right.mediaType) -
            Number(!!left.year) - Number(!!left.mediaType));
          const best = matching[0];
          trace("exact Netflix-ID bevestigd in reactContext");
          return { title: best.title, aliases: [], year: best.year, mediaType: best.mediaType };
        }
        if (titleNames.length > 1) {
          trace("meerdere verschillende titels bij exact Netflix-ID; niet automatisch gekozen");
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
  // Fallbacks alleen ophalen wanneer de canonieke titelpagina geen titel opleverde.
  for (const path of ["/watch/", "/" + lang + "/title/"]) {
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
      const k = "n15:" + id;
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


// ---------- zoekopdracht: titel(s) + jaar + type -> bevestigde IMDb-score ----------
// req = { key, id?, titles[], fallbackTitles[], year?, mediaType? }
const resCache = new Map();
const resPending = new Map();

async function lookup(req) {
  if (resCache.has(req.key)) return resCache.get(req.key);
  if (resPending.has(req.key)) return resPending.get(req.key);
  const p = lookup1(req).then((result) => {
    if (!result || !["fetch", "ctx"].includes(result.error)) resCache.set(req.key, result);
    return result;
  }).finally(() => resPending.delete(req.key));
  resPending.set(req.key, p);
  return p;
}

async function lookup1(req) {
  const steps = [];
  let titles = [...(req.titles || [])];
  let year = req.year || null;
  let mediaType = req.mediaType || null;
  let aliases = [];
  const id = req.id || null;

  // Netflix-pagina alleen erbij pakken als de pagina zelf te weinig vertelt.
  if (id && (!titles.length || !year)) {
    const info = await infoFromId(id);
    if (info) {
      if (info.title) titles.push(info.title);
      aliases = info.aliases || [];
      year = year || info.year || null;
      mediaType = mediaType || info.mediaType || null;
    } else {
      steps.push("netflix: " + (nfWhy.get(id) || "geen titelmetadata"), ...(nfTrace.get(id) || []));
    }
  }
  if (!titles.length) titles = [...(req.fallbackTitles || [])];

  const candidates = [...titles, ...aliases]
    .map(cleanTitle)
    .filter((title, index, all) => title && all.findIndex((x) => x.toLowerCase() === title.toLowerCase()) === index);

  if (!candidates.length) {
    return { rating: null, dbg: { q: "(geen betrouwbare titel)", y: year, steps: ["id " + (id || "?"), ...steps] } };
  }

  const failed = [];
  for (const title of candidates) {
    const result = await ask(title, year, mediaType);
    if (result.error) return result;
    const rating = Number(result.rating);
    if (result.verified === true && Number.isFinite(rating) && rating >= 0 && rating <= 10 && /^tt\d{5,}$/.test(result.id || "")) {
      return result;
    }
    failed.push("kandidaat: " + title);
    const detail = result && result.dbg;
    if (detail && Array.isArray(detail.steps)) failed.push(...detail.steps);
    else failed.push("geen score of bevestigde IMDb-ID ontvangen");
  }
  return {
    rating: null,
    dbg: {
      q: candidates[0], y: year,
      steps: ["Netflix-ID: " + (id || "?"), "type: " + (mediaType || "onbekend"), "jaar: " + (year || "onbekend"), ...steps, ...failed]
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

// =====================================================================
//  DOM-herkenning
//  Eén badge per plek: óf in de knoppenrij van een modal (Play / + / duim),
//  óf linksboven op een kaartje in een rij. Nooit allebei op dezelfde titel.
// =====================================================================
const MODAL_SEL = '.previewModal--wrapper, .previewModal--container, .detail-modal, .mini-modal, [role="dialog"]';
const CARD_SEL = '.title-card, .titleCard--container, [class*="titleCard"], .moreLikeThis, [class*="moreLikeThis"]';
const EPISODE_SEL = '.episodeSelector, [class*="episodeSelector"], [class*="episode-"], [data-uia*="episode-"]';
const EXCL_SEL = CARD_SEL + ", " + EPISODE_SEL + ', [class*="trailers"]';
const PLAY_RE = /^(play|afspelen|speel af|resume|hervat|doorgaan|continue|next episode|volgende aflevering|watch now|nu kijken)/i;
const END_CONTROLS = '[data-uia*="mute"], [data-uia*="volume"], [data-uia*="expand"], [data-uia*="detail"], [aria-label*="mute" i], [aria-label*="geluid" i], [aria-label*="volume" i]';

const inView = (r) => r.right > -300 && r.left < innerWidth + 300 && r.bottom > -300 && r.top < innerHeight + 300;
const clean = (t) => (t || "").replace(/[\u2066-\u2069\u200e\u200f]/g, "").replace(/\s+/g, " ").trim();

function currentId() {
  const match = location.pathname.match(/^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?title\/(\d{5,})(?:\/|$)/i);
  return match ? match[1] : null;
}
function jbvId() {
  const v = new URLSearchParams(location.search).get("jbv");
  return v && /^\d{5,}$/.test(v) ? v : null;
}

// Buitenste modal-element waar dit element in zit (of null).
function modalRoot(el) {
  let m = el.closest(MODAL_SEL);
  if (!m) return null;
  let up;
  while ((up = m.parentElement && m.parentElement.closest(MODAL_SEL))) m = up;
  return m;
}
const isMini = (root) => !!(root.matches(".mini-modal") || root.closest(".mini-modal") || root.querySelector(":scope > .mini-modal"));
// Elementen in een uitgesloten blok (More Like This, afleveringenlijst, trailers) binnen de modal.
function excluded(el, root) {
  const x = el.closest(EXCL_SEL);
  return !!x && x !== root && root.contains(x);
}

function findPlay(scope) {
  const nodes = scope.querySelectorAll('[data-uia="play-button"], button, a[href*="/watch/"]');
  for (const el of nodes) {
    if (!el.offsetParent || el.closest(".imdb-badge")) continue;
    if (excluded(el, scope)) continue;
    const label = clean(el.getAttribute("aria-label") || el.textContent);
    const uia = el.getAttribute("data-uia") || "";
    if (/play-button/.test(uia) || (label.length < 40 && PLAY_RE.test(label))) return el;
  }
  return null;
}

// Titelkandidaten uit wat de modal zelf toont (logo-alt, "Over <titel>", aria-label).
function domTitles(root) {
  const out = [];
  const add = (v) => { const t = cleanTitle(v); if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t); };
  root.querySelectorAll('.about-header strong, .about-wrapper strong, [data-uia*="about"] strong').forEach((e) => {
    if (!excluded(e, root)) add(e.textContent);
  });
  root.querySelectorAll("img[alt]").forEach((img) => {
    if (excluded(img, root)) return;
    const sig = (img.className || "") + " " + (img.getAttribute("data-uia") || "") + " " + (img.parentElement ? img.parentElement.className || "" : "");
    if (/titleTreatment|title-treatment|video-title|logo/i.test(sig)) add(img.getAttribute("alt"));
  });
  root.querySelectorAll('[data-uia="video-title"], [data-uia*="title-treatment"], h1').forEach((e) => {
    if (excluded(e, root)) return;
    const img = e.querySelector("img[alt]");
    add(e.getAttribute("aria-label") || (img && img.getAttribute("alt")) || e.textContent);
  });
  add(root.getAttribute("aria-label"));
  if (!out.length) {
    for (const img of root.querySelectorAll("img[alt]")) {
      if (!excluded(img, root) && clean(img.getAttribute("alt"))) { add(img.getAttribute("alt")); if (out.length) break; }
    }
  }
  return out;
}

// Jaar en type (film/serie) uit de metadata-regel: "2026  4 Parts" of "2026  2h 8m".
function domMeta(root) {
  let year = null, line = "";
  for (const e of root.querySelectorAll("span, div, li, p")) {
    if (e.childElementCount > 0) continue;
    const t = clean(e.textContent);
    if (!/^(19|20)\d{2}$/.test(t) || excluded(e, root)) continue;
    year = +t;
    const bits = [t];
    for (let s = e.nextElementSibling, i = 0; s && i < 3; s = s.nextElementSibling, i++) bits.push(clean(s.textContent));
    line = bits.join(" ").slice(0, 100);
    break;
  }
  let mediaType = null;
  if (/\b(seasons?|seizoenen|seizoen|parts?|delen|deel|episodes?|afleveringen|limited series|miniserie|miniseries)\b/i.test(line)) mediaType = "series";
  else if (/\b\d+\s?(h|u|uur|hr)\b|\b\d+\s?(min|m)\b/i.test(line)) mediaType = "movie";
  if (!mediaType) {
    for (const e of root.querySelectorAll("span, div, li, p")) {
      if (e.childElementCount > 0) continue;
      const t = clean(e.textContent);
      if (!t || t.length > 25 || excluded(e, root)) continue;
      if (/^(films?|movies?)$/i.test(t) || /^\d+\s?(h|u|uur)(\s?\d+\s?(m|min))?$/i.test(t) || /^\d+\s?min$/i.test(t)) { mediaType = "movie"; break; }
      if (/^(serie|series|show|tv series|tv-serie)$/i.test(t) || /^\d+\s?(seasons?|seizoenen|seizoen|parts?|delen)$/i.test(t) || /^limited series$/i.test(t)) { mediaType = "series"; break; }
    }
  }
  if (!mediaType) {
    const tx = root.textContent || "";
    const hint = tx.match(/\b(This|Deze)\s+(series|show|film|movie|serie|programma)\b/i);
    if (hint) mediaType = /film|movie/i.test(hint[2]) ? "movie" : "series";
    else {
      const gi = tx.search(/Genres?:/i);
      const g = gi >= 0 ? tx.slice(gi, gi + 160) : "";
      const s = /(series|serie|shows?|programma)/i.test(g), f = /(films?|movies?)/i.test(g);
      if (s && !f) mediaType = "series"; else if (f && !s) mediaType = "movie";
    }
  }
  return { year, mediaType };
}

function modalIds(root) {
  const ids = new Set();
  let playId = null;
  root.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]').forEach((a) => {
    if (excluded(a, root)) return;
    const id = idOf(a.getAttribute("href"));
    if (id) ids.add(id);
  });
  return ids;
}

function modalInfo(root, play) {
  const mini = isMini(root);
  let id = null;
  if (!mini) id = currentId() || jbvId();
  if (!id) {
    const link = play && (play.matches("a[href]") ? play : play.closest("a[href]") || play.querySelector("a[href]"));
    const playId = link ? idOf(link.getAttribute("href")) : null;
    const ids = modalIds(root);
    id = ids.size === 1 ? [...ids][0] : (playId && ids.has(playId) ? playId : null);
  }
  const meta = domMeta(root);
  return { id, titles: domTitles(root), year: meta.year, mediaType: meta.mediaType };
}

// ---------- badge in de knoppenrij van een modal ----------
function insertInRow(play, badge) {
  const row = play.parentElement;
  if (!row) return false;
  const kids = [...row.children].filter((k) => !k.classList.contains("imdb-badge"));
  const isEnd = (k) => k.matches(END_CONTROLS) || !!k.querySelector(END_CONTROLS);
  let anchor = null;
  kids.forEach((k) => { if (!isEnd(k)) anchor = k; });
  if (anchor) anchor.insertAdjacentElement("afterend", badge); else row.appendChild(badge);
  return true;
}

function removeBadges(scope, surface) {
  scope.querySelectorAll('.imdb-badge[data-surface="' + surface + '"]').forEach((b) => b.remove());
}

function mountModal(root, key, res, mini) {
  const play = findPlay(root);
  if (!play) return false;
  removeBadges(root, "modal");
  const size = mini ? "s" : (BIGGER[S.size] || "l");
  const badge = build(res, size, "imdb-inline") || buildDebugBadge(res, size, "imdb-inline");
  if (!badge) { root.dataset.imdbNo = key; return true; }
  badge.dataset.surface = "modal";
  badge.dataset.key = key;
  if (mini) badge.classList.add("imdb-mini");
  if (!insertInRow(play, badge)) { badge.remove(); return false; }
  delete root.dataset.imdbNo;
  return true;
}

const BIGGER = { s: "m", m: "l", l: "xl" };
function loadingBadge(size, extra) {
  const b = UI.makeBadge({ loading: true }, { ...S, size: size || S.size }, hooks);
  if (extra) b.classList.add(extra);
  return b;
}

function updateModals() {
  const roots = new Set();
  document.querySelectorAll(MODAL_SEL).forEach((m) => {
    const r = modalRoot(m);
    if (r && r.getClientRects().length) roots.add(r);
  });
  // Oudere titelpagina zonder modal
  if (!roots.size && currentId()) {
    const page = document.querySelector("main") || document.body;
    if (findPlay(page)) roots.add(page);
  }

  const live = new Set();
  roots.forEach((root) => {
    const play = findPlay(root);
    if (!play) return;
    const mini = isMini(root);
    if (mini ? !S.showHover : !S.showMain) { removeBadges(root, "modal"); return; }
    const info = modalInfo(root, play);
    if (!info.id && !info.titles.length) return;
    live.add(root);

    const key = ["m", info.id || "", info.titles[0] || "", info.year || "", info.mediaType || ""].join("|");
    if (root.dataset.imdbKey !== key) {
      removeBadges(root, "modal");
      root.dataset.imdbKey = key;
      delete root.dataset.imdbPending;
      delete root.dataset.imdbNo;
    }
    const badges = [...root.querySelectorAll('.imdb-badge[data-surface="modal"]')];
    if (badges.length > 1) badges.slice(1).forEach((b) => b.remove());       // nooit dubbel
    if (badges.length && badges[0].dataset.key === key && badges[0].isConnected) return;
    if (root.dataset.imdbNo === key || root.dataset.imdbPending === key) return;

    if (resCache.has(key)) { mountModal(root, key, resCache.get(key), mini); return; }
    // Pas zoeken als de gegevens van de modal even stabiel zijn (spaart aanvragen bij snel hoveren).
    if (root.__imdbSeenKey !== key) { root.__imdbSeenKey = key; root.__imdbSeenAt = Date.now(); }
    if (Date.now() - root.__imdbSeenAt < 500) { setTimeout(queueScan, 550); return; }
    root.dataset.imdbPending = key;
    const loadPlay = findPlay(root);
    if (loadPlay) {
      removeBadges(root, "modal");
      const lb = loadingBadge(mini ? "s" : (BIGGER[S.size] || "l"), "imdb-inline");
      lb.dataset.surface = "modal"; lb.dataset.key = key;
      if (mini) lb.classList.add("imdb-mini");
      insertInRow(loadPlay, lb);
    }
    lookup({ key, id: info.id, titles: info.titles, year: info.year, mediaType: info.mediaType }).then((res) => {
      if (root.dataset.imdbPending === key) delete root.dataset.imdbPending;
      if (!root.isConnected || root.dataset.imdbKey !== key) return;
      saveNetflixDiagnostic(info.id || key, res);
      mountModal(root, key, res, mini);
    }).catch(() => {
      if (root.dataset.imdbPending === key) delete root.dataset.imdbPending;
      removeBadges(root, "modal");
      root.dataset.imdbNo = key;
    });
  });

  // Losse modal-badges zonder (zichtbare) modal opruimen
  document.querySelectorAll('.imdb-badge[data-surface="modal"]').forEach((b) => {
    const r = modalRoot(b) || b.closest("main");
    if (!r || !live.has(r)) b.remove();
  });
}

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
  const titleCard = a.closest(".title-card");
  if (titleCard) {
    const w = titleCard.getBoundingClientRect().width;
    if (w <= 620 && w >= 64 && titleCard.querySelector(POSTER_SELECTOR) && hasOnlyThisTitle(titleCard)) return titleCard;
  }
  for (let node = a.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
    const r = node.getBoundingClientRect();
    if (r.width > 620) break;
    if (r.width < 64 || r.height < r.width * 0.38 || r.height > r.width * 2.2 || !inView(r)) continue;
    if (node.tagName === "A") continue;
    if ((node.matches(POSTER_SELECTOR) || node.querySelector(POSTER_SELECTOR)) && hasOnlyThisTitle(node)) return node;
  }
  return null;
}

function cardTitleOf(a, host) {
  const out = [];
  const add = (v) => { const t = cleanTitle(v); if (t && !out.includes(t)) out.push(t); };
  add(a.getAttribute("aria-label"));
  const fb = host.querySelector(".fallback-text, [class*='fallback-text']");
  if (fb) add(fb.textContent);
  const img = host.querySelector("img[alt]");
  if (img) add(img.getAttribute("alt"));
  return out;
}

function renderCard(host, id, a) {
  if (host.dataset.imdbHost && host.dataset.imdbHost !== id) {
    host.querySelectorAll(':scope > .imdb-badge[data-surface="card"]').forEach((b) => b.remove());
    delete host.dataset.imdbPending;
    delete host.dataset.imdbNo;
  }
  if (host.dataset.imdbHost === id && (
    host.querySelector(':scope > .imdb-badge[data-surface="card"]') ||
    host.dataset.imdbPending === id || host.dataset.imdbNo === id)) return;

  host.dataset.imdbHost = id;
  host.dataset.imdbPending = id;
  delete host.dataset.imdbNo;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";

  const key = "c|" + id;
  const lb = loadingBadge(null, "imdb-card-badge");
  lb.dataset.surface = "card"; lb.dataset.key = key;
  host.appendChild(lb);
  lookup({ key, id, titles: [], fallbackTitles: cardTitleOf(a, host) }).then((res) => {
    if (host.dataset.imdbHost !== id) return;
    delete host.dataset.imdbPending;
    saveNetflixDiagnostic(id, res);
    host.querySelectorAll(':scope > .imdb-badge[data-surface="card"]').forEach((b) => b.remove());
    const badge = build(res, null, "imdb-card-badge") || buildDebugBadge(res, null, "imdb-card-badge");
    if (!badge) { host.dataset.imdbNo = id; return; }
    badge.dataset.surface = "card";
    badge.dataset.key = key;
    host.appendChild(badge);
  }).catch(() => {
    if (host.dataset.imdbHost === id) {
      delete host.dataset.imdbPending; host.dataset.imdbNo = id;
      host.querySelectorAll(':scope > .imdb-badge[data-surface="card"]').forEach((b) => b.remove());
    }
  });
}

function scanCards() {
  if (!S.showCards) return;
  document.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]').forEach((a) => {
    const id = idOf(a.getAttribute("href"));
    if (!id) return;
    if (a.closest(EPISODE_SEL)) return;                       // geen badge op losse afleveringen
    if (a.closest(MODAL_SEL) && !a.closest(CARD_SEL)) return; // knoppen/posters van de modal zelf
    if (!inView(a.getBoundingClientRect())) return;           // spaart OMDb-quota

    const host = cardHostForLink(a, id);
    if (!host) return;
    if (host.matches(MODAL_SEL) || host.querySelector(MODAL_SEL)) return;
    const outer = host.parentElement && host.parentElement.closest("[data-imdb-host]");
    if (outer && outer !== host) return;                      // nooit een badge in een badge-kaart
    if (host.querySelector("[data-imdb-host]")) return;
    host.classList.toggle("imdb-host-mini", host.getBoundingClientRect().width < 140);
    renderCard(host, id, a);
  });
}

// ---------- afspelen: badge kleiner of weg ----------
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

function scan() {
  try { updateModals(); } catch (e) { console.debug("[imdb] modals", e); }
  try { scanCards(); } catch (e) { console.debug("[imdb] cards", e); }
  syncPlayback();
}
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
