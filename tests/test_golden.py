"""Texas golden test (spec section 9): reproduce the pilot from recorded fixtures, offline."""
import csv
import datetime as dt
import json
import os

import pytest

from raceattn.config import load_race
from raceattn.pipeline import run
from tests.conftest import FIXTURE_RAW, ROOT

PILOT = os.path.join(ROOT, "docs", "reference", "pilot", "out")
PAGES = {"wiki_race": "wikipedia/pageviews/2026_United_States_Senate_election_in_Texas",
         "wiki_talarico": "wikipedia/pageviews/James_Talarico",
         "wiki_paxton": "wikipedia/pageviews/Ken_Paxton",
         "wiki_total": "wikipedia/pageviews_total"}


@pytest.fixture(scope="module")
def result(tmp_path_factory):
    import socket

    # module-scoped, so block the network here too
    mp = pytest.MonkeyPatch()
    mp.setattr(socket.socket, "connect", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("network")))
    mp.setattr(socket, "getaddrinfo", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("network")))
    try:
        out = tmp_path_factory.mktemp("processed")
        res = run(load_race("tx-senate-2026"), ["kalshi", "wikipedia"], raw_dir=FIXTURE_RAW, out_dir=str(out),
                  log=lambda *_: None, display=False)
        res["_out"] = str(out)
        yield res
    finally:
        mp.undo()


@pytest.fixture(scope="module")
def pilot_results():
    with open(os.path.join(PILOT, "results.json")) as f:
        return json.load(f)


@pytest.fixture(scope="module")
def pilot_daily():
    with open(os.path.join(PILOT, "tx_daily.csv")) as f:
        return list(csv.DictReader(f))


def daily(result):
    cols = result["series"]["daily"]["columns"]
    return [dict(zip(cols, r)) for r in result["series"]["daily"]["rows"]]


def test_hourly_candles_1536(result):
    rows = result["series"]["hourly"]["rows"]
    assert len(rows) == 1536
    assert len({r[0] for r in rows}) == 1536
    assert result["quality"]["kalshi/price_close"]["extra"]["hours"] == 1536


@pytest.mark.parametrize("day, close", [("2026-09-05", 0.49), ("2026-10-05", 0.65), ("2026-10-29", 0.69),
                                        ("2026-11-04", 0.997)])
def test_daily_closes(result, day, close):
    d = {r["date"]: r for r in daily(result)}
    assert d[day]["kalshi/price_close"] == pytest.approx(close, abs=0.01)


def test_wikipedia_65_days_each(result):
    for s in PAGES.values():
        q = result["quality"][s]
        assert q["coverage_days"] == 65 and q["window_days"] == 65 and q["status"] == "ok", s
    rows = daily(result)
    assert len(rows) == 65
    for s in PAGES.values():
        assert all(r[s] is not None for r in rows)


@pytest.mark.parametrize("outcome", ["volume_surprise", "abs_price_change", "price_change"])
def test_lag_table_matches_pilot(result, pilot_results, outcome):
    ours = result["metrics"]["daily"]["wikipedia/pageviews_total"]["outcomes"][outcome]
    pilot = pilot_results["daily"]["wiki_total"][outcome]
    for lag in ["-2", "-1", "0", "1", "2"]:
        p_rho, p_n = pilot[lag]
        assert ours[lag]["n"] == p_n, (outcome, lag)
        assert ours[lag]["rho"] == pytest.approx(p_rho, abs=0.02), (outcome, lag)


def test_window_and_exclusions_match_pilot(result, pilot_results):
    assert [result["window"]["start"], result["window"]["end"]] == pilot_results["window"]
    assert result["excluded_days"] == pilot_results["excluded"]


def test_daily_table_matches_pilot_csv(result, pilot_daily):
    ours = {r["date"]: r for r in daily(result)}
    assert sorted(ours) == [r["date"] for r in pilot_daily]
    for p in pilot_daily:
        o = ours[p["date"]]
        assert o["kalshi/price_close"] == pytest.approx(float(p["close"]), abs=1e-9), p["date"]
        assert o["kalshi/volume"] == pytest.approx(float(p["volume"]), rel=1e-12), p["date"]
        for col, s in PAGES.items():
            assert o[s] == float(p[col]), (p["date"], col)


def test_output_files_written(result):
    with open(os.path.join(result["_out"], "tx-senate-2026.json")) as f:
        saved = json.load(f)
    assert saved["race"]["race_id"] == "tx-senate-2026"
    with open(os.path.join(result["_out"], "index.json")) as f:
        idx = json.load(f)
    h = idx["races"]["tx-senate-2026"]["headline"]
    assert h["status"] == "computed" and h["lags"]["1"]["n"] == 55


def test_every_metric_cell_has_n_quality_and_hash(result):
    entry = result["metrics"]["daily"]["wikipedia/pageviews_total"]
    assert entry["noise_band"] == pytest.approx(2 / 56 ** 0.5, abs=1e-4)
    assert entry["noise_band_pilot"] == pytest.approx(2 / 56 ** 0.5, abs=1e-4)
    for cells in entry["outcomes"].values():
        for c in cells.values():
            assert isinstance(c["n"], int) and c["quality_status"] in ("ok", "degraded")
            assert len(c["query_hash"]["attention"]) == 16 and len(c["query_hash"]["outcome"]) == 16
            assert c["noise_band"] == pytest.approx(2 / c["n"] ** 0.5, abs=1e-4)


def test_queries_logged(result):
    k = result["queries"]["kalshi"]
    assert len(k["queries"]) == 4
    assert k["queries"][0]["endpoint"].endswith("/series/SENATETX/markets/SENATETX-26-D/candlesticks")
    assert k["queries"][0]["params"]["start_ts"] == int(dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc).timestamp())
    assert k["queries"][-1]["params"]["end_ts"] == int(dt.datetime(2026, 11, 5, tzinfo=dt.timezone.utc).timestamp())
    w = result["queries"]["wikipedia"]["queries"]
    assert [q["endpoint"].split("/")[-4] for q in w] == ["2026_United_States_Senate_election_in_Texas",
                                                           "James_Talarico", "Ken_Paxton"]
    assert all(q["endpoint"].endswith("/daily/20260901/20261104") for q in w)
