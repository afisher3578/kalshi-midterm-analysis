"""News connectors. Guardian, NYT, Media Cloud and GDELT fixtures are synthetic from docs (no keys here)."""
import json
import os
import shutil
import uuid

import pytest

from raceattn.cache import Cache
from raceattn.config import load_race
from raceattn.connectors.news import (GdeltConnector, GuardianConnector, ManualNewsConnector, MediaCloudConnector,
                                      NytConnector, news_query)
from raceattn.http import FetchError
from tests.conftest import HERE, TEST_CONFIGS
from tests.fakes import Resp, fake_http

FIX = os.path.join(HERE, "fixtures", "news")
MANUAL = os.path.join(HERE, "fixtures", "news_manual")
DAY = os.path.join(TEST_CONFIGS, "tx-bsky-1day.yaml")


def fx(name):
    with open(os.path.join(FIX, name + ".json")) as f:
        return json.load(f)


def key():
    return "fake-" + uuid.uuid4().hex


def all_text(root):
    out = ""
    for d, _, fs in os.walk(root):
        for f in fs:
            out += open(os.path.join(d, f), encoding="utf-8").read()
    return out


def test_news_query_from_config():
    assert news_query(load_race("tx-senate-2026")) == '("Talarico" OR "Ken Paxton") AND Senate'
    assert news_query(load_race(os.path.join(TEST_CONFIGS, "oh-dummy-2030.yaml"))) == '"Jane Example"'


@pytest.mark.parametrize("cls, fixture, value, envname", [
    (GuardianConnector, "guardian_day", 7.0, "GUARDIAN_API_KEY"),
    (NytConnector, "nyt_day", 4.0, "NYT_API_KEY"),
])
def test_daily_query_param_key_redacted(tmp_path, cls, fixture, value, envname):
    race = load_race(DAY)
    k = key()
    http, sess = fake_http(lambda *a: Resp(200, fx(fixture)))
    c = cls(http=http, cache=Cache(str(tmp_path)), env={envname: k})
    rows = c.fetch(race, race.window)
    assert [r.value for r in rows] == [value] and rows[0].series == c.series
    assert sess.requests[0]["params"]["api-key"] == k  # sent
    s = c.query_summary(race, race.window)
    assert k not in json.dumps(s) and "api-key" not in json.dumps(s["queries"])
    # the query hash does not depend on the key
    c2 = cls(env={envname: key()})
    assert c2.series_query_hashes(race, race.window) == c.series_query_hashes(race, race.window)
    assert k not in all_text(tmp_path)
    assert c.quality(rows, race.window)[c.series].status == "ok"


@pytest.mark.parametrize("cls, envname", [(GuardianConnector, "GUARDIAN_API_KEY"), (NytConnector, "NYT_API_KEY")])
def test_error_messages_redact_query_param_key(tmp_path, cls, envname):
    race = load_race(DAY)
    k = key()
    # an error body that echoes the key back, the worst case
    http, _ = fake_http(lambda m, u, p, h, b: Resp(401, None, text="bad key %s in %s?api-key=%s" % (k, u, k)))
    c = cls(http=http, cache=Cache(str(tmp_path)), env={envname: k})
    with pytest.raises(FetchError) as e:
        c.fetch(race, race.window)
    assert k not in str(e.value) and "[REDACTED]" in str(e.value)


def test_nyt_sleeps_between_calls_and_accepts_metadata_spelling():
    from raceattn.http import HttpClient

    c = NytConnector(http=HttpClient(sleep=0.3), env={})
    assert c.http.sleep == 12.0
    assert c.extract({"response": {"metadata": {"hits": 9}}}) == 9
    assert c.extract({"response": {"meta": {"hits": 3}}}) == 3
    with pytest.raises(FetchError):
        c.extract({"response": {}})
    assert GuardianConnector(http=HttpClient(sleep=0.3), env={}).http.sleep >= 1.0


