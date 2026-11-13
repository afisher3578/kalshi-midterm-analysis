"""Media Cloud request handling and the audit workflow (docs/mediacloud-search-criteria.md, sections 5, 6 and 10).

Requests: every response is cached on disk (raceattn/cache.py layout) and reused unless --refresh. Calls are
paced (default 30 s between Media Cloud requests: GET search/api-params gives a query-rate of 2/m for the search
endpoints, and the rate of the other endpoints is not known, so the pace applies to all of them). HTTP 401, 403 and
429 stop the command at once with a message naming the status: no retry, no workaround. The key goes in the
Authorization header at send time only; it is never stored.

Endpoints follow the official python client (https://github.com/mediacloud/api-client, mediacloud/api.py). Checked
against the live API (version 3.2.3) on 2026-11-12, see docs/sources/mediacloud.md:
- GET search/count-over-time  q, start, end, platform, cs -> count_over_time.counts[date, count, total_count, ratio];
                              start and end inclusive, zero days returned explicitly
- GET search/story-list       q, start, end, platform, cs, page_size, pagination_token -> stories, pagination_token;
                              page_size=1000 accepted (one page was enough so far, later pages and the sort order
                              are not checked)
- GET search/count-by-source-over-interval  q, start, end, platform, cs, interval=day -> source-interval-attention
                              [media_name, interval, bucket (date), matching_stories, total_stories, ratio]; one row
                              per source per day, zero rows included; the per-day sum of matching_stories equals the
                              count-over-time count
- GET search/sources          q, start, end, platform, cs -> sources[source, count]
- GET sources/collections/    name, platform, limit, offset -> count, next, results[id, name, source_count, ...]
publish_date is a date with no time or timezone, so days are the publish date as Media Cloud extracted it.

Audit sampling: the story list is paged up to `max_pages` pages; n stories are drawn with random.Random(seed) from
the stories retrieved. That is uniform over the retrieved stories. When the page cap is hit, the retrieved stories
are the first pages in the API's sort order, so the sample is not uniform over every match (the summary says so).
Only metadata is kept (id, date, source, title, url), never story text, and the CSV is written under the
git-ignored data/local/.
"""
from __future__ import annotations

import csv
import json
import os
import random
import re
import time
import unicodedata
import urllib.parse
from collections import defaultdict
from typing import Any, Callable, Iterable

from raceattn.cache import Cache
from raceattn.connectors.base import RenderedQuery, cached_request
from raceattn.http import FetchError, HttpClient
from raceattn.mcqueries import QueryConfig
from raceattn.metrics.reliability import krippendorff_alpha_nominal, simple_agreement, wilson

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://search.mediacloud.org/api/"
COUNT_URL = BASE + "search/count-over-time"
STORY_LIST_URL = BASE + "search/story-list"
SOURCE_INTERVAL_URL = BASE + "search/count-by-source-over-interval"
SOURCES_URL = BASE + "search/sources"
COLLECTIONS_URL = BASE + "sources/collections/"
ENV_KEY = "MEDIACLOUD_API_KEY"
DEFAULT_PACE = 30.0
STOP_STATUS = (401, 403, 429)
AUDIT_DIR = os.path.join(ROOT, "data", "local", "mediacloud", "audit")
AUDIT_COLUMNS = ["query", "collection", "story_id", "publish_date", "source", "title", "url", "relevant",
                 "category", "coder", "notes"]
CODING_COLUMNS = ["relevant", "category", "coder", "notes"]
RELEVANT_VALUES = ("yes", "no", "unclear")
NO_KEY = ("MEDIACLOUD_API_KEY is not set. Export it in your shell or put `MEDIACLOUD_API_KEY=...` in .env at the "
          "repo root (git-ignored, loaded at startup, never printed). Get a key from your profile at "
          "https://search.mediacloud.org")
STOP_REASONS = {401: "the key was not accepted (check MEDIACLOUD_API_KEY)",
                403: "forbidden: the key has no access to this endpoint or collection",
                429: "rate limit or weekly quota reached (the default quota is 4,000 requests a week)"}


