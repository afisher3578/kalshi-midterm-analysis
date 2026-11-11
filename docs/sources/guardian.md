# Source: Guardian Open Platform (news_guardian)

Checked 2026-11-11 (docs and an unauthenticated probe; no key here).

## Endpoint and auth
- `GET https://content.guardianapis.com/search` with `q`, `from-date`, `to-date` (YYYY-MM-DD, inclusive),
  `use-date=published`, `page-size=1`, `api-key`.
- One request per UTC day; the count is `response.total`. One outlet only.
- Key from `GUARDIAN_API_KEY`. It is a query param, so it is added at send time only (`secret_params`): it is not in
  the logged params, the query hash, the cache key or the cache record, and HttpClient redacts it from errors.
- Docs: https://open-platform.theguardian.com/documentation/search (the page loads
  `/documentation/md/content_search.md`).

## Limits
- Developer key (https://open-platform.theguardian.com/access/): "Up to 1 call per second, Up to 500 calls per day",
  free for non-commercial use. The connector spaces calls 1.1 s apart; a 65-day window is 65 calls.

## Terms
- https://www.theguardian.com/open-platform/terms-and-conditions: OP Content covers "Guardian, Observer and third
  party content and data"; clause 5 says OP Content must not be kept longer than 24 hours; republished content or
  tools based on it must show "Powered by The Guardian"; end users get personal non-commercial use.
- Open question: whether a stored daily `total` is "OP Content". If it is, the 24-hour rule would forbid committing
  the counts. Listed in docs/licensing.md. The publish step warns.

## Probe
- No key: HTTP 401 `{"message": "No API key found in request"}`. `api-key=test` (the old demo key): HTTP 401
  `{"message": "Unauthorized"}`. The demo key no longer works.

## Unverified
- Live response shape (from the docs sample); the time zone used by `from-date`/`to-date` (assumed UTC days).
  Fixture `tests/fixtures/news/guardian_day.json` is synthetic from docs.
