"""Default source list with no keys: Kalshi and Wikipedia still run, the rest are skipped with a reason."""
import json
import os
import shutil

import pytest

from raceattn.config import load_race
from raceattn.pipeline import run
from raceattn.settings import load_settings
from tests.conftest import FIXTURE_RAW
from tests.fakes import Resp, fake_http

KEYS = ("X_BEARER_TOKEN", "MEDIACLOUD_API_KEY", "GUARDIAN_API_KEY", "NYT_API_KEY", "BSKY_HANDLE", "BSKY_APP_PASSWORD")


def route(method, url, params, headers, body):
    if url.endswith("/historical/cutoff"):
        return Resp(200, {"trades_created_ts": "2026-09-11T00:00:00Z"})
    if url.endswith("/trades"):
        t = params["min_ts"] + 1800
        return Resp(200, {"cursor": "", "trades": [
            {"trade_id": str(t), "created_time": __import__("datetime").datetime.utcfromtimestamp(t).strftime(
                "%Y-%m-%dT%H:%M:%SZ"), "count_fp": "5.00", "is_block_trade": False}]})
    if "searchPosts" in url:
        day = params["since"][:10]
        return Resp(200, {"posts": [{"uri": "u-%s-%s" % (params["q"], day),
                                     "record": {"createdAt": day + "T15:30:00Z"}, "indexedAt": day + "T15:30:01Z"}]})
    raise AssertionError("unexpected request " + url)


@pytest.fixture(scope="module")
def result(tmp_path_factory):
    raw = tmp_path_factory.mktemp("raw")
    shutil.copytree(FIXTURE_RAW, raw, dirs_exist_ok=True)
    out = tmp_path_factory.mktemp("out")
    http, sess = fake_http(route)
    logs = []
    res = run(load_race("tx-senate-2026"), None, raw_dir=str(raw), out_dir=str(out), http=http, log=logs.append,
              env={}, display=False)
    return res, logs, str(out), sess


def test_default_sources_and_skips(result):
    res, logs, _, _ = result
    assert res["sources_requested"] == load_settings()["default_sources"]
    assert res["sources"] == ["kalshi", "kalshi_trades", "wikipedia", "bluesky"]
    sk = res["skipped"]
    assert set(sk) == {"x", "news_mediacloud", "news_guardian", "news_nyt", "news_manual"}
    assert "X_BEARER_TOKEN" in sk["x"] and "missing manual CSV" in sk["news_manual"]
    assert any(l.startswith("skipped connectors:") for l in logs)


def test_golden_numbers_unchanged(result):
    res = result[0]
    cell = res["metrics"]["daily"]["wikipedia/pageviews_total"]["outcomes"]["volume_surprise"]["1"]
    assert cell["rho"] == pytest.approx(0.2786, abs=1e-4) and cell["n"] == 55
    assert len(res["series"]["hourly"]["rows"]) == 1536
    assert res["series"]["hourly"]["columns"] == ["ts_utc", "kalshi/price_close", "kalshi/volume"]


def test_hourly_grid_and_daily_columns(result):
    res = result[0]
    g = res["series"]["hourly_grid"]
    assert g["columns"] == ["ts_utc", "bluesky/post_count", "kalshi/small_trade_share", "kalshi/trade_count"]
    assert len(g["rows"]) == 65 * 24 and g["rows"][0][0] == "2026-09-01T01:00:00Z"
    row = dict(zip(g["columns"], g["rows"][15]))  # hour 15:00-16:00 on Sep 1 ends at 16:00
    assert row["ts_utc"] == "2026-09-01T16:00:00Z" and row["bluesky/post_count"] == 2.0
    d = res["series"]["daily"]["columns"]
    assert "bluesky/post_count" in d and "kalshi/trade_count" in d and "kalshi/small_trade_share" in d
    assert "bluesky/post_count" in res["metrics"]["hourly"] and "bluesky/post_count" in res["metrics"]["daily"]
    assert "kalshi/trade_count" not in res["metrics"]["daily"]


def test_events_and_polling(result):
    res = result[0]
    ev = res["metrics"]["events"]
    assert ev["status"] == "no confirmed events" and ev["n_needs_review_ignored"] == 53
    e = ev["series"]["wikipedia/pageviews_total"]
    assert e["event_windows"] == {"status": "no confirmed events"}
    assert e["reversion"]["n_spikes"] == e["spikes"]["n"] and "n" in e["reversion"]
    assert len(e["query_hash"]["attention"]) == 16 and e["quality_status"] == "ok"
    assert res["polling"]["polling_density"] == 53 and res["polling"]["status"] == "needs_review"


def test_licensing_warning(result):
    res, logs, out, _ = result
    assert res["licensing"]["confirmed"] is False
    assert res["licensing"]["sources_with_unconfirmed_terms"] == ["bluesky"]
    assert any(l.startswith("LICENSING WARNING") for l in logs)
    from raceattn.cli import main

    assert main(["publish", "--out-dir", out]) == 1


def test_every_new_series_has_quality(result):
    res = result[0]
    for s in ("kalshi/trade_count", "kalshi/small_trade_share", "bluesky/post_count"):
        q = res["quality"][s]
        assert {"coverage_days", "window_days", "missing_days", "longest_gap", "near_zero", "status"} <= set(q)


def test_cli_default_run_without_keys(tmp_path, monkeypatch, capsys):
    """Acceptance (offline form): the CLI with no keys and no --sources exits 0 and lists the skipped ones."""
    from raceattn import cli
    import raceattn.pipeline as pl

    for k in KEYS:
        monkeypatch.delenv(k, raising=False)
    raw = tmp_path / "raw"
    shutil.copytree(FIXTURE_RAW, raw)
    http, _ = fake_http(route)
    monkeypatch.setattr(pl, "HttpClient", lambda: http)
    rc = cli.main(["run", "--race", "tx-senate-2026", "--no-display", "--raw-dir", str(raw), "--out-dir", str(tmp_path / "out")])
    out = capsys.readouterr().out
    assert rc == 0
    for s in ("x", "news_mediacloud", "news_guardian", "news_nyt", "news_manual"):
        assert "== %s: skipped" % s in out


def test_publish_without_licensed_sources(tmp_path):
    from raceattn.cli import main

    (tmp_path / "r.json").write_text(json.dumps({"race": {"race_id": "r"}, "sources": ["kalshi", "wikipedia"]}))
    assert main(["publish", "--out-dir", str(tmp_path)]) == 0
