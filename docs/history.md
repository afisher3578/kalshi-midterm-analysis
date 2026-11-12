# History

Short summaries of each milestone. The full notes for each one are linked and stay as they were written. The
project was called race-attention until MC4 renamed it kalshi-midterm-analysis (the GitHub repo name); the
notes files still use the old name.

## M0: Texas end to end

Race config schema, the Kalshi candlestick and Wikipedia pageview connectors, one UTC daily clock, the metrics
module (surprise, lag tables, quality checks) and the Texas Senate race end to end. A golden test reproduces the
stdlib pilot in `docs/reference/pilot/`. Notes: [m0-notes.md](m0-notes.md).

## M1: Texas dashboard

A static dashboard in `web/` (Vite, TypeScript, D3, Observable Plot) that reads `data/processed/tx-senate-2026.json`
and makes no other network calls. Kalshi price and volume panels, Wikipedia attention panels, the lag table, and an
offline render check with screenshots and axe. Notes: [m1-notes.md](m1-notes.md).

## M2: more sources and event metrics

Kalshi trades, X (your own token, with a cost guard), news connectors (Media Cloud, Guardian, NYT, a manual CSV,
optional GDELT) and Bluesky (unauthenticated). The event list generator (`events`), event windows, spikes, excess
attention and reversion. `publish` checks licensing and the funding flag and sends nothing. Kalshi trades and
Bluesky ran live; the keyed sources were built against documented shapes only. Notes: [m2-notes.md](m2-notes.md).

## M3: discovery, multi-state runs, US map

`discover` finds 2026 Senate and Governor races on Kalshi and Wikipedia and writes draft configs for human review.
`run --all` runs every confirmed config. Five more races ran end to end (four Senate, one Governor). The dashboard
gained a US map, filters, linkable URLs and the M3 charts. Notes: [m3-notes.md](m3-notes.md).

## MC1: Media Cloud search criteria and audit

The Media Cloud search criteria ([mediacloud-search-criteria.md](mediacloud-search-criteria.md)) as a per-race query
file, `config/queries/tx-senate-2026.mediacloud.yaml`. The connector makes one count-over-time request per query and
collection, paced 30 s apart and cached. The audit workflow (`mediacloud collections`, `audit`, `precision`,
`agreement`) and `.env` support. Built and tested offline; no key was available. Notes:
[mc1-notes.md](mc1-notes.md).

## MC2: local dashboard and the News view

`python -m raceattn dashboard` builds `web/` if needed and serves it on 127.0.0.1 with `data/processed` read live.
The News (Media Cloud) view: status, tiles, five charts, the ten largest days, the query drawer and downloads, with
an empty state when no Media Cloud data exists and a labeled synthetic `--demo` mode. `npm run verify` starts the
server itself. Notes: [mc2-notes.md](mc2-notes.md).

## MC4: rename and README

The project name changed to kalshi-midterm-analysis (`PROJECT_NAME` in `raceattn/__init__.py` and
`web/src/config.ts`). The Python package stays `raceattn`. The README was rewritten for a newcomer and the
milestone history moved here. MC3 (the live Media Cloud pull) has not run yet.
