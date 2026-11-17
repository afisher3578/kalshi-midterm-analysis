"""The opposing (Republican) contract: the market chosen from the event's markets list, the R columns on the
existing hourly grid, daily R from the hourly candles, the reconciliation, the sum check, the candidates block and
the committed processed files. Offline only.

The Kalshi events, candles and display blocks in the build tests are SYNTHETIC, built in this file; none of it is
real Kalshi data. The last section reads the committed data/processed files (skipped when they are absent).
"""
import copy
import datetime as dt
import json
import os

import pytest

from raceattn import discover, opposing
from raceattn.cache import Cache, query_hash
from raceattn.config import load_race
from raceattn.connectors.kalshi import KalshiConnector
from raceattn.metrics.surprise import daily_kalshi
from tests.conftest import ROOT
from tests.fakes import Resp, fake_http

UTC = dt.timezone.utc
PROCESSED = os.path.join(ROOT, "data", "processed")
RACES = ("fl-senate-2026", "ky-senate-2026", "nc-senate-2026", "oh-senate-2026", "tx-governor-2026", "tx-senate-2026")
EVENT = "SENATETX-26"
R_TICKER = "SENATETX-26-REP"  # not "<event>-R": the rule must read the markets list
MARKETS = [
    {"ticker": "SENATETX-26-D", "subtitle": "Democratic party:: Democratic party", "yes_sub_title": "James Talarico",
     "status": "finalized", "result": "yes"},
    {"ticker": "SENATETX-26-R", "subtitle": "Independent:: Independent", "yes_sub_title": "Synthetic Independent",
     "status": "finalized", "result": "no"},
    {"ticker": R_TICKER, "subtitle": "Republican party:: Republican party", "yes_sub_title": "Ken Paxton",
     "status": "finalized", "result": "no"},
]
NO_R_BEFORE = dt.datetime(2026, 8, 5, 3, tzinfo=UTC)  # synthetic: the R market has no candle before 03:00
NO_R = {dt.datetime(2026, 8, 6, 10, tzinfo=UTC)}  # synthetic gap in the R candles
GRID_END = dt.datetime(2026, 8, 7, 0, tzinfo=UTC)  # the synthetic D grid ends here; R candles go further


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def r_price(t):
    return round(0.40 + t.hour / 1000, 3)


def route(method, url, params, headers, body):
    if url.endswith("/events/" + EVENT):
        return Resp(200, {"event": {"event_ticker": EVENT}, "markets": MARKETS})
    if R_TICKER + "/candlesticks" not in url:
        return Resp(404, {"error": "unexpected %s" % url})
    out = []
    for t in range(params["start_ts"], params["end_ts"] + 1, 3600):
        end = dt.datetime.fromtimestamp(t, UTC)
        if end < NO_R_BEFORE or end in NO_R or end > dt.datetime(2026, 8, 8, tzinfo=UTC):
            continue
        out.append({"end_period_ts": t, "price": {"close_dollars": "%.3f" % r_price(end)}, "volume_fp": str(t % 11)})
    return Resp(200, {"candlesticks": out})


def no_requests(method, url, params, headers, body):
    raise AssertionError("request made for a cached read: %s %s" % (url, params))


def synthetic_result():
    """A race JSON with a synthetic D display_hourly (Aug 5 00:00 to Aug 7 00:00) and display_daily (Aug 5 to 7)."""
    rows, t = [], dt.datetime(2026, 8, 5, tzinfo=UTC)
    while t <= GRID_END:
        rows.append([iso(t), 0.6, 1.0])
        t += dt.timedelta(hours=1)
    daily = [{"date": d, "kalshi_price_close": 0.6, "kalshi_volume": float(sum(1 for r in rows if r[0][:10] == d)),
              "wikipedia_pageviews_total": 7.0} for d in ("2026-08-05", "2026-08-06", "2026-08-07")]
    return {"series": {
        "hourly": {"columns": ["ts_utc", "kalshi/price_close", "kalshi/volume"], "rows": [["x", 1, 2]]},
        "display_hourly": {"columns": ["ts_utc", "kalshi/price_close", "kalshi/volume"], "rows": rows,
                           "first_ts": rows[0][0], "last_ts": rows[-1][0], "n_rows": len(rows),
                           "filled_hours": {"n": 0}, "reconciliation": {"status": "match"}},
        "display_daily": {"columns": ["date", "kalshi_price_close", "kalshi_volume", "wikipedia_pageviews_total"],
                          "rows": daily, "requests_made": 0}},
        "metrics": {"x": 1}}


