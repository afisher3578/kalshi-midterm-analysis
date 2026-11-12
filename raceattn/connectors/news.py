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
    """Media Cloud search API, two paths:

    - With config/queries/<race_id>.mediacloud.yaml (raceattn/mcqueries.py): one count-over-time request per query
      and per collection that has an id. Series per query and collection key:
        news_mediacloud/<query>/<collection>              daily story count (attention)
        news_mediacloud/<query>/<collection>/ratio        Media Cloud's ratio (matches / all stories that day)
        news_mediacloud/<query>/<collection>/total_count  all stories in the collection that day
      and per derived entry in the config (shares and ratios, section 4):
        news_mediacloud/<derived>/<collection>
      Ratio, total_count, derived series and derived-support queries are context series: shown and quality
      checked, not used as attention in the lag and event metrics. A collection with a null id is skipped and
      reported as not configured. A date the API returns with count 0 is 0; a date it leaves out is missing.
    - Without the file: the old single request for news_query over the US national collection, unchanged.
    """

    id = "news_mediacloud"
    auth = "api_key"
    cost_model = "free"
    env_keys = ("MEDIACLOUD_API_KEY",)
    series = "news_mediacloud/story_count"
    unit = "stories"
    base_url = "https://search.mediacloud.org/api/search/count-over-time"
    US_NATIONAL = 34412234
    PLATFORM = "onlinenews-mediacloud"

    def __init__(self, *a, collections: list[int] | None = None, pace_seconds: float = 30.0,
                 queries_dir: str | None = None, sleep=None, **kw):
        super().__init__(*a, **kw)
        from raceattn import mcqueries
        from raceattn.mediacloud import PacedHttp

        self.collections = list(collections or [self.US_NATIONAL])
        self.queries_dir = queries_dir or mcqueries.QUERIES_DIR
        self.http = PacedHttp(self.http, pace_seconds, **({"sleep": sleep} if sleep else {}))
        self.context_series: set[str] = set()
        self.derived_nulls: dict[str, dict[str, str]] = {}
        self._cfg: dict[str, Any] = {}
        self._active = None  # the query config of the last config-path fetch (quality() has no race argument)

    def query_config(self, race):
        """The race's Media Cloud query config, or None for the old news_query path."""
        from raceattn import mcqueries

        if race.race_id not in self._cfg:
            self._cfg[race.race_id] = mcqueries.find(race.race_id, self.queries_dir)
        return self._cfg[race.race_id]

    # -- old path (no query file)
    def _render_news_query(self, race, window):
        return [RenderedQuery(self.base_url, {"q": news_query(race), "start": window.start.isoformat(),
                                              "end": window.end.isoformat(), "platform": self.PLATFORM,
                                              "cs": ",".join(str(c) for c in self.collections)},
                              label="count-over-time")]

    def _fetch_news_query(self, race, window):
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

    # -- query-config path
    def _requests(self, cfg, window):
        """(query name, collection, RenderedQuery) for every query and configured collection, in file order."""
        out = []
        for name, q in cfg.queries.items():
            for c in cfg.configured_collections:
                out.append((name, c, RenderedQuery(self.base_url, {
                    "q": q, "start": window.start.isoformat(), "end": window.end.isoformat(),
                    "platform": cfg.platform, "cs": str(c.id)}, label="%s/%s" % (name, c.key))))
        return out

    @staticmethod
    def count_series(name, ckey, kind=None):
        return "news_mediacloud/%s/%s%s" % (name, ckey, "/" + kind if kind else "")

    def render_queries(self, race, window):
        cfg = self.query_config(race)
        if cfg is None:
            return self._render_news_query(race, window)
        return [q for _, _, q in self._requests(cfg, window)]

    def series_query_hashes(self, race, window):
        cfg = self.query_config(race)
        if cfg is None:
            return super().series_query_hashes(race, window)
        out, by_query = {}, {}
        for name, c, q in self._requests(cfg, window):
            by_query[(name, c.key)] = q.query_hash
            for kind in (None, "ratio", "total_count"):
                out[self.count_series(name, c.key, kind)] = q.query_hash
        for d in cfg.derived:
            for c in cfg.configured_collections:
                out[self.count_series(d.name, c.key)] = combine_hashes([by_query[(r, c.key)] for r in d.refs.values()])
        return out

    def query_summary(self, race, window):
        cfg = self.query_config(race)
        if cfg is None:
            return super().query_summary(race, window)
        s = Connector.query_summary(self, race, window)
        s["key_handling"] = "key sent in the Authorization header at request time only; not in these params, the hash or the cache"
        per: dict[str, Any] = {}
        hashes = s["series_query_hash"]
        for name, q in cfg.queries.items():
            role = ("derived_support" if name in cfg.derived_support else
                    "core" if name in cfg.core_queries else "series")
            entry = {"query": q, "query_sha256": cfg.query_hash(name), "role": role, "collections": {}}
            for c in cfg.collections:
                ce = {"collection_id": c.id, "collection_name": c.name, "config_version": cfg.version,
                      "config_status": cfg.status, "config_sha256": cfg.config_sha256}
                if c.configured:
                    ce.update(status="fetched", request_hash=hashes[self.count_series(name, c.key)],
                              series={"count": self.count_series(name, c.key),
                                      "ratio": self.count_series(name, c.key, "ratio"),
                                      "total_count": self.count_series(name, c.key, "total_count")})
                else:
                    ce.update(status="not configured", note="no collection id in the query config; no request "
                              "made and no series (not a zero)")
                entry["collections"][c.key] = ce
            per[name] = entry
        s["mediacloud"] = dict(cfg.summary(), queries=per, derived_nulls=self.derived_nulls,
                               series_design="news_mediacloud/<query>/<collection> is the daily story count; "
                               "/ratio and /total_count are Media Cloud's normalized ratio and the collection's "
                               "total stories that day; news_mediacloud/<derived>/<collection> are the derived "
                               "shares and ratios. Only counts of non-support queries enter the lag and event "
                               "metrics.")
        return s

    def fetch(self, race, window):
        cfg = self.query_config(race)
        rows = self._fetch_news_query(race, window) if cfg is None else self._fetch_config(cfg, race, window)
        self.log("   news_mediacloud: %d HTTP request(s) made, %d cache hit(s)" % (self.http.requests, self.cache_hits))
        return rows

    def _fetch_config(self, cfg, race, window):
        days = window.days()
        dayset = set(days)
        for c in cfg.unconfigured_collections:
            self.log("   news_mediacloud: collection %s not configured (no id in %s); skipped, not counted as zero"
                     % (c.key, os.path.basename(cfg.path or "")))
        self._active = cfg
        headers = {"Authorization": "Token " + self.secret("MEDIACLOUD_API_KEY")}
        rows: list[Row] = []
        counts: dict[tuple[str, str], dict[dt.date, float]] = {}
        self.expected_series: list[str] = []
        self.context_series = set()
        for name, c, q in self._requests(cfg, window):
            rec = self.cached_get(race, window, q, q.query_hash, "count_over_time", headers=headers)
            entries = (((rec["body"] or {}).get("count_over_time") or {}).get("counts"))
            if entries is None:
                raise FetchError("Media Cloud response for %s/%s has no count_over_time.counts" % (name, c.key))
            cs, rs, ts = (self.count_series(name, c.key, k) for k in (None, "ratio", "total_count"))
            self.expected_series += [cs, rs, ts]
            self.context_series |= {rs, ts}
            if name in cfg.derived_support:
                self.context_series.add(cs)
            per: dict[dt.date, float] = {}
            for e in entries:
                d = dt.date.fromisoformat(str(e["date"])[:10])
                if d not in dayset:
                    continue
                if d in per:
                    raise FetchError("Media Cloud returned %s twice for %s/%s" % (d, name, c.key))
                for series, field, unit in ((cs, "count", "stories"), (rs, "ratio", "ratio"),
                                            (ts, "total_count", "stories")):
                    if e.get(field) is not None:
                        rows.append(Row(race.race_id, self.id, series, _day(d), "day", float(e[field]), unit,
                                        q.query_hash, rec["fetched_at"]))
                if e.get("count") is not None:
                    per[d] = float(e["count"])
            counts[(name, c.key)] = per
        hashes = self.series_query_hashes(race, window)
        fetched_at = max(r.fetched_at for r in rows) if rows else now_utc()
        self.derived_nulls = {}
        for dv in cfg.derived:
            for c in cfg.configured_collections:
                s = self.count_series(dv.name, c.key)
                self.expected_series.append(s)
                self.context_series.add(s)
                nulls: dict[str, str] = {}
                for d in days:
                    v, why = derive(dv.kind, dv.refs, {k: counts[(ref, c.key)].get(d) for k, ref in dv.refs.items()})
                    if v is None:
                        nulls[d.isoformat()] = why
                    else:
                        rows.append(Row(race.race_id, self.id, s, _day(d), "day", round(v, 6), "share", hashes[s],
                                        fetched_at))
                self.derived_nulls[s] = nulls
        return rows

    def quality(self, rows, window):
        cfg = self._active
        if cfg is None:
            return super().quality(rows, window)
        by: dict[str, list[Row]] = {}
        for r in rows:
            by.setdefault(r.series, []).append(r)
        days = window.days()
        a0, a1 = cfg.phase("analysis")
        adays = [d for d in days if a0 <= d <= a1]
        out = {}
        for s in self.expected_series:
            daily = self.daily_values(by.get(s, []))
            derived = s in self.derived_nulls
            q = compute_quality(daily, days, check_near_zero=not derived, min_near_zero_days=2)
            present = sum(1 for d in adays if daily.get(d) is not None)
            q.extra["analysis_phase"] = {"start": a0.isoformat(), "end": a1.isoformat(), "days": len(adays),
                                         "present": present}
            q.extra["gate"] = ("docs/mediacloud-search-criteria.md section 7: at least 95% of the analysis-phase "
                               "days present; near-zero stretches of 2 or more days; explicit zeros are real zeros, "
                               "missing dates are missing")
            if adays and present / len(adays) < 0.95:
                q.status = worst(q.status, "degraded")
                q.reasons.append("analysis phase coverage %d/%d days is under 95%%" % (present, len(adays)))
            if derived:
                q.extra["null_days"] = self.derived_nulls[s]
            else:
                q.extra["explicit_zero_days"] = sorted(d.isoformat() for d, v in daily.items() if v == 0)
            out[s] = q
        return out


