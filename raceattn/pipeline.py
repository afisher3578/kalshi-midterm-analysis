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
from raceattn.connectors.kalshi import SERIES_PRICE, SERIES_SMALL_TRADE_SHARE, SERIES_TRADE_COUNT, SERIES_VOLUME
from raceattn.connectors.wikipedia import SERIES_TOTAL
from raceattn.display import display_totals
from raceattn.http import HttpClient
from raceattn.metrics.events import event_metrics, load_events
from raceattn.metrics.lags import (DAILY_LAGS, HOURLY_LAGS, MIN_PAIRS, attention_lag_table, noise_band,
                                   pilot_noise_band)
from raceattn.metrics.quality import Quality, worst
from raceattn.metrics.surprise import daily_kalshi
from raceattn.settings import load_settings

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_RAW = os.path.join(ROOT, "data", "raw")
DEFAULT_OUT = os.path.join(ROOT, "data", "processed")
EVENTS_DIR = os.path.join(ROOT, "config", "events")
# sources whose terms on publishing aggregate counts are not confirmed (docs/licensing.md)
LICENSED_SOURCES = ("x", "bluesky", "reddit", "news_mediacloud", "news_guardian", "news_nyt", "gdelt")
LICENSING_WARNING = ("LICENSING WARNING: this output contains aggregate counts from %s. Whether their terms allow "
                     "publishing even aggregate counts is not confirmed (see docs/licensing.md). Do not publish "
                     "until Alex sets licensing_confirmed: true in config/project.yaml.")
HEADLINE_ATTENTION = SERIES_TOTAL
NOISE_NOTE = ("Rough noise band is 2/sqrt(n). Daily series are autocorrelated, so the effective n is smaller "
              "and this band is generous. Timing and association only, not causation.")
OUTCOME_SERIES = {"volume_surprise": SERIES_VOLUME, "abs_price_change": SERIES_PRICE, "price_change": SERIES_PRICE}


class PipelineError(RuntimeError):
    pass


class CostGuardError(PipelineError):
    pass


def make_connectors(sources: list[str], http: HttpClient, cache: Cache, refresh: bool,
                    settings: dict[str, Any] | None = None, env: dict[str, str] | None = None) -> list[Connector]:
    out = []
    conf = (settings or {}).get("connectors") or {}
    for s in sources:
        if s not in REGISTRY:
            raise PipelineError("unknown source %r. Available in this build: %s" % (s, ", ".join(sorted(REGISTRY))))
        out.append(REGISTRY[s](http=http, cache=cache, refresh=refresh, env=env, **(conf.get(s) or {})))
    return out


def cost_guard(connectors: list[Connector], race: Race, yes: bool, max_spend: float | None,
               log: Callable[[str], None]) -> None:
    """Paid connectors print an estimate and need --yes or --max-spend before any pull."""
    for c in connectors:
        if c.cost_model == "free":
            continue
        est = c.estimate_cost(race)
        log("cost estimate for %s: about $%.2f over %d requests (%s)%s" % (
            c.id, est.usd, est.requests, c.cost_model, (". " + est.note) if est.note else ""))
        if yes:
            continue
        if est.requests == 0:
            log("   %s: every paid read is already cached; nothing will be pulled" % c.id)
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


