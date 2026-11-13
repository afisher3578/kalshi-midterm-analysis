"""Media Cloud query config, connector, request handling and audit workflow (MC1). Offline only.

Every Media Cloud response here is SYNTHETIC (tests/fixtures/mediacloud/*.synthetic.json, or built in the test and
labelled so): no key was available, so nothing in this file is real Media Cloud data.
"""
import csv
import datetime as dt
import hashlib
import json
import os

import pytest

from raceattn import mcqueries
from raceattn.cache import Cache
from raceattn.config import load_race
from raceattn.connectors.news import MediaCloudConnector, derive
from raceattn.http import FetchError
from raceattn.metrics.quality import compute_quality
from raceattn.metrics.reliability import krippendorff_alpha_nominal, simple_agreement, wilson
from raceattn import mediacloud as mc
from tests.conftest import HERE, ROOT, TEST_CONFIGS
from tests.fakes import Resp, fake_http

FIX = os.path.join(HERE, "fixtures", "mediacloud")
TX_QUERIES = os.path.join(ROOT, "config", "queries", "tx-senate-2026.mediacloud.yaml")
RACE5 = os.path.join(TEST_CONFIGS, "tx-mc-5day.yaml")
KEY = "fake-mc-key-not-real-0001"

T = ('("James Talarico" OR Talarico) AND (Senate OR "U.S. Senate" OR "Senate race" OR campaign OR election OR '
     'candidate OR nominee OR poll OR polls OR debate OR Paxton)')
P = ('("Ken Paxton" OR "Kenneth Paxton" OR Paxton) AND (Senate OR "U.S. Senate" OR "Senate race" OR campaign OR '
     'election OR candidate OR nominee OR runoff OR poll OR polls OR debate OR Cornyn OR Talarico) NOT "Bill Paxton"')
TA = '("James Talarico" OR Talarico)'
PA = '("Ken Paxton" OR "Kenneth Paxton" OR Paxton) NOT "Bill Paxton"'
H = 'article_title:(Talarico OR "Ken Paxton" OR Paxton) AND (Senate OR Talarico OR Paxton OR campaign OR poll)'
EXPECTED = {
    "talarico_race": "(%s) AND language:en" % T,
    "paxton_race": "(%s) AND language:en" % P,
    "race_either": "((%s) OR (%s)) AND language:en" % (T, P),
    "race_both": "((%s) AND (%s)) AND language:en" % (T, P),
    "talarico_any": "(%s) AND language:en" % TA,
    "paxton_any": "(%s) AND language:en" % PA,
    "headline_either": "(%s) AND language:en" % H,
    "any_either": "((%s) OR (%s)) AND language:en" % (TA, PA),
}


def fx(name):
    with open(os.path.join(FIX, name)) as f:
        return json.load(f)


def queries_dir(tmp_path, race_id="tx-mc-5day", edit=None):
    """The real Texas query file, renamed for a test race (and optionally edited)."""
    d = tmp_path / "queries"
    d.mkdir(exist_ok=True)
    text = open(TX_QUERIES, encoding="utf-8").read().replace("race_id: tx-senate-2026", "race_id: " + race_id)
    if edit:
        edited = edit(text)
        assert edited != text, "the test edit did not apply"
        text = edited
    (d / (race_id + ".mediacloud.yaml")).write_text(text, encoding="utf-8")
    return str(d)


def count_route(cfg, body_for=None, status=200, per_source_for=None, per_source_status=200):
    """Fake Media Cloud: count-over-time, count-by-source-over-interval and search/sources, all SYNTHETIC."""
    by_q = {q: name for name, q in cfg.queries.items()}
    data = fx("count_over_time_5day.synthetic.json")["by_query"]
    ps = fx("per_source_5day.synthetic.json")

    def route(method, url, params, headers, body):
        name = by_q[params["q"]]
        if url == mc.COUNT_URL:
            if status != 200:
                return Resp(status, {"detail": "synthetic error"})
            return Resp(200, body_for(name) if body_for else data[name])
        assert url in (mc.SOURCE_INTERVAL_URL, mc.SOURCES_URL), url
        if per_source_status != 200:
            return Resp(per_source_status, {"detail": "synthetic error"})
        kind = "count_by_source" if url == mc.SOURCE_INTERVAL_URL else "sources"
        return Resp(200, per_source_for(kind, name, params) if per_source_for else ps[kind][name])

    return route


def connector(tmp_path, route, **kw):
    http, sess = fake_http(route)
    c = MediaCloudConnector(http=http, cache=Cache(str(tmp_path / "raw")), env={"MEDIACLOUD_API_KEY": KEY},
                            queries_dir=kw.pop("qdir", None) or queries_dir(tmp_path), pace_seconds=0, **kw)
    c.log = lambda *_: None
    return c, sess


# -- query config

def test_renders_all_queries_exactly():
    cfg = mcqueries.load(TX_QUERIES)
    assert cfg.queries == EXPECTED
    assert list(cfg.queries)[:7] == ["talarico_race", "paxton_race", "race_either", "race_both", "talarico_any",
                                     "paxton_any", "headline_either"]
    assert cfg.derived_support == ("any_either",)
    assert cfg.status == "draft" and cfg.version == 1 and cfg.frozen_on is None
    assert [(c.key, c.id) for c in cfg.collections] == [("national", 34412234), ("texas_local", 38381323)]
    assert cfg.phase("analysis") == (dt.date(2026, 9, 1), dt.date(2026, 11, 2))
    assert cfg.api_version == "3.2.3" and cfg.timezone_note.startswith("publish_date is a date with no time")
    assert [c.source_count for c in cfg.collections] == [246, 593]
    for name, q in EXPECTED.items():
        assert cfg.query_hash(name) == hashlib.sha256(q.encode()).hexdigest()


def test_query_hash_canonical_and_config_hash():
    assert mcqueries.query_sha256("(a  OR\n b) AND language:en") == mcqueries.query_sha256("(a OR b) AND language:en")
    cfg = mcqueries.load(TX_QUERIES)
    import yaml

    data = yaml.safe_load(open(TX_QUERIES))
    assert mcqueries.parse(data).config_sha256 == cfg.config_sha256  # comments and layout do not matter
    data["collections"]["texas_local"]["id"] = 123
    assert mcqueries.parse(data).config_sha256 != cfg.config_sha256


