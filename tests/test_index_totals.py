"""index.json races[*].display: display-window totals for the dashboard map (Kalshi volume, Wikipedia total, the
headline news count), each with n_days. The small tables here are SYNTHETIC; the last test reads the committed
data/processed files (skipped when they are absent)."""
import json
import os

import pytest

from raceattn import display
from raceattn.cli import main
from tests.conftest import ROOT

PROCESSED = os.path.join(ROOT, "data", "processed")
NEWS = display.COL_NEWS_HEADLINE


def dd(rows, cols):
    return {"window": {"start": "2026-08-05", "end": "2026-08-07", "days": 3}, "columns": ["date", *cols], "rows": rows}


def test_totals_skip_nulls_and_count_days():
    t = display.display_totals(dd([
        {"date": "2026-08-05", "kalshi_volume": 10.5, "wikipedia_pageviews_total": 100, NEWS: 3},
        {"date": "2026-08-06", "kalshi_volume": None, "wikipedia_pageviews_total": 0, NEWS: None},
        {"date": "2026-08-07", "kalshi_volume": 4, "wikipedia_pageviews_total": None, NEWS: None},
    ], ["kalshi_volume", "wikipedia_pageviews_total", NEWS]))
    assert t["window"] == {"start": "2026-08-05", "end": "2026-08-07", "days": 3}
    assert t["kalshi_volume"] == {"total": 14.5, "n_days": 2}
    assert t["wikipedia_pageviews_total"] == {"total": 100, "n_days": 2}  # a zero day is a day with data
    assert t[NEWS] == {"total": 3, "n_days": 1}


def test_missing_columns_are_left_out_and_all_null_is_null():
    t = display.display_totals(dd([{"date": "2026-08-05", "kalshi_volume": None}], ["kalshi_volume"]))
    assert t["kalshi_volume"] == {"total": None, "n_days": 0}
    assert "wikipedia_pageviews_total" not in t and NEWS not in t
    assert display.display_totals(None) is None


def test_refresh_command_patches_only_the_display_key(tmp_path):
    race = {"series": {"display_daily": dd([{"date": "2026-08-05", "kalshi_volume": 7}], ["kalshi_volume"])}}
    (tmp_path / "zz-senate-2026.json").write_text(json.dumps(race))
    (tmp_path / "index.json").write_text(json.dumps({"project": "p", "races": {
        "zz-senate-2026": {"race_id": "zz-senate-2026", "metrics": {"x": 1}},
        "zz-missing-2026": {"race_id": "zz-missing-2026"}}}))
    assert main(["index-totals", "--out-dir", str(tmp_path)]) == 0
    idx = json.loads((tmp_path / "index.json").read_text())
    assert idx["races"]["zz-senate-2026"]["display"]["kalshi_volume"] == {"total": 7, "n_days": 1}
    assert idx["races"]["zz-senate-2026"]["metrics"] == {"x": 1}
    assert "display" not in idx["races"]["zz-missing-2026"]


@pytest.mark.skipif(not os.path.isfile(os.path.join(PROCESSED, "index.json")), reason="no committed processed data")
def test_committed_index_matches_the_race_files():
    with open(os.path.join(PROCESSED, "index.json"), encoding="utf-8") as f:
        idx = json.load(f)
    for rid, entry in idx["races"].items():
        with open(os.path.join(PROCESSED, rid + ".json"), encoding="utf-8") as f:
            res = json.load(f)
        assert entry["display"] == json.loads(json.dumps(display.display_totals(res["series"]["display_daily"]))), rid
        assert entry["display"]["kalshi_volume"]["n_days"] >= 20, rid
    assert NEWS in idx["races"]["tx-senate-2026"]["display"]
