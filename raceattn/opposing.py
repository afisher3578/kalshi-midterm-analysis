"""The opposing major-party contract (Republican) next to the followed Democratic one, for charts only, and the
race's `candidates` block.

The Republican market is read from the Kalshi event's markets list (the event body `discover` caches), never from a
ticker pattern. Its hourly candles for the display window are pulled with KalshiConnector on a copy of the race whose
followed_market is the Republican ticker, so the chunking, cache, pacing and stop rules are the same as for the
Democratic contract; the copy is never written back to config.

What this adds to a race JSON, next to the existing data and never changing it:
- series.display_hourly: columns kalshi_r/price_close and kalshi_r/volume at the end of every row, on the existing
  hourly grid (no rows added or dropped), plus series.display_hourly.opposing;
- series.display_daily: columns kalshi_r_price_close and kalshi_r_volume at the end, plus a pointer block;
- the top-level `candidates` block.
The metrics, baselines, quality and the chart's volume series (kalshi/volume, the Democratic contract) never read
these columns.
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import os
import re
from typing import Any, Callable

from raceattn import discover
from raceattn.config import Race
from raceattn.connectors.base import Connector
from raceattn.connectors.kalshi import SERIES_PRICE, SERIES_VOLUME
from raceattn.display import COL_PRICE, _iso, reconcile
from raceattn.metrics.surprise import daily_kalshi

H_PRICE = "kalshi_r/price_close"
H_VOLUME = "kalshi_r/volume"
D_PRICE = "kalshi_r_price_close"
D_VOLUME = "kalshi_r_volume"
SUM_TOLERANCE = 0.05
NOTE = ("Republican contract of the same Kalshi event, for charts only. Read from the event's markets list (the "
        "market whose subtitle names the Republican party), not from a ticker pattern. Hourly candles for the display "
        "window from display start 00:00 UTC to end + 1 day 00:00 UTC, same chunks, cache and pacing as the "
        "Democratic contract. On the existing hourly grid: an hour with no R candle gets the previous hour's R close "
        "and R volume 0 (filled_hours); leading hours with no R close yet stay null (leading_null_hours). R candles "
        "past the grid's last_ts are not added. Daily R: close = last close of the UTC day by end_period_ts, volume = "
        "sum of the day's hourly volume. The metrics and the chart's volume series (kalshi/volume, Democratic) never "
        "read these columns.")
SUM_NOTE = ("D close + R close per row where both are non-null. Two complementary contracts would sum to about 1; "
            "flag = abs(mean - 1) > %g. Nothing is dropped or adjusted." % SUM_TOLERANCE)


# ------------------------------------------------------------------ the event's markets
def event_markets(race: Race, fetcher: discover.Fetcher) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """The event's markets from the discovery cache (requested only when the cache file is missing)."""
    ticker = race.kalshi.event
    url = discover.kalshi_event_url(ticker)
    path = fetcher.cache.path("kalshi_discovery", "event", ticker, discover.query_hash(url, {}), "event")
    cached = os.path.isfile(path) and not fetcher.refresh
    rec = fetcher.kalshi_event(ticker)
    markets = (rec.get("body") or {}).get("markets") or []
    return markets, {"url": url, "cache_file": os.path.relpath(path, discover.ROOT) if path.startswith(discover.ROOT)
                     else path, "from_cache": cached, "fetched_at": rec.get("fetched_at")}


def _party_rule(m: dict[str, Any], word: str) -> bool:
    return (m.get("subtitle") or "").strip().lower().startswith(word.lower())


def opposing_market(markets: list[dict[str, Any]], followed: str) -> tuple[dict[str, Any], str]:
    """The Republican market of the event: the one whose subtitle starts with "Republican" (the discover rule);
    discover.party_market (subtitle or ticker suffix) only when no subtitle names it. Never the followed market."""
    others = [m for m in markets if m.get("ticker") != followed]
    hits = [m for m in others if _party_rule(m, "Republican")]
    if len(hits) > 1:
        raise ValueError("several markets have a Republican subtitle: %s" % ", ".join(m["ticker"] for m in hits))
    if hits:
        return hits[0], "subtitle starts with 'Republican'"
    m = discover.party_market(others, "Republican")
    if m is None:
        raise ValueError("no Republican market in the event (tickers: %s)" % ", ".join(
            str(m_.get("ticker")) for m_ in markets))
    return m, "discover.party_market fallback (ticker suffix)"


