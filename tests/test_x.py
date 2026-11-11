"""X connector: query rendering, cost guard, counts/all with pagination, 403 fallback, token handling.
Fixtures are synthetic from docs (no X token available); see tests/fixtures/README.md."""
import datetime as dt
import json
import os
import uuid

import pytest

from raceattn.cache import Cache
from raceattn.config import load_race
from raceattn.connectors.x import PRICE_PER_REQUEST, XConnector, render_query
from raceattn.pipeline import CostGuardError, cost_guard, run
from tests.conftest import HERE, TEST_CONFIGS
from tests.fakes import Resp, fake_http

FIX = os.path.join(HERE, "fixtures", "x")
DAY = os.path.join(TEST_CONFIGS, "tx-bsky-1day.yaml")
NOW = dt.datetime(2026, 10, 3, 12, tzinfo=dt.timezone.utc)


def fx(name):
    with open(os.path.join(FIX, name + ".json")) as f:
        return json.load(f)


def token():
    return "fake-x-" + uuid.uuid4().hex


def route_ok(method, url, params, headers, body):
    if url.endswith("/counts/all"):
        return Resp(200, fx("counts_all_page1" if params.get("next_token") else "counts_all_page0"))
    raise AssertionError("unexpected " + url)


def route_403(method, url, params, headers, body):
    if url.endswith("/counts/all"):
        return Resp(403, fx("error_403_client_forbidden"))
    if url.endswith("/counts/recent"):
        return Resp(200, fx("counts_recent"))
    raise AssertionError(url)


def test_query_rendered_in_one_place():
    race = load_race("tx-senate-2026")
    q = render_query(race)
    assert q == '("James Talarico" OR "Talarico" OR "Ken Paxton" OR "Paxton") lang:en -is:retweet'
    c = XConnector(env={})
    rq = c.render_queries(race, race.window)[0]
    assert rq.params == {"query": q, "granularity": "hour", "start_time": "2026-09-01T00:00:00Z",
                         "end_time": "2026-11-05T00:00:00Z"}
    assert rq.endpoint == "https://api.x.com/2/tweets/counts/all"


def test_estimate_requests_times_price(tmp_path):
    race = load_race("tx-senate-2026")
    est = XConnector(env={}, cache=Cache(str(tmp_path))).estimate_cost(race)
    # 65 days = 1560 hours; 744 hourly buckets per page -> 3 requests
    assert est.requests == 3 and est.usd == pytest.approx(3 * PRICE_PER_REQUEST["all"])
    assert "per request" in est.note


def test_cost_guard_refuses_without_yes_and_makes_no_call(tmp_path, monkeypatch, capsys):
    """Acceptance: with a fake token the estimate prints first and the guard refuses; no network call."""
    monkeypatch.setenv("X_BEARER_TOKEN", token())
    calls = []

    def route(*a):
        calls.append(a)
        raise AssertionError("network call before the cost guard")

    http, sess = fake_http(route)
    logs = []
    with pytest.raises(CostGuardError, match="--yes or --max-spend"):
        run(load_race("tx-senate-2026"), ["x"], raw_dir=str(tmp_path), out_dir=str(tmp_path), http=http,
            log=logs.append, write=False)
    assert calls == [] and sess.requests == []
    assert logs and logs[0].startswith("cost estimate for x: about $0.03 over 3 requests")
    with pytest.raises(CostGuardError, match="over --max-spend"):
        run(load_race("tx-senate-2026"), ["x"], raw_dir=str(tmp_path), out_dir=str(tmp_path), http=http,
            log=logs.append, write=False, max_spend=0.01)
    assert sess.requests == []


def test_cli_refuses_without_yes(tmp_path, monkeypatch, capsys):
    from raceattn.cli import main

    monkeypatch.setenv("X_BEARER_TOKEN", token())
    rc = main(["run", "--race", "tx-senate-2026", "--sources", "x", "--raw-dir", str(tmp_path), "--out-dir",
               str(tmp_path)])
    out = capsys.readouterr()
    assert rc == 2
    assert out.out.index("cost estimate for x") >= 0
    assert "--yes or --max-spend" in out.err


