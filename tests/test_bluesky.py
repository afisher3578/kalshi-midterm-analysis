"""Bluesky: recorded live fixture (reduced), until walk, cursor mode, page cap, counts-only cache."""
import json
import os
import uuid

import pytest

from raceattn.cache import Cache
from raceattn.config import load_race
from raceattn.connectors.bluesky import SERIES, BlueskyConnector, search_terms, sort_time
from raceattn.http import FetchError
from tests.conftest import HERE, TEST_CONFIGS
from tests.fakes import Resp, fake_http

DAY = os.path.join(TEST_CONFIGS, "tx-bsky-1day.yaml")
with open(os.path.join(HERE, "fixtures", "bluesky", "tx-bsky-1day.json")) as f:
    RECORDED = json.load(f)


def replay(method, url, params, headers, body):
    key = json.dumps({"url": url, "params": params}, sort_keys=True)
    for r in RECORDED["responses"]:
        if r["key"] == key:
            return Resp(r["status"], r["body"])
    raise AssertionError("request not in the recorded fixture: " + key)


def test_terms_one_per_alias():
    assert search_terms(load_race("tx-senate-2026")) == ["Talarico", "Paxton"]
    assert search_terms(load_race(os.path.join(TEST_CONFIGS, "oh-dummy-2030.yaml"))) == ["Example"]


def test_recorded_unauthenticated_until_walk(tmp_path):
    race = load_race(DAY)
    http, sess = fake_http(replay)
    c = BlueskyConnector(http=http, cache=Cache(str(tmp_path)), env={}, max_pages_per_day=RECORDED["max_pages_per_day"])
    rows = c.fetch(race, race.window)
    assert len(sess.requests) == len(RECORDED["responses"]) == 8
    assert all(r["url"] == "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts" for r in sess.requests)
    assert all("cursor" not in r["params"] and r["params"]["lang"] == "en" for r in sess.requests)
    # until moves back to the oldest timestamp seen
    untils = [r["params"]["until"] for r in sess.requests if r["params"]["q"] == "Talarico"]
    assert untils[0] == "2026-10-02T00:00:00.000Z" and untils == sorted(untils, reverse=True)
    assert len(rows) == 24 and all(r.series == SERIES and r.granularity == "hour" for r in rows)
    total = sum(r.value for r in rows)
    assert 500 < total < 800  # 8 pages of 100, minus boundary repeats and cross-term duplicates
    q = c.quality(rows, race.window)[SERIES]
    assert q.status == "degraded" and "page cap hit" in q.reasons[0]  # cap of 4 pages per term
    assert q.extra["mode"] == "unauthenticated" and q.extra["capped_days"] == ["2026-10-01"]
    # cache holds counts only
    files = [os.path.join(d, f) for d, _, fs in os.walk(tmp_path) for f in fs]
    assert len(files) == 1
    text = open(files[0]).read()
    assert "at://" not in text and "h:" not in text and "did:" not in text
    rec = json.loads(text)
    assert set(rec) >= {"hourly", "pages", "capped_terms"} and sum(rec["hourly"].values()) == total
    # second run reads the cache, no requests
    c2 = BlueskyConnector(http=http, cache=Cache(str(tmp_path)), env={})
    assert [r.value for r in c2.fetch(race, race.window)] == [r.value for r in rows]
    assert len(sess.requests) == 8 and c2.cache_hits == 1


def post(uri, ts):
    return {"uri": uri, "record": {"createdAt": ts}, "indexedAt": ts}


