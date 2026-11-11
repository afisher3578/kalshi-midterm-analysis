# Source: Bluesky search

Checked live 2026-11-11, unauthenticated only (no app password here).

## What was observed live (2026-11-11)
- `GET https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=Talarico&limit=5` returned **HTTP 403**
  (an HTML "403 Forbidden" page).
- `GET https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=Talarico&limit=5` returned **HTTP 200** with posts,
  no login.
- With `sort=latest&lang=en&since=2026-10-01T00:00:00Z&until=2026-10-02T00:00:00Z&limit=100` on api.bsky.app:
  200, 94 posts (not 100), a `cursor` and `hitsTotal` 1027.
- Passing that `cursor` back unauthenticated returned **HTTP 403** ("Request forbidden by administrative rules",
  server openresty). So unauthenticated cursor pagination does not work, as one of the reports said.
- Moving `until` to the oldest `createdAt` on the page worked (200, next 96 posts). `until` is inclusive: the
  boundary post came back once (overlap of 1), so dedupe on `uri` is needed.
- `limit=101` returned 400; 100 is the maximum.
- `OR` is not supported: `Talarico` 1130 hits, `Paxton` 1999, `Talarico OR Paxton` 24, `"James Talarico" OR
  "Ken Paxton"` 1. Quoted phrases work alone (`"Ken Paxton"` 1059). So each term is searched separately and posts
  are deduped on uri across terms.
- `since`/`until` filtered as expected back to 2026-09-01. `createdAt` and `indexedAt` mostly agree; a few posts
  were indexed hours after `createdAt`.
- Volume for Texas: 1,100 to 6,400 distinct posts a day for the two terms in early September (from the full run).
  Requests took 0.2 to 0.6 s plus our 0.3 s spacing; the full Texas window took 22 minutes. Throughput matched our spacing, so no 429
  backoff slowed it (responses were not logged one by one).
- robots.txt on api.bsky.app: "Crawling the public parts of the API is allowed. HTTP 429 ("backoff") status codes
  are used for rate-limiting. Up to a handful concurrent requests should be ok." We send one at a time.

## Endpoint, auth and modes
- Unauthenticated (default): `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts`, params `q`, `sort=latest`,
  `since`, `until`, `lang=en`, `limit=100`. Paging by the `until` walk.
- Authenticated: if `BSKY_HANDLE` and `BSKY_APP_PASSWORD` are set, `POST https://bsky.social/xrpc/com.atproto.server.createSession`
  gives an access token kept in memory only; searches go to `https://bsky.social/xrpc/app.bsky.feed.searchPosts`
  with `Authorization: Bearer <token>` and use `cursor` paging. If a cursor request returns 403 the connector drops
  to the `until` walk for that term and day and notes it.
- UNVERIFIED: authenticated search and cursor paging (no app password here). Built from the AT Protocol docs shape
  and tested only with fakes.

## Counting
- Query terms are rendered in one place, `raceattn/connectors/bluesky.py:search_terms`: each entity's aliases, or
  its name if it has none; multi-word terms are quoted. Texas: `Talarico`, `Paxton`.
- One walk per term per UTC day. A post is placed by the earlier of `record.createdAt` and `indexedAt` (close to the
  index's sort time), and counted once per day across terms (dedupe on uri in memory).
- Cap: `max_pages_per_day` (default 50 per term and day) and `max_pages` (default 6000 per run), both in
  `config/project.yaml`. A capped day is a lower bound and the series becomes `degraded` with the list of capped
  days. Days skipped because the run budget ran out stay missing (not zero).
- Series `bluesky/post_count`, hourly.
- Storage: the raw cache keeps one record per day with hourly counts, pages, capped terms and the first page's
  `hitsTotal` per term. No text, handles, dids or uris are written anywhere. The processed output has counts only.

## Terms
- Bluesky's developer guidelines and API docs pages (docs.bsky.app) now redirect to bsky.network pages that render
  only with JavaScript, so they could not be read in this session: UNVERIFIED. The Bluesky terms of service
  (https://bsky.social/about/support/tos) were fetched but say nothing specific about API research use or
  publishing counts.
- Open question (docs/licensing.md): whether publishing aggregate hourly counts is fine, and whether deleted posts
  must be removed from stored counts. We store no post content, which keeps this small.

## Fixture
- `tests/fixtures/bluesky/tx-bsky-1day.json`: recorded live 2026-11-11 (2026-10-01, 4 pages per term), reduced to
  hashed uris and timestamps by `scripts/record_bluesky_fixture.py`.
