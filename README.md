# race-attention

Working name (kept in one constant, `PROJECT_NAME` in `raceattn/__init__.py`). Takes one US race, pulls Kalshi
market data and attention data for it, puts them on one UTC clock and computes the same metrics for every race.
The tool reports timing and association, not causation.

Milestone M0 covers: race config schema, Kalshi and Wikipedia connectors, the metrics module, Texas end to end and
a golden test that reproduces the stdlib pilot in `docs/reference/pilot/`. See `docs/spec.md` and `docs/m0-notes.md`.

## Setup

Do not use the macOS system Python (no CA certs, broken numpy). Use a venv:

    uv venv --python 3.11 .venv
    uv pip install --python .venv/bin/python -r requirements-dev.txt   # or requirements.txt without test tools
    ln -sf ../../scripts/hooks/pre-commit .git/hooks/pre-commit        # secrets check on every commit

M0 needs no keys. Later connectors read keys from the environment or a git-ignored `.env`; see `.env.example`.

## Run

    .venv/bin/python -m raceattn run --race tx-senate-2026 --sources kalshi,wikipedia
    .venv/bin/python -m raceattn run --race path/to/other-race.yaml
    .venv/bin/python -m raceattn validate --race tx-senate-2026

Options: `--refresh` (ignore the cache and re-fetch), `--yes` / `--max-spend USD` (required before any paid
connector runs; both M0 connectors are free), `--raw-dir`, `--out-dir`.

`--race` takes a race id (loads `config/races/<id>.yaml`) or a path to a yaml file. One file fully describes a
race; connectors render every query from it and hard-code nothing.

## Test

    .venv/bin/pytest -q            # offline: recorded fixtures, network blocked
    .venv/bin/pytest -q --live     # also runs the live smoke test against Kalshi and Wikimedia
    .venv/bin/python scripts/check_secrets.py

## Outputs

`data/raw/<source>/<race_id>/<start>_<end>/<query_hash>/*.json` (git-ignored): raw JSON responses with the request
endpoint and params, fetch time and HTTP status. No headers or keys. Reused unless `--refresh`.

`data/processed/<race_id>.json` (committed):
- `race`: config summary. `window` (inclusive UTC dates) and `excluded_days`.
- `queries`: per connector, every rendered request (endpoint, params, query hash), the connector query hash and the
  query hash behind each series. A reader can audit exactly what was fetched.
- `series.hourly`: Kalshi hourly rows `[ts_utc, kalshi/price_close, kalshi/volume]`. `ts_utc` is the candle's
  `end_period_ts`; price is forward-filled for hours with no trades; volume is 0 when missing.
- `series.daily`: the aligned daily table on the window's dates: `date, excluded, kalshi/price_close` (last close of
  the UTC day), `kalshi/volume` (sum of the day's hourly volume), `wikipedia/pageviews_total` and one
  `wikipedia/pageviews/<Title>` column per page. Attention values are never interpolated; missing stays null.
- `quality`: per series coverage, missing days, longest gap, near-zero stretches, status `ok | degraded | unusable`
  and reasons.
- `metrics.daily.<attention series>`: lag tables of attention surprise vs `volume_surprise`, `abs_price_change` and
  `price_change` at lags -2..+2 days (lag > 0: outcome after attention). Each cell has `rho` (null when n < 20),
  `n`, `noise_band` (2/sqrt(n)), `quality_status` and the attention and outcome query hashes. A series marked
  `unusable` is skipped with the reason.
- `metrics.hourly`: empty in M0 (no hourly attention source yet). The hourly path is implemented and tested.

`data/processed/index.json` (committed): one entry per race with window, quality statuses and the headline metric
(Wikipedia total surprise vs Kalshi volume surprise). Re-running one race merges into the file and keeps the others.

## Method

- Surprise: `ln((x_t + 1) / (mean of the previous 7 same-slot values + 1))`; previous 7 days for daily series, the
  same hour on the previous 7 days for hourly series. Null if x_t or any of the 7 is missing.
- `exclude_days` from the config (election night for Texas) are masked after the surprise is computed, on both the
  attention and the outcome side, as in the pilot.
- Spearman rho with average ranks for ties. Cells with fewer than 20 pairs are blank; `n` is always reported.
- Noise band: each cell stores 2/sqrt(n), and each table stores 2/sqrt(max n in the table). The pilot printed
  2/sqrt(max(n - 7, 1)) with n = non-excluded days; that value is stored as `noise_band_pilot`. Daily series are
  autocorrelated, so either band is generous.

## Quality thresholds

Computed on daily buckets. Near zero = under 5% of the series median with a normal neighbor. `unusable` if coverage
is under 70%, there is no data, or near-zero days exceed 10% of the window. `degraded` if coverage is under 95%, any
near-zero stretch exists, or a gap is 3 days or longer. Otherwise `ok`. The near-zero check is off for Kalshi price
(a low price is a real price).

## Layout

    config/races/          one yaml per race
    raceattn/connectors/   base.py kalshi.py wikipedia.py
    raceattn/metrics/      surprise.py lags.py quality.py
    raceattn/pipeline.py   raceattn/cli.py
    data/processed/        committed outputs
    docs/sources/          terms and robots findings per source
    tests/fixtures/raw/    recorded public API responses (same layout as data/raw)
    scripts/               check_secrets.py, hooks/pre-commit

## License

Proposed defaults, not final: MIT for code, CC BY 4.0 for aggregated data. To be decided before anything is published.

## Dashboard

A static dashboard for one race lives in `web/` (Vite + TypeScript, D3, Observable Plot). It reads
`data/processed/<race_id>.json` and makes no other network calls.

    cd web
    npm ci
    npm run build      # writes web/dist and copies data/processed/*.json into web/dist/data/
    npm run preview    # serves web/dist at http://127.0.0.1:4173/
    npm run dev        # live reload; serves data/processed under /data/

`?race=<race_id>` picks the race file (default `tx-senate-2026`). The page loads its data with `fetch`, and
browsers block `fetch` from `file://` pages, so open it over http (`npm run preview` or any static file server
on `web/dist`), not by double-clicking `index.html`. The build is plain static files and can go on any host
under any path. `npm run check` type-checks, `npm test` runs the transform tests, and `npm run verify` (with the
preview running) does the offline render check, screenshots and axe. Details and results: `docs/m1-notes.md`.
