// Gedeelde weergave-code: gebruikt door content.js (Netflix) én options.js (voorbeeld).
globalThis.IMDbUI = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const sv = (tag, attrs, kids) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    (kids || []).forEach((c) => e.appendChild(c));
    return e;
  };
  const icon = (cls, vb, kids) =>
    sv("svg", { viewBox: vb, class: cls, "aria-hidden": "true", focusable: "false" }, kids);

  // ---------- iconen ----------
  const logo = () => {
    const t = sv("text", {
      x: 17, y: 12.4, "text-anchor": "middle", "font-family": "Arial Black, Arial, sans-serif",
      "font-weight": "900", "font-size": "11", fill: "#000", textLength: "27", lengthAdjust: "spacingAndGlyphs"
    });
    t.textContent = "IMDb";
    return icon("i-logo", "0 0 34 17", [sv("rect", { width: 34, height: 17, rx: 3, fill: "#f5c518" }), t]);
  };
  const star = () => icon("i-star", "0 0 24 24", [sv("path", {
    fill: "currentColor", d: "M12 2.2l2.95 6.1 6.7.9-4.9 4.65 1.25 6.65L12 17.2l-6 3.3 1.25-6.65-4.9-4.65 6.7-.9z"
  })]);
  const tomato = () => icon("i-tomato", "0 0 24 24", [
    sv("circle", { cx: 12, cy: 13.5, r: 8.5, fill: "#fa320a" }),
    sv("path", { fill: "#3f9b3a", d: "M12 5.4c-.4-1.9-1.9-3-3.7-2.7 1 .6 1.5 1.3 1.6 2.2-1.5-.4-2.9 0-3.7 1.1 1.6-.1 2.7.4 3.4 1.2L12 7.4l2.4-1.8c.7-.8 1.8-1.3 3.4-1.2-.8-1.1-2.2-1.5-3.7-1.1.1-.9.6-1.6 1.6-2.2-1.8-.3-3.3.8-3.7 2.7z" })
  ]);

  // ---------- hulpjes ----------
  const tier = (r) => (r >= 8 ? "great" : r >= 7 ? "good" : r >= 6 ? "ok" : "bad");
  const metaCls = (m) => { const n = +m; return n >= 61 ? "g" : n >= 40 ? "y" : "r"; };
  const fmtVotes = (v) => {
    const n = parseInt(String(v || "").replace(/[^\d]/g, ""), 10);
    if (!n) return null;
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(".0", "") + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(n);
  };

  // ---------- badge ----------
  function makeBadge(res, o, hooks) {
    o = Object.assign({ showMeta: true, showRT: true, showVotes: false, size: "m", style: "badge" }, o);
    hooks = hooks || {};
    const style = ["badge", "compact", "minimal"].includes(o.style) ? o.style : "badge";
    const a = h("a", "imdb-badge imdb-sz-" + o.size + " imdb-style-" + style);
    if (style !== "badge") a.classList.add("imdb-text");
    const setLink = () => {
      if (!res || !res.id) return;
      a.href = "https://www.imdb.com/title/" + res.id + "/";
      a.target = "_blank";
      a.rel = "noopener";
      a.addEventListener("click", (e) => e.stopPropagation());
    };
    const number = res && res.rating != null ? parseFloat(res.rating) : NaN;
    const hasRating = Number.isFinite(number);
    const hasRT = !!(res && res.rt != null && Number.isFinite(parseFloat(res.rt)));
    const hasMeta = !!(res && res.metascore && res.metascore !== "N/A");
    const detail = res && res.dbg
      ? " · gezocht: " + res.dbg.q + (res.dbg.y ? " (" + res.dbg.y + ")" : "") + " · " + (res.dbg.steps || []).join(" | ")
      : "";

    if (res && res.loading) {
      a.classList.add("imdb-loading");
      const dots = h("span", "imdb-dots");
      dots.append(h("i"), h("i"), h("i"));
      a.appendChild(dots);
      a.title = "IMDb-gegevens laden";
      return a;
    }

    const noRatingText = res && res.id ? "IMDb · geen score" : "IMDb · niet gevonden";
    if (style !== "badge") {
      let text = hasRating ? "IMDb " + number.toFixed(1) : noRatingText;
      const shortError = res && res.error === "no-key" ? "IMDb · key nodig"
        : res && res.error === "bad-key" ? "IMDb · key ongeldig"
        : res && res.error === "limit" ? "IMDb · limiet bereikt"
        : res && res.error ? "IMDb · niet beschikbaar" : null;
      if (!hasRating && shortError) text = shortError;
      if (style === "compact") {
        if (o.showRT && hasRT) text += " · RT " + res.rt + "%";
        if (o.showMeta && hasMeta) text += " · Meta " + res.metascore;
        if (o.showVotes && res.votes) text += " · " + fmtVotes(res.votes);
      }
      a.appendChild(h("span", "imdb-inline-text", text));
      if (res && res.error) a.title = "IMDb: " + res.error + detail;
      else a.title = hasRating ? "IMDb " + number.toFixed(1) + "/10" + detail : noRatingText + detail;
      if (res && res.error === "no-key") {
        a.title = "Klik om je gratis OMDb-key in te stellen";
        a.href = "#";
        a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); hooks.onOptions && hooks.onOptions(); });
      } else setLink();
      return a;
    }

    const err = (txt, tip, act) => {
      a.classList.add("imdb-muted");
      a.append(logo(), h("span", null, txt));
      a.title = tip;
      if (act) {
        a.href = "#";
        a.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          hooks.onOptions && hooks.onOptions();
        });
      }
    };

    if (hasRating || hasRT || hasMeta) {
      if (hasRating) {
        a.classList.add("imdb-t-" + tier(number));
        const sc = h("span", "imdb-score");
        sc.append(h("span", "n", number.toFixed(1)), h("small", null, "/10"));
        a.append(logo(), star(), sc);
      } else {
        a.classList.add("imdb-muted");
        a.append(logo(), h("span", "imdb-score-label", res && res.id ? "geen IMDb-score" : "IMDb-score ontbreekt"));
      }

      const v = o.showVotes && fmtVotes(res && res.votes);
      if (v && hasRating) a.append(h("span", "imdb-votes", v));
      if (o.showRT && hasRT) {
        const c = h("span", "imdb-chip imdb-rt");
        c.title = "Rotten Tomatoes";
        c.append(tomato(), document.createTextNode(res.rt + "%"));
        a.append(c);
      }
      if (o.showMeta && hasMeta) {
        const c = h("span", "imdb-chip imdb-mg imdb-mg-" + metaCls(res.metascore), res.metascore);
        c.title = "Metascore";
        a.append(c);
      }
      if (res && res.id) setLink();
      a.title = (hasRating ? "IMDb " + number.toFixed(1) + "/10" : noRatingText) + detail;
      return a;
    }

    const e = res && res.error;
    if (e === "no-key") err("key instellen", "Klik om je gratis OMDb-key in te stellen", true);
    else if (e === "bad-key") err("key ongeldig", "Klik om je OMDb-key te controleren", true);
    else if (e === "limit") err("daglimiet bereikt", "OMDb staat 1.000 aanvragen per dag toe. Morgen werkt het weer.");
    else if (e === "ctx") err("ververs pagina", "De extensie is bijgewerkt: ververs de pagina");
    else if (e === "fetch") err("ophalen mislukt", "De gegevens konden niet worden opgehaald. Probeer het later opnieuw.");
    else if (e) err("niet beschikbaar", "Ophalen mislukt: " + e);
    else err("geen IMDb-score", "Geen betrouwbare IMDb-match gevonden" + detail);
    return a;
  }

  // ---------- infokaart ----------
  const row = (label, val) => {
    if (!val) return null;
    const d = h("div", "imdb-row");
    d.append(h("b", null, label), document.createTextNode(val));
    return d;
  };

  function buildCard(res) {
    const card = h("div", "imdb-card");
    if (res.poster) {
      const img = h("img");
      img.src = res.poster;
      img.alt = "";
      card.appendChild(img);
    }
    const body = h("div", "imdb-card-body");
    body.appendChild(h("div", "imdb-card-title", (res.title || "") + (res.year ? " (" + res.year + ")" : "")));

    const sub = [res.rated, res.runtime, res.type === "series" ? "Serie" : res.type === "movie" ? "Film" : null]
      .filter(Boolean).join(" · ");
    if (sub) body.appendChild(h("div", "imdb-card-sub", sub));

    const sc = h("div", "imdb-card-scores");
    if (res.rating != null && Number.isFinite(parseFloat(res.rating))) {
      const big = h("div", "imdb-big imdb-t-" + tier(parseFloat(res.rating)));
      big.append(star(), h("span", "n", parseFloat(res.rating).toFixed(1)), h("small", null, "/10"));
      const v = fmtVotes(res.votes);
      if (v) big.append(h("em", null, v + " stemmen"));
      sc.appendChild(big);
    } else {
      sc.appendChild(h("span", "imdb-card-no-rating", res.id ? "Nog geen IMDb-score" : "Geen IMDb-score beschikbaar"));
    }
    if (res.rt != null) {
      const c = h("span", "imdb-chip imdb-rt");
      c.append(tomato(), document.createTextNode(res.rt + "%"));
      sc.appendChild(c);
    }
    if (res.metascore) sc.appendChild(h("span", "imdb-chip imdb-mg imdb-mg-" + metaCls(res.metascore), res.metascore));
    body.appendChild(sc);

    if (res.genre) {
      const g = h("div", "imdb-genres");
      res.genre.split(",").forEach((x) => g.appendChild(h("span", null, x.trim())));
      body.appendChild(g);
    }
    if (res.plot) body.appendChild(h("p", null, res.plot));
    [row("Regie", res.director), row("Cast", res.actors), row("Awards", res.awards), row("Box office", res.boxOffice)]
      .forEach((r) => r && body.appendChild(r));
    card.appendChild(body);
    return card;
  }

  return { makeBadge, buildCard, logo, star };
})();
