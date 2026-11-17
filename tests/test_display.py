"""Display window (series.display_daily): config default and validation, the cache plan, the block shape, cache
reuse and that the analysis output does not change. Offline only.

Every response for dates outside the recorded fixtures (Aug 5 to 31, and all Florida and Media Cloud data) is
SYNTHETIC, built in this file; none of it is real Kalshi, Wikipedia or Media Cloud data.
"""
import copy
import datetime as dt
import json
import os
import shutil
import urllib.parse

import pytest
import yaml

from raceattn import display
from raceattn.cache import Cache
from raceattn.config import ConfigError, Window, load_race, validate
from raceattn.connectors.news import MediaCloudConnector
from raceattn.pipeline import run
from tests.conftest import FIXTURE_RAW, ROOT
from tests.fakes import Resp, fake_http, is_r_candles, kalshi_event_body

TX = os.path.join(ROOT, "config", "races", "tx-senate-2026.yaml")
QDIR = os.path.join(ROOT, "config", "queries")
KEY = "fake-mc-key-not-real-0002"
D = dt.date
NO_CANDLES = D(2026, 8, 7)          # synthetic Kalshi gap: no candles that day
WIKI_GAP = (D(2026, 8, 10), "James_Talarico")  # synthetic Wikipedia gap: one page missing that day
MC_MISSING, MC_ZERO = D(2026, 8, 27), D(2026, 8, 26)


def tx_data():
    with open(TX) as f:
        return yaml.safe_load(f)


# -- config

def test_six_configs_set_display_window():
    for rid in ("tx-senate-2026", "tx-governor-2026", "fl-senate-2026", "ky-senate-2026", "nc-senate-2026",
                "oh-senate-2026"):
        r = load_race(rid)
        assert r.display_window_set and r.display_window == Window(D(2026, 8, 5), D(2026, 11, 4)), rid
        assert r.display_window.n_days == 92
        assert r.window == Window(D(2026, 9, 1), D(2026, 11, 4)) and r.exclude_days == (D(2026, 11, 3), D(2026, 11, 4))


def test_default_display_window_from_election_date():
    d = tx_data()
    del d["display_window"]
    r = validate(d)
    assert not r.display_window_set
    assert r.display_window == Window(D(2026, 8, 5), D(2026, 11, 4))  # E - 90 days to E + 1 day
    assert r.summary()["display_window"]["source"].startswith("default")
    d["election_date"] = D(2026, 11, 10)
    assert validate(d).display_window == Window(D(2026, 8, 12), D(2026, 11, 11))


@pytest.mark.parametrize("dw, msg", [
    ({"start": D(2026, 9, 2), "end": D(2026, 11, 4)}, "must contain the analysis window"),
    ({"start": D(2026, 8, 5), "end": D(2026, 11, 3)}, "must contain the analysis window"),
    ({"start": D(2026, 11, 5), "end": D(2026, 8, 5)}, "is after end"),
    ({"start": D(2026, 8, 5)}, "expected {start"),
    ("2026-08-05", "expected {start"),
    ({"start": "nope", "end": D(2026, 11, 4)}, "expected a date"),
])
def test_display_window_validation(dw, msg):
    d = tx_data()
    d["display_window"] = dw
    with pytest.raises(ConfigError, match=msg):
        validate(d)


def test_default_that_misses_the_window_is_an_error():
    d = tx_data()
    del d["display_window"]
    d["window"] = {"start": D(2026, 7, 1), "end": D(2026, 11, 4)}
    with pytest.raises(ConfigError, match="default from election_date"):
        validate(d)


# -- plan

def days(a, b):
    return Window(a, b).days()


def test_plan_reuses_cached_windows_and_requests_only_the_rest():
    gap = days(D(2026, 8, 5), D(2026, 8, 31))
    p = display.plan(gap, [Window(D(2026, 8, 1), D(2026, 8, 24)), Window(D(2026, 9, 1), D(2026, 11, 4))])
    assert [(w.label, t[0], t[-1], c) for w, t, c in p] == [
        ("20260801_20260824", D(2026, 8, 5), D(2026, 8, 24), True),
        ("20260825_20260831", D(2026, 8, 25), D(2026, 8, 31), False)]
    assert [(w.label, c) for w, _, c in display.plan(gap, [])] == [("20260805_20260831", False)]
    full = display.plan(gap, [Window(D(2026, 8, 1), D(2026, 8, 24)), Window(D(2026, 8, 25), D(2026, 8, 31))])
    assert all(c for _, _, c in full) and sum(len(t) for _, t, _ in full) == 27
    # a cached window in the middle splits the new requests in two
    mid = display.plan(gap, [Window(D(2026, 8, 10), D(2026, 8, 12))])
    assert [(w.label, c) for w, _, c in mid] == [("20260805_20260809", False), ("20260810_20260812", True),
                                               ("20260813_20260831", False)]