@pytest.mark.parametrize("edit, msg", [
    (lambda t: t.replace("status: draft ", "status: final "), "status must be one of"),
    (lambda t: t.replace("talarico_any: '((\"James Talarico\" OR", "talarico_any: '((\"James Talarico\" or"),
     "lower-case operator"),
    (lambda t: t.replace("talarico_any: '((\"James Talarico\" OR Talarico)) AND language:en'",
                         "talarico_any: '(\"James Talarico\" OR Talarico)'"), "must have the form"),
    (lambda t: t.replace("OR poll OR polls OR debate OR Paxton)) OR ((", "OR poll OR debate OR Paxton)) OR ((", 1),
     "does not match its composition"),
    (lambda t: t.replace("talarico_any: '((\"James", "talarico_any: '((\"\"James"), "unbalanced double quotes"),
    (lambda t: t.replace("status: draft ", "status: frozen "), "needs a frozen_on date"),
    (lambda t: t.replace("id: 34412234,", "id: null,").replace("id: 38381323,", "id: null,"),
     "no collection has an id"),
    (lambda t: t.replace("core_queries: [talarico_race, paxton_race]", "core_queries: [nope]"), "unknown query nope"),
])
def test_validator_rejects(tmp_path, edit, msg):
    d = queries_dir(tmp_path, edit=edit)
    with pytest.raises(mcqueries.QueryConfigError, match=msg):
        mcqueries.find("tx-mc-5day", d)


def test_unwrap_rejects_split_groups():
    assert mcqueries.unwrap("(a) OR (b) AND language:en", "en") is None
    assert mcqueries.unwrap("((a) OR (b)) AND language:en", "en") == "(a) OR (b)"


# -- derived math

def test_derive_shares_and_zero_denominators():
    share = {"numerator": "t", "other": "p"}
    assert derive("share", share, {"numerator": 10, "other": 30}) == (0.25, "")
    v, why = derive("share", share, {"numerator": 0, "other": 0})
    assert v is None and "denominator is 0" in why
    v, why = derive("share", share, {"numerator": None, "other": 3})
    assert v is None and "input missing" in why and "t" in why
    ex = {"numerator": "t", "other": "p", "both": "b"}
    assert derive("exclusive_share", ex, {"numerator": 10, "other": 30, "both": 5}) == (5 / 30, "")
    assert derive("exclusive_share", ex, {"numerator": 4, "other": 4, "both": 4})[0] is None  # 0 / 0
    assert "inconsistent" in derive("exclusive_share", ex, {"numerator": 3, "other": 9, "both": 5})[1]
    r = {"numerator": "e", "denominator": "a"}
    assert derive("ratio", r, {"numerator": 7, "denominator": 14}) == (0.5, "")
    v, why = derive("ratio", r, {"numerator": 7, "denominator": 0})
    assert v is None and why == "denominator is 0 (a = 0)"


# -- connector, config path

def test_connector_series_zero_vs_missing_and_derived(tmp_path):
    race = load_race(RACE5)
    c, sess = connector(tmp_path, None)
    cfg = c.query_config(race)
    sess.route = count_route(cfg)
    rows = c.fetch(race, race.window)
    assert len(sess.requests) == 28  # 8 queries x 2 collections, plus 3 per-source queries x 2 collections x 2
    assert {r["params"]["cs"] for r in sess.requests} == {"34412234", "38381323"}
    assert all(r["headers"] == {"Authorization": "Token " + KEY} for r in sess.requests)
    vals = {}
    for r in rows:
        vals.setdefault(r.series, {})[r.ts_utc.date().isoformat()] = r.value
    tr = vals["news_mediacloud/talarico_race/national"]
    assert tr == {"2026-10-01": 10, "2026-10-02": 0, "2026-10-03": 6, "2026-10-05": 4}  # 10-04 missing, 10-02 zero
    assert "2026-09-30" not in tr  # outside the window
    assert vals["news_mediacloud/talarico_race/national/total_count"]["2026-10-01"] == 20000
    assert vals["news_mediacloud/talarico_race/national/ratio"]["2026-10-01"] == pytest.approx(10 / 20000)
    share = vals["news_mediacloud/talarico_share/national"]
    assert share == {"2026-10-01": 0.25, "2026-10-03": 0.75, "2026-10-05": 0.25}
    ex = vals["news_mediacloud/talarico_exclusive_share/national"]
    assert ex == {"2026-10-01": round(5 / 30, 6), "2026-10-03": round(5 / 6, 6), "2026-10-05": round(2 / 12, 6)}
    cvb = vals["news_mediacloud/core_vs_broad/national"]
    assert cvb == {"2026-10-01": 0.5, "2026-10-03": round(7 / 12, 6), "2026-10-04": round(9 / 22, 6)}
    nulls = c.derived_nulls["news_mediacloud/talarico_share/national"]
    assert "denominator is 0" in nulls["2026-10-02"] and "input missing" in nulls["2026-10-04"]
    assert c.derived_nulls["news_mediacloud/core_vs_broad/national"]["2026-10-05"] == "denominator is 0 (any_either = 0)"
    assert vals["news_mediacloud/talarico_race/texas_local"] == tr  # same synthetic body for both collections

    q = c.quality(rows, race.window)
    t = q["news_mediacloud/talarico_race/national"]
    assert t.coverage_days == 4 and t.missing_days == ["2026-10-04"]
    assert t.extra["explicit_zero_days"] == ["2026-10-02"]
    assert t.status == "degraded"  # 4/5 days present is under the 95% gate
    assert any("analysis phase coverage 4/5" in r for r in t.reasons)
    assert q["news_mediacloud/paxton_race/national"].status == "ok"  # one explicit zero day is a real zero
    assert q["news_mediacloud/talarico_share/national"].extra["null_days"]["2026-10-02"].startswith("denominator")
    assert "news_mediacloud/any_either/national" in c.context_series
    assert "news_mediacloud/talarico_race/national" not in c.context_series

    s = c.query_summary(race, race.window)
    m = s["mediacloud"]
    assert m["config_sha256"] == cfg.config_sha256 and m["status"] == "draft" and m["version"] == 1
    tq = m["queries"]["talarico_race"]
    assert tq["query"] == EXPECTED["talarico_race"] and tq["query_sha256"] == cfg.query_hash("talarico_race")
    assert tq["role"] == "core" and m["queries"]["any_either"]["role"] == "derived_support"
    nat, loc = tq["collections"]["national"], tq["collections"]["texas_local"]
    assert nat["status"] == "fetched" and nat["collection_id"] == 34412234
    assert nat["collection_name"] == "United States - National" and nat["config_sha256"] == cfg.config_sha256
    assert loc["status"] == "fetched" and loc["collection_id"] == 38381323
    assert loc["collection_name"] == "Texas, United States - State & Local"
    assert m["collections"]["texas_local"]["status"] == "configured"
    assert KEY not in json.dumps(s)


