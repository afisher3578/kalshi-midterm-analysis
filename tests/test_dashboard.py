"""The local dashboard command (raceattn/dashboard.py): staleness check, missing Node, routing, the demo fixture."""
import http.client
import json
import os
import socket
import subprocess
import threading
import time

import pytest

from raceattn import cli, dashboard as d

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RACE = "tx-senate-2026"
# the real socket functions, saved before the autouse no_network fixture replaces them (the thread test needs
# a localhost connection; nothing here leaves 127.0.0.1)
REAL = {"connect": socket.socket.connect, "connect_ex": socket.socket.connect_ex,
        "create_connection": socket.create_connection, "getaddrinfo": socket.getaddrinfo}


def touch(path, t):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        open(path, "w").close()
    os.utime(path, (t, t))


def make_web(tmp_path, dist_t=None, src_t=100.0, nm_t=None, lock_t=50.0):
    web = tmp_path / "web"
    touch(str(web / "src" / "main.ts"), src_t)
    touch(str(web / "index.html"), 10.0)
    touch(str(web / "package.json"), 10.0)
    touch(str(web / "package-lock.json"), lock_t)
    touch(str(web / "vite.config.ts"), 10.0)
    if dist_t is not None:
        touch(str(web / "dist" / "index.html"), dist_t)
    if nm_t is not None:
        touch(str(web / "node_modules" / ".package-lock.json"), nm_t)
    return str(web)


def test_needs_build_missing_and_stale_and_fresh(tmp_path):
    assert d.needs_build(make_web(tmp_path / "a"))                      # no dist
    assert d.needs_build(make_web(tmp_path / "b", dist_t=50.0))         # src newer than dist
    assert not d.needs_build(make_web(tmp_path / "c", dist_t=200.0))    # dist newer than every input
    web = make_web(tmp_path / "d", dist_t=200.0)
    touch(os.path.join(web, "vite.config.ts"), 300.0)                   # any input counts
    assert d.needs_build(web)


def test_needs_install(tmp_path):
    assert d.needs_install(make_web(tmp_path / "a"))                    # no node_modules
    assert d.needs_install(make_web(tmp_path / "b", nm_t=10.0))         # lock newer than the install
    assert not d.needs_install(make_web(tmp_path / "c", nm_t=60.0))


def test_ensure_built_runs_ci_only_when_needed_and_reports_failure(tmp_path):
    calls = []
    web = make_web(tmp_path / "a", dist_t=50.0, nm_t=60.0)
    assert d.ensure_built(web, runner=lambda cmd, cwd: calls.append(cmd) or 0, log=lambda s: None) == 0
    assert calls == [["npm", "run", "build"]]
    calls.clear()
    web = make_web(tmp_path / "b", dist_t=50.0)
    assert d.ensure_built(web, runner=lambda cmd, cwd: calls.append(cmd) or 0, log=lambda s: None) == 0
    assert calls == [["npm", "ci"], ["npm", "run", "build"]]
    calls.clear()
    web = make_web(tmp_path / "c", dist_t=500.0)
    assert d.ensure_built(web, runner=lambda cmd, cwd: calls.append(cmd) or 0, log=lambda s: None) == 0
    assert calls == []
    logs = []
    web = make_web(tmp_path / "d", dist_t=50.0, nm_t=60.0)
    assert d.ensure_built(web, runner=lambda cmd, cwd: 3, log=logs.append) == 3
    assert any("failed with exit code 3" in s for s in logs)


def test_missing_node_or_npm_exits_2(capsys):
    code = d.run(RACE, open_browser=False, which=lambda t: None if t == "npm" else "/usr/bin/" + t,
                 runner=lambda cmd, cwd: pytest.fail("must not build"))
    assert code == 2
    err = capsys.readouterr().err
    assert d.NO_NODE in err and "npm" in err


def test_unknown_race_lists_valid_ids(capsys):
    assert d.run("zz-nothing-2026", open_browser=False, build=False) == 2
    err = capsys.readouterr().err
    assert "tx-senate-2026" in err and "Valid race ids" in err


def test_cli_wires_dashboard(monkeypatch):
    seen = {}
    monkeypatch.setattr(d, "run", lambda race, **kw: seen.update(race=race, **kw) or 0)
    assert cli.main(["dashboard", "--race", RACE, "--port", "5000", "--no-open", "--demo"]) == 0
    assert seen == {"race": RACE, "port": 5000, "open_browser": False, "demo": True, "build": True}