# -- synthetic routes for dates outside the recorded fixtures

def kalshi_body(params):
    out, t = [], params["start_ts"]
    while t < params["end_ts"]:
        t += 3600
        end = dt.datetime.fromtimestamp(t, dt.timezone.utc)
        if end.date() == NO_CANDLES:
            continue
        out.append({"end_period_ts": t, "price": {"close_dollars": "%.2f" % (0.30 + (t // 86400) % 7 / 100)},
                    "volume_fp": str(t % 13)})
    return {"candlesticks": out}


def wiki_body(url):
    parts = url.split("/")
    page, a, b = urllib.parse.unquote(parts[-4]), parts[-2], parts[-1]
    cur, end, items = dt.datetime.strptime(a, "%Y%m%d").date(), dt.datetime.strptime(b, "%Y%m%d").date(), []
    while cur <= end:
        if (cur, page) != WIKI_GAP:
            items.append({"timestamp": cur.strftime("%Y%m%d00"), "views": 100 + cur.day})
        cur += dt.timedelta(days=1)
    return {"items": items}


def mc_body(params):
    cur, end, counts = D.fromisoformat(params["start"]), D.fromisoformat(params["end"]), []
    while cur <= end:
        if cur != MC_MISSING:
            counts.append({"date": cur.isoformat() + " 00:00:00", "count": 0 if cur == MC_ZERO else cur.day,
                           "ratio": 0.001, "total_count": 1000})
        cur += dt.timedelta(days=1)
    return {"count_over_time": {"counts": counts}}


def route(method, url, params, headers, body):
    if "kalshi" in url and "/events/" in url:
        return Resp(200, kalshi_event_body(url))
    if "kalshi" in url:
        return Resp(200, kalshi_body(params))
    if "wikimedia" in url:
        return Resp(200, wiki_body(url))
    if "mediacloud" in url:
        return Resp(200, mc_body(params))
    return Resp(404, {"error": "unexpected"})


def no_requests(method, url, params, headers, body):
    raise AssertionError("request made for a cached read: %s %s" % (url, params))


def block_rows(res):
    return {r["date"]: r for r in res["series"]["display_daily"]["rows"]}


# -- Texas from the recorded fixtures plus a synthetic Aug 5 to 31 segment

@pytest.fixture
def tx_runs(tmp_path):
    raw = tmp_path / "raw"
    shutil.copytree(FIXTURE_RAW, raw)
    race = load_race("tx-senate-2026")
    kw = dict(raw_dir=str(raw), log=lambda *_: None, write=False)
    plain = run(race, ["kalshi", "wikipedia"], display=False, **kw)
    http, sess = fake_http(route)
    shown = run(race, ["kalshi", "wikipedia"], http=http, **kw)  # display defaults to on: the config sets it
    return plain, shown, sess, raw, race, kw


def test_display_block_shape_and_nulls(tx_runs):
    _, res, sess, _, _, _ = tx_runs
    b = res["series"]["display_daily"]
    assert b["window"]["start"] == "2026-08-05" and b["window"]["end"] == "2026-11-04" and b["window"]["days"] == 92
    assert b["columns"] == ["date", "kalshi_price_close", "kalshi_volume", "wikipedia_pageviews_total",
                            "kalshi_r_price_close", "kalshi_r_volume"]  # the opposing contract last
    assert len(b["rows"]) == 92 and b["rows"][0]["date"] == "2026-08-05" and b["rows"][-1]["date"] == "2026-11-04"
    assert [r["date"] for r in b["rows"]] == [d.isoformat() for d in days(D(2026, 8, 5), D(2026, 11, 4))]
    assert b["news"] == "not run"
    rows = block_rows(res)
    # nulls stay null: no interpolation, no zero fill
    assert rows["2026-08-07"]["kalshi_price_close"] is None and rows["2026-08-07"]["kalshi_volume"] is None
    assert rows["2026-08-10"]["wikipedia_pageviews_total"] is None
    assert rows["2026-08-11"]["wikipedia_pageviews_total"] == 3 * (100 + 11)
    assert rows["2026-08-08"]["kalshi_price_close"] is not None
    cov = b["coverage"]
    assert cov["kalshi_price_close"] == {"days_present": 91, "days_total": 92, "missing_days": ["2026-08-07"]}
    assert cov["kalshi_volume"]["missing_days"] == ["2026-08-07"]
    assert cov["wikipedia_pageviews_total"] == {"days_present": 91, "days_total": 92, "missing_days": ["2026-08-10"]}
    # one new segment per source for Aug 5 to 31; Sept 1 on comes from the analysis run
    new = [s for s in b["segments"] if s["from"] == "new segment"]
    assert {(s["source"], s["request_window"]["start"], s["request_window"]["end"]) for s in new} == {
        ("kalshi", "2026-08-05", "2026-08-31"), ("wikipedia", "2026-08-05", "2026-08-31")}
    reqs = [r for r in sess.requests if not is_r_candles(r["url"])]  # the opposing contract has its own count
    assert b["requests_made"] == len(reqs) == 2 + 3  # two 20-day Kalshi chunks, three pages
    for r in reqs:
        if "kalshi" in r["url"]:
            assert r["params"]["end_ts"] <= int(dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc).timestamp())
        else:
            assert r["url"].endswith("/daily/20260805/20260831")
    assert any("display_daily" in n for n in res["notes"])
    assert res["race"]["display_window"]["start"] == "2026-08-05"


def test_display_matches_daily_inside_the_analysis_window(tx_runs):
    _, res, _, _, _, _ = tx_runs
    t = res["series"]["daily"]
    cols = t["columns"]
    rows = block_rows(res)
    for r in t["rows"]:
        d = dict(zip(cols, r))
        shown = rows[d["date"]]
        assert shown["kalshi_price_close"] == d["kalshi/price_close"]
        assert shown["kalshi_volume"] == d["kalshi/volume"]
        assert shown["wikipedia_pageviews_total"] == d["wikipedia/pageviews_total"]


def test_display_window_leaves_the_analysis_output_unchanged(tx_runs):
    plain, shown, _, _, _, _ = tx_runs
    assert "display_daily" not in plain["series"]
    for k in ("daily", "hourly", "hourly_grid", "meta"):
        assert shown["series"][k] == plain["series"][k], k
    for k in ("metrics", "quality", "window", "excluded_days", "queries", "sources"):
        assert shown[k] == plain[k], k
    cell = shown["metrics"]["daily"]["wikipedia/pageviews_total"]["outcomes"]["volume_surprise"]["1"]
    assert cell["rho"] == pytest.approx(0.2786, abs=1e-4) and cell["n"] == 55  # golden number


def test_second_run_reads_the_new_segment_from_cache(tx_runs):
    _, first, _, _, race, kw = tx_runs
    http, sess = fake_http(no_requests)
    again = run(race, ["kalshi", "wikipedia"], http=http, **kw)
    assert sess.requests == []
    b = again["series"]["display_daily"]
    assert b["requests_made"] == 0
    assert b["rows"] == first["series"]["display_daily"]["rows"]
    assert {s["from"] for s in b["segments"]} == {"analysis run (series.daily values)", "cached window"}


def test_no_display_flag_skips_the_block(tx_runs):
    plain, _, _, _, _, _ = tx_runs
    assert "display_daily" not in plain["series"]
    assert not any("display_daily" in n for n in plain["notes"])


# -- a race without Media Cloud queries

def test_non_texas_race_has_no_news_columns(tmp_path):
    http, sess = fake_http(route)
    res = run(load_race("fl-senate-2026"), ["kalshi", "wikipedia"], raw_dir=str(tmp_path), http=http,
              log=lambda *_: None, write=False)
    b = res["series"]["display_daily"]
    assert b["news"] == "not run"
    assert b["columns"] == ["date", "kalshi_price_close", "kalshi_volume", "wikipedia_pageviews_total",
                            "kalshi_r_price_close", "kalshi_r_volume"]
    assert not any(c.startswith("news") for c in b["coverage"])
    assert len(b["rows"]) == 92 and all(set(r) == set(b["columns"]) for r in b["rows"])
    # analysis: 4 Kalshi chunks, 3 pages; Aug 5 to 31: 2 chunks, 3 pages; opposing: the event body, 5 R chunks
    assert len([r for r in sess.requests if not is_r_candles(r["url"])]) == (4 + 3) + (2 + 3) + 1
    assert len([r for r in sess.requests if is_r_candles(r["url"])]) == 5


# -- Media Cloud: slice the tuning cache, request only Aug 25 to 31, paced

def seed_tuning_cache(conn, race, w):
    """Synthetic cache records at the paths the connector reads for window w (like the Aug 1 to 24 tuning pull)."""
    cfg = conn.query_config(race)
    for (_, _, q), path in zip(conn._requests(cfg, w), conn.cache_paths(race, w)):
        conn.cache.put(path, {"request": {"endpoint": q.endpoint, "params": dict(q.params)}, "query_hash": q.query_hash,
                              "status": 200, "fetched_at": "2026-11-12T00:00:00Z", "body": mc_body(q.params)})


def mc_conn(tmp_path, route_):
    http, sess = fake_http(route_)
    conn = MediaCloudConnector(http=http, cache=Cache(str(tmp_path / "raw")), env={"MEDIACLOUD_API_KEY": KEY},
                               queries_dir=QDIR)
    conn.log = lambda *_: None
    return conn, sess


def test_mediacloud_display_uses_the_tuning_cache(tmp_path, no_pacing_sleep):
    race = load_race("tx-senate-2026")
    conn, sess = mc_conn(tmp_path, route)
    seed_tuning_cache(conn, race, Window(D(2026, 8, 1), D(2026, 8, 24)))
    analysis_cols = {"news_mediacloud/talarico_race/national": [7.0] * race.window.n_days}
    b = display.build(race, [conn], race.window.days(), analysis_cols, log=lambda *_: None)
    assert len(sess.requests) == 16 == b["requests_made"]  # 8 queries x 2 collections, Aug 25 to 31 only
    assert {(r["params"]["start"], r["params"]["end"]) for r in sess.requests} == {("2026-08-25", "2026-08-31")}
    assert {r["params"]["cs"] for r in sess.requests} == {"34412234", "38381323"}
    assert all(r["headers"]["Authorization"] == "Token " + KEY for r in sess.requests)
    assert len(no_pacing_sleep) == 15 and all(0 < w <= 30 for w in no_pacing_sleep)  # 30 s apart
    cols = b["columns"][1:]
    assert len(cols) == 16 and b["news"] == cols and "news/talarico_race/national" in cols
    assert "news/any_either/texas_local" in cols
    rows = {r["date"]: r for r in b["rows"]}
    assert rows["2026-08-05"]["news/talarico_race/national"] == 5.0   # from the Aug 1 to 24 cache
    assert rows["2026-08-26"]["news/talarico_race/national"] == 0.0   # an explicit 0 stays 0
    assert rows["2026-08-27"]["news/talarico_race/national"] is None  # a date the API left out stays null
    assert rows["2026-09-01"]["news/talarico_race/national"] == 7.0   # analysis run value
    assert rows["2026-09-01"]["news/paxton_race/national"] is None    # no analysis value given: null, not 0
    cov = b["coverage"]["news/talarico_race/national"]
    assert cov == {"days_present": 91, "days_total": 92, "missing_days": ["2026-08-27"]}
    segs = [(s.get("request_window", {}).get("start"), s["from"]) for s in b["segments"]]
    assert segs == [(None, "analysis run (series.daily values)"), ("2026-08-01", "cached window"),
                    ("2026-08-25", "new segment")]
    assert KEY not in json.dumps(b)
    for p in conn.cache_paths(race, Window(D(2026, 8, 25), D(2026, 8, 31))):
        assert KEY not in open(p).read()
    # the second build reads Aug 25 to 31 from the cache too: no request
    conn2, sess2 = mc_conn(tmp_path, no_requests)
    b2 = display.build(race, [conn2], race.window.days(), analysis_cols, log=lambda *_: None)
    assert sess2.requests == [] and b2["requests_made"] == 0 and b2["rows"] == b["rows"]


@pytest.mark.parametrize("status", [401, 403, 429])
def test_mediacloud_display_stops_on_auth_or_rate_limit(tmp_path, status):
    from raceattn.http import FetchError

    race = load_race("tx-senate-2026")
    conn, sess = mc_conn(tmp_path, lambda *a: Resp(status, {"detail": "no " + KEY}))
    with pytest.raises(FetchError) as e:
        display.build(race, [conn], race.window.days(), {}, log=lambda *_: None)
    assert len(sess.requests) == 1  # stopped at the first refusal, no retry, no further query
    assert KEY not in str(e.value)
