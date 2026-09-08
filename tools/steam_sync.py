#!/usr/bin/env python3
"""
Steam play-time collector.

Pulls owned games and play time from the Steam Web API and writes them in the
app's data model. Two outputs, matching psn_sync.py:

  steam_titles.json   current lifetime totals per game (hours, last played,
                      per-device split, cover art)
  snapshots.json      shared append-only history — this appends an entry with
                      source "steam" alongside the PSN ones

Steam reports LIFETIME totals only, so per-day hours come from diffing
consecutive snapshots. Steam also has no "first played" field, so this derives
one: when a game's total goes from zero to non-zero between two syncs, that
date is recorded and carried forward. Games already played before the first
sync cannot be back-dated — they simply have no first-played date.

--------------------------------------------------------------------------------
SETUP (one time)
--------------------------------------------------------------------------------
1. Get a Steam Web API key (free, instant):
       https://steamcommunity.com/dev/apikey
   Sign in, enter any domain (e.g. "localhost"), agree, copy the key.

2. Find your SteamID64 (17 digits): https://steamid.io/

3. Steam > Profile > Edit Profile > Privacy Settings >
   "Game details" = Public, otherwise the API returns nothing.

4. Put both in the environment (locally: .env, gitignored; in CI: repository
   secrets STEAM_API_KEY and STEAM_ID):
       STEAM_API_KEY=...
       STEAM_ID=765611...

--------------------------------------------------------------------------------
RUN
--------------------------------------------------------------------------------
    python3 tools/steam_sync.py --out data
"""

import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

from filters import split_games

SOURCE = "steam"
OWNED_URL = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/"
CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps"


def load_dotenv(path):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def fetch_owned(key, steamid):
    params = urllib.parse.urlencode(
        {
            "key": key,
            "steamid": steamid,
            "include_appinfo": 1,
            "include_played_free_games": 1,
            "format": "json",
        }
    )
    req = urllib.request.Request(
        f"{OWNED_URL}?{params}", headers={"User-Agent": "playtime/1.0"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            sys.exit("Steam rejected the request (401/403). Check STEAM_API_KEY.")
        sys.exit(f"HTTP error from Steam: {exc.code} {exc.reason}")
    except Exception as exc:  # noqa: BLE001
        sys.exit(f"Could not reach Steam: {exc}")

    games = (data.get("response") or {}).get("games")
    if games is None:
        sys.exit(
            "No games returned. Check STEAM_ID is your SteamID64 and that\n"
            "Profile > Privacy Settings > 'Game details' is set to Public."
        )
    return games


def to_model(g):
    appid = g["appid"]
    hours = round(g.get("playtime_forever", 0) / 60, 3)
    last_ts = g.get("rtime_last_played", 0)
    # Steam breaks total play time down by device; the Deck figure is the only
    # way to tell handheld hours from desktop ones.
    devices = {
        d: round(g.get(f"playtime_{d}_forever", 0) / 60, 3)
        for d in ("windows", "mac", "linux", "deck")
    }
    return {
        "id": f"steam_{appid}",
        "appid": appid,
        "title": g.get("name") or f"App {appid}",
        "platform": "Steam",
        "console": "Steam",
        "hours": hours,
        "sessions": None,  # Steam does not report launch counts
        "firstPlayed": None,  # derived below, once a 0 -> >0 transition is seen
        "lastPlayed": dt.date.fromtimestamp(last_ts).isoformat() if last_ts else None,
        "recentHours": round(g.get("playtime_2weeks", 0) / 60, 2),
        "devices": {k: v for k, v in devices.items() if v},
        "cover": f"{CDN}/{appid}/header.jpg",
    }


def carry_first_played(previous_path, games, today):
    """Keep known first-played dates; stamp today on games that just started.

    A game seen at zero hours in the last sync and above zero now was played
    for the first time since then. Anything already above zero on the very
    first sync has an unknowable start date and stays null.
    """
    if not previous_path.exists():
        return 0
    try:
        old = json.loads(previous_path.read_text())
    except json.JSONDecodeError:
        return 0

    before = {g["id"]: g for g in old.get("games", [])}
    started = 0
    for game in games:
        prev = before.get(game["id"])
        if not prev:
            continue
        if prev.get("firstPlayed"):
            game["firstPlayed"] = prev["firstPlayed"]
        elif prev.get("hours", 0) == 0 and game["hours"] > 0:
            game["firstPlayed"] = today
            started += 1
    return started


def update_snapshots(path, games, today):
    snapshots = []
    if path.exists():
        try:
            snapshots = json.loads(path.read_text())
        except json.JSONDecodeError:
            print(f"! {path} is unreadable — starting a fresh history", file=sys.stderr)

    entry = {
        "date": today,
        "source": SOURCE,
        "hours": {g["id"]: g["hours"] for g in games},
    }
    snapshots = [
        s for s in snapshots if not (s.get("date") == today and s.get("source") == SOURCE)
    ]
    snapshots.append(entry)
    snapshots.sort(key=lambda s: (s.get("date", ""), s.get("source", "")))
    path.write_text(json.dumps(snapshots, indent=1))

    previous = [s for s in snapshots if s["source"] == SOURCE and s["date"] < today]
    if not previous:
        return None
    before = previous[-1]["hours"]
    return {
        gid: round(hours - before.get(gid, 0), 2)
        for gid, hours in entry["hours"].items()
        if hours - before.get(gid, 0) > 0.01
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch Steam play time.")
    parser.add_argument("--out", default="data", help="output directory (default: data)")
    args = parser.parse_args()

    root = pathlib.Path(__file__).resolve().parent.parent
    load_dotenv(root / ".env")

    key = os.environ.get("STEAM_API_KEY", "").strip()
    steamid = os.environ.get("STEAM_ID", "").strip()
    if not key or not steamid:
        sys.exit(
            "STEAM_API_KEY and STEAM_ID must both be set.\n"
            "Locally: add them to .env (see .env.example).\n"
            "In CI: add them as repository secrets.\n"
            "Key: https://steamcommunity.com/dev/apikey"
        )

    out = pathlib.Path(args.out)
    if not out.is_absolute():
        out = root / out
    out.mkdir(parents=True, exist_ok=True)

    today = dt.date.today().isoformat()
    games = [to_model(g) for g in fetch_owned(key, steamid)]
    games, dropped = split_games(games, out)
    if dropped:
        print(f"skipped {len(dropped)} non-game titles: " + ", ".join(g["title"] for g in dropped[:6]))
    games.sort(key=lambda g: -g["hours"])

    titles_path = out / "steam_titles.json"
    started = carry_first_played(titles_path, games, today)

    payload = {
        "source": SOURCE,
        "steamId": steamid,
        "syncedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "games": games,
    }
    titles_path.write_text(json.dumps(payload, indent=1))

    played = [g for g in games if g["hours"] > 0]
    total = sum(g["hours"] for g in games)
    deck = sum(g["devices"].get("deck", 0) for g in games)
    print(f"{len(games)} games ({len(played)} played), {total:,.1f} hours total")
    if deck:
        print(f"  of which {deck:,.1f}h on Steam Deck")
    if started:
        print(f"  {started} game(s) started for the first time today")

    gained = update_snapshots(out / "snapshots.json", games, today)
    if gained is None:
        print("First Steam snapshot recorded — daily history starts from the next sync.")
    elif gained:
        for gid, hours in sorted(gained.items(), key=lambda kv: -kv[1]):
            name = next(g["title"] for g in games if g["id"] == gid)
            print(f"  +{hours:.2f}h  {name}")
    else:
        print("No new play time since the last snapshot.")


if __name__ == "__main__":
    main()