def test_near_zero_gate_needs_two_days():
    days = [dt.date(2026, 9, 1) + dt.timedelta(i) for i in range(20)]
    one = {d: (0.0 if i == 10 else 100.0) for i, d in enumerate(days)}
    two = {d: (0.0 if i in (10, 11) else 100.0) for i, d in enumerate(days)}
    assert compute_quality(one, days, min_near_zero_days=2).status == "ok"
    assert compute_quality(one, days).status == "degraded"  # the M0 rule, unchanged for other sources
    q = compute_quality(two, days, min_near_zero_days=2)
    assert q.status == "degraded" and q.near_zero[0]["days"] == 2


def test_fallback_without_query_file_is_the_old_request(tmp_path):
    race = load_race("tx-senate-2026")
    c, sess = connector(tmp_path, lambda *a: Resp(200, json.load(open(os.path.join(HERE, "fixtures", "news",
                                                                                  "mediacloud_count_over_time.json")))),
                        qdir=str(tmp_path / "none"))
    rows = c.fetch(race, race.window)
    assert len(sess.requests) == 1
    assert sess.requests[0]["params"] == {"q": '("Talarico" OR "Ken Paxton") AND Senate', "start": "2026-09-01",
                                          "end": "2026-11-04", "platform": "onlinenews-mediacloud", "cs": "34412234"}
    assert {r.series for r in rows} == {"news_mediacloud/story_count"}
    s = c.query_summary(race, race.window)
    assert "mediacloud" not in s and s["query"] == '("Talarico" OR "Ken Paxton") AND Senate'
    assert c.context_series == set()


# -- per-source requests: breadth and top sources

def test_parse_source_interval_zeros_missing_and_several_sources():
    ps = fx("per_source_5day.synthetic.json")["count_by_source"]
    t = mc.parse_source_interval(ps["talarico_race"])
    assert {d: v["breadth"] for d, v in t.items()} == {"2026-09-30": 1, "2026-10-01": 2, "2026-10-02": 0,
                                                       "2026-10-03": 1, "2026-10-05": 3}
    assert "2026-10-04" not in t  # a day the response leaves out is missing, not 0
    assert t["2026-10-01"]["matching"] == 10  # a: 6, b: 4, c: 0 (c has 0 matching that day and is not counted)
    assert mc.parse_source_interval({"source-interval-attention": []}) == {}
    # the same source twice on one day counts once; a bucket with a time is cut to the date
    rows = [{"media_name": "x.example", "bucket": "2026-10-01 00:00:00", "matching_stories": 2},
            {"media_name": "x.example", "bucket": "2026-10-01", "matching_stories": 1}]
    assert mc.parse_source_interval({"source-interval-attention": rows}) == {"2026-10-01": {"breadth": 1, "matching": 3}}
    with pytest.raises(FetchError, match="source-interval-attention"):
        mc.parse_source_interval({"counts": []})


def test_parse_top_sources_sorted_and_only_source_and_count():
    body = {"sources": [{"source": "b.example", "count": 3, "title": "SYNTHETIC story title"},
                        {"source": "a.example", "count": 3}, {"source": "c.example", "count": 9}]}
    assert mc.parse_top_sources(body) == [{"source": "c.example", "count": 9}, {"source": "a.example", "count": 3},
                                          {"source": "b.example", "count": 3}]
    assert mc.parse_top_sources({"sources": []}) == []
    with pytest.raises(FetchError, match="sources"):
        mc.parse_top_sources({})


def test_breadth_series_and_top_sources(tmp_path):
    race = load_race(RACE5)
    c, sess = connector(tmp_path, None)
    cfg = c.query_config(race)
    assert cfg.per_source_queries == ("talarico_race", "paxton_race", "race_either")
    sess.route = count_route(cfg)
    rows = c.fetch(race, race.window)
    per_source = [r for r in sess.requests if r["url"] != mc.COUNT_URL]
    assert len(per_source) == 12  # 3 queries x 2 collections x 2 endpoints
    assert all(r["headers"] == {"Authorization": "Token " + KEY} for r in per_source)
    sbs = [r for r in per_source if r["url"] == mc.SOURCE_INTERVAL_URL]
    src = [r for r in per_source if r["url"] == mc.SOURCES_URL]
    assert len(sbs) == len(src) == 6
    assert {by_name(cfg, r["params"]["q"]) for r in sbs} == {"talarico_race", "paxton_race", "race_either"}
    assert all(r["params"]["start"] == "2026-10-01" and r["params"]["end"] == "2026-10-05"
               and r["params"]["interval"] == "day" and r["params"]["platform"] == "onlinenews-mediacloud" for r in sbs)
    # top sources use the analysis phase of the query config, not the race window
    assert all(r["params"]["start"] == "2026-09-01" and r["params"]["end"] == "2026-11-02"
               and "interval" not in r["params"] for r in src)

    vals = {}
    for r in rows:
        vals.setdefault(r.series, {})[r.ts_utc.date().isoformat()] = r.value
    tb = vals["news_mediacloud/talarico_race/national/breadth"]
    assert tb == {"2026-10-01": 2, "2026-10-02": 0, "2026-10-03": 1, "2026-10-05": 3}  # 10-04 missing, 09-30 out
    assert vals["news_mediacloud/race_either/texas_local/breadth"] == {"2026-10-01": 3, "2026-10-02": 0,
                                                                       "2026-10-03": 2, "2026-10-04": 1, "2026-10-05": 3}
    assert not any(s.endswith("/breadth") and "race_both" in s for s in vals)
    assert {r.unit for r in rows if r.series.endswith("/breadth")} == {"sources"}
    assert "news_mediacloud/race_either/national/breadth" in c.context_series

    q = c.quality(rows, race.window)
    b = q["news_mediacloud/talarico_race/national/breadth"]
    assert b.missing_days == ["2026-10-04"] and b.extra["explicit_zero_days"] == ["2026-10-02"]
    assert b.status == "degraded" and any("analysis phase coverage 4/5" in r for r in b.reasons)
    assert b.extra["days_where_source_sum_differs_from_count"] == []

    s = c.query_summary(race, race.window)
    m = s["mediacloud"]
    top = m["top_sources"]["race_either"]["national"]
    assert top == {"query": "race_either", "collection": "national", "start": "2026-09-01", "end": "2026-11-02",
                   "sources": [{"source": "synthetic-a.example", "count": 35},
                               {"source": "synthetic-c.example", "count": 16},
                               {"source": "synthetic-b.example", "count": 14},
                               {"source": "synthetic-d.example", "count": 14}]}
    assert set(m["top_sources"]) == {"talarico_race", "paxton_race", "race_either"}
    assert set(m["top_sources"]["paxton_race"]) == {"national", "texas_local"}
    assert m["per_source_queries"] == ["talarico_race", "paxton_race", "race_either"]
    assert m["endpoints"]["breadth"] == mc.SOURCE_INTERVAL_URL and m["endpoints"]["top_sources"] == mc.SOURCES_URL
    nat = m["queries"]["race_either"]["collections"]["national"]
    assert nat["series"]["breadth"] == "news_mediacloud/race_either/national/breadth"
    assert nat["breadth_request_hash"] == s["series_query_hash"]["news_mediacloud/race_either/national/breadth"]
    assert nat["top_sources_request_hash"] and "breadth" not in m["queries"]["race_both"]["collections"]["national"]["series"]
    assert len(s["queries"]) == 28 and c.estimate_cost(race).requests == 28
    assert KEY not in json.dumps(s)


