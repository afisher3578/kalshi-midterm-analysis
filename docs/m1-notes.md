# M1 notes: Texas dashboard

Date: 2026-11-11. Static dashboard in `web/` (Vite + TypeScript, D3 7.9.2, Observable Plot 0.6.19). It reads
`data/processed/tx-senate-2026.json` and nothing else. No server, no network calls beyond the page's own files.

## Build and run

    cd web
    npm ci
    npm run check      # tsc --noEmit
    npm test           # vitest: transforms, plus a cross-check against the pipeline's rho
    npm run build      # web/dist, with data/processed/*.json copied to web/dist/data/
    npm run preview    # http://127.0.0.1:4173/
    CHROME_PATH=... npm run verify   # with preview running: offline render, screenshots, spot checks, axe

`?race=<race_id>` picks the race file (default `tx-senate-2026`); there is no race switcher in M1.

## Verification results

- `npm ci && npm run check && npm run build`: pass. `web/dist` holds `index.html`, `assets/` (one JS, one CSS) and
  `data/index.json`, `data/tx-senate-2026.json`.
- `npm test`: 11 tests pass. One test computes the surprise in TypeScript and a Spearman rho from it, and gets the
  pipeline's lag 0 cell for Wikipedia total vs volume surprise (rho 0.2383, n 56) to 4 decimals. So the page's surprise
  view uses the same numbers the metrics used.
- Offline render (`scripts/verify.mjs`, Playwright 1.65 driving the installed Chromium 1248 through `CHROME_PATH`):
  every request whose host is not 127.0.0.1 or localhost is aborted and recorded. Result: 0 blocked requests,
  0 console errors, 0 page errors. Requests made: `/`, `/assets/index-*.js`, `/assets/index-*.css`,
  `/data/tx-senate-2026.json`.
- The election-day rule sits at the same pixel x on all six panels (checked in the DOM), so the shared axis holds.
- The view toggle moves with arrow keys. All three downloads produce files with no network request
  (daily CSV 4,029 bytes, hourly CSV 51,649 bytes, metrics JSON about 22 KB).
- No horizontal page scroll at 390 px; tables scroll inside their own container.
- `grep -E 'https?://' web/dist`:
  - JS bundle: `http://www.w3.org/2000/svg`, `.../1999/xhtml`, `.../1999/xlink`, `.../2000/xmlns/`,
    `.../XML/1998/namespace` (SVG and XML namespace strings inside D3, never fetched), and two plain footer
    links to source terms (`https://docs.kalshi.com/getting_started/quick_start_market_data`,
    `https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html`).
  - `index.html` and the CSS: none.
  - `data/tx-senate-2026.json`: the recorded API endpoints in the `queries` audit block
    (`https://external-api.kalshi.com/...` 4 times, `https://wikimedia.org/...` 3 times). These are data, not loads.
  - No script, style or font is loaded from anywhere but the page's own origin.

### Spot checks (DOM read in Playwright vs JSON)

| Check | Value on page | Value in JSON | JSON path |
|---|---|---|---|
| Lag cell, Wikipedia total vs volume surprise, lag +1 | `0.28 * n=55` | rho 0.2786, n 55 | `metrics.daily["wikipedia/pageviews_total"].outcomes.volume_surprise["1"]` |
| Daily close on 2026-10-05 (daily values table, cents) | `65.0` | 0.65 | `series.daily.rows[34][2]` (column `kalshi/price_close`) |
| Coverage and missing days, James_Talarico | `65/65 days (100%)`, `None missing` | coverage_days 65, window_days 65, coverage 1.0, missing_days [] | `quality["wikipedia/pageviews/James_Talarico"]` |

### Accessibility

- Lighthouse 13.6.0, accessibility only, headless Chromium 1248 via `CHROME_PATH`, against `npm run preview`:
  mobile preset 100, desktop preset 100. No failing audits.
- axe-core (via @axe-core/playwright 4.14.0, WCAG 2.0/2.1 A and AA tags) at 1280 and 390 px: 0 violations.
- Fixed along the way: Plot puts `aria-label` on `<g>` and `<line>` mark groups, which axe flags
  (aria-prohibited-attr). The page moves those names to `data-mark` and gives each chart `role="img"` with an
  `aria-label` and `aria-description`, inside a `<figure>` whose `<figcaption>` has a one-sentence text summary.
