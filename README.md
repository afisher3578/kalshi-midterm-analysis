# race-attention

Working name (kept in one constant, `PROJECT_NAME` in `raceattn/__init__.py`). Takes one US race, pulls Kalshi
market data and attention data for it, puts them on one UTC clock and computes the same metrics for every race.
The tool reports timing and association, not causation.

Milestone M0 covers: race config schema, Kalshi and Wikipedia connectors, the metrics module, Texas end to end and
a golden test that reproduces the stdlib pilot in `docs/reference/pilot/`. M2 adds Kalshi trades, X (your own
token), news (Media Cloud, Guardian, NYT, a manual CSV, optional GDELT), Bluesky, the event list generator and the
event, spike and reversion metrics. M3 adds race discovery (`discover`), multi-state runs (`run --all`) and the US
map dashboard. See `docs/spec.md` and `docs/m0-notes.md` to `docs/m3-notes.md`.

## Setup

Do not use the macOS system Python (no CA certs, broken numpy). Use a venv:

    uv venv --python 3.11 .venv
    uv pip install --python .venv/bin/python -r requirements-dev.txt   # or requirements.txt without test tools
    ln -sf ../../scripts/hooks/pre-commit .git/hooks/pre-commit        # secrets check on every commit

No key is required. X, Media Cloud, Guardian and NYT read keys from the environment (export them in your shell, or
keep a git-ignored `.env` and load it yourself); see `.env.example`. A connector whose key is missing is skipped
with the reason, and the run still exits 0.

## Run

    .venv/bin/python -m raceattn run --race tx-senate-2026                      # default sources
    .venv/bin/python -m raceattn run --race tx-senate-2026 --sources kalshi,wikipedia
    .venv/bin/python -m raceattn run --race tx-senate-2026 --sources x --max-spend 1.00
    .venv/bin/python -m raceattn run --race path/to/other-race.yaml
    .venv/bin/python -m raceattn validate --race tx-senate-2026
    .venv/bin/python -m raceattn events --race tx-senate-2026     # draft config/events/<race>.csv (needs_review)
    .venv/bin/python -m raceattn publish                          # licensing and funding-flag check; sends nothing

Default sources (`default_sources` in `config/project.yaml`): `kalshi, kalshi_trades, wikipedia, x,
news_mediacloud, news_guardian, news_nyt, news_manual, bluesky`. `gdelt` is optional and not in the list.

Options: `--refresh` (ignore the cache and re-fetch; a cached paid read is never re-pulled), `--yes` /
`--max-spend USD` (required before any paid connector runs; X is the only paid one and prints its estimate first),
`--raw-dir`, `--out-dir`. Connector settings (Bluesky page caps, small-trade threshold, block trades, NYT spacing)
and the event metric settings are in `config/project.yaml`.

A Bluesky pull pages through every matching post (one request per 100 posts; Texas was about 2,000 requests and
22 minutes). It is cached per day, so later runs make no requests.

Events: `events` reads the polling tables on the race's Wikipedia page at a fixed revision and writes one row per
poll (`date_utc,type,source_url,note,status`), plus debates and filing deadlines only where the page lists them.
Every row is `needs_review` and cites the revision. Change a row's status to `confirmed` after checking it; the
event metrics ignore everything else. `events` refuses to overwrite a file that has confirmed rows (use `--force`).

## Discover races and run them all

    .venv/bin/python -m raceattn discover --office senate                 # all 50 states
    .venv/bin/python -m raceattn discover --office governor --state TX,OH
    .venv/bin/python -m raceattn run --all                                # every confirmed config

`discover` lists every Kalshi event (`GET /events`, statuses open, closed and settled; the settled listing is cut to
events with a market closing on or after election day) and matches a state by the event title ("Ohio Senate winner?",
"Texas Governor winner?" with 2026 in the sub title), never by ticker pattern. The followed market is the Democratic
party contract, as for Texas. It then finds the race article on Wikipedia through the MediaWiki API (redirects
resolved, so the Ohio and Florida special elections are found from the regular title), reads the nominees from the
election infobox (at least 5% of the vote when shares are listed) and writes
`config/races/drafts/<race_id>.yaml` with `status: needs_review` and a `discovery:` block: one confidence note per
field (high, medium or low, why, and the source URL or ticker). Aliases default to the surname. The news query uses
the bare surname only when Wikipedia has no other topic under it (no article, a redirect to the candidate, or a
surname list page), else the full name. Subreddits stay empty. It also writes
`config/races/drafts/discover-report-<office>.md` (and `.json`): every race resolved, every state not resolved and
why, and for a race that already has a hand-written config, a field-by-field comparison. The first run takes about
15 minutes (about 370 Kalshi pages and 2 s between MediaWiki calls); later runs read the cache (`--refresh` re-fetches).