def by_name(cfg, q):
    return {v: k for k, v in cfg.queries.items()}[q]


def test_breadth_flags_days_where_the_source_sum_differs(tmp_path):
    race = load_race(RACE5)
    c, sess = connector(tmp_path, None)
    cfg = c.query_config(race)
    ps = fx("per_source_5day.synthetic.json")

    def per_source(kind, name, params):
        body = json.loads(json.dumps(ps[kind][name]))
        if kind == "count_by_source" and name == "race_either":
            body["source-interval-attention"].append({"media_name": "extra.example", "bucket": "2026-10-03",
                                                      "matching_stories": 1})
        return body
    sess.route = count_route(cfg, per_source_for=per_source)
    rows = c.fetch(race, race.window)
    q = c.quality(rows, race.window)
    assert q["news_mediacloud/race_either/national/breadth"].extra["days_where_source_sum_differs_from_count"] == [
        "2026-10-03"]


def test_per_source_queries_config_value(tmp_path):
    cfg = mcqueries.load(TX_QUERIES)
    assert cfg.per_source_queries == ("talarico_race", "paxton_race", "race_either")
    data = mcqueries.yaml.safe_load(open(TX_QUERIES, encoding="utf-8"))
    assert "per_source_queries" not in data and cfg.per_source_queries == mcqueries.DEFAULT_PER_SOURCE  # the default
    data["per_source_queries"] = ["race_either"]
    assert mcqueries.parse(data).per_source_queries == ("race_either",)
    data["per_source_queries"] = []
    assert mcqueries.parse(data).per_source_queries == ()
    data["per_source_queries"] = ["nope"]
    with pytest.raises(mcqueries.QueryConfigError, match="per_source_queries lists unknown query nope"):
        mcqueries.parse(data)

    qdir = queries_dir(tmp_path, edit=lambda t: t.replace("exclusions_log: []", "per_source_queries: [race_either]\nexclusions_log: []"))
    race = load_race(RACE5)
    c, sess = connector(tmp_path, None, qdir=qdir)
    sess.route = count_route(c.query_config(race))
    c.fetch(race, race.window)
    assert len(sess.requests) == 16 + 4
    assert set(c.top_sources) == {"race_either"}


def test_top_sources_cap(tmp_path):
    """SYNTHETIC: search/sources stops at 100 sources (seen live on 2026-11-12). A list of exactly 100 is marked capped
    with the stories it covers against the daily counts over the same dates; 99 is not."""
    assert mc.TOP_SOURCES_CAP == 100
    qdir = queries_dir(tmp_path, edit=lambda t: t.replace("analysis: {start: 2026-09-01, end: 2026-11-02}",
                                                          "analysis: {start: 2026-10-01, end: 2026-10-05}"))
    race = load_race(RACE5)
    c, sess = connector(tmp_path, None, qdir=qdir)
    cfg = c.query_config(race)
    data = fx("count_over_time_5day.synthetic.json")["by_query"]
    ps = fx("per_source_5day.synthetic.json")
    either = {"count_over_time": {"counts": [{"date": "2026-10-%02d 00:00:00" % d, "count": 30, "total_count": 1000,
                                              "ratio": 0.03} for d in range(1, 6)]}}

    def per_source(kind, name, params):
        if kind == "sources" and name in ("race_either", "talarico_race"):
            return {"sources": [{"source": "s%03d.example" % k, "count": 1} for k in range(100)]}
        if kind == "sources" and name == "paxton_race":
            return {"sources": [{"source": "s%03d.example" % k, "count": 1} for k in range(99)]}
        return ps[kind][name]
    sess.route = count_route(cfg, body_for=lambda n: either if n == "race_either" else data[n], per_source_for=per_source)
    c.fetch(race, race.window)
    e = c.top_sources["race_either"]["national"]
    assert (e["start"], e["end"]) == ("2026-10-01", "2026-10-05") and len(e["sources"]) == 100
    assert e["capped"] is True and e["cap"] == 100 and e["covered_stories"] == 100 and e["total_stories"] == 150
    assert e["missing_count_days"] == 0
    assert e["note"] == ("search/sources returns at most 100 sources; the 100 listed cover 100 of 150 race_either "
                         "stories in national (66.7%)")
    t = c.top_sources["talarico_race"]["texas_local"]  # talarico_race has no count on 2026-10-04
    assert t["capped"] and t["total_stories"] == 20 and t["missing_count_days"] == 1
    assert t["note"].endswith("; 1 day(s) of the window have no count, so the total leaves them out")
    p = c.top_sources["paxton_race"]["national"]
    assert len(p["sources"]) == 99 and not {"capped", "covered_stories", "total_stories", "note"} & set(p)
    m = c.query_summary(race, race.window)["mediacloud"]
    assert m["top_sources"]["race_either"]["national"]["capped"] is True


