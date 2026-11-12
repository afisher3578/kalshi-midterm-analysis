import os
import socket

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURE_RAW = os.path.join(HERE, "fixtures", "raw")
TEST_CONFIGS = os.path.join(HERE, "configs")


def pytest_addoption(parser):
    parser.addoption("--live", action="store_true", default=False, help="run tests that hit the real APIs")


def pytest_configure(config):
    config.addinivalue_line("markers", "live: hits the real Kalshi and Wikimedia APIs (needs --live)")


def pytest_collection_modifyitems(config, items):
    if config.getoption("--live"):
        return
    skip = pytest.mark.skip(reason="live test: pass --live to run")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip)


class NetworkBlocked(RuntimeError):
    pass


@pytest.fixture(autouse=True)
def no_network(request, monkeypatch):
    """Every non-live test runs with outbound connections disabled."""
    if "live" in request.keywords:
        return

    def blocked(*a, **kw):
        raise NetworkBlocked("network access attempted in an offline test")

    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)
    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)


@pytest.fixture
def fast_http():
    from raceattn.http import HttpClient

    return HttpClient(sleep=0, max_retries=0, backoff=0)


@pytest.fixture(autouse=True)
def no_pacing_sleep(request, monkeypatch):
    """Media Cloud pacing (30 s by default) never really sleeps in offline tests; the waits are recorded."""
    if "live" in request.keywords:
        return []
    import raceattn.mediacloud as mc

    waits = []
    monkeypatch.setattr(mc, "_sleep", waits.append)
    return waits


@pytest.fixture(autouse=True)
def no_repo_dotenv(monkeypatch, tmp_path_factory):
    """Tests never read the real <repo>/.env (it may hold Alex's keys); a test that needs one writes its own."""
    import raceattn.envfile as envfile

    monkeypatch.setattr(envfile, "ENV_PATH", str(tmp_path_factory.mktemp("noenv") / ".env"))
