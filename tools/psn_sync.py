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

   The npsso cookie lasts about 60 days. Every run exchanges it for fresh
   tokens, so the short-lived access token (1 hour) and refresh token (10
   days) psnawp reports are irrelevant here — do not treat them as the
   deadline. When the npsso itself expires the sync fails, and the workflow
   raises a GitHub issue saying so.

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
import re
import sys

from filters import normalize, split_games

SOURCE = "psn"

TZ = os.environ.get("PLAYTIME_TZ", "Pacific/Auckland")


def local_today():
    """Today where the games were actually played, not on the CI runner.

    The sync runs at midnight NZ, so the UTC date is the day before for part
    of the year. Labelling snapshots with the local date keeps a day's hours
    on the day they were played.
    """
    try:
        from zoneinfo import ZoneInfo
        return dt.datetime.now(ZoneInfo(TZ)).date().isoformat()
    except Exception:  # noqa: BLE001 — no tzdata: UTC is close enough to carry on
        return dt.date.today().isoformat()



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


def _counts(earned, defined):
    """(earned, total, platinum) from either a TrophySet or a plain dict."""
    get = (lambda o, k: o[k]) if isinstance(earned, dict) else getattr
    got = sum(get(earned, k) for k in ("bronze", "silver", "gold", "platinum"))
    total = sum(get(defined, k) for k in ("bronze", "silver", "gold", "platinum"))
    return got, total, get(earned, "platinum") > 0


def trophy_key(name):
    """Looser name key, used only when a title id resolves to nothing.

    Sony names some PS5 lists "<Game> Trophies" or "<Game> Trophy Set", puts
    platform tags on others, and spaces digits inconsistently ("DIRT5").
    """
    n = normalize(name)
    n = re.sub(r"\s+(trophies|trophy set|trophy)$", "", n)
    n = re.sub(r"\s+(ps4|ps5)(\s+(and\s+)?(ps4|ps5))*$", "", n)
    return n.replace(" ", "")


def fetch_trophies(client):
    """Every trophy list on the account, keyed by its communication id.

    One paginated call. The summary is counted from the list itself, not from
    what matched a game: PS3 and Vita titles never appear in the play-time
    API, so their platinums would otherwise vanish.
    """
    lists, by_name = {}, {}
    summary = {"platinums": 0, "titles": 0}
    for t in client.trophy_titles():
        summary["titles"] += 1
        got, total, plat = _counts(t.earned_trophies, t.defined_trophies)
        if plat:
            summary["platinums"] += 1
        if not total:
            continue
        lists[t.np_communication_id] = {"earned": got, "total": total, "platinum": plat}
        key = trophy_key(t.title_name)
        if key not in by_name or got > by_name[key]["earned"]:
            by_name[key] = lists[t.np_communication_id]
    return lists, by_name, summary


def resolve_trophy_lists(client, games, previous):
    """Map each game's own title id to its trophy list(s), cached across runs.

    Matching by name missed a quarter of the library — Sony titles some lists
    "EA SPORTS FC 24 Trophies" — so the play-time title id is looked up
    directly instead. A collection resolves to several lists (the Nathan
    Drake Collection is three). Re-checked only when a game's hours change,
    so a daily run makes a handful of calls rather than one per game.
    """
    need = []
    for game in games:
        was = previous.get(game["id"]) or {}
        unchanged = abs(was.get("hours", -1) - game["hours"]) < 0.001
        if unchanged and "trophyLists" in was:
            game["trophyLists"] = was["trophyLists"]
        else:
            need.append(game)
    for i in range(0, len(need), 5):          # the endpoint takes five ids at a time
        batch = need[i:i + 5]
        found = {}
        try:
            for t in client.trophy_titles_for_title(title_ids=[g["titleId"] for g in batch]):
                found.setdefault(t.np_title_id, set()).add(t.np_communication_id)
        except Exception as exc:  # noqa: BLE001 — a failed batch just stays unresolved
            print(f"  trophy lookup failed for a batch: {exc}", file=sys.stderr)
            continue
        for game in batch:
            game["trophyLists"] = sorted(found.get(game["titleId"], []))
    return len(need)


def fetch_titles(npsso, previous, out):
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
    lists, by_name, summary = fetch_trophies(client)
    # Media apps go before the trophy lookup, or they are re-queried every
    # day: they never make it into the saved file, so nothing is cached.
    titles, dropped = split_games(titles, out)
    looked_up = resolve_trophy_lists(client, titles, previous)
    matched = 0
    for game in titles:
        sets = [lists[c] for c in game.get("trophyLists", []) if c in lists]
        if sets:
            # A collection's lists are separate games' worth of trophies; add them.
            game["trophies"] = {
                "earned": sum(x["earned"] for x in sets),
                "total": sum(x["total"] for x in sets),
                "platinum": any(x["platinum"] for x in sets),
            }
        elif trophy_key(game["title"]) in by_name:
            game["trophies"] = by_name[trophy_key(game["title"])]
        else:
            continue
        matched += 1
    summary["lookedUp"] = looked_up

    titles.sort(key=lambda g: -g["hours"])
    return client.online_id, titles, matched, summary, dropped


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
    """Sony's UTC timestamp as the calendar date where it was played.

    Taking .date() straight off a UTC datetime put any NZ session before
    midday on the previous day.
    """
    if not value:
        return None
    try:
        from zoneinfo import ZoneInfo
        return value.astimezone(ZoneInfo(TZ)).date().isoformat()
    except Exception:  # noqa: BLE001
        return value.date().isoformat()


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
        previous = {}
        prev_path = out / "psn_titles.json"
        if prev_path.exists():
            try:
                previous = {g["id"]: g for g in json.loads(prev_path.read_text()).get("games", [])}
            except json.JSONDecodeError:
                previous = {}
        online_id, titles, matched, summary, dropped = fetch_titles(npsso, previous, out)
    except Exception as exc:  # noqa: BLE001 — the cause matters more than the type
        sys.exit(
            f"PSN fetch failed: {exc}\n"
            "If this mentions auth or a token, the npsso has most likely expired "
            "(they last ~60 days). Get a fresh one and update PSN_NPSSO."
        )

    if dropped:
        print(f"skipped {len(dropped)} non-game titles: " + ", ".join(g["title"] for g in dropped[:6]))

    today = local_today()
    payload = {
        "source": SOURCE,
        "onlineId": online_id,
        "syncedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "trophySummary": summary,
        "games": titles,
    }
    (out / "psn_titles.json").write_text(json.dumps(payload, indent=1))

    total = sum(g["hours"] for g in titles)
    print(f"{online_id}: {len(titles)} titles, {total:,.1f} hours total")
    print(f"  trophies found for {matched} of {len(titles)} titles "
          f"({summary.pop('lookedUp')} looked up by title id this run); account has "
          f"{summary['platinums']} platinums across {summary['titles']} trophy sets")

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
