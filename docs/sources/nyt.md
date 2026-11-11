# Source: New York Times Article Search (news_nyt)

Checked 2026-11-11 (OpenAPI spec, FAQ, terms and an unauthenticated probe; no key here).

## Endpoint and auth
- `GET https://api.nytimes.com/svc/search/v2/articlesearch.json` with `q`, `begin_date`, `end_date` (YYYYMMDD),
  `api-key`. One request per UTC day.
- Key from `NYT_API_KEY`, a query param handled like the Guardian key (sent only, never logged, hashed or cached;
  redacted from errors).
- Count: `response.meta.hits` per the published OpenAPI spec. Some third-party notes mention `response.metadata.hits`
  after an April 2025 update; the connector accepts both. The spec says hits shows 10,000 when there are 10,000 or more.
- Series `news_nyt/article_count`, daily. One outlet only.

## Limits
- FAQ: "500 requests per day and 5 requests per minute. You should sleep 12 seconds between calls." The connector
  uses its own client with 12 s between calls (`sleep_seconds` in config/project.yaml). 65 days is about 13 minutes.

## Terms
- https://developer.nytimes.com/terms: no commercial use, including "providing archived or cached data sets
  containing Content"; attribution per https://developer.nytimes.com/branding. No explicit rule on publishing hit
  counts. Listed in docs/licensing.md.

## Probe
- No key: HTTP 401 `{"fault":{"faultstring":"Failed to resolve API Key variable request.queryparam.api-key", ...}}`.

## Unverified
- Which field the live API returns (`meta` or `metadata`); whether boolean `q` syntax like the Texas `news_query`
  behaves as on the Guardian. Fixture `tests/fixtures/news/nyt_day.json` is synthetic from docs.
