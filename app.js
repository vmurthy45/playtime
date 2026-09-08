/* Playtime — cross-platform play-time stats.
   Zero-build: plain JS, hand-rolled SVG charts, no dependencies.
   Data comes from data/*.json, written by the collectors in tools/. */

(() => {
  "use strict";

  const state = { games: [], snapshots: [], syncedAt: null };

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtH = (h) => (h >= 100 ? Math.round(h).toLocaleString() : h >= 10 ? h.toFixed(1) : h.toFixed(2).replace(/0$/, ""));
  const fmtDate = (iso) =>
    iso ? new Date(iso + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
  const year = (iso) => (iso ? iso.slice(0, 4) : null);
  const dayMs = 86400000;
  const toDay = (iso) => Math.floor(new Date(iso + "T00:00:00").getTime() / dayMs);
  const fromDay = (d) => new Date(d * dayMs).toISOString().slice(0, 10);

  const consoleColor = (c) => (c === "PS5" ? "var(--ps5)" : c === "PS4" ? "var(--ps4)" : "var(--other)");

  /* ---------------------------------------------------------------- load */

  async function load() {
    const [titles, snaps] = await Promise.all([
      fetch("data/psn_titles.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("data/snapshots.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);

    if (!titles) {
      const err = $("#loadError");
      err.hidden = false;
      err.textContent =
        "Couldn't load data/psn_titles.json. Run tools/psn_sync.py, or serve this folder over http (file:// blocks fetch).";
      $("#subtitle").textContent = "No data";
      return;
    }

    state.games = titles.games || [];
    state.snapshots = snaps || [];
    state.syncedAt = titles.syncedAt;

    render();
  }

  /* ------------------------------------------------------------- derive */

  // PSN reports lifetime totals, so per-day hours come from diffing snapshots.
  // A gap between snapshots gives a known total over an unknown split — those
  // days are marked estimated rather than silently drawn as fact.
  function dailySeries() {
    const snaps = state.snapshots.filter((s) => s.source === "psn").sort((a, b) => a.date.localeCompare(b.date));
    const days = [];
    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1], cur = snaps[i];
      let gained = 0;
      const perGame = {};
      for (const [id, hours] of Object.entries(cur.hours)) {
        const delta = hours - (prev.hours[id] || 0);
        if (delta > 0.005) { gained += delta; perGame[id] = delta; }
      }
      const from = toDay(prev.date) + 1, to = toDay(cur.date);
      const span = Math.max(1, to - from + 1);
      for (let d = from; d <= to; d++) {
        days.push({ date: fromDay(d), hours: gained / span, estimated: span > 1, perGame: span === 1 ? perGame : null });
      }
    }
    return { days, since: snaps.length ? snaps[0].date : null, snapshotCount: snaps.length };
  }

  /* ------------------------------------------------------------- render */

  function render() {
    const g = state.games;
    const totalH = g.reduce((s, x) => s + x.hours, 0);
    const firsts = g.map((x) => x.firstPlayed).filter(Boolean).sort();
    $("#subtitle").textContent = `${g.length} games · ${fmtH(totalH)} hours · since ${fmtDate(firsts[0])}`;
    if (state.syncedAt) {
      $("#syncedAt").textContent = "Last synced " + new Date(state.syncedAt).toLocaleString();
    }
    renderOverview(totalH);
    renderGames();
    renderTimeline();
    renderDaily();
  }

  /* --- overview --- */

  function renderOverview(totalH) {
    const g = state.games;
    const sessions = g.reduce((s, x) => s + (x.sessions || 0), 0);
    const played = g.filter((x) => x.hours > 0);
    const lasts = g.map((x) => x.lastPlayed).filter(Boolean).sort();
    const firsts = g.map((x) => x.firstPlayed).filter(Boolean).sort();
    const years = firsts.length ? (toDay(lasts[lasts.length - 1]) - toDay(firsts[0])) / 365.25 : 0;
    const cutoff = fromDay(toDay(new Date().toISOString().slice(0, 10)) - 365);
    const activeYear = g.filter((x) => x.lastPlayed && x.lastPlayed >= cutoff);

    $("#tiles").innerHTML = [
      [fmtH(totalH), "hours tracked"],
      [g.length, "games"],
      [sessions.toLocaleString(), "sessions launched"],
      [fmtH(totalH / Math.max(1, sessions)) + "h", "average session"],
      [years.toFixed(1) + " yrs", "of history"],
      [activeYear.length, "played in last 12 months"],
    ].map(([v, l]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");

    // Most played
    const top = [...played].sort((a, b) => b.hours - a.hours).slice(0, 10);
    const max = top.length ? top[0].hours : 1;
    $("#topList").innerHTML = top.map((x) => `
      <li>
        ${cover(x)}
        <div>
          <div class="name">${esc(x.title)}${pill(x.console)}</div>
          <div class="meta">${x.sessions} sessions · last played ${fmtDate(x.lastPlayed)}</div>
          <div class="bar" style="width:${(x.hours / max * 100).toFixed(1)}%;background:${consoleColor(x.console)}"></div>
        </div>
        <div class="hrs">${fmtH(x.hours)}h</div>
      </li>`).join("");

    // Games started per year
    const byYear = {};
    for (const x of g) { const y = year(x.firstPlayed); if (y) byYear[y] = (byYear[y] || 0) + 1; }
    $("#startedChart").innerHTML = columnChart(
      Object.keys(byYear).sort().map((y) => ({ label: y.slice(2), value: byYear[y], title: `${byYear[y]} games started in ${y}` }))
    );

    // Console split
    const byConsole = {};
    for (const x of g) { const c = x.console || "UNKNOWN"; byConsole[c] = (byConsole[c] || 0) + x.hours; }
    const parts = Object.entries(byConsole).sort((a, b) => b[1] - a[1]);
    const sum = parts.reduce((s, p) => s + p[1], 0) || 1;
    $("#consoleChart").innerHTML =
      `<div style="display:flex;height:26px;border-radius:7px;overflow:hidden;background:var(--surface-2)">` +
      parts.map(([c, h]) =>
        `<div title="${esc(c)}: ${fmtH(h)}h" style="width:${(h / sum * 100).toFixed(2)}%;background:${consoleColor(c)}"></div>`
      ).join("") + `</div>` +
      `<div class="legend">` + parts.map(([c, h]) =>
        `<span><i style="background:${consoleColor(c)}"></i>${esc(c === "UNKNOWN" ? "Other" : c)} — ${fmtH(h)}h (${Math.round(h / sum * 100)}%)</span>`
      ).join("") + `</div>`;

    // Longest average sessions (needs enough launches to mean anything)
    const avg = g.filter((x) => (x.sessions || 0) >= 5 && x.hours > 0)
      .map((x) => ({ ...x, avg: x.hours / x.sessions }))
      .sort((a, b) => b.avg - a.avg).slice(0, 12);
    $("#sessionChart").innerHTML = barRows(
      avg.map((x) => ({ label: x.title, value: x.avg, color: consoleColor(x.console), suffix: "h", extra: `${x.sessions} launches` }))
    );
  }

  // The PlayStation CDN 404s on a few older titles, so the initial is the
  // fallback rather than an empty grey square.
  const cover = (x) =>
    `<div class="cover"><span>${esc((x.title || "?").trim()[0])}</span>` +
    (x.cover ? `<img src="${esc(x.cover)}" alt="" loading="lazy" onerror="this.remove()">` : "") +
    `</div>`;
  const pill = (c) =>
    c && c !== "UNKNOWN" ? `<span class="pill pill--${c.toLowerCase()}">${esc(c)}</span>` : "";

  /* --- games --- */

  function renderGames() {
    const consoles = [...new Set(state.games.map((x) => x.console).filter((c) => c && c !== "UNKNOWN"))].sort();
    const sel = $("#consoleFilter");
    sel.innerHTML = `<option value="">All consoles</option>` + consoles.map((c) => `<option>${esc(c)}</option>`).join("");
    ["#search", "#sort", "#consoleFilter"].forEach((s) => $(s).addEventListener("input", drawGames));
    drawGames();
  }

  function drawGames() {
    const q = $("#search").value.trim().toLowerCase();
    const sort = $("#sort").value;
    const con = $("#consoleFilter").value;

    let list = state.games.filter((x) =>
      (!q || x.title.toLowerCase().includes(q)) && (!con || x.console === con));

    const cmp = {
      hours: (a, b) => b.hours - a.hours,
      recent: (a, b) => (b.lastPlayed || "").localeCompare(a.lastPlayed || ""),
      first: (a, b) => (b.firstPlayed || "").localeCompare(a.firstPlayed || ""),
      sessions: (a, b) => (b.sessions || 0) - (a.sessions || 0),
      avg: (a, b) => b.hours / (b.sessions || 1) - a.hours / (a.sessions || 1),
      title: (a, b) => a.title.localeCompare(b.title),
    }[sort];
    list = [...list].sort(cmp);

    const shown = list.reduce((s, x) => s + x.hours, 0);
    $("#gamesCount").textContent = `${list.length} of ${state.games.length} games · ${fmtH(shown)} hours`;

    $("#gameList").innerHTML = list.length ? list.map((x) => `
      <li class="card">
        ${cover(x)}
        <div>
          <div class="name">${esc(x.title)}${pill(x.console)}</div>
          <div class="meta">
            ${x.sessions} sessions · ${fmtH(x.hours / (x.sessions || 1))}h avg<br>
            ${fmtDate(x.firstPlayed)} → ${fmtDate(x.lastPlayed)}
          </div>
        </div>
        <div class="hrs"><b>${fmtH(x.hours)}h</b><span>${x.hours ? "" : "never played"}</span></div>
      </li>`).join("") : `<li class="empty">No games match.</li>`;
  }

  /* --- timeline --- */

  function renderTimeline() {
    $("#timelineCount").addEventListener("change", drawTimeline);
    drawTimeline();
  }

  function drawTimeline() {
    const limit = +$("#timelineCount").value;
    let games = state.games.filter((x) => x.firstPlayed && x.lastPlayed);
    games = [...games].sort((a, b) => b.hours - a.hours);
    if (limit) games = games.slice(0, limit);
    games.sort((a, b) => a.firstPlayed.localeCompare(b.firstPlayed));

    if (!games.length) { $("#timeline").innerHTML = `<p class="empty">No dated games yet.</p>`; return; }

    const minD = toDay(games.reduce((m, x) => (x.firstPlayed < m ? x.firstPlayed : m), games[0].firstPlayed));
    const maxD = toDay(state.games.reduce((m, x) => (x.lastPlayed && x.lastPlayed > m ? x.lastPlayed : m), games[0].lastPlayed));
    const rowH = 15, padL = 4, padT = 22, w = 1000;
    const h = padT + games.length * rowH + 6;
    const x = (d) => padL + ((d - minD) / Math.max(1, maxD - minD)) * (w - padL * 2);

    // year gridlines
    const y0 = +fromDay(minD).slice(0, 4), y1 = +fromDay(maxD).slice(0, 4);
    let grid = "";
    for (let y = y0; y <= y1; y++) {
      const gx = x(toDay(`${y}-01-01`));
      if (gx < padL || gx > w - padL) continue;
      grid += `<line x1="${gx.toFixed(1)}" y1="16" x2="${gx.toFixed(1)}" y2="${h}" stroke="var(--line)" stroke-width="1"/>` +
              `<text x="${(gx + 3).toFixed(1)}" y="11" font-size="10" fill="var(--muted)">${y}</text>`;
    }

    const rows = games.map((g, i) => {
      const x1 = x(toDay(g.firstPlayed)), x2 = Math.max(x(toDay(g.lastPlayed)), x1 + 2.5);
      const y = padT + i * rowH;
      const tip = `<title>${esc(g.title)} — ${fmtH(g.hours)}h\n${fmtDate(g.firstPlayed)} → ${fmtDate(g.lastPlayed)}</title>`;
      // Label after the bar, or before it once the bar runs too close to the
      // right edge — hover tooltips are useless on a phone.
      const after = x2 < w * 0.62;
      const label = `<text x="${(after ? x2 + 5 : x1 - 5).toFixed(1)}" y="${y + 7.5}" font-size="9.5"
        fill="var(--muted)" text-anchor="${after ? "start" : "end"}">${esc(g.title.slice(0, 42))}</text>`;
      return `<g>${tip}<rect x="${x1.toFixed(1)}" y="${y}" width="${(x2 - x1).toFixed(1)}" height="8" rx="4"
        fill="${consoleColor(g.console)}" opacity="0.85"/>${label}</g>`;
    }).join("");

    $("#timeline").innerHTML =
      `<svg viewBox="0 0 ${w} ${h}" style="min-width:640px" role="img" aria-label="Game rotation timeline">${grid}${rows}</svg>` +
      `<div class="legend">
         <span><i style="background:var(--ps4)"></i>PS4</span>
         <span><i style="background:var(--ps5)"></i>PS5</span>
         <span><i style="background:var(--other)"></i>Other</span>
       </div>`;
  }

  /* --- daily --- */

  function renderDaily() {
    const { days, since, snapshotCount } = dailySeries();

    if (!days.length) {
      $("#dailyHint").innerHTML = snapshotCount < 2
        ? `Only one snapshot so far (${since ? fmtDate(since) : "today"}). PSN reports lifetime totals, so a
           day-by-day breakdown needs two syncs to compare — this fills in from tomorrow.`
        : `No play time recorded between snapshots yet.`;
      $("#dailyChart").innerHTML = `<p class="empty">Nothing to plot yet.</p>`;
      $("#dailyBreakdown").innerHTML = "";
      return;
    }

    const recent = days.slice(-60);
    $("#dailyHint").innerHTML =
      `Derived by comparing daily snapshots, so it starts at ${fmtDate(since)} — anything before that is
       genuinely unknown, not zero. Hatched bars are windows where two syncs were more than a day apart:
       the total is real, the split across those days is an even guess.`;

    const max = Math.max(...recent.map((d) => d.hours), 0.5);
    const w = 1000, h = 180, pad = 18;
    const bw = (w - pad * 2) / recent.length;
    const bars = recent.map((d, i) => {
      const bh = (d.hours / max) * (h - pad * 2);
      const x = pad + i * bw, y = h - pad - bh;
      const fill = d.hours === 0 ? "var(--nodata)" : "var(--accent)";
      const style = d.estimated ? ` opacity="0.45" stroke="var(--accent)" stroke-dasharray="2 2"` : "";
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 1.5).toFixed(1)}"
        height="${Math.max(d.hours ? 1.5 : 0.8, bh).toFixed(1)}" rx="2" fill="${fill}"${style}>
        <title>${fmtDate(d.date)} — ${fmtH(d.hours)}h${d.estimated ? " (estimated across a multi-day gap)" : ""}</title></rect>`;
    }).join("");

    const total = recent.reduce((s, d) => s + d.hours, 0);
    $("#dailyChart").innerHTML =
      `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Hours per day">
         <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--line)"/>
         ${bars}
         <text x="${pad}" y="12" font-size="11" fill="var(--muted)">${fmtH(max)}h peak</text>
       </svg>
       <div class="gapnote"><span class="hatch"></span> estimated across a gap between syncs</div>`;

    const perGame = {};
    for (const d of recent) for (const [id, hrs] of Object.entries(d.perGame || {})) perGame[id] = (perGame[id] || 0) + hrs;
    const rows = Object.entries(perGame).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([id, hrs]) => {
        const g = state.games.find((x) => x.id === id);
        return { label: g ? g.title : id, value: hrs, color: consoleColor(g && g.console), suffix: "h" };
      });
    $("#dailyBreakdown").innerHTML = rows.length
      ? `<h2 class="h">What those hours went into</h2><div class="chartbox">${barRows(rows)}</div>
         <p class="hint" style="margin-top:10px">${fmtH(total)} hours across the last ${recent.length} days.</p>`
      : "";
  }

  /* ------------------------------------------------------- chart helpers */

  function columnChart(items) {
    if (!items.length) return `<p class="empty">No data.</p>`;
    const w = 1000, h = 170, pad = 22;
    const max = Math.max(...items.map((i) => i.value));
    const bw = (w - pad * 2) / items.length;
    return `<svg viewBox="0 0 ${w} ${h}" role="img">
      ${items.map((it, i) => {
        const bh = (it.value / max) * (h - pad * 2.2);
        const x = pad + i * bw, y = h - pad - bh;
        return `<rect x="${(x + 2).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 5).toFixed(1)}" height="${bh.toFixed(1)}"
                  rx="3" fill="var(--accent)" opacity=".85"><title>${esc(it.title || it.label)}</title></rect>
                <text x="${(x + bw / 2).toFixed(1)}" y="${h - 6}" font-size="10.5" fill="var(--muted)" text-anchor="middle">${esc(it.label)}</text>
                <text x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="10.5" fill="var(--muted)" text-anchor="middle">${it.value}</text>`;
      }).join("")}
    </svg>`;
  }

  function barRows(items) {
    if (!items.length) return `<p class="empty">No data.</p>`;
    const max = Math.max(...items.map((i) => i.value));
    return items.map((it) => `
      <div style="display:grid;grid-template-columns:1fr 62px;gap:10px;align-items:center;margin-bottom:7px">
        <div>
          <div style="font-size:13px;margin-bottom:3px">${esc(it.label)}${it.extra ? ` <span style="color:var(--muted)">· ${esc(it.extra)}</span>` : ""}</div>
          <div style="height:6px;border-radius:3px;background:${it.color || "var(--accent)"};width:${(it.value / max * 100).toFixed(1)}%"></div>
        </div>
        <div style="text-align:right;font-variant-numeric:tabular-nums;font-size:13px">${fmtH(it.value)}${it.suffix || ""}</div>
      </div>`).join("");
  }

  /* ---------------------------------------------------------------- tabs */

  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === btn));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("is-active", p.id === "panel-" + btn.dataset.tab));
    window.scrollTo({ top: 0 });
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  load();
})();
