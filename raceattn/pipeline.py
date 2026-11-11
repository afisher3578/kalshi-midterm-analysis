"""Run connectors for one race, align on one UTC clock, compute metrics, write processed JSON."""
from __future__ import annotations

import datetime as dt
import json
import os
from typing import Any, Callable

from raceattn import PROJECT_NAME, __version__
from raceattn.cache import Cache
from raceattn.config import Race
from raceattn.connectors import REGISTRY
from raceattn.connectors.base import Connector, Row, iso_utc, now_utc
from raceattn.connectors.kalshi import SERIES_PRICE, SERIES_VOLUME
from raceattn.connectors.wikipedia import SERIES_TOTAL
from raceattn.http import HttpClient
from raceattn.metrics.lags import (DAILY_LAGS, HOURLY_LAGS, MIN_PAIRS, attention_lag_table, noise_band,
                                   pilot_noise_band)
from raceattn.metrics.quality import Quality, worst
from raceattn.metrics.surprise import daily_kalshi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_RAW = os.path.join(ROOT, "data", "raw")
DEFAULT_OUT = os.path.join(ROOT, "data", "processed")
HEADLINE_ATTENTION = SERIES_TOTAL
NOISE_NOTE = ("Rough noise band is 2/sqrt(n). Daily series are autocorrelated, so the effective n is smaller "
              "and this band is generous. Timing and association only, not causation.")
OUTCOME_SERIES = {"volume_surprise": SERIES_VOLUME, "abs_price_change": SERIES_PRICE, "price_change": SERIES_PRICE}


class PipelineError(RuntimeError):
    pass


class CostGuardError(PipelineError):
    pass


def make_connectors(sources: list[str], http: HttpClient, cache: Cache, refresh: bool) -> list[Connector]:
    out = []
    for s in sources:
        if s not in REGISTRY:
            raise PipelineError("unknown source %r. Available in this build: %s" % (s, ", ".join(sorted(REGISTRY))))
        out.append(REGISTRY[s](http=http, cache=cache, refresh=refresh))
    return out


def cost_guard(connectors: list[Connector], race: Race, yes: bool, max_spend: float | None,
               log: Callable[[str], None]) -> None:
    """Paid connectors print an estimate and need --yes or --max-spend before any pull."""
    for c in connectors:
        if c.cost_model == "free":
            continue
        est = c.estimate_cost(race)
        log("cost estimate for %s: about $%.2f over %d requests (%s)" % (c.id, est.usd, est.requests, c.cost_model))
        if yes:
            continue
        if max_spend is None:
            raise CostGuardError("%s is a paid source (%s). Re-run with --yes or --max-spend <usd>." % (c.id, c.cost_model))
        if est.usd > max_spend:
            raise CostGuardError("%s estimate $%.2f is over --max-spend $%.2f" % (c.id, est.usd, max_spend))


def _round(v, nd=6):
    return None if v is None else round(v, nd)


def daily_metrics(race: Race, days: list[dt.date], daily_cols: dict[str, list], quality: dict[str, Quality],
                  series_hash: dict[str, str], attention: list[str]) -> dict[str, Any]:
    keep = [d not in race.exclude_days for d in days]
    n_kept = sum(keep)
    out: dict[str, Any] = {}
    kalshi_bad = [s for s in (SERIES_PRICE, SERIES_VOLUME) if s not in quality or quality[s].status == "unusable"]
    for name in attention:
        entry: dict[str, Any] = {"attention_series": name, "granularity": "day", "lags": list(DAILY_LAGS),
                                 "min_pairs": MIN_PAIRS, "query_hash": series_hash.get(name)}
        q = quality.get(name)
        if q is None or q.status == "unusable":
            entry.update(status="skipped", reason="attention series %s is unusable: %s" % (
                name, "; ".join(q.reasons) if q else "no data"))
            out[name] = entry
            continue
        if kalshi_bad:
            entry.update(status="skipped", reason="Kalshi series unusable or missing: %s" % ", ".join(kalshi_bad))
            out[name] = entry
            continue
        table = attention_lag_table(daily_cols[name], daily_cols[SERIES_PRICE], daily_cols[SERIES_VOLUME], keep,
                                    step=1, lags=DAILY_LAGS)
        max_n = 0
        for oname, cells in table.items():
            oseries = OUTCOME_SERIES[oname]
            for cell in cells.values():
                cell["quality_status"] = worst(q.status, quality[oseries].status)
                cell["query_hash"] = {"attention": series_hash.get(name), "outcome": series_hash.get(oseries)}
                max_n = max(max_n, cell["n"])
        entry.update(status="computed", quality_status=q.status, outcomes=table,
                     noise_band=_round(noise_band(max_n), 4), noise_band_n=max_n,
                     noise_band_pilot=_round(pilot_noise_band(n_kept), 4), n_days_not_excluded=n_kept,
                     note=NOISE_NOTE)
        out[name] = entry
    return out