class MediaCloudStop(FetchError):
    """HTTP 401, 403 or 429 from Media Cloud. The command stops; nothing is retried."""


def _sleep(seconds: float) -> None:
    """The real sleep. Tests replace this module attribute (tests/conftest.py), so no test ever waits."""
    time.sleep(seconds)


class PacedHttp:
    """get_json with at least `pace_seconds` between Media Cloud requests and an immediate stop on 401, 403, 429.
    Cache hits never reach this object, so they are not paced. `sleep` and `clock` are injectable for tests."""

    def __init__(self, http: Any = None, pace_seconds: float = DEFAULT_PACE,
                 sleep: Callable[[float], None] | None = None, clock: Callable[[], float] = time.monotonic):
        http = http or HttpClient()
        if isinstance(http, HttpClient):
            # pacing is done here, so the inner client does not sleep; 401/403/429 are never retried
            self.inner = HttpClient(sleep=0, max_retries=http.max_retries, backoff=http.backoff, timeout=http.timeout,
                                    session=http.session, stop_status=STOP_STATUS)
        else:
            self.inner = http
        self.pace_seconds = float(pace_seconds)
        self.sleep = sleep or (lambda sec: _sleep(sec))
        self.clock = clock
        self.requests = 0
        self.slept = 0.0
        self._last: float | None = None

    def get_json(self, url, params=None, ok_status=(200,), headers=None, secret_params=None):
        if self._last is not None and self.pace_seconds > 0:
            wait = self.pace_seconds - (self.clock() - self._last)
            if wait > 0:
                self.sleep(wait)
                self.slept += wait
        self.requests += 1
        try:
            return self.inner.get_json(url, params, ok_status=ok_status, headers=headers, secret_params=secret_params)
        except FetchError as e:
            if e.status in STOP_STATUS:
                raise MediaCloudStop("Media Cloud returned HTTP %d: %s. Stopping; no retry. Responses already "
                                     "fetched stay in the cache. (%s)" % (e.status, STOP_REASONS[e.status], e),
                                     e.status)
            raise
        finally:
            self._last = self.clock()


def auth_headers(key: str) -> dict[str, str]:
    return {"Authorization": "Token " + key}


class Client:
    """Cached, paced Media Cloud GETs for the CLI commands (the connector uses Connector.cached_get)."""

    def __init__(self, key: str, http: Any = None, raw_dir: str | None = None, refresh: bool = False,
                 pace_seconds: float = DEFAULT_PACE, sleep: Callable[[float], None] | None = None):
        if not key:
            raise FetchError(NO_KEY)
        self._key = key
        self.http = http if isinstance(http, PacedHttp) else PacedHttp(http, pace_seconds, sleep)
        self.cache = Cache(raw_dir or os.path.join(ROOT, "data", "raw"))
        self.refresh = refresh
        self.cache_hits = 0

    @property
    def requests(self) -> int:
        return self.http.requests

    def get(self, source: str, scope: str, window_label: str, q: RenderedQuery, name: str,
            dir_hash: str | None = None) -> dict[str, Any]:
        path = self.cache.path(source, scope, window_label, dir_hash or q.query_hash, name)
        rec, hit = cached_request(self.cache, path, self.http, q, not self.refresh, headers=auth_headers(self._key))
        self.cache_hits += hit
        return rec

    def request_line(self) -> str:
        return ("Media Cloud: %d HTTP request(s) made, %d served from the cache (paced %.0f s apart)"
                % (self.requests, self.cache_hits, self.http.pace_seconds))


# -- per-source responses (breadth and top sources)

def parse_source_interval(body: Any) -> dict[str, dict[str, Any]]:
    """search/count-by-source-over-interval -> {day: {"breadth": sources with matching_stories > 0, "matching": the sum
    of matching_stories}}. A day in the response with no matching source is an explicit 0; a day the response leaves
    out is not in the result (missing). Only the source name and the counts are read."""
    rows = (body or {}).get("source-interval-attention")
    if not isinstance(rows, list):
        raise FetchError("Media Cloud count-by-source-over-interval response has no `source-interval-attention` list")
    srcs: dict[str, set] = {}
    matching: dict[str, float] = {}
    for r in rows:
        day = str(r.get("bucket") or "")[:10]
        if not day:
            raise FetchError("Media Cloud count-by-source-over-interval row has no `bucket`")
        srcs.setdefault(day, set())
        n = r.get("matching_stories") or 0
        matching[day] = matching.get(day, 0.0) + float(n)
        if n > 0:
            srcs[day].add(r.get("media_name"))
    return {d: {"breadth": len(srcs[d]), "matching": matching[d]} for d in sorted(srcs)}