A draft is trusted only after a human reviews it, moves it to `config/races/` and sets `status: confirmed`. A file
in `config/races/` without a `status` (the hand-written Texas config) counts as confirmed. `run --all` runs every
confirmed config and writes `data/processed/<race>.json` and `index.json`; drafts and `needs_review` files are left
out and listed. Per-race run settings (a lower Bluesky page cap, a source left out with a reason) go under
`race_overrides` in `config/project.yaml`; the race JSON records them in `run_overrides` and `skipped`.

`--race` takes a race id (loads `config/races/<id>.yaml`) or a path to a yaml file. One file fully describes a
race; connectors render every query from it and hard-code nothing.

## Test

    .venv/bin/pytest -q            # offline: recorded fixtures, network blocked
    .venv/bin/pytest -q --live     # also runs live smoke tests (Kalshi, Wikimedia, Bluesky; keyed ones skip without a key)
    .venv/bin/python scripts/check_secrets.py

## Outputs

`data/raw/<source>/<race_id>/<start>_<end>/<query_hash>/*.json` (git-ignored): raw JSON responses with the request
endpoint and params, fetch time and HTTP status. No headers or keys (query-param keys are added at send time only).
Reused unless `--refresh`. Bluesky stores one record per day with hourly counts only.

`data/processed/<race_id>.json` (committed):
- `race`: config summary. `window` (inclusive UTC dates) and `excluded_days`.
- `sources` (connectors that ran), `sources_requested` and `skipped` (connector id -> reason, e.g. missing key or
  missing manual CSV).
- `polling`: `polling_density` from `config/events/<race>.meta.json` (polls in the window, needs review).
- `licensing`: whether `licensing_confirmed` is set and the warning, when the output has counts from X, Bluesky,
  Reddit or the news APIs (docs/licensing.md).
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
- `series.hourly_grid`: every hour of the window for the other hourly series (`kalshi/trade_count`,
  `kalshi/small_trade_share`, `x/post_count`, `bluesky/post_count`). `ts_utc` is the hour's end, the same convention
  as the candles. These are also summed to UTC days (by bucket start; null if any hour is missing) in
  `series.daily`; the daily small-trade share is small trades / all trades.
- `metrics.hourly.<series>`: hourly lag tables (same-hour surprise, lags -3..+3 h) for X and Bluesky. Hourly
  attention series also get daily lag tables in `metrics.daily`.
- `metrics.events`: event windows, spikes, excess attention and reversion per daily attention series (see Method).
  With no confirmed events, `status` is `"no confirmed events"` and the event-window and excess-attention entries say
  so instead of giving a number; `n_needs_review_ignored` counts the draft rows that were ignored.

`data/processed/index.json` (committed): one entry per race with state, office, window, quality statuses and the
headline metric (Wikipedia total surprise vs Kalshi volume surprise, every lag). Under `metrics`, the map's numbers,
each with its n and all over the non-excluded days of the window: `attention_total` (Wikipedia pageviews summed),
`attention_vs_volume` (rho at lag 0), `price_change` (cents, first close to the last close before election night),
`polling_density`, `data_coverage` (mean coverage of the attention series that ran), `quality_summary` (status counts,
unusable series with reasons, skipped sources with reasons) and `attention` (the same numbers per attention series,
with its platform group). Re-running one race merges into the file and keeps the others.

The race JSON also has `events_overlay` (every row of the events CSV in the window with its status; the dashboard
draws them, metrics use only confirmed rows) and `run_overrides`.

## Method

- Surprise: `ln((x_t + 1) / (mean of the previous 7 same-slot values + 1))`; previous 7 days for daily series, the
  same hour on the previous 7 days for hourly series. Null if x_t or any of the 7 is missing.
- `exclude_days` from the config (election night for Texas) are masked after the surprise is computed, on both the
  attention and the outcome side, as in the pilot.
- Spearman rho with average ranks for ties. Cells with fewer than 20 pairs are blank; `n` is always reported.
- Noise band: each cell stores 2/sqrt(n), and each table stores 2/sqrt(max n in the table). The pilot printed
  2/sqrt(max(n - 7, 1)) with n = non-excluded days; that value is stored as `noise_band_pilot`. Daily series are
  autocorrelated, so either band is generous.

