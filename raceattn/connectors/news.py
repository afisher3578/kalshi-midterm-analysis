"""News connectors (spec section 6): Media Cloud, Guardian, NYT, a manual CSV import and optional GDELT.

All of them render the query from the race config's `news_query` (falling back to the OR-joined entity names) in
one place, `news_query()`. API keys passed as query params (Guardian, NYT) go in `secret_params`: they are added
to the request at send time only, so the logged params, the query hash, the cache key and the cache record never
contain the key, and HttpClient redacts the key from any error message.
"""
from __future__ import annotations

import csv
import datetime as dt
import os
from typing import Any, Optional

from raceattn.cache import combine_hashes, query_hash
from raceattn.config import Race, Window
from raceattn.connectors.base import Connector, RenderedQuery, Row, now_utc
from raceattn.http import FetchError, HttpClient
from raceattn.metrics.quality import compute_quality, worst

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MANUAL_DIR = os.path.join(ROOT, "data", "raw", "news_manual")


def news_query(race: Race) -> str:
    """The one place the news query is chosen: news_query from the config, else entity names OR-joined."""
    if race.news_query:
        return race.news_query
    return " OR ".join('"%s"' % e.name.replace('"', "") for e in race.entities)


def spaced_http(http, seconds: float):
    """A dedicated client with at least `seconds` between calls, so one provider's rate limit does not slow the
    others. Test doubles that are not an HttpClient pass through unchanged."""
    if isinstance(http, HttpClient) and http.sleep < seconds:
        return HttpClient(sleep=seconds, max_retries=http.max_retries, backoff=max(http.backoff, 2.0),
                          timeout=http.timeout, session=http.session)
    return http


def _day(d: dt.date) -> dt.datetime:
    return dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc)


class DailyCountConnector(Connector):
    """One request per UTC day; the count comes from the response metadata (`extract`)."""

    granularity = ["day"]
    series = ""
    unit = "articles"

    def render_queries(self, race: Race, window: Window) -> list[RenderedQuery]:
        return [self.day_query(race, d) for d in window.days()]

    def day_query(self, race: Race, d: dt.date) -> RenderedQuery:
        raise NotImplementedError

    def secret_params(self) -> dict[str, str]:
        return {}

    def extract(self, body: Any) -> Optional[float]:
        raise NotImplementedError

    def series_query_hashes(self, race: Race, window: Window) -> dict[str, str]:
        return {self.series: combine_hashes([q.query_hash for q in self.render_queries(race, window)])}

    def query_summary(self, race: Race, window: Window) -> dict[str, Any]:
        s = super().query_summary(race, window)
        s["query"] = news_query(race)
        s["key_handling"] = "key sent at request time only; not in these params, the hash or the cache"
        return s

    def fetch(self, race: Race, window: Window) -> list[Row]:
        h = self.series_query_hashes(race, window)[self.series]
        rows = []
        secret = self.secret_params()
        for d, q in zip(window.days(), self.render_queries(race, window)):
            rec = self.cached_get(race, window, q, h, d.strftime("day_%Y%m%d"), secret_params=secret or None)
            v = self.extract(rec["body"])
            if v is not None:
                rows.append(Row(race.race_id, self.id, self.series, _day(d), "day", float(v), self.unit, h,
                                rec["fetched_at"]))
        return rows

    def quality(self, rows, window):
        q = super().quality(rows, window)
        if self.series not in q:
            q[self.series] = compute_quality({}, window.days())
        return q


class GuardianConnector(DailyCountConnector):
    """content.guardianapis.com/search, one request per day, count from response.total. One outlet only."""

    id = "news_guardian"
    auth = "api_key"
    cost_model = "free"
    env_keys = ("GUARDIAN_API_KEY",)
    series = "news_guardian/article_count"
    base_url = "https://content.guardianapis.com/search"

    def __init__(self, *a, sleep_seconds: float = 1.1, **kw):
        super().__init__(*a, **kw)
        self.http = spaced_http(self.http, sleep_seconds)  # developer key: up to 1 call per second

    def day_query(self, race, d):
        return RenderedQuery(self.base_url, {"q": news_query(race), "from-date": d.isoformat(),
                                             "to-date": d.isoformat(), "use-date": "published", "page-size": 1},
                             label=d.isoformat())

    def secret_params(self):
        return {"api-key": self.secret("GUARDIAN_API_KEY")}

    def extract(self, body):
        r = (body or {}).get("response") or {}
        if r.get("status") not in (None, "ok"):
            raise FetchError("Guardian response status %r: %s" % (r.get("status"), r.get("message", "")))
        return r.get("total")


