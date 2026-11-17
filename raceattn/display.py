"""Display series: series.display_daily in the race JSON, one row per date of the race's display window, and
series.display_hourly, the hourly Kalshi candles for the same window (see build_hourly).

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


# -- series.display_hourly: hourly Kalshi for the display window, charts only

HOURLY_COLUMNS = ["ts_utc", SERIES_PRICE, SERIES_VOLUME]  # the series.hourly columns
HOURLY_NOTE = ("Hourly Kalshi for charts only: one row per hour of the display window, from display start 00:00 UTC "
               "to the market's last candle. ts_utc is the candle end_period_ts. Inside the analysis window the "
               "values are the series.hourly values; outside it they are read from the raw cache (see segments). "
               "An hour with no candle gets the previous hour's close and volume 0 (counted in filled_hours). "
               "An hour whose candle has a null price (that pull had no earlier close) gets the previous hour's "
               "close and keeps its volume (counted in forward_filled_null_price); series.hourly keeps the null. "
               "Only leading hours with no earlier close anywhere stay null (null_price_hours). "
               "Kalshi only: news and Wikipedia stay daily, never hourly. The metrics never read this block.")
GRANULARITY_NOTE = ("Kalshi has hourly candles (series.hourly, series.display_hourly) and daily rows. Wikipedia "
                    "pageviews and Media Cloud counts are daily only; Media Cloud publish dates carry no time of "
                    "day, so there are no hourly news values.")


def _parse_ts(s: str) -> dt.datetime:
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def _iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def granularity(series: dict[str, Any]) -> dict[str, Any]:
    """series.granularity: the sources with data in this race JSON and their time resolution."""
    daily_cols = (series.get("daily") or {}).get("columns") or []
    out: dict[str, Any] = {}
    if (series.get("hourly") or {}).get("rows") or any(c.startswith("kalshi/") for c in daily_cols):
        out["kalshi"] = "hourly and daily"
    if any(c.startswith("news_mediacloud/") for c in daily_cols):
        out["news_mediacloud"] = "daily"
    if any(c.startswith("wikipedia/") for c in daily_cols):
        out["wikipedia"] = "daily"
    out["note"] = GRANULARITY_NOTE
    return out


def reconcile(rows: list[list], daily: dict[str, Any] | None) -> dict[str, Any]:
    """Hourly rows against series.display_daily: per UTC date of ts_utc, the sum of hourly volume against the
    daily volume (abs diff > 1e-6 is a mismatch) and the last hourly price against the daily close (exact after
    rounding to 6 places). Every mismatch is listed."""
    by_day: dict[str, list[list]] = {}
    for r in rows:
        by_day.setdefault(r[0][:10], []).append(r)
    drows = {r["date"]: r for r in (daily or {}).get("rows") or []}
    vol_mm, close_mm, null_days, no_hours = [], [], [], []
    checked = 0
    for date in sorted(drows):
        dr = drows[date]
        hrs = by_day.get(date)
        dv, dc = dr.get(COL_VOLUME), dr.get(COL_PRICE)
        if dv is None or dc is None:
            null_days.append(date)
        if not hrs:
            if dv is not None or dc is not None:
                no_hours.append(date)
            continue
        checked += 1
        hsum = sum(r[2] or 0.0 for r in hrs)
        if dv is not None and abs(hsum - dv) > 1e-6:
            vol_mm.append({"date": date, "hourly_sum": hsum, "daily": dv})
        hlast = hrs[-1][1]
        if dc is not None and (hlast is None or round(hlast, 6) != round(dc, 6)):
            close_mm.append({"date": date, "hourly_last": hlast, "daily": dc})
    out = {"days_checked": checked, "volume_mismatches": vol_mm, "close_mismatches": close_mm,
           "daily_null_days": null_days,
           "status": "mismatch" if vol_mm or close_mm or no_hours or not drows else "match"}
    if no_hours:
        out["days_without_hourly_rows"] = no_hours
    if not drows:
        out["note"] = "no series.display_daily rows to compare against"
    return out


def build_hourly(race: Race, kalshi_conn: Connector, hourly_rows: list[list], refresh: bool = False,
                 log: Callable[[str], None] = print, daily: dict[str, Any] | None = None) -> dict[str, Any]:
    """series.display_hourly: hourly Kalshi on a full grid of display window hours. `hourly_rows` are the
    series.hourly rows of the analysis run; `daily` is series.display_daily for the reconciliation."""
    display, analysis = race.display_window, race.window
    first_date, last_date = display.start, display.end
    # analysis rows first: on a shared ts the analysis value wins
    by_ts: dict[dt.datetime, list] = {}
    for ts, price, vol in hourly_rows:
        t = _parse_ts(ts)
        if first_date <= t.date() <= last_date:
            by_ts.setdefault(t, [price, vol])
    segments: list[dict[str, Any]] = []
    inside = [d for d in display.days() if analysis.start <= d <= analysis.end]
    if inside:
        segments.append({"source": kalshi_conn.id, "days": {"start": inside[0].isoformat(), "end": inside[-1].isoformat(),
                                                            "n": len(inside)},
                         "from": "analysis run (series.hourly values)", "hours": len(by_ts)})
    requests = 0
    overlap = 0
    cached = [] if refresh else cached_windows(kalshi_conn, race)
    for w, take, from_cache in plan(gap_days(display, analysis), cached):
        hits0, fetches0 = kalshi_conn.cache_hits, kalshi_conn.fetches
        rows = kalshi_conn.fetch(race, w)
        vol = {r.ts_utc: r.value for r in rows if r.series == SERIES_VOLUME}
        take_set = set(take)
        used = 0
        for r in rows:
            if r.series != SERIES_PRICE:
                continue
            if r.ts_utc in by_ts:  # chunk or segment edge: the analysis value wins
                overlap += 1
                continue
            if r.ts_utc.date() not in take_set:
                continue
            by_ts[r.ts_utc] = [r.value, vol.get(r.ts_utc)]
            used += 1
        made = kalshi_conn.fetches - fetches0
        requests += made
        segments.append({"source": kalshi_conn.id, "request_window": {"start": w.start.isoformat(), "end": w.end.isoformat()},
                         "days": {"start": take[0].isoformat(), "end": take[-1].isoformat(), "n": len(take)},
                         "from": "cached window" if from_cache else "new segment", "hours": used,
                         "cache_hits": kalshi_conn.cache_hits - hits0, "requests": made})
        log("   display_hourly %s: %s..%s from %s %s (%d cache hit(s), %d request(s))" % (
            kalshi_conn.id, take[0], take[-1], "cached window" if from_cache else "new segment", w.label,
            kalshi_conn.cache_hits - hits0, made))
    # full hourly grid from display start 00:00 to the last candle; no hours invented after it
    out_rows: list[list] = []
    filled: list[str] = []
    null_price: list[str] = []
    ffill_null: list[str] = []
    if by_ts:
        t, last_t = display.start_dt, max(by_ts)
        prev = None
        while t <= last_t:
            if t in by_ts:
                price, v = by_ts[t]
                if price is None and prev is not None:  # candle without a close in its own pull
                    price = prev
                    ffill_null.append(_iso(t))
            else:
                price, v = prev, 0.0
                filled.append(_iso(t))
            if price is None:
                null_price.append(_iso(t))
            out_rows.append([_iso(t), price, v])
            prev = price
            t += dt.timedelta(hours=1)
    rec = reconcile(out_rows, daily)
    log("   display_hourly %s..%s: %d hour(s), %d filled, %d null price filled, %d request(s) made, "
        "reconciliation %s" % (out_rows[0][0] if out_rows else "-", out_rows[-1][0] if out_rows else "-",
                               len(out_rows), len(filled), len(ffill_null), requests, rec["status"]))
    return {
        "window": {"start": display.start.isoformat(), "end": display.end.isoformat(), "days": display.n_days,
                   "inclusive": True, "timezone": "UTC",
                   "source": "race config" if race.display_window_set else "default from election_date"},
        "analysis_window": {"start": analysis.start.isoformat(), "end": analysis.end.isoformat()},
        "columns": list(HOURLY_COLUMNS),
        "rows": out_rows,
        "first_ts": out_rows[0][0] if out_rows else None,
        "last_ts": out_rows[-1][0] if out_rows else None,
        "n_rows": len(out_rows),
        "filled_hours": {"n": len(filled), "hours": filled,
                         "rule": "no candle for that hour: price forward-filled from the previous hour, volume 0"},
        "forward_filled_null_price": {"n": len(ffill_null), "hours": ffill_null,
                                      "rule": "candle with a null price (its pull had no earlier close): price "
                                              "forward-filled from the previous hour, volume kept"},
        "null_price_hours": {"n": len(null_price), "hours": null_price,
                             "rule": "no close known yet at that hour (no earlier candle with a price)"},
        "overlap_dropped": {"n": overlap, "rule": "segment candles at a ts the analysis run already has; the "
                                                  "analysis value is kept"},
        "segments": segments,
        "requests_made": requests,
        "reconciliation": rec,
        "note": HOURLY_NOTE,
    }


def patch_processed(race: Race, path: str, kalshi_conn: Connector, refresh: bool = False,
                    log: Callable[[str], None] = print) -> dict[str, Any]:
    """Add series.display_hourly and series.granularity to an existing processed race JSON, in place. Built from
    the file's own series.hourly and series.display_daily plus the raw cache; every other key is left as it is."""
    import json

    from raceattn.pipeline import _dump

    with open(path, encoding="utf-8") as f:
        result = json.load(f)
    series = result["series"]
    w = result.get("window") or {}
    if (w.get("start"), w.get("end")) != (race.window.start.isoformat(), race.window.end.isoformat()):
        raise ValueError("%s: analysis window %s..%s does not match the race config %s..%s; re-run the pipeline" % (
            path, w.get("start"), w.get("end"), race.window.start, race.window.end))
    if series.get("hourly", {}).get("columns") != HOURLY_COLUMNS:
        raise ValueError("%s: series.hourly columns are %r, expected %r" % (
            path, series.get("hourly", {}).get("columns"), HOURLY_COLUMNS))
    size_before = os.path.getsize(path)
    series["display_hourly"] = build_hourly(race, kalshi_conn, series["hourly"]["rows"], refresh=refresh, log=log,
                                            daily=series.get("display_daily"))
    series["granularity"] = granularity(series)
    _dump(path, result)
    return {"block": series["display_hourly"], "granularity": series["granularity"], "size_before": size_before,
            "size_after": os.path.getsize(path)}


