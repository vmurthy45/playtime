/* Playtime — cross-platform play-time stats.
   Zero-build: plain JS, hand-rolled SVG charts, no dependencies.
   Data comes from data/*.json, written by the collectors in tools/. */

(() => {
  "use strict";

  const SOURCES = [
    { file: "data/psn_titles.json", label: "PlayStation" },
    { file: "data/steam_titles.json", label: "Steam" },
  ];

  // entries = one record per game per platform. groups = the same game merged
  // across platforms, which is what the lists actually show.
  const state = { entries: [], groups: [], snapshots: [], aliases: {}, synced: [] };

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtH = (h) => (h >= 100 ? Math.round(h).toLocaleString() : h >= 10 ? h.toFixed(1) : h.toFixed(2).replace(/0$/, ""));
  const fmtDate = (iso) =>
    iso ? new Date(iso + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
  const year = (iso) => (iso ? iso.slice(0, 4) : null);
  const dayMs = 86400000;
  const toDay = (iso) => Math.floor(new Date(iso + "T00:00:00").getTime() / dayMs);
  const fromDay = (d) => new Date(d * dayMs).toISOString().slice(0, 10);
  const minDate = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
  const maxDate = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

  const TINT = { PS4: "var(--ps4)", PS5: "var(--ps5)", Steam: "var(--steam)" };
  const tint = (c) => TINT[c] || "var(--other)";

  /* ---------------------------------------------------------------- load */

  const getJSON = (url) =>
    fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  async function load() {
    const [files, snaps, aliases] = await Promise.all([
      Promise.all(SOURCES.map((s) => getJSON(s.file))),
      getJSON("data/snapshots.json"),
      getJSON("data/aliases.json"),
    ]);

    // Keys starting with "_" are notes in the file, not mappings.
    state.aliases = Object.fromEntries(
      Object.entries(aliases || {}).filter(([k]) => !k.startsWith("_")));
    state.snapshots = snaps || [];
    files.forEach((f) => {
      if (!f) return;
      // Older syncs wrote the raw enum name; "Other" is what the UI shows.
      for (const g of f.games || []) {
        if (g.console === "UNKNOWN" || !g.console) g.console = "Other";
        state.entries.push(g);
      }
      if (f.syncedAt) state.synced.push({ source: f.source, at: f.syncedAt });
    });

    if (!state.entries.length) {
      const err = $("#loadError");
      err.hidden = false;
      err.textContent =
        "No data files loaded. Run tools/psn_sync.py or tools/steam_sync.py, and serve this folder over http (file:// blocks fetch).";
      $("#subtitle").textContent = "No data";
      return;
    }

    state.groups = groupEntries(state.entries);
    render();
  }

  /* --------------------------------------------------------------- group */

  // The same game bought on two platforms should read as one game with a
  // split, not two half-stories. Matching is deliberately conservative:
  // trademark noise and punctuation only. data/aliases.json can force a
  // pairing the normaliser misses — { "steam_1091500": "cyberpunk 2077" }.
  function normalize(title) {
    return title
      .toLowerCase()
      .replace(/[™®©]/g, "")
      .replace(/[‘’']/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/^the /, "")
      .trim();
  }

  function groupEntries(entries) {
    const byKey = new Map();
    for (const e of entries) {
      const key = state.aliases[e.id] || normalize(e.title);
      let g = byKey.get(key);
      if (!g) {
        g = {
          key,
          title: e.title,
          cover: e.cover,
          hours: 0,
          sessions: 0,
          hasSessions: false,
          // Only some platforms report launch counts (PSN does, Steam does
          // not), so session maths must use the hours those counts cover —
          // never the cross-platform total.
          sessionHours: 0,
          sessionConsoles: [],
          firstPlayed: null,
          lastPlayed: null,
          consoles: [],
          platforms: [],
          parts: [],
        };
        byKey.set(key, g);
      }
      g.hours += e.hours || 0;
      if (typeof e.sessions === "number") {
        g.sessions += e.sessions;
        g.hasSessions = true;
        g.sessionHours += e.hours || 0;
        if (!g.sessionConsoles.includes(e.console)) g.sessionConsoles.push(e.console);
      }
      g.firstPlayed = minDate(g.firstPlayed, e.firstPlayed);
      g.lastPlayed = maxDate(g.lastPlayed, e.lastPlayed);
      if (!g.consoles.includes(e.console)) g.consoles.push(e.console);
      if (!g.platforms.includes(e.platform)) g.platforms.push(e.platform);
      g.parts.push(e);
      // Prefer the cover of whichever platform has more hours on it.
      if (e.cover && (e.hours || 0) >= Math.max(...g.parts.map((p) => p.hours || 0))) g.cover = e.cover;
    }
    return [...byKey.values()].sort((a, b) => b.hours - a.hours);
  }

  // Average session length over the platforms that actually count launches.
  const avgSession = (g) => (g.sessions ? g.sessionHours / g.sessions : 0);
  // True when the launch count covers only part of the game's hours.
  const partialSessions = (g) => g.hasSessions && g.sessionHours + 0.01 < g.hours;
  const sessionLabel = (g) =>
    `${g.sessions} ${partialSessions(g) ? g.sessionConsoles.join("/") + " " : ""}sessions`;

  /* ------------------------------------------------------------- derive */

  // Both platforms report lifetime totals, so per-day hours come from diffing
  // snapshots. Each source is diffed on its own, then summed per day. A gap
  // between syncs gives a known total over an unknown split — those days are
  // marked estimated rather than silently drawn as fact.
  function dailySeries() {
    const bySource = {};
    for (const s of state.snapshots) (bySource[s.source] ||= []).push(s);

    const byDate = {};
    let earliest = null;
    for (const [source, list] of Object.entries(bySource)) {
      list.sort((a, b) => a.date.localeCompare(b.date));
      earliest = minDate(earliest, list[0].date);
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1], cur = list[i];
        let gained = 0;
        const perGame = {};
        for (const [id, hours] of Object.entries(cur.hours)) {
          const delta = hours - (prev.hours[id] || 0);
          if (delta > 0.005) { gained += delta; perGame[id] = delta; }
        }
        const from = toDay(prev.date) + 1, to = toDay(cur.date);
        const span = Math.max(1, to - from + 1);
        for (let d = from; d <= to; d++) {
          const date = fromDay(d);
          const slot = (byDate[date] ||= { date, hours: 0, estimated: false, perGame: {}, sources: {} });
          slot.hours += gained / span;
          slot.sources[source] = (slot.sources[source] || 0) + gained / span;
          if (span > 1) slot.estimated = true;
          else for (const [id, h] of Object.entries(perGame)) slot.perGame[id] = (slot.perGame[id] || 0) + h;
        }
      }
    }
    const days = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
    return { days, since: earliest, snapshotCount: state.snapshots.length };
  }

  /* ------------------------------------------------------------- render */

  function render() {
    const totalH = state.entries.reduce((s, x) => s + (x.hours || 0), 0);
    const firsts = state.entries.map((x) => x.firstPlayed).filter(Boolean).sort();
    const platforms = [...new Set(state.entries.map((x) => x.platform))];
    $("#subtitle").textContent =
      `${state.groups.length} games · ${fmtH(totalH)} hours · ${platforms.join(" + ")}` +
      (firsts.length ? ` · since ${fmtDate(firsts[0])}` : "");
    $("#syncedAt").textContent = state.synced
      .map((s) => `${s.source} synced ${new Date(s.at).toLocaleDateString()}`)
      .join(" · ");
    renderOverview(totalH);
    renderGames();
    renderTimeline();
    renderDaily();
  }

  /* --- overview --- */

  function renderOverview(totalH) {
    const entries = state.entries;
    const byConsole = {};
    for (const e of entries) byConsole[e.console || "Other"] = (byConsole[e.console || "Other"] || 0) + (e.hours || 0);

    const dates = entries.map((x) => x.lastPlayed).filter(Boolean).sort();
    const firsts = entries.map((x) => x.firstPlayed).filter(Boolean).sort();
    const years = firsts.length && dates.length ? (toDay(dates[dates.length - 1]) - toDay(firsts[0])) / 365.25 : 0;
    const cutoff = fromDay(toDay(new Date().toISOString().slice(0, 10)) - 365);
    const activeYear = state.groups.filter((g) => g.lastPlayed && g.lastPlayed >= cutoff);
    const multi = state.groups.filter((g) => g.platforms.length > 1);

    const byPlatform = {};
    for (const e of entries) byPlatform[e.platform] = (byPlatform[e.platform] || 0) + (e.hours || 0);

    // Steam breaks its own totals down by device, so handheld hours are
    // knowable without touching the Deck itself.
    const deck = entries.reduce((s, e) => s + ((e.devices && e.devices.deck) || 0), 0);
    const steamH = byPlatform.Steam || 0;

    const tiles = [
      [fmtH(totalH), "hours tracked"],
      [state.groups.length, "games"],
      ...Object.entries(byPlatform).map(([p, h]) => [fmtH(h), `hours on ${p}`]),
      [years ? years.toFixed(1) + " yrs" : "—", "of history"],
      [activeYear.length, "played in last 12 months"],
    ];
    if (deck) tiles.push([fmtH(deck), `hours on Steam Deck (${Math.round(deck / steamH * 100)}% of Steam)`]);
    if (multi.length) tiles.push([multi.length, "games on both platforms"]);
    $("#tiles").innerHTML = tiles
      .map(([v, l]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");

    // Most played
    const top = state.groups.filter((g) => g.hours > 0).slice(0, 10);
    const max = top.length ? top[0].hours : 1;
    $("#topList").innerHTML = top.map((g) => `
      <li>
        ${cover(g)}
        <div>
          <div class="name">${esc(g.title)}${pills(g)}</div>
          <div class="meta">${metaLine(g)}</div>
          <div class="barwrap">${splitBar(g, max)}</div>
        </div>
        <div class="hrs">${fmtH(g.hours)}h</div>
      </li>`).join("");

    // Games started per year — only counts games whose start date is known.
    const byYear = {};
    for (const g of state.groups) { const y = year(g.firstPlayed); if (y) byYear[y] = (byYear[y] || 0) + 1; }
    $("#startedChart").innerHTML = columnChart(
      Object.keys(byYear).sort().map((y) => ({ label: y.slice(2), value: byYear[y], title: `${byYear[y]} games started in ${y}` }))
    );

    // Where the hours went
    const parts = Object.entries(byConsole).sort((a, b) => b[1] - a[1]);
    const sum = parts.reduce((s, p) => s + p[1], 0) || 1;
    $("#consoleChart").innerHTML =
      `<div class="stack">` +
      parts.map(([c, h]) => `<div title="${esc(c)}: ${fmtH(h)}h" style="width:${(h / sum * 100).toFixed(2)}%;background:${tint(c)}"></div>`).join("") +
      `</div><div class="legend">` +
      parts.map(([c, h]) =>
        `<span><i style="background:${tint(c)}"></i>${esc(c)} — ${fmtH(h)}h (${Math.round(h / sum * 100)}%)</span>`).join("") +
      `</div>`;

    // Longest average sessions — PSN only, Steam reports no launch counts.
    const avg = state.groups.filter((g) => g.hasSessions && g.sessions >= 5 && g.sessionHours > 0)
      .map((g) => ({ ...g, avg: avgSession(g) }))
      .sort((a, b) => b.avg - a.avg).slice(0, 12);
    $("#sessionChart").innerHTML = barRows(
      avg.map((g) => ({
        label: g.title,
        value: g.avg,
        color: tint(g.sessionConsoles[0]),
        suffix: "h",
        extra: `${g.sessions} launches` + (partialSessions(g) ? ` on ${g.sessionConsoles.join("/")}` : ""),
      }))
    );
  }

  const metaLine = (g) => {
    const bits = [];
    if (g.hasSessions) bits.push(`${sessionLabel(g)} · ${fmtH(avgSession(g))}h avg`);
    if (g.platforms.length > 1) bits.push(g.parts.map((p) => `${p.console} ${fmtH(p.hours)}h`).join(" + "));
    bits.push(`last played ${fmtDate(g.lastPlayed)}`);
    return esc(bits.join(" · "));
  };

  // One bar per platform, so a cross-platform game shows its split in place.
  const splitBar = (g, max) =>
    g.parts.filter((p) => p.hours > 0).map((p) =>
      `<span class="bar" style="width:${(p.hours / max * 100).toFixed(2)}%;background:${tint(p.console)}"></span>`).join("");

  // Cover art 404s on a few older titles, so the initial is the fallback
  // rather than an empty grey square.
  const cover = (x) =>
    `<div class="cover"><span>${esc((x.title || "?").trim()[0])}</span>` +
    (x.cover ? `<img src="${esc(x.cover)}" alt="" loading="lazy" onerror="this.remove()">` : "") +
    `</div>`;

  const pills = (g) =>
    g.consoles.filter(Boolean).map((c) =>
      `<span class="pill" style="color:${tint(c)};border-color:${tint(c)}">${esc(c)}</span>`).join("");

  /* --- games --- */

  function renderGames() {
    const consoles = [...new Set(state.entries.map((x) => x.console).filter(Boolean))].sort();
    $("#consoleFilter").innerHTML =
      `<option value="">All platforms</option>` + consoles.map((c) => `<option>${esc(c)}</option>`).join("");
    ["#search", "#sort", "#consoleFilter"].forEach((s) => $(s).addEventListener("input", drawGames));
    drawGames();
  }

  function drawGames() {
    const q = $("#search").value.trim().toLowerCase();
    const sort = $("#sort").value;
    const con = $("#consoleFilter").value;

    let list = state.groups.filter((g) =>
      (!q || g.title.toLowerCase().includes(q)) && (!con || g.consoles.includes(con)));

    const cmp = {
      hours: (a, b) => b.hours - a.hours,
      recent: (a, b) => (b.lastPlayed || "").localeCompare(a.lastPlayed || ""),
      first: (a, b) => (b.firstPlayed || "").localeCompare(a.firstPlayed || ""),
      sessions: (a, b) => b.sessions - a.sessions,
      avg: (a, b) => avgSession(b) - avgSession(a),
      title: (a, b) => a.title.localeCompare(b.title),
    }[sort];
    list = [...list].sort(cmp);

    const shown = list.reduce((s, g) => s + g.hours, 0);
    $("#gamesCount").textContent = `${list.length} of ${state.groups.length} games · ${fmtH(shown)} hours`;

    $("#gameList").innerHTML = list.length ? list.map((g) => `
      <li class="card">
        ${cover(g)}
        <div>
          <div class="name">${esc(g.title)}${pills(g)}</div>
          <div class="meta">
            ${g.hasSessions ? `${sessionLabel(g)} · ${fmtH(avgSession(g))}h avg<br>` : ""}
            ${g.firstPlayed ? fmtDate(g.firstPlayed) + " → " : ""}${fmtDate(g.lastPlayed)}
            ${g.platforms.length > 1 ? "<br>" + esc(g.parts.map((p) => `${p.console} ${fmtH(p.hours)}h`).join(" + ")) : ""}
          </div>
        </div>
        <div class="hrs"><b>${fmtH(g.hours)}h</b><span>${g.hours ? "" : "never played"}</span></div>
      </li>`).join("") : `<li class="empty">No games match.</li>`;
  }

  /* --- timeline --- */

  function renderTimeline() {
    $("#timelineCount").addEventListener("change", drawTimeline);
    drawTimeline();
  }

  function drawTimeline() {
    const limit = +$("#timelineCount").value;
    const dated = state.entries.filter((x) => x.firstPlayed && x.lastPlayed);
    const undated = state.entries.length - dated.length;

    $("#timelineNote").innerHTML = undated
      ? `${undated} entries are missing a start date and are not shown. PSN supplies one for
         every title; Steam supplies none, so a Steam game only joins this chart once it goes
         from unplayed to played while tracking is running.`
      : "";

    let rows = [...dated].sort((a, b) => b.hours - a.hours);
    if (limit) rows = rows.slice(0, limit);
    rows.sort((a, b) => a.firstPlayed.localeCompare(b.firstPlayed));

    if (!rows.length) { $("#timeline").innerHTML = `<p class="empty">No dated games yet.</p>`; return; }

    const minD = toDay(rows.reduce((m, x) => minDate(m, x.firstPlayed), rows[0].firstPlayed));
    const maxD = toDay(dated.reduce((m, x) => maxDate(m, x.lastPlayed), rows[0].lastPlayed));
    const rowH = 15, padL = 4, padT = 22, w = 1000;
    const h = padT + rows.length * rowH + 6;
    const x = (d) => padL + ((d - minD) / Math.max(1, maxD - minD)) * (w - padL * 2);

    const y0 = +fromDay(minD).slice(0, 4), y1 = +fromDay(maxD).slice(0, 4);
    let grid = "";
    for (let y = y0; y <= y1; y++) {
      const gx = x(toDay(`${y}-01-01`));
      if (gx < padL || gx > w - padL) continue;
      grid += `<line x1="${gx.toFixed(1)}" y1="16" x2="${gx.toFixed(1)}" y2="${h}" stroke="var(--line)" stroke-width="1"/>` +
              `<text x="${(gx + 3).toFixed(1)}" y="11" font-size="10" fill="var(--muted)">${y}</text>`;
    }

    const bars = rows.map((g, i) => {
      const x1 = x(toDay(g.firstPlayed)), x2 = Math.max(x(toDay(g.lastPlayed)), x1 + 2.5);
      const y = padT + i * rowH;
      const tip = `<title>${esc(g.title)} — ${fmtH(g.hours)}h on ${esc(g.console)}\n${fmtDate(g.firstPlayed)} → ${fmtDate(g.lastPlayed)}</title>`;
      // Label after the bar, or before it once the bar runs too close to the
      // right edge — hover tooltips are useless on a phone.
      const after = x2 < w * 0.62;
      const label = `<text x="${(after ? x2 + 5 : x1 - 5).toFixed(1)}" y="${y + 7.5}" font-size="9.5"
        fill="var(--muted)" text-anchor="${after ? "start" : "end"}">${esc(g.title.slice(0, 42))}</text>`;
      return `<g>${tip}<rect x="${x1.toFixed(1)}" y="${y}" width="${(x2 - x1).toFixed(1)}" height="8" rx="4"
        fill="${tint(g.console)}" opacity="0.85"/>${label}</g>`;
    }).join("");

    const consoles = [...new Set(rows.map((r) => r.console))];
    $("#timeline").innerHTML =
      `<svg viewBox="0 0 ${w} ${h}" style="min-width:640px" role="img" aria-label="Game rotation timeline">${grid}${bars}</svg>` +
      `<div class="legend">` +
      consoles.map((c) => `<span><i style="background:${tint(c)}"></i>${esc(c)}</span>`).join("") +
      `</div>`;
  }

  /* --- daily --- */

  function renderDaily() {
    const { days, since, snapshotCount } = dailySeries();

    if (!days.length) {
      $("#dailyHint").innerHTML = snapshotCount < 2
        ? `Only one snapshot so far${since ? " (" + fmtDate(since) + ")" : ""}. Both platforms report
           lifetime totals, so a day-by-day breakdown needs two syncs to compare — this fills in
           from tomorrow.`
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
      const per = Object.entries(d.sources).map(([s, hrs]) => `${s} ${fmtH(hrs)}h`).join(", ");
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 1.5).toFixed(1)}"
        height="${Math.max(d.hours ? 1.5 : 0.8, bh).toFixed(1)}" rx="2" fill="${fill}"${style}>
        <title>${fmtDate(d.date)} — ${fmtH(d.hours)}h${per ? " (" + per + ")" : ""}${d.estimated ? " · estimated across a multi-day gap" : ""}</title></rect>`;
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
    for (const d of recent) for (const [id, hrs] of Object.entries(d.perGame)) perGame[id] = (perGame[id] || 0) + hrs;
    const rows = Object.entries(perGame).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([id, hrs]) => {
        const e = state.entries.find((x) => x.id === id);
        return { label: e ? e.title : id, value: hrs, color: tint(e && e.console), suffix: "h" };
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
      <div class="barrow">
        <div>
          <div class="barrow__label">${esc(it.label)}${it.extra ? ` <span style="color:var(--muted)">· ${esc(it.extra)}</span>` : ""}</div>
          <div class="barrow__bar" style="background:${it.color || "var(--accent)"};width:${(it.value / max * 100).toFixed(1)}%"></div>
        </div>
        <div class="barrow__val">${fmtH(it.value)}${it.suffix || ""}</div>
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
