# M3 notes: race discovery, multi-state runs, US map

Date: 2026-11-11. Status: M3 built. Discover ran live for all 50 states (Senate and Governor), five extra races ran
end to end (four Senate, one Governor), the map dashboard renders offline and `npm run verify` passes. The optional
localhost refresh server was not built (see the end).

## What was built

- `python -m raceattn discover --office senate|governor [--state XX,YY]` (`raceattn/discover.py`).
  - Kalshi: lists every event through `GET /events` (status open, closed and settled, cursor paging) and matches a
    state by title only: "<State> Senate winner?" or "<State> Governor winner?" (an optional "(Party)" or
    "(Person)" suffix), with "2026" in the sub title. No ticker pattern is used. When a state has a party event and a
    "(Person)" event (Alaska Senate), the party event wins. `GET /events/{ticker}` gives the markets; the followed
    market is the Democratic party contract (same rule as Texas). The Kalshi candidate named on that contract
    (`yes_sub_title`) is checked against the Wikipedia nominees; a match makes the Kalshi note high confidence.
  - Wikipedia: the race article is looked up through the MediaWiki query API with redirects resolved, trying
    "2026 United States Senate election in <State>" and the "special election" title (Governor:
    "2026 <State> gubernatorial election"). Ohio and Florida 2026 are special elections; the regular title redirects
    to them and the note says so. If both titles were separate articles, the Kalshi series (a trailing S, like
    SENATEOHS) would pick the special one, at medium confidence.
  - Candidates: the nominees in the article's election infobox with at least 5% of the vote (all nominees when no
    shares are listed) and their article titles (redirects resolved). Aliases default to the surname.
  - News query: `("A" OR "B") AND Senate|Governor`. A candidate's term is the bare surname when Wikipedia has no
    other topic under it (no article, a redirect to the candidate, or a surname list page), else the full name.
    This rule reproduces the Texas query (Talarico is a surname list page; Paxton is a disambiguation page).
  - Window, exclude_days: same rules as Texas (September 1 to the day after election day; election day and the day
    after are excluded). Subreddits are left empty with a low note. `polling_density` stays null until the events
    generator runs.
  - Writes `config/races/drafts/<race_id>.yaml` with `status: needs_review` and a `discovery:` block (confidence,
    why and source per field, plus the article revision), and `config/races/drafts/discover-report-<office>.md` and
    `.json`: every race resolved, every state not resolved and why, and a field-by-field comparison for any race that
    already has a hand-written config. Every draft is validated as a race config before it is written.
  - One state's failed request does not stop the run; it is listed as not resolved with the error.
- Race config schema: optional `status` (`confirmed` or `needs_review`; a file without one counts as confirmed)
  and `discovery` (a mapping, kept but not used by the pipeline).
- `python -m raceattn run --all`: every confirmed config in `config/races/` (drafts/ and `needs_review` files are
  listed and left out), one race after another; writes each race JSON and merges `index.json`. Exit 2 if any race
  failed, with the names.
- `race_overrides` in `config/project.yaml`: per race, `skip` (source and reason) and `connectors` (settings merged
  over the project ones). The race JSON records them in `run_overrides`, and skipped sources appear in `skipped`
  with the reason.
- `index.json` per race: `metrics` with `attention_total`, `attention_vs_volume` (rho, n, lag, noise band),
  `price_change` (cents, n, dates), `polling_density`, `data_coverage` (share, n series, window days),
  `quality_summary` (status counts, unusable series with reasons, skipped sources with reasons) and `attention`
  (the same per attention series, with its platform group), plus `kalshi` and `status`. The M1 fields are unchanged.
- Race JSON: `events_overlay` (every row of the events CSV inside the window with its status) and `run_overrides`.
- Dashboard (`web/`): see "Dashboard" below.
- Tests: `tests/test_discover.py` (8, offline on recorded responses), `tests/test_m3_pipeline.py` (5), a secrets
  test, and `web/tests/m3.test.ts` (8). Fixture recorder: `scripts/record_discover_fixture.py`.
- Fixes to earlier code that M3 needed: the events CLI passes `events_dir` explicitly, so the M2 test that
  monkeypatches it no longer rewrites the real `config/events/tx-senate-2026.meta.json`; `scripts/check_secrets.py`
  blanks token-named query parameters inside URLs in the MediaWiki wikitext caches only (Oregon and Montana race
  pages cite state websites with `OWASP_CSRFTOKEN=` and `&token=` links; these are page content fetched with no key).
  The M1 web test now expects 5 Texas attention series (Bluesky was added in M2).

## Races covered and why

