"""Local dashboard: `python -m raceattn dashboard --race <id> [--port 4173] [--no-open] [--demo] [--no-build]`.

Builds web/ when web/dist is missing or older than its inputs, then serves on 127.0.0.1 only (stdlib http.server):
- `/` and the files of web/dist (index.html gets a meta tag saying the local server is running, so the page knows
  it may ask for /local/; the static build has no such tag and never requests /local/);
- `/data/<name>.json`: read live from data/processed on every request (a fresh pipeline run shows without a rebuild;
  this overrides the copies in web/dist/data);
- `/local/mediacloud/<race>/query-config.json`: the parsed Media Cloud query config, in the same shape as the race
  JSON block `queries.news_mediacloud` (the pipeline writes that block only when Media Cloud ran);
- `/local/mediacloud/<race>/audit.json`: the git-ignored audit CSVs under data/local/mediacloud/audit/<race>/
  (titles and URLs: local only, never published);
- `/local/demo/<race>.mediacloud.json` (only with --demo): a synthetic Media Cloud fixture made in memory with
  random.Random(1), marked `_synthetic: true` and `_note: "DEMO DATA, not real"`. Nothing is written to disk.
Every other path is 404. Names are matched against fixed patterns, so `..` and encoded separators never resolve.
"""
from __future__ import annotations

import datetime as dt
import errno
import json
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
PROCESSED = os.path.join(ROOT, "data", "processed")
AUDIT_DIR = os.path.join(ROOT, "data", "local", "mediacloud", "audit")
BUILD_INPUTS = ("src", "index.html", "package.json", "package-lock.json", "vite.config.ts")
NO_NODE = ("Node.js and npm are needed to build the dashboard: install Node 20+ from nodejs.org, then run this "
           "again")
DEMO_NOTE = "DEMO DATA, not real"
META_TAG = '<meta name="raceattn-local-server" content="%s">'

NAME = r"[A-Za-z0-9_-][A-Za-z0-9._-]*"          # one path segment; never starts with a dot
RACE = r"[a-z0-9][a-z0-9-]*"
DATA_RE = re.compile(r"^/data/([a-z0-9][a-z0-9-]*\.json)$")
DIST_RE = re.compile(r"^/((?:assets/)?%s)$" % NAME)
MC_RE = re.compile(r"^/local/mediacloud/(%s)/(query-config|audit)\.json$" % RACE)
DEMO_RE = re.compile(r"^/local/demo/(%s)\.mediacloud\.json$" % RACE)
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
         ".txt": "text/plain; charset=utf-8", ".map": "application/json", ".woff2": "font/woff2"}


# -------------------------------------------------------------------------------------------------- build

def newest_mtime(paths: list[str]) -> float:
    """Newest modification time of the files under `paths` (files or directories); 0 if none exist."""
    newest = 0.0
    for p in paths:
        if os.path.isfile(p):
            newest = max(newest, os.path.getmtime(p))
        elif os.path.isdir(p):
            for d, _, files in os.walk(p):
                for f in files:
                    newest = max(newest, os.path.getmtime(os.path.join(d, f)))
    return newest


def needs_build(web_dir: str = WEB) -> bool:
    """True when web/dist/index.html is missing or older than the newest build input."""
    built = os.path.join(web_dir, "dist", "index.html")
    if not os.path.isfile(built):
        return True
    return os.path.getmtime(built) < newest_mtime([os.path.join(web_dir, p) for p in BUILD_INPUTS])


def needs_install(web_dir: str = WEB) -> bool:
    """True when web/node_modules is missing or older than package-lock.json (npm writes
    node_modules/.package-lock.json on every install, so that file dates the install)."""
    nm = os.path.join(web_dir, "node_modules")
    lock = os.path.join(web_dir, "package-lock.json")
    if not os.path.isdir(nm):
        return True
    stamp = os.path.join(nm, ".package-lock.json")
    t = os.path.getmtime(stamp if os.path.isfile(stamp) else nm)
    return os.path.isfile(lock) and t < os.path.getmtime(lock)


def missing_tools(which: Callable[[str], str | None] = shutil.which) -> list[str]:
    return [t for t in ("node", "npm") if not which(t)]


def _run(cmd: list[str], cwd: str) -> int:
    """Runs a command with its output going straight to this terminal, so a failed build is visible."""
    return subprocess.run(cmd, cwd=cwd).returncode


