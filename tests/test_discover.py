"""Offline tests for `discover` (raceattn/discover.py) on responses recorded live on 2026-11-11.

tests/fixtures/raw holds the discovery cache: the Kalshi /events walks (reduced to Senate and Governor election
events, as the live run stores them), /events/{ticker} for the matched events, and the MediaWiki query and parse
responses for TX, OH, FL, KY and AZ (no 2026 Senate race)."""
import os
import shutil

import pytest
import yaml

from raceattn import discover as dv
from raceattn.config import confirmed_races, load_race, validate
from tests.conftest import FIXTURE_RAW, ROOT


@pytest.fixture(scope="module")
def rep(tmp_path_factory):
    out = tmp_path_factory.mktemp("drafts")
    return dv.discover("senate", ["TX", "OH", "FL", "KY", "AZ"], raw_dir=FIXTURE_RAW, drafts_dir=str(out),
                       log=lambda s: None), out


def by_state(r, st):
    return next(x for x in r["resolved"] if x["state"] == st)


def test_resolves_states_the_ticker_pattern_missed(rep):
    r, _ = rep
    assert {x["state"] for x in r["resolved"]} == {"TX", "OH", "FL", "KY"}
    ky = by_state(r, "KY")
    assert ky["kalshi_event"] == "SENATELA-26"  # Kentucky's event, found by its title only
    assert ky["followed_market"] == "SENATELA-26-D"
    assert by_state(r, "OH")["kalshi_event"] == "SENATEOHS-26"
    assert by_state(r, "FL")["kalshi_event"] == "SENATEFLS-26"


def test_special_elections_resolve_through_redirects(rep):
    r, out = rep
    oh = yaml.safe_load(open(os.path.join(out, "oh-senate-2026.yaml")))
    assert oh["wikipedia_pages"][0] == "2026_United_States_Senate_special_election_in_Ohio"
    assert "redirects" in oh["discovery"]["wikipedia_pages"]["why"]
    fl = yaml.safe_load(open(os.path.join(out, "fl-senate-2026.yaml")))
    assert fl["wikipedia_pages"][0] == "2026_United_States_Senate_special_election_in_Florida"


def test_unresolved_state_lists_reasons(rep):
    r, _ = rep
    az = next(x for x in r["unresolved"] if x["state"] == "AZ")
    assert any("no Kalshi event" in m for m in az["reasons"])
    assert any("no Wikipedia page" in m for m in az["reasons"])


def test_drafts_are_valid_needs_review_configs(rep):
    _, out = rep
    for fn in ("tx-senate-2026.yaml", "oh-senate-2026.yaml", "fl-senate-2026.yaml", "ky-senate-2026.yaml"):
        race = load_race(os.path.join(out, fn))
        assert race.status == "needs_review"
        assert race.subreddits == ()
        assert race.discovery["subreddits"]["confidence"] == "low"
        for k in ("kalshi", "entities", "wikipedia_pages", "news_query", "window", "exclude_days"):
            assert race.discovery[k]["confidence"] in ("high", "medium", "low")
            assert race.discovery[k]["source"]


def test_tx_draft_matches_hand_config_except_subreddits(rep):
    r, out = rep
    rows = {c["field"]: c for c in r["comparisons"]["tx-senate-2026"]}
    assert [f for f, c in rows.items() if not c["match"]] == ["subreddits"]
    assert rows["subreddits"]["hand"] == ["texas", "TexasPolitics"] and rows["subreddits"]["draft"] == []
    tx = load_race(os.path.join(out, "tx-senate-2026.yaml"))
    assert tx.news_query == '("Talarico" OR "Ken Paxton") AND Senate'
    assert tx.kalshi.followed_market == "SENATETX-26-D"


def test_report_files_written(rep):
    _, out = rep
    md = open(os.path.join(out, "discover-report-senate.md")).read()
    assert "SENATELA-26" in md and "Not resolved" in md and "subreddits | NO" in md


def test_infobox_and_surname_helpers():
    box = dv.infobox("x {{Infobox election\n| election_date = November 3, 2026\n| nominee1 = '''[[Jon Husted|Jon Husted]]'''"
                     "\n| party1 = Republican Party (United States)\n| percentage1 = 48.1%<ref>x</ref>\n| nominee2 = "
                     "[[Sherrod Brown]]\n| party2 = Democratic Party (United States)\n| percentage2 = '''51.0%'''\n"
                     "| map = {{switcher |a |b}}\n}} rest")
    n = dv.nominees(box)
    assert [(x["target"], x["name"], x["percentage"]) for x in n] == [("Jon Husted", "Jon Husted", 48.1),
                                                                     ("Sherrod Brown", "Sherrod Brown", 51.0)]
    assert dv.parse_election_date(box).isoformat() == "2026-11-03"
    assert dv.surname("Martin Luther King Jr.") == "King"
    assert dv.title_regex("VA", "senate").match("Virginia Senate winner?")
    assert not dv.title_regex("VA", "senate").match("West Virginia Senate winner?")
    assert dv.title_regex("AK", "governor").match("Alaska Governor winner? (Party)")


def test_confirmed_races_skips_drafts_and_needs_review(tmp_path):
    shutil.copy(os.path.join(ROOT, "config", "races", "tx-senate-2026.yaml"), tmp_path)
    data = yaml.safe_load(open(os.path.join(ROOT, "config", "races", "tx-senate-2026.yaml")))
    data.update(race_id="xx-senate-2026", state="OH", status="needs_review")
    (tmp_path / "xx-senate-2026.yaml").write_text(yaml.safe_dump(data))
    (tmp_path / "drafts").mkdir()
    races, left = confirmed_races(str(tmp_path))
    assert [r.race_id for r in races] == ["tx-senate-2026"]
    assert left == {"xx-senate-2026.yaml": "status is needs_review, not confirmed"}
    with pytest.raises(Exception):
        validate({**data, "status": "maybe"})