def parse_top_sources(body: Any) -> list[dict[str, Any]]:
    """search/sources -> [{source, count}], largest count first, then by source name. Other fields are dropped."""
    rows = (body or {}).get("sources")
    if not isinstance(rows, list):
        raise FetchError("Media Cloud search/sources response has no `sources` list")
    out = [{"source": str(r.get("source")), "count": int(r.get("count") or 0)} for r in rows]
    return sorted(out, key=lambda r: (-r["count"], r["source"]))


# -- collections lookup

def search_collections(client: Client, name: str, platform: str | None = None, limit: int = 100,
                       max_pages: int = 5) -> dict[str, Any]:
    """Collections whose name matches. No platform filter by default: the directory's platform values (seen as
    `online_news` in the client's tests) differ from the search platform `onlinenews-mediacloud` (unverified)."""
    out, offset, total = [], 0, None
    pages = 0
    base = {"name": name, "limit": limit}
    if platform:
        base["platform"] = platform
    dir_hash = RenderedQuery(COLLECTIONS_URL, base).query_hash
    for _ in range(max_pages):
        q = RenderedQuery(COLLECTIONS_URL, dict(base, offset=offset), label="collections")
        rec = client.get("news_mediacloud_directory", "collections", "search", q, "page_%03d" % pages,
                         dir_hash=dir_hash)
        pages += 1
        body = rec["body"] or {}
        results = body.get("results")
        if results is None:
            raise FetchError("Media Cloud collections response has no `results`")
        total = body.get("count")
        out.extend(results)
        offset += len(results)
        if not body.get("next") or not results:
            break
    return {"query": name, "platform": platform, "count": total, "results": out, "pages": pages,
            "complete": total is None or len(out) >= total}


# -- story list and audit

def story_list(client: Client, race_id: str, phase: str, query: str, collection_id: int, start: str, end: str,
               platform: str, page_size: int, max_pages: int) -> dict[str, Any]:
    """Page through search/story-list. Each page is cached under the request hash (without the token)."""
    base = {"q": query, "start": start, "end": end, "platform": platform, "cs": str(collection_id),
            "page_size": page_size}
    dir_hash = RenderedQuery(STORY_LIST_URL, base).query_hash
    stories, token, pages = [], None, 0
    while pages < max_pages:
        params = dict(base)
        if token:
            params["pagination_token"] = token
        rec = client.get("news_mediacloud_audit", race_id, phase, RenderedQuery(STORY_LIST_URL, params, label=phase),
                         "page_%03d" % pages, dir_hash=dir_hash)
        pages += 1
        body = rec["body"] or {}
        if "stories" not in body:
            raise FetchError("Media Cloud story-list response has no `stories`")
        stories.extend(body.get("stories") or [])
        token = body.get("pagination_token")
        if not token:
            break
    return {"stories": stories, "pages": pages, "capped": bool(token) and pages >= max_pages,
            "request_hash": dir_hash}


def normalize_title(t: str | None) -> str:
    t = unicodedata.normalize("NFKD", t or "")
    t = "".join(ch for ch in t if not unicodedata.combining(ch)).lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", t).split())


def domain(url: str | None) -> str:
    host = urllib.parse.urlsplit(url or "").netloc.lower().split("@")[-1].split(":")[0]
    return host[4:] if host.startswith("www.") else host


