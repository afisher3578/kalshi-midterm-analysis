import copy
import datetime as dt
import os

import pytest
import yaml

from raceattn.config import ConfigError, load_race, resolve_race_path, validate
from tests.conftest import ROOT, TEST_CONFIGS

TX = os.path.join(ROOT, "config", "races", "tx-senate-2026.yaml")


def base():
    with open(TX) as f:
        return yaml.safe_load(f)


def test_tx_config_loads_by_id_and_path():
    a = load_race("tx-senate-2026")
    b = load_race(TX)
    assert a == b
    assert a.race_id == "tx-senate-2026" and a.state == "TX" and a.office == "senate"
    assert a.window.start == dt.date(2026, 9, 1) and a.window.end == dt.date(2026, 11, 4)
    assert a.window.n_days == 65
    assert a.exclude_days == (dt.date(2026, 11, 3), dt.date(2026, 11, 4))
    assert a.kalshi.followed_market == "SENATETX-26-D"
    assert a.wikipedia_pages == ("2026_United_States_Senate_election_in_Texas", "James_Talarico", "Ken_Paxton")
    assert a.polling_density is None


def test_tx_config_matches_spec_exactly():
    d = base()
    assert d == {
        "race_id": "tx-senate-2026", "state": "TX", "office": "senate", "election_date": dt.date(2026, 11, 3),
        "window": {"start": dt.date(2026, 9, 1), "end": dt.date(2026, 11, 4)},
        "exclude_days": [dt.date(2026, 11, 3), dt.date(2026, 11, 4)],
        "kalshi": {"series": "SENATETX", "event": "SENATETX-26", "followed_market": "SENATETX-26-D"},
        "entities": [{"name": "James Talarico", "aliases": ["Talarico"]}, {"name": "Ken Paxton", "aliases": ["Paxton"]}],
        "wikipedia_pages": ["2026_United_States_Senate_election_in_Texas", "James_Talarico", "Ken_Paxton"],
        "subreddits": ["texas", "TexasPolitics"], "news_query": '("Talarico" OR "Ken Paxton") AND Senate',
        "polling_density": None,
    }


def test_unknown_race_id_lists_available():
    with pytest.raises(ConfigError, match="tx-senate-2026"):
        resolve_race_path("zz-nothing-2026")


def test_missing_file_path():
    with pytest.raises(ConfigError, match="not found"):
        resolve_race_path("/nope/missing.yaml")


def test_dummy_config_valid():
    r = load_race(os.path.join(TEST_CONFIGS, "oh-dummy-2030.yaml"))
    assert r.office == "governor" and r.polling_density == 4


@pytest.mark.parametrize("mutate, msg", [
    (lambda d: d.pop("race_id"), "missing required key 'race_id'"),
    (lambda d: d.pop("kalshi"), "missing required key 'kalshi'"),
    (lambda d: d["kalshi"].pop("followed_market"), "missing required key 'followed_market'"),
    (lambda d: d.pop("wikipedia_pages"), "missing required key 'wikipedia_pages'"),
    (lambda d: d.update(office="mayor"), "office: must be one of senate | house | governor | national"),
    (lambda d: d.update(state="Texas"), "two-letter"),
    (lambda d: d.update(race_id="TX Senate"), "lowercase"),
    (lambda d: d.update(election_date="Nov 3"), "election_date: expected a date"),
    (lambda d: d["window"].update(start="2026-13-01"), "window.start: expected a date"),
    (lambda d: d.update(window={"start": dt.date(2026, 11, 5), "end": dt.date(2026, 11, 4)}), "is after end"),
    (lambda d: d.update(window="2026-09-01"), "window: expected"),
    (lambda d: d.update(exclude_days=[dt.date(2026, 12, 1)]), "not inside or adjacent"),
    (lambda d: d.update(exclude_days="2026-11-03"), "exclude_days: expected a list"),
    (lambda d: d.update(entities=[]), "entities: expected a non-empty list"),
    (lambda d: d.update(entities=[{"aliases": ["x"]}]), "missing required key 'name'"),
    (lambda d: d.update(wikipedia_pages=["A", 3]), "list of non-empty strings"),
    (lambda d: d.update(wikipedia_pages=["A", "A"]), "duplicate"),
    (lambda d: d.update(polling_density="many"), "polling_density"),
    (lambda d: d.update(kalshi_ticker="X"), "unknown keys kalshi_ticker"),
])
def test_validation_errors(mutate, msg):
    d = copy.deepcopy(base())
    mutate(d)
    with pytest.raises(ConfigError, match=msg.replace("|", r"\|")):
        validate(d, "tx.yaml")


def test_exclude_days_adjacent_ok():
    d = base()
    d["exclude_days"] = [dt.date(2026, 8, 31), "2026-11-05"]
    r = validate(d)
    assert r.exclude_days == (dt.date(2026, 8, 31), dt.date(2026, 11, 5))


def test_optional_keys_default():
    d = base()
    for k in ("exclude_days", "subreddits", "news_query", "polling_density"):
        d.pop(k)
    r = validate(d)
    assert r.exclude_days == () and r.subreddits == () and r.news_query is None


def test_top_level_not_mapping():
    with pytest.raises(ConfigError, match="mapping"):
        validate(["a"])