def ensure_built(web_dir: str = WEB, runner: Callable[[list[str], str], int] = _run,
                 log: Callable[[str], None] = print) -> int:
    """npm ci (only when node_modules is missing or stale) and npm run build (only when dist is stale).
    Returns 0, or the failing command's exit code."""
    if not needs_build(web_dir):
        log("web/dist is up to date; no build needed")
        return 0
    steps = ([["npm", "ci"]] if needs_install(web_dir) else []) + [["npm", "run", "build"]]
    for cmd in steps:
        log("running: %s (in %s)" % (" ".join(cmd), os.path.relpath(web_dir, ROOT) if web_dir.startswith(ROOT) else web_dir))
        code = runner(cmd, web_dir)
        if code != 0:
            log("error: `%s` failed with exit code %d (its output is above)" % (" ".join(cmd), code))
            return code or 1
    return 0


# -------------------------------------------------------------------------------------------------- data

def race_ids(processed: str = PROCESSED) -> list[str]:
    path = os.path.join(processed, "index.json")
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as f:
        return sorted((json.load(f).get("races") or {}).keys())


def query_config(race_id: str) -> dict[str, Any] | None:
    """The Media Cloud query block exactly as the pipeline would write it into queries.news_mediacloud, built from
    config/queries/<race>.mediacloud.yaml with no request made. None when the race has no query file."""
    from raceattn import mcqueries
    from raceattn.config import load_race
    from raceattn.connectors.news import MediaCloudConnector

    if mcqueries.find(race_id) is None:
        return None
    race = load_race(race_id)
    summary = MediaCloudConnector(env={}).query_summary(race, race.window)
    return {"_source": "parsed from %s by the dashboard server; no Media Cloud request was made"
            % summary["mediacloud"]["path"], "news_mediacloud": summary}


AUDIT_FIELDS = ("query", "collection", "story_id", "publish_date", "source", "title", "url", "relevant")


def audit_rows(race_id: str, audit_dir: str = AUDIT_DIR) -> dict[str, Any]:
    """Rows of the audit CSVs (tuning and analysis) for the news view: precision and sample headlines."""
    from raceattn import mediacloud as mc

    out: dict[str, Any] = {"_note": "local only, not published", "race_id": race_id, "phases": {}}
    for phase in ("analysis", "tuning"):
        path = mc.audit_path(race_id, phase, audit_dir)
        if not os.path.isfile(path):
            continue
        try:
            rows = mc.read_audit(path)
        except ValueError as e:
            out["phases"][phase] = {"path": os.path.relpath(path, ROOT), "error": str(e), "rows": []}
            continue
        out["phases"][phase] = {"path": os.path.relpath(path, ROOT),
                                "rows": [{k: r.get(k, "") for k in AUDIT_FIELDS} for r in rows]}
    out["available"] = bool(out["phases"])
    return out


# -------------------------------------------------------------------------------------------------- demo

PER_SOURCE_DEMO = ("talarico_race", "paxton_race", "race_either")


