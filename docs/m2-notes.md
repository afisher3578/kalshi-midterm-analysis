# M2 notes

Date: 2026-11-11. Status: M2 built. Kalshi trades, Bluesky (unauthenticated), the event generator and the Texas run
ran live. X, Media Cloud, Guardian and NYT were not called live (no keys here); they are built against the
documented response shapes and tested with fixtures marked `synthetic from docs`.

## What was built
- Shared: `HttpClient` takes auth `headers` and query-param `secret_params` per request (never stored), has
  `post_json`, and redacts every secret (and its URL-encoded form) from error messages. `cached_get` writes only the
  endpoint and the key-free params, scrubs the body of any echoed secret, and never re-pulls a cached read for a
  paid connector, even with `--refresh`. Connectors declare `env_keys` and a `skip_reason`.
- `config/project.yaml` + `raceattn/settings.py`: default sources, per-connector settings, event metric settings,
  `licensing_confirmed` and `funding_disclosure_enabled` (both false).
- Kalshi trades (`kalshi_trades`, in `connectors/kalshi.py`; `KalshiConnector.fetch_trades` now delegates to it):
  `/historical/cutoff`, `/historical/trades` before the cutoff, `/markets/trades` from it on, cursor paging,
  dedupe on `trade_id`. Hourly `kalshi/trade_count` and `kalshi/small_trade_share`.
- X (`connectors/x.py`): counts/all with `granularity=hour` and `next_token`, fallback to counts/recent with the
  series marked `degraded`, cost estimate, token from `X_BEARER_TOKEN` in an Authorization header built in process.
- News (`connectors/news.py`): `news_mediacloud`, `news_guardian`, `news_nyt`, `news_manual`, `gdelt` (optional).
  One file instead of the spec's mediacloud.py/guardian.py/nyt.py, because they share the daily-count base and the
  query rendering; ids and series names follow the spec.
- Bluesky (`connectors/bluesky.py`): unauthenticated `until` walk on api.bsky.app, optional app-password mode with
  cursor paging, per-term-day and per-run page caps, counts-only cache.
- Event generator (`raceattn/events.py`, `python -m raceattn events`): MediaWiki parse API at a fixed revision,
  polling tables (rowspans and named refs handled), debate tables, filing-deadline prose. Writes
  `config/events/<race>.csv` (all `needs_review`) and `<race>.meta.json` (`polling_density`, revision, counts,
  unparsed rows). Refuses to overwrite a file with confirmed rows unless `--force`.
- Metrics (`metrics/events.py`): event windows, spikes, excess attention and reversion (definitions in README).
- Pipeline: default source list, skipped connectors with reasons (`skipped` in the output and a log line), every
  hourly series on a full hour grid (`series.hourly_grid`), hourly series summed into the daily table, hourly lag
  tables for X and Bluesky, `metrics.events`, `polling`, `licensing`. `series.hourly` (Kalshi candles) is unchanged,
  so the M1 dashboard and the golden test read it as before. `schema_version` is now 2.
- `python -m raceattn publish`: prints the licensing warning for every processed race with counts from X, Bluesky,
  Reddit or a news API until `licensing_confirmed: true`, prints the funding flag, exits 1 while the warning
  applies. It publishes nothing.
- `scripts/check_secrets.py`: new patterns for env keys with values, `api-key=` in URLs, `Token <hex>` headers and
  JWTs. `scripts/record_bluesky_fixture.py` re-records the Bluesky fixture.
- Docs: `docs/sources/{x,bluesky,mediacloud,guardian,nyt,news_manual,gdelt}.md`, trades section in `kalshi.md`,
  MediaWiki section in `wikipedia.md`, `docs/licensing.md`, README sections, `.env.example` notes.

## Defaults chosen
- Default sources: `kalshi, kalshi_trades, wikipedia, x, news_mediacloud, news_guardian, news_nyt, news_manual,
  bluesky`. `gdelt` is optional and off.
- Small trade: `count_fp` under 10 contracts. Block trades excluded by default; the count excluded is in quality.
  Trade hours with no trades: count 0, share null.