| Race | Polls in the window | Density band | Why it was picked |
|---|---|---|---|
| tx-senate-2026 | 53 | high | the pilot race (hand-written config, kept as is) |
| oh-senate-2026 | 36 | high | heavily polled; a special election the old `SENATE{ST}` pattern missed (`SENATEOHS-26`) |
| fl-senate-2026 | 29 | medium | medium polling; a special election the old pattern missed (`SENATEFLS-26`) |
| nc-senate-2026 | 25 | medium | medium polling on a top-tier race; turned out to have the unusable source (below) |
| ky-senate-2026 | 1 | low | almost no polling; the old pattern missed it (its event is `SENATELA-26`) |
| tx-governor-2026 | 42 | high | optional: gives Texas a second race type so the race-type switcher has real data |

Bands: low under 10 polls in the window, medium 10 to 29, high 30 or more. Poll counts come from the events
generator (`config/events/<race>.meta.json`, all rows still `needs_review`). Maine was not picked: it would have
been a second high-density race, and Ohio covers high density while also testing the special-election path.

Review of each draft (done against the live sources on 2026-11-11, recorded in each config's `discovery.review`):
Kalshi event and both party markets (finalized, candidate names), the race and candidate articles (exist, infobox
nominees and shares), pageviews returned for every page in the run. One change per race: aliases that discover set
to a bare surname that is a common word or another Wikipedia topic were set to the full name, the same rule the news
query uses (Brown, Cooper, Whatley, Moody, Nixon, Barr, Booker, Hinojosa, Abbott). A Bluesky search for "Brown" or
"Cooper" would count unrelated posts. Husted keeps the surname alias. Kentucky's Booker article is
`Charles_Booker_(American_politician)` (discover resolved the redirect).

## What ran live (2026-11-11)

- `discover --office senate` and `--office governor` for all 50 states. Kalshi `/events` walk: open 100 pages
  (19,948 events), closed 3 (440), settled 267 (53,246) with `min_close_ts` = election day 00:00 UTC. Without that
  filter the settled listing ran past 400 pages (over 80,000 events, every settled event Kalshi ever ran) and was
  stopped. 1,972 Senate and Governor election events are kept in the cache.
  - Senate: 34 resolved. Not resolved: AK (the infobox lists no linked nominee yet; the Alaska market is still
    open), and 15 states with no 2026 Senate race (no Kalshi event and no Wikipedia page): AZ CA CT HI IN MD MO ND
    NV NY PA UT VT WA WI. 33 regular seats plus the OH and FL specials is 35; 34 of 35 resolved.
  - Governor: 32 resolved. Not resolved: AK, AR, CA (no linked nominee in the infobox), KS (no Kalshi event titled
    "Kansas Governor winner?"), and 14 states with neither source. ID, TN, VT and WY drafts have a low Kalshi note
    (the Kalshi candidate on the D contract is not an infobox nominee with 5% or more).
  - MediaWiki returned HTTP 429 twice at 0.3 s and 1 s spacing; discover now waits 2 s between calls with a longer
    backoff, and both full runs completed. A full first run takes about 15 minutes; later runs read the cache
    (0 requests).
- Events generator for OH, NC, FL, KY and TX Governor (counts above).
- `run --all` with no keys, default sources: Kalshi candles and trades, Wikipedia and Bluesky (unauthenticated) for
  FL, NC, OH (and KY after a retry, see below); Texas from cache. Total 11 minutes. Then `run --race
  tx-governor-2026` (Bluesky left out by override).
  - Kentucky's Wikipedia request got HTTP 429 from the Wikimedia REST API during `run --all` (the discover run was
    using the MediaWiki API at the same time); `run --race ky-senate-2026` a few minutes later succeeded.
  - Bluesky pages: FL 351, KY 260, NC 278, OH 375 (Texas 2,065 in M2). The 10-pages-per-term-per-day cap was hit
    only on 2026-11-04 for FL, NC and OH, so those days are lower bounds and the series is `degraded`.

## Sources skipped and why (also in each race JSON under `skipped`)

- Every race: X, Media Cloud, Guardian, NYT (no key here), news_manual (no CSV). The dashboard shows each as a "No
  data" card with the reason, the local command and the env var.
- tx-governor-2026: Bluesky, left out by `race_overrides` to bound runtime (the reason and the command are on the
  card).
- OH, NC, FL, KY: Bluesky ran, capped at 10 pages (1,000 posts) per term and day, `max_pages` 1,500 per run, set in
  `race_overrides`. Texas keeps the project defaults (50 per day, 6,000).

