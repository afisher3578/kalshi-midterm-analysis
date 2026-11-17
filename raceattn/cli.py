"""Command line: python -m raceattn run --race tx-senate-2026 [--sources kalshi,wikipedia,...]"""
from __future__ import annotations

import argparse
import csv
import os
import sys

from raceattn import PROJECT_NAME, __version__
from raceattn.config import ConfigError, confirmed_races, load_race
from raceattn.http import FetchError, HttpClient
from raceattn.pipeline import DEFAULT_OUT, DEFAULT_RAW, LICENSED_SOURCES, LICENSING_WARNING, PipelineError, run
from raceattn.settings import load_settings


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m raceattn", description="%s %s" % (PROJECT_NAME, __version__))
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="pull sources for one race and compute metrics")
    rg = r.add_mutually_exclusive_group(required=True)
    rg.add_argument("--race", help="race id (config/races/<id>.yaml) or path to a yaml file")
    rg.add_argument("--all", action="store_true",
                    help="every confirmed config in config/races/ (drafts/ and needs_review files are left out)")
    r.add_argument("--sources", default=None,
                   help="comma-separated connector ids (default: default_sources in config/project.yaml)")
    r.add_argument("--refresh", action="store_true",
                   help="ignore the disk cache and re-fetch (paid reads that are cached are never re-pulled)")
    r.add_argument("--yes", action="store_true", help="allow paid connectors without a spend cap")
    r.add_argument("--max-spend", type=float, default=None, metavar="USD", help="allow paid connectors up to this estimate")
    r.add_argument("--raw-dir", default=DEFAULT_RAW, help="raw response cache (default: data/raw)")
    r.add_argument("--out-dir", default=DEFAULT_OUT, help="processed output dir (default: data/processed)")
    r.add_argument("--mediacloud-pace", type=float, default=None, metavar="SECONDS",
                   help="seconds between Media Cloud requests (default: connectors.news_mediacloud.pace_seconds in "
                        "config/project.yaml, 30)")
    r.add_argument("--display", action=argparse.BooleanOptionalAction, default=None,
                   help="build series.display_daily for the race's display_window (default: on when the race config "
                        "sets display_window). Pulls only display dates no cached window covers")
    v = sub.add_parser("validate", help="validate a race config and print a summary")
    v.add_argument("--race", required=True)
    e = sub.add_parser("events", help="draft config/events/<race>.csv from the race's Wikipedia page")
    e.add_argument("--race", required=True)
    e.add_argument("--refresh", action="store_true", help="re-fetch the page instead of using the cached revision")
    e.add_argument("--force", action="store_true", help="overwrite an events CSV that already has confirmed rows")
    e.add_argument("--raw-dir", default=DEFAULT_RAW)
    dv = sub.add_parser("discover", help="find 2026 races on Kalshi and Wikipedia and write draft configs")
    dv.add_argument("--office", required=True, choices=["senate", "governor"])
    dv.add_argument("--state", default=None, help="two-letter state code(s), comma-separated (default: all 50)")
    dv.add_argument("--refresh", action="store_true", help="re-fetch instead of using the cached responses")
    dv.add_argument("--raw-dir", default=DEFAULT_RAW)
    dv.add_argument("--drafts-dir", default=None, help="default: config/races/drafts")
    mc = sub.add_parser("mediacloud", help="Media Cloud collections lookup and the audit workflow")
    mcs = mc.add_subparsers(dest="mc_cmd", required=True)

    def mc_common(sp):
        sp.add_argument("--refresh", action="store_true", help="re-fetch instead of using cached responses")
        sp.add_argument("--pace", type=float, default=None, metavar="SECONDS",
                        help="seconds between Media Cloud requests (default 30, or the project setting)")
        sp.add_argument("--raw-dir", default=DEFAULT_RAW)

    col = mcs.add_parser("collections", help="search Media Cloud collections by name (needs MEDIACLOUD_API_KEY)")
    cg = col.add_mutually_exclusive_group(required=True)
    cg.add_argument("--state", help="two-letter state code; searches the state's name (e.g. TX -> Texas)")
    cg.add_argument("--name", help="any name to search")
    col.add_argument("--max-pages", type=int, default=5, help="pages of 100 collections (default 5)")
    mc_common(col)
    au = mcs.add_parser("audit", help="draw random stories per core query and collection into a git-ignored CSV")
    au.add_argument("--race", required=True)
    au.add_argument("--phase", required=True, choices=["tuning", "analysis"])
    au.add_argument("--n", type=int, default=None, help="stories per query and collection (default: the config, 100)")
    au.add_argument("--seed", type=int, default=1)
    au.add_argument("--max-pages", type=int, default=20, help="story-list pages per query and collection (default 20)")
    au.add_argument("--page-size", type=int, default=1000, help="stories per page requested (default 1000)")
    au.add_argument("--out", default=None, help="default: data/local/mediacloud/audit/<race>/<phase>.csv")
    au.add_argument("--force", action="store_true", help="overwrite a CSV that already has coded rows")
    mc_common(au)
    pr = mcs.add_parser("precision", help="precision with a Wilson 95%% interval from a coded audit CSV")
    pr.add_argument("csv")
    pr.add_argument("--target", type=float, default=0.90, help="precision target (default 0.90)")
    ag = mcs.add_parser("agreement", help="agreement and Krippendorff's alpha between two coders' CSVs")
    ag.add_argument("csv_a")
    ag.add_argument("csv_b")
    db = sub.add_parser("dashboard", help="build web/ if needed and serve the dashboard on 127.0.0.1 (local only)")
    db.add_argument("--race", required=True, help="race id from data/processed/index.json")
    db.add_argument("--port", type=int, default=4173, help="port on 127.0.0.1 (default 4173; 0 picks a free port)")
    db.add_argument("--no-open", action="store_true", help="do not open a browser")
    db.add_argument("--demo", action="store_true",
                    help="serve a synthetic Media Cloud fixture (DEMO DATA, not real) from memory; opens ?demo=1")
    db.add_argument("--no-build", action="store_true", help="serve web/dist as it is (skip the Node check and build)")
    dh = sub.add_parser("display-hourly",
                        help="add series.display_hourly and series.granularity to existing processed race JSONs")
    dg = dh.add_mutually_exclusive_group(required=True)
    dg.add_argument("--race", help="race id (data/processed/<id>.json and config/races/<id>.yaml)")
    dg.add_argument("--all", action="store_true", help="every race in --out-dir except index.json")
    dh.add_argument("--refresh", action="store_true", help="ignore the disk cache and re-fetch the Kalshi candles")
    dh.add_argument("--raw-dir", default=DEFAULT_RAW, help="raw response cache (default: data/raw)")
    dh.add_argument("--out-dir", default=DEFAULT_OUT, help="processed output dir, patched in place (default: data/processed)")
    pub = sub.add_parser("publish", help="check processed output before publishing (licensing, funding flag)")
    pub.add_argument("--out-dir", default=DEFAULT_OUT)
    return p


