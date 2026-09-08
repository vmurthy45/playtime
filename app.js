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
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // DD MMM YY throughout — one date style, and never the locale's "Sept".
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d} ${MONTHS[+m - 1]} ${y.slice(2)}`;
  };
  // syncedAt is a UTC timestamp, so read it in local time — UTC is a day
  // behind NZ for most of the morning.
  const fmtStamp = (iso) => {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
  };
  const SOURCE_NAMES = { psn: "PSN", steam: "Steam" };
  const sourceName = (s) => SOURCE_NAMES[s] || s;
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
    const [files, snaps, aliases, nonGames] = await Promise.all([
      Promise.all(SOURCES.map((s) => getJSON(s.file))),
      getJSON("data/snapshots.json"),
      getJSON("data/aliases.json"),
      getJSON("data/non_games.json"),
    ]);

    // Consoles count Netflix and friends as titles with play time. The
    // collectors drop them going forward; this hides any already collected.
    const skipNames = new Set((nonGames && nonGames.names) || []);
    const skipIds = new Set((nonGames && nonGames.ids) || []);
    const isGame = (g) => !skipNames.has(normalize(g.title)) && !skipIds.has(g.id);

    // Keys starting with "_" are notes in the file, not mappings.
    state.aliases = Object.fromEntries(
      Object.entries(aliases || {}).filter(([k]) => !k.startsWith("_")));
    state.snapshots = snaps || [];
    files.forEach((f) => {
      if (!f) return;
      // Older syncs wrote the raw enum name; "Other" is what the UI shows.
      for (const g of f.games || []) {
        if (!isGame(g)) continue;
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
    const known = state.entries
      .map((x) => x.firstPlayed || x.lastPlayed)
      .filter(Boolean).sort();
    $("#subtitle").textContent =
      `${state.groups.length} games, ${fmtH(totalH)} hours.` +
      (known.length ? ` Since ${known[0].slice(0, 4)}` : "");
    $("#syncedAt").textContent = state.synced
      .map((s) => `${sourceName(s.source)} synced ${fmtStamp(s.at)}`)
      .join(" · ");
    renderOverview();
    renderStats(totalH);
    renderGames();
    renderTimeline();
    renderDaily();
  }

  /* --- overview --- */

  function renderOverview() {
    let platform = null;   // null = every platform

    const consoles = [...new Set(state.entries.map((e) => e.console).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    $("#platformFilter").innerHTML = consoles.map((c) =>
      `<button class="pf__btn" data-platform="${esc(c)}">
         <i style="background:${tint(c)}"></i>${esc(c)}
       </button>`).join("");

    const draw = () => {
      // With a platform selected, regroup from that platform's entries alone —
      // showing a merged game's combined hours under one platform's filter
      // would overstate it.
      const groups = platform
        ? groupEntries(state.entries.filter((e) => e.console === platform))
        : state.groups;

      const rows = $("#listToggle .is-active").dataset.list === "recent"
        ? groups.filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed)).slice(0, 10)
        : groups.filter((g) => g.hours > 0).slice(0, 10);

      // Bars are scaled within the list on show, not against the all-time top.
      const max = Math.max(...rows.map((g) => g.hours), 1);
      $("#topList").innerHTML = rows.length ? rows.map((g) => `
        <li>
          ${cover(g)}
          <div>
            <div class="name">${esc(g.title)}${pills(g)}</div>
            <div class="meta">${metaLine(g)}</div>
            <div class="barwrap">${splitBar(g, max)}</div>
          </div>
          <div class="hrs">${fmtH(g.hours)}h</div>
        </li>`).join("") : `<li class="empty">Nothing played on ${esc(platform || "any platform")} yet.</li>`;
    };

    $("#listToggle").addEventListener("click", (e) => {
      const btn = e.target.closest(".seg__btn");
      if (!btn) return;
      document.querySelectorAll("#listToggle .seg__btn")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
      draw();
    });

    $("#platformFilter").addEventListener("click", (e) => {
      const btn = e.target.closest(".pf__btn");
      if (!btn) return;
      // Clicking the active platform clears the filter.
      platform = btn.dataset.platform === platform ? null : btn.dataset.platform;
      document.querySelectorAll("#platformFilter .pf__btn").forEach((b) => {
        const on = b.dataset.platform === platform;
        b.classList.toggle("is-on", on);
        b.style.background = on ? tint(b.dataset.platform) : "";
      });
      draw();
    });

    draw();
  }

  /* --- stats --- */

  function renderStats(totalH) {
    const entries = state.entries;
    const byConsole = {};
    for (const e of entries) byConsole[e.console || "Other"] = (byConsole[e.console || "Other"] || 0) + (e.hours || 0);

    const dates = entries.map((x) => x.lastPlayed).filter(Boolean).sort();
    // Steam supplies no start date, so its earliest known point is when a game
    // was last played — ignoring that dated the library from 2015, not 2011.
    const known = entries.map((x) => x.firstPlayed || x.lastPlayed).filter(Boolean).sort();
    const years = known.length && dates.length ? (toDay(dates[dates.length - 1]) - toDay(known[0])) / 365.25 : 0;
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
    if (multi.length) tiles.push([multi.length, "games on multiple platforms"]);
    $("#tiles").innerHTML = tiles
      .map(([v, l]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");

    // New games per year: each game counted once, in the year it was first
    // played. Horizontal bars — twelve rows fit a phone; twelve columns did
    // not, and scrolling a chart sideways to read it was worse.
    const byYear = {};
    for (const g of state.groups) {
      const y = year(g.firstPlayed);
      if (y) (byYear[y] ||= []).push(g);
    }
    const yearKeys = Object.keys(byYear).sort().reverse();
    const peak = Math.max(...yearKeys.map((y) => byYear[y].length), 1);

    $("#startedChart").innerHTML = yearKeys.map((y) => `
      <button class="yrow" data-year="${y}" aria-pressed="false">
        <span class="yrow__year">${y}</span>
        <span class="yrow__track"><span class="yrow__fill" style="width:${(byYear[y].length / peak * 100).toFixed(1)}%"></span></span>
        <span class="yrow__n">${byYear[y].length}</span>
      </button>`).join("");

    let openYear = null;
    const showYear = (y) => {
      const games = [...(byYear[y] || [])].sort((a, b) => a.firstPlayed.localeCompare(b.firstPlayed));
      $("#yearGames").innerHTML = `
        <div class="yearlist chartbox">
          <h3>${games.length} new ${games.length === 1 ? "game" : "games"} in ${y}</h3>
          <ol>${games.map((g) => `
            <li>
              ${g.consoles.map((c) => `<span class="pip" style="background:${tint(c)}" title="${esc(c)}"></span>`).join("")}
              <span class="yl__title">${esc(g.title)}</span>
              <span class="yl__meta">${fmtDate(g.firstPlayed)} · ${fmtH(g.hours)}h</span>
            </li>`).join("")}</ol>
        </div>`;
    };

    $("#startedChart").addEventListener("click", (e) => {
      const btn = e.target.closest(".yrow");
      if (!btn) return;
      const y = btn.dataset.year;
      openYear = y === openYear ? null : y;   // click the open year to close it
      document.querySelectorAll(".yrow").forEach((b) => {
        const on = b.dataset.year === openYear;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      if (openYear) showYear(openYear); else $("#yearGames").innerHTML = "";
    });

    const parts = Object.entries(byConsole).sort((a, b) => b[1] - a[1]);
    const sum = parts.reduce((s, p) => s + p[1], 0) || 1;
    $("#consoleChart").innerHTML =
      `<div class="stack">` +
      parts.map(([c, h]) => `<div title="${esc(c)}: ${fmtH(h)}h" style="width:${(h / sum * 100).toFixed(2)}%;background:${tint(c)}"></div>`).join("") +
      `</div><div class="legend">` +
      parts.map(([c, h]) =>
        `<span><i style="background:${tint(c)}"></i>${esc(c)} — ${fmtH(h)}h (${Math.round(h / sum * 100)}%)</span>`).join("") +
      `</div>`;
  }

  const metaLine = (g) => {
    const bits = [];
    if (g.hasSessions) bits.push(sessionLabel(g));
    if (g.platforms.length > 1) bits.push(g.parts.map((p) => `${p.console} ${fmtH(p.hours)}h`).join(" + "));
    bits.push(`last played ${fmtDate(g.lastPlayed)}`);
    return esc(bits.join(" · "));
  };

  // One bar per platform, so a cross-platform game shows its split in place.
  const splitBar = (g, max) =>
    g.parts.filter((p) => p.hours > 0).map((p) =>
      `<span class="bar" title="${esc(p.console)} — ${fmtH(p.hours)}h"
         style="width:${(p.hours / max * 100).toFixed(2)}%;background:${tint(p.console)}"></span>`).join("");

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

    // Newest first, and anything undated sinks to the bottom rather than
    // sorting as an empty string.
    const byDate = (get) => (a, b) => {
      const x = get(a) || "", y = get(b) || "";
      if (!x || !y) return x ? -1 : y ? 1 : 0;
      return x < y ? 1 : x > y ? -1 : 0;
    };
    const cmp = {
      hours: (a, b) => b.hours - a.hours,
      recent: byDate((g) => g.lastPlayed),
      first: byDate((g) => g.firstPlayed),
      sessions: (a, b) => b.sessions - a.sessions,
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
            ${g.hasSessions ? sessionLabel(g) + "<br>" : ""}
            ${g.firstPlayed
              ? fmtDate(g.firstPlayed) + " → " + fmtDate(g.lastPlayed)
              : g.lastPlayed ? "last played " + fmtDate(g.lastPlayed) : ""}
            ${g.platforms.length > 1 ? "<br>" + esc(g.parts.map((p) => `${p.console} ${fmtH(p.hours)}h`).join(" + ")) : ""}
          </div>
        </div>
        <div class="hrs"><b>${fmtH(g.hours)}h</b><span>${g.hours ? "" : "never played"}</span></div>
      </li>`).join("") : `<li class="empty">No games match.</li>`;
  }

  /* --- timeline --- */

  function renderTimeline() {
    const dated = state.entries.filter((x) => x.firstPlayed && x.lastPlayed);
    const today = new Date().toISOString().slice(0, 10);
    const earliest = dated.reduce((m, x) => minDate(m, x.firstPlayed), today);
    const years = [];
    for (let y = +today.slice(0, 4); y >= +earliest.slice(0, 4); y--) years.push(y);

    // Ranges are windows on the calendar, not a cap on how many games show.
    $("#timelineRange").innerHTML = [
      `<option value="7d">Last 7 days</option>`,
      `<option value="30d">Last 30 days</option>`,
      `<option value="y:${years[0]}" selected>This year (${years[0]})</option>`,
      years[1] ? `<option value="y:${years[1]}">Last year (${years[1]})</option>` : "",
      `<option value="all">All time</option>`,
      years.length > 2
        ? `<optgroup label="By year">` +
          years.slice(2).map((y) => `<option value="y:${y}">${y}</option>`).join("") +
          `</optgroup>`
        : "",
    ].join("");
    $("#timelineRange").addEventListener("change", drawTimeline);
    $("#timelineSearch").addEventListener("input", drawTimeline);
    drawTimeline();
  }

  function rangeWindow(value, dated) {
    const today = new Date().toISOString().slice(0, 10);
    if (value === "all") {
      return {
        start: dated.reduce((m, x) => minDate(m, x.firstPlayed), today),
        end: dated.reduce((m, x) => maxDate(m, x.lastPlayed), today),
        label: "all time",
        padded: false,
      };
    }
    if (value.startsWith("y:")) {
      const y = value.slice(2);
      return { start: `${y}-01-01`, end: `${y}-12-31`, label: y };
    }
    const days = parseInt(value, 10);
    return { start: fromDay(toDay(today) - days + 1), end: today, label: `the last ${days} days` };
  }

  function drawTimeline() {
    const dated = state.entries.filter((x) => x.firstPlayed && x.lastPlayed);
    const q = $("#timelineSearch").value.trim().toLowerCase();
    const win = rangeWindow($("#timelineRange").value || "all", dated);

    const matches = q ? dated.filter((x) => x.title.toLowerCase().includes(q)) : dated;
    const inWindow = (x) => x.lastPlayed >= win.start && x.firstPlayed <= win.end;
    let rows = matches.filter(inWindow);
    rows.sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed) || b.hours - a.hours);

    const elsewhere = matches.length - rows.length;
    $("#timelineNote").innerHTML =
      `<b>${rows.length}</b> ${rows.length === 1 ? "game" : "games"}` +
      (q ? ` matching “${esc(q)}”` : "") + ` played during ${esc(win.label)}.` +
      // Only worth saying while searching, when it is the difference between
      // "no match" and "no match here".
      (q && elsewhere ? ` <b>${elsewhere}</b> more outside this range.` : "");

    if (!rows.length) {
      $("#timeline").innerHTML = `<p class="empty">${q ? "No game matches that." : "Nothing was played in that window."}</p>`;
      return;
    }

    // The window decides which games appear; the drawn range is padded either
    // side so a game carrying over from the year before is actually visible
    // instead of being cut flat at the edge.
    const winFrom = toDay(win.start), winTo = toDay(win.end);
    const pad = win.padded === false ? 0 : Math.min(90, Math.max(3, Math.round((winTo - winFrom) * 0.14)));
    const minD = winFrom - pad, maxD = winTo + pad;
    const pct = (d) => ((d - minD) / Math.max(1, maxD - minD)) * 100;

    // Every tick gets room and the chart scrolls sideways, rather than
    // dropping labels until they fit.
    const ticks = tickMarks(minD, maxD);
    const plotW = Math.max(560, ticks.length * 85);
    const axis = ticks.map(([t, label]) => {
      const x = pct(t);
      // Centred labels fall off the ends; the first and last anchor inward.
      const align = x < 3 ? "left:0;transform:none" : x > 97 ? "right:0;left:auto;transform:none" : `left:${x.toFixed(2)}%`;
      return `<span class="tl__tick" style="${align}">${esc(label)}</span>`;
    }).join("");
    const lines = ticks.map(([t]) =>
      `<span class="tl__line" style="left:${pct(t).toFixed(2)}%"></span>`).join("");

    // A bar spanning first-played to last-played, clipped to the window. It
    // means the game was in rotation across that stretch, not that it was
    // played every day in it.
    const body = rows.map((g) => {
      const colour = tint(g.console);
      const first = toDay(g.firstPlayed), last = toDay(g.lastPlayed);
      const from = Math.max(first, minD), to = Math.min(last, maxD);
      const left = pct(from);
      const width = Math.max(0.35, pct(to) - left);
      // A squared-off end means the bar runs past the edge of what is drawn.
      const cut = (first < minD ? " tlbar--cutL" : "") + (last > maxD ? " tlbar--cutR" : "");

      const bar = `<span class="tlbar${cut}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;background:${colour}"></span>`;

      const n = typeof g.sessions === "number" && g.sessions ? g.sessions : null;
      // Platform reads as a colour chip; the title stays in body colour so it
      // is legible (light blue text on white is not).
      return `<div class="tlrow">
        <div class="tlrow__name" title="${esc(g.title)} — ${fmtH(g.hours)}h on ${esc(g.console)}${n ? ` · ${n} sessions` : ""}">
          <span class="tlrow__chip" style="background:${colour}"></span>
          <span class="tlrow__title">${esc(g.title)}</span>
          ${n ? `<span class="tlrow__n">${n}×</span>` : ""}
        </div>
        <div class="tlrow__plot">${bar}</div>
      </div>`;
    }).join("");

    const consoles = [...new Set(rows.map((r) => r.console))];
    $("#timeline").innerHTML =
      `<div class="tl__scroll">
         <div class="tl" style="--plotw:${plotW}px">
           <div class="tl__head"><div class="tl__headname"></div><div class="tl__axis">${axis}</div></div>
           <div class="tl__body"><div class="tl__lines">${lines}</div>${body}</div>
         </div>
       </div>
       <div class="legend legend--tl">` +
      consoles.map((c) => `<span><i style="background:${tint(c)}"></i>${esc(c)}</span>`).join("") +
      `</div>`;
  }

  // Tick spacing follows the window: years for a decade, months for a year,
  // weeks for a month.
  function tickMarks(minD, maxD) {
    const span = maxD - minD;
    const ticks = [];
    if (span > 3 * 365) {
      for (let y = +fromDay(minD).slice(0, 4); y <= +fromDay(maxD).slice(0, 4); y++)
        ticks.push([toDay(`${y}-01-01`), String(y)]);
    } else if (span > 45) {
      const d = new Date(fromDay(minD) + "T00:00:00");
      d.setDate(1);
      while (toDay(d.toISOString().slice(0, 10)) <= maxD) {
        const iso = d.toISOString().slice(0, 10);
        ticks.push([toDay(iso), MONTHS[d.getMonth()]]);
        d.setMonth(d.getMonth() + 1);
      }
    } else {
      for (let t = minD; t <= maxD; t += 7) {
        const iso = fromDay(t);
        ticks.push([t, `${+iso.slice(8)} ${MONTHS[+iso.slice(5, 7) - 1]}`]);
      }
    }
    return ticks.filter(([t]) => t >= minD && t <= maxD);
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
      const per = Object.entries(d.sources).map(([s, hrs]) => `${sourceName(s)} ${fmtH(hrs)}h`).join(", ");
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
