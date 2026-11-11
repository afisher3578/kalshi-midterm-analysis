"""Kalshi trades: recorded live fixture spanning the historical cutoff, block trades, small-trade share."""
import datetime as dt
import os

import pytest

from raceattn.cache import Cache
from raceattn.config import load_race
from raceattn.connectors.kalshi import SERIES_SMALL_TRADE_SHARE, SERIES_TRADE_COUNT, KalshiTradesConnector
from tests.conftest import FIXTURE_RAW, TEST_CONFIGS
from tests.fakes import Resp, fake_http

TWO_DAY = os.path.join(TEST_CONFIGS, "tx-trades-2day.yaml")


def test_recorded_fixture_spans_cutoff():
    race = load_race(TWO_DAY)
    c = KalshiTradesConnector(cache=Cache(FIXTURE_RAW))
    rows = c.fetch(race, race.window)
    s = c.query_summary(race, race.window)
    eps = [q["endpoint"].split("/trade-api/v2")[1] for q in s["queries"]]
    assert eps == ["/historical/cutoff", "/historical/trades", "/markets/trades"]
    hist, live = s["queries"][1]["params"], s["queries"][2]["params"]
    assert hist["max_ts"] == live["min_ts"] == int(dt.datetime(2026, 9, 11, tzinfo=dt.timezone.utc).timestamp())
    counts = [r for r in rows if r.series == SERIES_TRADE_COUNT]
    shares = [r for r in rows if r.series == SERIES_SMALL_TRADE_SHARE]
    assert len(counts) == len(shares) == 48  # every hour of the 2-day window
    assert sum(r.value for r in counts) == 754 == c.stats["trades_in_window"]
    assert c.stats["pages"] == {"historical": 1, "live": 1} and c.fetches == 0
    assert all(r.source == "kalshi" for r in rows)
    for cnt, sh in zip(counts, shares):
        assert (sh.value is None) == (cnt.value == 0)
        assert sh.value is None or 0 <= sh.value <= 1
    q = c.quality(rows, race.window)
    assert q[SERIES_TRADE_COUNT].status == "ok"
    assert q[SERIES_TRADE_COUNT].extra["block_trades_excluded"] == 0
    assert q[SERIES_TRADE_COUNT].extra["small_trade_threshold_contracts"] == 10


def trade(tid, ts, count, block=False):
    return {"trade_id": tid, "created_time": ts, "count_fp": count, "is_block_trade": block,
            "yes_price_dollars": "0.5000", "taker_side": "yes", "ticker": "X"}


def synthetic_route(method, url, params, headers, body):
    if url.endswith("/historical/cutoff"):
        return Resp(200, {"trades_created_ts": "2026-09-11T00:00:00Z"})
    if url.endswith("/historical/trades"):
        return Resp(200, {"cursor": "", "trades": [trade("a", "2026-09-10T05:10:00Z", "3.00"),
                                                    trade("b", "2026-09-10T05:20:00Z", "250.00", block=True)]})
    if params.get("cursor") == "p2":
        return Resp(200, {"cursor": "", "trades": [trade("d", "2026-09-11T05:59:59Z", "9.99"),
                                                    trade("c", "2026-09-11T05:30:00Z", "12.00")]})  # dup c
    return Resp(200, {"cursor": "p2", "trades": [trade("c", "2026-09-11T05:30:00Z", "12.00"),
                                                 trade("e", "2026-09-11T05:00:00Z", "10.00")]})


@pytest.mark.parametrize("mode, n_hist", [("exclude", 1), ("include", 2)])
def test_block_trades_and_threshold(tmp_path, mode, n_hist):
    race = load_race(TWO_DAY)
    http, sess = fake_http(synthetic_route)
    c = KalshiTradesConnector(http=http, cache=Cache(str(tmp_path)), block_trades=mode)
    rows = c.fetch(race, race.window)
    by = {(r.series, r.ts_utc): r.value for r in rows}
    h5 = dt.datetime(2026, 9, 10, 5, tzinfo=dt.timezone.utc)
    assert by[(SERIES_TRADE_COUNT, h5)] == n_hist
    assert by[(SERIES_SMALL_TRADE_SHARE, h5)] == pytest.approx(1 / n_hist)  # 3 small; 250 is not
    h5b = h5 + dt.timedelta(days=1)
    assert by[(SERIES_TRADE_COUNT, h5b)] == 3  # c, e, d; duplicate c dropped
    assert by[(SERIES_SMALL_TRADE_SHARE, h5b)] == pytest.approx(1 / 3)  # only 9.99 < 10
    assert c.stats["block_trades_seen"] == 1
    assert c.stats["block_trades_excluded"] == (1 if mode == "exclude" else 0)
    assert c.stats["duplicate_trade_ids_dropped"] == 1
    assert sess.requests[-1]["params"]["cursor"] == "p2"


def test_threshold_configurable(tmp_path):
    race = load_race(TWO_DAY)
    http, _ = fake_http(synthetic_route)
    c = KalshiTradesConnector(http=http, cache=Cache(str(tmp_path)), small_trade_threshold=11)
    rows = c.fetch(race, race.window)
    h = dt.datetime(2026, 9, 11, 5, tzinfo=dt.timezone.utc)
    assert {(r.series, r.ts_utc): r.value for r in rows}[(SERIES_SMALL_TRADE_SHARE, h)] == pytest.approx(2 / 3)


def test_bad_block_mode():
    with pytest.raises(ValueError):
        KalshiTradesConnector(block_trades="maybe")


@pytest.mark.live
def test_live_trades_smoke(tmp_path):
    race = load_race(TWO_DAY)
    c = KalshiTradesConnector(cache=Cache(str(tmp_path)))
    rows = c.fetch(race, race.window)
    assert sum(r.value for r in rows if r.series == SERIES_TRADE_COUNT) == 754