@pytest.fixture
def applied(tmp_path):
    race = load_race("tx-senate-2026")  # event SENATETX-26, followed market SENATETX-26-D
    http, sess = fake_http(route)
    conn = KalshiConnector(http=http, cache=Cache(str(tmp_path)))
    conn.log = lambda *_: None
    fetcher = discover.Fetcher(http, raw_dir=str(tmp_path), log=lambda *_: None)
    before = synthetic_result()
    res = copy.deepcopy(before)
    out = opposing.apply(race, res, conn, fetcher, log=lambda *_: None)
    return race, before, res, out, sess, tmp_path


# -- the market

def test_opposing_market_from_the_markets_list_not_the_ticker():
    m, rule = opposing.opposing_market(MARKETS, "SENATETX-26-D")
    assert m["ticker"] == R_TICKER and m["yes_sub_title"] == "Ken Paxton" and "subtitle" in rule
    race = load_race("tx-senate-2026")
    p = opposing.pick(race, MARKETS)
    assert p["d"]["ticker"] == "SENATETX-26-D" and p["r"]["ticker"] == R_TICKER
    assert [(m["ticker"], m["name"]) for m in p["left_out"]] == [("SENATETX-26-R", "Synthetic Independent")]


def test_no_republican_market_is_an_error():
    with pytest.raises(ValueError):
        opposing.opposing_market([MARKETS[0]], "SENATETX-26-D")


# -- the columns

def test_r_columns_appended_and_existing_untouched(applied):
    _, before, res, _, _, _ = applied
    dh, dh0 = res["series"]["display_hourly"], before["series"]["display_hourly"]
    assert dh["columns"] == dh0["columns"] + ["kalshi_r/price_close", "kalshi_r/volume"]
    assert len(dh["rows"]) == len(dh0["rows"]) and [r[:3] for r in dh["rows"]] == dh0["rows"]
    for k in ("first_ts", "last_ts", "n_rows", "filled_hours", "reconciliation"):
        assert dh[k] == dh0[k], k
    dd, dd0 = res["series"]["display_daily"], before["series"]["display_daily"]
    assert dd["columns"] == dd0["columns"] + ["kalshi_r_price_close", "kalshi_r_volume"]
    for r, r0 in zip(dd["rows"], dd0["rows"]):
        assert {k: v for k, v in r.items() if not k.startswith("kalshi_r_")} == r0
    assert res["series"]["hourly"] == before["series"]["hourly"]
    assert res["metrics"] == before["metrics"]


def test_forward_fill_volume_zero_and_leading_null(applied):
    _, _, res, out, _, _ = applied
    rows = {r[0]: r for r in res["series"]["display_hourly"]["rows"]}
    b = out["block"]
    # no R candle before 03:00: leading nulls with volume 0
    assert [rows["2026-08-05T0%d:00:00Z" % h][3:] for h in range(3)] == [[None, 0.0]] * 3
    assert b["leading_null_hours"]["n"] == 3
    assert rows["2026-08-05T03:00:00Z"][3] == r_price(NO_R_BEFORE)
    # the gap hour gets the previous R close and volume 0
    assert rows["2026-08-06T10:00:00Z"][3:] == [rows["2026-08-06T09:00:00Z"][3], 0.0]
    assert b["filled_hours"]["hours"] == ["2026-08-05T00:00:00Z", "2026-08-05T01:00:00Z", "2026-08-05T02:00:00Z",
                                          "2026-08-06T10:00:00Z"]
    # R candles past the D grid are not added
    assert res["series"]["display_hourly"]["rows"][-1][0] == iso(GRID_END)
    assert b["candles_after_grid"]["n"] == 24 and b["candles_after_grid"]["first"] == "2026-08-07T01:00:00Z"
    assert b["ticker"] == R_TICKER and b["party"] == "R" and b["name"] == "Ken Paxton"
    assert "/events/" + EVENT in b["source"] and "event.json" in b["source"]