class NytConnector(DailyCountConnector):
    """NYT Article Search, one request per day, hit count from the response metadata. One outlet only.
    Rate limit (NYT FAQ): 5 requests a minute and 500 a day, so the connector sleeps `sleep_seconds` (default 12)
    between calls. A 65-day window is 65 calls, about 13 minutes."""

    id = "news_nyt"
    auth = "api_key"
    cost_model = "free"
    env_keys = ("NYT_API_KEY",)
    series = "news_nyt/article_count"
    base_url = "https://api.nytimes.com/svc/search/v2/articlesearch.json"

    def __init__(self, *a, sleep_seconds: float = 12.0, **kw):
        super().__init__(*a, **kw)
        self.http = spaced_http(self.http, sleep_seconds)

    def day_query(self, race, d):
        ymd = d.strftime("%Y%m%d")
        return RenderedQuery(self.base_url, {"q": news_query(race), "begin_date": ymd, "end_date": ymd},
                             label=d.isoformat())

    def secret_params(self):
        return {"api-key": self.secret("NYT_API_KEY")}

    def extract(self, body):
        r = (body or {}).get("response") or {}
        # the published spec says response.meta.hits; some third-party notes say metadata.hits. Accept both.
        for k in ("metadata", "meta"):
            if isinstance(r.get(k), dict) and r[k].get("hits") is not None:
                return r[k]["hits"]
        raise FetchError("NYT response has no response.metadata.hits or response.meta.hits")


class MediaCloudConnector(DailyCountConnector):
    """Media Cloud search API: daily story counts for news_query over a collection (default: US national).
    One request for the whole window (count-over-time returns one entry per day)."""

    id = "news_mediacloud"
    auth = "api_key"
    cost_model = "free"
    env_keys = ("MEDIACLOUD_API_KEY",)
    series = "news_mediacloud/story_count"
    unit = "stories"
    base_url = "https://search.mediacloud.org/api/search/count-over-time"
    US_NATIONAL = 34412234
    PLATFORM = "onlinenews-mediacloud"

    def __init__(self, *a, collections: list[int] | None = None, **kw):
        super().__init__(*a, **kw)
        self.collections = list(collections or [self.US_NATIONAL])

    def render_queries(self, race, window):
        return [RenderedQuery(self.base_url, {"q": news_query(race), "start": window.start.isoformat(),
                                              "end": window.end.isoformat(), "platform": self.PLATFORM,
                                              "cs": ",".join(str(c) for c in self.collections)},
                              label="count-over-time")]

    def fetch(self, race, window):
        q = self.render_queries(race, window)[0]
        h = q.query_hash
        rec = self.cached_get(race, window, q, h, "count_over_time",
                              headers={"Authorization": "Token " + self.secret("MEDIACLOUD_API_KEY")})
        counts = (((rec["body"] or {}).get("count_over_time") or {}).get("counts"))
        if counts is None:
            raise FetchError("Media Cloud response has no count_over_time.counts")
        days = set(window.days())
        rows, self.ratios = [], {}
        for c in counts:
            d = dt.date.fromisoformat(str(c["date"])[:10])
            if d in days and c.get("count") is not None:
                rows.append(Row(race.race_id, self.id, self.series, _day(d), "day", float(c["count"]), self.unit, h,
                                rec["fetched_at"]))
        return rows


