
const $ = (id) => document.getElementById(id);\nconst I18N = {
 en: {
  pageTitle:"See IMDb ratings on every Netflix title",lead:"This extension adds IMDb, Rotten Tomatoes and Metascore ratings to Netflix title cards. Hover over a badge to see the poster, plot and cast. A free API key is required to retrieve ratings.",
  getKey:"Get a free API key",keyIntro:"It takes about two minutes and is free. The free OMDb plan includes 1,000 requests per day. Ratings are cached for a week to reduce requests.",
  step1Title:"Open the OMDb signup page",step1Text:'OMDb provides the ratings. Open <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener">omdbapi.com/apikey.aspx</a> in a new tab.',
  step2Title:"Choose FREE and enter your email address",step2Text:'Choose the free plan (1,000 requests per day), enter your details and press Submit. You can enter “Personal” in the “Use” field.',
  step3Title:"Activate your key by email",step3Text:"You’ll receive an email with your key. Click the activation link in that email or the key won’t work. Didn’t receive it? Check your spam folder.",
  step4Title:"Paste your key below",step4Text:"Copy the key from the email and paste it below. You can also paste the full activation link; the key will be extracted automatically.",
  yourKey:"Your API key",testSave:"Test and save",display:"Display",rottenTomatoes:"Rotten Tomatoes",rottenHelp:"Show the Rotten Tomatoes score in the badge",metaHelp:"Show the Metacritic score",
  votes:"Vote count",votesHelp:"For example, 2.9M next to the rating",hoverCard:"Hover info card",hoverHelp:"Show poster, plot, cast and awards when hovering over a badge",
  debug:"Debug mode",debugHelp:"Also show badges for missing results, with details in the tooltip",size:"Size",small:"Small",normal:"Medium",large:"Large",
  troubleshooting:"Troubleshooting",diagnoseTitle:"Diagnosis: why aren’t ratings showing?",diagnoseHelp:"Test the connection and look up a title (use the title and year as shown on Netflix). Share the result if it doesn’t work.",
  startDiagnosis:"Run diagnosis",cacheHelp:"Ratings incorrect or outdated?",clearCache:"Clear cache",refreshNetflix:"and refresh Netflix.",
  missingHint:"Seeing “–” for a title? Some titles may not be found, especially when Netflix uses a localized title. The extension prefers showing no score over displaying a rating for the wrong movie or series.",
  credit:'Created by <strong>adminmossel</strong> · Meppel, The Netherlands',
  show:"Show",hide:"Hide",saved:"Saved",pasteKey:"Please paste your key first.",invalidKey:"This key was not recognised. Did you click the activation link in the email? Also check that you copied the complete key.",
  keyWorks:"Key verified and saved. Open Netflix and refresh the page.",limit:"Key saved. Your daily limit of 1,000 requests has already been reached. Try again tomorrow.",
  savedTestFailed:"Key saved, but the test failed ({reason}). Please try again later.",noConnection:"no connection",unknownError:"unknown error",
  cacheCleared:"Cache cleared ({count})",diagnosing:"Running…",omdbCheck:"OMDb t=Chicago P.D.",imdbCheck:"IMDb suggestions",
  suggestionError:"Suggestions error: ",fetchError:"Fetch error: "
 },
 nl: {
  pageTitle:"Bekijk IMDb-scores bij elke Netflix-titel",lead:"Deze extensie toont IMDb-, Rotten Tomatoes- en Metascore-scores op Netflix-kaartjes. Beweeg over een badge voor de poster, plot en cast. Voor het ophalen van scores is een gratis API-key nodig.",
  getKey:"Gratis API-key aanvragen",keyIntro:"Dit duurt ongeveer twee minuten en is gratis. Het gratis OMDb-abonnement biedt 1.000 aanvragen per dag. Scores worden een week bewaard om aanvragen te beperken.",
  step1Title:"Open de OMDb-aanmeldpagina",step1Text:'OMDb levert de scores. Open <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener">omdbapi.com/apikey.aspx</a> in een nieuw tabblad.',
  step2Title:"Kies FREE en vul je e-mailadres in",step2Text:'Kies het gratis abonnement (1.000 aanvragen per dag), vul je gegevens in en klik op Submit. Bij “Use” kun je “Personal” invullen.',
  step3Title:"Activeer je key via e-mail",step3Text:"Je ontvangt een e-mail met je key. Klik op de activatielink, anders werkt de key niet. Niets ontvangen? Controleer je spammap.",
  step4Title:"Plak je key hieronder",step4Text:"Kopieer de key uit de e-mail en plak hem hieronder. Je kunt ook de volledige activatielink plakken; de key wordt automatisch eruit gehaald.",
  yourKey:"Jouw API-key",testSave:"Testen en opslaan",display:"Weergave",rottenTomatoes:"Rotten Tomatoes",rottenHelp:"Toon de Rotten Tomatoes-score in de badge",metaHelp:"Toon de Metacritic-score",
  votes:"Aantal stemmen",votesHelp:"Bijvoorbeeld 2,9M naast de score",hoverCard:"Infokaart bij hover",hoverHelp:"Toon poster, plot, cast en awards wanneer je over een badge beweegt",
  debug:"Foutopsporing",debugHelp:"Toon ook badges bij ontbrekende resultaten, met uitleg in de tooltip",size:"Grootte",small:"Klein",normal:"Normaal",large:"Groot",
  troubleshooting:"Problemen oplossen",diagnoseTitle:"Diagnose: waarom zie ik geen scores?",diagnoseHelp:"Test de verbinding en zoek een titel op (gebruik de titel en het jaar zoals Netflix die toont). Deel het resultaat als het niet werkt.",
  startDiagnosis:"Diagnose starten",cacheHelp:"Klopt een score niet of is die verouderd?",clearCache:"Cache legen",refreshNetflix:"en vernieuw Netflix.",
  missingHint:"Zie je “–” bij een titel? Sommige titels worden niet gevonden, vooral wanneer Netflix een vertaalde titel gebruikt. De extensie toont liever geen score dan een score van de verkeerde film of serie.",
  credit:"Gemaakt door <strong>adminmossel</strong> · Meppel, Nederland",
  show:"Tonen",hide:"Verbergen",saved:"Opgeslagen",pasteKey:"Plak eerst je key.",invalidKey:"Deze key wordt niet herkend. Heb je op de activatielink in de e-mail geklikt? Controleer ook of je de volledige key hebt gekopieerd.",
  keyWorks:"Key gecontroleerd en opgeslagen. Open Netflix en vernieuw de pagina.",limit:"Key opgeslagen. De dagelijkse limiet van 1.000 aanvragen is al bereikt. Probeer het morgen opnieuw.",
  savedTestFailed:"Key opgeslagen, maar testen is mislukt ({reason}). Probeer het later opnieuw.",noConnection:"geen verbinding",unknownError:"onbekende fout",
  cacheCleared:"Cache geleegd ({count})",diagnosing:"Bezig…",omdbCheck:"OMDb t=Chicago P.D.",imdbCheck:"IMDb-suggesties",
  suggestionError:"Suggestiefout: ",fetchError:"Ophaalfout: "
 }
};
let language = "en";
function tr(key, vars={}) {
 const value = I18N[language][key] || I18N.en[key] || key;
 return value.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "");
}
function setLanguage(lang) {
 language = lang === "nl" ? "nl" : "en";
 document.documentElement.lang = language;
 document.title = language === "nl" ? "IMDb Rating voor Netflix" : "IMDb Ratings for Netflix";
 document.querySelectorAll("[data-i18n]").forEach(el => {
  const key = el.dataset.i18n;
  if (I18N[language][key]) el.innerHTML = I18N[language][key];
 });
 $("langEn").setAttribute("aria-pressed", String(language === "en"));
 $("langNl").setAttribute("aria-pressed", String(language === "nl"));
 $("languageLabel").textContent = language === "nl" ? "Taal" : "Language";
 $("key").placeholder = language === "nl" ? "bijvoorbeeld a1b2c3d4" : "e.g. a1b2c3d4";
 $("key").setAttribute("aria-label", language === "nl" ? "OMDb API-key" : "OMDb API key");
 $("eye").textContent = tr($("eye").dataset.visible === "true" ? "hide" : "show");
 $("dq").setAttribute("aria-label", language === "nl" ? "Titel" : "Title");
 $("dy").setAttribute("aria-label", language === "nl" ? "Jaar" : "Year");
}
$("langEn").addEventListener("click", async () => { setLanguage("en"); await chrome.storage.sync.set({language:"en"}); });
$("langNl").addEventListener("click", async () => { setLanguage("nl"); await chrome.storage.sync.set({language:"nl"}); });
chrome.storage.sync.get(["language"]).then(d => setLanguage(d.language || "en"));

