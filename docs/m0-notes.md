# M0 notes

Date: 2026-11-11. Status: M0 done on schedule (target was Nov 13).

## What was built
- Package `raceattn` with `python -m raceattn run --race <id|path> --sources kalshi,wikipedia` and `validate`.
- Race config loader with schema validation (`raceattn/config.py`) and `config/races/tx-senate-2026.yaml`, exactly
  as in spec section 4. Checks required keys, types, date parsing, window start <= end, exclude days inside or
  adjacent to the window, office enum, duplicate pages, unknown keys (catches typos).
- Connector base (`connectors/base.py`): `id, auth, granularity, cost_model, estimate_cost, fetch, quality`,
  the normalized `Row` (`race_id, source, series, ts_utc, granularity, value, unit, query_hash, fetched_at`) and
  `RenderedQuery`, the single place each connector builds its requests.
- Kalshi connector: hourly candlesticks in <= 20 day chunks, forward-filled price, volume from `volume_fp`, dedupe
  on `end_period_ts`. Series `kalshi/price_close`, `kalshi/volume`. Trades (`fetch_trades`) is an M2 stub that
  raises `NotImplementedError`.
- Wikipedia connector: one series per page, `wikipedia/pageviews/<Title>` (title as written in the config), plus
  `wikipedia/pageviews_total`.
- Metrics: surprise, daily Kalshi aggregates, price changes, masks, Spearman lag tables (daily and hourly paths),
  noise bands, quality checks.
- Pipeline writes `data/processed/tx-senate-2026.json` and merges `data/processed/index.json`.
- Disk cache under `data/raw/<source>/<race_id>/<start>_<end>/<query_hash>/`. Polite HTTP client with retries.
- Cost guard: paid connectors need `--yes` or `--max-spend` (tested with a fake paid connector).
- Secrets check `scripts/check_secrets.py`, pre-commit hook `scripts/hooks/pre-commit` (installed as a symlink in
  `.git/hooks/pre-commit`), and a test that runs it over tracked files, `data/processed` and `data/raw`.
- Tests: 95 offline plus 1 live (`pytest --live`).

## How to verify
    uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python -r requirements-dev.txt
    .venv/bin/pytest -q                      # offline, network blocked, recorded fixtures
    .venv/bin/pytest -q --live               # adds the live smoke test
    .venv/bin/python -m raceattn run --race tx-senate-2026 --refresh   # live pull, rewrites data/processed

## Defaults chosen (spec section 15)
1. Name: `race-attention`, in `PROJECT_NAME` (`raceattn/__init__.py`) and the package name only.
2. Front end: Vite + TypeScript + D3 + Observable Plot (M1; nothing built in M0).
3. Hosting: no deploy; the site will build to `web/dist` (git-ignored).
4. License: MIT for code, CC BY 4.0 for aggregated data, as proposed defaults only (noted in README).
5. Repo: `~/work/race-attention`, local commits on `main`, no remote, no push.
6. Races: Texas only.

## Other defaults and thresholds
- Query hash: sha256 of `{"endpoint": ..., "params": {...}}` as sorted, compact JSON; first 16 hex chars. Series
  built from several requests (Kalshi chunks, Wikipedia total) use a hash of the sorted request hashes.
- Quality (on daily buckets): `unusable` if coverage < 70%, no data, or near-zero days > 10% of the window;
  `degraded` if coverage < 95%, any near-zero stretch, or a gap of 3+ days; else `ok`. Near zero = under 5% of
  the series median with a normal neighbor on at least one side. Near-zero check is off for Kalshi price.
  The pilot's GDELT shape (44/65 days) comes out `unusable` (unit test).
- `wikipedia/pageviews_total` is null on a day when any page is missing. The pilot summed whatever pages were
  present. Both agree for Texas (all 65 days present for all pages); ours never hides a gap in a partial sum.
- The daily table uses the window's dates. The pilot used the dates that had Kalshi candles. Same 65 days for Texas.
- Every daily attention series gets a lag table (total and each page). The headline in `index.json` is the total.
- Noise band: per cell 2/sqrt(n); per table 2/sqrt(max n in the table) = 0.27 for Texas (n = 56). The pilot's
  2/sqrt(max(63 - 7, 1)) = 0.27 is stored as `noise_band_pilot`.
- rho is stored to 4 decimals (the pilot rounded to 2).
- HTTP: 0.3 s between calls, up to 4 retries on 429/5xx with backoff 1, 2, 4, 8 s, then stop with an error.
  403 stops at once. User-Agent `race-attention/0.1.0 (research tool; contact via repo)`.
- Wikipedia 404 (no data for an article) becomes an empty series marked `unusable`, not a crash.

## Golden test results (Texas, wikipedia/pageviews_total surprise)

Live run 2026-11-11 and the recorded fixtures give identical bodies, so the offline test and the committed output
are the same numbers. Kalshi: 1,536 hourly candles. Wikipedia: 65/65 days for each page. Daily closes: 0.49
(Sep 5), 0.65 (Oct 5), 0.69 (Oct 29), 0.997 (Nov 4). The daily table matches `tx_daily.csv` on close, volume and
every wiki column.

| outcome | lag | pilot rho | pilot n | new rho | new n | abs diff (2 dp) |
|---|---|---|---|---|---|---|
| volume_surprise | -2 | 0.02 | 54 | 0.0176 | 54 | 0.00 |
| volume_surprise | -1 | 0.07 | 55 | 0.0685 | 55 | 0.00 |
| volume_surprise | 0 | 0.24 | 56 | 0.2383 | 56 | 0.00 |
| volume_surprise | +1 | 0.28 | 55 | 0.2786 | 55 | 0.00 |
| volume_surprise | +2 | 0.22 | 54 | 0.2163 | 54 | 0.00 |
| abs_price_change | -2 | -0.02 | 56 | -0.0231 | 56 | 0.00 |
| abs_price_change | -1 | 0.05 | 56 | 0.0482 | 56 | 0.00 |
| abs_price_change | 0 | 0.06 | 56 | 0.0599 | 56 | 0.00 |
| abs_price_change | +1 | -0.02 | 55 | -0.0244 | 55 | 0.00 |
| abs_price_change | +2 | 0.00 | 54 | 0.0042 | 54 | 0.00 |
| price_change | -2 | 0.03 | 56 | 0.0266 | 56 | 0.00 |
| price_change | -1 | -0.10 | 56 | -0.0961 | 56 | 0.00 |
| price_change | 0 | -0.05 | 56 | -0.0528 | 56 | 0.00 |
| price_change | +1 | -0.15 | 55 | -0.1514 | 55 | 0.00 |
| price_change | +2 | -0.12 | 54 | -0.1150 | 54 | 0.00 |

No lag differs by more than 0.02 (all match at 2 decimals), so no investigation was needed.

## Not verified
- Kalshi terms on redistributing derived aggregates; any unauthenticated Kalshi rate limit (docs only cover
  authenticated token budgets). See `docs/sources/kalshi.md`.
- Wikimedia per-client rate limit numbers (we stay far below the documented 200 requests per second and send one
  request at a time). The User-Agent contact is generic until the repo has a public URL.
- `subreddits` in the Texas config (`texas`, `TexasPolitics`) were not checked; Reddit is M4.
- `docs/licensing.md` (spec section 12) is not written yet; it matters once X or Reddit counts are published (M2+).
- Kalshi trades endpoints and the historical cutoff (M2).