def pick(race: Race, markets: list[dict[str, Any]]) -> dict[str, Any]:
    """The followed D market, the R market and every other market of the event (left_out)."""
    followed = race.kalshi.followed_market
    d = next((m for m in markets if m.get("ticker") == followed), None)
    if d is None:
        raise ValueError("%s: followed market %s is not in event %s" % (race.race_id, followed, race.kalshi.event))
    r, rule = opposing_market(markets, followed)
    left = [{"ticker": m.get("ticker"), "name": m.get("yes_sub_title"), "subtitle": m.get("subtitle"),
             "status": m.get("status"), "result": m.get("result")}
            for m in markets if m.get("ticker") not in (followed, r.get("ticker"))]
    return {"d": d, "r": r, "rule": rule, "left_out": left}


# ------------------------------------------------------------------ R candles
def fetch_r(race: Race, conn: Connector, r_ticker: str) -> tuple[list, int, int]:
    """Hourly R rows for the display window (start 00:00 to end + 1 day 00:00). Returns rows, requests, hits."""
    r_race = dataclasses.replace(race, kalshi=dataclasses.replace(race.kalshi, followed_market=r_ticker))
    h0, f0 = conn.cache_hits, conn.fetches
    rows = conn.fetch(r_race, race.display_window)
    return rows, conn.fetches - f0, conn.cache_hits - h0


def hourly_by_ts(rows: list) -> dict[str, list]:
    vol = {r.ts_utc: r.value for r in rows if r.series == SERIES_VOLUME}
    return {_iso(r.ts_utc): [r.value, vol.get(r.ts_utc)] for r in rows if r.series == SERIES_PRICE}


def on_grid(grid: list[str], r_by_ts: dict[str, list]) -> tuple[list[list], dict[str, list[str]]]:
    """R price and volume on the given hourly grid: forward fill and volume 0 for hours with no R candle, null
    until the first R close."""
    out, filled, leading, ffill_null = [], [], [], []
    prev = None
    for t in grid:
        if t in r_by_ts:
            price, v = r_by_ts[t]
            if price is None and prev is not None:
                price = prev
                ffill_null.append(t)
        else:
            price, v = prev, 0.0
            filled.append(t)
        if price is None:
            leading.append(t)
        out.append([price, v])
        prev = price
    return out, {"filled": filled, "leading_null": leading, "ffill_null": ffill_null}


def daily_r(rows: list, dates: list[str]) -> dict[str, dict[str, Any]]:
    """Daily R values from the hourly candles (daily_kalshi), for the given dates (null when no candle)."""
    vol = {r.ts_utc: r.value for r in rows if r.series == SERIES_VOLUME}
    price = sorted((r for r in rows if r.series == SERIES_PRICE), key=lambda r: r.ts_utc)
    kd = daily_kalshi((r.ts_utc, r.value, vol.get(r.ts_utc)) for r in price)
    out = {}
    for d in dates:
        e = kd.get(dt.date.fromisoformat(d))
        out[d] = {"close": e["close"] if e else None, "volume": e["volume"] if e else None}
    return out


def sum_check(pairs: list[tuple[Any, Any]]) -> dict[str, Any]:
    s = [a + b for a, b in pairs if a is not None and b is not None]
    if not s:
        return {"n": 0, "mean": None, "min": None, "max": None, "flag": None, "note": SUM_NOTE}
    mean = sum(s) / len(s)
    return {"n": len(s), "mean": round(mean, 6), "min": round(min(s), 6), "max": round(max(s), 6),
            "flag": abs(mean - 1) > SUM_TOLERANCE, "note": SUM_NOTE}