def test_until_walk_dedupes_and_stops():
    race = load_race(DAY)
    pages = {"2026-10-02T00:00:00.000Z": [post("a", "2026-10-01T23:30:00Z"), post("b", "2026-10-01T10:00:00Z")],
             "2026-10-01T10:00:00.000Z": [post("b", "2026-10-01T10:00:00Z"), post("c", "2026-10-01T03:00:00Z")],
             "2026-10-01T03:00:00.000Z": [post("c", "2026-10-01T03:00:00Z")]}

    def route(m, url, params, h, b):
        if params["q"] != "Talarico":
            return Resp(200, {"posts": [post("a", "2026-10-01T23:30:00Z")]})  # cross-term duplicate
        return Resp(200, {"posts": pages[params["until"]], "hitsTotal": 3})

    http, sess = fake_http(route)
    c = BlueskyConnector(http=http, env={})
    rows = c.fetch(race, race.window)
    by = {r.ts_utc.hour: r.value for r in rows}
    assert by[23] == 1 and by[10] == 1 and by[3] == 1 and sum(by.values()) == 3
    assert c.quality(rows, race.window)[SERIES].status == "ok"


def test_authenticated_mode_cursor_and_token_in_memory(tmp_path):
    race = load_race(DAY)
    pw, jwt = "pw-" + uuid.uuid4().hex, "jwt-" + uuid.uuid4().hex
    seen = []

    def route(m, url, params, headers, body):
        seen.append((m, url, dict(params), dict(headers), body))
        if url.endswith("createSession"):
            return Resp(200, {"accessJwt": jwt, "refreshJwt": "r-" + uuid.uuid4().hex, "handle": "someone.example"})
        assert headers["Authorization"] == "Bearer " + jwt
        if params.get("cursor") == "c2":
            return Resp(403, None, text="forbidden")  # cursor refused: drop to the until walk
        if "cursor" not in params and params["until"] == "2026-10-02T00:00:00.000Z":
            return Resp(200, {"posts": [post("x%d" % params["q"].__len__(), "2026-10-01T12:00:00Z")], "cursor": "c2"})
        return Resp(200, {"posts": []})

    http, _ = fake_http(route)
    c = BlueskyConnector(http=http, cache=Cache(str(tmp_path)),
                         env={"BSKY_HANDLE": "someone.example", "BSKY_APP_PASSWORD": pw})
    rows = c.fetch(race, race.window)
    assert seen[0][1] == "https://bsky.social/xrpc/com.atproto.server.createSession"
    assert seen[1][1] == "https://bsky.social/xrpc/app.bsky.feed.searchPosts"
    assert sum(r.value for r in rows) == 2
    q = c.quality(rows, race.window)[SERIES]
    assert q.extra["mode"] == "authenticated" and any("switched to the until walk" in n for n in q.extra["notes"])
    blob = "".join(open(os.path.join(d, f)).read() for d, _, fs in os.walk(tmp_path) for f in fs)
    assert jwt not in blob and pw not in blob and "someone.example" not in blob


def test_403_without_cursor_stops():
    race = load_race(DAY)
    http, _ = fake_http(lambda *a: Resp(403, None, text="<html>403 Forbidden</html>"))
    with pytest.raises(FetchError, match="403"):
        BlueskyConnector(http=http, env={}).fetch(race, race.window)


def test_total_page_budget_leaves_days_missing_not_zero():
    race = load_race("tx-senate-2026")
    http, sess = fake_http(lambda *a: Resp(200, {"posts": []}))
    c = BlueskyConnector(http=http, env={}, max_pages=4)
    rows = c.fetch(race, race.window)
    assert len(sess.requests) == 4 and len(rows) == 48  # two days fetched, the rest missing
    q = c.quality(rows, race.window)[SERIES]
    assert q.status == "unusable" and len(q.extra["capped_days"]) == 63


def test_sort_time_uses_earlier_of_created_and_indexed():
    p = {"record": {"createdAt": "2030-01-01T00:00:00Z"}, "indexedAt": "2026-10-01T05:00:00.123Z"}
    assert sort_time(p).isoformat() == "2026-10-01T05:00:00.123000+00:00"


@pytest.mark.live
def test_live_bluesky_unauthenticated(tmp_path):
    race = load_race(DAY)
    c = BlueskyConnector(cache=Cache(str(tmp_path)), env={}, max_pages_per_day=2)
    rows = c.fetch(race, race.window)
    assert len(rows) == 24 and sum(r.value for r in rows) > 0
