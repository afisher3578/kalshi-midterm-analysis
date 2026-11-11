# Source: Wikipedia pageviews (Wikimedia Analytics API)

Checked 2026-11-11.

## What we call
- `GET https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/{title}/daily/{YYYYMMDD}/{YYYYMMDD}`
- One request per page in `wikipedia_pages`. The title is URL-quoted (`urllib.parse.quote(title, safe="")`),
  so `Jane_Example_(politician)` becomes `Jane_Example_%28politician%29`.
- Agent type `user` (excludes known spiders and automated traffic), access `all-access`. Daily only; per-article
  hourly is not offered.

## Terms and robots findings
- Access policy (https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html):
  by using the API you agree to Wikimedia's Terms of Use and Privacy Policy. Data from the Analytics API is CC0 1.0.
- A User-Agent header is required; clients without one may be blocked without notice. Preferred format is
  `<client name>/<version> (<contact information>) <library>/<version>`. We send
  `race-attention/0.1.0 (research tool; contact via repo)` on every request (Kalshi too). When the repo has a public URL or a contact address, put it in `USER_AGENT` in
  `raceattn/__init__.py`.
- Rate limits depend on client identity; the policy says to wait for each request to finish before sending the
  next to stay safe. The REST API's global rules (from the `/api/rest_v1/?spec` document) say no more than 200
  requests per second. We send requests one at a time with a 0.3 s sleep: 3 requests per race run.
- `https://wikimedia.org/robots.txt` returns 404 (no robots file at that host).
- The User-Agent policy page (https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)
  was reachable; the access policy above summarises it.

## How the connector behaves
- A 404 from this API means no data for that article and range. The connector records an empty series, the
  quality check marks it `unusable`, and metrics skip it with the reason.
- `wikipedia/pageviews_total` is only filled on days where every page has a value (no partial sums).

## Not verified
- The exact per-client rate limit numbers on the "Wikimedia APIs/Rate limits" page were not read.
- The contact part of the User-Agent is generic until the repo has a public URL.

## Event generator (M2): MediaWiki parse API
- `GET https://en.wikipedia.org/w/api.php?action=parse&page=<race page>&prop=wikitext|revid&format=json&formatversion=2&redirects=1`,
  one request per run, cached under `data/raw/wikipedia_events/` (`--refresh` re-reads the current revision).
  Same User-Agent and one-at-a-time rule as above.
- Every row of `config/events/<race>.csv` cites the revision URL (`index.php?title=...&oldid=<revid>`), so the draft
  can be checked against exactly the text it came from. Texas: revision 1384978385, fetched 2026-11-11.
- Wikipedia text is CC BY-SA 4.0. The CSV stores facts (pollster name, fieldwork dates, a date) and a link, not
  article text. Attribution is the revision link on every row.