# ------------------------------------------------------------------ writing the columns
def _strip(block: dict[str, Any], cols: list[str], rows_are_lists: bool) -> None:
    """Drop earlier R columns (a re-run replaces them in place; the other columns are not touched)."""
    columns = block["columns"]
    idx = [i for i, c in enumerate(columns) if c in cols]
    if not idx:
        return
    if rows_are_lists:
        block["rows"] = [[v for i, v in enumerate(r) if i not in idx] for r in block["rows"]]
    else:
        for r in block["rows"]:
            for c in cols:
                r.pop(c, None)
    block["columns"] = [c for c in columns if c not in cols]


def add_columns(series: dict[str, Any], rows: list, info: dict[str, Any]) -> dict[str, Any]:
    """Append the R columns to series.display_hourly and series.display_daily, add the opposing blocks."""
    dh, dd = series["display_hourly"], series["display_daily"]
    _strip(dh, [H_PRICE, H_VOLUME], True)
    _strip(dd, [D_PRICE, D_VOLUME], False)
    hcols = dh["columns"]
    pi, vi = hcols.index(SERIES_PRICE), hcols.index(SERIES_VOLUME)
    grid = [r[0] for r in dh["rows"]]
    r_by_ts = hourly_by_ts(rows)
    vals, counts = on_grid(grid, r_by_ts)
    for r, (p, v) in zip(dh["rows"], vals):
        r.extend([p, v])
    dh["columns"] = hcols + [H_PRICE, H_VOLUME]
    dates = [r["date"] for r in dd["rows"]]
    rd = daily_r(rows, dates)
    for r in dd["rows"]:
        r[D_PRICE] = rd[r["date"]]["close"]
        r[D_VOLUME] = rd[r["date"]]["volume"]
    dd["columns"] = dd["columns"] + [D_PRICE, D_VOLUME]
    last = dh["rows"][-1][0] if dh["rows"] else None
    after = sorted(t for t in r_by_ts if last is not None and t > last)
    before = sorted(t for t in r_by_ts if grid and t < grid[0])
    rec = reconcile([[r[0], p, v] for r, (p, v) in zip(dh["rows"], vals)], dd, price_col=D_PRICE, volume_col=D_VOLUME)
    if after:
        rec["note"] = ("%d R candle(s) after the grid's last_ts %s (%s..%s) are not on the hourly grid but count in "
                       "the daily R values of their date" % (len(after), last, after[0], after[-1]))
    hsum = sum_check([(r[pi], p) for r, (p, _) in zip(dh["rows"], vals)])
    dsum = sum_check([(r.get(COL_PRICE), r.get(D_PRICE)) for r in dd["rows"]])
    block = dict(info)
    block.update({
        "columns": [H_PRICE, H_VOLUME],
        "candles": len(r_by_ts),
        "candles_after_grid": {"n": len(after), "first": after[0] if after else None,
                               "last": after[-1] if after else None,
                               "rule": "R candles after the grid's last_ts are not added; the grid is not extended"},
        "candles_before_grid": len(before),
        "leading_null_hours": {"n": len(counts["leading_null"]), "hours": counts["leading_null"],
                               "rule": "no R close known yet at that hour"},
        "filled_hours": {"n": len(counts["filled"]), "hours": counts["filled"],
                         "rule": "no R candle for that hour: R price forward-filled from the previous hour, R volume 0"},
        "forward_filled_null_price": {"n": len(counts["ffill_null"]), "hours": counts["ffill_null"],
                                      "rule": "R candle with a null price: price forward-filled, volume kept"},
        "reconciliation": rec,
        "sum_check": hsum,
        "note": NOTE,
    })
    dh["opposing"] = block
    dd["opposing"] = {k: info[k] for k in ("ticker", "party", "name", "source")}
    dd["opposing"].update({"columns": [D_PRICE, D_VOLUME], "hourly": "series.display_hourly.opposing",
                           "days_with_close": sum(1 for d in dates if rd[d]["close"] is not None),
                           "sum_check": dsum,
                           "rule": "close = last R close of the UTC day by end_period_ts, volume = sum of the "
                                   "day's hourly R volume; null = no R candle that day"})
    return block


