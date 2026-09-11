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
  const state = { entries: [], groups: [], snapshots: [], aliases: {}, synced: [], trophySummary: null };

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
  // Calendar dates as whole-day indices, in UTC on both sides. Parsing
  // "2026-09-09" as *local* midnight put it on 8 Sep in UTC for anyone east of
  // Greenwich, so every date round-tripped through here came back a day early.
  const toDay = (iso) => Math.floor(Date.parse(iso.slice(0, 10) + "T00:00:00Z") / dayMs);
  const fromDay = (d) => new Date(d * dayMs).toISOString().slice(0, 10);
  // Today is the viewer's calendar date. The UTC date is yesterday in NZ
  // until midday.
  const pad2 = (n) => String(n).padStart(2, "0");
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const todayISO = () => localDate();
  const minDate = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
  const maxDate = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

  const TINT = { PS4: "var(--ps4)", PS5: "var(--ps5)", Steam: "var(--steam)" };
  const tint = (c) => TINT[c] || "var(--other)";

  /* ---------------------------------------------------------------- load */

  const getJSON = (url) =>
    fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  async function load() {
    const [files, snaps, aliases, nonGames, backfill] = await Promise.all([
      Promise.all(SOURCES.map((s) => getJSON(s.file))),
      getJSON("data/snapshots.json"),
      getJSON("data/aliases.json"),
      getJSON("data/non_games.json"),
      getJSON("data/backfill.json"),
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
      if (f.trophySummary) state.trophySummary = f.trophySummary;
    });

    if (!state.entries.length) {
      const err = $("#loadError");
      err.hidden = false;
      err.textContent =
        "No data files loaded. Run tools/psn_sync.py or tools/steam_sync.py, and serve this folder over http (file:// blocks fetch).";
      $("#subtitle").textContent = "No data";
      return;
    }

    applySessions(backfill);
    state.groups = groupEntries(state.entries);
    render();
  }

  // Steam never reports launches, so its session counts are built here.
  // Rule: each snapshot interval in which a game gained hours is one session
  // — at most one sitting per game per sync, which errs low and is close
  // enough. Where a backfill exists (tools/backfill_*.py, e.g. STS2 run
  // history) it supplies the count up to its last day, and only intervals
  // after that are added. A game with no evidence either way stays unknown
  // rather than showing x0, which would claim it was never launched.
  function applySessions(backfill) {
    const { activity } = dailySeries();
    for (const e of state.entries) {
      if (typeof e.sessions === "number") continue;   // PSN counts its own
      const b = backfill && backfill[e.id];
      const seen = activity[e.id];
      const later = seen ? seen.intervals.filter((d) => !b || d > b.through) : [];
      if (!b && !later.length) continue;
      e.sessions = (b ? b.sessions : 0) + later.length;
      e.sessionsFrom = b ? "run history" : "tracking";
      if (b && !e.firstPlayed) e.firstPlayed = b.firstPlayed;
    }
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
    `x${g.sessions}${partialSessions(g) ? " " + g.sessionConsoles.join("/") : ""}`;

  /* ------------------------------------------------------------- derive */

  // Both platforms report lifetime totals, so per-day hours come from diffing
  // snapshots. Each source is diffed on its own, then summed per day. A gap
  // between syncs gives a known total over an unknown split — those days are
  // marked estimated rather than silently drawn as fact.
  //
  // Alongside the daily totals this records, per game, the first and last day
  // the snapshots saw it gain hours. Steam supplies no first-played date, so
  // that observed activity is the only evidence of when a Steam game was
  // played — the timeline depends on it.
  function dailySeries() {
    const consoleOf = {};
    for (const e of state.entries) consoleOf[e.id] = e.console || "Other";

    const bySource = {};
    for (const s of state.snapshots) (bySource[s.source] ||= []).push(s);

    const byDate = {};
    const activity = {};
    let earliest = null;
    for (const list of Object.values(bySource)) {
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
        // The hours were earned between the two snapshots, so they belong to
        // the days from the earlier one up to (not including) the later one.
        // With a midnight sync that is exactly the day that just ended.
        const from = toDay(prev.date), to = Math.max(from, toDay(cur.date) - 1);
        const span = to - from + 1;

        for (const id of Object.keys(perGame)) {
          const a = (activity[id] ||= { first: null, last: null, intervals: [] });
          a.first = minDate(a.first, fromDay(from));
          a.last = maxDate(a.last, fromDay(to));
          a.intervals.push(fromDay(from));
        }
        for (let d = from; d <= to; d++) {
          const date = fromDay(d);
          const slot = (byDate[date] ||= { date, hours: 0, estimated: false, perGame: {}, byConsole: {} });
          slot.hours += gained / span;
          for (const [id, h] of Object.entries(perGame)) {
            const c = consoleOf[id] || "Other";
            slot.byConsole[c] = (slot.byConsole[c] || 0) + h / span;
          }
          if (span > 1) slot.estimated = true;
          else for (const [id, h] of Object.entries(perGame)) slot.perGame[id] = (slot.perGame[id] || 0) + h;
        }
      }
    }
    const days = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
    return { days, since: earliest, snapshotCount: state.snapshots.length, activity };
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
    // A source that quietly stops syncing should look wrong, not just old.
    const todayD = toDay(todayISO());
    $("#syncedAt").innerHTML = state.synced
      .map((s) => {
        const age = todayD - toDay(localDate(new Date(s.at)));
        const label = `${sourceName(s.source)} synced ${fmtStamp(s.at)}`;
        return age > 2 ? `<span class="stale">${esc(label)} · ${age} days ago</span>` : esc(label);
      })
      .join(" · ");
    state.spans = timelineSpans();
    renderOverview();
    renderStats(totalH);
    renderYir();
    renderTop5();
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
        <li class="row">
          <button class="row__head" aria-expanded="false">
            ${cover(g)}
            <div>
              <div class="name"><span class="name__t">${esc(g.title)}</span>${pills(g)}${hasTrophy(g) ? TROPHY : ""}</div>
              <div class="barwrap">${splitBar(g, max)}</div>
            </div>
            <div class="hrs">${fmtH(g.hours)}h</div>
          </button>
          <div class="row__detail" hidden>${detailHTML(g)}</div>
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
    const cutoff = fromDay(toDay(todayISO()) - 365);
    const activeYear = state.groups.filter((g) => g.lastPlayed && g.lastPlayed >= cutoff);
    const multi = state.groups.filter((g) => g.platforms.length > 1);

    const byPlatform = {};
    for (const e of entries) byPlatform[e.platform] = (byPlatform[e.platform] || 0) + (e.hours || 0);

    // Grouped by what the number is about: how many games, how much time,
    // how much of it was finished.
    const tile = ([v, l]) => `<div class="tile"><b>${v}</b><span>${esc(l)}</span></div>`;
    const fill = (id, rows) => { $(id).innerHTML = rows.map(tile).join(""); };

    fill("#tilesLibrary", [
      [state.groups.length, "games"],
      [activeYear.length, "played in last 12 months"],
      [multi.length, "games on multiple platforms"],
    ]);

    // Steam breaks its own totals down by device, so handheld hours are
    // knowable without touching the Deck itself.
    const deck = entries.reduce((s, e) => s + ((e.devices && e.devices.deck) || 0), 0);
    const steamH = byPlatform.Steam || 0;
    const timeTiles = [
      [fmtH(totalH), "hours tracked"],
      ...Object.entries(byPlatform).map(([p, h]) => [fmtH(h), `hours on ${p}`]),
      [years ? years.toFixed(1) + " yrs" : "—", "of history"],
    ];
    if (deck) timeTiles.push([fmtH(deck), `hours on Steam Deck (${Math.round(deck / steamH * 100)}% of Steam)`]);
    fill("#tilesTime", timeTiles);

    // Completion: a platinum or a full achievement sweep both mean finished.
    let platinums = 0, full = 0;
    for (const g of state.groups) {
      const t = bestTrophies(g), a = bestAchievements(g);
      if (t && t.platinum) platinums++;
      if (allAchievements(a)) full++;
    }
    // The platinum count comes from the trophy list itself, not from games
    // that matched one: PS3 and Vita titles never appear in the play-time
    // API, and a collection hides several trophy sets behind one title.
    const summary = state.trophySummary;
    const platinumTotal = summary ? summary.platinums : platinums;

    fill("#tilesCompletion", [
      [`${TROPHY}${platinumTotal + full}`, "games completed"],
      [platinumTotal, "platinum trophies"],
      [full, "Steam games at 100%"],
    ]);
    $("#completionNote").textContent = summary && summary.platinums > platinums
      ? `${summary.platinums - platinums} of these are PS3, Vita or collection titles, which have trophies but no play time to track.`
      : "";

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
      $("#startedChart").classList.toggle("has-selection", !!openYear);
      if (!openYear) { $("#yearGames").innerHTML = ""; return; }
      showYear(openYear);
      // The list opens below the chart; on a phone that is off-screen.
      $("#yearGames").scrollIntoView({ behavior: "smooth", block: "nearest" });
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

  const TROPHY = `<img class="plat" src="trophy.png" alt="Completed" title="Platinum trophy or 100% achievements">`;
  // Trophies belong to the game, not to each platform entry — PSN reports the
  // same set against a PS4 and PS5 copy, so take the best and show it once.
  const bestTrophies = (g) =>
    g.parts.map((p) => p.trophies).filter(Boolean).sort((a, b) => b.earned - a.earned)[0] || null;
  const bestAchievements = (g) =>
    g.parts.map((p) => p.achievements).filter(Boolean).sort((a, b) => b.earned - a.earned)[0] || null;
  // A trophy means "finished it": a PSN platinum, or every Steam achievement.
  const allAchievements = (a) => a && a.total > 0 && a.earned >= a.total;
  const hasTrophy = (g) =>
    g.parts.some((p) => (p.trophies && p.trophies.platinum) || allAchievements(p.achievements));

  // Everything that used to crowd the row, shown only when it is opened.
  const detailHTML = (g) => {
    const rows = [];
    if (g.firstPlayed) rows.push(["Played", `${fmtDate(g.firstPlayed)} → ${fmtDate(g.lastPlayed)}`]);
    else if (g.lastPlayed) rows.push(["Last played", fmtDate(g.lastPlayed)]);
    if (g.hasSessions) rows.push(["Sessions", sessionLabel(g)]);
    for (const p of g.parts) {
      rows.push([g.parts.length > 1 ? p.console : "Hours", `${fmtH(p.hours)}h`]);
    }
    const trophies = bestTrophies(g);
    if (trophies) {
      rows.push(["Trophies", `${trophies.platinum ? TROPHY : ""}${trophies.earned}/${trophies.total}`]);
    }
    const achievements = bestAchievements(g);
    if (achievements) {
      rows.push(["Achievements",
        `${allAchievements(achievements) ? TROPHY : ""}${achievements.earned}/${achievements.total}`]);
    }
    return `<dl class="detail">` + rows.map(([k, v]) =>
      `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("") + `</dl>`;
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
      <li class="row">
        <button class="row__head" aria-expanded="false">
          ${cover(g)}
          <div>
            <div class="name"><span class="name__t">${esc(g.title)}</span>${pills(g)}${hasTrophy(g) ? TROPHY : ""}</div>
          </div>
          <div class="hrs"><b>${fmtH(g.hours)}h</b>${g.hours ? "" : "<span>never played</span>"}</div>
        </button>
        <div class="row__detail" hidden>${detailHTML(g)}</div>
      </li>`).join("") : `<li class="empty">No games match.</li>`;
  }

  /* --- timeline --- */

  // When each entry was in rotation. PSN gives a real first-played date.
  // Steam gives none, so a Steam game starts at the first day the snapshots
  // saw it played, or failing that its last-played date — and is flagged so
  // the bar can show that its true start is earlier than drawn.
  function timelineSpans() {
    const { activity } = dailySeries();
    const spans = new Map();
    for (const e of state.entries) {
      const seen = activity[e.id];
      const start = e.firstPlayed || (seen && seen.first) || e.lastPlayed;
      const end = maxDate(e.lastPlayed, seen && seen.last) || start;
      if (start && end) spans.set(e.id, { start, end: maxDate(start, end), startKnown: !!e.firstPlayed });
    }
    return spans;
  }

  function renderTimeline() {
    const today = todayISO();
    let earliest = today;
    for (const sp of state.spans.values()) earliest = minDate(earliest, sp.start);
    const years = [];
    for (let y = +today.slice(0, 4); y >= +earliest.slice(0, 4); y--) years.push(y);

    // Ranges are windows on the calendar, not a cap on how many games show.
    $("#timelineRange").innerHTML = [
      `<option value="7d">Last 7 days</option>`,
      `<option value="30d" selected>Last 30 days</option>`,
      `<option value="y:${years[0]}">This year (${years[0]})</option>`,
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

  function rangeWindow(value) {
    const today = todayISO();
    if (value === "all") {
      let start = today, end = today;
      for (const sp of state.spans.values()) { start = minDate(start, sp.start); end = maxDate(end, sp.end); }
      return { start, end, label: "all time", padded: false };
    }
    if (value.startsWith("y:")) {
      const y = value.slice(2);
      return { start: `${y}-01-01`, end: `${y}-12-31`, label: y };
    }
    const days = parseInt(value, 10);
    return { start: fromDay(toDay(today) - days + 1), end: today, label: `the last ${days} days` };
  }

  function drawTimeline() {
    const spanOf = (x) => state.spans.get(x.id);
    const dated = state.entries.filter(spanOf);
    const q = $("#timelineSearch").value.trim().toLowerCase();
    const win = rangeWindow($("#timelineRange").value || "all");

    const matches = q ? dated.filter((x) => x.title.toLowerCase().includes(q)) : dated;
    const inWindow = (x) => spanOf(x).end >= win.start && spanOf(x).start <= win.end;
    let rows = matches.filter(inWindow);
    rows.sort((a, b) => spanOf(b).end.localeCompare(spanOf(a).end) || b.hours - a.hours);

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
    const { lines: gridDays, labels: ticks, daily } = tickMarks(minD, maxD);
    const plotW = daily
      // A column per day: wide enough to read, narrow enough that a month
      // still fits a laptop without scrolling.
      ? Math.round(gridDays.length * Math.max(20, Math.min(64, 800 / gridDays.length)))
      : Math.max(560, gridDays.length * 85);
    const axis = ticks.map(([t, label]) => {
      const x = pct(t);
      // Centred labels fall off the ends; the first and last anchor inward.
      const align = x < 3 ? "left:0;transform:none" : x > 97 ? "right:0;left:auto;transform:none" : `left:${x.toFixed(2)}%`;
      return `<span class="tl__tick" style="${align}">${esc(label)}</span>`;
    }).join("");
    const lines = gridDays.map((t) =>
      `<span class="tl__line" style="left:${pct(t).toFixed(3)}%"></span>`).join("");

    // A bar spanning first-played to last-played, clipped to the window. It
    // means the game was in rotation across that stretch, not that it was
    // played every day in it.
    const body = rows.map((g) => {
      const colour = tint(g.console);
      const sp = spanOf(g);
      const first = toDay(sp.start), last = toDay(sp.end);
      const from = Math.max(first, minD), to = Math.min(last, maxD);
      const left = pct(from);
      const width = Math.max(0.35, pct(to) - left);
      // A squared-off end means the game ran past what is drawn — either the
      // window edge, or (for Steam) a start date nobody recorded.
      const cut = (first < minD || !sp.startKnown ? " tlbar--cutL" : "") + (last > maxD ? " tlbar--cutR" : "");
      const when = sp.startKnown
        ? `${fmtDate(sp.start)} → ${fmtDate(sp.end)}`
        : `seen ${fmtDate(sp.start)} → ${fmtDate(sp.end)} · started earlier, date unknown`;

      const bar = `<span class="tlbar${cut}" title="${esc(g.title)} — ${when}"
        style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;background:${colour}"></span>`;

      const n = typeof g.sessions === "number" && g.sessions ? g.sessions : null;
      // Platform reads as a colour chip; the title stays in body colour so it
      // is legible (light blue text on white is not).
      return `<div class="tlrow">
        <div class="tlrow__name" title="${esc(g.title)} — ${fmtH(g.hours)}h on ${esc(g.console)}${n ? ` · ${n} sessions` : ""}">
          <span class="tlrow__chip" style="background:${colour}"></span>
          <span class="tlrow__title">${esc(g.title)}</span>
          ${n ? `<span class="tlrow__n">x${n}</span>` : ""}
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

  // Tick spacing follows the window: a line per day for a month or less,
  // months for a year, years for a decade. Lines and labels are separate —
  // a gridline every day is useful, a label every day is noise.
  function tickMarks(minD, maxD) {
    const span = maxD - minD + 1;

    if (span <= 45) {
      const lines = [];
      for (let t = minD; t <= maxD; t++) lines.push(t);
      const every = Math.max(1, Math.ceil(span / 9));
      const labels = lines
        .filter((_, i) => i % every === 0)
        .map((t) => {
          const iso = fromDay(t);
          return [t, `${+iso.slice(8)} ${MONTHS[+iso.slice(5, 7) - 1]}`];
        });
      return { lines, labels, daily: true };
    }

    if (span <= 3 * 365) {
      const lines = [];
      // Walk months in UTC too, or month boundaries slip a day east of GMT.
      const d = new Date(fromDay(minD) + "T00:00:00Z");
      d.setUTCDate(1);
      while (toDay(d.toISOString()) <= maxD) {
        const t = toDay(d.toISOString());
        if (t >= minD) lines.push([t, MONTHS[d.getUTCMonth()]]);
        d.setUTCMonth(d.getUTCMonth() + 1);
      }
      return { lines: lines.map(([t]) => t), labels: lines, daily: false };
    }

    const lines = [];
    for (let y = +fromDay(minD).slice(0, 4); y <= +fromDay(maxD).slice(0, 4); y++) {
      const t = toDay(`${y}-01-01`);
      if (t >= minD && t <= maxD) lines.push([t, String(y)]);
    }
    return { lines: lines.map(([t]) => t), labels: lines, daily: false };
  }

  /* --- daily --- */

  function renderDaily() {
    const { days, since, snapshotCount } = dailySeries();

    // Two snapshots taken hours apart with no play between them produce a
    // day of zero, which draws as a blank box and reads as "broken".
    const anyHours = days.some((d) => d.hours > 0.005);
    if (!days.length || !anyHours) {
      $("#dailyHint").innerHTML = snapshotCount < 2
        ? `Only one snapshot so far${since ? " (" + fmtDate(since) + ")" : ""}. Both platforms report
           lifetime totals, so a day-by-day breakdown needs two syncs to compare.`
        : `No play time between the syncs so far — the totals were identical. The first real day
           appears after a sync that follows an evening of play.`;
      $("#dailyChart").innerHTML = `<p class="empty">Nothing played yet between syncs.</p>`;
      $("#dailyBreakdown").innerHTML = "";
      return;
    }

    const recent = days.slice(-60);
    const anyEstimated = recent.some((d) => d.estimated);
    $("#dailyHint").textContent = `Tracked since ${fmtDate(since)}. Earlier days are unknown, not zero.`;
    $("#dailyChart").innerHTML = stackedDays(recent) +
      (anyEstimated ? `<div class="gapnote"><span class="hatch"></span> faded: a gap between syncs — total is real, daily split estimated</div>` : "");

    const total = recent.reduce((s, d) => s + d.hours, 0);
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


  /* --- stats sub-tabs --- */

  $("#statsNav").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg__btn");
    if (!btn) return;
    document.querySelectorAll("#statsNav .seg__btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    document.querySelectorAll("#panel-stats .subpanel")
      .forEach((p) => p.classList.toggle("is-active", p.id === "sub-" + btn.dataset.sub));
    if (btn.dataset.sub === "top5") drawTop5();
  });

  // A group's play span from its platform entries: overall first/last, plus
  // the earliest start that was actually recorded (Steam's often is not).
  function groupSpan(g) {
    let start = null, end = null, knownStart = null;
    for (const p of g.parts) {
      const sp = state.spans.get(p.id);
      if (!sp) continue;
      start = minDate(start, sp.start);
      end = maxDate(end, sp.end);
      if (sp.startKnown) knownStart = minDate(knownStart, sp.start);
    }
    return start ? { start, end, knownStart } : null;
  }

  const groupsFor = (platform) =>
    platform ? groupEntries(state.entries.filter((e) => e.platform === platform)) : state.groups;

  // Games of a year. "New" needs a recorded start in the year; "played" is
  // any overlap. Hours are lifetime hours — what the platforms report — not
  // hours inside the year, which only the daily snapshots know.
  function yearGames(y, platform) {
    const from = `${y}-01-01`, to = `${y}-12-31`;
    const fresh = [], back = [];
    for (const g of groupsFor(platform)) {
      const sp = groupSpan(g);
      if (!sp || sp.end < from || sp.start > to) continue;
      (sp.knownStart && year(sp.knownStart) === String(y) ? fresh : back).push({ g, sp });
    }
    fresh.sort((a, b) => b.g.hours - a.g.hours);
    back.sort((a, b) => b.g.hours - a.g.hours);
    return { fresh, back };
  }

  function activeYears() {
    const now = +todayISO().slice(0, 4);
    let first = now;
    for (const sp of state.spans.values()) first = Math.min(first, +sp.start.slice(0, 4));
    const ys = [];
    for (let y = now; y >= first; y--) ys.push(y);
    return ys;
  }

  /* --- year in review --- */

  function renderYir() {
    $("#yirYear").innerHTML = activeYears().map((y) => `<option>${y}</option>`).join("");
    $("#yirYear").addEventListener("change", drawYir);
    $("#yirPlatform").addEventListener("click", (e) => {
      const btn = e.target.closest(".seg__btn");
      if (!btn) return;
      document.querySelectorAll("#yirPlatform .seg__btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      drawYir();
    });
    drawYir();
  }

  function drawYir() {
    const y = +$("#yirYear").value;
    const platform = $("#yirPlatform .is-active").dataset.platform;
    const { fresh, back } = yearGames(y, platform);
    const played = fresh.length + back.length;

    // Exact hours inside the year exist only for days the snapshots cover.
    const consoles = platform === "Steam" ? ["Steam"] : platform === "PlayStation" ? ["PS4", "PS5", "Other"] : null;
    let tracked = 0;
    for (const d of dailySeries().days) {
      if (d.date.slice(0, 4) !== String(y)) continue;
      tracked += consoles ? consoles.reduce((s, c) => s + (d.byConsole[c] || 0), 0) : d.hours;
    }

    const newHours = fresh.reduce((s, x) => s + x.g.hours, 0);
    const completed = fresh.filter((x) => hasTrophy(x.g)).length;
    const tiles = [
      [played, "games played"],
      [fresh.length, "new games"],
      [back.length, "returning games"],
      [fmtH(newHours), "hours in new games"],
      [`${TROPHY}${completed}`, "new games completed"],
    ];
    if (tracked > 0.05) tiles.push([fmtH(tracked) + "h", `tracked in ${y}`]);

    const byMonth = Array(12).fill(0);
    for (const x of fresh) byMonth[+x.sp.knownStart.slice(5, 7) - 1]++;
    const peak = Math.max(...byMonth, 1);

    const card = (x, i) => `
      <li class="yir__game">
        <span class="yir__rank">${i + 1}</span>
        ${cover(x.g)}
        <div class="yir__game-main">
          <div class="name"><span class="name__t">${esc(x.g.title)}</span>${pills(x.g)}${hasTrophy(x.g) ? TROPHY : ""}</div>
          <div class="meta">${x.sp.knownStart ? "started " + fmtDate(x.sp.knownStart) : "last played " + fmtDate(x.sp.end)}</div>
        </div>
        <b class="yir__hrs">${fmtH(x.g.hours)}h</b>
      </li>`;

    const label = platform || "All platforms";
    $("#yir").innerHTML = played ? `
      <div class="yir__hero">
        <span class="yir__eyebrow">${esc(label)}</span>
        <h2 class="yir__title">${y} in Review</h2>
      </div>
      <div class="tiles">${tiles.map(([v, l]) => `<div class="tile"><b>${v}</b><span>${esc(l)}</span></div>`).join("")}</div>

      ${fresh.length ? `<h3 class="h">Top new games of ${y}</h3>
        <ol class="yir__list">${fresh.slice(0, 10).map(card).join("")}</ol>` : ""}

      ${fresh.length ? `<h3 class="h">When you started them</h3>
        <div class="chartbox yir__months">${byMonth.map((n, i) => `
          <div class="yir__month"><span class="yir__bar" style="height:${(n / peak * 100).toFixed(0)}%"></span>
            <b>${n || ""}</b><i>${MONTHS[i][0]}</i></div>`).join("")}</div>` : ""}

      ${back.length ? `<h3 class="h">Returned to</h3>
        <ol class="yir__list">${back.slice(0, 10).map(card).join("")}</ol>
        ${back.length > 10 ? `<p class="hint">…and ${back.length - 10} more.</p>` : ""}` : ""}

      ${platform === "Steam" ? `<p class="hint">Steam start dates exist only since tracking began, and for Slay the Spire 2.</p>` : ""}
    ` : `<p class="empty">Nothing on ${esc(label)} in ${y}.</p>`;
  }

  /* --- top 5 generator --- */

  const T5_KEY = "playtime.top5";
  const ICON = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON_UPLOAD = ICON(`<path d="M12 15V4"/><path d="m7 9 5-5 5 5"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>`);
  const ICON_PASTE = ICON(`<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h1a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1"/>`);
  const PS_PATH = new Path2D("M8.984 2.596v17.547l3.915 1.261V6.688c0-.69.304-1.151.794-.991.636.18.76.814.76 1.505v5.875c2.441 1.193 4.362-.002 4.362-3.152 0-3.237-1.126-4.675-4.438-5.827-1.307-.448-3.728-1.186-5.39-1.502zm4.656 16.241l6.296-2.275c.715-.258.826-.625.246-.818-.586-.192-1.637-.139-2.357.123l-4.205 1.5V14.98l.24-.085s1.201-.42 2.913-.615c1.696-.18 3.785.03 5.437.661 1.848.601 2.04 1.472 1.576 2.072-.465.6-1.622 1.036-1.622 1.036l-8.544 3.107V18.86zM1.807 18.6c-1.9-.545-2.214-1.668-1.352-2.32.801-.586 2.16-1.052 2.16-1.052l5.615-2.013v2.313L4.205 17c-.705.271-.825.632-.239.826.586.195 1.637.15 2.343-.12L8.247 17v2.074c-.12.03-.256.044-.39.073-1.939.331-3.996.196-6.038-.479z");
  const SWITCH_PATH = new Path2D("M14.176 24h3.674c3.376 0 6.15-2.774 6.15-6.15V6.15C24 2.775 21.226 0 17.85 0H14.1c-.074 0-.15.074-.15.15v23.7c-.001.076.075.15.226.15zm4.574-13.199c1.351 0 2.399 1.125 2.399 2.398 0 1.352-1.125 2.4-2.399 2.4-1.35 0-2.4-1.049-2.4-2.4-.075-1.349 1.05-2.398 2.4-2.398zM11.4 0H6.15C2.775 0 0 2.775 0 6.15v11.7C0 21.226 2.775 24 6.15 24h5.25c.074 0 .15-.074.15-.149V.15c.001-.076-.075-.15-.15-.15zM9.676 22.051H6.15c-2.326 0-4.201-1.875-4.201-4.201V6.15c0-2.326 1.875-4.201 4.201-4.201H9.6l.076 20.102zM3.75 7.199c0 1.275.975 2.25 2.25 2.25s2.25-.975 2.25-2.25c0-1.273-.975-2.25-2.25-2.25s-2.25.977-2.25 2.25z");
  const GOG_PATH = new Path2D("M7.15 15.24H4.36a.4.4 0 0 0-.4.4v2c0 .21.18.4.4.4h2.8v1.32h-3.5c-.56 0-1.02-.46-1.02-1.03v-3.39c0-.56.46-1.02 1.03-1.02h3.48v1.32zM8.16 11.54c0 .58-.47 1.05-1.05 1.05H2.63v-1.35h3.78a.4.4 0 0 0 .4-.4V6.39a.4.4 0 0 0-.4-.4H4.39a.4.4 0 0 0-.41.4v2.02c0 .23.18.4.4.4H6v1.35H3.68c-.58 0-1.05-.46-1.05-1.04V5.68c0-.57.47-1.04 1.05-1.04H7.1c.58 0 1.05.47 1.05 1.04v5.86zM21.36 19.36h-1.32v-4.12h-.93a.4.4 0 0 0-.4.4v3.72h-1.33v-4.12h-.93a.4.4 0 0 0-.4.4v3.72h-1.33v-4.42c0-.56.46-1.02 1.03-1.02h5.61v5.44zM21.37 11.54c0 .58-.47 1.05-1.05 1.05h-4.48v-1.35h3.78a.4.4 0 0 0 .4-.4V6.39a.4.4 0 0 0-.4-.4h-2.03a.4.4 0 0 0-.4.4v2.02c0 .23.18.4.4.4h1.62v1.35H16.9c-.58 0-1.05-.46-1.05-1.04V5.68c0-.57.47-1.04 1.05-1.04h3.43c.58 0 1.05.47 1.05 1.04v5.86zM13.72 4.64h-3.44c-.58 0-1.04.47-1.04 1.04v3.44c0 .58.46 1.04 1.04 1.04h3.44c.57 0 1.04-.46 1.04-1.04V5.68c0-.57-.47-1.04-1.04-1.04m-.3 1.75v2.02a.4.4 0 0 1-.4.4h-2.03a.4.4 0 0 1-.4-.4V6.4c0-.22.17-.4.4-.4H13c.23 0 .4.18.4.4zM12.63 13.92H9.24c-.57 0-1.03.46-1.03 1.02v3.39c0 .57.46 1.03 1.03 1.03h3.39c.57 0 1.03-.46 1.03-1.03v-3.39c0-.56-.46-1.02-1.03-1.02m-.3 1.72v2a.4.4 0 0 1-.4.4v-.01H9.94a.4.4 0 0 1-.4-.4v-1.99c0-.22.18-.4.4-.4h2c.22 0 .4.18.4.4zM23.49 1.1a1.74 1.74 0 0 0-1.24-.52H1.75A1.74 1.74 0 0 0 0 2.33v19.34a1.74 1.74 0 0 0 1.75 1.75h20.5A1.74 1.74 0 0 0 24 21.67V2.33c0-.48-.2-.92-.51-1.24m0 20.58a1.23 1.23 0 0 1-1.24 1.24H1.75A1.23 1.23 0 0 1 .5 21.67V2.33a1.23 1.23 0 0 1 1.24-1.24h20.5a1.24 1.24 0 0 1 1.24 1.24v19.34z");
  // Platforms a typed-in game can be on. Ones without a logo get a text badge.
  const T5_PLATFORMS = ["Switch", "GOG", "Xbox", "PC", "PlayStation", "Steam", "Other"];
  const STEAM_PATH = new Path2D("M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z");
  const T5_THEMES = {
    slate:    { name: "Slate",    bg: ["#a9bcc1", "#6d8389"], banner: "#1f3f4f", text: "#f3eee4", title: "#17394a", shadow: ["#35d6d6", "#d23bd0"], sign: "#17394a" },
    amethyst: { name: "Amethyst", bg: ["#6c43a8", "#2b1850"], banner: "#3a2266", text: "#f4eefc", title: "#ffffff", shadow: ["#b88cff", "#2b1850"], sign: "#ffffff" },
    midnight: { name: "Midnight", bg: ["#23355a", "#0b1220"], banner: "#16233c", text: "#eef3ff", title: "#ffffff", shadow: ["#6d95ff", "#d23b3b"], sign: "#6d95ff" },
    ember:    { name: "Ember",    bg: ["#e0703a", "#5a1d1d"], banner: "#3a1414", text: "#fff4ec", title: "#fff4ec", shadow: ["#ffcf6b", "#3a1414"], sign: "#fff4ec" },
  };

  const t5 = { title: "", sign: "VIGZ", theme: "slate", ranks: false, slots: [null, null, null, null, null], uploads: {} };
  const t5Images = new Map();
  let t5Blob = null;

  function loadT5() {
    try { Object.assign(t5, JSON.parse(localStorage.getItem(T5_KEY)) || {}); } catch (_) {}
    t5.uploads = {};   // uploaded covers are session-only: too big for storage
    t5.slots = Array.from({ length: 5 }, (_, i) => t5.slots[i] || null);
  }
  function saveT5() {
    try {
      const { uploads, ...keep } = t5;
      localStorage.setItem(T5_KEY, JSON.stringify(keep));
    } catch (_) {}
  }

  const groupByKey = (key) => state.groups.find((g) => g.key === key) || null;

  // A slot holds a library game's key, or a game typed in by hand — one from
  // Switch, GOG or anywhere else the tracker cannot see. Either way the
  // poster wants the same things: a title, hours if known, platforms.
  function slotGame(i) {
    const v = t5.slots[i];
    if (!v) return null;
    if (typeof v === "object") {
      return { title: v.title, hours: v.hours, platforms: [v.platform || "Other"], group: null };
    }
    const g = groupByKey(v);
    return g ? { title: g.title, hours: g.hours, platforms: g.platforms, group: g } : null;
  }

  // Poster art. Steam has portrait art with CORS; Sony's CDN sends no CORS
  // header, which blocks exporting a canvas that contains it, so PlayStation
  // art comes through an image proxy that adds one. An uploaded cover wins.
  function coverUrl(g, slot) {
    if (t5.uploads[slot]) return t5.uploads[slot];
    if (!g) return null;
    const steam = g.parts.find((p) => p.platform === "Steam" && p.appid);
    if (steam) return `https://cdn.cloudflare.steamstatic.com/steam/apps/${steam.appid}/library_600x900.jpg`;
    const src = g.parts.find((p) => p.cover) ;
    return src ? `https://wsrv.nl/?url=${encodeURIComponent(src.cover)}&w=600&h=900&fit=cover&output=jpg` : null;
  }
  const fallbackUrl = (g) => {
    const p = g && g.parts.find((x) => x.cover);
    return p ? `https://wsrv.nl/?url=${encodeURIComponent(p.cover)}&w=600&h=900&fit=cover&output=jpg` : null;
  };

  function loadImage(url) {
    if (!url) return Promise.resolve(null);
    if (t5Images.has(url)) return t5Images.get(url);
    const p = new Promise((resolve) => {
      const img = new Image();
      if (!url.startsWith("blob:") && !url.startsWith("data:")) img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    t5Images.set(url, p);
    return p;
  }

  function renderTop5() {
    loadT5();
    const years = activeYears();
    $("#t5Year").innerHTML = `<option value="">—</option>` + years.map((y) => `<option>${y}</option>`).join("");
    $("#t5Theme").innerHTML = Object.entries(T5_THEMES).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("");
    $("#t5Games").innerHTML = state.groups.map((g) => `<option value="${esc(g.title)}"></option>`).join("");
    if (!t5.title) t5.title = `TOP 5 GAMES OF ${years[0]}`;
    $("#t5Title").value = t5.title;
    $("#t5Sign").value = t5.sign;
    $("#t5Theme").value = t5.theme;
    $("#t5Ranks").checked = !!t5.ranks;

    $("#t5Title").addEventListener("input", (e) => { t5.title = e.target.value; saveT5(); drawTop5(); });
    $("#t5Sign").addEventListener("input", (e) => { t5.sign = e.target.value; saveT5(); drawTop5(); });
    $("#t5Theme").addEventListener("change", (e) => { t5.theme = e.target.value; saveT5(); drawTop5(); });
    $("#t5Ranks").addEventListener("change", (e) => { t5.ranks = e.target.checked; saveT5(); drawTop5(); });
    $("#t5Year").addEventListener("change", (e) => {
      const y = e.target.value;
      if (!y) return;
      // A starting point, not a verdict: the five most-played new games.
      const picks = yearGames(+y, "").fresh.slice(0, 5).map((x) => x.g.key);
      t5.slots = Array.from({ length: 5 }, (_, i) => picks[i] || null);
      t5.uploads = {};
      t5.title = `TOP 5 GAMES OF ${y}`;
      $("#t5Title").value = t5.title;
      saveT5(); drawSlots(); drawTop5();
    });
    $("#t5Save").addEventListener("click", exportTop5);
    drawSlots();
  }

  function drawSlots() {
    $("#t5Slots").innerHTML = t5.slots.map((v, i) => {
      const sg = slotGame(i);
      const custom = v && typeof v === "object";
      const meta = !sg ? "empty"
        : custom ? (t5.uploads[i] ? "your game · custom cover" : "your game · add a cover")
        : `${fmtH(sg.hours)}h · ${sg.platforms.join(" + ")}${t5.uploads[i] ? " · custom cover" : ""}`;
      const extra = custom ? `
          <div class="t5slot__custom">
            <input type="number" min="0" step="1" inputmode="numeric" placeholder="Hours" value="${v.hours ?? ""}"
              data-act="hours" aria-label="Hours for ${esc(v.title)}">
            <select data-act="platform" aria-label="Platform for ${esc(v.title)}">
              ${T5_PLATFORMS.map((p) => `<option${p === (v.platform || "Other") ? " selected" : ""}>${p}</option>`).join("")}
            </select>
          </div>` : "";
      return `<li class="t5slot" data-i="${i}">
        <span class="t5slot__n">${i + 1}</span>
        <div class="t5slot__pick">
          <input list="t5Games" placeholder="Pick or type a game…" value="${sg ? esc(sg.title) : ""}" aria-label="Game in position ${i + 1}">
          ${extra}
          <span class="t5slot__meta">${esc(meta)}</span>
        </div>
        <div class="t5slot__btns">
          <button type="button" data-act="up" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-act="down" aria-label="Move down" ${i === 4 ? "disabled" : ""}>↓</button>
          <label class="t5slot__upload" title="Upload a cover" aria-label="Upload a cover">${ICON_UPLOAD}<input type="file" accept="image/*" data-act="upload"></label>
          <button type="button" data-act="paste" title="Paste a cover from the clipboard" aria-label="Paste a cover">${ICON_PASTE}</button>
          <button type="button" data-act="clear" aria-label="Clear">×</button>
        </div>
      </li>`;
    }).join("");
  }

  function setCover(i, blob) {
    if (t5.uploads[i]) URL.revokeObjectURL(t5.uploads[i]);
    t5.uploads[i] = URL.createObjectURL(blob);
    $("#t5Note").textContent = "";
    drawSlots(); drawTop5();
  }

  // Paste: the button reads the clipboard directly (iOS shows its own
  // "Paste" bubble). Where the browser refuses, fall back to the keyboard —
  // the next ⌘V / Ctrl+V with an image lands in the slot that asked.
  let pasteTarget = null;
  async function pasteInto(i) {
    if (navigator.clipboard && navigator.clipboard.read) {
      try {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type) { setCover(i, await item.getType(type)); return; }
        }
        $("#t5Note").textContent = "There's no image on the clipboard.";
        return;
      } catch (_) { /* denied or unsupported — use the keyboard instead */ }
    }
    pasteTarget = i;
    $("#t5Note").textContent = `Press ⌘V / Ctrl+V to paste into #${i + 1}.`;
  }

  document.addEventListener("paste", (e) => {
    if (!$("#sub-top5").classList.contains("is-active")) return;
    const item = [...((e.clipboardData && e.clipboardData.items) || [])].find((x) => x.type.startsWith("image/"));
    if (!item) return;                       // plain text pastes behave normally
    const focused = document.activeElement && document.activeElement.closest(".t5slot");
    const i = focused ? +focused.dataset.i
      : pasteTarget !== null ? pasteTarget
      : Math.max(0, t5.slots.findIndex((k, n) => k && !t5.uploads[n]));
    e.preventDefault();
    pasteTarget = null;
    setCover(i, item.getAsFile());
  });

  $("#t5Slots").addEventListener("change", (e) => {
    const li = e.target.closest(".t5slot");
    if (!li) return;
    const i = +li.dataset.i;
    if (e.target.dataset.act === "upload") {
      const file = e.target.files && e.target.files[0];
      if (file) setCover(i, file);
      return;
    } else if (e.target.matches("input[list]")) {
      const typed = e.target.value.trim();
      const g = state.groups.find((x) => x.title === typed);
      const was = t5.slots[i];
      if (g) t5.slots[i] = g.key;
      else if (typed) {
        // Not in the library: keep it as the user's own entry, carrying over
        // hours and platform if they are only correcting the name.
        const prev = was && typeof was === "object" ? was : {};
        t5.slots[i] = { title: typed, hours: prev.hours ?? null, platform: prev.platform || "Switch" };
      } else t5.slots[i] = null;
      if (!(was && typeof was === "object" && typeof t5.slots[i] === "object")) delete t5.uploads[i];
    } else if (e.target.dataset.act === "hours" || e.target.dataset.act === "platform") {
      const v = t5.slots[i];
      if (v && typeof v === "object") {
        if (e.target.dataset.act === "hours") v.hours = e.target.value === "" ? null : Math.max(0, +e.target.value);
        else v.platform = e.target.value;
      }
    }
    saveT5(); drawSlots(); drawTop5();
  });
  $("#t5Slots").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const i = +btn.closest(".t5slot").dataset.i;
    const swap = (a, b) => {
      [t5.slots[a], t5.slots[b]] = [t5.slots[b], t5.slots[a]];
      [t5.uploads[a], t5.uploads[b]] = [t5.uploads[b], t5.uploads[a]];
    };
    if (btn.dataset.act === "up" && i > 0) swap(i, i - 1);
    if (btn.dataset.act === "down" && i < 4) swap(i, i + 1);
    if (btn.dataset.act === "paste") { pasteInto(i); return; }
    if (btn.dataset.act === "clear") { t5.slots[i] = null; delete t5.uploads[i]; }
    saveT5(); drawSlots(); drawTop5();
  });

  function wrapLines(ctx, text, maxW, maxLines) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width <= maxW || !line) line = test;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      lines.length = maxLines;
      while (ctx.measureText(lines[maxLines - 1] + "…").width > maxW && lines[maxLines - 1].includes(" "))
        lines[maxLines - 1] = lines[maxLines - 1].replace(/\s+\S+$/, "");
      lines[maxLines - 1] += "…";
    }
    return lines;
  }

  function drawLogo(ctx, path, cx, cy, size, color) {
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.fillStyle = color;
    ctx.fill(path);
    ctx.restore();
  }

  let t5Drawing = 0;
  async function drawTop5() {
    const run = ++t5Drawing;
    const canvas = $("#t5Canvas");
    const ctx = canvas.getContext("2d");
    const W = 1080, H = 1350;
    const th = T5_THEMES[t5.theme] || T5_THEMES.slate;
    const font = '"Bebas Neue", "Impact", "Arial Narrow", sans-serif';
    try { await document.fonts.load(`100px "Bebas Neue"`); } catch (_) {}

    const games = t5.slots.map((_, i) => slotGame(i));
    const imgs = await Promise.all(games.map(async (sg, i) => {
      if (!sg) return null;
      return (await loadImage(coverUrl(sg.group, i))) || (await loadImage(fallbackUrl(sg.group)));
    }));
    if (run !== t5Drawing) return;   // a newer draw started while images loaded

    // Background: soft two-tone gradient, a vignette, and fine grain.
    const bg = ctx.createRadialGradient(W * 0.3, H * 0.2, 100, W / 2, H / 2, H * 0.85);
    bg.addColorStop(0, th.bg[0]); bg.addColorStop(1, th.bg[1]);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 9000; i++) {
      ctx.fillStyle = `rgba(${rnd() > 0.5 ? "255,255,255" : "0,0,0"},${(rnd() * 0.05).toFixed(3)})`;
      ctx.fillRect(rnd() * W, rnd() * H, 2, 2);
    }

    // Title with an offset two-colour shadow.
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    let size = 150;
    ctx.font = `${size}px ${font}`;
    while (ctx.measureText(t5.title).width > W - 120 && size > 60) ctx.font = `${(size -= 4)}px ${font}`;
    ctx.fillStyle = th.shadow[0]; ctx.fillText(t5.title, W / 2 - 5, 158);
    ctx.fillStyle = th.shadow[1]; ctx.fillText(t5.title, W / 2 + 5, 164);
    ctx.fillStyle = th.title;     ctx.fillText(t5.title, W / 2, 161);

    // Three cards over two, as in the originals.
    const cw = 256, ch = 384;
    const spots = [[190, 205], [540, 205], [890, 205], [365, 790], [715, 790]];
    spots.forEach(([cx, top], i) => {
      const g = games[i];
      const x = cx - cw / 2;
      // cover with a white border
      ctx.fillStyle = "#ffffff"; ctx.fillRect(x - 6, top - 6, cw + 12, ch + 12);
      ctx.fillStyle = "rgba(0,0,0,.25)"; ctx.fillRect(x, top, cw, ch);
      const img = imgs[i];
      if (img) {
        // cover-fit into the 2:3 frame
        const r = Math.max(cw / img.width, ch / img.height);
        const sw = cw / r, sh = ch / r;
        ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, top, cw, ch);
      } else {
        ctx.fillStyle = th.text; ctx.globalAlpha = 0.5;
        ctx.font = `40px ${font}`; ctx.fillText(g ? "ADD A COVER" : `#${i + 1}`, cx, top + ch / 2);
        ctx.globalAlpha = 1;
      }
      if (t5.ranks && g) {
        ctx.fillStyle = th.banner; ctx.beginPath(); ctx.arc(x + 4, top + 4, 34, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = th.text; ctx.font = `46px ${font}`; ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), x + 4, top + 7); ctx.textBaseline = "alphabetic";
      }

      // banner with a pointed foot
      const by = top + ch + 6, bh = 118, point = 34;
      ctx.fillStyle = th.banner;
      ctx.beginPath();
      ctx.moveTo(x, by); ctx.lineTo(x + cw, by); ctx.lineTo(x + cw, by + bh);
      ctx.lineTo(cx, by + bh + point); ctx.lineTo(x, by + bh); ctx.closePath(); ctx.fill();
      if (!g) return;

      ctx.fillStyle = th.text;
      ctx.font = `36px ${font}`;
      const lines = wrapLines(ctx, g.title.replace(/[™®©]/g, ""), cw - 24, 2);
      lines.forEach((ln, k) => ctx.fillText(ln, cx, by + 38 + k * 34));
      if (g.hours != null && g.hours !== "") ctx.fillText(`${Math.round(g.hours)}H`, cx, by + 38 + 2 * 34);

      // platform logos along the foot; platforms without one get a word
      const LOGOS = { PlayStation: PS_PATH, Steam: STEAM_PATH, Switch: SWITCH_PATH, GOG: GOG_PATH };
      const marks = g.platforms.map((p) => LOGOS[p] || p.toUpperCase());
      const gap = 40;
      marks.forEach((m, k) => {
        const mx = cx + (k - (marks.length - 1) / 2) * gap, my = by + bh + 4;
        if (typeof m === "string") {
          ctx.font = `26px ${font}`; ctx.textBaseline = "middle";
          ctx.fillText(m, mx, my + 1); ctx.textBaseline = "alphabetic";
        } else drawLogo(ctx, m, mx, my, 30, th.text);
      });
    });

    // signature
    if (t5.sign) {
      ctx.textAlign = "right"; ctx.font = `96px ${font}`;
      ctx.fillStyle = th.shadow[0]; ctx.fillText(t5.sign, W - 44, H - 42);
      ctx.fillStyle = th.sign;      ctx.fillText(t5.sign, W - 48, H - 46);
    }

    // Keep an export ready, so the Save tap can share it straight away —
    // iOS only allows sharing inside the tap itself.
    t5Blob = null;
    try {
      canvas.toBlob((b) => { if (run === t5Drawing) t5Blob = b; }, "image/png");
      $("#t5Note").textContent = "";
    } catch (_) {
      $("#t5Note").textContent = "A cover could not be exported — upload that cover instead.";
    }
  }

  async function exportTop5() {
    const name = (t5.title || "top-5").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".png";
    if (!t5Blob) {
      $("#t5Note").textContent = "Still drawing — try again in a second.";
      return;
    }
    const file = new File([t5Blob], name, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: t5.title }); return; } catch (_) { /* cancelled */ return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(t5Blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ------------------------------------------------------- chart helpers */

  // A round step that gives about four gridlines at whatever scale the data is.
  function niceStep(max) {
    for (const step of [0.25, 0.5, 1, 2, 3, 4, 5, 10, 20]) if (max / step <= 4) return step;
    return Math.ceil(max / 4);
  }

  // Hours per day, one bar per day stacked by console (PS4 at the bottom,
  // Steam on top), with an hours axis and dates underneath.
  function stackedDays(days) {
    const ORDER = ["PS4", "PS5", "Steam", "Other"];
    // SVG text scales with the viewBox, so a 1000-wide chart squeezed onto a
    // phone rendered its axis labels at 5px. Match the coordinate space to
    // the screen and the text stays the size it is written as.
    const narrow = window.innerWidth <= 640;
    const w = narrow ? 380 : 1000, h = narrow ? 210 : 230;
    const padL = 42, padR = 8, padT = 12, padB = 28;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    const max = Math.max(...days.map((d) => d.hours), 0.25);
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;
    const y = (v) => padT + plotH - (v / top) * plotH;

    let grid = "";
    for (let v = 0; v <= top + 1e-9; v += step) {
      const gy = y(v).toFixed(1);
      grid += `<line x1="${padL}" y1="${gy}" x2="${w - padR}" y2="${gy}" stroke="var(--line)"${v ? ' stroke-dasharray="3 4"' : ""}/>` +
              `<text x="${padL - 8}" y="${(+gy + 4).toFixed(1)}" font-size="12" fill="var(--muted)" text-anchor="end">${+v.toFixed(2)}h</text>`;
    }

    const slot = plotW / days.length;
    // A few days of data should read as bars, not slabs.
    const bw = Math.min(44, slot * 0.72);
    const every = Math.max(1, Math.ceil(days.length / 8));

    const bars = days.map((d, i) => {
      const cx = padL + slot * (i + 0.5);
      const x = (cx - bw / 2).toFixed(1);
      let cum = 0, stack = "";
      for (const c of ORDER) {
        const v = d.byConsole[c] || 0;
        if (v <= 0.001) continue;
        const y1 = y(cum + v), y0 = y(cum);
        stack += `<rect x="${x}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, y0 - y1).toFixed(1)}" fill="${tint(c)}"/>`;
        cum += v;
      }
      const parts = ORDER.filter((c) => d.byConsole[c] > 0.001).map((c) => `${c} ${fmtH(d.byConsole[c])}h`).join(", ");
      const tip = `${fmtDate(d.date)} — ${fmtH(d.hours)}h${parts ? " (" + parts + ")" : ""}${d.estimated ? " · estimated across a gap" : ""}`;
      const iso = d.date;
      const label = i % every === 0
        ? `<text x="${cx.toFixed(1)}" y="${h - 10}" font-size="12" fill="var(--muted)" text-anchor="middle">${+iso.slice(8)} ${MONTHS[+iso.slice(5, 7) - 1]}</text>`
        : "";
      // A full-height transparent strip, so the tooltip works even on a zero day.
      return `<g${d.estimated ? ' opacity="0.45"' : ""}><title>${esc(tip)}</title>
        <rect x="${(cx - slot / 2).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent"/>
        ${stack}</g>${label}`;
    }).join("");

    const present = ORDER.filter((c) => days.some((d) => d.byConsole[c] > 0.001));
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Hours played per day, by platform">${grid}${bars}</svg>
      <div class="legend">${present.map((c) => `<span><i style="background:${tint(c)}"></i>${esc(c)}</span>`).join("")}</div>`;
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

  // One handler for both lists: rows are rendered closed and open in place.
  for (const id of ["#topList", "#gameList"]) {
    $(id).addEventListener("click", (e) => {
      const head = e.target.closest(".row__head");
      if (!head) return;
      const open = head.getAttribute("aria-expanded") === "true";
      head.setAttribute("aria-expanded", open ? "false" : "true");
      head.parentElement.classList.toggle("is-open", !open);
      head.nextElementSibling.hidden = open;
    });
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
