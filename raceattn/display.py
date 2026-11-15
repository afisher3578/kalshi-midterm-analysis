"""Display series: series.display_daily in the race JSON, one row per date of the race's display window.

The display window (config `display_window`, default election_date - 90 days to election_date + 1 day) is for
charts only. Nothing here feeds the metrics, baselines, quality or series.daily: those stay on the analysis
window. Days inside the analysis window reuse the analysis run's daily values as they are. Days outside it are
read per source from the raw cache, and only the dates that no cached window covers are requested, as one new
segment per run of consecutive missing dates.

A segment's daily values use the same definitions as series.daily, computed on that segment's own pull:
Kalshi close = last close of the UTC day (by end_period_ts), volume = sum of the day's hourly volume; Wikipedia
total = sum over the configured pages, null if any page is missing that day; news = the count-over-time count
(matching stories) per query and collection. Missing values are null, never interpolated or filled with zero.
"""
from __future__ import annotations

import datetime as dt
import os
import re
from typing import Any, Callable

from raceattn.config import Race, Window
from raceattn.connectors.base import Connector
from raceattn.connectors.kalshi import SERIES_PRICE, SERIES_VOLUME
from raceattn.connectors.wikipedia import SERIES_TOTAL
from raceattn.metrics.surprise import daily_kalshi

COL_PRICE = "kalshi_price_close"
COL_VOLUME = "kalshi_volume"
COL_WIKI = "wikipedia_pageviews_total"
SOURCES = ("kalshi", "wikipedia", "news_mediacloud")
LABEL_RE = re.compile(r"^(\d{8})_(\d{8})$")
NOTE = ("Display series for charts only: one row per UTC date of the display window. The metrics, baselines, "
        "quality and series.daily use the analysis window and never read this block. Inside the analysis window "
        "the values are the series.daily values. Outside it each source is read from the raw cache, and dates no "
        "cached window covers are pulled as a new segment (see segments); each segment's daily values use the "
        "series.daily definitions on that segment's own pull: Kalshi close = last close of the UTC day by "
        "end_period_ts, volume = sum of the day's hourly candles (the first day of a segment has no candle ending "
        "at 00:00, the same as the first day of the analysis window); Wikipedia total = sum over the configured "
        "pages, null if any page is missing that day; news/<query>/<collection> = Media Cloud count-over-time "
        "count (matching stories) for that publish date. Null = no data, never interpolated or zero-filled.")


def news_col(query: str, ckey: str) -> str:
    return "news/%s/%s" % (query, ckey)


def gap_days(display: Window, analysis: Window) -> list[dt.date]:
    """Display dates outside the analysis window."""
    return [d for d in display.days() if not analysis.start <= d <= analysis.end]


def cached_windows(conn: Connector, race: Race) -> list[Window]:
    """Windows with a cache directory for this source and race whose every request file is on disk."""
    if conn.cache is None or not hasattr(conn, "cache_paths"):
        return []
    root = os.path.join(conn.cache.root, conn.id, race.race_id)
    out = []
    for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        m = LABEL_RE.match(name)
        if not m:
            continue
        try:
            w = Window(dt.datetime.strptime(m.group(1), "%Y%m%d").date(), dt.datetime.strptime(m.group(2), "%Y%m%d").date())
        except ValueError:
            continue
        paths = conn.cache_paths(race, w) if w.start <= w.end else []
        if paths and all(os.path.isfile(p) for p in paths):
            out.append(w)
    return out


def plan(needed: list[dt.date], cached: list[Window]) -> list[tuple[Window, list[dt.date], bool]]:
    """Cover the needed dates with (request window, dates taken from it, from_cache). A date inside a fully
    cached window is read from it (the window reaching furthest wins); runs of consecutive dates no cached
    window covers become new request windows spanning just those dates."""
    needed = sorted(set(needed))
    out: list[tuple[Window, list[dt.date], bool]] = []
    i = 0
    while i < len(needed):
        d = needed[i]
        hits = [w for w in cached if w.start <= d <= w.end]
        if hits:
            w = max(hits, key=lambda w_: w_.end)
            take = []
            while i < len(needed) and needed[i] <= w.end and (not take or needed[i] == take[-1] + dt.timedelta(days=1)):
                take.append(needed[i])
                i += 1
            out.append((w, take, True))
            continue
        take = [d]
        i += 1
        while (i < len(needed) and needed[i] == take[-1] + dt.timedelta(days=1)
               and not any(w.start <= needed[i] <= w.end for w in cached)):
            take.append(needed[i])
            i += 1
        out.append((Window(take[0], take[-1]), take, False))
    return out


