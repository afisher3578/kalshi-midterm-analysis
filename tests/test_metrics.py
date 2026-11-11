import datetime as dt
import math

import pytest

from raceattn.metrics.lags import (HOURLY_LAGS, attention_lag_table, lag_table, noise_band, pilot_noise_band, ranks,
                                   spearman)
from raceattn.metrics.surprise import apply_mask, daily_kalshi, price_changes, surprise


def test_surprise_daily():
    s = [1, 1, 1, 1, 1, 1, 1, 3]
    out = surprise(s, 7)
    assert out[:7] == [None] * 7
    assert out[7] == pytest.approx(math.log(4 / 2))


def test_surprise_none_when_any_prev_missing_or_x_missing():
    s = [1, 1, None, 1, 1, 1, 1, 3, 2, 2, 2, 2, 2, None]
    out = surprise(s, 7)
    assert out[7] is None  # window i-7..i-1 includes the None at 2
    assert out[9] is None  # still includes index 2
    assert out[10] is not None
    assert out[13] is None  # x itself missing


def test_surprise_hourly_same_slot():
    # 8 days of hourly data; hour 5 is 9 on the last day, 1 elsewhere
    s = [1.0] * (24 * 8)
    s[24 * 7 + 5] = 9.0
    out = surprise(s, 7, step=24)
    assert all(v is None for v in out[: 24 * 7])
    assert out[24 * 7 + 5] == pytest.approx(math.log(10 / 2))
    assert out[24 * 7 + 4] == pytest.approx(0.0)


def test_price_changes():
    signed, ab = price_changes([0.5, 0.6, None, 0.4, 0.3])
    assert signed[0] is None and signed[1] == pytest.approx(0.1)
    assert signed[2] is None and signed[3] is None
    assert signed[4] == pytest.approx(-0.1) and ab[4] == pytest.approx(0.1)


def test_daily_kalshi_groups_by_end_period_date():
    t = lambda d, h: dt.datetime(2026, 9, d, h, tzinfo=dt.timezone.utc)
    rows = [(t(1, 0), 0.5, 10.0), (t(1, 23), 0.6, 5.0), (t(2, 0), None, 0.0), (t(2, 1), 0.7, None)]
    d = daily_kalshi(rows)
    assert d[dt.date(2026, 9, 1)] == {"volume": 15.0, "close": 0.6}
    assert d[dt.date(2026, 9, 2)] == {"volume": 0.0, "close": 0.7}


def test_ranks_ties_average():
    assert ranks([10, 20, 20, 30]) == [1.0, 2.5, 2.5, 4.0]
    assert ranks([5, 5, 5]) == [2.0, 2.0, 2.0]


def test_spearman_perfect_and_inverse():
    a = list(range(25))
    assert spearman(a, a)[0] == pytest.approx(1.0)
    assert spearman(a, a[::-1])[0] == pytest.approx(-1.0)


def test_spearman_with_ties_matches_pearson_on_ranks():
    a = [1, 2, 2, 3, 4, 5, 5, 5, 6, 7, 8, 9, 9, 10, 11, 12, 13, 13, 14, 15]
    b = [2, 1, 3, 3, 5, 4, 6, 6, 8, 7, 9, 9, 11, 10, 12, 14, 13, 15, 15, 16]
    rho, n = spearman(a, b)
    ra, rb = ranks(a), ranks(b)
    ma, mb = sum(ra) / n, sum(rb) / n
    exp = sum((x - ma) * (y - mb) for x, y in zip(ra, rb)) / math.sqrt(
        sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))
    assert n == 20 and rho == pytest.approx(exp)


def test_spearman_under_20_pairs_blank_but_n_reported():
    a = list(range(25))
    b = [None] * 6 + list(range(19))
    rho, n = spearman(a, b)
    assert rho is None and n == 19


def test_spearman_constant_is_none():
    assert spearman([1] * 30, list(range(30)))[0] is None


def test_lag_direction():
    # outcome is attention shifted forward by 1: lag +1 is perfect
    att = [float((i * 7) % 11) for i in range(40)]
    out = [None] + att[:-1]
    t = lag_table(att, {"o": out}, [-1, 0, 1])
    assert t["o"]["1"]["rho"] == pytest.approx(1.0)
    assert t["o"]["1"]["n"] == 39
    assert t["o"]["1"]["noise_band"] == pytest.approx(round(2 / math.sqrt(39), 4))


def test_lag_table_blank_cells():
    t = lag_table(list(range(15)), {"o": list(range(15))}, [0])
    assert t["o"]["0"] == {"rho": None, "n": 15, "noise_band": round(2 / math.sqrt(15), 4)}


def test_noise_bands():
    assert noise_band(25) == pytest.approx(0.4)
    assert noise_band(0) is None
    assert pilot_noise_band(63) == pytest.approx(2 / math.sqrt(56))
    assert pilot_noise_band(3) == pytest.approx(2.0)


def test_apply_mask():
    assert apply_mask([1, 2, 3], [True, False, True]) == [1, None, 3]


def test_hourly_path_lags_and_mask():
    hours = 24 * 30
    import random

    rng = random.Random(1)
    vol = [rng.random() * 100 for _ in range(hours)]
    att = vol[1:] + [vol[-1]]  # attention at t mirrors volume at t+1
    close = [0.5 + 0.001 * (i % 7) for i in range(hours)]
    keep = [True] * hours
    t = attention_lag_table(att, close, vol, keep, step=24, lags=HOURLY_LAGS)
    assert set(t) == {"volume_surprise", "abs_price_change", "price_change"}
    assert list(t["volume_surprise"]) == ["-3", "-2", "-1", "0", "1", "2", "3"]
    best = max(t["volume_surprise"], key=lambda k: t["volume_surprise"][k]["rho"] or -9)
    assert best == "1"  # outcome one hour after attention
    # masking the last 5 days removes pairs on both sides
    keep2 = [i < 24 * 25 for i in range(hours)]
    t2 = attention_lag_table(att, close, vol, keep2, step=24, lags=HOURLY_LAGS)
    assert t2["volume_surprise"]["0"]["n"] == 24 * 25 - 24 * 7
