---
tags: [kalshi-grant, spec, dev-handoff, research-tool]
created: 2026-11-10
related: ["[[kalshi-midterm-grant-notes]]", "[[kalshi-grant-pilot/README]]"]
---

# Race attention tool: build spec (working name `race-attention`)

Status: spec for dev. Written by studio for Alex Fisher, Nov 10 2026. Nothing here posts, sends or publishes anything. The grant proposal is due Nov 18 (Kalshi midterm research grant), so Milestones 0 and 1 matter most for the proposal's feasibility section.

## 1. Purpose

A standard way to take one US race, pull Kalshi market data for it, pull attention data about it from news and social platforms, line them up on one clock, compute the same metrics for every race, and show the result in a dashboard. A user changes the race and every connector re-targets automatically. Paid APIs (X, others) run with the user's own credentials.

Research question the tool serves: do midterm prices follow events (information) or the feed (attention), and does that differ by platform, media type and polling density? The tool is the instrument and the public output. It must be reproducible: same config in, same numbers out.

Users:
- Alex (researcher, runs the pipeline locally with his own keys, publishes the results).
- A reader of the published report (opens the hosted dashboard, picks a state, sees cached aggregates, no keys needed).
- A third-party researcher (clones the repo, adds a race config and their own keys, runs it).

## 2. Scope tiers and milestones

| Milestone | Deliverable | Target |
|---|---|---|
| M0 | Repo scaffold, race config schema, Kalshi and Wikipedia connectors, metrics module, Texas end to end, golden test that reproduces the pilot numbers (section 9) | by Nov 13 |
| M1 | Static dashboard for one race (Texas): price, volume, three attention series, data-quality badges, lag table. Screenshots usable in the proposal | by Nov 15 |
| M2 | Remaining connectors: X (bring your own token), news (Media Cloud, Guardian, NYT), Bluesky. Event list generator (section 7) | after M1 |
| M3 | Interactive US map with filters, race discovery for all Senate races, per-state pipeline runs | after M2 |
| M4 | Optional connectors (Reddit, YouTube, Google Trends import, Polymarket prices), local refresh server, docs and license | stretch |

Dev: tell Alex if the Nov 13 and Nov 15 targets slip. They are there so the proposal can carry real screenshots, and Alex can still apply without them.

## 3. Architecture

Python pipeline, static front end, no hosted server.

```
race-attention/
  config/races/tx-senate-2026.yaml     one file per race
  config/events/tx-senate-2026.csv     information events (section 7)
  raceattn/
    connectors/   base.py kalshi.py wikipedia.py x.py mediacloud.py guardian.py nyt.py bluesky.py gdelt.py ...
    metrics/      surprise.py lags.py quality.py
    pipeline.py   cli.py
  data/raw/<source>/<race_id>/...      cached raw responses (git-ignored)
  data/processed/<race_id>.json        per-race output the dashboard reads (committed)
  data/processed/index.json            list of races + headline metrics for the map
  web/                                 static site
  tests/ fixtures/
  docs/
```

Defaults (dev may change with a reason on the card):
- Python 3.11+. Use `requests` with `certifi`, or `httpx`. On Alex's machine the system Python had no CA certs and pandas/numpy were broken, so do not depend on the system Python; use a venv (uv or `python -m venv`) with pinned requirements. Pandas is optional; the pilot did all the math in the standard library.
- Front end: Vite + TypeScript, D3 (d3-geo with us-atlas TopoJSON) for the map, Observable Plot for charts. Output is static files deployable to GitHub Pages or any static host. No server holds keys.
- CLI: `python -m raceattn run --race tx-senate-2026 --sources kalshi,wikipedia,x`, `python -m raceattn discover --office senate`, `python -m raceattn build-site`.

## 4. Race config schema (YAML)

```yaml
race_id: tx-senate-2026
state: TX
office: senate            # senate | house | governor | national
election_date: 2026-11-03
window: {start: 2026-09-01, end: 2026-11-04}   # UTC dates, inclusive
exclude_days: [2026-11-03, 2026-11-04]          # election night, used for the main metrics
kalshi:
  series: SENATETX
  event: SENATETX-26
  followed_market: SENATETX-26-D                # the contract the metrics follow
entities:
  - {name: "James Talarico", aliases: ["Talarico"]}
  - {name: "Ken Paxton",     aliases: ["Paxton"]}
wikipedia_pages:
  - 2026_United_States_Senate_election_in_Texas
  - James_Talarico
  - Ken_Paxton
subreddits: [texas, TexasPolitics]              # suggested, dev to verify they exist
news_query: '("Talarico" OR "Ken Paxton") AND Senate'
polling_density: null                           # filled from the polling table count (section 7)
```

