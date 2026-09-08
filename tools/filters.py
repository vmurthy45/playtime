"""Shared title filtering for the collectors.

Consoles count Netflix, YouTube and friends as titles with play time, which
makes them show up as if they were games. The exclusion list lives in
data/non_games.json so it can be edited without touching code, and the app
applies the same list to anything already collected.
"""

import json
import re

DEFAULT = {
    "names": [
        # streaming and media
        "netflix", "youtube", "youtube vr", "disney", "disney plus", "plex",
        "spotify", "twitch", "prime video", "amazon prime video", "apple tv",
        "crunchyroll", "hulu", "neon", "tvnz", "threenow", "three now",
        "sky go", "sky sport now", "bbc iplayer", "dazn", "funimation",
        "deezer", "tidal", "wwe network", "playstation video", "playstation music",
        # system apps
        "media player", "web browser", "internet browser", "playstation store",
        # steam software that is not a game
        "wallpaper engine", "steamvr", "steam linux runtime", "proton experimental",
    ],
    "ids": [],
}


def normalize(title):
    """Same normalisation the app uses, so both sides agree on a match."""
    t = title.lower()
    for ch in "™®©":
        t = t.replace(ch, "")
    t = re.sub(r"[‘’']", "", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    t = re.sub(r"^the ", "", t)
    return t.strip()


def load_exclusions(data_dir):
    """Read data/non_games.json, falling back to the built-in list."""
    path = data_dir / "non_games.json"
    if not path.exists():
        path.write_text(json.dumps({"_comment": DOC, **DEFAULT}, indent=1))
        return set(DEFAULT["names"]), set(DEFAULT["ids"])
    try:
        cfg = json.loads(path.read_text())
    except json.JSONDecodeError:
        return set(DEFAULT["names"]), set(DEFAULT["ids"])
    return set(cfg.get("names", [])), set(cfg.get("ids", []))


def split_games(games, data_dir):
    """Return (games, dropped) — dropped are the media apps and tools."""
    names, ids = load_exclusions(data_dir)
    keep, drop = [], []
    for g in games:
        (drop if normalize(g["title"]) in names or g["id"] in ids else keep).append(g)
    return keep, drop


DOC = (
    "Titles hidden from Playtime: media apps, system apps, and software that "
    "is not a game. Matched on the normalised title — lowercase, punctuation "
    "stripped, leading 'the' removed. Use 'ids' for one-offs a name cannot "
    "catch (e.g. 'steam_431960')."
)