def test_r_daily_matches_the_daily_definition(applied):
    race, _, res, _, _, tmp = applied
    conn = KalshiConnector(http=fake_http(no_requests)[0], cache=Cache(str(tmp)))
    rows, made, hits = opposing.fetch_r(race, conn, R_TICKER)
    assert made == 0 and hits == 5
    vol = {r.ts_utc: r.value for r in rows if r.series == "kalshi/volume"}
    kd = daily_kalshi((r.ts_utc, r.value, vol[r.ts_utc]) for r in rows if r.series == "kalshi/price_close")
    for r in res["series"]["display_daily"]["rows"]:
        e = kd[dt.date.fromisoformat(r["date"])]
        assert r["kalshi_r_price_close"] == e["close"] and r["kalshi_r_volume"] == e["volume"]


def test_reconciliation_and_injected_mismatch(applied):
    _, _, res, out, _, _ = applied
    rec = out["block"]["reconciliation"]
    # Aug 7 has R candles after the grid's last_ts in the daily values only: a listed mismatch, with a note
    assert rec["status"] == "mismatch" and [m["date"] for m in rec["volume_mismatches"]] == ["2026-08-07"]
    assert [m["date"] for m in rec["close_mismatches"]] == ["2026-08-07"]
    assert "after the grid" in rec["note"]
    dd = copy.deepcopy(res["series"]["display_daily"])
    dd["rows"][0]["kalshi_r_volume"] += 5
    dd["rows"][1]["kalshi_r_price_close"] = 0.123
    rows = [[r[0], r[3], r[4]] for r in res["series"]["display_hourly"]["rows"]]
    rec2 = opposing.reconcile(rows, dd, price_col=opposing.D_PRICE, volume_col=opposing.D_VOLUME)
    assert [m["date"] for m in rec2["volume_mismatches"]] == ["2026-08-05", "2026-08-07"]
    assert [m["date"] for m in rec2["close_mismatches"]] == ["2026-08-06", "2026-08-07"]


def test_sum_check_flag(applied):
    _, _, res, out, _, _ = applied
    s = out["block"]["sum_check"]
    hrows = res["series"]["display_hourly"]["rows"]
    pairs = [r[1] + r[3] for r in hrows if r[3] is not None]
    assert s["n"] == len(pairs) and s["mean"] == round(sum(pairs) / len(pairs), 6)
    assert s["flag"] is False  # 0.6 + about 0.41 is about 1.01
    assert res["series"]["display_daily"]["opposing"]["sum_check"]["n"] == 3
    assert opposing.sum_check([(0.6, 0.5), (0.7, 0.5)])["flag"] is True  # mean 1.15
    assert opposing.sum_check([(0.5, 0.52), (None, 0.5)]) == opposing.sum_check([(0.5, 0.52)])
    assert opposing.sum_check([(None, 0.5)])["n"] == 0


def test_second_apply_replaces_and_makes_no_requests(applied):
    race, _, res, out, sess, tmp = applied
    assert len(sess.requests) == 1 + 5  # the event body, then 92 days in 20-day chunks
    http, sess2 = fake_http(no_requests)
    conn = KalshiConnector(http=http, cache=Cache(str(tmp)))
    conn.log = lambda *_: None
    again = copy.deepcopy(res)
    out2 = opposing.apply(race, again, conn, discover.Fetcher(http, raw_dir=str(tmp), log=lambda *_: None),
                          log=lambda *_: None)
    assert sess2.requests == [] and out2["block"]["requests_made"] == 0 and out2["event_requests"] == 0
    assert again["series"]["display_hourly"]["rows"] == res["series"]["display_hourly"]["rows"]
    assert again["series"]["display_daily"]["columns"] == res["series"]["display_daily"]["columns"]