def test_counts_all_with_pagination(tmp_path):
    race = load_race(DAY)
    tok = token()
    http, sess = fake_http(route_ok)
    c = XConnector(http=http, cache=Cache(str(tmp_path)), env={"X_BEARER_TOKEN": tok}, now=NOW)
    rows = c.fetch(race, race.window)
    assert len(rows) == 24 and [r.ts_utc.hour for r in rows] == list(range(24))
    assert rows[0].value == 40.0 and rows[0].series == "x/post_count"
    assert len(sess.requests) == 2 and sess.requests[1]["params"]["next_token"] == "synthetic-next-1"
    assert all(r["headers"]["Authorization"] == "Bearer " + tok for r in sess.requests)
    assert all(tok not in r["url"] and tok not in json.dumps(r["params"]) for r in sess.requests)
    q = c.quality(rows, race.window)["x/post_count"]
    assert q.status == "ok" and q.extra["mode"] == "counts/all"


def test_paid_reads_never_re_pulled_even_with_refresh(tmp_path):
    race = load_race(DAY)
    http, sess = fake_http(route_ok)
    env = {"X_BEARER_TOKEN": token()}
    XConnector(http=http, cache=Cache(str(tmp_path)), env=env, now=NOW).fetch(race, race.window)
    n = len(sess.requests)
    c2 = XConnector(http=http, cache=Cache(str(tmp_path)), env=env, now=NOW, refresh=True)
    c2.fetch(race, race.window)
    assert len(sess.requests) == n and c2.cache_hits == 2
    assert c2.estimate_cost(race).requests == 0  # fully cached: estimate is $0


def test_403_prints_body_falls_back_to_recent_and_degrades(tmp_path):
    race = load_race(DAY)
    tok = token()
    http, sess = fake_http(route_403)
    c = XConnector(http=http, cache=Cache(str(tmp_path)), env={"X_BEARER_TOKEN": tok}, now=NOW)
    logs = []
    c.log = logs.append
    rows = c.fetch(race, race.window)
    assert any("client-not-enrolled" in l and "HTTP 403" in l for l in logs)  # exact body shown
    assert [r["url"].rsplit("/", 1)[1] for r in sess.requests] == ["all", "recent"]
    assert len(rows) == 24 and rows[5].value == 40.0 + (5 * 37) % 60  # post_count spelling read
    q = c.quality(rows, race.window)["x/post_count"]
    assert q.status == "degraded" and any("counts/all refused (HTTP 403)" in r for r in q.reasons)
    assert c.query_summary(race, race.window)["mode"] == "recent"
    # the refusal is not cached (a later run with access can try again); the recent read is
    files = [os.path.join(d, f) for d, _, fs in os.walk(tmp_path) for f in fs]
    assert len(files) == 1
    assert all(tok not in open(p).read() for p in files)


def test_recent_window_outside_last_7_days(tmp_path):
    """Texas window ended before the last 7 days: fallback has nothing to read and says so."""
    race = load_race(DAY)
    http, sess = fake_http(route_403)
    c = XConnector(http=http, cache=Cache(str(tmp_path)), env={"X_BEARER_TOKEN": token()},
                   now=dt.datetime(2026, 11, 11, tzinfo=dt.timezone.utc))
    c.log = lambda *_: None
    rows = c.fetch(race, race.window)
    q = c.quality(rows, race.window)["x/post_count"]
    assert rows == [] and q.status == "unusable" and any("no overlap" in r for r in q.reasons)


def test_401_stops_with_error_and_no_token_in_message(tmp_path):
    from raceattn.http import FetchError

    race = load_race(DAY)
    tok = token()
    http, _ = fake_http(lambda *a: Resp(401, fx("error_401")))
    c = XConnector(http=http, cache=Cache(str(tmp_path)), env={"X_BEARER_TOKEN": tok}, now=NOW)
    c.log = lambda *_: None
    with pytest.raises(FetchError) as e:
        c.fetch(race, race.window)
    assert "401" in str(e.value) and tok not in str(e.value)


def test_skipped_without_token():
    race = load_race(DAY)
    assert "X_BEARER_TOKEN" in XConnector(env={}).skip_reason(race)
    assert XConnector(env={"X_BEARER_TOKEN": token()}).skip_reason(race) is None


@pytest.mark.live
def test_live_x_smoke(tmp_path):
    if not os.environ.get("X_BEARER_TOKEN"):
        pytest.skip("X_BEARER_TOKEN not set")
    race = load_race(DAY)
    c = XConnector(cache=Cache(str(tmp_path)))
    rows = c.fetch(race, race.window)
    q = c.quality(rows, race.window)["x/post_count"]
    assert q.status in ("ok", "degraded", "unusable")
