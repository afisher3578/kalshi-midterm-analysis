"""Polite HTTP client: descriptive User-Agent, small sleeps, bounded retries with backoff."""
from __future__ import annotations

import time
from typing import Any

import certifi
import requests

from raceattn import USER_AGENT

RETRY_STATUS = {429, 500, 502, 503, 504}


class FetchError(RuntimeError):
    """A request failed for good (blocked, repeated errors). The pipeline stops and reports it."""


class HttpClient:
    def __init__(self, sleep: float = 0.3, max_retries: int = 4, backoff: float = 2.0, timeout: float = 60.0,
                 session: requests.Session | None = None):
        self.sleep = sleep
        self.max_retries = max_retries
        self.backoff = backoff
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
        self.calls = 0

    def get_json(self, url: str, params: dict[str, Any] | None = None, ok_status: tuple[int, ...] = (200,)) -> tuple[int, Any]:
        """GET and parse JSON. Retries 429 and 5xx with exponential backoff, then raises FetchError.
        403 stops immediately (we never work around a block)."""
        last = ""
        for attempt in range(self.max_retries + 1):
            if self.calls:
                time.sleep(self.sleep)
            self.calls += 1
            try:
                r = self.session.get(url, params=params, timeout=self.timeout, verify=certifi.where())
            except requests.RequestException as e:
                last = "network error: %s" % type(e).__name__
            else:
                if r.status_code in ok_status:
                    try:
                        return r.status_code, r.json()
                    except ValueError:
                        raise FetchError("%s returned HTTP %d with a non-JSON body" % (url, r.status_code))
                if r.status_code == 403:
                    raise FetchError("%s returned HTTP 403 (blocked or forbidden). Stopping; not retrying." % url)
                if r.status_code not in RETRY_STATUS:
                    raise FetchError("%s returned HTTP %d: %s" % (url, r.status_code, r.text[:300]))
                last = "HTTP %d" % r.status_code
            if attempt < self.max_retries:
                time.sleep(self.backoff ** attempt)
        raise FetchError("%s failed after %d attempts (last: %s). Stopping." % (url, self.max_retries + 1, last))
