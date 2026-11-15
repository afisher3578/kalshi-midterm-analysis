"""Kalshi public market data (spec section 5). No auth, no trading, read-only GETs."""
from __future__ import annotations

import datetime as dt
from typing import Any

from raceattn.cache import combine_hashes
from raceattn.config import Race, Window
from raceattn.connectors.base import Connector, RenderedQuery, Row, iso_utc
from raceattn.http import FetchError

BASE_URL = "https://external-api.kalshi.com/trade-api/v2"
CHUNK_DAYS = 20
PERIOD_INTERVAL = 60  # minutes: hourly candles
SERIES_PRICE = "kalshi/price_close"
SERIES_VOLUME = "kalshi/volume"
SERIES_TRADE_COUNT = "kalshi/trade_count"
SERIES_SMALL_TRADE_SHARE = "kalshi/small_trade_share"


def _ts(t: dt.datetime) -> int:
    return int(t.timestamp())


def _num(v: Any) -> float | None:
    if v in (None, ""):
        return None
    return float(v)


class KalshiConnector(Connector):
    id = "kalshi"
    auth = "none"
    granularity = ["hour"]
    cost_model = "free"

    def __init__(self, *a, base_url: str = BASE_URL, chunk_days: int = CHUNK_DAYS, **kw):
        super().__init__(*a, **kw)
        self.base_url = base_url
        self.chunk_days = chunk_days

    def render_queries(self, race: Race, window: Window) -> list[RenderedQuery]:
        """Hourly candlesticks for the followed market, in chunks of <= chunk_days.
        The window is inclusive UTC dates, so requests run from start 00:00 to (end + 1 day) 00:00."""
        k = race.kalshi
        endpoint = "%s/series/%s/markets/%s/candlesticks" % (self.base_url, k.series, k.followed_market)
        start, end = window.start_dt, window.end_exclusive_dt
        out, cur = [], start
        while cur < end:
            nxt = min(cur + dt.timedelta(days=self.chunk_days), end)
            out.append(RenderedQuery(endpoint, {"start_ts": _ts(cur), "end_ts": _ts(nxt),
                                                "period_interval": PERIOD_INTERVAL},
                                     label="candlesticks %s..%s" % (iso_utc(cur), iso_utc(nxt))))
            cur = nxt
        return out

    def series_query_hashes(self, race: Race, window: Window) -> dict[str, str]:
        h = combine_hashes([q.query_hash for q in self.render_queries(race, window)])
        return {SERIES_PRICE: h, SERIES_VOLUME: h}

    @staticmethod
    def chunk_name(q: RenderedQuery) -> str:
        return "chunk_%d_%d" % (q.params["start_ts"], q.params["end_ts"])

    def cache_paths(self, race: Race, window: Window) -> list[str]:
        """Cache file of every chunk for this window (used to tell whether a window is fully cached)."""
        qs = self.render_queries(race, window)
        dir_hash = combine_hashes([q.query_hash for q in qs])
        return [self.cache.path(self.id, race.race_id, window.label, dir_hash, self.chunk_name(q)) for q in qs]

    def fetch_candles(self, race: Race, window: Window) -> tuple[list[dict[str, Any]], list[str]]:
        """Raw candles from every chunk (cached), plus the fetched_at of each chunk."""
        qs = self.render_queries(race, window)
        dir_hash = combine_hashes([q.query_hash for q in qs])
        candles, fetched = [], []
        for q in qs:
            rec = self.cached_get(race, window, q, dir_hash, self.chunk_name(q))
            body = rec["body"]
            if not isinstance(body, dict) or "candlesticks" not in body:
                raise FetchError("Kalshi %s: response has no 'candlesticks' key" % q.label)
            candles.extend(body["candlesticks"] or [])
            fetched.append(rec["fetched_at"])
        return candles, fetched

    def fetch(self, race: Race, window: Window) -> list[Row]:
        candles, fetched = self.fetch_candles(race, window)
        h = self.series_query_hashes(race, window)[SERIES_PRICE]
        fetched_at = max(fetched) if fetched else ""
        # sort, dedupe on end_period_ts (chunk edges overlap), forward-fill price, volume 0 when missing
        by_ts: dict[int, dict[str, Any]] = {}
        for c in sorted(candles, key=lambda c: c["end_period_ts"]):
            by_ts.setdefault(int(c["end_period_ts"]), c)
        rows: list[Row] = []
        last = None
        self.filled_hours = 0
        for ts in sorted(by_ts):
            c = by_ts[ts]
            close = _num((c.get("price") or {}).get("close_dollars"))
            if close is None:
                close = last
                if last is not None:
                    self.filled_hours += 1
            else:
                last = close
            vol = _num(c.get("volume_fp")) or 0.0
            t = dt.datetime.fromtimestamp(ts, dt.timezone.utc)
            rows.append(Row(race.race_id, self.id, SERIES_PRICE, t, "hour", close, "usd_per_contract", h, fetched_at))
            rows.append(Row(race.race_id, self.id, SERIES_VOLUME, t, "hour", vol, "contracts", h, fetched_at))
        return rows

    def quality(self, rows: list[Row], window: Window):
        q = super().quality(rows, window)
        hours = sum(1 for r in rows if r.series == SERIES_PRICE)
        for name in q:
            q[name].extra.update({"hours": hours, "window_hours": window.n_days * 24})
        if SERIES_PRICE in q:
            q[SERIES_PRICE].extra["forward_filled_hours"] = getattr(self, "filled_hours", 0)
        return q

    def daily_values(self, rows):
        # price is a level, so for quality we only need presence per day: use the last close
        if rows and rows[0].series == SERIES_PRICE:
            out = {}
            for r in rows:
                if r.value is not None:
                    out[r.ts_utc.date()] = r.value
            return out
        return Connector.daily_values(rows)

    def check_near_zero(self, series: str) -> bool:
        # a low price is a real price, not missing data
        return series != SERIES_PRICE

    def fetch_trades(self, race: Race, window: Window) -> list[Row]:
        """kalshi/trade_count and kalshi/small_trade_share (hourly). See KalshiTradesConnector."""
        c = KalshiTradesConnector(http=self.http, cache=self.cache, refresh=self.refresh, base_url=self.base_url)
        return c.fetch(race, window)