def segment_values(conn: Connector, race: Race, w: Window) -> dict[str, dict[dt.date, Any]]:
    """Daily display values from one pull of `w` (cached reads make no request)."""
    if conn.id == "kalshi":
        rows = conn.fetch(race, w)
        price = sorted((r for r in rows if r.series == SERIES_PRICE), key=lambda r: r.ts_utc)
        vol = {r.ts_utc: r.value for r in rows if r.series == SERIES_VOLUME}
        kd = daily_kalshi((r.ts_utc, r.value, vol.get(r.ts_utc)) for r in price)
        return {COL_PRICE: {d: e["close"] for d, e in kd.items()}, COL_VOLUME: {d: e["volume"] for d, e in kd.items()}}
    if conn.id == "wikipedia":
        return {COL_WIKI: {r.ts_utc.date(): r.value for r in conn.fetch(race, w) if r.series == SERIES_TOTAL}}
    if conn.id == "news_mediacloud":
        return {news_col(n, k): per for (n, k), per in conn.fetch_counts(race, w).items()}
    return {}


def source_columns(conn: Connector, race: Race) -> list[str]:
    if conn.id == "kalshi":
        return [COL_PRICE, COL_VOLUME]
    if conn.id == "wikipedia":
        return [COL_WIKI]
    if conn.id == "news_mediacloud":
        cfg = conn.query_config(race)
        if cfg is None:
            return []
        return [news_col(n, c.key) for n in cfg.queries for c in cfg.configured_collections]
    return []


def analysis_values(days: list[dt.date], cols: dict[str, list]) -> dict[str, dict[dt.date, Any]]:
    """The analysis run's daily columns (series.daily) under display column names."""
    out: dict[str, dict[dt.date, Any]] = {}
    for src, dst in ((SERIES_PRICE, COL_PRICE), (SERIES_VOLUME, COL_VOLUME), (SERIES_TOTAL, COL_WIKI)):
        if src in cols:
            out[dst] = {d: v for d, v in zip(days, cols[src]) if v is not None}
    for s, vals in cols.items():
        parts = s.split("/")
        if parts[0] == "news_mediacloud" and len(parts) == 3:
            out[news_col(parts[1], parts[2])] = {d: v for d, v in zip(days, vals) if v is not None}
    return out


def build(race: Race, connectors: list[Connector], days: list[dt.date], cols: dict[str, list], refresh: bool = False,
          log: Callable[[str], None] = print) -> dict[str, Any]:
    """series.display_daily for the connectors that ran (Kalshi, Wikipedia, Media Cloud with a query file)."""
    display, analysis = race.display_window, race.window
    ddays = display.days()
    gap = gap_days(display, analysis)
    inside = [d for d in ddays if analysis.start <= d <= analysis.end]
    inside_set = set(inside)
    base = analysis_values(days, cols)
    columns: list[str] = []
    values: dict[str, dict[dt.date, Any]] = {}
    segments: list[dict[str, Any]] = []
    news: Any = "not run"
    requests = 0
    for conn in connectors:
        if conn.id not in SOURCES:
            continue
        scols = source_columns(conn, race)
        if not scols:
            continue
        columns += scols
        for c in scols:
            values[c] = {d: v for d, v in base.get(c, {}).items() if d in inside_set}
        if conn.id == "news_mediacloud":
            news = list(scols)
        if inside:
            segments.append({"source": conn.id, "days": {"start": inside[0].isoformat(), "end": inside[-1].isoformat(),
                                                         "n": len(inside)},
                             "from": "analysis run (series.daily values)"})
        cached = [] if refresh else cached_windows(conn, race)
        for w, take, from_cache in plan(gap, cached):
            hits0, fetches0 = conn.cache_hits, conn.fetches
            vals = segment_values(conn, race, w)
            for c in scols:
                m = vals.get(c, {})
                for d in take:
                    if m.get(d) is not None:
                        values[c][d] = m[d]
            made = conn.fetches - fetches0
            requests += made
            segments.append({"source": conn.id, "request_window": {"start": w.start.isoformat(), "end": w.end.isoformat()},
                             "days": {"start": take[0].isoformat(), "end": take[-1].isoformat(), "n": len(take)},
                             "from": "cached window" if from_cache else "new segment",
                             "cache_hits": conn.cache_hits - hits0, "requests": made})
            log("   display %s: %s..%s from %s %s (%d cache hit(s), %d request(s))" % (
                conn.id, take[0], take[-1], "cached window" if from_cache else "new segment", w.label,
                conn.cache_hits - hits0, made))
    rows = [dict([("date", d.isoformat())] + [(c, values[c].get(d)) for c in columns]) for d in ddays]
    coverage = {}
    for c in columns:
        missing = [d.isoformat() for d in ddays if values[c].get(d) is None]
        coverage[c] = {"days_present": len(ddays) - len(missing), "days_total": len(ddays), "missing_days": missing}
    log("   display_daily %s..%s: %d day(s), %d column(s), %d request(s) made" % (
        display.start, display.end, len(ddays), len(columns), requests))
    return {
        "window": {"start": display.start.isoformat(), "end": display.end.isoformat(), "days": len(ddays),
                   "inclusive": True, "timezone": "UTC",
                   "source": "race config" if race.display_window_set else "default from election_date"},
        "analysis_window": {"start": analysis.start.isoformat(), "end": analysis.end.isoformat()},
        "columns": ["date"] + columns,
        "rows": rows,
        "news": news,
        "coverage": coverage,
        "segments": segments,
        "requests_made": requests,
        "note": NOTE,
    }