Event metrics (spec section 8; settings in `config/project.yaml` under `events`):
- Only events with status `confirmed` in `config/events/<race>.csv` are used.
- Event window: days -k..+k around each confirmed event, k = 2. Per offset: mean attention surprise, mean volume
  surprise, mean absolute and signed daily price change, each with n.
- Spike: a day with attention surprise >= 1.0 (about 2.7 times the trailing 7-day mean, with the +1 in the formula).
- Excess attention: a spike with no confirmed event within +-k days.
- Reversion after a spike on day t: move = close[t] - close[t-1]; if |move| >= 0.01, reversal fraction =
  -(close[t+3] - close[t]) / move; "reverted" if it is >= 0.5. Reported: spikes, n with a move, n reverted, share,
  mean fraction, and each spike. Excluded days are masked first.
- Every entry carries n, the quality status behind it and the query hashes.

## Quality thresholds

Computed on daily buckets. Near zero = under 5% of the series median with a normal neighbor. `unusable` if coverage
is under 70%, there is no data, or near-zero days exceed 10% of the window. `degraded` if coverage is under 95%, any
near-zero stretch exists, or a gap is 3 days or longer. Otherwise `ok`. The near-zero check is off for Kalshi price
(a low price is a real price).

## Layout

    config/races/          one yaml per race (confirmed); drafts/ holds discover output (needs_review)
    config/events/         event drafts per race (<race>.csv) and generator meta (<race>.meta.json)
    config/project.yaml    default sources, connector settings, race_overrides, licensing and funding flags
    raceattn/connectors/   base.py kalshi.py wikipedia.py x.py news.py bluesky.py
    raceattn/metrics/      surprise.py lags.py quality.py events.py
    raceattn/pipeline.py   raceattn/cli.py   raceattn/events.py (generator)   raceattn/discover.py
    data/processed/        committed outputs
    docs/sources/          terms and robots findings per source
    tests/fixtures/raw/    recorded public API responses (same layout as data/raw)
    scripts/               check_secrets.py, hooks/pre-commit

## License

Proposed defaults, not final: MIT for code, CC BY 4.0 for aggregated data. To be decided before anything is published.

## Dashboard

A static dashboard lives in `web/` (Vite + TypeScript, D3, Observable Plot). It reads `data/processed/index.json`
and `data/processed/<race_id>.json` and makes no other network calls. The US map uses d3-geo with the us-atlas
`states-albers-10m.json` geometry, committed in `web/src/geo/` and bundled, so it renders offline.

- Map: states colored by a selectable metric (total attention, attention surprise vs volume rho, price change,
  polling density, data coverage). A state with no race, or with n under 20 for the metric, is hatched and reads
  "insufficient data". Each state with a race prints its value on the map; a legend and a table below the map give
  the same values with n.
- Click a state, press Enter or Space on a focused state, or pick it from the State select: the race opens below
  with the M1 panels and the M3 charts (small multiples, normalized overlay, lead-lag heatmap, event study, scatter of
  attention surprise vs volume surprise, calendar heatmap). A race-type switcher appears when a state has more than
  one race.
- Filters: race type, platform group (talking, reporting, looking) and source, window (sub-range, applied in the
  page), map metric, information-event overlay, polling density band (low under 10 polls, medium 10 to 29, high 30+).
- The URL carries `race`, `state` and the filters, so every view is linkable (`?race=oh-senate-2026&state=OH`).
- A source with no data shows a card with the reason and the command to run it locally with your own key; an
  unusable series shows its badge and reason.

    cd web
    npm ci
    npm run build      # writes web/dist and copies data/processed/*.json into web/dist/data/
    npm run preview    # serves web/dist at http://127.0.0.1:4173/
    npm run dev        # live reload; serves data/processed under /data/

`?race=<race_id>` picks the race (default `tx-senate-2026`). The page loads its data with `fetch`, and
browsers block `fetch` from `file://` pages, so open it over http (`npm run preview` or any static file server
on `web/dist`), not by double-clicking `index.html`. The build is plain static files and can go on any host
under any path. `npm run check` type-checks, `npm test` runs the transform tests, and `npm run verify` (with the
preview running) does the offline render check, the state-switch check, the badge checks, screenshots and axe at
390 and 1280 px. Details and results: `docs/m1-notes.md` and `docs/m3-notes.md`.