@pytest.fixture
def ctx(tmp_path):
    dist = tmp_path / "web" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html><head><title>t</title></head><body></body></html>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (dist / "data").mkdir()
    (dist / "data" / "index.json").write_text('{"stale": true}')
    (tmp_path / "secret.txt").write_text("secret")
    return d.Context(RACE, demo=False, web_dir=str(tmp_path / "web"), audit_dir=str(tmp_path / "audit"))


def test_routes(ctx):
    s, t, b = d.route("/", ctx)
    assert s == 200 and b'<meta name="raceattn-local-server" content="live">' in b
    assert d.route("/assets/app.js", ctx)[0] == 200
    s, t, b = d.route("/data/index.json?x=1", ctx)
    assert s == 200 and b"stale" not in b and json.loads(b)["races"][RACE]   # live from data/processed, not dist
    assert d.route("/data/%s.json" % RACE, ctx)[0] == 200
    q = json.loads(d.route("/local/mediacloud/%s/query-config.json" % RACE, ctx)[2])
    assert q["news_mediacloud"]["mediacloud"]["collections"]["texas_local"]["status"] == "configured"
    assert len(q["news_mediacloud"]["mediacloud"]["queries"]) == 8
    a = json.loads(d.route("/local/mediacloud/%s/audit.json" % RACE, ctx)[2])
    assert a["available"] is False and a["phases"] == {}
    assert d.route("/local/demo/%s.mediacloud.json" % RACE, ctx)[0] == 404      # no --demo, no demo route
    assert d.route("/local/mediacloud/zz-none/audit.json", ctx)[0] == 404


@pytest.mark.parametrize("path", [
    "/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt",
    "/data/../README.md", "/data/..%2fREADME.md", "/data/index.json/..", "/.env", "/assets/.hidden", "/data/data.yaml",
    "/data/sub/index.json", "/local/mediacloud/../../.env", "/local/demo/../x.json", "/local/../data/local/x",
    "/local/mediacloud/%s/audit.csv" % RACE, "/data/index.json%00", "/assets\\app.js", "/data/../../.git/config",
    "/web/dist/index.html", "/data", "/local/",
])
def test_traversal_and_unlisted_paths_are_404(ctx, path):
    assert d.route(path, ctx)[0] == 404


def test_audit_route_reads_local_csv(tmp_path):
    from raceattn import mediacloud as mc

    audit = tmp_path / "audit"
    p = mc.audit_path(RACE, "analysis", str(audit))
    os.makedirs(os.path.dirname(p))
    with open(p, "w", encoding="utf-8") as f:
        f.write(",".join(mc.AUDIT_COLUMNS) + "\n")
        f.write("talarico_race,national,1,2026-10-01T10:00:00,Outlet,Title one,https://example.invalid/1,yes,,,\n")
    c = d.Context(RACE, web_dir=str(tmp_path / "web"), audit_dir=str(audit))
    a = json.loads(d.route("/local/mediacloud/%s/audit.json" % RACE, c)[2])
    assert a["available"] and a["phases"]["analysis"]["rows"][0]["title"] == "Title one"
    assert a["_note"] == "local only, not published"


def test_local_routes_only_in_this_server():
    """The Vite config serves and copies data/processed only; nothing under /local/ or data/local reaches the build."""
    vite = open(os.path.join(ROOT, "web", "vite.config.ts"), encoding="utf-8").read()
    assert "data/local" not in vite and "/local" not in vite.replace("data/local", "")
    assert '"../data/processed"' in vite


def demo():
    with open(os.path.join(d.PROCESSED, RACE + ".json"), encoding="utf-8") as f:
        race = json.load(f)
    return d.demo_fixture(RACE, race, d.query_config(RACE))


