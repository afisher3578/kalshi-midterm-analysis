"""X (Twitter) post counts with the user's own bearer token (spec section 6). Paid: pay-per-use.

The token comes from the environment (X_BEARER_TOKEN) at request time and goes into an Authorization header built
inside this process. It is never put in argv, URLs, logs, exceptions, cache records or output JSON.

Endpoint order: GET /2/tweets/counts/all (full archive, granularity=hour). If X refuses it (for example 403 on a
plan without full-archive access), the exact error body is printed (it contains no token) and the connector falls
back to GET /2/tweets/counts/recent (last 7 days only) and marks the series `degraded` with the reason.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
from typing import Any

from raceattn.cache import combine_hashes
from raceattn.config import Race, Window
from raceattn.connectors.base import Connector, Estimate, RenderedQuery, Row, iso_utc
from raceattn.http import FetchError
from raceattn.metrics.quality import worst

BASE_URL = "https://api.x.com/2/tweets/counts"
SERIES = "x/post_count"
QUERY_SUFFIX = "lang:en -is:retweet"
HOURS_PER_PAGE = 744  # hour granularity returns up to 31 days of buckets per page (docs.x.com, see docs/sources/x.md)
# Pay-per-use prices from https://docs.x.com/x-api/getting-started/pricing as read on the date in docs/sources/x.md:
# "Counts: All $0.010 per request", "Counts: Recent $0.005 per request". Re-check before a large pull.
PRICE_PER_REQUEST = {"all": 0.010, "recent": 0.005}
RECENT_DAYS = 7
MAX_QUERY_LEN = {"all": 1024, "recent": 512}  # self-serve limits per the X docs
REFUSED_STATUS = (400, 401, 402, 403, 404, 429)  # returned to us (not raised) so the body can be shown


def render_query(race: Race) -> str:
    """The one place the X query is built: every entity name and alias as a quoted phrase, OR-joined,
    plus `lang:en -is:retweet`."""
    terms: list[str] = []
    for e in race.entities:
        for t in (e.name,) + tuple(e.aliases):
            t = t.replace('"', "").strip()
            if t and t not in terms:
                terms.append(t)
    return "(%s) %s" % (" OR ".join('"%s"' % t for t in terms), QUERY_SUFFIX)


def _parse_ts(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone.utc)


class XConnector(Connector):
    id = "x"
    auth = "bearer_token"
    granularity = ["hour"]
    cost_model = ("pay-per-use: counts/all $%.3f per request, counts/recent $%.3f per request (prices from a "
                  "docs read, see docs/sources/x.md; not confirmed against a bill)" % (PRICE_PER_REQUEST["all"], PRICE_PER_REQUEST["recent"]))
    env_keys = ("X_BEARER_TOKEN",)

    def __init__(self, *a, base_url: str = BASE_URL, now: dt.datetime | None = None, **kw):
        super().__init__(*a, **kw)
        self.base_url = base_url
        self._now = now
        self.mode = "all"
        self.degraded_reason: str | None = None
        self.refusal: dict[str, Any] | None = None

    def now(self) -> dt.datetime:
        return self._now or dt.datetime.now(dt.timezone.utc)

    def _headers(self) -> dict[str, str]:
        token = self.secret("X_BEARER_TOKEN")
        if not token:
            raise FetchError("X_BEARER_TOKEN is not set")
        return {"Authorization": "Bearer " + token}

    def _range(self, window: Window, mode: str) -> tuple[dt.datetime, dt.datetime]:
        start, end = window.start_dt, window.end_exclusive_dt
        if mode == "recent":
            # counts/recent: start_time must be within the last 7 days; end_time at least 10 s before now
            now = self.now().replace(microsecond=0)
            start = max(start, (now - dt.timedelta(days=RECENT_DAYS) + dt.timedelta(minutes=5)).replace(
                minute=0, second=0) + dt.timedelta(hours=1))
            end = min(end, now - dt.timedelta(seconds=30))
        return start, end

    def render_queries(self, race: Race, window: Window, mode: str | None = None) -> list[RenderedQuery]:
        mode = mode or self.mode
        start, end = self._range(window, mode)
        if start >= end:
            return []
        return [RenderedQuery("%s/%s" % (self.base_url, mode),
                              {"query": render_query(race), "granularity": "hour",
                               "start_time": iso_utc(start), "end_time": iso_utc(end)},
                              label="counts/%s" % mode)]

    def series_query_hashes(self, race: Race, window: Window) -> dict[str, str]:
        return {SERIES: combine_hashes([q.query_hash for q in self.render_queries(race, window)])}

    def query_summary(self, race: Race, window: Window) -> dict[str, Any]:
        s = super().query_summary(race, window)
        s.update(query=render_query(race), mode=self.mode, pagination="next_token; one cached request per page")
        if self.refusal:
            s["counts_all_refused"] = self.refusal
        return s

    def pages_needed(self, window: Window, mode: str = "all") -> int:
        start, end = self._range(window, mode)
        hours = max(0, math.ceil((end - start).total_seconds() / 3600))
        return math.ceil(hours / HOURS_PER_PAGE) if hours else 0

    def _cached_pages(self, race: Race, window: Window) -> int:
        if not self.cache:
            return 0
        qs = self.render_queries(race, window, "all")
        if not qs:
            return 0
        n = 0
        while self.cache.get(self.cache.path(self.id, race.race_id, window.label, qs[0].query_hash,
                                             "page_%04d" % n)) is not None:
            n += 1
        return n

    def estimate_cost(self, race: Race) -> Estimate:
        """requests x price per request. Counts/all first; cached pages are never re-pulled and cost nothing.
        The fallback (counts/recent) would add at most one more request."""
        window = race.window
        pages = self.pages_needed(window, "all")
        cached = min(self._cached_pages(race, window), pages)
        need = pages - cached
        usd = need * PRICE_PER_REQUEST["all"]
        return Estimate(usd=round(usd, 4), requests=need,
                        note="%d page(s) of up to %d hourly buckets at $%.3f per request (counts/all), %d already "
                             "cached; if counts/all is refused, counts/recent costs $%.3f per request. Prices "
                             "from a docs read, not confirmed against a bill." % (pages, HOURS_PER_PAGE, PRICE_PER_REQUEST["all"],
                                                                     cached, PRICE_PER_REQUEST["recent"]))

    def _pull(self, race: Race, window: Window, q: RenderedQuery, headers: dict[str, str]):
        """All pages for one rendered query. Returns (records, refused_record_or_None)."""
        recs, token, page = [], None, 0
        while True:
            params = dict(q.params)
            if token:
                params["next_token"] = token
            pq = RenderedQuery(q.endpoint, params, q.label)
            rec = self.cached_get(race, window, pq, q.query_hash, "page_%04d" % page,
                                  ok_status=(200,) + REFUSED_STATUS, headers=headers)
            if rec["status"] != 200:
                if self.cache:  # a refusal is not a paid read: drop it so a later run can try again
                    path = self.cache.path(self.id, race.race_id, window.label, q.query_hash, "page_%04d" % page)
                    if os.path.isfile(path):
                        os.remove(path)
                return recs, rec
            recs.append(rec)
            token = ((rec["body"] or {}).get("meta") or {}).get("next_token")
            page += 1
            if not token:
                return recs, None

    def fetch(self, race: Race, window: Window) -> list[Row]:
        headers = self._headers()
        self.mode = "all"
        qs = self.render_queries(race, window, "all")
        recs, refused = self._pull(race, window, qs[0], headers)
        if refused is not None:
            body = json.dumps(refused["body"], sort_keys=True)
            self.refusal = {"status": refused["status"], "body": refused["body"]}
            self.log("x: counts/all refused with HTTP %d. Exact error body from X:\n%s" % (refused["status"], body))
            if refused["status"] in (401,):
                raise FetchError("X rejected the bearer token (HTTP 401). Check X_BEARER_TOKEN. Body: %s" % body)
            self.mode = "recent"
            self.degraded_reason = ("counts/all refused (HTTP %d); fell back to counts/recent, which covers only "
                                    "the last %d days" % (refused["status"], RECENT_DAYS))
            self.log("x: falling back to counts/recent (last %d days); series marked degraded" % RECENT_DAYS)
            qs = self.render_queries(race, window, "recent")
            recs = []
            if qs:
                recs, refused2 = self._pull(race, window, qs[0], headers)
                if refused2 is not None:
                    raise FetchError("X counts/recent also refused (HTTP %d): %s"
                                     % (refused2["status"], json.dumps(refused2["body"], sort_keys=True)))
            else:
                self.degraded_reason += "; the window has no overlap with the last %d days" % RECENT_DAYS
        h = combine_hashes([q.query_hash for q in qs]) if qs else ""
        rows, fetched = [], [r["fetched_at"] for r in recs]
        fetched_at = max(fetched) if fetched else ""
        seen = set()
        lo, hi = window.start_dt, window.end_exclusive_dt
        for rec in recs:
            for b in (rec["body"] or {}).get("data") or []:
                t = _parse_ts(b["start"])
                if t in seen or not lo <= t < hi:
                    continue
                seen.add(t)
                # the docs show both spellings: tweet_count (guide example) and post_count (API reference)
                v = b.get("tweet_count", b.get("post_count"))
                rows.append(Row(race.race_id, self.id, SERIES, t, "hour", None if v is None else float(v), "posts",
                                h, fetched_at))
        rows.sort(key=lambda r: r.ts_utc)
        self.pages_fetched = len(recs)
        return rows

    def quality(self, rows, window):
        q = super().quality(rows, window)
        if SERIES not in q:
            from raceattn.metrics.quality import compute_quality

            q[SERIES] = compute_quality({}, window.days())
        qq = q[SERIES]
        qq.extra.update({"mode": "counts/" + self.mode, "hours": len(rows), "window_hours": window.n_days * 24})
        if self.degraded_reason:
            qq.status = worst(qq.status, "degraded")
            qq.reasons.append(self.degraded_reason)
        return q