def cmd_events(args) -> int:
    from raceattn import events

    race = load_race(args.race)
    path = os.path.join(events.EVENTS_DIR, race.race_id + ".csv")
    if os.path.isfile(path) and not args.force:
        with open(path, encoding="utf-8", newline="") as f:
            confirmed = sum(1 for r in csv.DictReader(f) if (r.get("status") or "").strip() == "confirmed")
        if confirmed:
            print("error: %s has %d confirmed row(s). Re-run with --force to overwrite it with a new draft."
                  % (os.path.relpath(path), confirmed), file=sys.stderr)
            return 2
    rec = events.fetch_page(race, HttpClient(), raw_dir=args.raw_dir, refresh=args.refresh)
    rows, meta = events.generate(race, rec)
    csv_path, meta_path = events.write(race, rows, meta, events_dir=events.EVENTS_DIR)
    print("revision: %s" % meta["revision_url"])
    print("wrote %s: %d poll(s), %d debate(s), %d filing deadline(s), all status needs_review"
          % (os.path.relpath(csv_path), meta["counts"]["poll"], meta["counts"]["debate"],
             meta["counts"]["filing_deadline"]))
    print("polling_density (polls in the window %s..%s): %d; polls on the page: %d; unparsed poll rows: %d"
          % (meta["window"][0], meta["window"][1], meta["polling_density"], meta["polls_on_page"],
             len(meta["unparsed_poll_rows"])))
    print("wrote %s. A human must review every row and set status to confirmed before metrics use it."
          % os.path.relpath(meta_path))
    return 0


def run_settings(args):
    """Project settings with --mediacloud-pace applied, or None to let run() load them."""
    if getattr(args, "mediacloud_pace", None) is None:
        return None
    settings = load_settings()
    settings.setdefault("connectors", {}).setdefault("news_mediacloud", {})["pace_seconds"] = args.mediacloud_pace
    return settings