def test_demo_fixture_is_labeled_deterministic_and_has_no_processed_path():
    a, b = demo(), demo()
    assert a == b
    assert a["_synthetic"] is True and a["_note"] == "DEMO DATA, not real"
    text = json.dumps(a)
    assert "data/processed" not in text and "data" + os.sep + "processed" not in text
    assert ROOT not in text
    cols = a["series"]["daily"]["columns"]
    for c in ("national", "texas_local"):
        for q in ("race_either", "talarico_race", "paxton_race", "any_either"):
            assert "news_mediacloud/%s/%s" % (q, c) in cols
        for q in ("talarico_race", "paxton_race", "race_either"):
            assert "news_mediacloud/%s/%s/breadth" % (q, c) in cols
            top = a["queries"]["news_mediacloud"]["mediacloud"]["top_sources"][q][c]
            assert top["query"] == q and top["collection"] == c and top["sources"]
            assert all(set(x) == {"source", "count"} for x in top["sources"])
            assert [x["count"] for x in top["sources"]] == sorted((x["count"] for x in top["sources"]), reverse=True)
        assert not any(x.endswith("/distinct_sources") for x in cols)
    rows = a["local"]["audit"]["phases"]["analysis"]["rows"]
    assert rows and all(r["url"].startswith("https://example.invalid/") and "DEMO" in r["title"] for r in rows)
    i = cols.index("news_mediacloud/race_either/national")
    vals = [r[i] for r in a["series"]["daily"]["rows"]]
    assert 0 in vals and None in vals                       # an explicit zero day and a missing day


def test_demo_fixture_derived_match_the_connector_math():
    from raceattn.connectors.news import derive

    a = demo()
    cols = a["series"]["daily"]["columns"]
    ix = {c: k for k, c in enumerate(cols)}
    for r in a["series"]["daily"]["rows"]:
        for c in ("national", "texas_local"):
            vals = {k: r[ix["news_mediacloud/%s/%s" % (q, c)]] for k, q in
                    (("numerator", "talarico_race"), ("other", "paxton_race"), ("both", "race_both"))}
            v, _ = derive("share", {"numerator": "t", "other": "p"}, {"numerator": vals["numerator"],
                                                                     "other": vals["other"]})
            got = r[ix["news_mediacloud/talarico_share/%s" % c]]
            assert (got is None and v is None) or got == pytest.approx(v, abs=1e-6)


def git_status(paths):
    return subprocess.run(["git", "status", "--porcelain", "--", *paths], cwd=ROOT, capture_output=True,
                          text=True, check=True).stdout


def test_demo_server_start_in_a_thread_writes_nothing(monkeypatch):
    for k in ("connect", "connect_ex"):
        monkeypatch.setattr(socket.socket, k, REAL[k])
    monkeypatch.setattr(socket, "create_connection", REAL["create_connection"])
    monkeypatch.setattr(socket, "getaddrinfo", REAL["getaddrinfo"])
    watched = ["data/processed", "web", "data/local/demo"]
    before = git_status(watched)
    listing = {p: sorted(os.listdir(os.path.join(ROOT, p))) for p in ("data/processed",)}
    dist_before = sorted(os.listdir(os.path.join(ROOT, "web", "dist"))) if os.path.isdir(
        os.path.join(ROOT, "web", "dist")) else None
    got = {}

    def ready(srv, url):
        try:
            port = srv.server_address[1]
            got["url"] = url
            for path in ("/local/demo/%s.mediacloud.json" % RACE, "/data/index.json", "/../README.md",
                         "/local/mediacloud/%s/query-config.json" % RACE, "/"):
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                c.request("GET", path)
                r = c.getresponse()
                got[path] = (r.status, r.read())
                c.close()
        finally:
            srv.shutdown()

    t = threading.Thread(target=lambda: got.update(code=d.run(RACE, port=0, open_browser=False, demo=True,
                                                              build=False, ready=ready, quiet=True)))
    t.start()
    t.join(30)
    assert not t.is_alive() and got["code"] == 0
    assert got["url"].endswith("?race=%s&view=news&demo=1" % RACE)
    status, body = got["/local/demo/%s.mediacloud.json" % RACE]
    assert status == 200 and json.loads(body)["_note"] == "DEMO DATA, not real"
    assert got["/data/index.json"][0] == 200
    assert got["/../README.md"][0] == 404
    assert got["/"][0] == (200 if dist_before is not None else 404)
    if dist_before is not None:
        assert b'content="demo"' in got["/"][1]
    assert git_status(watched) == before
    assert {p: sorted(os.listdir(os.path.join(ROOT, p))) for p in ("data/processed",)} == listing
    if dist_before is not None:
        assert sorted(os.listdir(os.path.join(ROOT, "web", "dist"))) == dist_before
    assert not os.path.exists(os.path.join(ROOT, "data", "local", "demo"))


def test_port_in_use_exits_2(capsys):
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    port = blocker.getsockname()[1]
    try:
        assert d.run(RACE, port=port, open_browser=False, build=False) == 2
    finally:
        blocker.close()
    assert "already in use" in capsys.readouterr().err
