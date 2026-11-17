"""series.display_hourly and series.granularity: the hourly grid, forward fill, the analysis rows winning on
overlap, cache reuse, the reconciliation against series.display_daily, and the committed processed files.
Offline only.

The Kalshi candles and the analysis rows in the build tests are SYNTHETIC, built in this file; none of it is real
Kalshi data. The last section reads the committed data/processed files (skipped when they are absent).
"""
import datetime as dt
import json
import os
import shutil

import pytest

from raceattn import display
from raceattn.cache import Cache
from raceattn.config import Window, load_race
from raceattn.connectors.kalshi import KalshiConnector
from raceattn.metrics.surprise import daily_kalshi
from raceattn.pipeline import run
from tests.conftest import FIXTURE_RAW, ROOT
from tests.fakes import Resp, fake_http, is_r_candles

D = dt.date
UTC = dt.timezone.utc
PROCESSED = os.path.join(ROOT, "data", "processed")
RACES = ("fl-senate-2026", "ky-senate-2026", "nc-senate-2026", "oh-senate-2026", "tx-governor-2026", "tx-senate-2026")
NO_CANDLE = {dt.datetime(2026, 8, 10, 5, tzinfo=UTC), dt.datetime(2026, 8, 10, 6, tzinfo=UTC)}  # synthetic gap
ANALYSIS_GAP = "2026-09-02T10:00:00Z"  # synthetic gap in the analysis rows


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def ts(s):
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def kalshi_route(method, url, params, headers, body):
    """Synthetic candles ending every hour from start_ts to end_ts (the API also returns the one ending at
    start_ts), with no candle at the NO_CANDLE hours."""
    if "kalshi" not in url:
        return Resp(404, {"error": "unexpected"})
    out = []
    for t in range(params["start_ts"], params["end_ts"] + 1, 3600):
        end = dt.datetime.fromtimestamp(t, UTC)
        if end in NO_CANDLE:
            continue
        out.append({"end_period_ts": t, "price": {"close_dollars": "%.2f" % (0.20 + end.hour / 100)},
                    "volume_fp": str(t % 17)})
    return Resp(200, {"candlesticks": out})


def no_requests(method, url, params, headers, body):
    raise AssertionError("request made for a cached read: %s %s" % (url, params))


def analysis_rows():
    """Synthetic series.hourly rows: 2026-09-01T00:00Z to 2026-09-03T00:00Z, one hour missing."""
    out, t = [], dt.datetime(2026, 9, 1, tzinfo=UTC)
    while t <= dt.datetime(2026, 9, 3, tzinfo=UTC):
        if iso(t) != ANALYSIS_GAP:
            out.append([iso(t), 0.9, 1000.0])
        t += dt.timedelta(hours=1)
    return out


def kconn(raw, route):
    http, sess = fake_http(route)
    c = KalshiConnector(http=http, cache=Cache(str(raw)))
    c.log = lambda *_: None
    return c, sess


@pytest.fixture
def built(tmp_path):
    """Aug 5 to 20 already cached (a pull of its own); build_hourly must request only Aug 21 to 31."""
    race = load_race("tx-senate-2026")
    seed, _ = kconn(tmp_path, kalshi_route)
    seed.fetch(race, Window(D(2026, 8, 5), D(2026, 8, 20)))
    conn, sess = kconn(tmp_path, kalshi_route)
    b = display.build_hourly(race, conn, analysis_rows(), log=lambda *_: None)
    return race, b, sess, tmp_path


def test_full_grid_from_display_start(built):
    _, b, _, _ = built
    assert b["columns"] == ["ts_utc", "kalshi/price_close", "kalshi/volume"]
    assert b["first_ts"] == b["rows"][0][0] == "2026-08-05T00:00:00Z"
    assert b["last_ts"] == b["rows"][-1][0] == "2026-09-03T00:00:00Z"  # the last candle; nothing invented after it
    t = [ts(r[0]) for r in b["rows"]]
    assert all(b_ - a == dt.timedelta(hours=1) for a, b_ in zip(t, t[1:]))
    assert b["n_rows"] == len(b["rows"]) == 29 * 24 + 1
    assert b["window"] == {"start": "2026-08-05", "end": "2026-11-04", "days": 92, "inclusive": True,
                           "timezone": "UTC", "source": "race config"}
    assert b["null_price_hours"]["n"] == 0
    assert "never hourly" in b["note"] and "end_period_ts" in b["note"]


