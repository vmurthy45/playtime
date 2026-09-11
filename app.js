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
          const a = (activity[id] ||= { first: null, last: null });
          a.first = minDate(a.first, fromDay(from));
          a.last = maxDate(a.last, fromDay(to));
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
    state.spans = timelineSpans();
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
