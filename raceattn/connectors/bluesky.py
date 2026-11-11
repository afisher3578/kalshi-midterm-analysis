"""Bluesky post counts from app.bsky.feed.searchPosts (spec section 6). Free; no counts endpoint exists, so the
connector pages through matching posts and keeps only an hourly count.

Modes (see docs/sources/bluesky.md for what was observed live):
- unauthenticated: https://api.bsky.app (public.api.bsky.app returned 403 for search when tested). Cursor
  pagination returned 403 unauthenticated, so the connector pages backwards by moving `until` to the oldest
  timestamp seen and dedupes on uri (`until` is inclusive, so the boundary post comes back once more).
- authenticated: if BSKY_HANDLE and BSKY_APP_PASSWORD are set, createSession on bsky.social gives an access token
  that is kept in memory only; search then uses cursor pagination, and drops to the `until` walk if a cursor
  request is refused.

The search does not support OR (tested: "A OR B" matched far fewer posts than A alone), so each entity term is
searched separately and posts are deduped on uri across terms within each UTC day. Only hourly counts leave
memory: no text, handles, dids or uris are written to the cache or the output.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

from raceattn.cache import combine_hashes
from raceattn.config import Race, Window
from raceattn.connectors.base import Connector, RenderedQuery, Row, iso_utc, now_utc
from raceattn.http import FetchError
from raceattn.metrics.quality import compute_quality, worst

PUBLIC_URL = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts"
PDS_URL = "https://bsky.social"
SERIES = "bluesky/post_count"


def search_terms(race: Race) -> list[str]:
    """The one place the Bluesky query is built: per entity, its aliases (or its name if it has none).
    Multi-word terms are quoted as phrases."""
    out: list[str] = []
    for e in race.entities:
        for t in (e.aliases or (e.name,)):
            t = t.replace('"', "").strip()
            t = '"%s"' % t if " " in t else t
            if t and t not in out:
                out.append(t)
    return out


def _parse(s: str) -> dt.datetime | None:
    try:
        t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t.astimezone(dt.timezone.utc)


def sort_time(post: dict[str, Any]) -> dt.datetime | None:
    """Approximates the search index's sortAt: the earlier of record.createdAt and indexedAt
    (createdAt is set by the client and can be in the future)."""
    c = _parse(((post.get("record") or {}).get("createdAt")) or "")
    i = _parse(post.get("indexedAt") or "")
    ts = [t for t in (c, i) if t is not None]
    return min(ts) if ts else None


def _z(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000)


class BlueskyConnector(Connector):
    id = "bluesky"
    auth = "none"  # app password optional
    granularity = ["hour"]
    cost_model = "free"

    def __init__(self, *a, max_pages_per_day: int = 50, max_pages: int = 6000, page_size: int = 100,
                 lang: str | None = "en", public_url: str = PUBLIC_URL, pds_url: str = PDS_URL, **kw):
        super().__init__(*a, **kw)
        self.max_pages_per_day = int(max_pages_per_day)
        self.max_pages = int(max_pages)
        self.page_size = int(page_size)
        self.lang = lang
        self.public_url = public_url
        self.pds_url = pds_url
        self._access: str | None = None  # in memory only
        self.stats: dict[str, Any] = {}

    @property
    def authenticated(self) -> bool:
        return bool(self.secret("BSKY_HANDLE") and self.secret("BSKY_APP_PASSWORD"))

    @property
    def mode(self) -> str:
        return "authenticated" if self.authenticated else "unauthenticated"

    def search_url(self) -> str:
        return (self.pds_url + "/xrpc/app.bsky.feed.searchPosts") if self.authenticated else self.public_url

    def render_queries(self, race: Race, window: Window) -> list[RenderedQuery]:
        """One query per (term, UTC day). Paging params (until, cursor) are added at fetch time."""
        out = []
        for d in window.days():
            lo = dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc)
            for term in search_terms(race):
                p = {"q": term, "sort": "latest", "since": _z(lo), "until": _z(lo + dt.timedelta(days=1)),
                     "limit": self.page_size}
                if self.lang:
                    p["lang"] = self.lang
                out.append(RenderedQuery("app.bsky.feed.searchPosts", p, label="%s %s" % (term, d.isoformat())))
        return out

    def series_query_hashes(self, race, window):
        return {SERIES: combine_hashes([q.query_hash for q in self.render_queries(race, window)])}

    def query_summary(self, race, window):
        s = super().query_summary(race, window)
        s.update(terms=search_terms(race), mode=self.mode, host=self.search_url().split("/xrpc/")[0],
                 pagination=("cursor, falling back to an until walk" if self.authenticated
                             else "until walk (unauthenticated cursors returned 403)"),
                 max_pages_per_day=self.max_pages_per_day, max_pages=self.max_pages)
        # one line per term instead of one per term and day
        s["queries"] = s["queries"][:len(search_terms(race))]
        s["queries_note"] = "first day shown; the same params repeat for every UTC day in the window"
        return s

    # -- auth
    def _login(self) -> None:
        if self._access or not self.authenticated:
            return
        handle, pw = self.secret("BSKY_HANDLE"), self.secret("BSKY_APP_PASSWORD")
        status, body = self.http.post_json(self.pds_url + "/xrpc/com.atproto.server.createSession",
                                           {"identifier": handle, "password": pw}, secret_values=(pw, handle))
        tok = (body or {}).get("accessJwt")
        if not tok:
            raise FetchError("Bluesky createSession returned no access token")
        self._access = tok

    def _headers(self) -> dict[str, str] | None:
        return {"Authorization": "Bearer " + self._access} if self._access else None

    def _get(self, params: dict[str, Any]) -> tuple[int, Any]:
        headers = self._headers()
        kw = {"headers": headers} if headers else {}
        return self.http.get_json(self.search_url(), params, ok_status=(200, 403), **kw)

    # -- paging
    def _day_counts(self, race: Race, d: dt.date, budget: list[int]) -> dict[str, Any]:
        """Hourly counts for one UTC day across all terms, deduped on uri (in memory)."""
        lo = dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc)
        hi = lo + dt.timedelta(days=1)
        seen: set[str] = set()
        hourly: dict[int, int] = {}
        capped, pages, hits, notes = [], 0, {}, []
        for q in [q for q in self.render_queries(race, Window(d, d))]:
            term = q.params["q"]
            use_cursor = self.authenticated
            cursor, until, term_pages = None, q.params["until"], 0
            while True:
                if term_pages >= self.max_pages_per_day or budget[0] <= 0:
                    capped.append(term)
                    break
                p = dict(q.params)
                if cursor:
                    p["cursor"] = cursor
                else:
                    p["until"] = until
                status, body = self._get(p)
                budget[0] -= 1
                pages += 1
                term_pages += 1
                if status == 403:
                    if cursor:
                        notes.append("cursor request refused (403); switched to the until walk")
                        use_cursor, cursor = False, None
                        continue
                    raise FetchError("Bluesky search returned HTTP 403 for %s (blocked or needs login). Stopping."
                                     % self.search_url().split("/xrpc/")[0])
                posts = (body or {}).get("posts") or []
                if term not in hits and body.get("hitsTotal") is not None:
                    hits[term] = body.get("hitsTotal")
                new, oldest = 0, None
                for post in posts:
                    t = sort_time(post)
                    if t is not None and (oldest is None or t < oldest):
                        oldest = t
                    uri = post.get("uri")
                    if not uri or uri in seen:
                        continue
                    seen.add(uri)
                    if t is None or not lo <= t < hi:
                        continue
                    new += 1
                    hourly[t.hour] = hourly.get(t.hour, 0) + 1
                if not posts:
                    break
                if use_cursor and body.get("cursor"):
                    cursor = body["cursor"]
                    continue
                if use_cursor:
                    break  # no cursor: done
                # until walk: stop when a page brings nothing new or we passed the start of the day
                if new == 0 or oldest is None or oldest <= lo:
                    break
                until = _z(oldest)
        return {"hourly": {str(h): n for h, n in sorted(hourly.items())}, "pages": pages, "capped_terms": capped,
                "hits_total_first_page": hits, "notes": notes, "mode": self.mode, "fetched_at": now_utc()}

    def fetch(self, race: Race, window: Window) -> list[Row]:
        h = self.series_query_hashes(race, window)[SERIES]
        rows, capped_days, pages, from_cache = [], [], 0, 0
        budget = [self.max_pages]
        notes: set[str] = set()
        for d in window.days():
            dq = [q for q in self.render_queries(race, Window(d, d))]
            dh = combine_hashes([q.query_hash for q in dq])
            path = self.cache.path(self.id, race.race_id, window.label, h, "day_%s_%s" % (d.strftime("%Y%m%d"), dh)) \
                if self.cache else None
            rec = self.cache.get(path) if (path and not self.refresh) else None
            if rec is None:
                if budget[0] <= 0:
                    capped_days.append(d.isoformat())
                    continue
                self._login()
                rec = self._day_counts(race, d, budget)
                rec["query_hash"] = dh
                self.fetches += rec["pages"]
                if path:
                    self.cache.put(path, rec)  # counts only: no text, handles, dids or uris
            else:
                from_cache += 1
                self.cache_hits += 1
            pages += rec["pages"]
            notes.update(rec.get("notes") or [])
            if rec["capped_terms"]:
                capped_days.append(d.isoformat())
            for hr in range(24):
                t = dt.datetime(d.year, d.month, d.day, hr, tzinfo=dt.timezone.utc)
                rows.append(Row(race.race_id, self.id, SERIES, t, "hour", float(rec["hourly"].get(str(hr), 0)),
                                "posts", h, rec["fetched_at"]))
        self.stats = {"mode": self.mode, "pages": pages, "days_from_cache": from_cache, "capped_days": capped_days,
                      "max_pages_per_day": self.max_pages_per_day, "max_pages": self.max_pages,
                      "terms": search_terms(race), "notes": sorted(notes)}
        return rows

    def quality(self, rows, window):
        q = super().quality(rows, window)
        if SERIES not in q:
            q[SERIES] = compute_quality({}, window.days())
        qq = q[SERIES]
        qq.extra.update(self.stats)
        capped = self.stats.get("capped_days") or []
        if capped:
            qq.status = worst(qq.status, "degraded")
            qq.reasons.append("page cap hit on %d day(s), so those counts are lower bounds: %s"
                              % (len(capped), ", ".join(capped[:10]) + (" ..." if len(capped) > 10 else "")))
        return q