Rules:
- One file fully describes a race. Changing the race in the CLI or the dashboard only changes which file is loaded.
- Each connector renders its own query from `entities`, `news_query` and the window. Connectors never hard-code a state or a candidate.
- Keep the query rendering in one place per connector and log the final query string in the output JSON, so a reader can audit what was searched.
- `discover` fills configs automatically: Kalshi event tickers (section 5), Wikipedia race page, candidate names from the race article. A human reviews the generated file before it is trusted. Flag low confidence.

## 5. Kalshi connector (public, no key)

Verified on Nov 10 2026 against the live API:
- Base `https://external-api.kalshi.com/trade-api/v2`. Docs: https://docs.kalshi.com/getting_started/quick_start_market_data
- Senate series follow `SENATE{ST}` with event ticker `SENATE{ST}-26` for 32 states (AL AK AR CO DE GA ID IL IA KS LA ME MA MI MN MS MT NE NH NJ NM NC OK OR RI SC SD TN TX VA WV WY). Missing among likely 2026 Senate races: KY, OH, FL (probably different tickers; dev must add a discovery step by event title, not a hard-coded pattern).
- Governor tickers do not follow one pattern. `KXGOV{ST}` returned events only for AK and CA. `discover` must search events by title and category.
- Markets in an event are party contracts, e.g. `SENATETX-26-D`, `SENATETX-26-R`. Fields seen: `status` (finalized), `result` (yes/no), `open_time`, `close_time`.
- Candlesticks: `GET /series/{series}/markets/{market}/candlesticks?start_ts&end_ts&period_interval={1|60|1440}`. Use chunks of 20 days or less. Price is in `price.close_dollars`, volume in `volume_fp` (a numeric string in contracts). Hours with no trades return a null price; forward-fill the price and keep volume 0.
- Trades: `GET /markets/trades` (live) and `GET /historical/trades` (before the cutoff from `GET /historical/cutoff`). Each trade has `created_time`, `count_fp`, `yes_price_dollars`, `taker_side`, `is_block_trade`. Needed for trade count and the small-trade share (M2). Historical candlesticks for markets settled before the cutoff come from `/historical/markets/{ticker}/candlesticks`. Changelog: https://docs.kalshi.com/changelog/index
- Be polite: small sleeps between calls, retry with backoff on 429 and 5xx, stop on repeated failure and say so. No auth is required for these endpoints. Do not add trading or any authenticated calls.
- Output series: `kalshi/price_close` (hourly), `kalshi/volume` (hourly), `kalshi/trade_count` and `kalshi/small_trade_share` (hourly, M2, threshold configurable, default under 10 contracts).

## 6. Connector interface and catalog

Every connector implements the same contract.

```python
class Connector:
    id: str                 # "x", "bluesky", ...
    auth: str               # "none" | "api_key" | "bearer_token" | "oauth" | "approval"
    granularity: list[str]  # ["hour","day"]
    cost_model: str         # human-readable, shown before a paid pull
    def estimate_cost(self, race) -> Estimate: ...
    def fetch(self, race, window) -> list[Row]: ...
    def quality(self, rows, window) -> Quality: ...
```

Normalized row (one table for everything):

```
race_id, source, series, ts_utc, granularity, value, unit, query_hash, fetched_at
```

`series` names use `source/kind`, e.g. `x/post_count`, `wikipedia/pageviews_race`, `news_mediacloud/story_count`, `bluesky/post_count`, `kalshi/price_close`.

Quality object (mandatory; this is what caught the GDELT problem in the pilot):
- `coverage_days` / `window_days`, list of missing days, longest gap, near-zero stretches (days at under 5% of the series median while neighbors are normal), `status`: `ok | degraded | unusable`.
- The dashboard shows the badge. Metrics skip a series marked `unusable` and print why. Never silently interpolate attention data.