class KalshiTradesConnector(Connector):
    """Trades for the followed market: /historical/trades before the cutoff from /historical/cutoff,
    /markets/trades from the cutoff on. Rows are hourly buckets by created_time (bucket start, UTC).

    Block trades are excluded by default (block_trades="exclude") and the number excluded is reported in quality.
    small_trade_share = trades with count_fp < small_trade_threshold divided by trades in the hour (null when the
    hour has no trades)."""

    id = "kalshi_trades"
    auth = "none"
    granularity = ["hour"]
    cost_model = "free"
    page_limit = 1000  # API maximum (limit=1001 is rejected)

    def __init__(self, *a, base_url: str = BASE_URL, small_trade_threshold: float = 10,
                 block_trades: str = "exclude", **kw):
        super().__init__(*a, **kw)
        if block_trades not in ("exclude", "include"):
            raise ValueError("block_trades must be exclude or include, got %r" % block_trades)
        self.base_url = base_url
        self.small_trade_threshold = float(small_trade_threshold)
        self.block_trades = block_trades
        self.stats: dict[str, Any] = {}

    def cutoff_query(self) -> RenderedQuery:
        return RenderedQuery(self.base_url + "/historical/cutoff", {}, label="historical cutoff")

    def render_queries(self, race: Race, window: Window, cutoff_ts: int | None = None) -> list[RenderedQuery]:
        """One query per endpoint and time range. Without a known cutoff, both endpoints cover the window
        (the logged queries then show the plan; fetch() splits at the cutoff it reads)."""
        lo, hi = _ts(window.start_dt), _ts(window.end_exclusive_dt)
        m = race.kalshi.followed_market
        out = []
        cut = hi if cutoff_ts is None else max(lo, min(cutoff_ts, hi))
        hist_hi = cut if cutoff_ts is not None else hi
        if lo < hist_hi:
            out.append(RenderedQuery(self.base_url + "/historical/trades",
                                     {"ticker": m, "min_ts": lo, "max_ts": hist_hi, "limit": self.page_limit},
                                     label="historical trades"))
        live_lo = cut if cutoff_ts is not None else lo
        if live_lo < hi:
            out.append(RenderedQuery(self.base_url + "/markets/trades",
                                     {"ticker": m, "min_ts": live_lo, "max_ts": hi, "limit": self.page_limit},
                                     label="live trades"))
        return out

    def _cutoff(self, race: Race, window: Window) -> int:
        q = self.cutoff_query()
        rec = self.cached_get(race, window, q, "cutoff", "cutoff")
        raw = (rec["body"] or {}).get("trades_created_ts")
        if not raw:
            raise FetchError("Kalshi /historical/cutoff has no trades_created_ts")
        return int(dt.datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp())

    def _plan(self, race: Race, window: Window) -> list[RenderedQuery]:
        if not hasattr(self, "_planned"):
            self.cutoff_ts = self._cutoff(race, window)
            self._planned = self.render_queries(race, window, self.cutoff_ts)
        return self._planned

    def query_summary(self, race: Race, window: Window) -> dict[str, Any]:
        qs = [self.cutoff_query()] + self._plan(race, window)
        h = combine_hashes([q.query_hash for q in self._plan(race, window)])
        return {"query_hash": h, "queries": [q.to_dict() for q in qs],
                "series_query_hash": {SERIES_TRADE_COUNT: h, SERIES_SMALL_TRADE_SHARE: h},
                "cutoff": {"trades_created_ts": iso_utc(dt.datetime.fromtimestamp(self.cutoff_ts, dt.timezone.utc))},
                "pagination": "cursor; each page is one cached request (cursor in the params)"}

    def series_query_hashes(self, race: Race, window: Window) -> dict[str, str]:
        h = combine_hashes([q.query_hash for q in self._plan(race, window)])
        return {SERIES_TRADE_COUNT: h, SERIES_SMALL_TRADE_SHARE: h}

    def fetch_raw(self, race: Race, window: Window) -> tuple[list[dict[str, Any]], list[str], dict[str, int]]:
        qs = self._plan(race, window)
        dir_hash = combine_hashes([q.query_hash for q in qs])
        trades, fetched, pages = [], [], {}
        for q in qs:
            cursor, page = None, 0
            kind = "historical" if "/historical/" in q.endpoint else "live"
            while True:
                params = dict(q.params)
                if cursor:
                    params["cursor"] = cursor
                pq = RenderedQuery(q.endpoint, params, q.label)
                rec = self.cached_get(race, window, pq, dir_hash, "%s_page_%04d" % (kind, page))
                body = rec["body"]
                if not isinstance(body, dict) or "trades" not in body:
                    raise FetchError("Kalshi %s: response has no 'trades' key" % q.label)
                trades.extend(body["trades"] or [])
                fetched.append(rec["fetched_at"])
                page += 1
                cursor = body.get("cursor")
                if not cursor or not body["trades"]:
                    break
            pages[kind] = page
        return trades, fetched, pages

    def fetch(self, race: Race, window: Window) -> list[Row]:
        trades, fetched, pages = self.fetch_raw(race, window)
        h = self.series_query_hashes(race, window)[SERIES_TRADE_COUNT]
        fetched_at = max(fetched) if fetched else ""
        lo, hi = window.start_dt, window.end_exclusive_dt
        seen: set[str] = set()
        counts: dict[dt.datetime, list[int]] = {}
        blocks = dupes = outside = 0
        for t in trades:
            tid = t.get("trade_id")
            if tid in seen:
                dupes += 1
                continue
            seen.add(tid)
            ts = dt.datetime.fromisoformat(t["created_time"].replace("Z", "+00:00")).astimezone(dt.timezone.utc)
            if not lo <= ts < hi:
                outside += 1
                continue
            if t.get("is_block_trade"):
                blocks += 1
                if self.block_trades == "exclude":
                    continue
            hour = ts.replace(minute=0, second=0, microsecond=0)
            c = counts.setdefault(hour, [0, 0])
            c[0] += 1
            if (_num(t.get("count_fp")) or 0.0) < self.small_trade_threshold:
                c[1] += 1
        rows = []
        hour = lo
        while hour < hi:  # every hour in the window: a trade count of 0 is a real 0
            n, small = counts.get(hour, (0, 0))
            rows.append(Row(race.race_id, "kalshi", SERIES_TRADE_COUNT, hour, "hour", float(n), "trades", h, fetched_at))
            rows.append(Row(race.race_id, "kalshi", SERIES_SMALL_TRADE_SHARE, hour, "hour",
                            (small / n) if n else None, "share_of_trades", h, fetched_at))
            hour += dt.timedelta(hours=1)
        self.stats = {"trades_in_window": sum(c[0] for c in counts.values()), "block_trades_seen": blocks,
                      "block_trades": self.block_trades,
                      "block_trades_excluded": blocks if self.block_trades == "exclude" else 0,
                      "duplicate_trade_ids_dropped": dupes, "trades_outside_window": outside,
                      "small_trade_threshold_contracts": self.small_trade_threshold, "pages": pages,
                      "cutoff_trades_created_ts": iso_utc(dt.datetime.fromtimestamp(self.cutoff_ts, dt.timezone.utc))}
        return rows

    def daily_values(self, rows):
        # quality: a day is present if the hourly buckets exist; share can be null on quiet hours
        out = {}
        for r in rows:
            d = r.ts_utc.date()
            out[d] = (out.get(d) or 0.0) + (r.value or 0.0)
        return out

    def check_near_zero(self, series: str) -> bool:
        return False  # a quiet hour or day with 0 trades is a real 0

    def quality(self, rows, window):
        q = super().quality(rows, window)
        for name in q:
            q[name].extra.update(self.stats)
        return q
