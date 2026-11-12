# MC1 notes: Media Cloud search criteria, connector upgrade, audit workflow

Date: 2026-11-11. Status: built and tested offline. There is no Media Cloud key on this machine, so nothing here
has run against the live API and no Media Cloud numbers exist yet. A later card does the live run. The criteria
this implements are in docs/mediacloud-search-criteria.md (repo copy of Alex's approved note).

## What was built

- `config/queries/tx-senate-2026.mediacloud.yaml`: the section 9 shape, `status: draft`, version 1. The seven
  queries from section 4 with the logic as drafted, plus `any_either` (below). Collections: `national` (id
  34412234, "United States - National", unconfirmed) and `texas_local` (`{name: null, id: null}` until the lookup).
  Also `api_version: null`, `timezone_note: unverified`, `looked_up_on` and `source_count` per collection,
  `exclusions_log`, `changes_log`, `derived` and the `audit` block.
- `raceattn/mcqueries.py`: loader and validator, query hash and config hash.
- `raceattn/connectors/news.py` (`MediaCloudConnector`): the query config path, with the old `news_query` path kept
  for races without a query file.
- `raceattn/mediacloud.py`: paced, cached requests that stop on 401/403/429; collections search; story-list paging;
  audit sampling; syndication rate; precision and agreement over coded CSVs.
- `raceattn/metrics/reliability.py`: Wilson interval, simple agreement, Krippendorff's alpha (nominal).
- `raceattn/envfile.py`: `.env` loading at CLI startup.
- CLI: `mediacloud collections`, `mediacloud audit`, `mediacloud precision`, `mediacloud agreement`;
  `run --mediacloud-pace`; `validate` also validates the query file and prints its hash.
- Smaller changes: `HttpClient(stop_status=...)` and `FetchError.status` (`raceattn/http.py`); the cache logic of
  `Connector.cached_get` moved into `cached_request` so the CLI commands share it (`raceattn/connectors/base.py`);
  `compute_quality(min_near_zero_days=...)` (default 1, the M0 rule); pipeline support for context series and a
  `.env` hint when a key is missing; `data/local/` in `.gitignore`.
- Tests: `tests/test_mediacloud.py` (33 offline, 1 live), `tests/test_dotenv.py` (3). Synthetic fixtures in
  `tests/fixtures/mediacloud/` (`*.synthetic.json`, each with `_synthetic: true` and a note), listed in
  `tests/fixtures/README.md`. The M2 test for the old Media Cloud path now points the connector at an empty
  queries dir, since Texas has a query file.

## Design choices

### Query rendering and hashes
- Every stored query is `(<base>) AND language:en`. That is a syntax adaptation with the logic unchanged: without
  the outer parentheses the language clause would bind only to the last clause (paxton_race ends with
  `NOT "Bill Paxton"`) or mix with the OR in race_either. The YAML says so in a comment.
- `race_either` is `((talarico_race) OR (paxton_race)) AND language:en` and `race_both` is
  `((talarico_race) AND (paxton_race)) AND language:en`, with the base queries written out in full and
  `language:en` once at the end. Each composition is declared under `compositions:`; the validator rebuilds the
  string from its parts and fails if the stored one differs. So editing `talarico_race` without editing
  `race_either` is an error, not a silent drift.
- `any_either` = `((talarico_any) OR (paxton_any)) AND language:en`, listed under `derived_support`. It is the
  denominator of core_vs_broad. It has to be its own request because the size of a union cannot be computed from
  two counts (stories mentioning both would be counted twice).
- Validator also checks: version, status (`draft | tuned | frozen`, `frozen` needs `frozen_on`), two-letter
  language, collection ids (positive integer or null, at least one set), all four phases with start before end,
  balanced quotes and parentheses, capitalized AND/OR/NOT outside quotes, every name referenced by `derived` and
  `audit.core_queries` exists, and the race id matches the file name.
- Query hash: sha256 of the canonical query string (whitespace runs collapsed, trimmed), full 64 hex characters.
  Config hash: sha256 of the parsed YAML as canonical JSON (sorted keys, dates as ISO strings), so comments and
  layout do not change it and any value does. The per-request hashes used for the cache and `series_query_hash`
  are the existing 16-character request hashes (endpoint plus params), as for every other connector.

### Series
- Per query and configured collection (one count-over-time request over the race window):
  - `news_mediacloud/<query>/<collection>`: daily story count, unit stories.
  - `news_mediacloud/<query>/<collection>/ratio`: Media Cloud's normalized ratio, unit ratio.
  - `news_mediacloud/<query>/<collection>/total_count`: all stories in the collection that day.
  Separate series rather than fields, so each gets its own quality badge (a drop in total_count shows an ingest
  gap) and they fit the existing daily table.
- Derived, per collection, defined in the YAML `derived:` block (the connector hard-codes no query name):
  - `news_mediacloud/talarico_share/<c>` = talarico_race / (talarico_race + paxton_race) (mention share).
  - `news_mediacloud/talarico_exclusive_share/<c>` = only_T / (only_T + only_P), only_T = talarico_race - race_both,
    only_P = paxton_race - race_both.
  - `news_mediacloud/core_vs_broad/<c>` = race_either / any_either.
  A zero denominator gives null with a reason (never 0 or inf); a missing input gives null with a reason; a
  negative only-count (race_both larger than an input) gives null with "inconsistent counts". The reasons are in
  the quality entry (`extra.null_days`) and in `queries.news_mediacloud.mediacloud.derived_nulls`. Values are
  rounded to 6 decimals.
- Context series: ratio, total_count, the derived series and the `any_either` count are shown in the daily table
  and quality checked, but they are not attention series: no lag table, no event metrics, not in the index
  `attention` block. `series.meta` marks them `role: context`. The seven query counts are attention series.
- A collection with a null id gets no request and no series. The run log says "collection texas_local not
  configured ... skipped, not counted as zero", and the queries block has `status: not configured` for it.
- Zero vs missing: a date that comes back with `count: 0` is a 0 row (listed in `extra.explicit_zero_days`); a
  window date absent from the response has no row and is missing. A date that appears twice stops the run.

### Quality gate (section 7)
- Media Cloud series use the existing quality module with near-zero stretches of 2 or more days (section 7 says
  "two or more"; the M0 rule counts single days, and it is unchanged for every other source). One explicit zero
  between normal days is therefore a real zero and does not degrade the series.
- On top of the window check, the analysis phase (Sept 1 to Nov 2) must have at least 95% of its days present, else
  the series is degraded with the reason. The window coverage rule (95% ok, under 70% unusable, a 3-day gap is
  degraded) still applies. Unusable series are kept out of the metrics as before.
- Derived series skip the near-zero check (a small share is a valid value) but get the coverage checks; their null
  days count as missing.

### Race JSON `queries` block
`queries.news_mediacloud` keeps the usual `query_hash`, `queries` (every request with params and hash) and
`series_query_hash`, plus `mediacloud`: path, version, status, frozen_on, config_sha256, language, platform,
api_version, timezone_note, phases, collections (with configured or not), the derived definitions, the exclusions
and changes logs, and per query: the full query string, its sha256, its role (core, series, derived_support) and per
collection the id, name, config version, status and config hash, the request hash and the series names, or
`not configured`.

### Request handling
- Cache: every response under `data/raw/` (git-ignored). Count requests:
  `news_mediacloud/<race>/<window>/<request hash>/count_over_time.json`; audit pages:
  `news_mediacloud_audit/<race>/<phase>/<hash>/page_NNN.json`; collections:
  `news_mediacloud_directory/collections/search/<hash>/page_NNN.json`. Nothing is re-fetched without `--refresh`.
- Pacing: 30 s between Media Cloud requests by default, for every Media Cloud endpoint, because the FAQ does not
  say which ones allow only 2 a minute. A Texas run with one collection is 8 requests, about 3.5 minutes; with
  `texas_local` filled in, 16 requests, about 7.5 minutes. Configurable in `config/project.yaml`
  (`connectors.news_mediacloud.pace_seconds`), with `run --mediacloud-pace` and `mediacloud ... --pace`. Tests
  never sleep: the sleep function is injected (and `tests/conftest.py` replaces the module's sleep for every
  test).
- 401, 403 and 429 raise at once with "Media Cloud returned HTTP <status>: <reason>. Stopping; no retry."
  (`HttpClient(stop_status=...)`; the inner client never retries them, even with retries configured). 5xx keeps the
  bounded retries. The pipeline and the CLI exit 2.
- Each Media Cloud command prints "N HTTP request(s) made, M served from the cache"; the connector logs
  "news_mediacloud: N HTTP request(s) made, M cache hit(s)".

### `.env`
- `<repo root>/.env` is read by the CLI at startup with a stdlib parser (no new dependency; python-dotenv is not in
  the requirements): `NAME=value`, an optional `export`, comments, quoted values. A variable already set in the
  environment is never overridden; empty values are not set. Only the names of loaded variables are printed (to
  stderr), never values. Tests never read the real `.env` (an autouse fixture points the loader elsewhere).
- When a key is missing, the run prints "`<KEY>` is not set: export it in your shell or put it in .env at the repo
  root". The `skipped` reason in the JSON is unchanged, so the other races' output did not change.

### Collections lookup
`python -m raceattn mediacloud collections --state TX` searches the state's name ("Texas") with `--name` as the
alternative, pages of 100 up to `--max-pages` (5), and prints id, source count, platform and name. No platform
filter is sent (the directory's platform values differ from the search platform). Without a key it prints how to
set one (shell or `.env`) and exits 2, so a script notices. Copy the chosen name, id, source count and the lookup
date into the query file.

### Audit
- `python -m raceattn mediacloud audit --race tx-senate-2026 --phase tuning|analysis --n 100 --seed 1`
  (`--max-pages 20`, `--page-size 1000`, `--out`, `--force`, `--refresh`, `--pace`). Phase dates come from the
  query config.
- Core queries: `talarico_race` and `paxton_race` (`audit.core_queries` in the YAML, so it can change without
  code). They are the main series of section 4 and the ones the section 6 coding scheme (race, attorney-general
  office, other) is written for. `race_either` and `race_both` are compositions of those two, so their precision
  follows from them; the any-mention queries and `headline_either` are sensitivity series. Add any of them to the
  list if Alex wants them audited too.
- Sampling: for each core query and configured collection, page through story-list (up to `--max-pages`),
  deduplicate by story id, sort by (publish_date, id), then `random.Random(seed).sample(pool, n)` with a fresh
  generator per query and collection (so revising one query and redrawing does not change the others). This is
  uniform over the retrieved stories. If the page cap is hit, the retrieved stories are only the first pages in
  the API's sort order (unverified, probably by date), so the sample is not uniform over all matches; the summary
  and the log say when that happened. If fewer than n stories exist, all are written.
- Output: `data/local/mediacloud/audit/<race>/<phase>.csv` (git-ignored) with exactly `query, collection,
  story_id, publish_date, source, title, url, relevant, category, coder, notes`, the last four empty; plus
  `<phase>.summary.json` (pages, retrieved, sampled, cap hit, syndication, config hash). Only metadata: story text
  is never requested or stored. The command refuses to overwrite a CSV that already has coding unless `--force`.
- Syndication (section 5): a story counts as syndicated when its normalized title (lower case, accents and
  punctuation removed) appears on two or more domains. Reported per query and collection two ways: inside the
  sample, and each sampled story against every retrieved story (more copies are visible there, so that is the
  better estimate). Nothing is deduplicated. No 48-hour window is applied (the phases are short).
- `mediacloud precision <csv>`: per query and collection, precision = yes / (yes + no). `unclear` and blank rows
  are left out of the denominator and counted; any other value is counted as invalid. Wilson 95% interval (no
  continuity correction). `--target` (0.90) flags rows below it.
- `mediacloud agreement <csv_a> <csv_b>`: joins on (query, collection, story_id), reports stories only in one file,
  and for `relevant` and `category` gives simple agreement and Krippendorff's alpha (nominal) over the stories
  both coders filled in (values trimmed and lower-cased; `unclear` is a code like any other). Prints a warning
  under 0.70.
- Tests check alpha against Krippendorff (2011) "Computing Krippendorff's Alpha-Reliability": the nominal example
  with four observers and missing data (0.743) and the binary two-observer example (0.095); Wilson against
  Newcombe (1998) Table I (81/263, 15/148, 0/20, 1/29).

## Defaults chosen

- Texas collection: `texas_local` is `{name: null, id: null}` until the live lookup; no request, no series.
- National collection: id 34412234 as in the client's tests, name "United States - National", both unconfirmed.
- Pacing: 30 s between Media Cloud requests, every endpoint.
- Audit: seed 1, n from the config (100), core queries talarico_race and paxton_race, 20 pages of 1000.
- `mediacloud collections` and `mediacloud audit` without a key: message and exit 2. `run` without a key: the
  connector is skipped with the reason and the run exits 0.
- Hashes: full sha256 for query and config hashes.

## Five-race comparison and the Texas acceptance run

Run on 2026-11-11 with `MEDIACLOUD_API_KEY` unset and no `.env`, from the existing cache (every connector reported
0 fetched; no network was needed):

    for r in tx-senate-2026 oh-senate-2026 nc-senate-2026 fl-senate-2026 ky-senate-2026 tx-governor-2026; do
      .venv/bin/python -m raceattn run --race $r --out-dir /tmp/mc1_after; done

Every run exited 0. For Texas the log says:

    == news_mediacloud: skipped (missing key: set MEDIACLOUD_API_KEY (see .env.example))
       MEDIACLOUD_API_KEY is not set: export it in your shell or put it in .env at the repo root (git-ignored, loaded at startup, never printed)

Kalshi, Kalshi trades, Wikipedia and Bluesky ran as before. Compared with the committed `data/processed/*.json`,
each of the six files differs in exactly one line, `generated_at`; everything else is byte-identical (the same
held for the same runs at HEAD before the change). `index.json` differs only in the six per-race `generated_at` values and `updated_at`.
No regenerated JSON was committed. `data/processed/tx-senate-2026.json` has no Media Cloud series.

## Unverified (needs the key)

The list in docs/sources/mediacloud.md, in short: the national collection's name and source count; whether a Texas
state-and-local collection exists and its id; the `article_title:` grammar; whether `language:en` works in `q`;
whether count-over-time gives `ratio` and `total_count` and returns zero days explicitly; per-source counts and top
sources (breadth, not built); the publish-date timezone; the API version; the live shapes and params of
count-over-time, story-list (page size, token, sort order) and sources/collections; which endpoints are limited to
2 a minute; whether wire copy is collapsed.

## Not done

- The dashboard (`web/`) was not changed. Once Texas has Media Cloud data its race JSON will have 7 count series
  plus context series under three-part names; the dashboard's labels and grouping for `news_mediacloud/story_count`
  will need a look then.
- Breadth (distinct sources per day) and top sources: not built until the API is known to offer them.
- Recall checks (known items from the Wikipedia page) and the top-days review (section 6, items 4 and 5): not
  built.
- The reliability-sample size calculation (section 6, item 3) is a decision for Alex; the agreement command takes
  whatever subsample is coded.
