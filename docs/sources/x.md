# Source: X (Twitter) post counts

Checked 2026-11-11 (docs read; no X token was available, so nothing was called live).

## Endpoint and auth
- `GET https://api.x.com/2/tweets/counts/all` (full archive), params `query`, `start_time`, `end_time`,
  `granularity=hour`, `next_token` for paging. Fallback `GET https://api.x.com/2/tweets/counts/recent` (last 7
  days only; `start_time` must be within the last 7 days).
- Auth: the user's own app bearer token from `X_BEARER_TOKEN`. It is read from the environment when the request is
  made and sent in an `Authorization` header built inside the process. It never goes into argv, the URL, logs,
  exceptions (HttpClient redacts it), cache records or output JSON. The cache record holds only the endpoint and
  the params without the token.
- Sources: https://docs.x.com/x-api/posts/counts/introduction, https://docs.x.com/x-api/posts/get-count-of-all-posts,
  https://docs.x.com/x-api/posts/get-count-of-recent-posts.

## Query
- Rendered in one place, `raceattn/connectors/x.py:render_query`: every entity name and alias as a quoted phrase,
  OR-joined, plus `lang:en -is:retweet`. Texas:
  `("James Talarico" OR "Talarico" OR "Ken Paxton" OR "Paxton") lang:en -is:retweet`.
- The query string is logged under `queries.x.query` in the processed JSON.
- Docs: counts use the same operators as search; `lang:` and `is:retweet` need a conjunction (they cannot stand
  alone), `OR` and quoted phrases are supported. Query length limit 1,024 characters for counts/all on self-serve
  plans, 512 for recent.

## Limits, paging and price
- Hour granularity returns up to 744 buckets (31 days) per page, so a 65-day window is 3 requests.
- Rate limit: 300 requests per 15 minutes per app for both counts endpoints.
- Pricing page (https://docs.x.com/x-api/getting-started/pricing), as read on 2026-11-11: "Counts: Recent $0.005
  per request", "Counts: All $0.010 per request", "Posts: Read $0.005 per resource", pay-per-use capped at 3
  million post reads per month. The counts introduction page lists counts/all as "Pay-per-use, Enterprise".
- UNVERIFIED: the prices were read through a summarizing fetch and have not been checked against a bill; whether
  counts/all actually works on a given pay-per-use account. The connector tries counts/all first and does not
  assume either way.

## Behavior
- Cost guard: `estimate_cost` = pages needed (hours / 744, rounded up) minus pages already cached, times $0.010.
  The pipeline prints it before any request and refuses without `--yes` or `--max-spend`. A fully cached pull
  estimates $0 and runs without the flag. A cached paid read is never re-pulled, even with `--refresh`.
- If counts/all is refused (any of 400, 401, 402, 403, 404, 429), the exact error body is printed (X's problem JSON:
  `title`, `detail`, `type`, sometimes `reason`; it contains no token). 401 stops (bad token). Otherwise the
  connector falls back to counts/recent and marks `x/post_count` `degraded` with the reason. If the window has no
  overlap with the last 7 days (Texas, which ended 2026-11-04), the series is empty and `unusable`.
- The refusal itself is not cached, so a run after access is granted tries counts/all again.
- Response field: the guide example uses `data[].tweet_count`, the API reference `post_count`; both are read.
- Series `x/post_count`, hourly, bucket start in UTC.

## Terms (see docs/licensing.md)
- Developer Policy (https://docs.x.com/developer-terms/policy) restricts redistribution of X Content and, under
  benchmarking, says not to "Calculate aggregate X Post metrics, such as the total number of Posts posted per day".
  Publishing hourly counts is an open question. The publish step warns until Alex confirms.
- Post text, user names and ids are never requested (counts endpoints return none).

## Fixtures
- `tests/fixtures/x/*.json` are synthetic from docs (no token here).
