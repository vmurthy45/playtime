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
| Steam | planned | port `steam_sync.py` from the old `game-library` repo |
| Steam Deck / GOG via Heroic | planned | read the SDH-PlayTime plugin's SQLite db on the Deck |

## Run it locally

```bash
pip install psnawp
cp .env.example .env          # then paste your npsso into it
python3 tools/psn_sync.py --out data
python3 -m http.server 8230   # then open http://localhost:8230
```

`file://` will not work — the app fetches `data/*.json`, which browsers block on
the file protocol.

## The npsso token

PSN auth is a browser cookie, not an API key:

1. Log in to PlayStation in a browser.
2. Open <https://ca.account.sony.com/api/v1/ssocookie>.
3. Copy the 64-character `npsso` value.

The `ca.` is Canada and is irrelevant — it reads the cookie from whatever session
you are logged into, from any region. `{"npsso":null}` means you are not logged
in, not that you are in the wrong place.

The refresh token derived from it lasts **~60 days**, after which the sync fails
and you repeat the three steps above. Locally it lives in `.env` (gitignored); in
CI it is the repository secret `PSN_NPSSO`.

## Deploy

1. Push this folder as the root of a GitHub repo.
2. Settings → Secrets and variables → Actions → add `PSN_NPSSO`.
3. Settings → Actions → General → Workflow permissions → **Read and write**.
4. Settings → Pages → deploy from branch, root.
5. Actions → *Daily PSN sync* → **Run workflow** once to confirm it works.

After a code change, bump `CACHE` in `sw.js` or clients keep serving the old
shell from cache.

## How the numbers are derived

PSN reports **lifetime totals per title**, never a per-day breakdown. So:

- **Totals, first played, last played, session counts** are exact, straight from
  Sony, going back to the account's first game.
- **Hours per day** are derived by diffing consecutive daily snapshots in
  `data/snapshots.json`. That means the daily chart only fills in from the second
  sync onward, and days before the first sync are genuinely unknown rather than
  zero — the app draws them that way.
- When two syncs land more than a day apart, the total for that window is real
  but the split across those days is an even guess. Those bars are drawn hatched
  and labelled estimated.

`play_count` counts launches, not sessions in a strict sense — a game suspended
and resumed can count again, so "average session" runs short on games you dip in
and out of.

## Files

```
index.html  styles.css  app.js     the dashboard (Overview / Games / Timeline / Daily)
sw.js  manifest.webmanifest        PWA shell — bump CACHE on every change
tools/psn_sync.py                  PSN collector
data/psn_titles.json               current lifetime totals per title
data/snapshots.json                append-only history, one entry per sync per source
.github/workflows/psn-sync.yml     daily 06:00 UTC
```
