"""Command line: python -m raceattn run --race tx-senate-2026 --sources kalshi,wikipedia"""
from __future__ import annotations

import argparse
import sys

from raceattn import PROJECT_NAME, __version__
from raceattn.config import ConfigError, load_race
from raceattn.http import FetchError
from raceattn.pipeline import DEFAULT_OUT, DEFAULT_RAW, PipelineError, run


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m raceattn", description="%s %s" % (PROJECT_NAME, __version__))
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="pull sources for one race and compute metrics")
    r.add_argument("--race", required=True, help="race id (config/races/<id>.yaml) or path to a yaml file")
    r.add_argument("--sources", default="kalshi,wikipedia", help="comma-separated connector ids (default: kalshi,wikipedia)")
    r.add_argument("--refresh", action="store_true", help="ignore the disk cache and re-fetch")
    r.add_argument("--yes", action="store_true", help="allow paid connectors without a spend cap")
    r.add_argument("--max-spend", type=float, default=None, metavar="USD", help="allow paid connectors up to this estimate")
    r.add_argument("--raw-dir", default=DEFAULT_RAW, help="raw response cache (default: data/raw)")
    r.add_argument("--out-dir", default=DEFAULT_OUT, help="processed output dir (default: data/processed)")
    v = sub.add_parser("validate", help="validate a race config and print a summary")
    v.add_argument("--race", required=True)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        race = load_race(args.race)
        if args.cmd == "validate":
            print("ok: %s (%s %s), window %s..%s, %d excluded day(s)" % (
                race.race_id, race.state, race.office, race.window.start, race.window.end, len(race.exclude_days)))
            return 0
        sources = [s.strip() for s in args.sources.split(",") if s.strip()]
        run(race, sources, raw_dir=args.raw_dir, out_dir=args.out_dir, refresh=args.refresh, yes=args.yes,
            max_spend=args.max_spend)
        print("wrote %s/%s.json and index.json" % (args.out_dir, race.race_id))
        return 0
    except (ConfigError, PipelineError, FetchError) as e:
        print("error: %s" % e, file=sys.stderr)
        return 2
