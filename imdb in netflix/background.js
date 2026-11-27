// Haalt ratings op via OMDb. Vervang fetchRating() later door een call naar je
// eigen backend die de officiële IMDb API (AWS Data Exchange) gebruikt.
const TTL = 7 * 24 * 60 * 60 * 1000;      // gevonden ratings: 7 dagen
const NEG_TTL = 3 * 60 * 60 * 1000;      // "niet gevonden": 3 uur
const PREFIX = "r13:";                    // nieuwe cache-versie (oude, foute resultaten vervallen)

// ---------- titel-vergelijking: voorkomt dat een verkeerde film wordt getoond ----------
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

// "The Office" en "Office" zijn dezelfde titel; lidwoorden vooraan tellen niet mee.
const ARTICLES = /^(the|a|an|de|het|een|le|la|les|el|los|las|der|die|das|il|lo) /;
const tKey = (s) => norm(s).replace(ARTICLES, "");
const sameTitle = (a, b) => !!tKey(a) && tKey(a) === tKey(b);

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

// ---------- jaartallen ----------
// Netflix toont bij een serie het jaar van het LAATSTE seizoen (Lupin deel 4 = 2026),
// terwijl IMDb het startjaar geeft (2021). Daarom wordt voor series het hele
// looptijdbereik vergeleken, niet alleen het startjaar.
const year4 = (v) => parseInt(String(v || "").match(/\d{4}/)?.[0], 10) || null;
function yearRange(v) {
  const s = String(v || "").replace(/[\u2013\u2014]/g, "-");
  const m = s.match(/(\d{4})(?:\s*-\s*(\d{4})?)?/);
  if (!m) return null;
  return { start: +m[1], end: m[2] ? +m[2] : null, ranged: /-/.test(s) };
}
function yearFits(range, requested, bucket, slack) {
  const req = year4(requested);
  if (!req || !range) return true;
  if (bucket === "series") {
    const end = range.ranged ? range.end : range.start;   // open einde = loopt nog
    if (req < range.start - slack) return false;
    if (end && req > end + slack) return false;
    return true;
  }
  return Math.abs(req - range.start) <= slack;
}

// ---------- type (film / serie) ----------
const bucketOfSuggestion = (qid) =>
  /^(tvSeries|tvMiniSeries)$/i.test(qid || "") ? "series"
  : /^(movie|tvMovie|tvSpecial|tvShort|short|video)$/i.test(qid || "") ? "movie" : null;
const bucketOfRecord = (type) => type === "series" ? "series" : type === "movie" ? "movie" : null;
const typeOk = (bucket, requested) => !!bucket && (!requested || bucket === requested);

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

// IMDb-suggesties: gratis, snel, en met looptijd (yr) en populariteit (rank).
async function suggest(title, dbg) {
  const q = norm(title).replace(/ /g, "_");
  if (!q) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const r = await fetch("https://v2.sg.media-imdb.com/suggestion/" + q[0] + "/" + q + ".json", { signal: controller.signal });
    if (!r.ok) {
      if (dbg) dbg.steps.push("IMDb-suggesties HTTP " + r.status);
      return [];
    }
    const d = await r.json();
    return (d.d || [])
      .filter((x) => x.id && /^tt\d+$/.test(x.id) && bucketOfSuggestion(x.qid))
      .map((x) => ({
        id: x.id, title: x.l, year: x.y || null, range: x.yr || x.y || null,
        qid: x.qid, rank: Number.isFinite(+x.rank) ? +x.rank : 1e9
      }));
  } catch (error) {
    if (dbg) dbg.steps.push("IMDb-suggesties fout: " + (error && error.message || "onbekend"));
    return [];
  }
  finally { clearTimeout(timeout); }
}

const fatal = (error) => ["bad-key", "limit"].includes(error && error.message);