def cmd_run_all(args) -> int:
    import time

    races, left_out = confirmed_races()
    for fn, why in left_out.items():
        print("== %s: left out (%s)" % (fn, why))
    if not races:
        print("error: no confirmed race configs in config/races/", file=sys.stderr)
        return 2
    sources = [s.strip() for s in args.sources.split(",") if s.strip()] if args.sources else None
    failed = {}
    for race in races:
        print("\n######## %s" % race.race_id)
        t0 = time.time()
        try:
            run(race, sources, raw_dir=args.raw_dir, out_dir=args.out_dir, refresh=args.refresh, yes=args.yes,
                max_spend=args.max_spend, settings=run_settings(args), display=args.display)
            print("wrote %s/%s.json (%.0f s)" % (args.out_dir, race.race_id, time.time() - t0))
        except (PipelineError, FetchError) as e:
            failed[race.race_id] = str(e)
            print("error: %s: %s" % (race.race_id, e), file=sys.stderr)
    print("\nrun --all: %d race(s) written, %d failed%s; index.json updated" % (
        len(races) - len(failed), len(failed), (" (%s)" % ", ".join(failed)) if failed else ""))
    return 2 if failed else 0


def cmd_discover(args) -> int:
    from raceattn import discover

    states = [s.strip().upper() for s in args.state.split(",") if s.strip()] if args.state else None
    rep = discover.discover(args.office, states, raw_dir=args.raw_dir, refresh=args.refresh,
                            drafts_dir=args.drafts_dir or discover.DRAFTS_DIR)
    print()
    print(discover.report_markdown(rep))
    print("wrote %d draft(s) and discover-report-%s.md/.json in %s" % (
        len(rep["resolved"]), args.office, os.path.relpath(args.drafts_dir or discover.DRAFTS_DIR)))
    return 0


def mediacloud_pace(args) -> float:
    if getattr(args, "pace", None) is not None:
        return args.pace
    conf = (load_settings().get("connectors") or {}).get("news_mediacloud") or {}
    return float(conf.get("pace_seconds", 30.0))


