"""Token leak test: fake secrets (built at runtime from uuid4, so no literal is in the repo) go through every
keyed connector, on success and error paths. Afterwards the repo, the captured logs, the cache dir and the
processed output must not contain any of them."""
import json
import os
import uuid

import pytest

from raceattn.config import load_race
from raceattn.http import FetchError
from raceattn.pipeline import run
from tests.conftest import HERE, ROOT, TEST_CONFIGS
from tests.fakes import Resp, fake_http

DAY = os.path.join(TEST_CONFIGS, "tx-bsky-1day.yaml")
SKIP = {".git", ".venv", "__pycache__", "node_modules"}


def fx(*p):
    with open(os.path.join(HERE, "fixtures", *p) + ".json") as f:
        return json.load(f)


@pytest.fixture
def secrets(monkeypatch):
    s = {k: "%s-%s" % (k.lower(), uuid.uuid4().hex) for k in
         ("X_BEARER_TOKEN", "GUARDIAN_API_KEY", "NYT_API_KEY", "MEDIACLOUD_API_KEY", "BSKY_HANDLE",
          "BSKY_APP_PASSWORD")}
    for k, v in s.items():
        monkeypatch.setenv(k, v)
    return s


def grep_tree(root, needles):
    hits = []
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP]
        for fn in files:
            p = os.path.join(d, fn)
            try:
                if os.path.getsize(p) > 50 * 1024 * 1024:
                    continue
                data = open(p, "rb").read()
            except OSError:
                continue
            for n in needles:
                if n.encode() in data:
                    hits.append((p, n[:12]))
    return hits


def make_route(secrets, fail):
    jwt = "jwt-" + uuid.uuid4().hex
    secrets = dict(secrets, _jwt=jwt)

    def route(method, url, params, headers, body):
        echo = "echo: %s %s %s" % (json.dumps(params), json.dumps(headers), json.dumps(body))
        if "kalshi" in url:
            raise AssertionError("kalshi not used here")
        if url.endswith("createSession"):
            if fail:
                return Resp(401, {"error": "AuthenticationRequired", "message": "bad " + echo})
            return Resp(200, {"accessJwt": jwt, "handle": secrets["BSKY_HANDLE"]})
        if "searchPosts" in url:
            return Resp(200, {"posts": [{"uri": "at://did:plc:%s/p/1" % uuid.uuid4().hex,
                                         "record": {"createdAt": "2026-10-01T12:00:00Z", "text": "posttext " + echo},
                                         "indexedAt": "2026-10-01T12:00:00Z",
                                         "author": {"handle": secrets["BSKY_HANDLE"]}}]})
        if "/counts/all" in url:
            return Resp(403, dict(fx("x", "error_403_client_forbidden"), detail=echo))
        if "/counts/recent" in url:
            return Resp(401 if fail else 200, fx("x", "counts_recent") if not fail else {"detail": echo})
        if "guardianapis" in url:
            return Resp(401, None, text="Unauthorized " + echo) if fail else Resp(200, fx("news", "guardian_day"))
        if "nytimes" in url:
            return Resp(429 if fail else 200, {"fault": echo} if fail else fx("news", "nyt_day"))
        if "mediacloud" in url:
            return Resp(401 if fail else 200, {"detail": echo} if fail else
                        {"count_over_time": {"counts": [{"date": "2026-10-01", "count": 3, "total_count": 9,
                                                         "ratio": 0.3}]}})
        raise AssertionError(url)

    return route, secrets


SOURCES = ["x", "news_mediacloud", "news_guardian", "news_nyt", "bluesky"]


def test_no_secret_anywhere(tmp_path, secrets, capsys):
    import datetime as dt

    import raceattn.connectors.x as xmod

    race = load_race(DAY)
    logs, errors = [], []
    raw, out = tmp_path / "raw", tmp_path / "out"
    route, all_secrets = make_route(secrets, fail=False)
    http, sess = fake_http(route)
    orig_now = xmod.XConnector.now
    xmod.XConnector.now = lambda self: dt.datetime(2026, 10, 3, tzinfo=dt.timezone.utc)
    try:
        res = run(race, SOURCES, raw_dir=str(raw), out_dir=str(out), http=http, log=logs.append, yes=True)
        # error paths: each connector on its own so every one hits its failure branch
        for src in SOURCES:
            route_f, s2 = make_route(secrets, fail=True)
            all_secrets.update(s2)
            http_f, _ = fake_http(route_f)
            try:
                run(race, [src], raw_dir=str(tmp_path / ("raw_err_" + src)), out_dir=str(tmp_path / "out_err"),
                    http=http_f, log=logs.append, yes=True)
            except FetchError as e:
                errors.append(str(e))
    finally:
        xmod.XConnector.now = orig_now
    assert len(errors) == len(SOURCES), errors
    assert res["sources"] == SOURCES and res["skipped"] == {}
    assert len(sess.requests) > 0
    captured = capsys.readouterr()
    needles = [v for v in all_secrets.values()]
    blob = "\n".join(logs + errors) + captured.out + captured.err + json.dumps(res)
    for n in needles:
        assert n not in blob, "secret leaked into logs, errors or result"
    assert grep_tree(str(tmp_path), needles) == []
    assert grep_tree(ROOT, needles) == []
    # the Bluesky handle, uris and post text from the fake API are not in the output either
    assert "did:plc" not in json.dumps(res) and "posttext" not in json.dumps(res)
    assert grep_tree(str(tmp_path), ["did:plc", "posttext"]) == []