async function fetchRating(title, key, year, mediaType, strict) {
  const yr = year4(year);
  const dbg = { q: title, y: yr, steps: [] };
  const done = (result) => ({ ...result, dbg });
  const take = (record) => record && record.rating != null ? { ...record, verified: true } : null;
  const short = norm(title).split(" ").filter(Boolean).length < 2;

  // Een OMDb-record is pas goed als type en jaar kloppen (jaar met ruimte `slack`).
  const recordOk = (record, slack) => {
    if (!record) return false;
    const bucket = bucketOfRecord(record.type);
    return typeOk(bucket, mediaType) && yearFits(yearRange(record.year), yr, bucket, slack);
  };
  const byId = async (id) => {
    const data = await omdb({ i: id, plot: "short" }, key);
    dbg.steps.push("i=" + id + ":" + (data.Response === "True" ? data.imdbRating : data.Error));
    return data.Response === "True" ? map(data) : null;
  };

  // Korte titels zoals "Close", "Her" of "Up" zijn zonder jaar én type te ambigu.
  if (!yr && !mediaType && short) {
    dbg.steps.push("ambigue korte titel zonder jaar/type; match overgeslagen");
    return done({ rating: null });
  }

  // ---- route 1: IMDb-suggesties (geen OMDb-quota nodig voor het zoeken) ----
  const suggestions = await suggest(title, dbg);
  const typed = suggestions.filter((s) => typeOk(bucketOfSuggestion(s.qid), mediaType));
  dbg.steps.push("suggesties:" + suggestions.length + " (type ok:" + typed.length + ")");

  const fits = (s, slack) => yearFits(yearRange(s.range), yr, bucketOfSuggestion(s.qid), slack);
  const uniq = (list) => [...new Map(list.map((s) => [s.id, s])).values()];
  const exact = typed.filter((s) => sameTitle(s.title, title));

  // Eerst het strengste jaar, daarna geleidelijk ruimer.
  let pool = [], slackUsed = 0;
  for (const slack of [0, 1, 3]) {
    pool = uniq(exact.filter((s) => fits(s, slack)));
    if (pool.length) { slackUsed = slack; break; }
  }
  // Bijna-gelijke titel ("Lupin: Part 4") alleen met exact jaar.
  if (!pool.length && yr) {
    pool = uniq(typed.filter((s) => sim(s.title, title) >= 0.85 && fits(s, 0)));
    slackUsed = 0;
    if (pool.length) dbg.steps.push("titel ongeveer gelijk; jaar exact");
  }
  dbg.steps.push("kandidaten:" + pool.map((s) => s.id + "[" + s.title + "," + (s.range || "?") + "]").join(",") + " slack=" + slackUsed);

  if (pool.length) {
    pool.sort((a, b) => a.rank - b.rank);
    // Meerdere gelijknamige producties: zonder jaar niet gokken, met jaar de bekendste.
    // strict (kaartjes zonder jaar): bij meerdere gelijknamige titels nooit gokken.
    if (pool.length > 1 && !yr && (strict || pool[1].rank < pool[0].rank * 3)) {
      dbg.steps.push("ambigue IMDb-suggesties zonder jaar:" + pool.map((s) => s.id).join(","));
      return done({ rating: null });
    }
    try {
      const record = await byId(pool[0].id);
      if (recordOk(record, Math.max(slackUsed, 1))) {
        const result = take(record);
        if (result) return done(result);
        dbg.steps.push("match gevonden maar nog geen IMDb-score");
        return done({ rating: null, id: record.id });
      }
      dbg.steps.push("suggestie verworpen: type/jaar wijkt af");
    } catch (error) {
      if (fatal(error)) throw error;
      dbg.steps.push("i-fout:" + pool[0].id);
    }
  }

  // Zonder jaar en in strict-modus zijn de OMDb-titelroutes te gokkerig.
  if (strict && !yr) {
    dbg.steps.push("strict: geen jaar, geen unieke suggestie; OMDb-titelroutes overgeslagen");
    return done({ rating: null });
  }

  // ---- route 2: directe OMDb-titelzoekactie ----
  try {
    const params = { t: title, plot: "short" };
    if (mediaType) params.type = mediaType;
    const direct = await omdb(params, key);
    if (direct.Response === "True") {
      const record = map(direct);
      dbg.steps.push("t:" + direct.Title + "(" + direct.imdbRating + ")");
      if (sameTitle(record.title, title) && recordOk(record, 1)) {
        const result = take(record);
        if (result) return done(result);
      }
    }
  } catch (error) {
    if (fatal(error)) throw error;
    dbg.steps.push("t-fout:" + (error && error.message || "onbekend"));
  }

  // ---- route 3: OMDb-search als laatste vangnet ----
  if (yr || mediaType) {
    try {
      const params = { s: title };
      if (mediaType) params.type = mediaType;
      const search = await omdb(params, key);
      dbg.steps.push("s:" + (search.Response === "True" ? (search.Search || []).length : search.Error));
      if (search.Response === "True" && Array.isArray(search.Search)) {
        let matches = search.Search.filter((item) => {
          const bucket = bucketOfRecord(item.Type);
          return item.imdbID && sameTitle(item.Title, title) && typeOk(bucket, mediaType) &&
            yearFits(yearRange(item.Year), yr, bucket, 1);
        });
        matches = uniq(matches.map((m) => ({ id: m.imdbID, ...m })));
        if (matches.length === 1 || (matches.length > 1 && yr)) {
          const exactYear = matches.filter((m) => year4(m.Year) === yr);
          const choice = (exactYear.length === 1 ? exactYear : matches)[0];
          if (matches.length === 1 || exactYear.length === 1) {
            const record = await byId(choice.imdbID);
            if (recordOk(record, 1)) {
              const result = take(record);
              if (result) return done(result);
            }
          } else dbg.steps.push("ambigue OMDb-zoekresultaten:" + matches.map((m) => m.id).join(","));
        }
      }
    } catch (error) {
      if (fatal(error)) throw error;
      dbg.steps.push("s-fout:" + (error && error.message || "onbekend"));
    }
  }
  return done({ rating: null });
}