def hourly_metrics(hourly_attention: dict[str, list], hours: list[dt.datetime], close: list, volume: list,
                   race: Race) -> dict[str, Any]:
    """Hourly path (step 24, lags -3..+3 hours). No hourly attention source exists in M0."""
    keep = [h.date() not in race.exclude_days for h in hours]
    return {name: {"attention_series": name, "granularity": "hour", "lags": list(HOURLY_LAGS), "status": "computed",
                   "outcomes": attention_lag_table(vals, close, volume, keep, step=24, lags=HOURLY_LAGS)}
            for name, vals in hourly_attention.items()}


def run(race: Race, sources: list[str], raw_dir: str = DEFAULT_RAW, out_dir: str = DEFAULT_OUT,
        refresh: bool = False, yes: bool = False, max_spend: float | None = None, http: HttpClient | None = None,
        log: Callable[[str], None] = print, write: bool = True) -> dict[str, Any]:
    window = race.window
    days = window.days()
    http = http or HttpClient()
    cache = Cache(raw_dir)
    connectors = make_connectors(sources, http, cache, refresh)
    cost_guard(connectors, race, yes, max_spend, log)

    rows: list[Row] = []
    queries: dict[str, Any] = {}
    quality: dict[str, Quality] = {}
    series_hash: dict[str, str] = {}
    series_meta: dict[str, Any] = {}
    for c in connectors:
        summary = c.query_summary(race, window)
        queries[c.id] = summary
        series_hash.update(summary["series_query_hash"])
        log("== %s: %d request(s), query hash %s" % (c.id, len(summary["queries"]), summary["query_hash"]))
        crows = c.fetch(race, window)
        log("   %d rows (%d from cache, %d fetched)" % (len(crows), c.cache_hits, c.fetches))
        rows.extend(crows)
        for name, q in c.quality(crows, window).items():
            quality[name] = q
            log("   quality %-55s %-9s %d/%d days%s" % (name, q.status, q.coverage_days, q.window_days,
                                                         (" (" + "; ".join(q.reasons) + ")") if q.reasons else ""))
        for r in crows:
            series_meta.setdefault(r.series, {"source": r.source, "granularity": r.granularity, "unit": r.unit,
                                              "query_hash": r.query_hash, "fetched_at": r.fetched_at})

    by_series: dict[str, list[Row]] = {}
    for r in rows:
        by_series.setdefault(r.series, []).append(r)

    # hourly Kalshi
    price = sorted(by_series.get(SERIES_PRICE, []), key=lambda r: r.ts_utc)
    vol = {r.ts_utc: r.value for r in by_series.get(SERIES_VOLUME, [])}
    hourly_rows = [[iso_utc(r.ts_utc), r.value, vol.get(r.ts_utc)] for r in price]
    kd = daily_kalshi((r.ts_utc, r.value, vol.get(r.ts_utc)) for r in price)

    # daily aligned table on the window's dates
    attention_daily = [s for s, m in series_meta.items() if m["granularity"] == "day"]
    attention_daily.sort(key=lambda s: (s != HEADLINE_ATTENTION, s))
    cols: dict[str, list] = {SERIES_PRICE: [kd.get(d, {}).get("close") for d in days],
                             SERIES_VOLUME: [kd.get(d, {}).get("volume") for d in days]}
    for s in attention_daily:
        m = {r.ts_utc.date(): r.value for r in by_series[s]}
        cols[s] = [m.get(d) for d in days]
    for s, q in quality.items():  # a series with no rows at all still gets a column of nulls
        if s not in cols and s.startswith("wikipedia/"):
            cols[s] = [None] * len(days)
            attention_daily.append(s)
    daily_columns = ["date", "excluded"] + list(cols)
    daily_rows = [[d.isoformat(), d in race.exclude_days] + [cols[c][i] for c in cols] for i, d in enumerate(days)]

    notes = []
    if "kalshi" in sources:
        metrics_daily = daily_metrics(race, days, cols, quality, series_hash, attention_daily)
    else:
        metrics_daily = {}
        notes.append("kalshi not in --sources, so no outcome series and no metrics")
    metrics = {"daily": metrics_daily, "hourly": {},
               "hourly_note": "no hourly attention source in M0; the hourly path (step 24, lags -3..+3 h) is "
                              "implemented and unit tested"}
    for name, entry in metrics_daily.items():
        if entry["status"] == "skipped":
            log("   metrics skipped for %s: %s" % (name, entry["reason"]))

    result = {
        "project": PROJECT_NAME, "version": __version__, "schema_version": 1, "generated_at": now_utc(),
        "race": race.summary(),
        "window": {"start": window.start.isoformat(), "end": window.end.isoformat(), "days": window.n_days,
                   "inclusive": True, "timezone": "UTC"},
        "excluded_days": [d.isoformat() for d in race.exclude_days],
        "sources": list(sources),
        "queries": queries,
        "series": {
            "meta": series_meta,
            "hourly": {"columns": ["ts_utc", SERIES_PRICE, SERIES_VOLUME], "rows": hourly_rows,
                       "note": "ts_utc is the candle end_period_ts; price forward-filled for hours with no trades"},
            "daily": {"columns": daily_columns, "rows": daily_rows,
                      "note": "Kalshi daily: volume = sum of hourly candles by UTC date of end_period_ts, "
                              "close = last close of the day. Attention values are never interpolated."},
        },
        "quality": {k: v.to_dict() for k, v in sorted(quality.items())},
        "metrics": metrics,
        "notes": notes,
    }
    print_tables(result, log)
    if write:
        write_outputs(result, out_dir)
    return result


