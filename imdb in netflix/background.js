// Haalt ratings op via OMDb. Vervang fetchRating() later door een call naar je
// eigen backend die de officiële IMDb API (AWS Data Exchange) gebruikt.
const TTL = 7 * 24 * 60 * 60 * 1000;      // gevonden ratings: 7 dagen
const NEG_TTL = 3 * 60 * 60 * 1000;      // "niet gevonden": 3 uur
const PREFIX = "r4:";                     // nieuwe cache-versie (oude, foute resultaten vervallen)

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

function yearCompatible(candidateYear, requestedYear) {
  const a = parseInt(String(candidateYear || "").match(/\d{4}/)?.[0], 10);
  const b = parseInt(String(requestedYear || "").match(/\d{4}/)?.[0], 10);
  return !a || !b || Math.abs(a - b) <= 1;
}

function typeCompatible(candidateType, requestedType) {
  if (!requestedType) return true;
  const actual = String(candidateType || "").toLowerCase();
  if (requestedType === "series") return actual === "series";
  if (requestedType === "movie") return actual === "movie";
  return true;
}

function suggestionTypeCompatible(qid, requestedType) {
  if (!requestedType) return true;
  if (requestedType === "series") return /^(tvSeries|tvMiniSeries)$/i.test(qid || "");
  return /^(movie|tvMovie|tvSpecial|tvShort|short)$/i.test(qid || "");
}

// ---------- OMDb ----------
async function omdb(params, apiKey) {
  const u = new URL("https://www.omdbapi.com/");
  u.search = new URLSearchParams({ apikey: apiKey, ...params });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8500);
  let res;
  try { res = await fetch(u, { signal: controller.signal }); }
  finally { clearTimeout(timeout); }
  if (!res.ok) throw new Error("fetch");
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const r = await fetch("https://v2.sg.media-imdb.com/suggestion/" + q[0] + "/" + q + ".json", { signal: controller.signal });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.d || [])
      .filter((x) => x.id && x.id.startsWith("tt") &&
        /^(movie|tvSeries|tvMiniSeries|tvMovie|tvSpecial|tvShort|video|short)$/.test(x.qid || ""))
      .map((x) => ({ id: x.id, title: x.l, year: x.y || null, qid: x.qid || null }));
  } catch { return []; }
  finally { clearTimeout(timeout); }
}