- Lighthouse manual checks (focus order, etc.) are not scored; focus order follows the DOM and every control has
  a visible 3 px focus ring.

### Screenshots

- `docs/screenshots/m1-texas-1280.png` (full page, 1280 px, raw view)
- `docs/screenshots/m1-texas-390.png` (full page, 390 px)
- `docs/screenshots/m1-texas-1280-surprise.png` (full page, surprise view)
- `docs/screenshots/m1-texas-1280-drawer.png` ("How this is computed" drawer, open)

All taken at device scale 2. Reviewed by eye: no overlapping labels or clipped axes.

## Defaults chosen

- Chart types: line for the hourly price and for each daily attention series (with small dots so isolated days
  stay visible), bars for hourly volume (one bar per candle hour). No dual axes; one series per panel.
- Price: shown in cents, 0 to 100, which equals the implied probability in percent.
- Volume scale: symlog, sign(x) ln(1 + |x|) (Plot `symlog`, constant 1), so zero-volume hours sit on the baseline.
  Ticks at 0, 100, 10k, 1M.
- Shared x axis: window start 00:00 UTC to the day after window end, 00:00 UTC, on every panel. Hourly bars span
  the hour ending at `end_period_ts`. Daily points are drawn at noon UTC of their date.
- Election day: dashed rule at 00:00 UTC of the election date. Excluded days: shaded band, labelled "shaded:
  excluded from metrics" on every panel.
- Attention y axis: fitted to the days used in the metrics (the non-excluded days). Election-night values above
  it (Nov 4 is about 15 times a normal day) are not drawn as a line; they get a triangle on the frame edge and
  their exact values are printed in the panel caption. Without this the raw panels are flat lines with one spike.
- z-score: (x - mean) / sd, mean and sample sd (n - 1) over non-missing, non-excluded days. Excluded days use the
  same scale. A display aid only.
- Surprise: not stored in the JSON, so the page computes it with the pipeline's formula
  (`raceattn/metrics/surprise.py`): ln((x + 1) / (mean of previous 7 days + 1)), null if any input is missing.
  The unit test above checks it against the pipeline.
- Lag tables: one table per outcome (a, b, c), rows = attention series, columns = lags -2..+2 and the row's noise
  band. Each cell shows rho to 2 decimals and n. A `*` (and a screen-reader phrase) marks |rho| above the row's band.
  Cells with n < 20 read "blank: n<20" with n.
- Data loading: a small Vite plugin. The dev server serves `../data/processed/<name>.json` at `/data/<name>.json`
  (names must match `^[a-z0-9-]+\.json$`); the build emits the same files into `dist/data/`. The page fetches
  `data/<race>.json` relative to the page, with Vite `base: './'`, so it works under any static path.
- No-data cards: derived from `race` and `sources` in the JSON plus a static catalog in `web/src/config.ts`
  (X, Bluesky, Media Cloud, Guardian, NYT, GDELT, Reddit, YouTube). A source shows if the config field it needs
  (entities, news_query or subreddits) is set and it is not in `sources`. Source ids match the connector ids the
  M2 work uses (`x`, `bluesky`, `news_mediacloud`, `news_guardian`, `news_nyt`, `gdelt`).
- Funding disclosure: `SHOW_FUNDING_DISCLOSURE` in `web/src/config.ts`, read from `VITE_FUNDING_DISCLOSURE=on` at
  build time. Off by default; with it off nothing renders.
- `PROJECT_NAME` lives in `web/src/config.ts` (mirrors `raceattn/__init__.py`).
- Every daily value behind the charts is in a collapsible table, so no number needs hover.

## Leftovers

- Reddit and YouTube connectors do not exist yet, and the M2 connectors were still uncommitted while this was
  built, so the no-data commands for them will fail until M2 lands.
- The election-day rule is at 00:00 UTC on the election date. Polls in Texas close around 00:00 to 01:00 UTC on
  Nov 4, so the rule marks the calendar day, not poll close.
- The volume panel has 1,536 bars; at 390 px they merge into an area. Daily volume might read better on phones.
- Playwright 1.65 expects Chromium 1254, which is not installed; the verify script uses `CHROME_PATH` to point at
  the installed 1248 build.
- Hourly lag tables are empty in M0 data; the page prints the pipeline's note instead.