- X query: every entity name and alias as a quoted phrase, OR-joined, plus `lang:en -is:retweet`. Estimate: pages
  (hours / 744, rounded up) minus cached pages, times $0.010. A fully cached pull passes the guard with $0.
- X refusal statuses that trigger the fallback: 400, 402, 403, 404, 429. 401 stops (bad token). Refusals are not
  cached.
- Bluesky: terms are each entity's aliases (name if none). `sort=latest`, `lang=en`, `limit=100`. Up to 50 pages
  per term per UTC day and 6000 per run. A post's time is the earlier of `createdAt` and `indexedAt`.
- News query: the race config `news_query`, else entity names OR-joined. Guardian 1.1 s between calls, NYT 12 s,
  GDELT 6 s. Media Cloud collection 34412234 (US national).
- Hourly alignment: non-candle hourly series are stored by bucket start and shown in `hourly_grid` by hour end, like
  the Kalshi candles. Daily sums use the bucket start's UTC date; a day with any missing hour is null.
- Events: k = 2 days; spike = attention surprise >= 1.0; reversion N = 3 days, "reverted" = at least half of the
  spike-day move undone; spike-day moves under 1 cent count as "no move". Only `confirmed` rows are used.
- Poll dates: the cited source's `date=` when it is on or up to 30 days after the end of fieldwork (release date),
  else the end of fieldwork; the note says which. Polls are deduped on pollster + end of fieldwork. Only polls with
  a date in the window go in the CSV. Polling sections under "General election" are used when present.
- `polling_density`: distinct polls with a date in the window (53 for Texas).

## What ran live (2026-11-11)
- Kalshi trades for SENATETX-26-D: cutoff 2026-09-11T00:00:00Z; 2,563 historical trades (3 pages) and 113,765
  live (114 pages); 116,328 in the window; 0 block trades. Fixture recorded for 2026-09-10..11 (754 trades).
- Bluesky, unauthenticated: the probes in `docs/sources/bluesky.md` (public.api.bsky.app 403, api.bsky.app 200,
  cursor 403, `until` walk works, `until` inclusive, no `OR`), the 1-day fixture, and the full Texas window
  (see "Texas run" below).
- Event generator for Texas: revision 1384978385; 53 polls in the window (44 dated by the cited release date, 9 by
  end of fieldwork), 0 debates and 0 filing deadlines in the window (the page lists only a January primary debate
  and says no general election debates were held), 1 unparsed row ("Mid-April 2025", outside the window).
  `config/events/tx-senate-2026.csv` is committed as a draft, every row `needs_review`.
- Unauthenticated probes of Media Cloud (401), Guardian (401; the old `test` demo key no longer works), NYT (401)
  and GDELT (429 on the first request).
- `pytest -q --live` with no keys: 165 passed, 4 skipped (Guardian, NYT, Media Cloud, X: key not set).

## What did not run live
- X counts (no token). Whether counts/all works on pay-per-use is still unknown.
- Media Cloud, Guardian, NYT counts (no keys).
- Bluesky authenticated mode and cursor paging (no app password).
- GDELT counts (rate limited on the one probe; optional anyway).

## Texas run
`python -m raceattn run --race tx-senate-2026` with no keys, after the live pulls (all reads from cache):
- Ran: kalshi, kalshi_trades, wikipedia, bluesky. Skipped with reasons: x, news_mediacloud, news_guardian, news_nyt
  (missing key), news_manual (missing `data/raw/news_manual/tx-senate-2026.csv`). Exit 0.
- Golden numbers unchanged: Wikipedia total surprise vs volume surprise rho 0.24 / 0.28 / 0.22 at lags 0 / +1 / +2
  (n 56 / 55 / 54); 1,536 hourly candles.
- Kalshi trades: 116,328 trades, 65/65 days, `ok`. Daily small-trade share 0.31 to 0.38 in the last four days.
- Bluesky: 158,838 posts over 65 days (2,065 pages in 22 minutes, unauthenticated), `degraded` because the
  50-page cap was hit on 2026-09-10, 09-11 and 11-04 (those days are lower bounds).
  Daily Bluesky surprise vs volume surprise: rho 0.24 (lag 0, n 56), 0.19 (+1), 0.17 (+2). Hourly vs volume
  surprise: 0.07 to 0.12 at lags -3..+3 h (n about 1,300; noise band 0.05).
