"""Connector contract, normalized Row, cost estimate and rendered query (spec section 6)."""
from __future__ import annotations

import datetime as dt
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

from raceattn.cache import Cache, combine_hashes, query_hash
from raceattn.config import Race, Window
from raceattn.http import HttpClient
from raceattn.metrics.quality import Quality, compute_quality


def iso_utc(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_utc() -> str:
    return iso_utc(dt.datetime.now(dt.timezone.utc))


@dataclass(frozen=True)
class Row:
    race_id: str
    source: str
    series: str
    ts_utc: dt.datetime
    granularity: str  # "hour" | "day"
    value: Optional[float]
    unit: str
    query_hash: str
    fetched_at: str

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["ts_utc"] = iso_utc(self.ts_utc)
        return d


@dataclass(frozen=True)
class Estimate:
    usd: float
    requests: int
    note: str = ""


@dataclass(frozen=True)
class RenderedQuery:
    """One request as it will be sent. This is what gets logged and hashed."""

    endpoint: str
    params: dict[str, Any] = field(default_factory=dict)
    label: str = ""

    @property
    def query_hash(self) -> str:
        return query_hash(self.endpoint, self.params)

    def to_dict(self) -> dict[str, Any]:
        return {"label": self.label, "endpoint": self.endpoint, "params": dict(self.params),
                "query_hash": self.query_hash}


class Connector:
    id: str = ""
    auth: str = "none"  # "none" | "api_key" | "bearer_token" | "oauth" | "approval"
    granularity: list[str] = []
    cost_model: str = "free"

    def __init__(self, http: HttpClient | None = None, cache: Cache | None = None, refresh: bool = False):
        self.http = http or HttpClient()
        self.cache = cache
        self.refresh = refresh
        self.cache_hits = 0
        self.fetches = 0

    # -- query rendering: the only place a connector builds its requests
    def render_queries(self, race: Race, window: Window) -> list[RenderedQuery]:
        raise NotImplementedError

    def series_query_hashes(self, race: Race, window: Window) -> dict[str, str]:
        """Series name -> query hash of the request(s) behind it."""
        raise NotImplementedError

    def query_summary(self, race: Race, window: Window) -> dict[str, Any]:
        qs = self.render_queries(race, window)
        return {"query_hash": combine_hashes([q.query_hash for q in qs]),
                "queries": [q.to_dict() for q in qs],
                "series_query_hash": self.series_query_hashes(race, window)}

    def estimate_cost(self, race: Race) -> Estimate:
        return Estimate(usd=0.0, requests=len(self.render_queries(race, race.window)), note=self.cost_model)

    def fetch(self, race: Race, window: Window) -> list[Row]:
        raise NotImplementedError

    def quality(self, rows: list[Row], window: Window) -> dict[str, Quality]:
        """Quality per series, on daily buckets. Override check_near_zero per series as needed."""
        by_series: dict[str, list[Row]] = defaultdict(list)
        for r in rows:
            by_series[r.series].append(r)
        out = {}
        for name, rs in by_series.items():
            out[name] = compute_quality(self.daily_values(rs), window.days(), check_near_zero=self.check_near_zero(name))
        return out

    def check_near_zero(self, series: str) -> bool:
        return True

    @staticmethod
    def daily_values(rows: list[Row]) -> dict[dt.date, Optional[float]]:
        """Daily buckets for quality: sum of present values per UTC date."""
        out: dict[dt.date, Optional[float]] = {}
        for r in rows:
            if r.value is None:
                continue
            d = r.ts_utc.astimezone(dt.timezone.utc).date()
            out[d] = (out.get(d) or 0.0) + r.value
        return out

    # -- cached GET
    def cached_get(self, race: Race, window: Window, q: RenderedQuery, dir_hash: str, name: str,
                   ok_status: tuple[int, ...] = (200,)) -> dict[str, Any]:
        """Return the cache record for a request, fetching it only if missing or --refresh."""
        path = self.cache.path(self.id, race.race_id, window.label, dir_hash, name) if self.cache else None
        if path and not self.refresh:
            rec = self.cache.get(path)
            if rec is not None:
                self.cache_hits += 1
                return rec
        status, body = self.http.get_json(q.endpoint, q.params, ok_status=ok_status)
        self.fetches += 1
        rec = {"request": {"endpoint": q.endpoint, "params": dict(q.params)}, "query_hash": q.query_hash,
               "status": status, "fetched_at": now_utc(), "body": body}
        if path:
            self.cache.put(path, rec)
        return rec