Cost guard: any connector with `cost_model` other than free must print an estimate and require `--yes` or `--max-spend 5.00` before pulling. Cache everything on disk by (source, race, window, query hash). Never re-pull a paid read that is already cached.

### Connector catalog (access as of Nov 10 2026; re-verify before coding each)

| Connector | Channel | Auth | Cost / limits | Notes | Priority |
|---|---|---|---|---|---|
| Kalshi | prices, volume, trades | none | free | section 5 | M0 |
| Wikipedia pageviews | looking | none | free | `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/{title}/daily/{start}/{end}`. Daily only, no hourly. Pilot found 65 of 65 days. Sum race page plus candidate pages; keep them as separate series too | M0 |
| X (Twitter) | talking | user's bearer token | pay-per-use. About $0.005 per post read, counts endpoint priced per request, 3M reads a month cap, full-archive search listed for pay-per-use. https://docs.x.com/x-api/getting-started/pricing | Use `GET /2/tweets/counts/all` with `granularity=hour` for volume (cheap). Whether counts/all is open on pay-per-use is UNVERIFIED: the connector must try it, print the exact API error if refused, and fall back to recent counts (7 days) with the quality badge `degraded`. Token goes through `curl -K -` or an Authorization header from an environment variable, never in arguments, logs or committed files. Query default: entities OR-joined, `lang:en -is:retweet`. Post text is never stored in published output | M2 |
| Media Cloud | reporting | free account API key | default 4000 requests a week, some endpoints 2 per minute. https://www.mediacloud.org/documentation/faqs | Daily story counts and ratios for a query across collections (US national). Fallback: user drops an export CSV `data/raw/news_manual/<race>.csv` (`date,count`). Replaces GDELT as the default news series | M2 |
| Guardian Open Platform | reporting (one outlet) | free key | free tier | Content API with `q`, `from-date`, `to-date`; `response.total` gives a count. UNVERIFIED in this session, dev to confirm limits and fields | M2 |
| New York Times Article Search | reporting (one outlet) | free key | free tier with rate limits | Hit count per query and date range from the response metadata. UNVERIFIED, dev to confirm | M2 |
| Bluesky | talking | none or app password | free | `app.bsky.feed.searchPosts` with `q`, `since`, `until`, `lang`, `sort`. CONFLICTING reports: one says search needs a logged-in session and `public.api.bsky.app` returns 403 for search; another says `api.bsky.app` works unauthenticated but unauthenticated cursor pagination returns 403 (walk backwards with `until` instead and dedupe on `uri`). Dev must test live and support both modes. There is no counts endpoint, so counts come from paging posts; cap pages and store only counts per hour | M2 |
| GDELT DOC | reporting | none | free; one request per 5 seconds, 429 blocks last minutes | Pilot result: 44 of 65 days returned, gaps through Oct 28 to Nov 2, near-zero values. Keep as an optional connector that the quality check will usually mark `degraded` or `unusable`. Do not use as the default | M4 |
| Reddit | talking | approved credentials | official API needs approval; no published price | Per-user credentials only. Optional archive route (Arctic Shift dumps) has an unresolved terms question: leave it behind an explicit flag with a warning in the docs. Counts per hour per subreddit and per query, no text stored | M4 |
| YouTube Data API v3 | video | free API key | default quota 10,000 units a day, `search.list` limited to 100 calls a day. https://developers.google.com/youtube/data/getting-started | Daily count of matching videos via `publishedAfter/Before`. Expensive in calls; low priority | M4 |
| Google Trends | searching | alpha access only | limited testers: https://developers.google.com/search/apis/trends | No scraping of the website. Provide an import path for a CSV exported from the Trends page (`date,value`) and mark values as relative interest, not counts | M4 |
| Polymarket prices | prices (comparison market) | none expected | free | Public price history for matching contracts, for a Kalshi vs Polymarket overlay. UNVERIFIED; check the API terms first | M4 |
| TikTok Research API | video | approved researcher | academic institutions only, 4 week approval, 1,000 requests a day. https://developers.tiktok.com/products/research-api/ | Alex is independent, so likely ineligible. Leave a documented adapter stub, not a built connector | out |
| Discord, Telegram | talking | n/a | n/a | OUT OF SCOPE (no access, terms). Do not add | out |
| Threads, Substack | talking | n/a | no usable public search API known | Out of scope unless Alex asks | out |