def print_tables(result: dict[str, Any], log: Callable[[str], None]) -> None:
    for name, entry in result["metrics"]["daily"].items():
        if entry["status"] != "computed":
            continue
        log("DAILY %s surprise vs outcomes (lag>0: outcome after attention)" % name)
        for oname, cells in entry["outcomes"].items():
            log("  %-17s %s" % (oname, "  ".join(
                "lag%+d=%s(n%d)" % (int(k), ("%.2f" % c["rho"]) if c["rho"] is not None else "NA", c["n"])
                for k, c in cells.items())))
        log("  noise band ~ +-%.2f (2/sqrt(%d)); pilot formula 2/sqrt(max(n-7,1)) with n=%d days gives %.2f. %s"
            % (entry["noise_band"], entry["noise_band_n"], entry["n_days_not_excluded"], entry["noise_band_pilot"],
               "Daily series are autocorrelated, so this is generous."))


def headline(result: dict[str, Any]) -> dict[str, Any]:
    entry = result["metrics"]["daily"].get(HEADLINE_ATTENTION)
    h: dict[str, Any] = {"attention_series": HEADLINE_ATTENTION, "outcome": "volume_surprise"}
    if not entry or entry["status"] != "computed":
        h.update(status="insufficient data", reason=(entry or {}).get("reason", "not computed"))
        return h
    cells = entry["outcomes"]["volume_surprise"]
    h.update(status="computed", quality_status=entry["quality_status"], noise_band=entry["noise_band"],
             lags={k: {"rho": c["rho"], "n": c["n"]} for k, c in cells.items()})
    return h


def write_outputs(result: dict[str, Any], out_dir: str) -> tuple[str, str]:
    os.makedirs(out_dir, exist_ok=True)
    rid = result["race"]["race_id"]
    path = os.path.join(out_dir, rid + ".json")
    _dump(path, result)
    idx_path = os.path.join(out_dir, "index.json")
    idx = {"project": PROJECT_NAME, "races": {}}
    if os.path.isfile(idx_path):
        with open(idx_path, encoding="utf-8") as f:
            idx = json.load(f)
        idx.setdefault("races", {})
    r = result["race"]
    k = [d["kalshi"] for d in [r]][0]
    idx["races"][rid] = {
        "race_id": rid, "state": r["state"], "office": r["office"], "election_date": r["election_date"],
        "followed_market": k["followed_market"], "window": result["window"], "path": rid + ".json",
        "generated_at": result["generated_at"], "sources": result["sources"],
        "quality": {s: q["status"] for s, q in result["quality"].items()},
        "headline": headline(result),
    }
    idx["project"] = PROJECT_NAME
    idx["updated_at"] = result["generated_at"]
    idx["races"] = dict(sorted(idx["races"].items()))
    _dump(idx_path, idx)
    return path, idx_path


def _dump(path: str, obj: Any) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1)
        f.write("\n")
    os.replace(tmp, path)
