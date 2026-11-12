"""Audit statistics: Wilson score interval for precision, simple agreement and Krippendorff's alpha (nominal).

Krippendorff's alpha follows K. Krippendorff, "Computing Krippendorff's Alpha-Reliability" (2011,
https://repository.upenn.edu/asc_papers/43): build the coincidence matrix from every unit that has two or more
values (each pair of values in a unit adds 1/(m_u - 1)), then alpha = 1 - D_o / D_e with the nominal
difference function (0 if equal, 1 otherwise). Units with fewer than two values are not pairable and are dropped.
"""
from __future__ import annotations

import math
from collections import Counter
from typing import Any, Hashable, Iterable, Optional, Sequence

Z95 = 1.959963984540054


def wilson(successes: int, n: int, z: float = Z95) -> tuple[Optional[float], Optional[float]]:
    """Wilson score interval (no continuity correction). (None, None) when n is 0."""
    if n <= 0:
        return None, None
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def simple_agreement(pairs: Iterable[tuple[Hashable, Hashable]]) -> tuple[Optional[float], int]:
    """Share of units where both coders gave the same value. Returns (agreement, n units)."""
    pairs = list(pairs)
    if not pairs:
        return None, 0
    return sum(1 for a, b in pairs if a == b) / len(pairs), len(pairs)


def krippendorff_alpha_nominal(units: Sequence[Sequence[Any]]) -> dict[str, Any]:
    """units: one list of values per unit (one value per coder; None = that coder gave no value).
    Returns alpha, the number of pairable values n, pairable units and the observed and expected disagreement."""
    o: Counter = Counter()
    n_units = 0
    for u in units:
        vals = [v for v in u if v is not None]
        m = len(vals)
        if m < 2:
            continue
        n_units += 1
        for i, a in enumerate(vals):
            for j, b in enumerate(vals):
                if i != j:
                    o[(a, b)] += 1.0 / (m - 1)
    n_c: Counter = Counter()
    for (a, _), w in o.items():
        n_c[a] += w
    n = sum(n_c.values())
    out: dict[str, Any] = {"alpha": None, "n_values": round(n, 6), "n_units": n_units}
    if n <= 1:
        out["reason"] = "fewer than two pairable values"
        return out
    d_o = sum(w for (a, b), w in o.items() if a != b) / n
    d_e = sum(n_c[a] * n_c[b] for a in n_c for b in n_c if a != b) / (n * (n - 1))
    out.update(observed_disagreement=round(d_o, 6), expected_disagreement=round(d_e, 6))
    if d_e == 0:
        out["reason"] = "only one value used by every coder, so expected disagreement is 0 and alpha is undefined"
        return out
    out["alpha"] = 1 - d_o / d_e
    return out