## Unusable source

`nc-senate-2026`: `kalshi/volume` is `unusable` (7 near-zero days, over 10% of the window: 7 to 216 contracts on
days where the median is 4,697). That is the M0 quality rule applied as written; the market really was thin on
those days. Because every lag table needs volume surprise, North Carolina has no lag tables, no event metrics and
"insufficient data" for the rho metric on the map. The dashboard shows the Unusable card with the reason, the volume
panel says why, and the lag section lists every table it left out. Open question for Alex: the near-zero rule was
written for attention gaps (the pilot's GDELT). A quiet day in a thin market is real data, as a low price is. It
could be exempted for Kalshi volume the way price is. Not changed here, so the M0 to M2 numbers stay the same.

## TX discover vs the hand-written config

Field by field (`config/races/drafts/discover-report-senate.md`, checked by `tests/test_discover.py`):

| Field | Match | Note |
|---|---|---|
| race_id, state, office, election_date | yes | |
| window, exclude_days | yes | 2026-09-01 to 2026-11-04; 2026-11-03 and 11-04 |
| kalshi (series, event, followed_market) | yes | SENATETX, SENATETX-26, SENATETX-26-D |
| entities | yes | James Talarico [Talarico], Ken Paxton [Paxton] |
| wikipedia_pages | yes | race page, James_Talarico, Ken_Paxton |
| news_query | yes | `("Talarico" OR "Ken Paxton") AND Senate` |
| polling_density | yes | null in both |
| subreddits | **no** | draft `[]`, hand-written `[texas, TexasPolitics]`. Discover leaves subreddits empty on purpose: there is no reliable source for them, and the Texas ones were never checked either (M0 notes) |

The draft also has `status: needs_review` and a `discovery` block, which the hand-written file does not have.

## Dashboard

- Map (`web/src/map.ts`): d3-geo with us-atlas 3.0.1 `states-albers-10m.json`, copied to `web/src/geo/` with its
  ISC license and bundled into the JS, so there is no CDN and no remote topojson. Metric select: total attention,
  attention surprise vs volume surprise rho (lag 0), price change in cents, polling density, data coverage. Five
  equal-width bins (blues for counts and shares, purple-orange diverging around 0 for rho and price change). A state
  without a race, or with n under 20 days or pairs, is hatched and reads "insufficient data" with the reason; a state
  outside the polling band is dotted ("filtered out"). Each state with a race prints its code and value on the map,
  the legend lists the bins in text, and a table below the map gives every value with its n.
- Every number carries n: "3.08M (n=63 days)", "rho 0.24 (n=56 pairs, lag 0)", "+23.0 cents (n=63 days, ...)",
  "53 polls in the window (n=53)", "100% (n=5 series x 65 days)".
- Opening a race: click a state, Enter or Space on a focused state (only states with a race are focusable), the
  State select, or the table's Open button. The URL carries `race`, `state` and the filters. A race-type switcher
  (radio group) appears when the state has more than one race (Texas: Senate and Governor).
- Race view (`web/src/race.ts`) reuses the M1 panels (price, volume, one panel per attention series with quality
  badges, lag tables, daily table, method drawer, exports) and adds: normalized overlay (z-scores, numbered line ends
  and a numbered list, color plus dash), lead-lag heatmap (rho and n printed in every cell, recomputed in the page),
  event study (anchors: confirmed events, else attention spikes with surprise >= 1.0; draft events are never used),
  scatter of attention surprise vs volume surprise (n and rho in the caption), calendar heatmap (weeks by weekday,
  log scale, excluded days marked x, missing days dashed). A "Queries behind this race" section prints the news
  query, Wikipedia pages, search terms and every rendered request from the race JSON.
- Filters: race type, map metric, polling density band, platform group (looking, talking, reporting), source,
  window from/to (applied in the page: the surprise is computed on the full window, then days outside the range are
  dropped from the comparison charts; the pipeline's lag tables stay full-window and say so), information-event
  overlay (purple ticks; dashed = draft row that needs review; the caption counts them).
- Badges: a skipped source gets a "No data" card with the reason from the race JSON, the command
  `python -m raceattn run --race <id> --sources <src>` and the env var; an unusable series gets an "Unusable" card
  with its reason, and its panel is still drawn with the reason in the caption.

## Verification results

- `.venv/bin/pytest -q`: 175 passed, 8 skipped (live tests), offline with the network blocked.
- `cd web && npm run check && npm test && npm run build`: pass (tsc clean, 20 vitest tests; one checks every lag
  cell of every committed race against the page's own Spearman code).
- `npm run preview` + `CHROME_PATH=~/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" npm run verify`:
  VERIFY OK, 28 checks, 0 blocked requests, 0 console errors, 0 page errors. axe (WCAG 2.0/2.1 A and AA): 0
  violations at 1280 (Texas, Florida, North Carolina) and 390 (Texas, Florida). Checks include:
  - offline: every non-local request aborted and recorded (none made);
  - map: every state with a race is a focusable button, states without one are hatched, every label prints a value,
    the table rows match index.json (TX 3.08M n=63 days; TX rho 0.24 n=56 pairs lag 0);
  - keyboard: focus Florida on the map, press Enter, the Florida race opens; `:focus-visible` is on;
  - state switch TX to FL with no reload: title, followed market, news query, Wikipedia pages, Bluesky terms, price
    panel title, lag cell, daily close on 2026-10-05 (12.0 cents, from the FL JSON) and the heatmap all change, and no
    parameterized request string repeats (the only repeat is Kalshi's global `/historical/cutoff`, which has no
    parameters); the URL becomes `?race=fl-senate-2026&state=FL`;
  - race type: TX Senate to TX Governor through the switcher; the race type filter limits the map to Texas;
  - filters: "talking" leaves only Bluesky panels; a window from 2026-10-01 recomputes the heatmap with smaller n;
    the event overlay caption counts 29 events for Florida;
  - badges: X card on Florida (reason, command, `X_BEARER_TOKEN`); Bluesky card on TX Governor (override reason);
    the North Carolina `kalshi/volume` Unusable card, the volume panel's reason and the lag section's list;
  - no horizontal page scroll at 390 px on the map page and on the Florida race opened from the State select.
- Screenshots (device scale 2), looked at by eye: `docs/screenshots/m3-map-1280.png`, `m3-map-390.png`,
  `m3-race-fl-senate-2026-1280.png`, `m3-race-fl-senate-2026-390.png`. Fixed after looking: election night swamped
  the overlay's scale (excluded days are no longer drawn there), heatmap row labels were clipped (shorter labels),
  the calendar drew only the excluded days (Plot drops rows with a null channel), the Florida map label sat on the
  coast (nudged), labels were about 6 px tall at 390 (larger under 560 px). The M1 screenshots are left as they were.
- `scripts/check_secrets.py`: clean over tracked files, data/processed and data/raw. No em or en dashes in the files
  written for M3 (scanned).

## Defaults chosen

- Discovery title rule, Democratic contract as the followed market, the 5% nominee threshold, the surname rule for
  news terms, `min_close_ts` = election day for the settled listing, 2 s between MediaWiki calls.
- Map headline rho: lag 0 (same day), fixed in advance rather than the largest of the five lags.
- Totals, price change and coverage use the non-excluded days of the window; price change runs from the first close
  to the last close before election night (`full_window_cents` keeps the change through the window end).
- `data_coverage`: mean coverage of the attention series that ran.
- Map source when no single source is picked: Wikipedia for all and looking, Bluesky for talking, Media Cloud for
  reporting.
- Polling bands: low under 10, medium 10 to 29, high 30+.
- Bins: five equal-width bins over the values shown; diverging metrics centered on 0.
- Event study anchors: confirmed events, else spike days of the selected series.
- Default view: the map with Texas Senate open below it (the M1 default race).

## Unverified

- Whether Kalshi's `/events` listing is complete: there is no total count to compare against, and a listing that
  ran into the hundreds of pages had to be cut with `min_close_ts`. Every 2026 Senate event the earlier probes found
  by series is in the result.
- Kalshi and Wikimedia rate limits for anonymous use (both sent 429s at modest rates; documented numbers not found).
- The poll counts behind `polling_density` (all event rows are still `needs_review`).
- The reviewed aliases for OH, NC, FL, KY and TX Governor (full names) were not tested against alternatives on
  Bluesky; the Bluesky counts for them are lower bounds on capped days.
- Subreddits for every new race (left empty).
- Governor drafts other than Texas were not reviewed or run.
- The North Carolina volume question above.

## Optional refresh server

Not built (marked optional in the brief and in spec section 11, M4). Nothing in M3 needs a key, and the page only
reads committed JSON.

## How to verify

    .venv/bin/pytest -q
    .venv/bin/python -m raceattn discover --office senate --state TX,OH,FL,KY   # reads the cache; --refresh re-fetches
    .venv/bin/python -m raceattn run --all                                       # cached: about 1 s, no requests
    cd web && npm ci && npm run check && npm test && npm run build
    npm run preview &
    CHROME_PATH=... npm run verify