Rules for every connector:
- Read the source's terms and robots rules before coding it and write the finding in `docs/sources/<source>.md`.
- On 403 or 429 stop and report; do not rotate IPs, spoof agents or otherwise work around a block.
- Official APIs and user-supplied exports only. No scraping behind a login.

## 7. Information events and polling density

Attention only means something against a list of real information events (poll releases, race calls, scheduled debates, filing deadlines, early returns, major candidate news with a new fact). The event list is defined before looking at prices.

- `config/events/<race>.csv`: `date_utc, type, source_url, note`.
- Generator (M2): propose poll release dates from the polling table on the race's Wikipedia page, debates and deadlines from the same page where present, and write them to a draft CSV marked `needs_review`. A human confirms before metrics use it. Never invent an event.
- `polling_density` for a race = number of polls in the window (from the same table). This feeds the "sparsely polled" filter on the map.

## 8. Metrics (same for every race)

All series are put on one UTC clock (hourly where the source allows, otherwise daily; daily attention series are analyzed against daily Kalshi aggregates).

- Surprise: `ln((x_t + 1) / (mean of the previous 7 same-slot values + 1))`. For hourly series the "same slot" is the same hour of day on the previous 7 days; for daily series the previous 7 days. Apply it to every attention series and to Kalshi volume, so shared upward trends toward the election do not produce fake correlation.
- Exclusion: drop `exclude_days` (election night) from the main metrics; show them in the charts, marked.
- Lag table: Spearman rho of attention surprise against (a) Kalshi volume surprise, (b) absolute price change, (c) signed price change, at lags -2..+2 days (daily) or -3..+3 hours (hourly). Lag above 0 means the outcome is measured after the attention.
- Blank any cell with fewer than 20 pairs. Print the rough noise band, about 2/sqrt(n), next to every table and note that daily series are autocorrelated so it is generous. The tool reports timing and association, not causation.
- Event windows (M2): average attention and price response in the days around each confirmed information event, plus the same around attention spikes with no listed event ("excess attention").
- Reversion (M2): after an attention spike, did the price move back within N days? N configurable, default 3.
- Every number in the output JSON carries `n`, the quality status of the series behind it, and the query hash.

## 9. Acceptance for M0 (Texas golden test)

The pilot already ran on Texas with stdlib scripts; use it as the reference and reproduce it: `~/obsidian/main/permanent/kalshi-grant-pilot/tx_pilot.py` with its README, and `out/tx_daily.csv` as the expected output. The new pipeline must match on:
- Kalshi `SENATETX-26-D` hourly candles for 2026-09-01 to 2026-11-04: 1,536 hours.
- Daily closes: about 0.49 on Sept 5, 0.65 on Oct 5, 0.69 on Oct 29, 0.997 on Nov 4 (the market finalized Yes).
- Wikipedia: 65 days for each of the three pages.
- Wikipedia surprise vs Kalshi volume surprise rho within 0.02 of the pilot (about 0.24 to 0.28 at lags 0 to +2, n about 55). If the new numbers differ by more than that, find out why before moving on and put the reason on the card.
- Tests run with recorded fixtures and without network. A separate `--live` smoke test hits the real APIs.

## 10. Dashboard (M1 and M3)

M1 (Texas only):
- Header: race, window, followed contract, election day marked.
- Panels with a shared time axis: Kalshi price, Kalshi volume (log scale), one panel per attention series with its quality badge. Toggle between raw, z-scored and surprise.
- Lag table with `n` and the noise band. A "how this is computed" drawer.
- Export buttons: CSV of the aligned series, JSON of the metrics.

M3 (all races, interactive map):
- US map. States colored by a selectable metric: total attention, attention surprise vs volume rho, price change over the window, polling density, data coverage. States with no race, or fewer than 20 pairs, shown as "insufficient data", never as a number.
- Click a state: opens that race's panels. If a state has several races (Senate, Governor, House), a race-type switcher.
- Filters: race type, platform (talking / reporting / looking and each source), window, metric, information-event overlay on or off, polling density band.
- Chart types: small multiples, normalized overlay, lead-lag heatmap, event-study plot, scatter of attention surprise vs volume surprise, calendar heatmap of attention.
- Hosted mode shows only committed processed data. A source with no cached data for a race shows "run locally with your own key", with the command.
- Phone-friendly, keyboard accessible, no hover-only information. Respect the colors and fonts the site theme gives; no external tracking scripts.