# ------------------------------------------------------------------ candidates
def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z ]", "", (s or "").lower()).strip()


def _match_entity(race: Race, kalshi_name: str | None) -> tuple[str | None, str]:
    """Config entity for a Kalshi yes_sub_title: exact name (case and punctuation aside), else surname."""
    for e in race.entities:
        if _norm(e.name) == _norm(kalshi_name):
            return e.name, "exact"
    sn = _norm(discover.surname(kalshi_name or ""))
    hits = [e for e in race.entities if _norm(discover.surname(e.name)) == sn]
    if len(hits) == 1:
        return hits[0].name, "surname"
    return None, "none"


def infobox_nominees(race: Race, fetcher: discover.Fetcher) -> tuple[list[dict[str, Any]] | None, str]:
    """Nominees from the cached race article (the same parse request and cache path as discover). Read from the
    cache only; (None, why) when it is not cached."""
    if not race.wikipedia_pages:
        return None, "the race config lists no Wikipedia page"
    page = race.wikipedia_pages[0]
    label = "%s_%s" % (discover.WINDOW_START.strftime("%Y%m%d"),
                       (race.election_date + dt.timedelta(days=1)).strftime("%Y%m%d"))
    params = {"action": "parse", "page": page, "prop": "wikitext|revid", "format": "json", "formatversion": 2,
              "redirects": 1}
    path = fetcher.cache.path("wikipedia_events", race.race_id, label, discover.query_hash(discover.WIKI_API, params),
                              "parse")
    rec = fetcher.cache.get(path)
    if rec is None:
        return None, "the race article %s is not in the cache (%s); infobox check not done" % (page, path)
    parse = ((rec.get("body") or {}).get("parse")) or {}
    text = parse.get("wikitext")
    text = text if isinstance(text, str) else (text or {}).get("*", "")
    rev = "%s revid %s" % (discover.wiki_url(page.replace("_", " ")), parse.get("revid"))
    return discover.nominees(discover.infobox(text)), rev


def candidates(race: Race, chosen: dict[str, Any], event_source: dict[str, Any],
               fetcher: discover.Fetcher) -> dict[str, Any]:
    notes: list[str] = []
    major = []
    used_entities = set()
    noms, wiki_src = infobox_nominees(race, fetcher)
    if noms is None:
        notes.append("Wikipedia check impossible: %s." % wiki_src)
    for party, word, m in (("D", "Democratic", chosen["d"]), ("R", "Republican", chosen["r"])):
        kname = m.get("yes_sub_title")
        ename, how = _match_entity(race, kname)
        if ename is None:
            notes.append("%s: Kalshi name %r matches no config entity (%s); the Kalshi name is used." % (
                m["ticker"], kname, ", ".join(e.name for e in race.entities)))
            name = kname
        else:
            used_entities.add(ename)
            name = ename
            if how != "exact":
                notes.append("%s: Kalshi name %r differs from the config entity %r (matched by surname); the config "
                             "name is kept." % (m["ticker"], kname, ename))
        entry = {"name": name, "party": party, "kalshi_ticker": m["ticker"], "kalshi_name": kname}
        if noms is not None:
            sn = _norm(discover.surname(name or ""))
            hit = [n for n in noms if _norm(discover.surname(n["name"])) == sn]
            if not hit:
                notes.append("%s %r is not among the infobox nominees (%s)." % (
                    party, name, ", ".join(n["name"] for n in noms) or "none"))
                entry["wikipedia_infobox"] = None
            else:
                n = hit[0]
                party_ok = word.lower() in (n["party"] or "").lower()
                if not party_ok:
                    notes.append("%s %r: the infobox party is %r." % (party, name, n["party"]))
                if _norm(n["name"]) != _norm(name):
                    notes.append("%s: infobox name %r differs from %r." % (party, n["name"], name))
                entry["wikipedia_infobox"] = {"name": n["name"], "party": n["party"], "percentage": n["percentage"],
                                              "party_matches": party_ok}
        major.append(entry)
    left = [{"name": m["name"], "ticker": m["ticker"],
             "why": "a market of event %s that is neither the followed Democratic contract nor the Republican "
                    "contract (status %s, result %s)" % (race.kalshi.event, m.get("status"), m.get("result"))}
            for m in chosen["left_out"]]
    if noms is not None:
        major_sn = {_norm(discover.surname(e["name"] or "")) for e in major}
        for n in noms:
            if _norm(discover.surname(n["name"])) not in major_sn:
                left.append({"name": n["name"], "ticker": None,
                             "why": "infobox nominee (%s, %s%%) with no D or R Kalshi contract" % (
                                 n["party"], n["percentage"])})
    for e in race.entities:
        if e.name not in used_entities:
            notes.append("config entity %r matches no D or R Kalshi contract." % e.name)
    if not notes:
        notes.append("Kalshi names, config entities and the Wikipedia infobox nominees and parties agree.")
    return {
        "major": major,
        "left_out": left,
        "source": "Kalshi event %s markets (yes_sub_title), cache %s; names from the race config entities; checked "
                  "against the Wikipedia infobox nominees (%s)" % (event_source["url"], event_source["cache_file"],
                                                                  wiki_src if noms is not None else "not checked"),
        "note": " ".join(notes),
    }