@pytest.mark.parametrize("status", [401, 403, 429])
def test_per_source_requests_stop_on_401_403_429(tmp_path, status):
    race = load_race(RACE5)
    c, sess = connector(tmp_path, None)
    c.http.inner.max_retries = 4
    sess.route = count_route(c.query_config(race), per_source_status=status)
    with pytest.raises(mc.MediaCloudStop) as e:
        c.fetch(race, race.window)
    assert e.value.status == status and ("HTTP %d" % status) in str(e.value) and "Stopping" in str(e.value)
    assert len(sess.requests) == 17  # the 16 counts, then the first per-source request, no retry
    assert sess.requests[-1]["url"] == mc.SOURCE_INTERVAL_URL
    assert KEY not in str(e.value)


def test_no_story_text_in_the_output(tmp_path):
    """Per-source responses with extra SYNTHETIC story fields: none of them reaches the rows or the summary."""
    race = load_race(RACE5)
    c, sess = connector(tmp_path, None)
    cfg = c.query_config(race)
    ps = fx("per_source_5day.synthetic.json")
    marks = {"title": "SYNTHETIC-TITLE-MARK", "url": "https://example.invalid/SYNTHETIC-URL-MARK",
             "text": "SYNTHETIC-TEXT-MARK"}

    def per_source(kind, name, params):
        body = json.loads(json.dumps(ps[kind][name]))
        for r in body["source-interval-attention" if kind == "count_by_source" else "sources"]:
            r.update(marks)
        return body
    sess.route = count_route(cfg, per_source_for=per_source)
    rows = c.fetch(race, race.window)
    out = json.dumps([r.to_dict() for r in rows]) + json.dumps(c.query_summary(race, race.window))
    out += json.dumps({k: v.to_dict() if hasattr(v, "to_dict") else str(v) for k, v in c.quality(rows, race.window).items()})
    for v in marks.values():
        assert v not in out
    for top in c.top_sources.values():
        for t in top.values():
            assert all(set(x) == {"source", "count"} for x in t["sources"])


# -- request handling

@pytest.mark.parametrize("status", [401, 403, 429])
def test_stops_on_401_403_429_without_retry(tmp_path, status):
    race = load_race(RACE5)
    c, sess = connector(tmp_path, None)
    c.http.inner.max_retries = 4  # even with retries configured, these statuses are never retried
    sess.route = count_route(c.query_config(race), status=status)
    with pytest.raises(mc.MediaCloudStop) as e:
        c.fetch(race, race.window)
    assert e.value.status == status and ("HTTP %d" % status) in str(e.value) and "Stopping" in str(e.value)
    assert len(sess.requests) == 1
    assert KEY not in str(e.value)


def test_cache_hit_no_refetch_and_refresh(tmp_path):
    race = load_race(RACE5)
    c, sess = connector(tmp_path, None)
    cfg = c.query_config(race)
    sess.route = count_route(cfg)
    rows1 = c.fetch(race, race.window)
    assert len(sess.requests) == 28 and c.http.requests == 28
    c2, sess2 = connector(tmp_path, count_route(cfg))
    rows2 = c2.fetch(race, race.window)
    assert len(sess2.requests) == 0 and c2.cache_hits == 28 and c2.http.requests == 0
    assert [r.value for r in rows1] == [r.value for r in rows2]
    assert c2.top_sources == c.top_sources and c2.top_sources["race_either"]["national"]["sources"]
    c3, sess3 = connector(tmp_path, count_route(cfg), refresh=True)
    c3.fetch(race, race.window)
    assert len(sess3.requests) == 28 and c3.cache_hits == 0
    blob = "".join(open(os.path.join(d, f)).read() for d, _, fs in os.walk(tmp_path / "raw") for f in fs)
    assert KEY not in blob and "Authorization" not in blob


def test_pacing_waits_between_requests_only():
    waits, now = [], [100.0]
    http, sess = fake_http(lambda *a: Resp(200, {"ok": 1}))
    p = mc.PacedHttp(http, pace_seconds=30, sleep=waits.append, clock=lambda: now[0])
    p.get_json("https://x.test/a")
    now[0] += 5
    p.get_json("https://x.test/b")
    assert waits == [25.0] and p.requests == 2
    assert MediaCloudConnector(env={}).http.pace_seconds == 30.0  # the default


def test_project_setting_sets_pace():
    from raceattn.pipeline import make_connectors
    from raceattn.settings import load_settings

    s = load_settings()
    assert s["connectors"]["news_mediacloud"]["pace_seconds"] == 30
    (c,) = make_connectors(["news_mediacloud"], mc.HttpClient(), None, False, {"connectors": {
        "news_mediacloud": {"pace_seconds": 0}}}, env={})
    assert c.http.pace_seconds == 0


# -- pipeline

def synthetic_full_window(cfg, days):
    """SYNTHETIC count-over-time bodies for the 65-day Texas window, built here (not Media Cloud data)."""
    base = {name: 10 + i for i, name in enumerate(cfg.queries)}

    def body(name):
        return {"count_over_time": {"counts": [
            {"date": d.isoformat() + " 00:00:00", "count": base[name] + (k % 7) * 3, "total_count": 20000 + k,
             "ratio": (base[name] + (k % 7) * 3) / (20000 + k)} for k, d in enumerate(days)]}}
    return body


