# Playtime

Cross-platform gaming play-time stats. Not a library manager — this is only about
hours: which games got them, when, and on what.

Static site, no build step, no dependencies in the browser. Collectors run in
GitHub Actions and commit their output to `data/`, so history keeps accumulating
whether or not the site is ever opened.

## Status

| Source | State | Notes |
| --- | --- | --- |
| PlayStation | **working** | `tools/psn_sync.py`, daily via Actions |
| Steam | **built, needs credentials** | `tools/steam_sync.py`; add `STEAM_API_KEY` + `STEAM_ID` |
| Steam Deck / GOG via Heroic | planned | read the SDH-PlayTime plugin's SQLite db on the Deck |

## Run it locally

```bash
pip install psnawp
cp .env.example .env          # then fill in the credentials
python3 tools/psn_sync.py --out data
python3 tools/steam_sync.py --out data
python3 -m http.server 8230   # then open http://localhost:8230
```

Either collector can run without the other; the app renders whatever data files
exist.

`file://` will not work — the app fetches `data/*.json`, which browsers block on
the file protocol.

## Credentials

### Steam

- **API key** — <https://steamcommunity.com/dev/apikey>, free and instant. Enter
  any domain (`localhost` is fine). Does not expire.
- **SteamID64** — the 17-digit one, from <https://steamid.io/>.
- **Profile > Privacy Settings > "Game details" must be Public**, or the API
  returns an empty library with no error worth reading.

### The npsso token

PSN auth is a browser cookie, not an API key:

1. Log in to PlayStation in a browser.
2. Open <https://ca.account.sony.com/api/v1/ssocookie>.
3. Copy the 64-character `npsso` value.

The `ca.` is Canada and is irrelevant — it reads the cookie from whatever session
you are logged into, from any region. `{"npsso":null}` means you are not logged
in, not that you are in the wrong place.

The npsso cookie lasts **about 60 days**, after which the sync fails and you
repeat the three steps above. Locally it lives in `.env` (gitignored); in CI it
is the repository secret `PSN_NPSSO`.

Every run exchanges the npsso for fresh tokens, so the short-lived access token
(1 hour) and refresh token (10 days) that `psnawp` reports are **not** the
deadline — only the npsso's own life matters. It cannot be renewed without a
login, so there is nothing to automate: when it dies the workflow raises a
GitHub issue telling you to replace it, and Steam keeps syncing meanwhile.

## Deploy

1. Push this folder as the root of a GitHub repo.
2. Settings → Secrets and variables → Actions → add `PSN_NPSSO`,
   `STEAM_API_KEY` and `STEAM_ID`.
3. Settings → Actions → General → Workflow permissions → **Read and write**.
4. Settings → Pages → deploy from branch, root.
5. Actions → *Daily play-time sync* → **Run workflow** once to confirm it works.

Each platform's fetch step is `continue-on-error`, so an expired PSN token does
not cost a day of Steam history — the run goes red but the other source still
commits.

After a code change, bump `CACHE` in `sw.js` or clients keep serving the old
shell from cache.

## The dashboard

- **Overview** — *Recently played* (the default) or *Most played*, ten each
  across both platforms.
- **Games** — everything, searchable and sortable, merged across platforms.
- **Timeline** — when each game was in rotation, filtered by a time window
  (last 7 days, last 30 days, this year, last year, all time, or any single
  year) and searchable by title. Tick spacing follows the window: weeks for a
  month, months for a year, years for a decade.
- **Daily** — hours per day, derived from snapshot diffs.
- **Stats** — totals, games started per year, where the hours went.

### Why the Timeline is dots, not bars

Only two dates per game are known for certain — first played and last played —
plus whatever days daily tracking has since recorded. A solid bar between them
would claim continuous play that never happened. So known days are dots, and the
faint line joining them means "in rotation across this stretch", nothing more.
The middle fills in with real dots as daily syncing accumulates.

The site renders in light mode only.

## How the numbers are derived

PSN reports **lifetime totals per title**, never a per-day breakdown. So:

- **Totals, first played, last played, session counts** are exact, straight from
  Sony, going back to the account's first game.
- **Hours per day** are derived by diffing consecutive daily snapshots in
  `data/snapshots.json`. That means the daily chart only fills in from the second
  sync onward, and days before the first sync are genuinely unknown rather than
  zero — the app draws them that way.
- The sync runs at **12:00 UTC, midnight in Auckland** (1am while daylight
  saving is on — cron cannot follow DST). Snapshots are stamped with the *local*
  date, and the hours between two snapshots are credited to the day that just
  ended, so an evening's play lands on the evening's date.
- When two syncs land more than a day apart, the total for that window is real
  but the split across those days is an even guess. Those bars are drawn hatched
  and labelled estimated.

**Trophies and achievements.** PSN trophy counts come from one paginated call
covering the whole account, matched to games by normalised title (PSN gives no
title id on those records). A platinum shows as a badge on the row. Steam
achievements need one call per game, so they are cached in `steam_titles.json`
and only re-fetched when a game's play time moves — a first run sweeps ~180
games, after that it is a handful a day. Games with no achievement schema
(early access, mostly) make Steam return a 500; that "checked, has none"
result is cached too, so they are not retried daily.

`play_count` counts launches, not sessions in a strict sense — a game suspended
and resumed can count again, so "average session" runs short on games you dip in
and out of. Steam reports no launch count at all, so session figures are
PlayStation-only.

Steam has no first-played field either. `steam_sync.py` derives one by watching
for a game going from zero hours to non-zero between syncs; games already played
before the first sync keep an empty start date and stay off the Timeline.

### What counts as a game

Consoles report Netflix, YouTube, Disney+, Plex and the like as titles with play
time — on this account that was 67 hours of "play". They are dropped by both
collectors and hidden by the app, using the list in `data/non_games.json`.
Matching is on the normalised title, so add a name to that file to hide anything
else (or an id under `ids` for a title a name cannot catch). Steam's separate
`- Multiplayer` entries are genuine game components and are kept.

### Same game, two platforms

Entries are merged into one game by a normalised title — trademark symbols and
punctuation stripped, nothing more aggressive, so *Modern Warfare* and *Modern
Warfare Remastered* stay separate. A merged game shows one row with a per-platform
split. If the normaliser misses a pairing, force it in `data/aliases.json` by
mapping the game's id to the other title's normalised form.

## Files

```
index.html  styles.css  app.js     the dashboard (Overview / Games / Timeline / Daily)
sw.js  manifest.webmanifest        PWA shell — bump CACHE on every change
tools/psn_sync.py                  PSN collector
tools/steam_sync.py                Steam collector
data/psn_titles.json               current lifetime totals per title
data/steam_titles.json             same, for Steam (plus per-device hours)
data/aliases.json                  manual cross-platform title pairings
data/non_games.json                titles to hide — media apps, tools
tools/filters.py                   shared exclusion logic for the collectors
data/snapshots.json                append-only history, one entry per sync per source
.github/workflows/sync.yml         both collectors, daily at midnight NZ
```