def test_candidates_block(applied):
    _, _, res, _, _, tmp = applied
    c = res["candidates"]
    assert [(m["name"], m["party"], m["kalshi_ticker"]) for m in c["major"]] == [
        ("James Talarico", "D", "SENATETX-26-D"), ("Ken Paxton", "R", R_TICKER)]
    assert c["left_out"][0]["ticker"] == "SENATETX-26-R" and c["left_out"][0]["name"] == "Synthetic Independent"
    # no cached race article in tmp: the infobox check is reported as impossible, not skipped silently
    assert "Wikipedia check impossible" in c["note"]


def test_config_name_kept_on_a_kalshi_name_mismatch():
    race = load_race("tx-senate-2026")
    mk = copy.deepcopy(MARKETS)
    mk[2]["yes_sub_title"] = "Warren Kenneth Paxton"
    p = opposing.pick(race, mk)
    c = opposing.candidates(race, p, {"url": "u", "cache_file": "f"},
                            discover.Fetcher(None, raw_dir=os.path.join(ROOT, "data", "raw"), log=lambda *_: None))
    assert c["major"][1]["name"] == "Ken Paxton" and c["major"][1]["kalshi_name"] == "Warren Kenneth Paxton"
    assert "Warren Kenneth Paxton" in c["note"] and "config name is kept" in c["note"]


# -- the committed processed files

def load(rid):
    path = os.path.join(PROCESSED, rid + ".json")
    if not os.path.isfile(path):
        pytest.skip("%s not present" % path)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@pytest.mark.parametrize("rid", RACES)
def test_committed_opposing(rid):
    res = load(rid)
    s = res["series"]
    dh, dd = s["display_hourly"], s["display_daily"]
    assert dh["columns"][-2:] == ["kalshi_r/price_close", "kalshi_r/volume"]
    assert dh["columns"][:3] == ["ts_utc", "kalshi/price_close", "kalshi/volume"]
    assert all(len(r) == 5 for r in dh["rows"]) and dh["n_rows"] == len(dh["rows"])
    assert "kalshi_r_price_close" in dd["columns"] and "kalshi_r_volume" in dd["columns"]
    assert dd["rows"][0]["date"] == "2026-08-05" and dh["rows"][0][0] == "2026-08-05T00:00:00Z"
    c = res["candidates"]
    assert [m["party"] for m in c["major"]] == ["D", "R"]
    assert c["major"][0]["kalshi_ticker"] == res["race"]["kalshi"]["followed_market"]
    o = dh["opposing"]
    assert o["ticker"] == c["major"][1]["kalshi_ticker"] and o["party"] == "R"
    assert o["reconciliation"]["status"] == "match", o["reconciliation"]
    for blk in (o["sum_check"], dd["opposing"]["sum_check"]):
        assert blk["flag"] == (abs(blk["mean"] - 1) > 0.05)
    # the event body really lists that market as the Republican one
    ev = res["race"]["kalshi"]["event"]
    url = discover.kalshi_event_url(ev)
    path = os.path.join(ROOT, "data", "raw", "kalshi_discovery", "event", ev, query_hash(url, {}), "event.json")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            mk = json.load(f)["body"]["markets"]
        m, _ = opposing.opposing_market(mk, res["race"]["kalshi"]["followed_market"])
        assert m["ticker"] == o["ticker"] and m["yes_sub_title"] == o["name"]


def test_committed_tx_senate_candidates():
    c = load("tx-senate-2026")["candidates"]
    assert [(m["name"], m["party"], m["kalshi_ticker"]) for m in c["major"]] == [
        ("James Talarico", "D", "SENATETX-26-D"), ("Ken Paxton", "R", "SENATETX-26-R")]


def test_committed_metrics_unchanged():
    # read from the committed JSON before the display-opposing patch
    tx = load("tx-senate-2026")["metrics"]["daily"]["news_mediacloud/race_either/national"]["outcomes"]
    oh = load("oh-senate-2026")["metrics"]["daily"]["wikipedia/pageviews_total"]["outcomes"]
    assert (tx["volume_surprise"]["0"]["rho"], tx["volume_surprise"]["0"]["n"]) == (0.2091, 56)
    assert (tx["abs_price_change"]["1"]["rho"], tx["abs_price_change"]["1"]["n"]) == (0.0855, 55)
    assert (oh["abs_price_change"]["0"]["rho"], oh["abs_price_change"]["0"]["n"]) == (0.1876, 56)
