#!/usr/bin/env python3
"""
PSN play-time collector.

Pulls per-title play time from the PlayStation Network and writes it in the
app's data model. Two outputs:

  psn_titles.json   current lifetime totals per title (hours, session count,
                    first/last played, cover art)
  snapshots.json    append-only history: one entry per sync per source, so
                    consecutive entries can be diffed into hours-per-day

PSN reports LIFETIME totals only, never a per-day breakdown. The daily series
is therefore derived by diffing snapshots — which means day-by-day history
starts accumulating from the second sync onward. first/last played dates come
straight from Sony and reach back to the account's first game, so the long-run
timeline is available immediately.

--------------------------------------------------------------------------------
SETUP
--------------------------------------------------------------------------------
1. Log in to PlayStation in a browser, then open:
       https://ca.account.sony.com/api/v1/ssocookie
   Copy the 64-character "npsso" value. (The "ca." is Canada but is
   region-irrelevant — it reads the cookie from your logged-in session. A
   null npsso means you are not logged in, not that you are in the wrong
   region.)

2. Put it in the environment (locally: playtime-tracker/.env, which is
   gitignored; in CI: a repository secret named PSN_NPSSO):
       PSN_NPSSO=xxxxxxxx...

   The refresh token derived from it lasts ~60 days, after which this script
   fails and you repeat step 1.

--------------------------------------------------------------------------------
RUN
--------------------------------------------------------------------------------
    pip install psnawp
    python3 tools/psn_sync.py --out data
"""

import argparse
import datetime as dt
import json
import os
import pathlib
import sys

from filters import split_games

SOURCE = "psn"


def load_dotenv(path):
    """Minimal .env reader — avoids a dependency for one variable."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def fetch_titles(npsso):
    from psnawp_api import PSNAWP

    client = PSNAWP(npsso).me()
    titles = []
    for t in client.title_stats():
        duration = t.play_duration
        titles.append(
            {
                "id": f"psn_{t.title_id}",
                "titleId": t.title_id,
                "title": t.name,
                "platform": "PlayStation",
                "console": _console(t.category, t.title_id),
                "hours": round(duration.total_seconds() / 3600, 3) if duration else 0.0,
                "sessions": t.play_count,
                "firstPlayed": _date(t.first_played_date_time),
                "lastPlayed": _date(t.last_played_date_time),
                "cover": t.image_url,
            }
        )
    titles.sort(key=lambda g: -g["hours"])
    return client.online_id, titles


# Sony's own id scheme: PS4 titles are CUSA…, PS5 titles PPSA…
ID_PREFIX = {"CUSA": "PS4", "PPSA": "PS5"}


def _console(category, title_id):
    """Which console a title belongs to.

    The API's `category` is unreliable: delisted games come back as
    "not_found", some report a bare "unknown", and media apps have their own
    categories entirely. Only "ps4_game" and "ps5_native_game" are mapped by
    the library. The title id prefix is dependable where the category is not,
    so it decides whenever the category cannot.
    """
    name = str(category).rsplit(".", 1)[-1]
    if name in ("PS4", "PS5"):
        return name
    return ID_PREFIX.get((title_id or "")[:4].upper(), "Other")


def _date(value):
    return value.date().isoformat() if value else None


def update_snapshots(path, titles, today):
    """Append today's totals; replace the entry if today already ran."""
    snapshots = []
    if path.exists():
        try:
            snapshots = json.loads(path.read_text())
        except json.JSONDecodeError:
            print(f"! {path} is unreadable — starting a fresh history", file=sys.stderr)

    entry = {
        "date": today,
        "source": SOURCE,
        "hours": {g["id"]: g["hours"] for g in titles},
    }
    snapshots = [s for s in snapshots if not (s.get("date") == today and s.get("source") == SOURCE)]
    snapshots.append(entry)
    snapshots.sort(key=lambda s: (s.get("date", ""), s.get("source", "")))
    path.write_text(json.dumps(snapshots, indent=1))

    # Report what today actually added, so a cron log is worth reading.
    previous = [s for s in snapshots if s["source"] == SOURCE and s["date"] < today]
    if not previous:
        return None
    before = previous[-1]["hours"]
    gained = {
        gid: round(hours - before.get(gid, 0), 2)
        for gid, hours in entry["hours"].items()
        if hours - before.get(gid, 0) > 0.01
    }
    return gained


def main():
    parser = argparse.ArgumentParser(description="Fetch PSN play time.")
    parser.add_argument("--out", default="data", help="output directory (default: data)")
    args = parser.parse_args()

    root = pathlib.Path(__file__).resolve().parent.parent
    load_dotenv(root / ".env")

    npsso = os.environ.get("PSN_NPSSO", "").strip()
    if not npsso:
        sys.exit(
            "PSN_NPSSO is not set.\n"
            "Locally: copy .env.example to .env and paste your npsso.\n"
            "In CI: add a repository secret named PSN_NPSSO.\n"
            "Get one at https://ca.account.sony.com/api/v1/ssocookie while logged in."
        )

    out = pathlib.Path(args.out)
    if not out.is_absolute():
        out = root / out
    out.mkdir(parents=True, exist_ok=True)

    try:
        online_id, titles = fetch_titles(npsso)
    except Exception as exc:  # noqa: BLE001 — the cause matters more than the type
        sys.exit(
            f"PSN fetch failed: {exc}\n"
            "If this mentions auth or a token, the npsso has most likely expired "
            "(they last ~60 days). Get a fresh one and update PSN_NPSSO."
        )

    titles, dropped = split_games(titles, out)
    if dropped:
        print(f"skipped {len(dropped)} non-game titles: " + ", ".join(g["title"] for g in dropped[:6]))

    today = dt.date.today().isoformat()
    payload = {
        "source": SOURCE,
        "onlineId": online_id,
        "syncedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "games": titles,
    }
    (out / "psn_titles.json").write_text(json.dumps(payload, indent=1))

    total = sum(g["hours"] for g in titles)
    print(f"{online_id}: {len(titles)} titles, {total:,.1f} hours total")

    gained = update_snapshots(out / "snapshots.json", titles, today)
    if gained is None:
        print("First snapshot recorded — daily history starts from the next sync.")
    elif gained:
        for gid, hours in sorted(gained.items(), key=lambda kv: -kv[1]):
            name = next(g["title"] for g in titles if g["id"] == gid)
            print(f"  +{hours:.2f}h  {name}")
    else:
        print("No new play time since the last snapshot.")


if __name__ == "__main__":
    main()