- Events: "no confirmed events"; 53 draft rows ignored. Spikes (surprise >= 1.0) in Wikipedia total and Bluesky on
  2026-09-10 and 09-11; reversion n = 1 for each (the other spike day had no price move of 1 cent), not reverted.
- `polling_density` 53 in `polling`. Licensing warning printed (Bluesky counts); `publish` exits 1.

## Acceptance checks
- No keys, default sources: runs Kalshi and Wikipedia (and trades, Bluesky), prints each skipped connector and why,
  exit 0. Live run above; offline form in `tests/test_pipeline_m2.py::test_cli_default_run_without_keys`.
- Fake `X_BEARER_TOKEN`: the CLI printed "cost estimate for x: about $0.03 over 3 requests ..." first, then
  refused without `--yes` or `--max-spend` (exit 2), and refused `--max-spend 0.01` as over the cap. No request
  was made (`tests/test_x.py::test_cost_guard_refuses_without_yes_and_makes_no_call` checks this with the network
  blocked; the live CLI check left no `data/raw/x`).
- Token leak test (`tests/test_leaks.py`): fake X, Guardian, NYT, Media Cloud and Bluesky secrets built from uuid4,
  run through every keyed connector on success and error paths (with fake APIs that echo the keys back); then the
  repo, captured logs, exceptions, cache dirs and processed output are searched and contain none of them. Checked
  that the test fails if redaction is switched off. No fixed marker string is used, so there is nothing to grep for
  afterwards.
- `pytest -q`: 161 passed, 8 skipped (live). `pytest -q --live` with no keys: 165 passed, 4 skipped (keyed tests).
- `scripts/check_secrets.py`: clean over tracked files, data/processed and data/raw.
- No em dashes in files written for M2 (scanned).
- The M1 dashboard reads the new output: `npm run check`, `npm test` and `npm run build` in web/ ran without errors
  (web/ untouched; the new Bluesky daily column shows up as another attention panel there).

## Unverified
- X prices ($0.010 per counts/all request, $0.005 per counts/recent request) were read through a summarizing fetch
  of the pricing page and are not confirmed against a bill. The `client-not-enrolled` 403 body fields are from
  third-party notes.
- X counts response field: docs show both `tweet_count` and `post_count`; both are read.
- Media Cloud live response shape and the US national collection name; Guardian and NYT live response shapes; NYT
  `meta` vs `metadata`; how NYT treats the boolean `news_query`; the Guardian date time zone (assumed UTC days).
- Bluesky developer guidelines (docs pages need JavaScript); authenticated search on bsky.social; any published
  rate limit for unauthenticated search (none was hit); the index's exact `sortAt` rule (we approximate it with the
  earlier of createdAt and indexedAt).
- Whether any source's terms allow publishing aggregate counts (docs/licensing.md). X's policy wording reads
  against it.
- The Guardian 24-hour storage rule's reach (does a daily total count as OP Content?).
- Event rows: every one needs a human check. The generator trusts Wikipedia's dates and the cited sources' `date=`
  fields, which can be the article date rather than the poll release.
- The Kalshi cutoff moves over time; cached runs keep the cutoff they were fetched with.

## How to verify
    .venv/bin/pytest -q                       # offline, fixtures only, network blocked
    .venv/bin/pytest -q --live                # live smoke tests; keyed ones skip without a key
    .venv/bin/python -m raceattn run --race tx-senate-2026          # no keys: prints skipped connectors, exit 0
    X_BEARER_TOKEN=fake-$(uuidgen) .venv/bin/python -m raceattn run --race tx-senate-2026 --sources x
                                              # prints the estimate, refuses (exit 2), no request made
    .venv/bin/python -m raceattn events --race tx-senate-2026       # cached revision; --refresh for the current one
    .venv/bin/python -m raceattn publish      # licensing warning, exit 1 until licensing_confirmed
    .venv/bin/python scripts/check_secrets.py
