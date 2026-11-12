# Source: Media Cloud (news_mediacloud)

First checked 2026-11-11 (docs, client source and an unauthenticated probe). Updated for MC1 on 2026-11-11. There
is still no key on this machine, so nothing below has been checked against live counts. The search criteria are in
docs/mediacloud-search-criteria.md; the implementation notes are in docs/mc1-notes.md.

## Endpoints and auth
- Key from `MEDIACLOUD_API_KEY` (shell or `.env` at the repo root), sent as `Authorization: Token <key>` (as in the
  official `mediacloud` python client, https://github.com/mediacloud/api-client, `mediacloud/api.py`). The client
  is not a dependency; requests go through `raceattn/http.py`.
- `GET https://search.mediacloud.org/api/search/count-over-time`: `q`, `start`, `end` (ISO dates, end inclusive),
  `platform=onlinenews-mediacloud`, `cs` (collection ids). One request per query and collection over the race
  window.
- `GET https://search.mediacloud.org/api/search/story-list`: the same params plus `page_size` and
  `pagination_token`; returns `stories[]` and `pagination_token`. Used only by `mediacloud audit`. `expanded` (story
  text) is never requested.
- `GET https://search.mediacloud.org/api/sources/collections/`: `name`, `limit`, `offset` (no platform filter; the
  directory's platform values differ from the search platform); returns
  `count`, `next`, `results[]` with `id`, `name`, `source_count`. Used only by `mediacloud collections`.
- `/api/version` is open without a key (200, checked in M2).

## Two connector paths
- With `config/queries/<race_id>.mediacloud.yaml` (Texas Senate only, for now): the query config path. Series
  `news_mediacloud/<query>/<collection>` (daily count), `.../ratio`, `.../total_count`, and the derived shares and
  ratios `news_mediacloud/<derived>/<collection>`. See docs/mc1-notes.md.
- Without that file (the other five races): the M2 path, unchanged: one request for the race config's
  `news_query` over the US national collection, series `news_mediacloud/story_count`.

## Fields used
- `count_over_time.counts[]`: `date` (first 10 characters), `count`, `total_count`, `ratio`. A date with
  `count: 0` is a zero; a date that is absent is missing. A date that appears twice stops the run.
- `stories[]`: `id`, `publish_date`, `media_name` (else the URL's domain), `title`, `url`. Nothing else is written.

## Request handling
- Every response is cached under `data/raw/news_mediacloud*/` (git-ignored) and reused unless `--refresh`.
- Requests are paced: 30 s between Media Cloud requests by default (`connectors.news_mediacloud.pace_seconds` in
  config/project.yaml, `run --mediacloud-pace`, `mediacloud ... --pace`). Cache hits are not paced. The pace applies
  to every Media Cloud endpoint because the FAQ does not say which ones are limited to 2 a minute.
- HTTP 401, 403 and 429 stop at once with a message naming the status. No retry. 5xx responses get the usual
  bounded retries from `raceattn/http.py`.
- Each command prints how many HTTP requests it made and how many responses came from the cache.

## Limits
- FAQ (https://www.mediacloud.org/documentation/faqs): "The default quota is 4000 API requests per week" and
  "Certain API endpoints are rate-limited to 2 requests per minute". The Texas config makes 8 count requests per
  run (7 queries plus the `any_either` support query, one configured collection), 16 once the Texas collection id
  is filled in. An audit is up to `--max-pages` (default 20) story-list pages per core query and collection.

## Terms
- https://www.mediacloud.org/legal/media-cloud-terms-of-use: "'Platform Outputs' include aggregated data and/or
  analyses produced by the Platform ... You may use, reproduce, distribute, and/or display any Platform Outputs".
  Attribution recommended, not required. Not designed for commercial use. Story text is not released.
- Storing and publishing daily counts looks allowed. Still listed in docs/licensing.md for Alex to confirm. Audit
  samples (titles and URLs) stay in git-ignored `data/local/` and are never published.

## Verified (offline only)
- The query file loads and validates; every query string, the compositions and the hashes are checked by tests.
- Request params, the Authorization header, caching, `--refresh`, pacing, the 401/403/429 stop, zero vs missing
  dates, the derived math, the audit CSV, precision, agreement and the `.env` key handling, all against fake HTTP
  with synthetic responses (tests/test_mediacloud.py, tests/test_dotenv.py).
- None of this proves the live API behaves the same way.

## Unverified (needs the key)
- That collection 34412234 is "United States - National", and its source count.
- Whether a Texas state-and-local collection exists, its name, id and source count (`texas_local` is null until
  `python -m raceattn mediacloud collections --state TX` runs with a key).
- The grammar of `article_title:` searches (headline_either), and whether `language:en` is accepted inside `q`.
- Whether `count-over-time` returns `ratio` and `total_count` for every day, and whether it returns days with zero
  matches explicitly or leaves them out.
- Whether per-source daily counts exist (breadth, spec section 5) and whether top sources are available. Neither is
  built.
- The timezone of `publish_date` (`timezone_note: unverified` in the config).
- The API version (`api_version: null`).
- The live response shapes of all three endpoints; the `story-list` params `page_size` and `pagination_token`, the
  maximum page size (1000 is requested) and the default sort order (it matters when the page cap is hit); the
  `sources/collections/` params `name`, `limit` and `offset`, and its platform values.
- Which endpoints are limited to 2 requests a minute.
- Whether Media Cloud collapses syndicated wire copy (the audit reports a duplicate rate instead of assuming).