def test_gap_hours_forward_filled_with_zero_volume(built):
    _, b, _, _ = built
    rows = {r[0]: r for r in b["rows"]}
    assert b["filled_hours"]["n"] == 3
    assert b["filled_hours"]["hours"] == ["2026-08-10T05:00:00Z", "2026-08-10T06:00:00Z", ANALYSIS_GAP]
    prev = rows["2026-08-10T04:00:00Z"][1]
    assert prev == pytest.approx(0.24)
    assert rows["2026-08-10T05:00:00Z"][1:] == [prev, 0.0]
    assert rows["2026-08-10T06:00:00Z"][1:] == [prev, 0.0]
    assert rows["2026-08-10T07:00:00Z"][1] == pytest.approx(0.27)
    assert rows[ANALYSIS_GAP][1:] == [0.9, 0.0]


def test_analysis_rows_win_on_overlap(built):
    _, b, _, _ = built
    rows = {r[0]: r for r in b["rows"]}
    # the Aug 21 to 31 pull also returns the candle ending 2026-09-01T00:00Z, with a different value
    assert rows["2026-09-01T00:00:00Z"][1:] == [0.9, 1000.0]
    assert b["overlap_dropped"]["n"] == 1
    for r in analysis_rows():
        assert rows[r[0]] == r
    assert rows["2026-08-31T23:00:00Z"][1] == pytest.approx(0.43)  # segment value outside the analysis window


def test_only_uncached_dates_requested(built):
    race, b, sess, raw = built
    assert b["requests_made"] == len(sess.requests) == 1  # Aug 21 to 31 is one chunk of <= 20 days
    p = sess.requests[0]["params"]
    assert p["start_ts"] == int(dt.datetime(2026, 8, 21, tzinfo=UTC).timestamp())
    assert p["end_ts"] == int(dt.datetime(2026, 9, 1, tzinfo=UTC).timestamp())
    segs = [(s["from"], s.get("request_window", {}).get("start"), s.get("requests")) for s in b["segments"]]
    assert segs == [("analysis run (series.hourly values)", None, None), ("cached window", "2026-08-05", 0),
                    ("new segment", "2026-08-21", 1)]
    # a second build reads everything from the cache
    conn2, sess2 = kconn(raw, no_requests)
    b2 = display.build_hourly(race, conn2, analysis_rows(), log=lambda *_: None)
    assert sess2.requests == [] and b2["requests_made"] == 0 and b2["rows"] == b["rows"]


@pytest.mark.parametrize("status", [401, 403, 429])
def test_stops_on_auth_or_rate_limit(tmp_path, status):
    from raceattn.http import FetchError

    conn, sess = kconn(tmp_path, lambda *a: Resp(status, {"error": "no"}))
    with pytest.raises(FetchError):
        display.build_hourly(load_race("tx-senate-2026"), conn, analysis_rows(), log=lambda *_: None)
    assert len(sess.requests) == 1


def test_first_hour_without_a_price_stays_null(tmp_path):
    race = load_race("tx-senate-2026")
    rows = [["2026-08-05T03:00:00Z", 0.5, 2.0]]
    conn, _ = kconn(tmp_path, lambda *a: Resp(200, {"candlesticks": []}))
    b = display.build_hourly(race, conn, rows, log=lambda *_: None)
    assert [r[0] for r in b["rows"]][:4] == ["2026-08-05T0%d:00:00Z" % h for h in range(4)]
    assert [r[1:] for r in b["rows"][:3]] == [[None, 0.0]] * 3
    assert b["null_price_hours"]["hours"] == ["2026-08-05T0%d:00:00Z" % h for h in range(3)]


def test_null_price_candle_forward_filled_volume_kept(tmp_path):
    """An analysis row with a null price (its pull had no earlier close) takes the previous grid hour's price and
    keeps its own volume; the input rows are not changed."""
    race = load_race("tx-senate-2026")
    seed, _ = kconn(tmp_path, kalshi_route)
    seed.fetch(race, Window(D(2026, 8, 5), D(2026, 8, 31)))
    rows = [["2026-09-01T00:00:00Z", None, 7.0], ["2026-09-01T01:00:00Z", None, 0.0],
            ["2026-09-01T02:00:00Z", 0.6, 3.0]]
    before = [list(r) for r in rows]
    conn, sess = kconn(tmp_path, no_requests)
    b = display.build_hourly(race, conn, rows, log=lambda *_: None)
    out = {r[0]: r for r in b["rows"]}
    prev = out["2026-08-31T23:00:00Z"][1]
    assert prev == pytest.approx(0.43)
    assert out["2026-09-01T00:00:00Z"] == ["2026-09-01T00:00:00Z", prev, 7.0]
    assert out["2026-09-01T01:00:00Z"] == ["2026-09-01T01:00:00Z", prev, 0.0]
    assert out["2026-09-01T02:00:00Z"] == ["2026-09-01T02:00:00Z", 0.6, 3.0]
    assert b["forward_filled_null_price"]["hours"] == ["2026-09-01T00:00:00Z", "2026-09-01T01:00:00Z"]
    assert "2026-09-01T00:00:00Z" not in b["filled_hours"]["hours"]
    assert b["null_price_hours"]["n"] == 0
    assert rows == before and sess.requests == []


