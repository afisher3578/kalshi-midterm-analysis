"""Surprise transform and Kalshi aggregates (spec section 8). Matches the pilot exactly."""
from __future__ import annotations

import datetime as dt
import math
from typing import Iterable, Optional, Sequence

Num = Optional[float]


def surprise(series: Sequence[Num], lookback: int = 7, step: int = 1) -> list[Num]:
    """ln((x_t + 1) / (mean of the previous `lookback` same-slot values + 1)).

    step=1 for daily series (previous 7 days), step=24 for hourly series (same hour on the previous 7 days).
    None when x_t is None or any of the previous `lookback` same-slot values is missing.
    """
    out: list[Num] = []
    for i, x in enumerate(series):
        prev = [series[i - k * step] for k in range(1, lookback + 1) if i - k * step >= 0]
        if x is None or len(prev) < lookback or any(p is None for p in prev):
            out.append(None)
        else:
            out.append(math.log((x + 1) / (sum(prev) / len(prev) + 1)))
    return out


def price_changes(close: Sequence[Num]) -> tuple[list[Num], list[Num]]:
    """Signed and absolute change from the previous slot. None where either side is missing."""
    signed: list[Num] = [None]
    for i in range(1, len(close)):
        a, b = close[i - 1], close[i]
        signed.append(b - a if a is not None and b is not None else None)
    return signed, [abs(x) if x is not None else None for x in signed]


def daily_kalshi(hourly: Iterable[tuple[dt.datetime, Num, Num]]) -> dict[dt.date, dict[str, Num]]:
    """Group hourly (ts_utc, close, volume) by the UTC date of ts_utc (the candle's end_period_ts).

    volume = sum of the day's hourly volume; close = last non-null close of the day.
    Input must be in time order (the sum is then bit-identical to the pilot's).
    """
    days: dict[dt.date, dict[str, Num]] = {}
    for t, close, vol in hourly:
        e = days.setdefault(t.astimezone(dt.timezone.utc).date(), {"volume": 0.0, "close": None})
        e["volume"] += vol or 0.0
        if close is not None:
            e["close"] = close
    return days


def apply_mask(series: Sequence[Num], keep: Sequence[bool]) -> list[Num]:
    return [v if k else None for v, k in zip(series, keep)]
