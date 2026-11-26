// Haalt ratings op via OMDb. Vervang fetchRating() later door een call naar je
// eigen backend die de officiële IMDb API (AWS Data Exchange) gebruikt.
const TTL = 7 * 24 * 60 * 60 * 1000;      // gevonden ratings: 7 dagen
const NEG_TTL = 12 * 60 * 60 * 1000;      // "niet gevonden": 12 uur
const PREFIX = "r3:";                     // nieuwe cache-versie (oude, foute resultaten vervallen)

// ---------- titel-vergelijking: voorkomt dat een verkeerde film wordt getoond ----------
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

function sim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (l.includes(s) && s.length / l.length >= 0.6) return 0.85;
  const A = new Set(a.split(" ")), B = new Set(b.split(" "));
  let i = 0; A.forEach((x) => B.has(x) && i++);
  return i / (A.size + B.size - i);
}

// ---------- OMDb ----------
async function omdb(params, apiKey) {
  const u = new URL("https://www.omdbapi.com/");
  u.search = new URLSearchParams({ apikey: apiKey, ...params });
  const res = await fetch(u);
  let d;
  try { d = await res.json(); } catch { throw new Error("fetch"); }
  if (d.Response === "False") {
    const e = d.Error || "";
    if (/invalid api key|no api key/i.test(e)) throw new Error("bad-key");
    if (/limit/i.test(e)) throw new Error("limit");
  }
  return d;
}

function map(d) {
  const r = parseFloat(d.imdbRating);
  const n = (x) => (x && x !== "N/A" ? x : null);
  const rt = (d.Ratings || []).find((x) => x.Source === "Rotten Tomatoes");
  const rtv = rt ? parseInt(rt.Value, 10) : NaN;
  return {
    rating: isNaN(r) ? null : r,
    rt: isNaN(rtv) ? null : rtv,
    id: n(d.imdbID), votes: n(d.imdbVotes), title: n(d.Title), year: n(d.Year),
    rated: n(d.Rated), runtime: n(d.Runtime), genre: n(d.Genre), director: n(d.Director),
    actors: n(d.Actors), plot: n(d.Plot), awards: n(d.Awards), poster: n(d.Poster),
    metascore: n(d.Metascore), boxOffice: n(d.BoxOffice), type: n(d.Type)
  };
}

// IMDb-suggesties kennen ook alternatieve (Engelse) titels van niet-Engelse producties,
// bv. Netflix' "The Golden Hour" = de Nederlandse serie "Het Gouden Uur".
async function suggest(title) {
  const q = norm(title).replace(/ /g, "_");
  if (!q) return [];
  try {
    const r = await fetch("https://v2.sg.media-imdb.com/suggestion/" + q[0] + "/" + q + ".json");
    const d = await r.json();
    return (d.d || [])
      .filter((x) => x.id && x.id.startsWith("tt") &&
        /^(movie|tvSeries|tvMiniSeries|tvMovie|tvSpecial|tvShort|video|short)$/.test(x.qid || ""))
      .map((x) => ({ id: x.id, title: x.l, year: x.y || null }));
  } catch { return []; }
}

async function fetchRating(title, key, year) {
  const yr = parseInt(year, 10) || null;
  const dbg = { q: title, y: yr, steps: [] };       // wordt als tooltip getoond bij "–"
  let fallback = null;                              // gevonden titel zonder rating
  const done = (m) => ({ ...m, dbg });
  const take = (m) => { if (m && m.rating != null) return m; if (m && !fallback) fallback = m; return null; };
  const byId = async (id) => {
    const d = await omdb({ i: id, plot: "short" }, key);
    dbg.steps.push("i=" + id + ":" + (d.Response === "True" ? d.imdbRating : d.Error));
    return d.Response === "True" ? map(d) : null;
  };

  // 1. IMDb-suggesties (kennen ook Engelse/alternatieve titels van niet-Engelse producties)
  const sug = await suggest(title);
  dbg.steps.push("suggesties:" + sug.length);
  // Titel telt zwaarst, jaar geeft een bonus. Alleen op jaar passen we toe voor titels waarvan
  // de naam afwijkt (bv. Engelse Netflix-titel van een Nederlandse serie). Een fout jaar blokkeert dus niets.
  const pick = sug.map((x) => {
      const s = sim(x.title, title), ym = !!(yr && x.year && Math.abs(x.year - yr) <= 1);
      return { x, s, ym, score: s + (ym ? 0.5 : 0) };
    }).filter((o) => o.s >= 0.6 || o.ym).sort((a, b) => b.score - a.score).map((o) => o.x);
  for (const x of pick.slice(0, 3)) { const m = take(await byId(x.id)); if (m) return done(m); }

  // 2. OMDb exacte titel (met jaar indien bekend)
  const d = await omdb({ t: title, ...(yr ? { y: yr } : {}), plot: "short" }, key);
  dbg.steps.push("t:" + (d.Response === "True" ? d.Title + "(" + d.imdbRating + ")" : d.Error));
  if (d.Response === "True" && sim(d.Title, title) >= 0.6) { const m = take(map(d)); if (m) return done(m); }

  // 3. OMDb zoeken en de best passende kiezen
  const s = await omdb({ s: title }, key);
  dbg.steps.push("s:" + (s.Response === "True" ? (s.Search || []).length : s.Error));
  if (s.Response === "True" && s.Search && s.Search.length) {
    const best = s.Search.filter((x) => x.Type !== "game" && x.Type !== "episode")
      .map((x) => ({ x, sc: sim(x.Title, title) + (yr && Math.abs(parseInt(x.Year, 10) - yr) <= 1 ? 0.2 : 0) }))
      .filter((o) => o.sc >= 0.6).sort((p, q) => q.sc - p.sc);
    for (const o of best.slice(0, 2)) { const m = take(await byId(o.x.imdbID)); if (m) return done(m); }
  }
  return done(fallback || { rating: null });
}

// max 4 gelijktijdige aanvragen + dubbele aanvragen samenvoegen
let active = 0; const queue = [];
function limit(fn) {
  return new Promise((res, rej) => { queue.push({ fn, res, rej }); pump(); });
}
function pump() {
  while (active < 4 && queue.length) {
    const j = queue.shift(); active++;
    j.fn().then(j.res, j.rej).finally(() => { active--; pump(); });
  }
}
const inflight = new Map();

async function getRating(title, year, nocache) {
  const key = PREFIX + norm(title) + (year ? ":" + year : "");
  const hit = (await chrome.storage.local.get([key]))[key];
  if (!nocache && hit && Date.now() - hit.t < (hit.v.rating == null ? NEG_TTL : TTL)) return hit.v;

  const { apiKey } = await chrome.storage.sync.get(["apiKey"]);
  if (!apiKey) return { error: "no-key" };

  if (!inflight.has(key)) {
    inflight.set(key, limit(() => fetchRating(title, apiKey, year)).finally(() => inflight.delete(key)));
  }
  const v = await inflight.get(key);
  await chrome.storage.local.set({ [key]: { t: Date.now(), v } });   // fouten worden NIET gecachet
  return v;
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg.type === "rating") {
    getRating(msg.title, msg.year, msg.nocache).then(send).catch((e) =>
      send({ error: ["bad-key", "limit"].includes(e && e.message) ? e.message : "fetch" }));
    return true;
  }
  if (msg.type === "options") chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === "install") chrome.runtime.openOptionsPage();
  // oude (foute) cache van versie 0.1 opruimen
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith("r2:"));
  if (old.length) chrome.storage.local.remove(old);
});