async function fetchRating(title, key, year, mediaType) {
  const yr = parseInt(year, 10) || null;
  const dbg = { q: title, y: yr, steps: [] };
  let fallback = null;
  const done = (m) => ({ ...m, dbg });
  const take = (m) => {
    if (m && m.rating != null) return m;
    if (m && m.id && !fallback) fallback = m;
    return null;
  };
  const byId = async (id) => {
    const d = await omdb({ i: id, plot: "short" }, key);
    dbg.steps.push("i=" + id + ":" + (d.Response === "True" ? d.imdbRating : d.Error));
    return d.Response === "True" ? map(d) : null;
  };

  const [sug, direct] = await Promise.all([
    suggest(title),
    omdb({ t: title, ...(yr ? { y: yr } : {}), plot: "short" }, key)
      .catch((e) => {
        if (["bad-key", "limit"].includes(e && e.message)) throw e;
        dbg.steps.push("t-fout:" + (e && e.message || "onbekend"));
        return null;
      })
  ]);
  dbg.steps.push("suggesties:" + sug.length);

  if (direct) {
    dbg.steps.push("t:" + (direct.Response === "True" ? direct.Title + "(" + direct.imdbRating + ")" : direct.Error));
    if (direct.Response === "True") {
      const candidate = map(direct);
      const safe = sim(candidate.title, title) >= 0.6 &&
        typeCompatible(candidate.type, mediaType) &&
        yearCompatible(candidate.year, yr);
      if (safe) {
        const m = take(candidate);
        if (m) return done(m);
      }
    }
  }

  const pick = sug.map((x) => {
    const similarity = sim(x.title, title);
    const yearMatch = !!(yr && x.year && Math.abs(x.year - yr) <= 1);
    return { x, similarity, yearMatch, score: similarity + (yearMatch ? 0.15 : 0) };
  }).filter((o) => o.similarity >= 0.6 && suggestionTypeCompatible(o.x.qid, mediaType) && yearCompatible(o.x.year, yr))
    .sort((a, b) => b.score - a.score)
    .map((o) => o.x);

  const checked = await Promise.all(pick.slice(0, 3).map(async (x) => {
    try { return { x, m: await byId(x.id) }; }
    catch (e) {
      if (["bad-key", "limit"].includes(e && e.message)) throw e;
      dbg.steps.push("i-fout:" + x.id);
      return { x, m: null };
    }
  }));
  for (const item of checked) {
    if (!item.m || sim(item.m.title, title) < 0.6 || !typeCompatible(item.m.type, mediaType) || !yearCompatible(item.m.year, yr)) continue;
    const m = take(item.m);
    if (m) return done(m);
  }

  try {
    const search = await omdb({ s: title }, key);
    dbg.steps.push("s:" + (search.Response === "True" ? (search.Search || []).length : search.Error));
    if (search.Response === "True" && search.Search && search.Search.length) {
      const best = search.Search.filter((x) => x.Type !== "game" && x.Type !== "episode" && typeCompatible(x.Type, mediaType) && yearCompatible(x.Year, yr))
        .map((x) => ({ x, similarity: sim(x.Title, title), yearMatch: !!(yr && Math.abs(parseInt(x.Year, 10) - yr) <= 1) }))
        .filter((o) => o.similarity >= 0.6)
        .sort((a, b) => (b.similarity + (b.yearMatch ? 0.15 : 0)) - (a.similarity + (a.yearMatch ? 0.15 : 0)));
      const results = await Promise.all(best.slice(0, 2).map(async (o) => {
        try { return await byId(o.x.imdbID); }
        catch (e) {
          if (["bad-key", "limit"].includes(e && e.message)) throw e;
          return null;
        }
      }));
      for (const m0 of results) {
        if (!m0 || sim(m0.title, title) < 0.6 || !typeCompatible(m0.type, mediaType) || !yearCompatible(m0.year, yr)) continue;
        const m = take(m0);
        if (m) return done(m);
      }
    }
  } catch (e) {
    if (["bad-key", "limit"].includes(e && e.message)) throw e;
    dbg.steps.push("s-fout:" + (e && e.message || "onbekend"));
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

async function getRating(title, year, nocache, mediaType) {
  const key = PREFIX + norm(title) + (year ? ":" + year : "") + ":" + (mediaType || "any");
  const hit = (await chrome.storage.local.get([key]))[key];
  if (!nocache && hit && Date.now() - hit.t < (hit.v.rating == null ? NEG_TTL : TTL)) return hit.v;

  const { apiKey } = await chrome.storage.sync.get(["apiKey"]);
  if (!apiKey) return { error: "no-key" };

  if (!inflight.has(key)) {
    inflight.set(key, limit(() => fetchRating(title, apiKey, year, mediaType)).finally(() => inflight.delete(key)));
  }
  const v = await inflight.get(key);
  await chrome.storage.local.set({ [key]: { t: Date.now(), v } });   // fouten worden NIET gecachet
  return v;
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg.type === "rating") {
    getRating(msg.title, msg.year, msg.nocache, msg.mediaType).then(send).catch((e) =>
      send({ error: ["bad-key", "limit"].includes(e && e.message) ? e.message : "fetch" }));
    return true;
  }
  if (msg.type === "options") chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === "install") chrome.runtime.openOptionsPage();
  // Oude cacheversies opruimen; de nieuwe matcher gebruikt r4 en n2.
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => /^(r2:|r3:)/.test(k) || k.startsWith("n1:"));
  if (old.length) chrome.storage.local.remove(old);
});