const $ = (id) => document.getElementById(id);
const DEF = { showMeta: true, showRT: true, showVotes: false, showCard: true, size: "m", debug: false };
let S = { ...DEF };
const SAMPLE = {
  rating: 8.1, rt: 92, metascore: "74", votes: "1,234,567", id: "tt0000000",
  title: "Voorbeeldtitel", year: "2024", rated: "PG-13", runtime: "118 min", type: "movie",
  genre: "Drama, Thriller", director: "Jan Jansen", actors: "Anna de Vries, Pieter Bakker",
  plot: "Zo ziet de infokaart eruit als je op een badge wijst.", awards: "3 wins & 5 nominations", boxOffice: "$42,000,000"
};
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- hero: rating telt op ----------
(() => {
  const b = IMDbUI.makeBadge(SAMPLE, { showMeta: true, showRT: true, size: "xl" });
  b.removeAttribute("href");
  $("heroBadge").appendChild(b);
  const n = b.querySelector(".n");
  if (reduced) return;
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / 1100);
    n.textContent = (SAMPLE.rating * (1 - Math.pow(1 - p, 3))).toFixed(1);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();

// ---------- toast ----------
let tt;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(tt);
  tt = setTimeout(() => t.classList.remove("show"), 1600);
}

// ---------- voorbeeld ----------
function renderPreview() {
  $("pv").replaceChildren(IMDbUI.makeBadge(SAMPLE, S));
  $("pvc").replaceChildren(...(S.showCard ? [IMDbUI.buildCard(SAMPLE)] : []));
}
function syncUI() {
  ["showRT", "showMeta", "showVotes", "showCard", "debug"].forEach((k) => ($(k).checked = !!S[k]));
  document.querySelectorAll("#size button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === S.size)));
  renderPreview();
}
async function save(patch) {
  S = { ...S, ...patch };
  await chrome.storage.sync.set(patch);
  syncUI();
  toast(tr("saved"));
}
["showRT", "showMeta", "showVotes", "showCard", "debug"].forEach((k) => $(k).addEventListener("change", (e) => save({ [k]: e.target.checked })));
$("size").addEventListener("click", (e) => { const v = e.target.dataset && e.target.dataset.v; if (v) save({ size: v }); });

// ---------- key testen en opslaan ----------
const ICON = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" opacity=".35"/><path class="draw" d="M7 12.5l3.5 3.5L17 9"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 3l10 18H2z" opacity=".5"/><path d="M12 10v5M12 18v.5"/></svg>',
  err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10" opacity=".35"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/></svg>'
};
function status(kind, text) {
  const s = $("status");
  s.className = "status show " + kind;
  s.replaceChildren();
  const i = document.createElement("span");
  i.innerHTML = ICON[kind];             // vaste, eigen SVG (geen gebruikersinvoer)
  const t = document.createElement("span");
  t.textContent = text;
  s.append(i.firstChild, t);
}
function extractKey(v) {
  v = v.trim();
  const m = v.match(/apikey=([a-z0-9]+)/i);   // hele activatielink geplakt? haal de key eruit
  return m ? m[1] : v;
}
async function testKey(key) {
  try {
    const r = await fetch("https://www.omdbapi.com/?apikey=" + encodeURIComponent(key) + "&i=tt0111161");
    const d = await r.json();
    if (d.Response === "True") return "ok";
    if (/limit/i.test(d.Error || "")) return "limit";
    if (/invalid|no api key/i.test(d.Error || "")) return "invalid";
    return "other";
  } catch { return "network"; }
}
$("save").addEventListener("click", async () => {
  const key = extractKey($("key").value);
  if (!key) return status("err", tr("pasteKey"));
  $("key").value = key;
  const b = $("save");
  b.disabled = true; b.classList.add("busy");
  const r = await testKey(key);
  b.disabled = false; b.classList.remove("busy");
  if (r === "invalid") return status("err", tr("invalidKey"));
  await chrome.storage.sync.set({ apiKey: key });
  if (r === "ok") status("ok", tr("keyWorks"));
  else if (r === "limit") status("warn", tr("limit"));
  else status("warn", tr("savedTestFailed", {reason:r === "network" ? tr("noConnection") : tr("unknownError")}));
});
$("key").addEventListener("keydown", (e) => e.key === "Enter" && $("save").click());
$("eye").dataset.visible = "false";\n$("eye").addEventListener("click", () => {
  const show = $("key").type === "password";
  $("key").type = show ? "text" : "password";
  $("eye").dataset.visible = String(show);\n  $("eye").textContent = tr(show ? "hide" : "show");
  $("eye").setAttribute("aria-pressed", String(show));
});

