"""Live smoke test: hits the real Kalshi and Wikimedia APIs. Run with: pytest --live"""
import pytest

from raceattn.config import load_race
from raceattn.pipeline import run

pytestmark = pytest.mark.live


def test_live_texas(tmp_path):
    res = run(load_race("tx-senate-2026"), ["kalshi", "wikipedia"], raw_dir=str(tmp_path / "raw"),
              out_dir=str(tmp_path / "out"), refresh=True, log=lambda *_: None)
    assert len(res["series"]["hourly"]["rows"]) == 1536
    for s in ("wikipedia/pageviews_total", "kalshi/volume"):
        assert res["quality"][s]["coverage_days"] == 65
    cell = res["metrics"]["daily"]["wikipedia/pageviews_total"]["outcomes"]["volume_surprise"]["1"]
    assert cell["rho"] == pytest.approx(0.28, abs=0.02) and cell["n"] == 55