def syndication(sample: list[dict[str, Any]], pool: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Duplicate rate (section 5): a story counts as syndicated when the same normalized title appears on at least
    one other domain. `in_sample` looks only inside the sample; `against_retrieved` checks each sampled story
    against every retrieved story (more copies are visible there, so it is the better estimate). Not deduped."""
    def titled_domains(stories):
        m: dict[str, set] = defaultdict(set)
        for s in stories:
            t = normalize_title(s.get("title"))
            if t:
                m[t].add(domain(s.get("url")))
        return m

    def rate(index):
        hits = 0
        for s in sample:
            t = normalize_title(s.get("title"))
            if t and len(index.get(t, set()) | {domain(s.get("url"))}) >= 2:
                hits += 1
        return {"syndicated": hits, "n": len(sample), "rate": round(hits / len(sample), 4) if sample else None}

    out = {"in_sample": rate(titled_domains(sample)),
           "rule": "same normalized title (lower case, accents and punctuation removed) on two or more domains; "
                   "stories are counted, not removed"}
    if pool is not None:
        out["against_retrieved"] = rate(titled_domains(pool))
    return out


def draw(stories: list[dict[str, Any]], n: int, seed: int) -> list[dict[str, Any]]:
    """n stories drawn uniformly (without replacement) from the retrieved stories, deduplicated by story id and put
    in a fixed order first, so the same retrieved set and seed always give the same sample."""
    seen, pool = set(), []
    for s in stories:
        sid = str(s.get("id"))
        if sid not in seen:
            seen.add(sid)
            pool.append(s)
    pool.sort(key=lambda s: (str(s.get("publish_date") or ""), str(s.get("id"))))
    picked = random.Random(seed).sample(pool, min(n, len(pool)))
    return sorted(picked, key=lambda s: (str(s.get("publish_date") or ""), str(s.get("id"))))


def audit_path(race_id: str, phase: str, audit_dir: str = AUDIT_DIR) -> str:
    return os.path.join(audit_dir, race_id, phase + ".csv")


def coded_rows(path: str) -> int:
    if not os.path.isfile(path):
        return 0
    with open(path, encoding="utf-8", newline="") as f:
        return sum(1 for r in csv.DictReader(f) if any((r.get(c) or "").strip() for c in CODING_COLUMNS))


def run_audit(cfg: QueryConfig, client: Client, phase: str, n: int, seed: int, max_pages: int = 20,
              page_size: int = 1000, out_path: str | None = None, force: bool = False,
              log: Callable[[str], None] = print) -> dict[str, Any]:
    if phase not in ("tuning", "analysis"):
        raise ValueError("phase must be tuning or analysis")
    start, end = cfg.phase(phase)
    out_path = out_path or audit_path(cfg.race_id, phase)
    if coded_rows(out_path) and not force:
        raise FileExistsError("%s already has %d coded row(s). Use --force to overwrite it with a new draw."
                              % (out_path, coded_rows(out_path)))
    if not cfg.core_queries:
        raise ValueError("audit.core_queries is empty in the query config")
    rows, cells = [], []
    for c in cfg.unconfigured_collections:
        log("   collection %s: not configured (no id in the query config), no sample drawn" % c.key)
    for qname in cfg.core_queries:
        for c in cfg.configured_collections:
            res = story_list(client, cfg.race_id, phase, cfg.queries[qname], c.id, start.isoformat(), end.isoformat(),
                             cfg.platform, page_size, max_pages)
            sample = draw(res["stories"], n, seed)
            retrieved = len({str(s.get("id")) for s in res["stories"]})
            synd = syndication(sample, res["stories"])
            cell = {"query": qname, "collection": c.key, "collection_id": c.id, "query_sha256": cfg.query_hash(qname),
                    "pages": res["pages"], "page_cap_hit": res["capped"], "retrieved": retrieved,
                    "sampled": len(sample), "syndication": synd,
                    "sampling": ("uniform over the %d retrieved stories" % retrieved) + (
                        "; the page cap (%d pages) was hit, so these are the first pages in the API's sort order, "
                        "not every match" % max_pages if res["capped"] else "; every page was retrieved")}
            cells.append(cell)
            log("   %s / %s: %d page(s), %d stories retrieved%s, %d sampled; syndicated: %s in sample, %s against "
                "retrieved" % (qname, c.key, res["pages"], retrieved, " (page cap hit)" if res["capped"] else "",
                               len(sample), _pct(synd["in_sample"]), _pct(synd["against_retrieved"])))
            if len(sample) < n:
                log("   %s / %s: only %d stories retrieved, fewer than n=%d; all of them are in the file"
                    % (qname, c.key, len(sample), n))
            for s in sample:
                rows.append({"query": qname, "collection": c.key, "story_id": s.get("id"),
                             "publish_date": s.get("publish_date"), "source": s.get("media_name") or domain(s.get("url")),
                             "title": s.get("title"), "url": s.get("url"), "relevant": "", "category": "",
                             "coder": "", "notes": ""})
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=AUDIT_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    summary = {"race_id": cfg.race_id, "phase": phase, "dates": [start.isoformat(), end.isoformat()], "n": n,
               "seed": seed, "max_pages": max_pages, "page_size": page_size, "config_version": cfg.version,
               "config_status": cfg.status, "config_sha256": cfg.config_sha256, "csv": out_path, "cells": cells,
               "syndication_overall": syndication([r for r in rows])["in_sample"],
               "not_configured": [c.key for c in cfg.unconfigured_collections]}
    with open(os.path.splitext(out_path)[0] + ".summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1)
        f.write("\n")
    return summary


def _pct(r: dict[str, Any] | None) -> str:
    if not r or r.get("rate") is None:
        return "n/a"
    return "%d/%d (%.1f%%)" % (r["syndicated"], r["n"], 100 * r["rate"])


# -- coding results

def read_audit(path: str) -> list[dict[str, str]]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        missing = [c for c in AUDIT_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise ValueError("%s: missing column(s) %s" % (path, ", ".join(missing)))
        return [{k: (v or "").strip() for k, v in r.items() if k} for r in reader]


def precision(rows: Iterable[dict[str, str]], target: float | None = None) -> list[dict[str, Any]]:
    """Per (query, collection): precision = yes / (yes + no). `unclear` and blank rows are left out of the
    denominator and reported; any other value is reported as invalid."""
    groups: dict[tuple[str, str], list[str]] = defaultdict(list)
    for r in rows:
        groups[(r["query"], r["collection"])].append(r["relevant"].lower())
    out = []
    for (q, c), vals in sorted(groups.items()):
        yes, no = vals.count("yes"), vals.count("no")
        lo, hi = wilson(yes, yes + no)
        p = yes / (yes + no) if yes + no else None
        out.append({"query": q, "collection": c, "rows": len(vals), "yes": yes, "no": no,
                    "unclear": vals.count("unclear"), "uncoded": vals.count(""),
                    "invalid": sum(1 for v in vals if v and v not in RELEVANT_VALUES), "coded": yes + no,
                    "precision": p, "wilson95": [lo, hi],
                    "meets_target": None if p is None or target is None else p >= target})
    return out


def agreement(rows_a: list[dict[str, str]], rows_b: list[dict[str, str]]) -> dict[str, Any]:
    """Join two coders' files on (query, collection, story_id); simple agreement and Krippendorff's alpha (nominal)
    for `relevant` and `category`. A variable counts for a story only when both coders filled it."""
    def index(rows, which):
        m = {}
        for r in rows:
            k = (r["query"], r["collection"], r["story_id"])
            if k in m:
                raise ValueError("coder %s file has story %s twice for %s / %s" % (which, k[2], k[0], k[1]))
            m[k] = r
        return m

    a, b = index(rows_a, "A"), index(rows_b, "B")
    both = sorted(set(a) & set(b))
    out: dict[str, Any] = {"joined": len(both), "only_a": len(set(a) - set(b)), "only_b": len(set(b) - set(a)),
                           "variables": {}}
    for var in ("relevant", "category"):
        pairs = [(a[k][var].lower(), b[k][var].lower()) for k in both if a[k][var] and b[k][var]]
        agree, n = simple_agreement(pairs)
        alpha = krippendorff_alpha_nominal([list(p) for p in pairs])
        out["variables"][var] = {"n_units": n, "simple_agreement": agree, "krippendorff_alpha": alpha["alpha"],
                                 "alpha_detail": alpha}
    return out