def cmd_mediacloud(args) -> int:
    from raceattn import mcqueries, mediacloud as mc
    from raceattn.discover import STATES

    if args.mc_cmd == "precision":
        rows = mc.read_audit(args.csv)
        print("precision = relevant yes / (yes + no); unclear and blank rows are left out (counted below). "
              "Wilson 95%% interval. Target %.2f." % args.target)
        print("%-18s %-12s %5s %5s %4s %7s %7s %7s  %-9s  %s" % ("query", "collection", "rows", "yes", "no",
                                                                "unclear", "uncoded", "invalid", "precision",
                                                                "wilson 95%"))
        for r in mc.precision(rows, args.target):
            lo, hi = r["wilson95"]
            print("%-18s %-12s %5d %5d %4d %7d %7d %7d  %-9s  %s%s" % (
                r["query"], r["collection"], r["rows"], r["yes"], r["no"], r["unclear"], r["uncoded"], r["invalid"],
                "n/a" if r["precision"] is None else "%.3f" % r["precision"],
                "n/a" if lo is None else "%.3f to %.3f" % (lo, hi),
                "" if r["meets_target"] is None else ("" if r["meets_target"] else "  BELOW TARGET")))
        return 0
    if args.mc_cmd == "agreement":
        res = mc.agreement(mc.read_audit(args.csv_a), mc.read_audit(args.csv_b))
        print("joined on (query, collection, story_id): %d stories in both files, %d only in A, %d only in B"
              % (res["joined"], res["only_a"], res["only_b"]))
        print("a variable counts for a story only when both coders filled it; values compared after trimming and "
              "lower-casing. Targets: alpha 0.80, drop the variable below 0.70 (Lacy et al. 2015).")
        for var, v in res["variables"].items():
            a = v["krippendorff_alpha"]
            print("  %-9s n=%-4d simple agreement %s, Krippendorff's alpha (nominal) %s%s" % (
                var, v["n_units"], "n/a" if v["simple_agreement"] is None else "%.3f" % v["simple_agreement"],
                "n/a" if a is None else "%.3f" % a,
                (" (%s)" % v["alpha_detail"]["reason"]) if a is None and v["alpha_detail"].get("reason") else
                ("  BELOW 0.70: drop this variable" if a is not None and a < 0.70 else "")))
        return 0

    key = (os.environ.get(mc.ENV_KEY) or "").strip()
    if not key:
        print("error: " + mc.NO_KEY, file=sys.stderr)
        return 2
    client = mc.Client(key, raw_dir=args.raw_dir, refresh=args.refresh, pace_seconds=mediacloud_pace(args))
    try:
        if args.mc_cmd == "collections":
            name = STATES[args.state.upper()] if args.state else args.name
            if args.state and args.state.upper() not in STATES:
                print("error: unknown state code %s" % args.state, file=sys.stderr)
                return 2
            res = mc.search_collections(client, name, max_pages=args.max_pages)
            print("Media Cloud collections matching %r (endpoint sources/collections/ is unverified):" % name)
            print("%-12s %-8s %-12s %s" % ("id", "sources", "platform", "name"))
            for c in res["results"]:
                print("%-12s %-8s %-12s %s" % (c.get("id"), c.get("source_count", "?"), c.get("platform", "?"),
                                              c.get("name")))
            print("%d shown of %s%s" % (len(res["results"]), res["count"], "" if res["complete"] else
                                       " (more pages: raise --max-pages)"))
            print("Record the chosen collection's name, id, source count and today's date (looked_up_on) in "
                  "config/queries/<race>.mediacloud.yaml.")
        else:
            race = load_race(args.race)
            cfg = mcqueries.find(race.race_id)
            if cfg is None:
                print("error: no %s" % os.path.relpath(mcqueries.path_for(race.race_id)), file=sys.stderr)
                return 2
            n = args.n or int(cfg.audit.get("per_query_per_collection", 100))
            print("audit %s, phase %s (%s..%s), n=%d per core query and collection, seed %d; core queries: %s"
                  % (race.race_id, args.phase, *[d.isoformat() for d in cfg.phase(args.phase)], n, args.seed,
                     ", ".join(cfg.core_queries)))
            res = mc.run_audit(cfg, client, args.phase, n, args.seed, max_pages=args.max_pages,
                               page_size=args.page_size, out_path=args.out, force=args.force)
            o = res["syndication_overall"]
            print("syndication duplicate rate in the sample (same normalized title on 2+ domains): %s"
                  % mc._pct(o))
            print("wrote %s (%d rows) and %s. Sampling is uniform over the retrieved stories; see the summary "
                  "for any page cap." % (os.path.relpath(res["csv"]), sum(c["sampled"] for c in res["cells"]),
                                         os.path.relpath(os.path.splitext(res["csv"])[0] + ".summary.json")))
    finally:
        print(client.request_line())
    return 0


def cmd_display_hourly(args) -> int:
    """Patch existing processed JSONs in place: series.display_hourly from their series.hourly plus the cache."""
    from raceattn import display
    from raceattn.cache import Cache
    from raceattn.pipeline import make_connectors

    if args.all:
        rids = sorted(fn[:-5] for fn in os.listdir(args.out_dir) if fn.endswith(".json") and fn != "index.json")
    else:
        rids = [args.race]
    if not rids:
        print("error: no processed race JSON in %s" % args.out_dir, file=sys.stderr)
        return 2
    http, cache = HttpClient(), Cache(args.raw_dir)
    total, bad = 0, []
    for rid in rids:
        path = os.path.join(args.out_dir, rid + ".json")
        if not os.path.isfile(path):
            print("error: %s not found (run the pipeline first)" % path, file=sys.stderr)
            return 2
        race = load_race(rid)
        kalshi = make_connectors(["kalshi"], http, cache, args.refresh, load_settings())[0]
        kalshi.log = print
        print("== %s" % rid)
        out = display.patch_processed(race, path, kalshi, refresh=args.refresh)
        b, rec = out["block"], out["block"]["reconciliation"]
        total += b["requests_made"]
        print("   rows %d, %s..%s, filled hours %d, null price filled %d, null price hours %d, requests made %d" % (
            b["n_rows"], b["first_ts"], b["last_ts"], b["filled_hours"]["n"], b["forward_filled_null_price"]["n"],
            b["null_price_hours"]["n"], b["requests_made"]))
        print("   reconciliation: %s (%d day(s) checked, %d volume mismatch(es), %d close mismatch(es), "
              "daily null days: %s)" % (rec["status"], rec["days_checked"], len(rec["volume_mismatches"]),
                                        len(rec["close_mismatches"]), ", ".join(rec["daily_null_days"]) or "none"))
        for m in rec["volume_mismatches"]:
            print("     volume %s: hourly sum %r, daily %r" % (m["date"], m["hourly_sum"], m["daily"]))
        for m in rec["close_mismatches"]:
            print("     close %s: hourly last %r, daily %r" % (m["date"], m["hourly_last"], m["daily"]))
        for d in rec.get("days_without_hourly_rows", []):
            print("     %s: daily values but no hourly rows" % d)
        print("   granularity: %s" % ", ".join("%s %s" % kv for kv in out["granularity"].items() if kv[0] != "note"))
        print("   wrote %s (%d -> %d bytes)" % (path, out["size_before"], out["size_after"]))
        if rec["status"] != "match":
            bad.append(rid)
    print("\ndisplay-hourly: %d race(s) patched, %d request(s) made, reconciliation mismatch in: %s" % (
        len(rids), total, ", ".join(bad) or "none"))
    return 0