def synthetic_per_source_full_window(cfg, days):
    """SYNTHETIC per-source bodies for the 65-day Texas window, consistent with synthetic_full_window."""
    count = synthetic_full_window(cfg, days)

    def body(kind, name, params):
        if kind == "sources":
            return {"sources": [{"source": "synthetic-b.example", "count": 7},
                                {"source": "synthetic-a.example", "count": 40}]}
        rows = []
        for e in count(name)["count_over_time"]["counts"]:
            n = e["count"]
            for src, v in (("synthetic-a.example", n - n // 3), ("synthetic-b.example", n // 3),
                           ("synthetic-c.example", 0)):
                rows.append({"media_name": src, "interval": "day", "bucket": e["date"][:10], "matching_stories": v,
                             "total_stories": 500, "ratio": v / 500})
        return {"source-interval-attention": rows}
    return body


def test_pipeline_context_series_stay_out_of_metrics(tmp_path):
    import shutil

    from raceattn.pipeline import index_metrics, run
    from tests.conftest import FIXTURE_RAW

    race = load_race("tx-senate-2026")
    raw = tmp_path / "raw"
    shutil.copytree(FIXTURE_RAW, raw)
    qdir = os.path.dirname(TX_QUERIES)
    cfg = mcqueries.find("tx-senate-2026", qdir)
    http, sess = fake_http(count_route(cfg, synthetic_full_window(cfg, race.window.days()),
                                      per_source_for=synthetic_per_source_full_window(cfg, race.window.days())))
    from raceattn.settings import load_settings

    settings = load_settings()
    settings["connectors"]["news_mediacloud"] = {"pace_seconds": 0, "queries_dir": qdir}
    logs = []
    res = run(race, ["kalshi", "wikipedia", "news_mediacloud"], raw_dir=str(raw), out_dir=str(tmp_path / "out"),
              http=http, log=logs.append, settings=settings, env={"MEDIACLOUD_API_KEY": KEY})
    assert len(sess.requests) == 28
    assert any("news_mediacloud: 28 HTTP request(s) made, 0 cache hit(s)" in l for l in logs)
    assert not any("not configured" in l for l in logs)
    counts = ["news_mediacloud/%s/national" % n for n in cfg.queries if n != "any_either"]
    daily = res["metrics"]["daily"]
    for s in counts:
        assert daily[s]["status"] == "computed"
    for s in daily:
        assert not s.endswith(("/ratio", "/total_count")) and "share" not in s and "core_vs_broad" not in s
    assert "news_mediacloud/any_either/national" not in daily
    cols = res["series"]["daily"]["columns"]
    assert "news_mediacloud/talarico_share/national" in cols and "news_mediacloud/any_either/national/ratio" in cols
    assert res["series"]["meta"]["news_mediacloud/talarico_share/national"]["role"] == "context"
    assert "role" not in res["series"]["meta"]["news_mediacloud/talarico_race/national"]
    assert res["quality"]["news_mediacloud/talarico_race/national"]["status"] == "ok"
    assert res["queries"]["news_mediacloud"]["mediacloud"]["config_sha256"] == cfg.config_sha256
    att = index_metrics(res)["attention"]
    assert "news_mediacloud/talarico_race/national" in att and "news_mediacloud/talarico_share/national" not in att
    # breadth: a context column in the daily table, quality checked, not in the metrics
    for q_ in ("talarico_race", "paxton_race", "race_either"):
        for c_ in ("national", "texas_local"):
            b = "news_mediacloud/%s/%s/breadth" % (q_, c_)
            assert b in cols and res["series"]["meta"][b]["role"] == "context" and b not in daily and b not in att
            assert res["series"]["meta"][b]["unit"] == "sources" and res["quality"][b]["status"] == "ok"
            assert res["quality"][b]["extra"]["days_where_source_sum_differs_from_count"] == []
    assert "news_mediacloud/race_both/national/breadth" not in cols
    m = res["queries"]["news_mediacloud"]["mediacloud"]
    assert m["endpoints"] == {"count": mc.COUNT_URL, "breadth": mc.SOURCE_INTERVAL_URL, "top_sources": mc.SOURCES_URL}
    top = m["top_sources"]["race_either"]["texas_local"]
    assert top["query"] == "race_either" and top["collection"] == "texas_local"
    assert [top["start"], top["end"]] == ["2026-09-01", "2026-11-02"] == m["top_sources_window"]
    assert top["sources"][0] == {"source": "synthetic-a.example", "count": 40}
    rendered = {q_["endpoint"] for q_ in res["queries"]["news_mediacloud"]["queries"]}
    assert rendered == {mc.COUNT_URL, mc.SOURCE_INTERVAL_URL, mc.SOURCES_URL}
    # golden numbers unaffected by the extra series
    cell = daily["wikipedia/pageviews_total"]["outcomes"]["volume_surprise"]["1"]
    assert cell["rho"] == pytest.approx(0.2786, abs=1e-4) and cell["n"] == 55
    assert KEY not in json.dumps(res)


def test_no_key_skip_message_mentions_dotenv(tmp_path):
    from raceattn.pipeline import run

    logs = []
    res = run(load_race(RACE5), ["news_mediacloud"], raw_dir=str(tmp_path), out_dir=str(tmp_path), log=logs.append,
              env={}, write=False)
    assert res["skipped"]["news_mediacloud"] == "missing key: set MEDIACLOUD_API_KEY (see .env.example)"
    assert any("MEDIACLOUD_API_KEY is not set" in l and ".env" in l for l in logs)


# -- CLI without a key

@pytest.mark.parametrize("argv", [["mediacloud", "collections", "--state", "TX"],
                                  ["mediacloud", "audit", "--race", "tx-senate-2026", "--phase", "tuning"]])
def test_cli_without_key(monkeypatch, capsys, argv):
    from raceattn.cli import main

    monkeypatch.delenv("MEDIACLOUD_API_KEY", raising=False)
    assert main(argv) == 2
    err = capsys.readouterr().err
    assert "MEDIACLOUD_API_KEY is not set" in err and ".env" in err


def patch_session(monkeypatch, route):
    """Every HttpClient made by the CLI gets a FakeSession with this route."""
    import raceattn.http as h
    from tests.fakes import FakeSession

    sessions = []

    def make():
        s = FakeSession(route)
        sessions.append(s)
        return s

    monkeypatch.setattr(h.requests, "Session", make)
    return sessions


def test_cli_collections(monkeypatch, capsys, tmp_path):
    from raceattn.cli import main

    monkeypatch.setenv("MEDIACLOUD_API_KEY", KEY)
    seen = []

    def route(m, url, params, headers, body):
        seen.append(params)
        assert url == mc.COLLECTIONS_URL
        return Resp(200, fx("collections_texas.synthetic.json"))

    patch_session(monkeypatch, route)
    assert main(["mediacloud", "collections", "--state", "TX", "--raw-dir", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert seen[0]["name"] == "Texas"
    assert "900001" in out and "Synthetic Texas - State & Local" in out and "123" in out
    assert "1 HTTP request(s) made, 0 served from the cache" in out
    assert main(["mediacloud", "collections", "--state", "TX", "--raw-dir", str(tmp_path)]) == 0
    assert "0 HTTP request(s) made, 1 served from the cache" in capsys.readouterr().out and len(seen) == 1


def test_cli_stops_on_429(monkeypatch, capsys, tmp_path):
    from raceattn.cli import main

    monkeypatch.setenv("MEDIACLOUD_API_KEY", KEY)
    calls = []
    patch_session(monkeypatch, lambda *a: calls.append(1) or Resp(429, {"detail": "slow down"}))
    assert main(["mediacloud", "collections", "--name", "Texas", "--raw-dir", str(tmp_path)]) == 2
    cap = capsys.readouterr()
    assert "HTTP 429" in cap.err and "rate limit" in cap.err and len(calls) == 1
    assert "1 HTTP request(s) made" in cap.out


# -- audit

def story_route(pages, seen=None):
    def route(m, url, params, headers, body):
        assert url == mc.STORY_LIST_URL and "expanded" not in params
        if seen is not None:
            seen.append(dict(params))
        tok = params.get("pagination_token")
        i = {None: 0, "tok-page-2": 1, "tok-page-3": 2}[tok]
        return Resp(200, pages[i])
    return route


def audit_client(tmp_path, route, refresh=False):
    http, sess = fake_http(route)
    return mc.Client(KEY, http=http, raw_dir=str(tmp_path / "raw"), refresh=refresh, pace_seconds=0), sess


def test_audit_csv_sample_and_syndication(tmp_path):
    cfg = mcqueries.load(TX_QUERIES)
    pages = fx("story_list.synthetic.json")["pages"]
    seen = []
    client, sess = audit_client(tmp_path, story_route(pages, seen))
    out = str(tmp_path / "audit" / "tuning.csv")
    res = mc.run_audit(cfg, client, "tuning", 100, 1, out_path=out, log=lambda *_: None)
    # 2 core queries x 2 configured collections x 3 pages
    assert client.requests == 12 and len(seen) == 12
    assert seen[0]["start"] == "2026-08-01" and seen[0]["end"] == "2026-08-24" and seen[0]["cs"] == "34412234"
    assert seen[1]["pagination_token"] == "tok-page-2"
    rows = list(csv.DictReader(open(out)))
    assert list(rows[0].keys()) == mc.AUDIT_COLUMNS
    assert len(rows) == 400 and {r["query"] for r in rows} == {"talarico_race", "paxton_race"}
    assert all(r[c] == "" for r in rows for c in mc.CODING_COLUMNS)
    assert len({r["story_id"] for r in rows if r["query"] == "talarico_race"}) == 100
    blob = open(out).read() + open(out.replace(".csv", ".summary.json")).read()
    assert "SYNTHETIC BODY TEXT" not in blob
    cell = res["cells"][0]
    assert cell["retrieved"] == 250 and cell["page_cap_hit"] is False and cell["sampled"] == 100
    assert "uniform over the 250 retrieved stories" in cell["sampling"]
    assert res["not_configured"] == []
    # syndication: 10 of the 250 stories share one title across domains
    assert cell["syndication"]["against_retrieved"]["syndicated"] == sum(
        1 for r in rows if r["query"] == "talarico_race" and r["collection"] == "national"
        and r["title"].startswith("Synthetic headline 1000 "))
    # deterministic: same seed, same sample (now from the cache, no requests)
    client2, sess2 = audit_client(tmp_path, story_route(pages))
    out2 = str(tmp_path / "audit2.csv")
    mc.run_audit(cfg, client2, "tuning", 100, 1, out_path=out2, log=lambda *_: None)
    assert open(out2).read() == open(out).read() and client2.requests == 0 and client2.cache_hits == 12
    out3 = str(tmp_path / "audit3.csv")
    mc.run_audit(cfg, client2, "tuning", 100, 2, out_path=out3, log=lambda *_: None)
    assert open(out3).read() != open(out).read()


def test_collection_without_id_is_skipped_and_listed(tmp_path):
    """A copy of the real config with texas_local's id set to null: no request, a log line, listed as not configured."""
    qdir = queries_dir(tmp_path, edit=lambda t: t.replace("id: 38381323,", "id: null,"))
    race = load_race(RACE5)
    c, sess = connector(tmp_path, None, qdir=qdir)
    logs = []
    c.log = logs.append
    cfg = c.query_config(race)
    assert [(k.key, k.id) for k in cfg.collections] == [("national", 34412234), ("texas_local", None)]
    sess.route = count_route(cfg)
    rows = c.fetch(race, race.window)
    assert len(sess.requests) == 8 + 6 and {r["params"]["cs"] for r in sess.requests} == {"34412234"}
    assert not any("texas_local" in r.series for r in rows)
    assert any("collection texas_local not configured (no id in tx-mc-5day.mediacloud.yaml); skipped, not counted "
               "as zero" in l for l in logs)
    m = c.query_summary(race, race.window)["mediacloud"]
    assert m["collections"]["texas_local"]["status"] == "not configured"
    assert m["queries"]["talarico_race"]["collections"]["texas_local"]["status"] == "not configured"

    alogs = []
    client, _ = audit_client(tmp_path, story_route(fx("story_list.synthetic.json")["pages"]))
    out = str(tmp_path / "audit" / "tuning.csv")
    res = mc.run_audit(cfg, client, "tuning", 100, 1, out_path=out, log=alogs.append)
    assert res["not_configured"] == ["texas_local"]
    assert json.load(open(out.replace(".csv", ".summary.json")))["not_configured"] == ["texas_local"]
    assert {cell["collection"] for cell in res["cells"]} == {"national"} and client.requests == 6
    assert "   collection texas_local: not configured (no id in the query config), no sample drawn" in alogs


def test_audit_page_cap_and_refuses_to_overwrite_coding(tmp_path):
    cfg = mcqueries.load(TX_QUERIES)
    pages = fx("story_list.synthetic.json")["pages"]
    client, _ = audit_client(tmp_path, story_route(pages))
    out = str(tmp_path / "a.csv")
    res = mc.run_audit(cfg, client, "analysis", 100, 1, max_pages=1, out_path=out, log=lambda *_: None)
    c = res["cells"][0]
    assert c["page_cap_hit"] is True and c["retrieved"] == 100 and "page cap (1 pages) was hit" in c["sampling"]
    rows = list(csv.DictReader(open(out)))
    rows[0]["relevant"] = "yes"
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=mc.AUDIT_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    with pytest.raises(FileExistsError, match="coded"):
        mc.run_audit(cfg, client, "analysis", 100, 1, max_pages=1, out_path=out, log=lambda *_: None)
    mc.run_audit(cfg, client, "analysis", 100, 1, max_pages=1, out_path=out, force=True, log=lambda *_: None)


def test_syndication_rule():
    s = [{"title": "Big News!", "url": "https://www.a.test/1"}, {"title": "big news", "url": "https://b.test/2"},
         {"title": "Big news", "url": "https://a.test/3"}, {"title": "Other", "url": "https://c.test/4"}]
    r = mc.syndication(s)["in_sample"]
    assert r == {"syndicated": 3, "n": 4, "rate": 0.75}
    assert mc.syndication(s[2:])["in_sample"]["syndicated"] == 0  # same domain only


# -- precision and agreement

def write_csv(path, rows):
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=mc.AUDIT_COLUMNS)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in mc.AUDIT_COLUMNS})


