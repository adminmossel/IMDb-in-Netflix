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
  toast("Opgeslagen");
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
  if (!key) return status("err", "Plak eerst je key in het veld.");
  $("key").value = key;
  const b = $("save");
  b.disabled = true; b.classList.add("busy");
  const r = await testKey(key);
  b.disabled = false; b.classList.remove("busy");
  if (r === "invalid") return status("err", "Deze key wordt niet herkend. Heb je op de activatielink in de e-mail geklikt? Controleer ook of je de hele key hebt gekopieerd.");
  await chrome.storage.sync.set({ apiKey: key });
  if (r === "ok") status("ok", "Key werkt en is opgeslagen. Open Netflix en ververs de pagina.");
  else if (r === "limit") status("warn", "Key opgeslagen. Let op: je daglimiet van 1.000 is vandaag al bereikt. Morgen werkt het weer.");
  else status("warn", "Key opgeslagen, maar testen lukte niet (" + (r === "network" ? "geen verbinding" : "onbekende fout") + "). Probeer het later nog eens.");
});
$("key").addEventListener("keydown", (e) => e.key === "Enter" && $("save").click());
$("eye").addEventListener("click", () => {
  const show = $("key").type === "password";
  $("key").type = show ? "text" : "password";
  $("eye").textContent = show ? "Verbergen" : "Tonen";
  $("eye").setAttribute("aria-pressed", String(show));
});

// ---------- cache leegmaken ----------
$("clear").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => /^r\d+:/.test(k));
  await chrome.storage.local.remove(keys);
  toast("Cache geleegd (" + keys.length + ")");
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
  out.textContent = "Bezig…";
  const key = extractKey($("key").value) || (await chrome.storage.sync.get(["apiKey"])).apiKey || "";
  const L = [];
  const show = (name, p) => p.then(async (r) => L.push(name + " [" + r.status + "]: " + (await r.text()).slice(0, 260)))
                            .catch((e) => L.push(name + " FOUT: " + e.message));
  await show("OMDb t=Chicago P.D.", fetch("https://www.omdbapi.com/?apikey=" + encodeURIComponent(key) + "&t=Chicago+P.D."));
  await show("IMDb-suggesties", fetch("https://v2.sg.media-imdb.com/suggestion/c/chicago_p_d.json"));
  const dq = $("dq").value.trim() || "Chicago P.D.", dy = parseInt($("dy").value, 10) || undefined;
  const q = dq.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  try {
    const r = await fetch("https://v2.sg.media-imdb.com/suggestion/" + q[0] + "/" + q + ".json");
    const d = await r.json();
    L.push('Suggesties voor "' + dq + '": ' + ((d.d || []).slice(0, 6).map((x) => x.id + " " + x.l + " (" + x.y + ", " + x.qid + ")").join(" | ") || "geen"));
  } catch (e) { L.push("Suggesties FOUT: " + e.message); }
  try {
    const bg = await chrome.runtime.sendMessage({ type: "rating", title: dq, year: dy, nocache: true });
    L.push("Extensie voor \"" + dq + "\": " + JSON.stringify(bg).slice(0, 500));
  } catch (e) { L.push("Extensie FOUT: " + e.message); }
  out.textContent = L.join("\n\n");
});

$("ver").textContent = "Versie " + chrome.runtime.getManifest().version;