def cmd_publish(args) -> int:
    """Prints the licensing warning (until confirmed) and the funding flag state. Publishes nothing."""
    import json

    settings = load_settings()
    found: dict[str, list[str]] = {}
    for fn in sorted(os.listdir(args.out_dir)) if os.path.isdir(args.out_dir) else []:
        if not fn.endswith(".json") or fn == "index.json":
            continue
        with open(os.path.join(args.out_dir, fn), encoding="utf-8") as f:
            res = json.load(f)
        srcs = [s for s in res.get("sources", []) if s in LICENSED_SOURCES]
        if srcs:
            found[res["race"]["race_id"]] = srcs
    print("publish check (nothing is uploaded or sent by this command)")
    if not found:
        print("  no processed race uses X, Bluesky, Reddit or a news API; no licensing warning needed")
    elif settings.get("licensing_confirmed"):
        print("  licensing_confirmed is true in config/project.yaml; counts from %s may be published"
              % ", ".join(sorted({s for v in found.values() for s in v})))
    else:
        for rid, srcs in found.items():
            print("  %s: %s" % (rid, LICENSING_WARNING % ", ".join(srcs)))
    print("  funding disclosure: %s" % ("ON" if settings.get("funding_disclosure_enabled")
                                       else "off (set funding_disclosure_enabled: true once the grant is awarded)"))
    return 1 if found and not settings.get("licensing_confirmed") else 0


def main(argv: list[str] | None = None) -> int:
    from raceattn import envfile

    loaded = envfile.load_env()
    if loaded:
        print("loaded from .env: %s (values not shown)" % ", ".join(sorted(loaded)), file=sys.stderr)
    args = build_parser().parse_args(argv)
    try:
        if args.cmd == "mediacloud":
            return cmd_mediacloud(args)
        if args.cmd == "publish":
            return cmd_publish(args)
        if args.cmd == "dashboard":
            from raceattn import dashboard

            return dashboard.run(args.race, port=args.port, open_browser=not args.no_open, demo=args.demo,
                                 build=not args.no_build)
        if args.cmd == "display-hourly":
            return cmd_display_hourly(args)
        if args.cmd == "events":
            return cmd_events(args)
        if args.cmd == "discover":
            return cmd_discover(args)
        if args.cmd == "run" and args.all:
            return cmd_run_all(args)
        race = load_race(args.race)
        if args.cmd == "validate":
            from raceattn import mcqueries

            print("ok: %s (%s %s), window %s..%s, %d excluded day(s)" % (
                race.race_id, race.state, race.office, race.window.start, race.window.end, len(race.exclude_days)))
            cfg = mcqueries.find(race.race_id)
            if cfg is not None:
                print("ok: %s version %d, status %s, %d queries, collections configured: %s; not configured: %s; "
                      "config sha256 %s" % (os.path.relpath(cfg.path), cfg.version, cfg.status, len(cfg.queries),
                                            ", ".join(c.key for c in cfg.configured_collections) or "none",
                                            ", ".join(c.key for c in cfg.unconfigured_collections) or "none",
                                            cfg.config_sha256))
            return 0
        sources = [s.strip() for s in args.sources.split(",") if s.strip()] if args.sources else None
        run(race, sources, raw_dir=args.raw_dir, out_dir=args.out_dir, refresh=args.refresh, yes=args.yes,
            max_spend=args.max_spend, settings=run_settings(args), display=args.display)
        print("wrote %s/%s.json and index.json" % (args.out_dir, race.race_id))
        return 0
    except (ConfigError, PipelineError, FetchError, ValueError, FileExistsError) as e:
        print("error: %s" % e, file=sys.stderr)
        return 2