def test_wilson_known_values():
    # Newcombe (1998), Statistics in Medicine 17:857-872, Table I, method 3 (score interval without continuity
    # correction): 81/263 -> 0.2553 to 0.3662; 15/148 -> 0.0624 to 0.1605; 0/20 -> 0 to 0.1611; 1/29 -> 0.0061 to 0.1718
    for (x, n), (lo, hi) in {(81, 263): (0.2553, 0.3662), (15, 148): (0.0624, 0.1605), (0, 20): (0.0, 0.1611),
                             (1, 29): (0.0061, 0.1718)}.items():
        a, b = wilson(x, n)
        assert (round(a, 4), round(b, 4)) == (lo, hi)
    assert wilson(0, 0) == (None, None)


def test_krippendorff_alpha_published_examples():
    # Krippendorff (2011), "Computing Krippendorff's Alpha-Reliability", https://repository.upenn.edu/asc_papers/43
    # Section C (nominal data, 4 observers, 12 units, missing values): alpha = 0.743.
    N = None
    A = [1, 2, 3, 3, 2, 1, 4, 1, 2, N, N, N]
    B = [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, N, 3]
    C = [N, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, N]
    D = [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, N]
    r = krippendorff_alpha_nominal(list(zip(A, B, C, D)))
    assert round(r["alpha"], 3) == 0.743 and r["n_values"] == 40
    # Section A (binary data, 2 observers, 10 units): alpha = 0.095.
    a = [0, 1, 0, 0, 0, 0, 0, 0, 1, 0]
    b = [1, 1, 1, 0, 0, 1, 0, 0, 0, 0]
    assert round(krippendorff_alpha_nominal(list(zip(a, b)))["alpha"], 3) == 0.095
    assert krippendorff_alpha_nominal([["x", "x"], ["x", "x"]])["alpha"] is None  # no variation: undefined
    assert simple_agreement(list(zip(a, b))) == (0.6, 10)


