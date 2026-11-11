"""Event generator (recorded MediaWiki fixture) and event / spike / reversion metrics."""
import csv
import datetime as dt
import os

import pytest

from raceattn import events as gen
from raceattn.config import load_race
from raceattn.metrics.events import NO_CONFIRMED, event_metrics, load_events, reversion
from raceattn.settings import load_settings
from tests.conftest import FIXTURE_RAW, ROOT

REV = "https://en.wikipedia.org/w/index.php?title=2026_United_States_Senate_election_in_Texas&oldid=1384978385"


@pytest.fixture(scope="module")
def generated():
    race = load_race("tx-senate-2026")
    rec = gen.fetch_page(race, http=None, raw_dir=FIXTURE_RAW)  # cached: no request
    return gen.generate(race, rec)


def test_generator_from_recorded_revision(generated):
    rows, meta = generated
    assert meta["revid"] == 1384978385 and meta["revision_url"] == REV
    assert meta["polling_density"] == 53 == meta["counts"]["poll"] == len(rows)
    assert meta["counts"] == {"poll": 53, "debate": 0, "filing_deadline": 0}  # page lists none in the window
    assert all(r["status"] == "needs_review" and r["source_url"] == REV and r["type"] == "poll" for r in rows)
    assert all("2026-09-01" <= r["date_utc"] <= "2026-11-04" for r in rows)
    assert all("date = release date" in r["note"] or "date = end of fieldwork" in r["note"] for r in rows)
    first = rows[0]
    assert first["date_utc"] == "2026-09-09" and first["note"].startswith("Univision/YouGov, fieldwork August 27")
    assert all("–" not in r["note"] and "\u2014" not in r["note"] for r in rows)
    assert meta["unparsed_poll_rows"] == ["Brad Parscale (R): 'Mid-April 2025'"]


def test_committed_draft_matches_generator(generated):
    rows, meta = generated
    with open(os.path.join(ROOT, "config", "events", "tx-senate-2026.csv"), encoding="utf-8") as f:
        committed = list(csv.DictReader(f))
    assert committed == rows


@pytest.mark.parametrize("s, start, end", [
    ("October 31 – November 2, 2026", "2026-10-31", "2026-11-02"),
    ("October 27–30, 2026", "2026-10-27", "2026-10-30"),
    ("September 8&ndash;9, 2026", "2026-09-08", "2026-09-09"),
    ("December 28, 2025 – January 3, 2026", "2025-12-28", "2026-01-03"),
    ("November 1, 2026", "2026-11-01", "2026-11-01"),
    ("through November 1, 2026", "2026-11-01", "2026-11-01"),
    ("1–3 October 2026", "2026-10-01", "2026-10-03"),
])
def test_parse_range(s, start, end):
    a, b = gen.parse_range_end(s)
    assert (a.isoformat(), b.isoformat()) == (start, end)


def test_parse_range_unparseable():
    assert gen.parse_range_end("Mid–April 2025") == (None, None)


def test_rowspan_and_named_refs():
    text = """== General election ==
=== Polling ===
{| class="wikitable"
! Poll source
! Date(s)<br />administered
! A
|-
| rowspan=2 |Pollster One<ref>{{cite web |title=x |date=October 9, 2026}}</ref>
| rowspan=2 |October 1–5, 2026
| 40%
|-
| 41%
|-
|Pollster Two<ref name="p2"/>
|October 2–3, 2026
| 39%
|}
<ref name="p2">{{cite news |date=December 30, 2026 |title=late}}</ref>
"""
    p = gen.extract_polls(text, dt.date(2026, 9, 1), dt.date(2026, 11, 4))
    assert [(x["pollster"], x["date"].isoformat(), x["basis"].split(" (")[0]) for x in p["polls"]] == [
        ("Pollster Two", "2026-10-03", "end of fieldwork"),  # cite date > 30 days later: not a release date
        ("Pollster One", "2026-10-09", "release date")]
    assert p["n_polls_total"] == 2  # the rowspan row is the same poll


def test_debates_and_deadlines_only_when_listed():
    text = """== General election ==
=== Debates ===
{| class="wikitable"
! No.
! Date
! Host
|-
! 1
| October 10, 2026
| [[Some Station]]
|}
The filing deadline was September 15, 2026.
"""
    w0, w1 = dt.date(2026, 9, 1), dt.date(2026, 11, 4)
    d = gen.extract_debates(text, w0, w1)
    assert [(x["date"].isoformat(), "Some Station" in x["note"]) for x in d] == [("2026-10-10", True)]
    f = gen.extract_deadlines(text, w0, w1)
    assert [x["date"].isoformat() for x in f] == ["2026-09-15"]
    assert gen.extract_debates("no tables here", w0, w1) == [] and gen.extract_deadlines("nothing", w0, w1) == []


