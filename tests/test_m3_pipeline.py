"""M3 pipeline additions: per-race overrides, index.json headline metrics for the map, the event overlay and
`run --all`."""
import json
import os
import shutil

import pytest

from raceattn.config import load_race
from raceattn.pipeline import index_metrics, run
from raceattn.settings import load_settings
from tests.conftest import FIXTURE_RAW
from tests.test_pipeline_m2 import route
from tests.fakes import fake_http


@pytest.fixture(scope="module")
def result(tmp_path_factory):
    raw = tmp_path_factory.mktemp("raw")
    shutil.copytree(FIXTURE_RAW, raw, dirs_exist_ok=True)
    out = tmp_path_factory.mktemp("out")
    settings = load_settings()
    settings["race_overrides"] = {"tx-senate-2026": {"skip": {"bluesky": "bounded runtime (test)"},
                                                     "connectors": {"kalshi_trades": {"small_trade_threshold": 5}},
                                                     "note": "test override"}}
    http, _ = fake_http(route)
    res = run(load_race("tx-senate-2026"), None, raw_dir=str(raw), out_dir=str(out), http=http, log=lambda s: None,
              env={}, settings=settings)
    return res, str(out)


def test_override_skips_with_reason_and_merges_settings(result):
    res, _ = result
    assert "bluesky" not in res["sources"]
    assert res["skipped"]["bluesky"] == "left out by race_overrides in config/project.yaml: bounded runtime (test)"
    assert res["run_overrides"]["note"] == "test override"
    assert res["quality"]["kalshi/trade_count"]["extra"]["small_trade_threshold_contracts"] == 5


def test_index_headline_metrics(result):
    res, out = result
    idx = json.load(open(os.path.join(out, "index.json")))["races"]["tx-senate-2026"]
    m = idx["metrics"]
    assert idx["state"] == "TX" and idx["office"] == "senate"
    assert m["attention_vs_volume"] == pytest.approx({**m["attention_vs_volume"], "rho": 0.2383, "n": 56, "lag": 0})
    assert m["attention_total"]["n_days"] == 63  # election night left out
    days = [r for r in res["series"]["daily"]["rows"] if not r[1]]
    col = res["series"]["daily"]["columns"].index("wikipedia/pageviews_total")
    assert m["attention_total"]["value"] == pytest.approx(sum(r[col] for r in days))
    pc = m["price_change"]
    assert pc["from"] == "2026-09-01" and pc["to"] == "2026-11-02" and pc["n_days"] == 63
    assert pc["cents"] == pytest.approx((pc["last_close"] - pc["first_close"]) * 100, abs=0.01)
    assert m["polling_density"] == 53
    assert m["data_coverage"]["share"] == 1.0 and m["data_coverage"]["n_series"] == 4
    assert m["quality_summary"]["skipped_sources"]["bluesky"].startswith("left out")
    a = m["attention"]["wikipedia/pageviews/Ken_Paxton"]
    assert a["group"] == "looking" and a["n_pairs"] == 56 and a["rho_volume_surprise"] is not None
    # the M1 fields are still there
    assert idx["headline"]["lags"]["1"] == {"rho": 0.2786, "n": 55}


def test_unusable_series_is_listed_and_has_no_number():
    res = {"series": {"daily": {"columns": ["date", "excluded", "kalshi/price_close", "kalshi/volume", "bluesky/post_count"],
                                "rows": [["2026-09-%02d" % (i + 1), False, 0.5, 10.0, None] for i in range(25)]},
                      "meta": {"bluesky/post_count": {"connector": "bluesky"}}},
           "quality": {"bluesky/post_count": {"status": "unusable", "coverage": 0.0, "reasons": ["no data"]},
                       "kalshi/price_close": {"status": "ok", "coverage": 1.0, "reasons": []}},
           "metrics": {"daily": {"bluesky/post_count": {"status": "skipped", "reason": "unusable"}}},
           "polling": {"polling_density": None}, "window": {"days": 25}, "skipped": {}}
    m = index_metrics(res)
    b = m["attention"]["bluesky/post_count"]
    assert b["total"] is None and b["n_days"] == 0 and b["status"] == "unusable" and b["group"] == "talking"
    assert m["quality_summary"]["unusable_series"] == {"bluesky/post_count": ["no data"]}
    assert m["attention_total"]["value"] is None  # no Wikipedia series: insufficient data on the map


def test_events_overlay_lists_draft_rows(result):
    res, _ = result
    ov = res["events_overlay"]
    assert ov["n"] == 53 and ov["n_confirmed"] == 0
    assert all(r["status"] == "needs_review" and r["type"] == "poll" for r in ov["rows"])


def test_run_all_uses_confirmed_configs(tmp_path, monkeypatch, capsys):
    from raceattn import cli
    import raceattn.pipeline as pl
    import raceattn.config as cfg

    races = tmp_path / "races"
    races.mkdir()
    shutil.copy(os.path.join(cfg.RACES_DIR, "tx-senate-2026.yaml"), races)
    (races / "drafts").mkdir()
    shutil.copy(os.path.join(cfg.RACES_DIR, "tx-senate-2026.yaml"), races / "drafts" / "zz-senate-2026.yaml")
    monkeypatch.setattr(cli, "confirmed_races", lambda: cfg.confirmed_races(str(races)))
    raw = tmp_path / "raw"
    shutil.copytree(FIXTURE_RAW, raw)
    http, _ = fake_http(route)
    monkeypatch.setattr(pl, "HttpClient", lambda: http)
    for k in ("X_BEARER_TOKEN", "MEDIACLOUD_API_KEY", "GUARDIAN_API_KEY", "NYT_API_KEY", "BSKY_HANDLE", "BSKY_APP_PASSWORD"):
        monkeypatch.delenv(k, raising=False)
    rc = cli.main(["run", "--all", "--sources", "kalshi,wikipedia", "--raw-dir", str(raw), "--out-dir", str(tmp_path / "out")])
    out = capsys.readouterr().out
    assert rc == 0
    assert "######## tx-senate-2026" in out and "zz-senate" not in out
    assert "1 race(s) written, 0 failed" in out
    idx = json.load(open(tmp_path / "out" / "index.json"))
    assert list(idx["races"]) == ["tx-senate-2026"]