def test_precision_and_agreement_cli(tmp_path, capsys):
    from raceattn.cli import main

    rows = ([{"query": "talarico_race", "collection": "national", "story_id": str(i), "relevant": "yes"} for i in range(81)]
            + [{"query": "talarico_race", "collection": "national", "story_id": str(100 + i), "relevant": "no"}
               for i in range(182)]
            + [{"query": "talarico_race", "collection": "national", "story_id": "u1", "relevant": "unclear"},
               {"query": "talarico_race", "collection": "national", "story_id": "u2", "relevant": ""}])
    a = tmp_path / "a.csv"
    write_csv(a, rows)
    p = mc.precision(mc.read_audit(str(a)), 0.9)[0]
    assert (p["yes"], p["no"], p["unclear"], p["uncoded"], p["coded"]) == (81, 182, 1, 1, 263)
    assert round(p["wilson95"][0], 4) == 0.2553 and p["meets_target"] is False
    assert main(["mediacloud", "precision", str(a)]) == 0
    out = capsys.readouterr().out
    assert "0.308" in out and "0.255 to 0.366" in out and "BELOW TARGET" in out

    # two coders: Krippendorff's binary example as relevant yes/no
    ra = [0, 1, 0, 0, 0, 0, 0, 0, 1, 0]
    rb = [1, 1, 1, 0, 0, 1, 0, 0, 0, 0]
    yn = {0: "no", 1: "yes"}
    ca = [{"query": "q", "collection": "national", "story_id": str(i), "relevant": yn[v], "category": "race"}
          for i, v in enumerate(ra)]
    cb = [{"query": "q", "collection": "national", "story_id": str(i), "relevant": yn[v],
           "category": "race" if i else "ag_office"} for i, v in enumerate(rb)] + [
        {"query": "q", "collection": "national", "story_id": "extra", "relevant": "yes"}]
    fa, fb = tmp_path / "ca.csv", tmp_path / "cb.csv"
    write_csv(fa, ca)
    write_csv(fb, cb)
    res = mc.agreement(mc.read_audit(str(fa)), mc.read_audit(str(fb)))
    assert res["joined"] == 10 and res["only_b"] == 1
    v = res["variables"]["relevant"]
    assert v["simple_agreement"] == 0.6 and round(v["krippendorff_alpha"], 3) == 0.095
    assert res["variables"]["category"]["simple_agreement"] == 0.9
    assert main(["mediacloud", "agreement", str(fa), str(fb)]) == 0
    out = capsys.readouterr().out
    assert "0.095" in out and "BELOW 0.70" in out


# -- live

@pytest.mark.live
def test_live_mediacloud_collections_and_one_count(tmp_path):
    key = os.environ.get("MEDIACLOUD_API_KEY")
    if not key:
        pytest.skip("MEDIACLOUD_API_KEY not set")
    client = mc.Client(key, raw_dir=str(tmp_path), pace_seconds=31)
    res = mc.search_collections(client, "United States - National", max_pages=1)
    assert isinstance(res["results"], list)
    cfg = mcqueries.load(TX_QUERIES)
    q = mc.RenderedQuery(mc.COUNT_URL, {"q": cfg.queries["talarico_race"], "start": "2026-10-01",
                                        "end": "2026-10-02", "platform": cfg.platform, "cs": "34412234"})
    rec = client.get("news_mediacloud", "live-smoke", "x", q, "count")
    assert "count_over_time" in rec["body"]