def derive(kind: str, refs: dict[str, str], vals: dict[str, Optional[float]]) -> tuple[Optional[float], str]:
    """One derived value from one day's counts (docs/mediacloud-search-criteria.md section 4).
    share: a / (a + b); exclusive_share: (a - both) / ((a - both) + (b - both)); ratio: numerator / denominator.
    Returns (value, "") or (None, reason). A zero denominator gives None, never 0 or inf."""
    missing = [refs[k] for k, v in vals.items() if v is None]
    if missing:
        return None, "input missing for this date: %s" % ", ".join(missing)
    if kind == "share":
        a, b = vals["numerator"], vals["other"]
        if a + b == 0:
            return None, "denominator is 0 (%s + %s = 0)" % (refs["numerator"], refs["other"])
        return a / (a + b), ""
    if kind == "exclusive_share":
        a, b, both = vals["numerator"] - vals["both"], vals["other"] - vals["both"], vals["both"]
        if a < 0 or b < 0:
            return None, "inconsistent counts: %s (%g) is larger than %s or %s" % (refs["both"], both, refs["numerator"],
                                                                                 refs["other"])
        if a + b == 0:
            return None, "denominator is 0 (only-%s + only-%s = 0)" % (refs["numerator"], refs["other"])
        return a / (a + b), ""
    if kind == "ratio":
        if vals["denominator"] == 0:
            return None, "denominator is 0 (%s = 0)" % refs["denominator"]
        return vals["numerator"] / vals["denominator"], ""
    raise ValueError("unknown derived kind %r" % kind)


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