def test_null_price_candle_without_earlier_close_stays_null(tmp_path):
    race = load_race("tx-senate-2026")
    rows = [["2026-08-05T00:00:00Z", None, 4.0], ["2026-08-05T01:00:00Z", 0.5, 2.0]]
    conn, _ = kconn(tmp_path, lambda *a: Resp(200, {"candlesticks": []}))
    b = display.build_hourly(race, conn, rows, log=lambda *_: None)
    assert b["rows"][:2] == [["2026-08-05T00:00:00Z", None, 4.0], ["2026-08-05T01:00:00Z", 0.5, 2.0]]
    assert b["forward_filled_null_price"]["n"] == 0
    assert b["null_price_hours"]["hours"] == ["2026-08-05T00:00:00Z"]


# -- reconciliation

def daily_block(rows):
    kd = daily_kalshi((ts(r[0]), r[1], r[2]) for r in rows)
    return {"rows": [{"date": d.isoformat(), "kalshi_price_close": e["close"], "kalshi_volume": e["volume"]}
                     for d, e in sorted(kd.items())]}


def test_reconciliation_matches_the_daily_definition(built):
    _, b, _, _ = built
    rec = display.reconcile(b["rows"], daily_block(b["rows"]))
    assert rec["status"] == "match" and rec["days_checked"] == 30
    assert rec["volume_mismatches"] == [] and rec["close_mismatches"] == [] and rec["daily_null_days"] == []


def test_reconciliation_lists_injected_mismatches(built):
    _, b, _, _ = built
    daily = daily_block(b["rows"])
    by = {r["date"]: r for r in daily["rows"]}
    want_sum = by["2026-08-12"]["kalshi_volume"]
    by["2026-08-12"]["kalshi_volume"] += 5
    by["2026-08-20"]["kalshi_price_close"] = 0.77
    by["2026-08-25"]["kalshi_volume"] = None
    by["2026-08-25"]["kalshi_price_close"] = None
    rec = display.reconcile(b["rows"], daily)
    assert rec["status"] == "mismatch"
    assert rec["volume_mismatches"] == [{"date": "2026-08-12", "hourly_sum": want_sum, "daily": want_sum + 5}]
    assert rec["close_mismatches"] == [{"date": "2026-08-20", "hourly_last": pytest.approx(0.43), "daily": 0.77}]
    assert rec["daily_null_days"] == ["2026-08-25"]
    # a 1e-7 volume difference is within tolerance
    daily2 = daily_block(b["rows"])
    daily2["rows"][3]["kalshi_volume"] += 1e-7
    assert display.reconcile(b["rows"], daily2)["status"] == "match"


# -- granularity

def test_granularity_keys():
    tx = {"hourly": {"rows": [["2026-09-01T00:00:00Z", 0.5, 1.0]]},
          "daily": {"columns": ["date", "excluded", "kalshi/price_close", "kalshi/volume", "wikipedia/pageviews_total",
                                "news_mediacloud/race_either/national"]}}
    g = display.granularity(tx)
    assert set(g) == {"kalshi", "wikipedia", "news_mediacloud", "note"}
    assert g["kalshi"] == "hourly and daily" and g["wikipedia"] == g["news_mediacloud"] == "daily"
    assert "no hourly news values" in g["note"]
    fl = {"hourly": {"rows": []}, "daily": {"columns": ["date", "excluded", "kalshi/price_close",
                                                        "wikipedia/pageviews_total", "bluesky/post_count"]}}
    assert set(display.granularity(fl)) == {"kalshi", "wikipedia", "note"}
    assert set(display.granularity({"daily": {"columns": ["date", "wikipedia/pageviews_total"]}})) == {"wikipedia",
                                                                                                         "note"}


# -- the pipeline builds both blocks and leaves the analysis output alone