def demo_fixture(race_id: str, race: dict[str, Any], qconf: dict[str, Any] | None, seed: int = 1) -> dict[str, Any]:
    """A synthetic Media Cloud block for one race, in the shape the pipeline writes (series.daily columns
    news_mediacloud/<query>/<collection>[/ratio|/total_count|/breadth], derived series, queries.news_mediacloud
    with top_sources.<query>.<collection>), and a coded audit sample with synthetic headlines on example.invalid. Deterministic: random.Random(seed), no clock. Every name says it is demo data."""
    rng = random.Random(seed)
    w = race["window"]
    d0, d1 = dt.date.fromisoformat(w["start"]), dt.date.fromisoformat(w["end"])
    days = [d0 + dt.timedelta(n) for n in range((d1 - d0).days + 1)]
    election = dt.date.fromisoformat(race["race"]["election_date"])
    mc_block = json.loads(json.dumps((qconf or {}).get("news_mediacloud", {}).get("mediacloud") or {}))
    queries = list((mc_block.get("queries") or {}).keys()) or [
        "talarico_race", "paxton_race", "race_either", "race_both", "talarico_any", "paxton_any", "headline_either",
        "any_either"]
    colls = {"national": {"name": "United States - National (DEMO: synthetic counts)", "id": None, "scale": 1.0,
                          "total": 30000, "zero": d0 + dt.timedelta(5), "missing": d0 + dt.timedelta(19)},
             "texas_local": {"name": "Texas state and local (DEMO: no real collection)", "id": None, "scale": 1.7,
                             "total": 9000, "zero": d0 + dt.timedelta(6), "missing": d0 + dt.timedelta(12)}}
    spikes = {d: rng.uniform(2.0, 3.2) for d in rng.sample(days[10:-8], 4)}
    spikes[election - dt.timedelta(1)] = 2.2
    spikes[election] = 6.0
    spikes[election + dt.timedelta(1)] = 4.0
    cols: dict[str, list[Any]] = {}
    for ck, c in colls.items():
        for q in queries:
            for kind in ("", "/ratio", "/total_count"):
                cols["news_mediacloud/%s/%s%s" % (q, ck, kind)] = []
        for dname in ("talarico_share", "talarico_exclusive_share", "core_vs_broad"):
            cols["news_mediacloud/%s/%s" % (dname, ck)] = []
        for q in PER_SOURCE_DEMO:
            cols["news_mediacloud/%s/%s/breadth" % (q, ck)] = []
        for i, d in enumerate(days):
            if d == c["missing"]:
                for name in cols:
                    if name.split("/")[2] == ck:
                        cols[name].append(None)
                continue
            trend = 1 + 1.6 * (i / len(days)) ** 2
            week = 0.65 if d.weekday() >= 5 else 1.0
            f = c["scale"] * trend * week * spikes.get(d, 1.0)
            t = max(0, round(16 * f * rng.uniform(0.75, 1.3)))
            p = max(0, round(21 * f * rng.uniform(0.75, 1.3)))
            if d == c["zero"]:
                t = p = 0
            both = min(t, p, round(min(t, p) * rng.uniform(0.25, 0.45)))
            t_any, p_any = t + round(t * rng.uniform(0.2, 0.4)), p + round(p * rng.uniform(1.2, 1.9))
            both_any = min(t_any, p_any, both + round(both * rng.uniform(0.1, 0.3)))
            vals = {"talarico_race": t, "paxton_race": p, "race_either": t + p - both, "race_both": both,
                    "talarico_any": t_any, "paxton_any": p_any, "any_either": t_any + p_any - both_any,
                    "headline_either": round((t + p - both) * rng.uniform(0.2, 0.35))}
            if d == c["zero"]:
                vals["headline_either"] = 0
            total = round(c["total"] * week * rng.uniform(0.9, 1.1))
            for q in queries:
                v = vals.get(q, 0)
                cols["news_mediacloud/%s/%s" % (q, ck)].append(v)
                cols["news_mediacloud/%s/%s/ratio" % (q, ck)].append(round(v / total, 8))
                cols["news_mediacloud/%s/%s/total_count" % (q, ck)].append(total)
            a, b = vals["talarico_race"], vals["paxton_race"]
            oa, ob = a - both, b - both
            cols["news_mediacloud/talarico_share/%s" % ck].append(round(a / (a + b), 6) if a + b else None)
            cols["news_mediacloud/talarico_exclusive_share/%s" % ck].append(round(oa / (oa + ob), 6) if oa + ob else None)
            cols["news_mediacloud/core_vs_broad/%s" % ck].append(
                round(vals["race_either"] / vals["any_either"], 6) if vals["any_either"] else None)
            for q in PER_SOURCE_DEMO:
                cols["news_mediacloud/%s/%s/breadth" % (q, ck)].append(
                    min(vals[q], round(vals[q] * rng.uniform(0.45, 0.7))))
    columns = ["date"] + list(cols)
    rows = [[d.isoformat()] + [cols[c][i] for c in cols] for i, d in enumerate(days)]

    a0, a1 = (mc_block.get("phases") or {}).get("analysis") or ["2026-09-01", "2026-11-02"]
    top_sources: dict[str, dict[str, Any]] = {}
    for q in PER_SOURCE_DEMO:
        for ck in colls:
            counts = cols["news_mediacloud/%s/%s" % (q, ck)]
            total = sum(v for d, v in zip(days, counts) if v is not None and a0 <= d.isoformat() <= a1)
            share, left, out = 0.12, total, []
            for k in range(20):
                n = min(left, round(total * share * rng.uniform(0.85, 1.0)))
                out.append({"source": "demo-outlet-%s-%02d.example.invalid" % (ck.replace("_", "-"), k + 1), "count": n})
                left -= n
                share *= 0.85
            out.sort(key=lambda r: (-r["count"], r["source"]))
            top_sources.setdefault(q, {})[ck] = {"query": q, "collection": ck, "start": a0, "end": a1, "sources": out,
                                                 "note": "synthetic outlet names on example.invalid"}

    audit = []
    for q in ("talarico_race", "paxton_race"):
        for ck in colls:
            counts = cols["news_mediacloud/%s/%s" % (q, ck)]
            pool = [(d, v) for d, v in zip(days, counts) if v and a0 <= d.isoformat() <= a1]
            picks = rng.choices([d for d, _ in pool], weights=[v for _, v in pool], k=40)
            for k, d in enumerate(sorted(picks)):
                r = rng.random()
                audit.append({"query": q, "collection": ck, "story_id": "demo-%s-%s-%02d" % (q, ck, k + 1),
                              "publish_date": d.isoformat() + "T12:00:00", "source":
                              "demo-outlet-%s-%02d.example.invalid" % (ck.replace("_", "-"), rng.randint(1, 10)),
                              "title": "DEMO headline %d (synthetic, not a real story): %s, %s" % (
                                  k + 1, q.replace("_", " "), ck.replace("_", " ")),
                              "url": "https://example.invalid/demo/%s/%s/%02d" % (q, ck, k + 1),
                              "relevant": "yes" if r < 0.86 else "no" if r < 0.95 else "unclear"})

    names = [c for c in columns if c != "date"]
    mc_block.update({"status": "demo", "collections": {ck: {"name": c["name"], "id": None, "source_count": None,
                                                              "looked_up_on": None, "status": "demo, synthetic"}
                                                         for ck, c in colls.items()},
                     "top_sources": top_sources, "derived_nulls": {}})
    return {"_synthetic": True, "_note": DEMO_NOTE, "_generator": "raceattn.dashboard.demo_fixture, random.Random(%d)"
            % seed, "race_id": race_id, "generated_at": "demo fixture, made in memory at server start",
            "window": w, "series": {"daily": {"columns": columns, "rows": rows,
                                              "note": "DEMO DATA, not real: synthetic daily counts"},
                                    "meta": {n: {"source": "news_mediacloud", "connector": "news_mediacloud",
                                                 "granularity": "day", "unit": "stories", "query_hash": "demo",
                                                 "fetched_at": "demo"} for n in names}},
            "queries": {"news_mediacloud": {"query_hash": "demo", "queries": [], "series_query_hash": {},
                                            "mediacloud": mc_block}},
            "local": {"audit": {"_note": "local only, not published; DEMO DATA, not real", "race_id": race_id,
                                "available": True, "phases": {"analysis": {"path": "demo (in memory)",
                                                                           "rows": audit}}}}}


