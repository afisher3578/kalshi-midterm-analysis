"""Spearman lag tables (spec section 8). Same math as the pilot."""
from __future__ import annotations

import math
from typing import Optional, Sequence

Num = Optional[float]
MIN_PAIRS = 20
DAILY_LAGS = (-2, -1, 0, 1, 2)
HOURLY_LAGS = (-3, -2, -1, 0, 1, 2, 3)


def ranks(v: Sequence[float]) -> list[float]:
    """1-based ranks, ties get the average rank."""
    idx = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v)
    i = 0
    while i < len(idx):
        j = i
        while j + 1 < len(idx) and v[idx[j + 1]] == v[idx[i]]:
            j += 1
        for k in range(i, j + 1):
            r[idx[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def spearman(a: Sequence[Num], b: Sequence[Num], min_n: int = MIN_PAIRS) -> tuple[Num, int]:
    """Spearman rho over pairs where both sides are present. (None, n) when n < min_n or no variance."""
    pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
    n = len(pairs)
    if n < min_n:
        return None, n
    ra, rb = ranks([p[0] for p in pairs]), ranks([p[1] for p in pairs])
    ma, mb = sum(ra) / n, sum(rb) / n
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    den = math.sqrt(sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))
    return (num / den if den else None), n


def noise_band(n: int) -> Num:
    """Rough |rho| noise band 2/sqrt(n). Generous: daily series are autocorrelated."""
    return 2 / math.sqrt(n) if n > 0 else None


def pilot_noise_band(n_days: int) -> float:
    """The pilot printed 2/sqrt(max(n - 7, 1)) with n = non-excluded days."""
    return 2 / math.sqrt(max(n_days - 7, 1))


def lag_table(att: Sequence[Num], outcomes: dict[str, Sequence[Num]], lags: Sequence[int],
              min_n: int = MIN_PAIRS) -> dict[str, dict[str, dict[str, Num]]]:
    """For each outcome and lag k, Spearman of att[i] vs outcome[i + k].
    k > 0 means the outcome is measured k slots AFTER the attention."""
    table: dict[str, dict[str, dict[str, Num]]] = {}
    for name, o in outcomes.items():
        table[name] = {}
        for k in lags:
            a, b = [], []
            for i in range(len(att)):
                j = i + k
                if 0 <= j < len(o):
                    a.append(att[i])
                    b.append(o[j])
            rho, n = spearman(a, b, min_n)
            table[name][str(k)] = {"rho": None if rho is None else round(rho, 4), "n": n, "noise_band": (
                None if noise_band(n) is None else round(noise_band(n), 4))}
    return table


def outcome_series(close: Sequence[Num], volume: Sequence[Num], step: int = 1, lookback: int = 7) -> dict[str, list[Num]]:
    """The three outcomes: volume surprise, absolute price change, signed price change (per slot)."""
    from raceattn.metrics.surprise import price_changes, surprise

    signed, absolute = price_changes(close)
    return {"volume_surprise": surprise(volume, lookback, step), "abs_price_change": absolute,
            "price_change": signed}


def attention_lag_table(att: Sequence[Num], close: Sequence[Num], volume: Sequence[Num], keep: Sequence[bool],
                        step: int, lags: Sequence[int], lookback: int = 7, min_n: int = MIN_PAIRS):
    """Attention surprise vs the three outcomes. Excluded slots (keep False) are masked on both sides,
    after the surprise is computed, the same way the pilot does it."""
    from raceattn.metrics.surprise import apply_mask, surprise

    a = apply_mask(surprise(att, lookback, step), keep)
    outs = {k: apply_mask(v, keep) for k, v in outcome_series(close, volume, step, lookback).items()}
    return lag_table(a, outs, lags, min_n)