def test_cli_refuses_to_overwrite_confirmed(tmp_path, monkeypatch, capsys):
    from raceattn import cli

    monkeypatch.setattr(gen, "EVENTS_DIR", str(tmp_path))
    (tmp_path / "tx-senate-2026.csv").write_text("date_utc,type,source_url,note,status\n2026-10-01,poll,u,n,confirmed\n")
    assert cli.main(["events", "--race", "tx-senate-2026", "--raw-dir", FIXTURE_RAW]) == 2
    assert "confirmed" in capsys.readouterr().err
    assert cli.main(["events", "--race", "tx-senate-2026", "--raw-dir", FIXTURE_RAW, "--force"]) == 0
    assert "53 poll(s)" in capsys.readouterr().out


# ------------------------------------------------------------------ metrics
DAYS = [dt.date(2026, 9, 1) + dt.timedelta(days=i) for i in range(30)]
SETTINGS = load_settings()["events"]


def flat_series():
    att = [100.0] * 30
    att[15] = 1000.0  # spike on day 15
    att[25] = 900.0   # spike on day 25
    close = [0.5] * 30
    for i in range(15, 30):
        close[i] = 0.6  # day-15 move of +0.10 ...
    for i in range(17, 30):
        close[i] = 0.52  # ... mostly reversed by day 17
    vol = [10.0 + (i % 3) for i in range(30)]
    return att, close, vol


def ev(*dates, needs_review=0):
    return {"confirmed": [{"date": d, "type": "poll", "source_url": "u"} for d in dates],
            "needs_review": needs_review, "problems": [], "exists": True}


def test_no_confirmed_events_says_so():
    att, close, vol = flat_series()
    out = event_metrics(DAYS, [True] * 30, att, close, vol, ev(needs_review=53), SETTINGS)
    assert out["event_windows"] == {"status": NO_CONFIRMED}
    assert out["excess_attention"] == {"status": NO_CONFIRMED}
    assert out["spikes"]["dates"] == ["2026-09-16", "2026-09-26"]
    r = out["reversion"]
    assert r["n_spikes"] == 2 and r["n"] == 1 and r["n_no_move"] == 1 and r["n_reverted"] == 1
    assert r["spikes"][0]["reversal_fraction"] == pytest.approx(0.8)


def test_event_windows_and_excess():
    att, close, vol = flat_series()
    out = event_metrics(DAYS, [True] * 30, att, close, vol, ev(DAYS[14], dt.date(2027, 1, 1)), SETTINGS)
    w = out["event_windows"]
    assert w["status"] == "computed" and w["n_events"] == 1 and w["events_outside_window"] == 1
    assert w["offsets"]["1"]["attention_surprise"]["n"] == 1
    assert w["offsets"]["1"]["attention_surprise"]["mean"] > 2  # the spike is one day after the event
    assert w["offsets"]["1"]["price_change"]["mean"] == pytest.approx(0.1)
    x = out["excess_attention"]
    assert x["n"] == 1 and x["dates"] == ["2026-09-26"] and x["n_spikes"] == 2


def test_excluded_days_masked():
    att, close, vol = flat_series()
    keep = [d != DAYS[15] for d in DAYS]
    out = event_metrics(DAYS, keep, att, close, vol, ev(), SETTINGS)
    assert out["spikes"]["dates"] == ["2026-09-26"]


def test_reversion_rules():
    days = DAYS[:6]
    r = reversion(days, [0.5, 0.6, 0.6, 0.6, 0.6, None], [1, 4], 3, 0.5, 0.01)
    assert r["spikes"][0]["reverted"] is False and r["spikes"][1]["status"] == "insufficient data"
    assert r["share_reverted"] == 0.0


def test_load_events(tmp_path):
    p = tmp_path / "e.csv"
    p.write_text("date_utc,type,source_url,note,status\n2026-10-01,poll,u,n,confirmed\n2026-10-02,poll,u,n,"
                 "needs_review\n2026-10-03,poll,u,n,maybe\nbad,poll,u,n,confirmed\n")
    e = load_events(str(p))
    assert [x["date"].isoformat() for x in e["confirmed"]] == ["2026-10-01"]
    assert e["needs_review"] == 1 and len(e["problems"]) == 2
    assert load_events(str(tmp_path / "missing.csv"))["exists"] is False


@pytest.mark.live
def test_live_events_texas(tmp_path):
    from raceattn.http import HttpClient

    race = load_race("tx-senate-2026")
    rows, meta = gen.generate(race, gen.fetch_page(race, HttpClient(), raw_dir=str(tmp_path)))
    assert meta["polling_density"] > 0 and all(r["status"] == "needs_review" for r in rows)
