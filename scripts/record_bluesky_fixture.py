#!/usr/bin/env python3
"""Record a small live Bluesky fixture for the offline tests (unauthenticated, no key needed).

Runs the Bluesky connector against the live API for tests/configs/tx-bsky-1day.yaml with a low page cap and
saves every request and a REDUCED response: each post keeps only a sha256 of its uri (for dedupe),
record.createdAt and indexedAt. No text, handles or dids are written.

  .venv/bin/python scripts/record_bluesky_fixture.py
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from raceattn.config import load_race  # noqa: E402
from raceattn.connectors.bluesky import BlueskyConnector  # noqa: E402
from raceattn.http import HttpClient  # noqa: E402

OUT = os.path.join(ROOT, "tests", "fixtures", "bluesky", "tx-bsky-1day.json")
MAX_PAGES_PER_DAY = 4


def request_key(url: str, params: dict) -> str:
    return json.dumps({"url": url, "params": params}, sort_keys=True)


def reduce_body(body: dict) -> dict:
    posts = [{"uri": "h:" + hashlib.sha256(p["uri"].encode()).hexdigest()[:20],
              "record": {"createdAt": (p.get("record") or {}).get("createdAt")}, "indexedAt": p.get("indexedAt")}
             for p in body.get("posts") or []]
    out = {"posts": posts}
    for k in ("cursor", "hitsTotal"):
        if k in body:
            out[k] = body[k]
    return out


class Recorder(HttpClient):
    def __init__(self):
        super().__init__()
        self.log = []

    def get_json(self, url, params=None, ok_status=(200,), headers=None, secret_params=None):
        status, body = super().get_json(url, params, ok_status=ok_status)
        self.log.append({"key": request_key(url, dict(params or {})), "status": status,
                         "body": reduce_body(body) if status == 200 else body})
        return status, body


def main() -> int:
    race = load_race(os.path.join(ROOT, "tests", "configs", "tx-bsky-1day.yaml"))
    http = Recorder()
    c = BlueskyConnector(http=http, env={}, max_pages_per_day=MAX_PAGES_PER_DAY)
    c.fetch(race, race.window)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"recorded_from": "https://api.bsky.app (unauthenticated)", "max_pages_per_day": MAX_PAGES_PER_DAY,
                   "reduced": "posts keep only sha256(uri)[:20], record.createdAt and indexedAt",
                   "responses": http.log}, f, indent=0, sort_keys=True)
        f.write("\n")
    print("wrote %s: %d responses, stats %s" % (os.path.relpath(OUT, ROOT), len(http.log), c.stats))
    return 0


if __name__ == "__main__":
    sys.exit(main())