def hourly_metrics(race: Race, hours: list[dt.datetime], cols: dict[str, list], quality: dict[str, Quality],
                   series_hash: dict[str, str], attention: list[str]) -> dict[str, Any]:
    """Hourly path: attention surprise (same hour on the previous 7 days, step 24) vs the Kalshi outcomes at
    lags -3..+3 hours. `hours` are hour-end timestamps, matching Kalshi's end_period_ts."""
    keep = [(h - dt.timedelta(hours=1)).date() not in race.exclude_days for h in hours]
    out: dict[str, Any] = {}
    kalshi_bad = [s for s in (SERIES_PRICE, SERIES_VOLUME) if s not in quality or quality[s].status == "unusable"]
    for name in attention:
        entry: dict[str, Any] = {"attention_series": name, "granularity": "hour", "lags": list(HOURLY_LAGS),
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
        table = attention_lag_table(cols[name], cols[SERIES_PRICE], cols[SERIES_VOLUME], keep, step=24,
                                    lags=HOURLY_LAGS)
        max_n = 0
        for oname, cells in table.items():
            oseries = OUTCOME_SERIES[oname]
            for cell in cells.values():
                cell["quality_status"] = worst(q.status, quality[oseries].status)
                cell["query_hash"] = {"attention": series_hash.get(name), "outcome": series_hash.get(oseries)}
                max_n = max(max_n, cell["n"])
        entry.update(status="computed", quality_status=q.status, outcomes=table,
                     noise_band=_round(noise_band(max_n), 4), noise_band_n=max_n,
                     note=NOISE_NOTE.replace("Daily series", "Hourly series"))
        out[name] = entry
    return out


def is_attention(series: str) -> bool:
    return not series.startswith("kalshi/")


def licensing_warning(sources_with_data: list[str], settings: dict[str, Any]) -> str | None:
    hit = [s for s in sources_with_data if s in LICENSED_SOURCES]
    if not hit or settings.get("licensing_confirmed"):
        return None
    return LICENSING_WARNING % ", ".join(hit)


def polling_info(race: Race, events_dir: str) -> dict[str, Any]:
    """polling_density from the event generator's meta file (config/events/<race>.meta.json), else the config."""
    path = os.path.join(events_dir, race.race_id + ".meta.json")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            meta = json.load(f)
        return {"polling_density": meta.get("polling_density"), "source": os.path.relpath(path, ROOT),
                "revision_url": meta.get("revision_url"), "generated_at": meta.get("generated_at"),
                "status": "needs_review"}
    return {"polling_density": race.polling_density, "source": "race config",
            "note": "run `python -m raceattn events --race %s` to count polls from Wikipedia" % race.race_id}


def race_override(race: Race, settings: dict[str, Any]) -> dict[str, Any]:
    """Per-race run settings from `race_overrides.<race_id>` in config/project.yaml: `skip` (source -> reason) and
    `connectors` (connector id -> settings merged over the project ones)."""
    return dict(((settings.get("race_overrides") or {}).get(race.race_id)) or {})


def override_summary(override: dict[str, Any]) -> dict[str, Any]:
    return {"skip": dict(override.get("skip") or {}), "connectors": dict(override.get("connectors") or {}),
            "note": override.get("note")} if override else {}


def events_overlay(path: str, race: Race) -> dict[str, Any]:
    """Every row of config/events/<race>.csv inside the window, with its status, for the dashboard overlay.
    Metrics only ever use confirmed rows; the overlay shows draft rows marked as needs_review."""
    import csv

    rows = []
    if os.path.isfile(path):
        with open(path, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                try:
                    d = dt.date.fromisoformat((r.get("date_utc") or "").strip()[:10])
                except ValueError:
                    continue
                if race.window.start <= d <= race.window.end:
                    rows.append({"date": d.isoformat(), "type": (r.get("type") or "").strip(),
                                 "status": (r.get("status") or "").strip(), "note": (r.get("note") or "").strip()})
    return {"file": os.path.relpath(path, ROOT) if path.startswith(ROOT) else path, "exists": os.path.isfile(path),
            "rows": rows, "n": len(rows), "n_confirmed": sum(1 for r in rows if r["status"] == "confirmed"),
            "note": "draft rows (needs_review) are shown for orientation only; metrics use confirmed rows"}


def run(race: Race, sources: list[str] | None = None, raw_dir: str = DEFAULT_RAW, out_dir: str = DEFAULT_OUT,
        refresh: bool = False, yes: bool = False, max_spend: float | None = None, http: HttpClient | None = None,
        log: Callable[[str], None] = print, write: bool = True, settings: dict[str, Any] | None = None,
        env: dict[str, str] | None = None, events_dir: str = EVENTS_DIR, display: bool | None = None
        ) -> dict[str, Any]:
    """`display`: build series.display_daily (None = when the race config sets display_window)."""
    settings = settings or load_settings()
    sources = list(sources or settings["default_sources"])
    window = race.window
    days = window.days()
    http = http or HttpClient()
    cache = Cache(raw_dir)
    override = race_override(race, settings)
    skipped: dict[str, str] = {}
    for src, why in (override.get("skip") or {}).items():
        if src in sources:
            reason = "left out by race_overrides in config/project.yaml: %s" % why
            skipped[src] = reason
            log("== %s: skipped (%s)" % (src, reason))
    run_settings = dict(settings)
    run_settings["connectors"] = {k: dict(v or {}) for k, v in (settings.get("connectors") or {}).items()}
    for cid, conf in (override.get("connectors") or {}).items():
        run_settings["connectors"].setdefault(cid, {}).update(conf or {})
    ev_path = os.path.join(events_dir, race.race_id + ".csv")
    all_connectors = make_connectors([s_ for s_ in sources if s_ not in skipped], http, cache, refresh,
                                     run_settings, env)
    connectors = []
    for c in all_connectors:
        c.log = log
        reason = c.skip_reason(race)
        if reason:
            skipped[c.id] = reason
            log("== %s: skipped (%s)" % (c.id, reason))
            for k in c.env_keys:
                if not c.secret(k):
                    log("   %s is not set: export it in your shell or put it in .env at the repo root "
                        "(git-ignored, loaded at startup, never printed)" % k)
        else:
            connectors.append(c)
    cost_guard(connectors, race, yes, max_spend, log)

    rows: list[Row] = []
    queries: dict[str, Any] = {}
    quality: dict[str, Quality] = {}
    series_hash: dict[str, str] = {}
    series_meta: dict[str, Any] = {}
    context: set[str] = set()  # shown and quality checked, but not attention in the metrics (e.g. Media Cloud ratios)
    for c in connectors:
        log("== %s: fetching" % c.id)
        crows = c.fetch(race, window)
        summary = c.query_summary(race, window)
        queries[c.id] = summary
        series_hash.update(summary["series_query_hash"])
        log("   %d request(s) rendered, query hash %s" % (len(summary["queries"]), summary["query_hash"]))
        log("   %d rows (%d from cache, %d fetched)" % (len(crows), c.cache_hits, c.fetches))
        rows.extend(crows)
        for name, q in c.quality(crows, window).items():
            quality[name] = q
            log("   quality %-55s %-9s %d/%d days%s" % (name, q.status, q.coverage_days, q.window_days,
                                                         (" (" + "; ".join(q.reasons) + ")") if q.reasons else ""))
        context |= set(getattr(c, "context_series", ()) or ())
        for r in crows:
            series_meta.setdefault(r.series, {"source": r.source, "connector": c.id, "granularity": r.granularity,
                                              "unit": r.unit, "query_hash": r.query_hash, "fetched_at": r.fetched_at})
    for s_ in context:
        if s_ in series_meta:
            series_meta[s_]["role"] = "context"
    if skipped:
        log("skipped connectors: " + "; ".join("%s (%s)" % kv for kv in skipped.items()))

    by_series: dict[str, list[Row]] = {}
    for r in rows:
        by_series.setdefault(r.series, []).append(r)

    # hourly Kalshi candles (ts = end_period_ts)
    price = sorted(by_series.get(SERIES_PRICE, []), key=lambda r: r.ts_utc)
    vol = {r.ts_utc: r.value for r in by_series.get(SERIES_VOLUME, [])}
    hourly_rows = [[iso_utc(r.ts_utc), r.value, vol.get(r.ts_utc)] for r in price]
    kd = daily_kalshi((r.ts_utc, r.value, vol.get(r.ts_utc)) for r in price)

    # every other hourly series on a full grid of window hours, labelled by hour end like the candles
    hourly_other = sorted(s for s, m in series_meta.items() if m["granularity"] == "hour"
                          and s not in (SERIES_PRICE, SERIES_VOLUME))
    hours = []
    t = window.start_dt + dt.timedelta(hours=1)
    while t <= window.end_exclusive_dt:
        hours.append(t)
        t += dt.timedelta(hours=1)
    hcols: dict[str, list] = {}
    for s in hourly_other:
        m = {r.ts_utc + dt.timedelta(hours=1): r.value for r in by_series[s]}
        hcols[s] = [m.get(h) for h in hours]
    price_by_end = {r.ts_utc: r.value for r in price}
    hcols_k = {SERIES_PRICE: [price_by_end.get(h) for h in hours], SERIES_VOLUME: [vol.get(h) for h in hours]}

    # daily aligned table on the window's dates
    attention_daily = [s for s, m in series_meta.items() if m["granularity"] == "day" and is_attention(s)
                       and s not in context]
    attention_daily.sort(key=lambda s: (s != HEADLINE_ATTENTION, s))
    context_daily = sorted(s for s, m in series_meta.items() if m["granularity"] == "day" and s in context)
    cols: dict[str, list] = {SERIES_PRICE: [kd.get(d, {}).get("close") for d in days],
                             SERIES_VOLUME: [kd.get(d, {}).get("volume") for d in days]}
    for s in attention_daily + context_daily:
        m = {r.ts_utc.date(): r.value for r in by_series[s]}
        cols[s] = [m.get(d) for d in days]
    # hourly series summed to UTC days (by bucket start); a day with any missing hour stays null
    daily_from_hourly = []
    for s in hourly_other:
        per: dict[dt.date, list] = {}
        for r in by_series[s]:
            per.setdefault(r.ts_utc.date(), []).append(r.value)
        if s == SERIES_SMALL_TRADE_SHARE:
            tc = {}
            for r in by_series.get(SERIES_TRADE_COUNT, []):
                tc[r.ts_utc] = r.value
            small: dict[dt.date, float] = {}
            tot: dict[dt.date, float] = {}
            for r in by_series[s]:
                n = tc.get(r.ts_utc) or 0.0
                tot[r.ts_utc.date()] = tot.get(r.ts_utc.date(), 0.0) + n
                small[r.ts_utc.date()] = small.get(r.ts_utc.date(), 0.0) + (r.value or 0.0) * n
            cols[s] = [(round(small[d] / tot[d], 6) if tot.get(d) else None) for d in days]
        else:
            cols[s] = [(sum(per[d]) if d in per and len(per[d]) == 24 and None not in per[d] else None) for d in days]
        if is_attention(s):
            daily_from_hourly.append(s)
    for s, q in quality.items():  # a series with no rows at all still gets a column of nulls
        if s not in cols and is_attention(s):
            cols[s] = [None] * len(days)
            if s not in context:
                attention_daily.append(s)
    daily_columns = ["date", "excluded"] + list(cols)
    daily_rows = [[d.isoformat(), d in race.exclude_days] + [cols[c][i] for c in cols] for i, d in enumerate(days)]

    notes = []
    if display is None:
        display = race.display_window_set
    display_daily = None
    if display and race.display_window is not None:
        from raceattn import display as display_mod

        log("== display window %s..%s" % (race.display_window.start, race.display_window.end))
        display_daily = display_mod.build(race, connectors, days, cols, refresh=refresh, log=log)
        notes.append("series.display_daily covers the display window %s..%s (%d days) for charts only; the metrics, "
                     "quality and series.daily use the analysis window %s..%s. Coverage and missing days per column "
                     "are in series.display_daily.coverage." % (
                         race.display_window.start, race.display_window.end, race.display_window.n_days,
                         window.start, window.end))
    has_kalshi = "kalshi" in [c.id for c in connectors]
    daily_attention = attention_daily + daily_from_hourly
    hourly_attention = [s for s in hourly_other if is_attention(s)]
    if has_kalshi:
        metrics_daily = daily_metrics(race, days, cols, quality, series_hash, daily_attention)
        metrics_hourly = hourly_metrics(race, hours, {**hcols, **hcols_k}, quality, series_hash, hourly_attention)
    else:
        metrics_daily, metrics_hourly = {}, {}
        notes.append("kalshi not in --sources, so no outcome series and no metrics")
    metrics = {"daily": metrics_daily, "hourly": metrics_hourly,
               "hourly_note": "hourly attention series (X, Bluesky) vs hourly Kalshi outcomes, step 24, lags "
                              "-3..+3 h; they are also summed to UTC days and appear in the daily tables"}
    for name, entry in list(metrics_daily.items()) + list(metrics_hourly.items()):
        if entry["status"] == "skipped":
            log("   metrics skipped for %s (%s): %s" % (name, entry["granularity"], entry["reason"]))

    # event windows, excess attention and reversion (daily)
    events = load_events(ev_path)
    ev_settings = settings["events"]
    ev_out: dict[str, Any] = {
        "events_file": os.path.relpath(ev_path, ROOT) if ev_path.startswith(ROOT) else ev_path,
        "events_file_exists": events["exists"], "n_confirmed": len(events["confirmed"]),
        "n_needs_review_ignored": events["needs_review"], "problems": events["problems"],
        "note": ("rows with status needs_review are ignored until a human marks them confirmed"
                 if events["needs_review"] else ""),
        "series": {}}
    if not events["confirmed"]:
        ev_out["status"] = "no confirmed events"
    keep = [d not in race.exclude_days for d in days]
    if has_kalshi:
        for name in daily_attention:
            q = quality.get(name)
            e: dict[str, Any] = {"query_hash": {"attention": series_hash.get(name),
                                                "price": series_hash.get(SERIES_PRICE),
                                                "volume": series_hash.get(SERIES_VOLUME)}}
            if q is None or q.status == "unusable":
                e.update(status="skipped", reason="attention series is unusable or missing")
            else:
                e.update(status="computed", quality_status=worst(q.status, quality[SERIES_PRICE].status,
                                                                 quality[SERIES_VOLUME].status))
                e.update(event_metrics(days, keep, cols[name], cols[SERIES_PRICE], cols[SERIES_VOLUME], events,
                                       ev_settings))
            ev_out["series"][name] = e
    metrics["events"] = ev_out
    if ev_out.get("status") == "no confirmed events":
        log("   event windows: no confirmed events (%d row(s) need review and were ignored)" % events["needs_review"])

    licensed = sorted({series_meta[s]["connector"] for s in series_meta if series_meta[s]["connector"] in LICENSED_SOURCES})
    warning = licensing_warning(licensed, settings)
    if warning:
        notes.append(warning)

    result = {
        "project": PROJECT_NAME, "version": __version__, "schema_version": 2, "generated_at": now_utc(),
        "race": race.summary(),
        "window": {"start": window.start.isoformat(), "end": window.end.isoformat(), "days": window.n_days,
                   "inclusive": True, "timezone": "UTC"},
        "excluded_days": [d.isoformat() for d in race.exclude_days],
        "sources": [c.id for c in connectors],
        "sources_requested": list(sources),
        "skipped": skipped,
        "polling": polling_info(race, events_dir),
        "run_overrides": override_summary(override),
        "events_overlay": events_overlay(ev_path, race),
        "licensing": {"confirmed": bool(settings.get("licensing_confirmed")), "warning": warning,
                      "sources_with_unconfirmed_terms": [] if settings.get("licensing_confirmed") else licensed},
        "queries": queries,
        "series": {
            "meta": series_meta,
            "hourly": {"columns": ["ts_utc", SERIES_PRICE, SERIES_VOLUME], "rows": hourly_rows,
                       "note": "ts_utc is the candle end_period_ts; price forward-filled for hours with no trades"},
            "hourly_grid": {"columns": ["ts_utc"] + hourly_other,
                            "rows": [[iso_utc(h)] + [hcols[s][i] for s in hourly_other] for i, h in enumerate(hours)],
                            "note": "every hour of the window; ts_utc is the hour's end (bucket start + 1 h), the "
                                    "same convention as the Kalshi candles. Null = no data for that hour."},
            "daily": {"columns": daily_columns, "rows": daily_rows,
                      "note": "Kalshi daily: volume = sum of hourly candles by UTC date of end_period_ts, "
                              "close = last close of the day. Hourly attention and trade series are summed by UTC "
                              "date of the bucket start (null if any hour is missing); small_trade_share is "
                              "small trades / all trades for the day. Attention values are never interpolated."},
        },
        "quality": {k: v.to_dict() for k, v in sorted(quality.items())},
        "metrics": metrics,
        "notes": notes,
    }
    if display_daily is not None:
        result["series"]["display_daily"] = display_daily
        kalshi = next((c for c in connectors if c.id == "kalshi"), None)
        if kalshi is not None:
            # display_daily just read (or with --refresh re-pulled) these windows: read them from the cache
            was, kalshi.refresh = kalshi.refresh, False
            try:
                result["series"]["display_hourly"] = display_mod.build_hourly(
                    race, kalshi, hourly_rows, refresh=False, log=log, daily=display_daily)
            finally:
                kalshi.refresh = was
            # the Republican contract next to it, and the candidates block (charts only, never the metrics)
            from raceattn import opposing
            from raceattn.discover import Fetcher

            opposing.apply(race, result, kalshi, Fetcher(http, raw_dir=raw_dir, refresh=refresh, log=log), log=log)
        result["series"]["granularity"] = display_mod.granularity(result["series"])
    print_tables(result, log)
    if warning:
        log(warning)
    if write:
        write_outputs(result, out_dir)
    return result


def print_tables(result: dict[str, Any], log: Callable[[str], None]) -> None:
    for name, entry in result["metrics"]["hourly"].items():
        if entry["status"] != "computed":
            continue
        log("HOURLY %s surprise vs outcomes (lag>0: outcome after attention)" % name)
        for oname, cells in entry["outcomes"].items():
            log("  %-17s %s" % (oname, "  ".join(
                "lag%+d=%s(n%d)" % (int(k), ("%.2f" % c["rho"]) if c["rho"] is not None else "NA", c["n"])
                for k, c in cells.items())))
        log("  noise band ~ +-%.2f (2/sqrt(%d))" % (entry["noise_band"], entry["noise_band_n"]))
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


# platform groups (spec section 6): who is talking, who is reporting, who is looking
PLATFORM_GROUPS = {"x": "talking", "bluesky": "talking", "reddit": "talking", "news_mediacloud": "reporting",
                   "news_guardian": "reporting", "news_nyt": "reporting", "news_manual": "reporting",
                   "gdelt": "reporting", "wikipedia": "looking", "youtube": "video"}
HEADLINE_LAG = "0"


def _kept_values(result: dict[str, Any], col: str) -> list[tuple[str, Any]]:
    t = result["series"]["daily"]
    i = t["columns"].index(col)
    return [(r[0], r[i]) for r in t["rows"] if not r[1]]


def index_metrics(result: dict[str, Any]) -> dict[str, Any]:
    """Headline numbers for the map. All over the non-excluded days of the window (election night is left out,
    as in the main metrics), each with its n."""
    t = result["series"]["daily"]
    meta = result["series"]["meta"]
    att = [c for c in t["columns"][2:] if is_attention(c) and (meta.get(c) or {}).get("role") != "context"]
    per: dict[str, Any] = {}
    for c in att:
        vals = [v for _, v in _kept_values(result, c) if v is not None]
        q = result["quality"].get(c, {})
        entry = result["metrics"]["daily"].get(c) or {}
        cell = ((entry.get("outcomes") or {}).get("volume_surprise") or {}).get(HEADLINE_LAG) or {}
        conn = (meta.get(c) or {}).get("connector") or c.split("/")[0]
        per[c] = {"source": conn, "group": PLATFORM_GROUPS.get(conn, "other"),
                  "total": round(sum(vals), 4) if vals else None, "n_days": len(vals),
                  "coverage": q.get("coverage"), "status": q.get("status", "unusable"),
                  "rho_volume_surprise": cell.get("rho"), "n_pairs": cell.get("n", 0), "lag": int(HEADLINE_LAG),
                  "metric_status": entry.get("status", "not computed"), "reason": entry.get("reason")}
    head = per.get(HEADLINE_ATTENTION) or {}
    closes = [(d, v) for d, v in _kept_values(result, SERIES_PRICE) if v is not None]
    all_closes = [(r[0], r[t["columns"].index(SERIES_PRICE)]) for r in t["rows"]
                  if r[t["columns"].index(SERIES_PRICE)] is not None]
    pc = None
    if len(closes) >= 2:
        pc = {"cents": round((closes[-1][1] - closes[0][1]) * 100, 2), "from": closes[0][0], "to": closes[-1][0],
              "first_close": closes[0][1], "last_close": closes[-1][1], "n_days": len(closes),
              "full_window_cents": round((all_closes[-1][1] - all_closes[0][1]) * 100, 2),
              "full_window_to": all_closes[-1][0],
              "note": "last close on the last non-excluded day minus the first close in the window (cents); "
                      "full_window_cents runs to the window end and includes election night"}
    usable = [v for v in per.values() if v["coverage"] is not None]
    statuses = [q["status"] for q in result["quality"].values()]
    return {
        "attention_total": {"series": HEADLINE_ATTENTION, "value": head.get("total"), "n_days": head.get("n_days", 0),
                            "unit": "views", "note": "sum over the non-excluded days of the window"},
        "attention_vs_volume": {"series": HEADLINE_ATTENTION, "outcome": "volume_surprise", "lag": int(HEADLINE_LAG),
                                "rho": head.get("rho_volume_surprise"), "n": head.get("n_pairs", 0),
                                "noise_band": (result["metrics"]["daily"].get(HEADLINE_ATTENTION) or {}).get("noise_band"),
                                "note": "Spearman rho of daily attention surprise vs Kalshi volume surprise, same day "
                                        "(lag 0, chosen before looking at the numbers); every lag is in the race file"},
        "price_change": pc,
        "polling_density": result["polling"].get("polling_density"),
        "polling_source": result["polling"].get("source"),
        "data_coverage": {"share": round(sum(v["coverage"] for v in usable) / len(usable), 4) if usable else None,
                          "n_series": len(usable), "window_days": result["window"]["days"],
                          "note": "mean coverage (days with data / window days) over the attention series that ran"},
        "quality_summary": {"ok": statuses.count("ok"), "degraded": statuses.count("degraded"),
                            "unusable": statuses.count("unusable"),
                            "unusable_series": {k: q["reasons"] for k, q in result["quality"].items()
                                                if q["status"] == "unusable"},
                            "skipped_sources": result["skipped"]},
        "attention": per,
    }


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
        "kalshi": k, "status": r.get("status", "confirmed"),
        "metrics": index_metrics(result),
        "display": display_totals(result["series"].get("display_daily")),
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