def test_mediacloud_header_key_and_series(tmp_path):
    """The old news_query path, used when the race has no config/queries/<race>.mediacloud.yaml."""
    race = load_race("tx-senate-2026")
    k = key()
    http, sess = fake_http(lambda *a: Resp(200, fx("mediacloud_count_over_time")))
    c = MediaCloudConnector(http=http, cache=Cache(str(tmp_path / "raw")), env={"MEDIACLOUD_API_KEY": k},
                            queries_dir=str(tmp_path / "no_query_files"))
    rows = c.fetch(race, race.window)
    assert len(rows) == 65 and rows[0].series == "news_mediacloud/story_count" and rows[0].value == 30
    r = sess.requests[0]
    assert r["headers"] == {"Authorization": "Token " + k}
    assert r["params"]["cs"] == "34412234" and r["params"]["platform"] == "onlinenews-mediacloud"
    assert r["params"]["start"] == "2026-09-01" and r["params"]["end"] == "2026-11-04"
    assert k not in all_text(tmp_path)
    assert c.quality(rows, race.window)[c.series].status == "ok"


def test_mediacloud_401_message_has_no_key(tmp_path):
    race = load_race(DAY)
    k = key()
    http, _ = fake_http(lambda *a: Resp(401, {"detail": "Invalid token %s" % k}))
    c = MediaCloudConnector(http=http, cache=Cache(str(tmp_path)), env={"MEDIACLOUD_API_KEY": k})
    with pytest.raises(FetchError) as e:
        c.fetch(race, race.window)
    assert k not in str(e.value)


@pytest.mark.parametrize("cls", [GuardianConnector, NytConnector, MediaCloudConnector])
def test_skipped_without_key(cls):
    assert cls(env={}).skip_reason(load_race(DAY)).startswith("missing key")


def manual(tmp_path, name, race_id="tx-bsky-1day"):
    d = tmp_path / "news_manual"
    d.mkdir(exist_ok=True)
    shutil.copy(os.path.join(MANUAL, name), d / (race_id + ".csv"))
    return ManualNewsConnector(manual_dir=str(d), env={})


def test_manual_csv(tmp_path):
    race = load_race(DAY)
    assert "missing manual CSV" in ManualNewsConnector(manual_dir=str(tmp_path), env={}).skip_reason(race)
    c = manual(tmp_path, "good.csv")
    assert c.skip_reason(race) is None
    rows = c.fetch(race, race.window)
    assert [(r.ts_utc.date().isoformat(), r.value) for r in rows] == [("2026-10-01", 12.0)]
    q = c.quality(rows, race.window)["news_manual/story_count"]
    assert q.status == "ok" and q.extra["rows_outside_window_ignored"] == 1


@pytest.mark.parametrize("name, msg", [("duplicate.csv", "duplicate date"), ("bad_header.csv", "header"),
                                       ("negative.csv", "non-negative"), ("bad_date.csv", "bad date")])
def test_manual_csv_validation(tmp_path, name, msg):
    c = manual(tmp_path, name)
    with pytest.raises(FetchError, match=msg):
        c.fetch(load_race(DAY), load_race(DAY).window)


def test_gdelt_optional_and_degraded(tmp_path):
    race = load_race("tx-senate-2026")
    http, sess = fake_http(lambda *a: Resp(200, fx("gdelt_timelinevolraw")))
    c = GdeltConnector(http=http, cache=Cache(str(tmp_path)), env={})
    rows = c.fetch(race, race.window)
    q = c.quality(rows, race.window)["gdelt/article_count"]
    assert q.status == "unusable" and q.coverage_days == 43  # every third day missing
    assert any("optional" in r for r in q.reasons)
    from raceattn.settings import load_settings

    assert "gdelt" not in load_settings()["default_sources"]


@pytest.mark.live
@pytest.mark.parametrize("cls, envname", [(GuardianConnector, "GUARDIAN_API_KEY"), (NytConnector, "NYT_API_KEY"),
                                          (MediaCloudConnector, "MEDIACLOUD_API_KEY")])
def test_live_news_smoke(tmp_path, cls, envname):
    if not os.environ.get(envname):
        pytest.skip("%s not set" % envname)
    race = load_race(DAY)
    c = cls(cache=Cache(str(tmp_path)))
    rows = c.fetch(race, race.window)
    assert c.quality(rows, race.window)[c.series].status in ("ok", "degraded", "unusable")