const TRAILER_TTL = 7 * 864e5;
async function tmdbJson(path, key) {
 const u=new URL("https://api.themoviedb.org/3"+path); u.searchParams.set("api_key",key);
 const c=new AbortController(),timer=setTimeout(()=>c.abort(),9000);
 try { const r=await fetch(u,{signal:c.signal}); if(!r.ok) throw new Error("tmdb-"+r.status); return await r.json(); }
 finally { clearTimeout(timer); }
}
async function getTrailer(msg) {
 const {tmdbApiKey,trailerEnabled}=await chrome.storage.sync.get(["tmdbApiKey","trailerEnabled"]);
 if(!trailerEnabled||!tmdbApiKey) return null;
 const ck="tr1:"+(msg.imdbId||norm(msg.title)+":"+(msg.year||"")+":"+(msg.mediaType||""));
 const cached=(await chrome.storage.local.get([ck]))[ck];
 if(cached&&Date.now()-cached.t<TRAILER_TTL) return cached.v;
 const kind=msg.mediaType==="series"?"tv":"movie"; let tmdbId=null;
 if(msg.imdbId&&/^tt\d+$/.test(msg.imdbId)) {
  const found=await tmdbJson("/find/"+encodeURIComponent(msg.imdbId)+"?external_source=imdb_id",tmdbApiKey);
  const list=kind==="tv"?(found.tv_results||[]):(found.movie_results||[]);
  const m=list.find(x=>{const d=kind==="tv"?x.first_air_date:x.release_date;const a=parseInt(String(d||"").slice(0,4),10),b=parseInt(String(msg.year||"").slice(0,4),10);return !a||!b||Math.abs(a-b)<=1;});
  if(m) tmdbId=m.id;
 }
 if(!tmdbId&&msg.title) {
  const s=await tmdbJson("/search/"+kind+"?query="+encodeURIComponent(msg.title)+(msg.year?(kind==="tv"?"&first_air_date_year=":"&year=")+encodeURIComponent(msg.year):"")+"&include_adult=false&language=nl-NL",tmdbApiKey);
  const titleOf=x=>kind==="tv"?x.name:x.title, dateOf=x=>kind==="tv"?x.first_air_date:x.release_date;
  const ranked=(s.results||[]).map(x=>({x,score:sim(titleOf(x),msg.title)})).filter(o=>o.score>=0.82&&(()=>{const a=parseInt(String(dateOf(o.x)||"").slice(0,4),10),b=parseInt(String(msg.year||"").slice(0,4),10);return !a||!b||Math.abs(a-b)<=1;})()).sort((a,b)=>b.score-a.score);
  if(ranked[0]) tmdbId=ranked[0].x.id;
 }
 if(!tmdbId){await chrome.storage.local.set({[ck]:{t:Date.now(),v:null}});return null;}
 let v=await tmdbJson("/"+kind+"/"+tmdbId+"/videos?language=nl-NL",tmdbApiKey);
 let list=(v.results||[]).filter(x=>x.site==="YouTube"&&x.key&&(x.type==="Trailer"||x.type==="Teaser"));
 if(!list.length){v=await tmdbJson("/"+kind+"/"+tmdbId+"/videos?language=en-US",tmdbApiKey);list=(v.results||[]).filter(x=>x.site==="YouTube"&&x.key&&(x.type==="Trailer"||x.type==="Teaser"));}
 const chosen=list.sort((a,b)=>(Number(b.official)-Number(a.official))||(Number(b.type==="Trailer")-Number(a.type==="Trailer")))[0];
 const result=chosen?{key:chosen.key,name:chosen.name||"Trailer"}:null;
 await chrome.storage.local.set({[ck]:{t:Date.now(),v:result}}); return result;
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

async function getRating(title, year, nocache, mediaType, strict) {
  const key = PREFIX + norm(title) + (year ? ":" + year : "") + ":" + (mediaType || "any") + (strict ? ":s" : "");
  const hit = (await chrome.storage.local.get([key]))[key];
  if (!nocache && hit && Date.now() - hit.t < (hit.v.rating == null ? NEG_TTL : TTL)) return hit.v;

  const { apiKey } = await chrome.storage.sync.get(["apiKey"]);
  if (!apiKey) return { error: "no-key" };

  if (!inflight.has(key)) {
    inflight.set(key, limit(() => fetchRating(title, apiKey, year, mediaType, strict)).finally(() => inflight.delete(key)));
  }
  const v = await inflight.get(key);
  await chrome.storage.local.set({ [key]: { t: Date.now(), v } });   // fouten worden NIET gecachet
  return v;
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg.type === "rating") {
    getRating(msg.title, msg.year, msg.nocache, msg.mediaType, msg.strict).then(send).catch((e) =>
      send({ error: ["bad-key", "limit"].includes(e && e.message) ? e.message : "fetch" }));
    return true;
  }
  if (msg.type === "trailer") { getTrailer(msg).then(send).catch(()=>send(null)); return true; }
  if (msg.type === "options") chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === "install") chrome.runtime.openOptionsPage();
  // Oude rating- en Netflix-metadata-caches opruimen na wijzigingen in de matcher.
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => /^(r\d+:)/.test(k) || /^(n\d+:)/.test(k));
  if (old.length) chrome.storage.local.remove(old);
});
