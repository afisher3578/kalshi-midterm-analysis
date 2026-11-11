"""Fake requests.Session for offline connector tests. Every request is recorded (url, params, headers, json)."""
from __future__ import annotations

import json
from typing import Any, Callable

from raceattn.http import HttpClient


class Resp:
    def __init__(self, code: int, body: Any = None, text: str | None = None):
        self.status_code = code
        self._body = body
        self.text = text if text is not None else json.dumps(body)

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class FakeSession:
    """route(method, url, params, headers, json_body) -> Resp"""

    def __init__(self, route: Callable[..., Resp]):
        self.route = route
        self.headers: dict[str, str] = {}
        self.requests: list[dict[str, Any]] = []

    def _do(self, method, url, params=None, headers=None, json=None, **kw):
        self.requests.append({"method": method, "url": url, "params": dict(params or {}),
                              "headers": dict(headers or {}), "json": json})
        return self.route(method, url, dict(params or {}), dict(headers or {}), json)

    def get(self, url, **kw):
        return self._do("GET", url, **kw)

    def post(self, url, **kw):
        return self._do("POST", url, **kw)


def fake_http(route) -> tuple[HttpClient, FakeSession]:
    s = FakeSession(route)
    return HttpClient(sleep=0, max_retries=0, backoff=0, session=s), s
