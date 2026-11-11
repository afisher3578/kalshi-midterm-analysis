"""Event windows, excess attention and reversion (spec section 8). Daily series only.

Definitions (also in README and docs/m2-notes.md):
- Events come from config/events/<race>.csv. Only rows with status `confirmed` are used. Rows marked
  `needs_review` (what the generator writes) are ignored, and the output says how many were ignored.
- Event window: days -k..+k around each confirmed event (k = window_days, default 2). For each offset the output
  has the mean attention surprise, mean Kalshi volume surprise, mean absolute and mean signed daily price change,
  each with its n (number of events with a value at that offset).
- Spike: a day whose attention surprise is >= spike_threshold (default 1.0: about 2.7 times the trailing 7-day
  mean, after the +1 in the surprise formula).
- Excess attention: a spike with no confirmed event within +-k days. With no confirmed events the output says
  "no confirmed events" instead of a number, because an unreviewed list cannot tell explained from excess.
- Reversion: for a spike on day t, move = close[t] - close[t-1]. If |move| >= min_price_move, the reversal
  fraction is -(close[t+N] - close[t]) / move with N = reversion_days (default 3). The spike "reverted" if that
  fraction is >= reversion_fraction (default 0.5, i.e. at least half of the spike-day move undone within N days).
Excluded days (election night) are masked before any of this, so a window touching them loses those offsets.
"""
from __future__ import annotations

import csv
import datetime as dt
import os
from typing import Any, Optional, Sequence

from raceattn.metrics.surprise import apply_mask, price_changes, surprise

Num = Optional[float]
EVENT_COLUMNS = ["date_utc", "type", "source_url", "note", "status"]
NO_CONFIRMED = "no confirmed events"


def load_events(path: str) -> dict[str, Any]:
    """Read an events CSV. Returns confirmed events, the count of rows needing review and any problems."""
    out: dict[str, Any] = {"path": path, "exists": os.path.isfile(path), "confirmed": [], "needs_review": 0,
                           "other_status": 0, "problems": []}
    if not out["exists"]:
        return out
    with open(path, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        missing = [c for c in EVENT_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            out["problems"].append("missing columns: %s" % ", ".join(missing))
            return out
        for i, row in enumerate(reader, 2):
            status = (row.get("status") or "").strip()
            if status == "needs_review":
                out["needs_review"] += 1
                continue
            if status != "confirmed":
                out["other_status"] += 1
                out["problems"].append("line %d: status %r is not confirmed or needs_review; ignored" % (i, status))
                continue
            try:
                d = dt.date.fromisoformat((row["date_utc"] or "").strip()[:10])
            except ValueError:
                out["problems"].append("line %d: bad date_utc %r; ignored" % (i, row["date_utc"]))
                continue
            out["confirmed"].append({"date": d, "type": row["type"], "source_url": row["source_url"]})
    return out


def _mean(vals: Sequence[Num]) -> tuple[Num, int]:
    v = [x for x in vals if x is not None]
    return (round(sum(v) / len(v), 6) if v else None), len(v)


def series_for_events(att: Sequence[Num], close: Sequence[Num], volume: Sequence[Num], keep: Sequence[bool]):
    signed, absolute = price_changes(close)
    return {"attention_surprise": apply_mask(surprise(att), keep),
            "volume_surprise": apply_mask(surprise(volume), keep),
            "abs_price_change": apply_mask(absolute, keep),
            "price_change": apply_mask(signed, keep)}


def event_windows(days: list[dt.date], s: dict[str, list[Num]], events: list[dt.date], k: int) -> dict[str, Any]:
    idx = {d: i for i, d in enumerate(days)}
    inside = [e for e in events if e in idx]
    offsets: dict[str, Any] = {}
    for off in range(-k, k + 1):
        cell = {}
        for name, vals in s.items():
            m, n = _mean([vals[idx[e] + off] if 0 <= idx[e] + off < len(days) else None for e in inside])
            cell[name] = {"mean": m, "n": n}
        offsets[str(off)] = cell
    return {"status": "computed", "k": k, "n_events": len(inside), "events_outside_window": len(events) - len(inside),
            "event_dates": [e.isoformat() for e in inside], "offsets": offsets}


def spikes(days: list[dt.date], att_surprise: Sequence[Num], threshold: float) -> list[int]:
    return [i for i, v in enumerate(att_surprise) if v is not None and v >= threshold]


def reversion(days, close: Sequence[Num], spike_idx: list[int], n_days: int, frac: float, min_move: float):
    items = []
    for i in spike_idx:
        item: dict[str, Any] = {"date": days[i].isoformat()}
        a = close[i - 1] if i >= 1 else None
        b = close[i]
        c = close[i + n_days] if i + n_days < len(close) else None
        if a is None or b is None or c is None:
            item.update(status="insufficient data", reason="price missing on t-1, t or t+%d" % n_days)
        elif abs(b - a) < min_move:
            item.update(status="no move", move=round(b - a, 6))
        else:
            f = -(c - b) / (b - a)
            item.update(status="computed", move=round(b - a, 6), later_change=round(c - b, 6),
                        reversal_fraction=round(f, 4), reverted=f >= frac)
        items.append(item)
    comp = [x for x in items if x["status"] == "computed"]
    rev = [x for x in comp if x["reverted"]]
    return {"n_spikes": len(items), "n": len(comp), "n_no_move": sum(1 for x in items if x["status"] == "no move"),
            "n_insufficient": sum(1 for x in items if x["status"] == "insufficient data"),
            "n_reverted": len(rev), "share_reverted": round(len(rev) / len(comp), 4) if comp else None,
            "mean_reversal_fraction": _mean([x["reversal_fraction"] for x in comp])[0], "spikes": items}


def event_metrics(days: list[dt.date], keep: list[bool], att: Sequence[Num], close: Sequence[Num],
                  volume: Sequence[Num], events: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    k = int(settings["window_days"])
    thr = float(settings["spike_threshold"])
    s = series_for_events(att, close, volume, keep)
    masked_close = apply_mask(close, keep)
    confirmed = [e["date"] for e in events["confirmed"]]
    sp = spikes(days, s["attention_surprise"], thr)
    out: dict[str, Any] = {
        "settings": {"window_days": k, "spike_threshold": thr, "reversion_days": settings["reversion_days"],
                     "reversion_fraction": settings["reversion_fraction"],
                     "min_price_move": settings["min_price_move"]},
        "spikes": {"n": len(sp), "dates": [days[i].isoformat() for i in sp],
                   "surprise": [round(s["attention_surprise"][i], 4) for i in sp]},
        "reversion": reversion(days, masked_close, sp, int(settings["reversion_days"]),
                               float(settings["reversion_fraction"]), float(settings["min_price_move"])),
    }
    if not confirmed:
        out["event_windows"] = {"status": NO_CONFIRMED}
        out["excess_attention"] = {"status": NO_CONFIRMED}
        return out
    out["event_windows"] = event_windows(days, s, confirmed, k)
    near = set()
    for e in confirmed:
        for off in range(-k, k + 1):
            near.add(e + dt.timedelta(days=off))
    excess = [i for i in sp if days[i] not in near]
    out["excess_attention"] = {"status": "computed", "n": len(excess), "n_spikes": len(sp),
                               "share_of_spikes": round(len(excess) / len(sp), 4) if sp else None,
                               "dates": [days[i].isoformat() for i in excess]}
    rv = reversion(days, masked_close, excess, int(settings["reversion_days"]), float(settings["reversion_fraction"]),
                   float(settings["min_price_move"]))
    out["reversion_excess_only"] = rv
    return out
