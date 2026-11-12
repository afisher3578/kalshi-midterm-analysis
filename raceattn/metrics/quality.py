"""Data quality checks (spec section 6). Quality is computed on daily buckets.

Thresholds (documented in README and docs/m0-notes.md):
- near zero: a day under NEAR_ZERO_FRAC (5%) of the series median (median of non-missing days), in a stretch
  that has at least one normal neighbor (a present day at or above the threshold) on either side.
- unusable: coverage < UNUSABLE_COVERAGE (70%), or no data, or near-zero days > UNUSABLE_NEAR_ZERO_FRAC (10%) of the window.
- degraded: coverage < OK_COVERAGE (95%), or any near-zero stretch, or a gap of DEGRADED_GAP_DAYS (3) days or more.
- ok: everything else.
Missing days stay missing. Nothing is interpolated.
"""
from __future__ import annotations

import datetime as dt
import statistics
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

NEAR_ZERO_FRAC = 0.05
OK_COVERAGE = 0.95
UNUSABLE_COVERAGE = 0.70
UNUSABLE_NEAR_ZERO_FRAC = 0.10
DEGRADED_GAP_DAYS = 3

STATUS_ORDER = {"ok": 0, "degraded": 1, "unusable": 2}


@dataclass
class Quality:
    coverage_days: int
    window_days: int
    missing_days: list[str]
    longest_gap: int
    near_zero: list[dict[str, Any]]
    status: str
    reasons: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def coverage(self) -> float:
        return self.coverage_days / self.window_days if self.window_days else 0.0

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["coverage"] = round(self.coverage, 4)
        return d


def worst(*statuses: str) -> str:
    return max(statuses, key=lambda s: STATUS_ORDER[s])


def _runs(flags: list[bool]) -> list[tuple[int, int]]:
    out, i = [], 0
    while i < len(flags):
        if flags[i]:
            j = i
            while j + 1 < len(flags) and flags[j + 1]:
                j += 1
            out.append((i, j))
            i = j + 1
        else:
            i += 1
    return out


def compute_quality(daily: dict[dt.date, Optional[float]], days: list[dt.date], check_near_zero: bool = True,
                    extra: dict[str, Any] | None = None, min_near_zero_days: int = 1) -> Quality:
    """daily maps date -> value (None or absent = missing). days is the full window, in order.
    min_near_zero_days: shortest near-zero stretch that counts (1 for the M0 rule; Media Cloud uses 2, per
    docs/mediacloud-search-criteria.md section 7)."""
    vals = [daily.get(d) for d in days]
    present = [v is not None for v in vals]
    missing = [d.isoformat() for d, p in zip(days, present) if not p]
    gaps = _runs([not p for p in present])
    longest_gap = max((j - i + 1 for i, j in gaps), default=0)
    coverage_days = sum(present)

    near_zero: list[dict[str, Any]] = []
    nz_days = 0
    clean = [v for v in vals if v is not None]
    if check_near_zero and clean:
        med = statistics.median(clean)
        thr = NEAR_ZERO_FRAC * med
        low = [v is not None and med > 0 and v < thr for v in vals]
        normal = [v is not None and v >= thr for v in vals]
        for i, j in _runs(low):
            # neighbors: nearest present days outside the stretch
            left = next((k for k in range(i - 1, -1, -1) if vals[k] is not None), None)
            right = next((k for k in range(j + 1, len(vals)) if vals[k] is not None), None)
            if j - i + 1 < min_near_zero_days:
                continue
            if (left is not None and normal[left]) or (right is not None and normal[right]):
                near_zero.append({"start": days[i].isoformat(), "end": days[j].isoformat(), "days": j - i + 1,
                                  "values": [vals[k] for k in range(i, j + 1)], "median": med})
                nz_days += j - i + 1

    n = len(days)
    cov = coverage_days / n if n else 0.0
    reasons: list[str] = []
    status = "ok"
    if coverage_days == 0:
        status, reasons = "unusable", ["no data in the window"]
    else:
        if cov < UNUSABLE_COVERAGE:
            status = "unusable"
            reasons.append("coverage %d/%d days (%.0f%%) is under %.0f%%" % (coverage_days, n, 100 * cov, 100 * UNUSABLE_COVERAGE))
        elif cov < OK_COVERAGE:
            status = worst(status, "degraded")
            reasons.append("coverage %d/%d days (%.0f%%) is under %.0f%%" % (coverage_days, n, 100 * cov, 100 * OK_COVERAGE))
        if longest_gap >= DEGRADED_GAP_DAYS:
            status = worst(status, "degraded")
            reasons.append("longest gap is %d days" % longest_gap)
        if near_zero:
            if n and nz_days / n > UNUSABLE_NEAR_ZERO_FRAC:
                status = "unusable"
                reasons.append("%d near-zero days (over %.0f%% of the window)" % (nz_days, 100 * UNUSABLE_NEAR_ZERO_FRAC))
            else:
                status = worst(status, "degraded")
                reasons.append("%d near-zero stretch(es) under %.0f%% of the median" % (len(near_zero), 100 * NEAR_ZERO_FRAC))
    return Quality(coverage_days=coverage_days, window_days=n, missing_days=missing, longest_gap=longest_gap,
                   near_zero=near_zero, status=status, reasons=reasons, extra=dict(extra or {}))
