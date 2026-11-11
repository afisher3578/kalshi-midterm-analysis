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
                max_spend=args.max_spend)
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
    args = build_parser().parse_args(argv)
    try:
        if args.cmd == "publish":
            return cmd_publish(args)
        if args.cmd == "events":
            return cmd_events(args)
        if args.cmd == "discover":
            return cmd_discover(args)
        if args.cmd == "run" and args.all:
            return cmd_run_all(args)
        race = load_race(args.race)
        if args.cmd == "validate":
            print("ok: %s (%s %s), window %s..%s, %d excluded day(s)" % (
                race.race_id, race.state, race.office, race.window.start, race.window.end, len(race.exclude_days)))
            return 0
        sources = [s.strip() for s in args.sources.split(",") if s.strip()] if args.sources else None
        run(race, sources, raw_dir=args.raw_dir, out_dir=args.out_dir, refresh=args.refresh, yes=args.yes,
            max_spend=args.max_spend)
        print("wrote %s/%s.json and index.json" % (args.out_dir, race.race_id))
        return 0
    except (ConfigError, PipelineError, FetchError) as e:
        print("error: %s" % e, file=sys.stderr)
        return 2