# the news column the dashboard charts and maps (race_either, national), as web/src/display.ts NEWS_COL
COL_NEWS_HEADLINE = news_col("race_either", "national")
TOTALS_NOTE = ("Totals over the display window from series.display_daily, for the dashboard map: the sum of the "
               "non-null days and n_days, the days with a value. A column the race does not have is left out.")


def display_totals(display_daily: dict[str, Any] | None) -> dict[str, Any] | None:
    """Per-column totals of series.display_daily (Kalshi volume, Wikipedia total, the headline news count), each
    with n_days. None when the race has no display_daily."""
    if not display_daily:
        return None
    cols = display_daily.get("columns") or []
    out: dict[str, Any] = {"window": {k: display_daily["window"].get(k) for k in ("start", "end", "days")},
                           "note": TOTALS_NOTE}
    for c in (COL_VOLUME, COL_WIKI, COL_NEWS_HEADLINE):
        if c not in cols:
            continue
        vals = [r.get(c) for r in display_daily.get("rows") or []]
        vals = [v for v in vals if v is not None]
        out[c] = {"total": round(sum(vals), 4) if vals else None, "n_days": len(vals)}
    return out


def refresh_index_totals(out_dir: str) -> dict[str, Any]:
    """Set index.json races[*].display from each processed race JSON's series.display_daily, in place. Every other
    key of the index is left as it is. Returns the new display blocks by race id."""
    import json

    from raceattn.pipeline import _dump

    idx_path = os.path.join(out_dir, "index.json")
    with open(idx_path, encoding="utf-8") as f:
        idx = json.load(f)
    done: dict[str, Any] = {}
    for rid, entry in idx.get("races", {}).items():
        path = os.path.join(out_dir, rid + ".json")
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            res = json.load(f)
        entry["display"] = display_totals((res.get("series") or {}).get("display_daily"))
        done[rid] = entry["display"]
    _dump(idx_path, idx)
    return done
