#!/usr/bin/env python3
"""
One-off backfill of Slay the Spire 2 sessions from the STS2 run tracker.

Steam reports play time but never a session count or a first-played date.
The run tracker (a separate project on this Mac) archives every finished run
with its start time and duration, which is enough to reconstruct both:

  sessions      one per archived run — each run is counted as a session
  firstPlayed   the date of the earliest run
  through       the date of the latest run; after it, the app adds one
                session per day the daily snapshots see the game played

Hours are deliberately not taken from here: the run timer adds up to more
than Steam's figure (148.8h against 124.3h on 2026-09-11), so Steam's number
stays authoritative.

Only runnable on the Mac that holds the run archive — the GitHub Action
cannot see it, which is why this is a one-off rather than part of the sync.

    python3 tools/backfill_sts2.py
"""

import datetime as dt
import glob
import json
import pathlib

ARCHIVE = pathlib.Path.home() / "Library/Application Support/sts2-run-tracker/data/runs"
ENTRY_ID = "steam_2868840"          # Slay the Spire 2 in steam_titles.json
TZ = "Pacific/Auckland"


def local_date(ts):
    from zoneinfo import ZoneInfo
    return dt.datetime.fromtimestamp(ts, ZoneInfo(TZ)).date().isoformat()


def main():
    runs = []
    for path in glob.glob(str(ARCHIVE / "*" / "*" / "*.run")):
        if ".conflict-" in path:      # the archiver's duplicates, not extra runs
            continue
        run = json.loads(pathlib.Path(path).read_text())
        if run.get("start_time"):
            runs.append((run["start_time"], run.get("run_time", 0)))
    if not runs:
        raise SystemExit(f"No runs found under {ARCHIVE}")
    runs.sort()

    sessions = len(runs)

    days = sorted({local_date(start) for start, _ in runs})
    record = {
        "title": "Slay the Spire 2",
        "source": "sts2-run-tracker",
        "sessions": sessions,
        "firstPlayed": days[0],
        "through": days[-1],
        "runs": len(runs),
        "playDays": days,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }

    out = pathlib.Path(__file__).resolve().parent.parent / "data" / "backfill.json"
    existing = json.loads(out.read_text()) if out.exists() else {}
    existing[ENTRY_ID] = record
    out.write_text(json.dumps(existing, indent=1))

    print(f"{len(runs)} runs -> {sessions} sessions, "
          f"{days[0]} to {days[-1]} across {len(days)} days")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
