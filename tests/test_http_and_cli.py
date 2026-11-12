import pytest

from raceattn.config import load_race
from raceattn.connectors.base import Connector, Estimate
from raceattn.connectors.kalshi import KalshiConnector
from raceattn.http import FetchError, HttpClient
from raceattn.pipeline import CostGuardError, cost_guard, run


class Resp:
    def __init__(self, code, body=None):
        self.status_code = code
        self._body = body
        self.text = str(body)

    def json(self):
        return self._body


class FakeSession:
    def __init__(self, codes):
        self.codes = list(codes)
        self.headers = {}
        self.calls = 0

    def get(self, url, params=None, timeout=None, verify=None):
        self.calls += 1
        return Resp(self.codes.pop(0), {"ok": True})


def client(codes, retries=3):
    s = FakeSession(codes)
    return HttpClient(sleep=0, max_retries=retries, backoff=0, session=s), s


def test_user_agent_set():
    c, s = client([200])
    assert s.headers["User-Agent"].startswith("kalshi-midterm-analysis/")
    assert "contact" in s.headers["User-Agent"]


def test_retry_then_success():
    c, s = client([429, 503, 200])
    assert c.get_json("https://example.invalid") == (200, {"ok": True})
    assert s.calls == 3


def test_repeated_failure_stops_and_reports():
    c, s = client([500, 500, 500, 500])
    with pytest.raises(FetchError, match="failed after 4 attempts"):
        c.get_json("https://example.invalid")


def test_403_stops_immediately():
    c, s = client([403, 200])
    with pytest.raises(FetchError, match="403"):
        c.get_json("https://example.invalid")
    assert s.calls == 1


def test_404_allowed_when_asked():
    c, s = client([404])
    assert c.get_json("https://example.invalid", ok_status=(200, 404))[0] == 404


class PaidConnector(Connector):
    id = "paid"
    cost_model = "about $0.005 per request"

    def estimate_cost(self, race):
        return Estimate(usd=1.25, requests=250)


def test_cost_guard():
    race = load_race("tx-senate-2026")
    log = []
    cost_guard([KalshiConnector()], race, False, None, log.append)  # free: no prompt
    assert log == []
    with pytest.raises(CostGuardError, match="--yes or --max-spend"):
        cost_guard([PaidConnector()], race, False, None, log.append)
    with pytest.raises(CostGuardError, match="over --max-spend"):
        cost_guard([PaidConnector()], race, False, 1.00, log.append)
    cost_guard([PaidConnector()], race, False, 5.00, log.append)
    cost_guard([PaidConnector()], race, True, None, log.append)
    assert "cost estimate for paid" in log[0]


def test_unknown_source(tmp_path):
    from raceattn.pipeline import PipelineError

    with pytest.raises(PipelineError, match="unknown source 'nope'"):
        run(load_race("tx-senate-2026"), ["nope"], raw_dir=str(tmp_path), out_dir=str(tmp_path), log=lambda *_: None)


def test_fetch_trades_delegates_to_trades_connector():
    from raceattn.connectors.kalshi import KalshiTradesConnector

    assert hasattr(KalshiConnector, "fetch_trades") and KalshiTradesConnector.id == "kalshi_trades"


def test_cli_validate_and_errors(capsys):
    from raceattn.cli import main

    assert main(["validate", "--race", "tx-senate-2026"]) == 0
    assert "ok: tx-senate-2026" in capsys.readouterr().out
    assert main(["run", "--race", "nope-2026"]) == 2
    assert "no race config" in capsys.readouterr().err


def test_cli_run_offline_from_fixtures(tmp_path, capsys):
    from raceattn.cli import main
    from tests.conftest import FIXTURE_RAW

    rc = main(["run", "--race", "tx-senate-2026", "--sources", "kalshi,wikipedia", "--raw-dir", FIXTURE_RAW,
               "--out-dir", str(tmp_path)])
    assert rc == 0
    assert (tmp_path / "tx-senate-2026.json").exists() and (tmp_path / "index.json").exists()


def test_cli_has_cost_flags():
    from raceattn.cli import build_parser

    a = build_parser().parse_args(["run", "--race", "tx-senate-2026", "--yes", "--max-spend", "5.00", "--refresh"])
    assert a.yes and a.max_spend == 5.0 and a.refresh


def test_network_is_blocked_in_offline_tests():
    import requests

    with pytest.raises(Exception):
        requests.get("https://example.com", timeout=2)


def test_metrics_skip_unusable_series(tmp_path):
    """A Wikipedia page with no data is unusable and its metrics are skipped with a reason."""
    import datetime as dt

    race = load_race("tx-senate-2026")

    class FakeHttp:
        def get_json(self, url, params=None, ok_status=(200,)):
            if "kalshi" in url:
                out, t = [], params["start_ts"]
                while t < params["end_ts"]:
                    t += 3600
                    out.append({"end_period_ts": t, "price": {"close_dollars": "0.5"}, "volume_fp": str(t % 97)})
                return 200, {"candlesticks": out}
            if "Ken_Paxton" in url:
                return 404, {"type": "not found"}
            return 200, {"items": [{"timestamp": (dt.date(2026, 9, 1) + dt.timedelta(days=i)).strftime("%Y%m%d00"),
                                    "views": 100 + i % 9} for i in range(65)]}

    res = run(race, ["kalshi", "wikipedia"], raw_dir=str(tmp_path), out_dir=str(tmp_path), http=FakeHttp(),
              log=lambda *_: None)
    m = res["metrics"]["daily"]
    assert res["quality"]["wikipedia/pageviews/Ken_Paxton"]["status"] == "unusable"
    assert m["wikipedia/pageviews/Ken_Paxton"]["status"] == "skipped"
    assert "unusable" in m["wikipedia/pageviews/Ken_Paxton"]["reason"]
    # the total needs every page, so it is unusable too
    assert m["wikipedia/pageviews_total"]["status"] == "skipped"
    assert m["wikipedia/pageviews/James_Talarico"]["status"] == "computed"


def test_index_merges_other_races(tmp_path):
    import json

    from raceattn.pipeline import write_outputs

    (tmp_path / "index.json").write_text(json.dumps({"project": "kalshi-midterm-analysis", "races": {"zz-other": {"x": 1}}}))
    from tests.conftest import FIXTURE_RAW

    run(load_race("tx-senate-2026"), ["kalshi", "wikipedia"], raw_dir=FIXTURE_RAW, out_dir=str(tmp_path),
        log=lambda *_: None)
    idx = json.loads((tmp_path / "index.json").read_text())
    assert set(idx["races"]) == {"zz-other", "tx-senate-2026"}
