"""Copy the discovery cache for a few states from data/raw into tests/fixtures/raw (run discover live first).

    .venv/bin/python -m raceattn discover --office senate --state TX,OH,FL,KY,AZ
    .venv/bin/python scripts/record_discover_fixture.py

The Kalshi /events walk records are reduced further: only events whose title starts with one of the fixture states'
names are kept (the live cache already keeps only Senate and Governor election events). Every other record is copied
unchanged. Nothing here holds a key: these are public, unauthenticated responses.
"""
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from raceattn.discover import STATES  # noqa: E402

SRC = os.path.join(ROOT, "data", "raw")
DST = os.path.join(ROOT, "tests", "fixtures", "raw")
FIXTURE_STATES = ["TX", "OH", "FL", "KY", "AZ"]


def main():
    names = tuple(STATES[s] + " " for s in FIXTURE_STATES)
    walk_root = os.path.join(SRC, "kalshi_discovery", "events", "all")
    for h in sorted(os.listdir(walk_root)):
        rec = json.load(open(os.path.join(walk_root, h, "walk.json")))
        before = len(rec["events"])
        rec["events"] = [e for e in rec["events"] if e["title"].startswith(names)]
        rec["fixture_note"] = ("reduced for tests to events whose title starts with %s (%d of %d kept)"
                               % (", ".join(n.strip() for n in names), len(rec["events"]), before))
        out = os.path.join(DST, "kalshi_discovery", "events", "all", h)
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, "walk.json"), "w") as f:
            json.dump(rec, f, indent=1, sort_keys=True)
            f.write("\n")
    copied = 0
    for e in os.listdir(os.path.join(SRC, "kalshi_discovery", "event")):
        if e.startswith(("SENATETX-26", "SENATEOHS-26", "SENATEFLS-26", "SENATELA-26")):
            shutil.copytree(os.path.join(SRC, "kalshi_discovery", "event", e),
                            os.path.join(DST, "kalshi_discovery", "event", e), dirs_exist_ok=True)
            copied += 1
    for st in FIXTURE_STATES:
        for key in ("%s-senate-2026" % st.lower(), "%s-senate-2026-candidates" % st.lower()):
            p = os.path.join(SRC, "wikipedia_discovery", key)
            if os.path.isdir(p):
                shutil.copytree(p, os.path.join(DST, "wikipedia_discovery", key), dirs_exist_ok=True)
                copied += 1
        p = os.path.join(SRC, "wikipedia_events", "%s-senate-2026" % st.lower())
        if os.path.isdir(p):
            shutil.copytree(p, os.path.join(DST, "wikipedia_events", "%s-senate-2026" % st.lower()), dirs_exist_ok=True)
            copied += 1
    print("fixture written under %s (%d directories copied)" % (os.path.relpath(DST, ROOT), copied))


if __name__ == "__main__":
    main()
