# Source: Media Cloud (news_mediacloud)

First checked 2026-11-11 (docs, client source and an unauthenticated probe). Updated for MC1 on 2026-11-11. Checked
against the live API with a key on 2026-11-12 (API version 3.2.3); the findings are below under Verified. The search
criteria are in docs/mediacloud-search-criteria.md; the implementation notes are in docs/mc1-notes.md.

## Endpoints and auth
- Key from `MEDIACLOUD_API_KEY` (shell or `.env` at the repo root), sent as `Authorization: Token <key>` (as in the
  official `mediacloud` python client, https://github.com/mediacloud/api-client, `mediacloud/api.py`). The client
  is not a dependency; requests go through `raceattn/http.py`.
- `GET https://search.mediacloud.org/api/search/count-over-time`: `q`, `start`, `end` (ISO dates, start and end
  both inclusive), `platform=onlinenews-mediacloud`, `cs` (collection ids). Returns
  `{"count_over_time": {"counts": [...], "total": N, "normalized_total": M}}`; each count has `date` (`YYYY-MM-DD`),
  `count`, `total_count` and `ratio` (= count / total_count). One request per query and collection over the race
  window.
- `GET https://search.mediacloud.org/api/search/story-list`: the same params plus `page_size` and
  `pagination_token`; returns `stories[]` and `pagination_token` (null on the last page). `page_size=1000` is
  accepted. Story fields: `id`, `indexed_date` (UTC, `+00:00`), `language`, `media_name`, `media_url`,
  `publish_date` (a date only), `title`, `url`. Used only by `mediacloud audit`. `expanded` (story text) is never
  requested.
- `GET https://search.mediacloud.org/api/sources/collections/`: `name`, `limit`, `offset` (no platform filter; the
  directory's platform values differ from the search platform); returns
  `count`, `next`, `results[]` with `id`, `name`, `source_count`. Used only by `mediacloud collections`.
- `GET https://search.mediacloud.org/api/sources/collections/<id>/`: one collection record (`name`, `platform`,
  `source_count`, `public`, `featured`). Used once by hand to confirm 34412234.
- `GET https://search.mediacloud.org/api/search/api-params`: returns
  `{"params": {"api-python-client": "5.1.0", "query-rate": "2/m"}}`, so search endpoints allow 2 requests a minute.
- `/api/version` is open without a key (200, checked in M2). On 2026-11-12: version 3.2.3, GIT_REV
  cf92de2e2dbee502990ea9c22c0fb680ee0f77ed.
- `GET https://search.mediacloud.org/api/search/count-by-source-over-interval`: the count-over-time params plus
  `interval=day`. Returns `{"source-interval-attention": [...]}`, one row per source per day including zeros, with
  `media_name`, `interval`, `bucket` (date), `matching_stories`, `total_stories`, `ratio`. For talarico_race
  national, Aug 1 to 24: 249 sources x 24 days = 5976 rows; the per-day sum of `matching_stories` equals the
  count-over-time count. One request per per-source query and collection over the race window (breadth).
- `GET https://search.mediacloud.org/api/search/sources`: `q`, `start`, `end`, `platform`, `cs` (no interval).
  Returns `{"sources": [{"source": "townhall.com", "count": 42}, ...]}`, largest count first, at most 100 sources
  (`TOP_SOURCES_CAP` in raceattn/mediacloud.py). 67 sources for talarico_race national, Aug 1 to 24; exactly 100
  for every Texas query and collection over the analysis phase. One request per per-source query and collection
  over the analysis phase (top sources).

## Two connector paths
- With `config/queries/<race_id>.mediacloud.yaml` (Texas Senate only, for now): the query config path. Series
  `news_mediacloud/<query>/<collection>` (daily count), `.../ratio`, `.../total_count`, `.../breadth` (for the
  per-source queries), and the derived shares and ratios `news_mediacloud/<derived>/<collection>`. See
  docs/mc1-notes.md.

## Breadth and top sources
- Which queries: `per_source_queries` in the query config. Without that key the default is talarico_race,
  paxton_race and race_either (`DEFAULT_PER_SOURCE` in raceattn/mcqueries.py). The Texas file does not set the
  key, so it uses the default (setting it would change the config hash).
- Breadth, `news_mediacloud/<query>/<collection>/breadth`: the number of distinct sources (`media_name`) with
  `matching_stories` > 0 that day, from one count-by-source-over-interval request over the race window (the same
  dates as the count series). A day in the response where no source matches is an explicit 0. A day the response
  leaves out is missing (null), the same zero and missing rule as the counts. A syndicated story that runs on
  several domains counts once for each domain, so breadth is partly a count of reprint sites (heavy in
  texas_local, see the duplicate rate below). Breadth is a context series: in the daily table and quality checked
  with the same gate as the counts (95% of analysis days present, near-zero stretches of 2 or more days), not
  attention in the lag and event metrics. The quality block also lists any day where the per-day sum of
  `matching_stories` differs from the count-over-time count (`days_where_source_sum_differs_from_count`).
- Top sources: one search/sources request over the analysis phase (`phases.analysis`), stored at
  `queries.news_mediacloud.mediacloud.top_sources.<query>.<collection>` =
  `{query, collection, start, end, sources: [{source, count}]}`, the full list returned, largest count first (ties
  by name). Only the source domain and its story count are kept: no story text, titles or URLs.
- The cap: when the list has 100 sources (`TOP_SOURCES_CAP`), the entry also gets `capped: true`, `cap`,
  `covered_stories` (the sum of the listed counts), `total_stories` (the sum of the daily count series
  `news_mediacloud/<query>/<collection>` over the same dates), `missing_count_days` (days of the window with no
  count, left out of the total) and a short `note`. Chart 5 shows the note in its subtitle. A capped list is the
  largest 100 sources, not every source.
- The endpoints used are recorded in `queries.news_mediacloud.mediacloud.endpoints` (`count`, `breadth`,
  `top_sources`), every rendered request with its endpoint and hash is in `queries.news_mediacloud.queries`, and
  each query and collection entry carries `breadth_request_hash` and `top_sources_request_hash`.
- Without that file (the other five races): the M2 path, unchanged: one request for the race config's
  `news_query` over the US national collection, series `news_mediacloud/story_count`.

## Fields used
- `count_over_time.counts[]`: `date` (first 10 characters), `count`, `total_count`, `ratio`. A date with
  `count: 0` is a zero; a date that is absent is missing. A date that appears twice stops the run. The live API
  returns zero days explicitly, so a missing date means something went wrong.
- Days are the `publish_date` as Media Cloud extracted it (usually the publisher's local date), not UTC days.
- `stories[]`: `id`, `publish_date`, `media_name` (else the URL's domain), `title`, `url`. Nothing else is written.
- `source-interval-attention[]`: `media_name`, `bucket` (first 10 characters), `matching_stories`. Only the count
  of matching sources per day is written, plus the per-day sum for the check above.
- `sources[]`: `source`, `count`. Nothing else is written.

## Request handling
- Every response is cached under `data/raw/news_mediacloud*/` (git-ignored) and reused unless `--refresh`.
- Requests are paced: 30 s between Media Cloud requests by default (`connectors.news_mediacloud.pace_seconds` in
  config/project.yaml, `run --mediacloud-pace`, `mediacloud ... --pace`). Cache hits are not paced. `search/api-params`
  gives a query rate of 2/m, so 30 s is the right pace for search endpoints. The pace applies to every Media Cloud
  endpoint because only the search value is known. Responses carry no rate-limit headers.
- HTTP 401, 403 and 429 stop at once with a message naming the status. No retry. 5xx responses get the usual
  bounded retries from `raceattn/http.py`.
- Each command prints how many HTTP requests it made and how many responses came from the cache.

## Limits
- FAQ (https://www.mediacloud.org/documentation/faqs): "The default quota is 4000 API requests per week" and
  "Certain API endpoints are rate-limited to 2 requests per minute". The Texas config makes 28 requests per run:
  16 count requests (7 queries plus the `any_either` support query, times two configured collections) and 12
  per-source requests (3 per-source queries x 2 collections x 2 endpoints). That is about 14 minutes at 30 s. A
  rerun is served from the cache (0 requests) unless `--refresh`. With the 4,000-a-week quota, that is about 140
  uncached runs a week, less any audits. An audit is up to `--max-pages` (default 20) story-list pages per core
  query and collection.

## Terms
- https://www.mediacloud.org/legal/media-cloud-terms-of-use: "'Platform Outputs' include aggregated data and/or
  analyses produced by the Platform ... You may use, reproduce, distribute, and/or display any Platform Outputs".
  Attribution recommended, not required. Not designed for commercial use. Story text is not released.
- Storing and publishing daily counts looks allowed. Still listed in docs/licensing.md for Alex to confirm. Audit
  samples (titles and URLs) stay in git-ignored `data/local/` and are never published.

## Verified
Offline (tests/test_mediacloud.py, tests/test_dotenv.py, fake HTTP with synthetic responses):
- The query file loads and validates; every query string, the compositions and the hashes are checked by tests.
- Request params, the Authorization header, caching, `--refresh`, pacing, the 401/403/429 stop, zero vs missing
  dates, the derived math, the audit CSV, precision, agreement and the `.env` key handling.
- Breadth and top sources: parsing count-by-source-over-interval (zero rows, a missing day, several sources on one
  day, a source with 0 matching), the breadth series and its quality gate, the search/sources parse and sort, the
  12 extra requests and cache hits on rerun, the stop on 401/403/429 for both endpoints, and that no story field
  reaches the output.

Live, 2026-11-12 (raw responses in git-ignored data/raw/mc3_probe/):
- API version 3.2.3. Search query rate 2/m (`search/api-params`); no rate-limit headers.
- Collection 34412234 is "United States - National": platform online_news, 246 sources, public, featured.
- `mediacloud collections --state TX` found one Texas collection: 38381323, "Texas, United States - State & Local",
  593 sources, platform online_news. Both are now in the query config.
- `article_title:` works as drafted. `article_title:Talarico AND language:en` gave 115 stories against 458 without
  the field (national, Aug 1 to 24), and all 115 titles contain "Talarico". `article_title:(Talarico OR Paxton)`
  and `(article_title:Talarico OR article_title:Paxton)` both gave 163, so the grouped form applies the field to
  every term. headline_either gave 155 stories, all with Talarico or Paxton in the title.
- `language:en` inside `q` is accepted and filters: talarico_race national Aug 1 to 24 gave 436 with it, 436
  without it and 0 with `language:fr`.
- No query syntax changes are needed; the seven queries and `any_either` stay as drafted.
- `count-over-time` returns `ratio` and `total_count` for every day; start and end are inclusive (Aug 1 to 24 gave
  24 dates); days with zero matches are returned explicitly with count 0 (a query matching nothing in the Texas
  collection gave 24 dates, all 0).
- `story-list` with `page_size=1000` returned all 436 talarico_race national stories (Aug 1 to 24) in one page with
  `pagination_token` null; the story count equals the count-over-time total.
- `publish_date` is a date only, with no time and no timezone. Media Cloud's Story Guide
  (https://www.mediacloud.org/documentation/story-guide) says publish date "does not include time because few
  published articles do, and it is impossible to accurately determine the timezone indicated at scale". Days are
  the extracted publish date, not UTC days. `indexed_date` is UTC but is ingest time, not publish time.
- Per-source daily counts (`count-by-source-over-interval`) and top sources (`search/sources`) exist and are built.
  The live pull with them is below ("Breadth and top sources, live").

## Unverified
- The `story-list` default sort order and pagination beyond one page (never needed so far; it matters when the
  audit page cap is hit).
- Whether every endpoint is limited to 2 requests a minute (only the `search/api-params` value is known).
- How accurate Media Cloud's `publish_date` extraction is.

## Breadth and top sources, live 2026-11-12
`python -m raceattn run --race tx-senate-2026`: 12 per-source requests (the 16 counts came from the cache), no 401,
403 or 429. The rebuild from the cache after that made 0 Media Cloud requests (28 cache hits).

- `search/sources` caps at 100 sources: it returned exactly 100, largest count first, for every query and
  collection over the analysis phase (Sept 1 to Nov 2). MC3 saw 67 over the tuning window, under the cap. The
  listed 100 cover most stories:

| Query | national: covered / total | texas_local: covered / total |
|---|---|---|
| talarico_race | 4032 / 4045 (99.7%) | 3142 / 3222 (97.5%) |
| paxton_race | 3768 / 3782 (99.6%) | 3199 / 3290 (97.2%) |
| race_either | 4904 / 4928 (99.5%) | 3764 / 3875 (97.1%) |

- Breadth: all six series (3 queries x 2 collections) have 63/63 analysis days, quality ok, and the per-day sum of
  `matching_stories` equals the count-over-time count on every day of the window (65 days). Mean distinct sources
  per day over the analysis phase: race_either national 37.0 (12 to 71, largest on Sept 10), texas_local 31.0 (6
  to 63, largest on Oct 28); talarico_race 33.6 and 27.7; paxton_race 31.3 and 28.3.

## Live run 2026-11-12
Texas Senate, both collections. Details and what is still open: docs/mc3-notes.md.

| Item | Result |
|---|---|
| Requests | 54 for MC3: 1 key check, 1 collections lookup, 16 probes (syntax and endpoints), 16 tuning-window counts, 4 tuning audit story-list pages, 16 analysis-and-election counts. The full-source rebuild after that: 16 cache hits, 0 requests. No 401, 403 or 429 |
| Series | 16 count series (8 queries x 2 collections) plus ratio, total_count and derived series, Sept 1 to Nov 4 |
| Coverage | Every count series 65/65 days, quality ok; analysis phase 63/63 days; no missing days, no near-zero stretches |
| Explicit zero days | One: headline_either / texas_local on 2026-10-04 |
| Undefined derived day | talarico_exclusive_share / texas_local on 2026-09-20 (zero denominator, null with a reason) |
| race_either, analysis / election totals | national 4928 / 974; texas_local 3875 / 893 |
| Largest race_either national days | Nov 4 (675), Nov 3 (299), Sept 10 (203) |
| Collection size (total_count per day) | national 5,532 to 13,151; texas_local 1,480 to 8,721, lowest on weekends (Oct 3, 4, 11, 18, 25) |
| Tuning audit | 4 cells, one story-list page each, every match retrieved, 100 drawn per cell (seed 1), 400 rows; retrieved equals the count-over-time total in every cell |
| Duplicate rate (same normalized title on 2+ domains), in sample / against retrieved | talarico_race national 6% / 8%, texas_local 28% / 43%; paxton_race national 7% / 14%, texas_local 24% / 41%; overall 90/400 in sample (22.5%) |
| Syndication | Heavy in the Texas collection; Media Cloud does not collapse it |
| Query status | Draft, not frozen; precision not coded yet |

Nov 4 being larger than Nov 3 fits publish dates being local dates with no timezone.
