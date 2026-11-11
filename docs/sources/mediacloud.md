# Source: Media Cloud (news_mediacloud)

Checked 2026-11-11 (docs, client source and an unauthenticated probe; no key here, so no live counts).

## Endpoint and auth
- `GET https://search.mediacloud.org/api/search/count-over-time` with `q`, `start`, `end` (ISO dates, end
  inclusive), `platform=onlinenews-mediacloud`, `cs` (collection ids, comma-joined).
- Key from `MEDIACLOUD_API_KEY`, sent as `Authorization: Token <key>` (as in the official `mediacloud` python client,
  https://github.com/mediacloud/api-client, `mediacloud/api.py`). Called with stdlib-style `requests`; the client
  is not a dependency.
- Collection: United States - National, id 34412234 (the client README and tests use this id; the collection record
  itself needs a key, so its name was not read live).

## Fields used
- `count_over_time.counts[]`: `date` (first 10 characters), `count`. `total_count` and `ratio` exist but are not
  stored yet. One request per race window.
- Series `news_mediacloud/story_count`, daily. Query from the race config `news_query` (logged in the output).

## Limits
- FAQ (https://www.mediacloud.org/documentation/faqs): "The default quota is 4000 API requests per week" and
  "Certain API endpoints are rate-limited to 2 requests per minute". We make one request per race.

## Terms
- https://www.mediacloud.org/legal/media-cloud-terms-of-use: "'Platform Outputs' include aggregated data and/or
  analyses produced by the Platform ... You may use, reproduce, distribute, and/or display any Platform Outputs".
  Attribution recommended, not required. Not designed for commercial use. Story text is not released.
- So storing and publishing daily counts looks allowed. Still listed in docs/licensing.md for Alex to confirm.

## Probe
- Without a key: HTTP 401, `www-authenticate: Token`, `{"detail":"Authentication credentials were not provided."}`.
  `/api/version` is open (200).

## Unverified
- The live response shape (built from the client's types and tests); the exact US national collection name; whether
  `count-over-time` is one of the 2-per-minute endpoints. Fixture `tests/fixtures/news/mediacloud_count_over_time.json`
  is synthetic from docs.