# ------------------------------------------------------------------ one race
def apply(race: Race, result: dict[str, Any], conn: Connector, fetcher: discover.Fetcher,
          log: Callable[[str], None] = print) -> dict[str, Any]:
    """Add the R columns, the opposing blocks and the candidates block to a race result, in place. Needs
    series.display_hourly and series.display_daily. Returns a summary for printing."""
    series = result["series"]
    if "display_hourly" not in series or "display_daily" not in series:
        raise ValueError("%s: series.display_hourly and series.display_daily are needed" % race.race_id)
    ev0 = fetcher.fetches
    markets, src = event_markets(race, fetcher)
    chosen = pick(race, markets)
    r = chosen["r"]
    ev = fetcher.fetches - ev0
    rows, made, hits = fetch_r(race, conn, r["ticker"])
    info = {"ticker": r["ticker"], "party": "R", "name": r.get("yes_sub_title"),
            "market_title": r.get("title"), "rule": chosen["rule"],
            "source": "%s (markets list); cache %s" % (src["url"], src["cache_file"]),
            "request_window": {"start": race.display_window.start_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
                               "end": race.display_window.end_exclusive_dt.strftime("%Y-%m-%dT%H:%M:%SZ")},
            "segments": [{"source": conn.id, "request_window": {"start": race.display_window.start.isoformat(),
                                                                "end": race.display_window.end.isoformat()},
                          "chunks": len(conn.render_queries(race, race.display_window)),
                          "from": "cache" if made == 0 else "new pull" if hits == 0 else "cache and new pull",
                          "cache_hits": hits, "requests": made}],
            "requests_made": made, "cache_hits": hits,
            "event_body": {"url": src["url"], "cache_file": src["cache_file"], "requests": ev,
                           "from": "cache" if ev == 0 else "requested (not cached)"}}
    block = add_columns(series, rows, info)
    result["candidates"] = candidates(race, chosen, src, fetcher)
    log("   opposing %s (%s): %d candle(s), %d request(s), %d cache hit(s); event body %s" % (
        r["ticker"], info["name"], block["candles"], made, hits, "requested" if ev else "from cache"))
    return {"block": block, "daily": series["display_daily"]["opposing"], "candidates": result["candidates"],
            "left_out": chosen["left_out"], "event_requests": ev, "event_source": src}


def patch_processed(race: Race, path: str, conn: Connector, fetcher: discover.Fetcher,
                    log: Callable[[str], None] = print) -> dict[str, Any]:
    """apply() on an existing processed race JSON, in place, written with the pipeline's _dump."""
    import json

    from raceattn.pipeline import _dump

    with open(path, encoding="utf-8") as f:
        result = json.load(f)
    size_before = os.path.getsize(path)
    out = apply(race, result, conn, fetcher, log=log)
    _dump(path, result)
    out.update({"size_before": size_before, "size_after": os.path.getsize(path)})
    return out
