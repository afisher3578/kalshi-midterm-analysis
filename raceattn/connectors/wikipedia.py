"""Wikipedia per-article daily pageviews via the Wikimedia REST API (spec section 6). No auth."""
from __future__ import annotations

import datetime as dt
import urllib.parse

from raceattn.cache import combine_hashes
from raceattn.config import Race, Window
from raceattn.connectors.base import Connector, RenderedQuery, Row
from raceattn.metrics.quality import compute_quality

BASE_URL = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article"
PROJECT = "en.wikipedia"
ACCESS = "all-access"
AGENT = "user"
SERIES_PREFIX = "wikipedia/pageviews/"
SERIES_TOTAL = "wikipedia/pageviews_total"


def page_series(title: str) -> str:
    return SERIES_PREFIX + title


class WikipediaConnector(Connector):
    id = "wikipedia"
    auth = "none"
    granularity = ["day"]
    cost_model = "free"

    def __init__(self, *a, base_url: str = BASE_URL, **kw):
        super().__init__(*a, **kw)
        self.base_url = base_url

    def render_queries(self, race: Race, window: Window) -> list[RenderedQuery]:
        start, end = window.start.strftime("%Y%m%d"), window.end.strftime("%Y%m%d")
        return [RenderedQuery("%s/%s/%s/%s/%s/daily/%s/%s" % (self.base_url, PROJECT, ACCESS, AGENT,
                                                              urllib.parse.quote(title, safe=""), start, end),
                              label=title)
                for title in race.wikipedia_pages]

    def series_query_hashes(self, race: Race, window: Window) -> dict[str, str]:
        qs = self.render_queries(race, window)
        out = {page_series(q.label): q.query_hash for q in qs}
        out[SERIES_TOTAL] = combine_hashes([q.query_hash for q in qs])
        return out

    def cache_paths(self, race: Race, window: Window) -> list[str]:
        """Cache file of every page request for this window (used to tell whether a window is fully cached)."""
        return [self.cache.path(self.id, race.race_id, window.label, q.query_hash, "daily")
                for q in self.render_queries(race, window)]

    def fetch(self, race: Race, window: Window) -> list[Row]:
        hashes = self.series_query_hashes(race, window)
        days = set(window.days())
        rows: list[Row] = []
        per_day: dict[dt.date, dict[str, float]] = {}
        fetched = []
        for q in self.render_queries(race, window):
            # 404 means the API has no data for that article and range; it becomes an empty series
            rec = self.cached_get(race, window, q, q.query_hash, "daily", ok_status=(200, 404))
            fetched.append(rec["fetched_at"])
            items = (rec["body"] or {}).get("items", []) if rec["status"] == 200 else []
            name = page_series(q.label)
            for it in items:
                ts = it["timestamp"]
                d = dt.date(int(ts[:4]), int(ts[4:6]), int(ts[6:8]))
                if d not in days:
                    continue
                t = dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc)
                rows.append(Row(race.race_id, self.id, name, t, "day", float(it["views"]), "views",
                                hashes[name], rec["fetched_at"]))
                per_day.setdefault(d, {})[q.label] = float(it["views"])
        # total only on days where every page has a value: a partial sum would hide a gap
        fetched_at = max(fetched) if fetched else ""
        for d in sorted(per_day):
            if len(per_day[d]) == len(race.wikipedia_pages):
                t = dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc)
                total = sum(per_day[d][p] for p in race.wikipedia_pages)
                rows.append(Row(race.race_id, self.id, SERIES_TOTAL, t, "day", total, "views",
                                hashes[SERIES_TOTAL], fetched_at))
        self._empty_pages = [p for p in race.wikipedia_pages if not any(r.series == page_series(p) for r in rows)]
        return rows

    def quality(self, rows, window):
        q = super().quality(rows, window)
        # a page with no rows at all still needs an (unusable) quality entry
        for p in getattr(self, "_empty_pages", []):
            q[page_series(p)] = compute_quality({}, window.days())
        if SERIES_TOTAL not in q:
            q[SERIES_TOTAL] = compute_quality({}, window.days())
        return q
