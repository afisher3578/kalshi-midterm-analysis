"""Polite HTTP client: descriptive User-Agent, small sleeps, bounded retries with backoff.

Secrets: callers pass auth headers in `headers` and query-param keys in `secret_params`. Neither is stored on the
client or the session, and every error message is passed through `redact` with those values first, so a key never
ends up in an exception, a log line or a cache record.
"""
from __future__ import annotations

import time
from typing import Any

import certifi
import requests

from raceattn import USER_AGENT

RETRY_STATUS = {429, 500, 502, 503, 504}
REDACTED = "[REDACTED]"


class FetchError(RuntimeError):
    """A request failed for good (blocked, repeated errors). The pipeline stops and reports it."""


def redact(text: str, secrets: list[str] | tuple[str, ...]) -> str:
    """Replace every secret value (and its URL-encoded form) in text."""
    import urllib.parse

    for s in secrets:
        if s:
            for form in {s, urllib.parse.quote(s, safe=""), urllib.parse.quote_plus(s)}:
                text = text.replace(form, REDACTED)
    return text


def _secret_values(headers: dict[str, str] | None, secret_params: dict[str, str] | None) -> list[str]:
    vals = list((secret_params or {}).values())
    for v in (headers or {}).values():
        vals.append(v)
        # "Bearer <token>" or "Token <key>": also redact the bare credential
        parts = v.split(None, 1)
        if len(parts) == 2:
            vals.append(parts[1])
    return [v for v in vals if v]


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

    def get_json(self, url: str, params: dict[str, Any] | None = None, ok_status: tuple[int, ...] = (200,),
                 headers: dict[str, str] | None = None, secret_params: dict[str, str] | None = None
                 ) -> tuple[int, Any]:
        """GET and parse JSON. Retries 429 and 5xx with exponential backoff, then raises FetchError.
        403 stops immediately (we never work around a block) unless the caller lists it in ok_status.
        A non-200 status in ok_status with a non-JSON body comes back as {"text": <first 2000 chars>}."""
        return self._request("GET", url, params, None, ok_status, headers, secret_params)

    def post_json(self, url: str, body: dict[str, Any], ok_status: tuple[int, ...] = (200,),
                  secret_values: tuple[str, ...] = ()) -> tuple[int, Any]:
        """POST a JSON body (used for Bluesky createSession). Values in secret_values are redacted in errors."""
        return self._request("POST", url, None, body, ok_status, None, None, secret_values)

    def _request(self, method, url, params, body, ok_status, headers, secret_params, extra_secrets=()):
        secrets = _secret_values(headers, secret_params) + [s for s in extra_secrets if s]
        send_params = dict(params or {})
        send_params.update(secret_params or {})
        kw: dict[str, Any] = {"timeout": self.timeout, "verify": certifi.where()}
        if send_params or method == "GET":
            kw["params"] = send_params or params
        if headers:
            kw["headers"] = headers
        if body is not None:
            kw["json"] = body
        last = ""
        for attempt in range(self.max_retries + 1):
            if self.calls:
                time.sleep(self.sleep)
            self.calls += 1
            try:
                if method == "GET":
                    r = self.session.get(url, **kw)
                else:
                    r = self.session.post(url, **kw)
            except requests.RequestException as e:
                last = "network error: %s" % type(e).__name__
            else:
                if r.status_code in ok_status:
                    try:
                        return r.status_code, r.json()
                    except ValueError:
                        if r.status_code != 200:
                            return r.status_code, {"text": redact((r.text or "")[:2000], secrets)}
                        raise FetchError("%s returned HTTP %d with a non-JSON body" % (url, r.status_code))
                if r.status_code == 403:
                    raise FetchError(redact("%s returned HTTP 403 (blocked or forbidden). Stopping; not retrying. "
                                            "Body: %s" % (url, (r.text or "")[:300]), secrets))
                if r.status_code not in RETRY_STATUS:
                    raise FetchError(redact("%s returned HTTP %d: %s" % (url, r.status_code, (r.text or "")[:300]),
                                            secrets))
                last = "HTTP %d" % r.status_code
            if attempt < self.max_retries:
                time.sleep(self.backoff ** attempt)
        raise FetchError(redact("%s failed after %d attempts (last: %s). Stopping." % (url, self.max_retries + 1, last),
                                secrets))
