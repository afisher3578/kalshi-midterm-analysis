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

    def fetch_candles(self, race: Race, window: Window) -> tuple[list[dict[str, Any]], list[str]]:
        """Raw candles from every chunk (cached), plus the fetched_at of each chunk."""
        qs = self.render_queries(race, window)
        dir_hash = combine_hashes([q.query_hash for q in qs])
        candles, fetched = [], []
        for q in qs:
            rec = self.cached_get(race, window, q, dir_hash, "chunk_%d_%d" % (q.params["start_ts"], q.params["end_ts"]))
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

    # ---------------------------------------------------------------- M2
    def fetch_trades(self, race: Race, window: Window) -> list[Row]:
        """M2 STUB: kalshi/trade_count and kalshi/small_trade_share (hourly).

        Plan: GET /markets/trades for live data and /historical/trades before the cutoff from
        GET /historical/cutoff; count trades per hour and the share with count_fp under a configurable
        threshold (default 10 contracts)."""
        raise NotImplementedError("Kalshi trades (trade_count, small_trade_share) are milestone M2")