class ManualNewsConnector(Connector):
    """A user-supplied export: data/raw/news_manual/<race_id>.csv with a header `date,count`.
    Validated strictly; rows outside the window are ignored and counted. Missing days stay missing."""

    id = "news_manual"
    auth = "none"
    granularity = ["day"]
    cost_model = "free"
    series = "news_manual/story_count"

    def __init__(self, *a, manual_dir: str = MANUAL_DIR, **kw):
        super().__init__(*a, **kw)
        self.manual_dir = manual_dir

    def path(self, race: Race) -> str:
        return os.path.join(self.manual_dir, race.race_id + ".csv")

    def skip_reason(self, race):
        if not os.path.isfile(self.path(race)):
            return "missing manual CSV: put a `date,count` export at %s" % os.path.relpath(self.path(race), ROOT)
        return None

    def render_queries(self, race, window):
        return [RenderedQuery("file:" + os.path.relpath(self.path(race), ROOT), {"sha256": self._file_hash(race)},
                              label="manual CSV")]

    def _file_hash(self, race):
        import hashlib

        with open(self.path(race), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:16]

    def series_query_hashes(self, race, window):
        return {self.series: self.render_queries(race, window)[0].query_hash}

    def read(self, race: Race) -> dict[dt.date, float]:
        path = self.path(race)
        out: dict[dt.date, float] = {}
        with open(path, encoding="utf-8-sig", newline="") as f:
            reader = csv.reader(f)
            header = [h.strip().lower() for h in next(reader, [])]
            if header[:2] != ["date", "count"]:
                raise FetchError("%s: header must be `date,count`, got %r" % (path, ",".join(header)))
            for i, row in enumerate(reader, 2):
                if not row or not "".join(row).strip():
                    continue
                if len(row) < 2:
                    raise FetchError("%s line %d: expected date,count" % (path, i))
                try:
                    d = dt.date.fromisoformat(row[0].strip())
                except ValueError:
                    raise FetchError("%s line %d: bad date %r (use YYYY-MM-DD)" % (path, i, row[0]))
                try:
                    v = float(row[1].strip())
                except ValueError:
                    raise FetchError("%s line %d: bad count %r" % (path, i, row[1]))
                if v < 0 or v != int(v):
                    raise FetchError("%s line %d: count must be a non-negative whole number, got %r" % (path, i, row[1]))
                if d in out:
                    raise FetchError("%s line %d: duplicate date %s" % (path, i, d))
                out[d] = v
        return out

    def fetch(self, race, window):
        data = self.read(race)
        h = self.series_query_hashes(race, window)[self.series]
        days = set(window.days())
        self.outside = sum(1 for d in data if d not in days)
        t = now_utc()
        return [Row(race.race_id, self.id, self.series, _day(d), "day", v, "stories", h, t)
                for d, v in sorted(data.items()) if d in days]

    def quality(self, rows, window):
        q = super().quality(rows, window)
        if self.series not in q:
            q[self.series] = compute_quality({}, window.days())
        q[self.series].extra["rows_outside_window_ignored"] = getattr(self, "outside", 0)
        return q


class GdeltConnector(Connector):
    """GDELT DOC 2.0 timelinevolraw, optional and not in the default source list. The pilot found it gappy; the
    quality check usually marks it degraded or unusable. One request per 5 seconds or more."""

    id = "gdelt"
    auth = "none"
    granularity = ["day"]
    cost_model = "free"
    series = "gdelt/article_count"
    base_url = "https://api.gdeltproject.org/api/v2/doc/doc"

    def __init__(self, *a, sleep_seconds: float = 6.0, **kw):
        super().__init__(*a, **kw)
        self.http = spaced_http(self.http, sleep_seconds)

    def render_queries(self, race, window):
        return [RenderedQuery(self.base_url, {"query": news_query(race), "mode": "timelinevolraw", "format": "json",
                                              "startdatetime": window.start.strftime("%Y%m%d000000"),
                                              "enddatetime": window.end.strftime("%Y%m%d235959")},
                              label="timelinevolraw")]

    def series_query_hashes(self, race, window):
        return {self.series: self.render_queries(race, window)[0].query_hash}

    def fetch(self, race, window):
        q = self.render_queries(race, window)[0]
        rec = self.cached_get(race, window, q, q.query_hash, "timeline")
        body = rec["body"] or {}
        tl = body.get("timeline") or []
        days = set(window.days())
        per_day: dict[dt.date, float] = {}
        for item in (tl[0].get("data") if tl else []) or []:
            ds = str(item.get("date", ""))
            try:
                d = dt.date(int(ds[:4]), int(ds[4:6]), int(ds[6:8]))
            except ValueError:
                continue
            if d in days and item.get("value") is not None:
                per_day[d] = per_day.get(d, 0.0) + float(item["value"])
        return [Row(race.race_id, self.id, self.series, _day(d), "day", v, "articles", q.query_hash, rec["fetched_at"])
                for d, v in sorted(per_day.items())]

    def quality(self, rows, window):
        q = super().quality(rows, window)
        if self.series not in q:
            q[self.series] = compute_quality({}, window.days())
        qq = q[self.series]
        qq.status = worst(qq.status, "degraded")
        qq.reasons.append("GDELT is optional: the pilot found gaps and near-zero days; never the default news series")
        return q
