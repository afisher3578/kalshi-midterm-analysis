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