def test_run_adds_display_hourly_and_granularity(tmp_path):
    raw = tmp_path / "raw"
    shutil.copytree(FIXTURE_RAW, raw)
    race = load_race("tx-senate-2026")
    kw = dict(raw_dir=str(raw), log=lambda *_: None, write=False)
    plain = run(race, ["kalshi"], display=False, **kw)
    http, sess = fake_http(kalshi_route)
    shown = run(race, ["kalshi"], http=http, **kw)
    assert "display_hourly" not in plain["series"] and "granularity" not in plain["series"]
    for k in ("daily", "hourly", "hourly_grid", "meta"):
        assert shown["series"][k] == plain["series"][k], k
    for k in ("metrics", "quality"):
        assert shown[k] == plain[k], k
    b = shown["series"]["display_hourly"]
    assert b["first_ts"] == "2026-08-05T00:00:00Z" and b["requests_made"] == 0  # display_daily pulled Aug 5 to 31
    d_reqs = [r for r in sess.requests if not is_r_candles(r["url"])]
    assert len(d_reqs) == 2  # two 20-day chunks for Aug 5 to 31, made once by display_daily
    assert len(sess.requests) - len(d_reqs) == 5  # the opposing contract: 92 days in 20-day chunks
    assert b["reconciliation"]["status"] == "match", b["reconciliation"]
    assert set(shown["series"]["granularity"]) == {"kalshi", "note"}
    # the opposing contract and the candidates block (see test_display_opposing.py)
    assert b["columns"][-2:] == ["kalshi_r/price_close", "kalshi_r/volume"] and b["opposing"]["ticker"] == "SENATETX-26-R"
    assert [m["kalshi_ticker"] for m in shown["candidates"]["major"]] == ["SENATETX-26-D", "SENATETX-26-R"]


# -- the committed processed files

def load(rid):
    path = os.path.join(PROCESSED, rid + ".json")
    if not os.path.isfile(path):
        pytest.skip("%s not present" % path)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@pytest.mark.parametrize("rid", RACES)
def test_committed_display_hourly(rid):
    res = load(rid)
    s = res["series"]
    b = s["display_hourly"]
    assert b["columns"][:3] == s["hourly"]["columns"]  # then the opposing contract (test_display_opposing.py)
    assert b["first_ts"] == b["rows"][0][0] == "2026-08-05T00:00:00Z"
    assert b["last_ts"] == b["rows"][-1][0] == s["hourly"]["rows"][-1][0]
    t = [ts(r[0]) for r in b["rows"]]
    assert all(y - x == dt.timedelta(hours=1) for x, y in zip(t, t[1:]))
    assert b["n_rows"] == len(b["rows"])
    rows = {r[0]: r[:3] for r in b["rows"]}
    ffill = set(b["forward_filled_null_price"]["hours"])
    for r in s["hourly"]["rows"]:
        if r[1] is not None:
            assert rows[r[0]] == r, r[0]
        elif r[0] in ffill:  # null close in the analysis pull: previous grid hour's price, same volume
            prev = rows[iso(ts(r[0]) - dt.timedelta(hours=1))]
            assert rows[r[0]] == [r[0], prev[1], r[2]] and prev[1] is not None, r[0]
        else:  # stays null only when no earlier close exists on the grid
            assert rows[r[0]] == r and all(x[1] is None for x in b["rows"] if x[0] <= r[0]), r[0]
    assert b["null_price_hours"]["hours"] == [x[0] for x in b["rows"] if x[1] is None]
    rec = b["reconciliation"]
    assert rec["days_checked"] == 92
    if rec["status"] != "match":  # real mismatches must be listed, never dropped
        assert rec["volume_mismatches"] or rec["close_mismatches"] or rec.get("days_without_hourly_rows")
    assert rec["status"] == "match", rec
    assert b["requests_made"] == 0
    g = s["granularity"]
    assert g["kalshi"] == "hourly and daily" and g["wikipedia"] == "daily"
    assert ("news_mediacloud" in g) == any(c.startswith("news_mediacloud/") for c in s["daily"]["columns"])


def test_committed_metrics_unchanged():
    # read from the committed JSON before the display-hourly patch
    tx = load("tx-senate-2026")["metrics"]["daily"]["wikipedia/pageviews_total"]["outcomes"]
    fl = load("fl-senate-2026")["metrics"]["daily"]["wikipedia/pageviews_total"]["outcomes"]
    assert (tx["volume_surprise"]["1"]["rho"], tx["volume_surprise"]["1"]["n"]) == (0.2786, 55)
    assert (tx["abs_price_change"]["0"]["rho"], tx["abs_price_change"]["0"]["n"]) == (0.0599, 56)
    assert (fl["volume_surprise"]["0"]["rho"], fl["volume_surprise"]["0"]["n"]) == (0.232, 56)