# -------------------------------------------------------------------------------------------------- server

class Context:
    """What the handler serves. Paths are injectable for tests."""

    def __init__(self, race_id: str, demo: bool = False, web_dir: str = WEB, processed: str = PROCESSED,
                 audit_dir: str = AUDIT_DIR):
        self.race_id = race_id
        self.demo = demo
        self.dist = os.path.join(web_dir, "dist")
        self.processed = processed
        self.audit_dir = audit_dir
        self._qconf: dict[str, Any] = {}
        self.demo_body: bytes | None = None
        if demo:
            with open(os.path.join(processed, race_id + ".json"), encoding="utf-8") as f:
                race = json.load(f)
            self.demo_body = json.dumps(demo_fixture(race_id, race, self.qconf(race_id))).encode("utf-8")

    def races(self) -> list[str]:
        return race_ids(self.processed)

    def qconf(self, race_id: str) -> dict[str, Any] | None:
        if race_id not in self._qconf:
            self._qconf[race_id] = query_config(race_id)
        return self._qconf[race_id]


def _file(path: str, root: str) -> bytes | None:
    """The file's bytes if it is a regular file inside root (after resolving links), else None."""
    real, base = os.path.realpath(path), os.path.realpath(root)
    if os.path.commonpath([real, base]) != base or not os.path.isfile(real):
        return None
    with open(real, "rb") as f:
        return f.read()


def _json(obj: Any) -> tuple[int, str, bytes]:
    return 200, TYPES[".json"], json.dumps(obj).encode("utf-8")


NOT_FOUND = (404, "text/plain; charset=utf-8", b"not found\n")