// ---------- cache leegmaken ----------
$("clear").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => /^r\d+:/.test(k));
  await chrome.storage.local.remove(keys);
  toast(tr("cacheCleared", {count:keys.length}));
});

// ---------- laden ----------
chrome.storage.sync.get([...Object.keys(DEF), "apiKey"]).then((d) => {
  S = { ...DEF, ...d };
  $("key").value = d.apiKey || "";
  syncUI();
});

// ---------- diagnose ----------
$("diag").addEventListener("click", async () => {
  const out = $("diagOut");
  out.textContent = tr("diagnosing");
  const key = extractKey($("key").value) || (await chrome.storage.sync.get(["apiKey"])).apiKey || "";
  const L = [];
  const show = (name, p) => p.then(async (r) => L.push(name + " [" + r.status + "]: " + (await r.text()).slice(0, 260)))
                            .catch((e) => L.push(name + " FOUT: " + e.message));
  await show(tr("omdbCheck"), fetch("https://www.omdbapi.com/?apikey=" + encodeURIComponent(key) + "&t=Chicago+P.D."));
  await show(tr("imdbCheck"), fetch("https://v2.sg.media-imdb.com/suggestion/c/chicago_p_d.json"));
  const dq = $("dq").value.trim() || "Chicago P.D.", dy = parseInt($("dy").value, 10) || undefined;
  const q = dq.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  try {
    const r = await fetch("https://v2.sg.media-imdb.com/suggestion/" + q[0] + "/" + q + ".json");
    const d = await r.json();
    L.push('Suggesties voor "' + dq + '": ' + ((d.d || []).slice(0, 6).map((x) => x.id + " " + x.l + " (" + x.y + ", " + x.qid + ")").join(" | ") || "geen"));
  } catch (e) { L.push(tr("suggestionError") + e.message); }
  try {
    const bg = await chrome.runtime.sendMessage({ type: "rating", title: dq, year: dy, nocache: true });
    L.push("Extensie voor \"" + dq + "\": " + JSON.stringify(bg).slice(0, 500));
  } catch (e) { L.push(tr("fetchError") + e.message); }
  out.textContent = L.join("\n\n");
});

$("ver").textContent = "Versie " + chrome.runtime.getManifest().version;