## 11. Bring your own keys

- Keys come from environment variables or a git-ignored `.env`: `X_BEARER_TOKEN`, `MEDIACLOUD_API_KEY`, `GUARDIAN_API_KEY`, `NYT_API_KEY`, `BSKY_HANDLE` and `BSKY_APP_PASSWORD`, `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`, `YOUTUBE_API_KEY`. Commit `.env.example` with empty values and a line on where to get each key.
- Keys are never written to logs, output JSON, cache files, the site build or commit history. A pre-commit check should fail on anything that looks like a key.
- Optional M4: a local refresh server (FastAPI on localhost) so the dashboard's "refresh this race" button runs the connectors with the user's local keys. Keys never go to the browser or a hosted server.
- Alex puts his own keys in his own shell. Nobody pastes a token into a chat or a card.

## 12. Data licensing in the output

- Publish counts and metrics, not post text, usernames or user ids. For X, Reddit and Bluesky, store only aggregate counts per time bucket in `data/processed`. Raw responses stay in the git-ignored cache.
- Whether X's and Reddit's terms allow publishing even aggregate counts is not confirmed. Write the open question in `docs/licensing.md` and make the publish step print a warning until Alex confirms.
- The grant requires a funding disclosure line in the published deliverable: "This research was funded in part by a grant from Kalshi Inc. under the Kalshi Midterm Election Research Grant Program. Kalshi did not direct, review, or approve the research or its conclusions." Put it in the site footer and README behind a config flag that is off until the grant is awarded.

## 13. Out of scope

Posting, messaging or publishing anything; user accounts; trading or authenticated Kalshi calls; real-time streaming; Discord and Telegram; any scraping that needs a login or defeats a block; storing or redistributing post text; sentiment scoring as a headline metric (hand-coded samples, if added later, are a separate milestone).

## 14. Pitfalls found in the pilot

- System Python had no CA certs and a broken numpy/pandas; use a venv.
- GDELT throttles (HTTP 429, wait minutes) and returned a gappy series; check coverage before using any news series.
- Wikipedia per-article pageviews are daily only.
- Kalshi hourly candles need chunking and forward-filled prices; `volume_fp` is a string; trades before the historical cutoff are on a different endpoint.
- Election night dominates every raw correlation. Exclude it for the main test and show it on the chart.
- Series with a strong shared trend need the surprise transform before any correlation is read.

## 15. Defaults for open questions (dev implements the default and lists it in the summary)

1. Name: `race-attention` is a working title. Keep it in one constant (`PROJECT_NAME`) and in the package name only. Alex may rename it.
2. Front end: Vite + TypeScript + D3 + Observable Plot, static build.
3. Hosting: no deploy. Build to `web/dist`. Alex decides where it goes.
4. License: MIT for code, CC BY 4.0 for aggregated data, as proposed defaults only. Alex decides before anything is published.
5. Repo: new git repo at `~/work/race-attention`, local commits on `main`, no remote, no push.
6. Races in the first build: Texas only. Other Senate races come in M3 via `discover`.

## 16. Sources checked while writing this spec

- Kalshi API docs: https://docs.kalshi.com/getting_started/quick_start_market_data and https://docs.kalshi.com/changelog/index (primary). Live checks on Nov 10 2026 for tickers, candlesticks and trades.
- X pay-per-use pricing: https://docs.x.com/x-api/getting-started/pricing (primary). Counts/all on pay-per-use not verified.
- Media Cloud FAQ: https://www.mediacloud.org/documentation/faqs (primary).
- YouTube quota: https://developers.google.com/youtube/data/getting-started (primary).
- Google Trends API alpha: https://developers.google.com/search/apis/trends (primary).
- TikTok Research API: https://developers.tiktok.com/products/research-api/ (primary).
- Bluesky search behavior: third-party notes, in conflict (GitHub toolkit and a search-operators guide); not tested here.
- Reddit access and Arctic Shift terms: third-party reports, unverified.
- Guardian, NYT and Polymarket APIs: not checked in this session.