def route(raw_path: str, ctx: Context) -> tuple[int, str, bytes]:
    """(status, content type, body) for a request path. Only whitelisted name patterns resolve."""
    path = urllib.parse.urlsplit(raw_path).path
    if "%" in path or "\\" in path or "\x00" in path:
        return NOT_FOUND  # no encoded separators or dots, ever
    if path in ("/", "/index.html"):
        body = _file(os.path.join(ctx.dist, "index.html"), ctx.dist)
        if body is None:
            return 404, "text/plain; charset=utf-8", b"web/dist/index.html is missing: run npm run build in web/\n"
        tag = (META_TAG % ("demo" if ctx.demo else "live")).encode("utf-8")
        return 200, TYPES[".html"], body.replace(b"</head>", tag + b"\n  </head>", 1)
    m = DATA_RE.match(path)
    if m:
        body = _file(os.path.join(ctx.processed, m.group(1)), ctx.processed)
        return (200, TYPES[".json"], body) if body is not None else NOT_FOUND
    m = MC_RE.match(path)
    if m:
        rid, what = m.groups()
        if rid not in ctx.races():
            return NOT_FOUND
        if what == "audit":
            return _json(audit_rows(rid, ctx.audit_dir))
        q = ctx.qconf(rid)
        return _json(q) if q is not None else _json({"_source": "no Media Cloud query file for this race",
                                                     "news_mediacloud": None})
    m = DEMO_RE.match(path)
    if m:
        if not ctx.demo or m.group(1) != ctx.race_id or ctx.demo_body is None:
            return NOT_FOUND
        return 200, TYPES[".json"], ctx.demo_body
    m = DIST_RE.match(path)
    if m and not m.group(1).startswith("data/"):
        body = _file(os.path.join(ctx.dist, m.group(1)), ctx.dist)
        if body is not None:
            return 200, TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream"), body
    return NOT_FOUND


def make_handler(ctx: Context):
    class Handler(BaseHTTPRequestHandler):
        server_version = "raceattn-dashboard"
        sys_version = ""

        def _send(self, head_only: bool):
            status, ctype, body = route(self.path, ctx)
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def do_GET(self):
            self._send(False)

        def do_HEAD(self):
            self._send(True)

        def log_message(self, fmt, *args):
            if getattr(self.server, "quiet", False):
                return
            sys.stderr.write("  %s\n" % (fmt % args))

    return Handler


class PortInUse(OSError):
    pass


def make_server(ctx: Context, port: int, quiet: bool = False) -> ThreadingHTTPServer:
    class Server(ThreadingHTTPServer):
        # SO_REUSEADDR only lets a restart bind over connections in TIME_WAIT; binding a port that another
        # server is listening on still fails (checked on macOS and Linux), and that is reported, never worked around
        allow_reuse_address = True
        daemon_threads = True

    try:
        srv = Server(("127.0.0.1", port), make_handler(ctx))
    except OSError as e:
        if e.errno in (errno.EADDRINUSE, errno.EACCES):
            raise PortInUse(e.errno, "port %d on 127.0.0.1 is already in use or not allowed" % port)
        raise
    srv.quiet = quiet
    return srv


def page_url(port: int, race_id: str, demo: bool) -> str:
    return "http://127.0.0.1:%d/?race=%s&view=news%s" % (port, race_id, "&demo=1" if demo else "")


def run(race_id: str, port: int = 4173, open_browser: bool = True, demo: bool = False, build: bool = True,
        which: Callable[[str], str | None] = shutil.which, runner: Callable[[list[str], str], int] = _run,
        ready: Callable[[ThreadingHTTPServer, str], None] | None = None, quiet: bool = False,
        web_dir: str = WEB, processed: str = PROCESSED) -> int:
    """The dashboard command. `ready(server, url)` is called once the server listens (tests use it to stop it)."""
    ids = race_ids(processed)
    if race_id not in ids:
        print("error: race %r is not in data/processed/index.json. Valid race ids: %s"
              % (race_id, ", ".join(ids) or "none (run the pipeline first)"), file=sys.stderr)
        return 2
    if build:
        missing = missing_tools(which)
        if missing:
            print("error: %s (not found on PATH: %s)" % (NO_NODE, ", ".join(missing)), file=sys.stderr)
            return 2
        code = ensure_built(web_dir, runner)
        if code:
            return code
    try:
        srv = make_server(Context(race_id, demo=demo, web_dir=web_dir, processed=processed), port, quiet=quiet)
    except PortInUse:
        print("error: port %d on 127.0.0.1 is already in use (another dashboard or `npm run preview`?). Stop it or "
              "pick another port with --port." % port, file=sys.stderr)
        return 2
    url = page_url(srv.server_address[1], race_id, demo)
    print("Dashboard: %s" % url, flush=True)
    if demo:
        print("Demo mode: synthetic Media Cloud data (DEMO DATA, not real) is served from memory at "
              "/local/demo/%s.mediacloud.json; nothing is written to disk." % race_id, flush=True)
    print("Serving web/dist, data/processed (live) and /local/ on 127.0.0.1 only. Press Ctrl+C to stop.", flush=True)
    if ready:
        threading.Thread(target=ready, args=(srv, url), daemon=True).start()
    if open_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        srv.server_close()
    return 0
