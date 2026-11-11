"""A second, made-up race: every rendered query changes from config alone, no code edits."""
import datetime as dt
import os

from raceattn.config import load_race
from raceattn.connectors.kalshi import KalshiConnector
from raceattn.connectors.wikipedia import WikipediaConnector
from raceattn.pipeline import run
from tests.conftest import TEST_CONFIGS

DUMMY = os.path.join(TEST_CONFIGS, "oh-dummy-2030.yaml")


def ts(y, m, d):
    return int(dt.datetime(y, m, d, tzinfo=dt.timezone.utc).timestamp())


def test_kalshi_queries_follow_config():
    tx, oh = load_race("tx-senate-2026"), load_race(DUMMY)
    k = KalshiConnector()
    qtx, qoh = k.render_queries(tx, tx.window), k.render_queries(oh, oh.window)
    assert {q.endpoint for q in qoh} == {
        "https://external-api.kalshi.com/trade-api/v2/series/KXGOVOHDUMMY/markets/KXGOVOHDUMMY-30-R/candlesticks"}
    assert qoh[0].params == {"start_ts": ts(2030, 8, 10), "end_ts": ts(2030, 8, 30), "period_interval": 60}
    assert qoh[-1].params["end_ts"] == ts(2030, 10, 1)  # inclusive end date -> next day 00:00
    assert len(qoh) == 3  # 52 days in chunks of <= 20
    for q in qoh:
        assert q.params["end_ts"] - q.params["start_ts"] <= 20 * 86400
    assert not {q.query_hash for q in qtx} & {q.query_hash for q in qoh}
    assert all("SENATETX" not in q.endpoint for q in qoh)


def test_wikipedia_queries_follow_config():
    oh = load_race(DUMMY)
    w = WikipediaConnector()
    urls = [q.endpoint for q in w.render_queries(oh, oh.window)]
    base = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/"
    assert urls == [base + "2030_Ohio_gubernatorial_election/daily/20300810/20300930",
                    base + "Jane_Example_%28politician%29/daily/20300810/20300930"]
    hashes = w.series_query_hashes(oh, oh.window)
    assert set(hashes) == {"wikipedia/pageviews/2030_Ohio_gubernatorial_election",
                           "wikipedia/pageviews/Jane_Example_(politician)", "wikipedia/pageviews_total"}


def test_pipeline_window_and_exclusions_follow_config(tmp_path):
    """Run the whole pipeline for the dummy race against a fake HTTP layer."""
    oh = load_race(DUMMY)
    seen = []

    class FakeHttp:
        def get_json(self, url, params=None, ok_status=(200,)):
            seen.append((url, dict(params or {})))
            if "kalshi" in url:
                out, t = [], params["start_ts"]
                while t < params["end_ts"]:
                    t += 3600
                    out.append({"end_period_ts": t, "price": {"close_dollars": "0.4000"}, "volume_fp": "10.00"})
                return 200, {"candlesticks": out}
            start = dt.date(2030, 8, 10)
            return 200, {"items": [{"timestamp": (start + dt.timedelta(days=i)).strftime("%Y%m%d00"),
                                    "views": 100 + (i * 37) % 50} for i in range(52)]}

    res = run(oh, ["kalshi", "wikipedia"], raw_dir=str(tmp_path / "raw"), out_dir=str(tmp_path / "out"),
              http=FakeHttp(), log=lambda *_: None)
    assert res["window"]["start"] == "2030-08-10" and res["window"]["end"] == "2030-09-30"
    assert res["excluded_days"] == ["2030-09-30", "2030-10-01"]
    rows = res["series"]["daily"]["rows"]
    assert len(rows) == 52 and rows[-1][0] == "2030-09-30" and rows[-1][1] is True
    assert sum(1 for r in rows if r[1]) == 1  # 2030-10-01 is adjacent, not in the window
    assert any("KXGOVOHDUMMY-30-R" in u for u, _ in seen)
    assert all("SENATETX" not in u and "Texas" not in u for u, _ in seen)
    # cache dir is keyed by source, race, window and query hash
    assert os.path.isdir(tmp_path / "raw" / "kalshi" / "oh-dummy-2030" / "20300810_20300930")
    assert res["metrics"]["daily"]["wikipedia/pageviews_total"]["status"] == "computed"


def test_no_hard_coded_race_values_in_connectors():
    import raceattn.connectors as pkg

    d = os.path.dirname(pkg.__file__)
    for fn in os.listdir(d):
        if fn.endswith(".py"):
            text = open(os.path.join(d, fn)).read()
            for bad in ("SENATETX", "Talarico", "Paxton", "Texas", "2026"):
                assert bad not in text, (fn, bad)
