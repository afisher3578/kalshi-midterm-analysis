# MC2 notes: local dashboard with the Media Cloud datapoints and basic visuals

Date: 2026-11-11. Status: built and verified offline. There is still no Media Cloud key on this machine, so the
Texas race has no Media Cloud data: the news view shows its empty state with real data, and every Media Cloud
number in demo mode is synthetic. The live pull is MC3.

## The command

    python -m raceattn dashboard --race tx-senate-2026            # build if needed, serve, open the browser
    python -m raceattn dashboard --race tx-senate-2026 --demo     # same, with synthetic Media Cloud data (labeled)
    python -m raceattn dashboard --race tx-senate-2026 --no-open --port 4180

Options: `--port` (default 4173; `0` picks a free port), `--no-open`, `--demo`, and `--no-build` (serve `web/dist` as
it is, skip the Node check and the build; `npm run verify` uses it). It prints
`Dashboard: http://127.0.0.1:4173/?race=tx-senate-2026&view=news` (with `&demo=1` under `--demo`) and stops cleanly
on Ctrl+C.

- The race id must be in `data/processed/index.json`; otherwise it prints the valid ids and exits 2.
- `node` and `npm` must be on PATH (`shutil.which`), else: "Node.js and npm are needed to build the dashboard:
  install Node 20+ from nodejs.org, then run this again", exit 2.
- Build: when `web/dist/index.html` is missing or older than the newest file in `web/src`, `web/index.html`,
  `web/package.json`, `web/package-lock.json` or `web/vite.config.ts`. `npm ci` runs first only when
  `web/node_modules` is missing or older than `package-lock.json` (dated by `node_modules/.package-lock.json`, which
  npm writes on every install). Each command is printed before it runs and its output goes to the terminal; a
  failure exits with the npm exit code.
- Port in use: "error: port 4173 on 127.0.0.1 is already in use ... pick another port with --port", exit 2. No
  fallback. (`SO_REUSEADDR` is on so a restart can bind over TIME_WAIT connections; binding a port another server
  is listening on still fails, checked on macOS.)
- Code: `raceattn/dashboard.py` (stdlib only: `http.server.ThreadingHTTPServer`, `webbrowser`, `subprocess`),
  wired into `raceattn/cli.py`. Tests: `tests/test_dashboard.py` (34, no real npm).

## Routes (127.0.0.1 only, GET and HEAD)

| Path | Serves |
|---|---|
| `/`, `/index.html` | `web/dist/index.html` with `<meta name="raceattn-local-server" content="live|demo">` added |
| `/<file>`, `/assets/<file>` | files of `web/dist` (not `web/dist/data`) |
| `/data/<name>.json` | `data/processed/<name>.json`, read on every request (overrides the copies in `web/dist/data`) |
| `/local/mediacloud/<race>/query-config.json` | the parsed query config (below) |
| `/local/mediacloud/<race>/audit.json` | the audit CSVs under `data/local/mediacloud/audit/<race>/` (local only) |
| `/local/demo/<race>.mediacloud.json` | the demo fixture, only with `--demo` and only for the served race |

Anything else is 404. Each segment must match a fixed pattern (`[A-Za-z0-9_-][A-Za-z0-9._-]*`, race ids
`[a-z0-9-]+`), a path with `%`, a backslash or a NUL is refused before matching, and a file is served only if its
resolved real path is inside the served directory. The tests try 21 traversal and unlisted paths. Responses carry
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

`/local/` exists only in this server. The Vite config is unchanged: it serves and copies `data/processed` only, so
`npm run build` never puts `data/local` or demo files in `web/dist` (checked by a pytest and by the verify script,
which walks `web/dist`). The page asks for `/local/` only when the meta tag is present, so the static build (any
static host, `npm run preview`) never requests it and never logs a 404.

## The News (Media Cloud) view

Reached from the race section by the tabs "Overview: Kalshi and attention" and "News (Media Cloud)" (real links,
switched in place on click), or directly with `?race=tx-senate-2026&view=news`. The other URL params work as
before; `view=raw|z|surprise` still picks the panel transform on the overview. `demo=1` asks for the demo fixture.
Code: `web/src/news.ts` (pure functions), `web/src/newsview.ts` (DOM), chart helpers added to `web/src/charts.ts`
(`linesChart`, `dailyBarsChart`, `emptyChart`, `hbarChart`), styles in `web/src/style.css`.

Top to bottom:
1. Empty-state card (no Media Cloud data, real mode): what is missing (the key, from `skipped.news_mediacloud`; the
   collections with no id) and the steps (below).
2. Status: "Live data", "Not yet pulled" or "DEMO DATA, not real"; collections with name, id and status ("not
   configured" for a null id); config version, status and hash (12 characters, full in a details element); last pull
   (latest `fetched_at` of the Media Cloud series in `series.meta`, else "never" with the race JSON `generated_at`; the
   page says which).
3. Tiles per collection for the analysis window (query config `phases.analysis`, else 2026-09-01..2026-11-02):
   total race_either stories, mean per day, peak day, days with zero stories (explicit zeros) with missing days
   counted and listed separately, average Talarico share (rule and n stated), distinct sources per day or "not
   available yet". Precision group from the audit file, or "not coded yet", or "available when run locally".
4. Chart 1: race_either per day per collection, radio toggle raw count / normalized ratio (`/ratio`). Election day
   (dashed line, label) and the excluded days (shaded, label) come from the race JSON. No primary or runoff date is
   in the Texas config or JSON (the events CSV has polls, debates and filing deadlines), so none is marked; the page
   says so, and would mark `race.primary_date` / `race.runoff_date` if a race JSON had them inside the window.
5. Chart 2: talarico_race and paxton_race per day, with the daily Talarico share beneath on the same x axis, 50%
   reference line.
6. Chart 3: stacked panels on one time axis: Kalshi hourly close (series and label of the race page), news
   race_either, Wikipedia pageviews summed, Kalshi contracts per day (`kalshi/volume` from the daily table).
7. Chart 4: race_either vs any_either per day, core_vs_broad beneath.
8. Chart 5: top sources as horizontal bars per collection, with the values in a table inside a details element.
9. The ten largest days (race_either, first collection with data) with counts per collection and up to three sample
   headlines per day from the audit file (national first, deduplicated by URL), links with
   `rel="noopener noreferrer"`, marked "local only, not published".
10. Method drawer ("How these numbers were made"): config path, version, status, frozen date, language, platform,
    API version, timezone note, config sha256; collections table; phases; every query verbatim with its role, sha256
    and per-collection status (8: the seven plus any_either); derived definitions; zero vs missing; exclusions and
    changes logs; limitations (from the unverified list in docs/sources/mediacloud.md, bundled in `newsview.ts`).
11. Downloads, built with Blob in the page: CSV (date plus every Media Cloud column of the daily table) and JSON
    (every tile value with its definition and n). Disabled with a reason when there is no data.

Every news chart is a labeled empty panel when there is no data (the time axis, the election marks and the text
"No Media Cloud data pulled for this race yet"), never zeros. Every chart has an aria-label, an aria-description
and a text summary in its caption; there are no tooltips. Phone: tiles wrap, charts follow the container width, the
top-days and other tables scroll inside labeled regions.

### Run step in the empty state (a deviation from the brief, on purpose)

`run --sources` exists, but `python -m raceattn run --race tx-senate-2026 --sources news_mediacloud` writes a race
JSON with only the sources of that run: checked on 2026-11-11 with `--out-dir /tmp/mc2_probe`, the result had
`sources: []` and only the `date, excluded, kalshi/price_close, kalshi/volume` columns, all Kalshi values empty. The
dashboard would lose its Kalshi and Wikipedia panels. So the card shows the race's current sources plus
news_mediacloud, built from the race JSON: `python -m raceattn run --race tx-senate-2026 --sources
kalshi,kalshi_trades,wikipedia,bluesky,news_mediacloud` (the others come from the cache), and says why not to use
`--sources news_mediacloud` alone.

## Data shapes the view reads

- Daily table `series.daily` of the race JSON: `news_mediacloud/<query>/<collection>` (count),
  `.../<collection>/ratio`, `.../<collection>/total_count`, `news_mediacloud/talarico_share/<collection>`,
  `news_mediacloud/talarico_exclusive_share/<collection>`, `news_mediacloud/core_vs_broad/<collection>`, as MC1
  writes them. A null cell or an absent date is missing; a 0 is a real zero.
- Query block: `queries.news_mediacloud.mediacloud` of the race JSON (MC1 shape). The pipeline writes it only when the
  connector runs, and the committed Texas JSON has none (the connector was skipped for the missing key). Choice: the
  view uses the JSON block when present, else the dashboard server's `/local/mediacloud/<race>/query-config.json`,
  which builds the exact same block with `MediaCloudConnector.query_summary` from the YAML (no request, no key), so
  the status line and the drawer show the real queries before any pull. The pipeline and the committed JSON are not
  changed. On a static host without the server the view says "available when run locally".
- Not built yet, shapes defined here so a later card can fill them:
  - Distinct sources per day: a daily column `news_mediacloud/<query>/<collection>/distinct_sources` (the tile reads
    `race_either`), number of distinct sources with at least one matching story that UTC day.
  - Top sources: `queries.news_mediacloud.mediacloud.top_sources.<collection>` =
    `{query, start, end, sources: [{source, count}], note?}`, counts over the analysis window.
- Audit (local only): `/local/mediacloud/<race>/audit.json` =
  `{available, _note, phases: {analysis|tuning: {path, rows: [{query, collection, story_id, publish_date, source,
  title, url, relevant}]}}}` from `data/local/mediacloud/audit/<race>/<phase>.csv`. Precision uses the analysis phase
  if any row is coded yes or no, else tuning. No separate story listing exists under data/local yet; headlines come
  from the audit rows.

## Math (web/src/news.ts, tests in web/tests/news.test.ts)

- Total = sum over analysis-window days with a value; mean per day = total / days with a value (explicit zeros
  count as days); peak = largest day, earliest date on a tie; zero days = explicit zeros; missing days = window days
  with no value.
- Average Talarico share = mean of the daily share over the window days where it is defined. It reads the derived
  column when present, else computes talarico_race / (talarico_race + paxton_race) with the same rule as `derive()`
  (null on a zero denominator or a missing input). n and the number of undefined days are shown.
- Precision = yes / (yes + no) per query and collection, unclear and blank left out and counted, Wilson 95% without
  continuity correction: the same rule and constant as `raceattn mediacloud precision`. The vitest case is the
  output of the Python function on the same rows (17 tests in news.test.ts, 38 web tests in total).

## Demo design

- `--demo` builds the fixture in memory at server start (`raceattn.dashboard.demo_fixture`, `random.Random(1)`, no
  clock, so it is identical every time) and serves it at `/local/demo/<race>.mediacloud.json`. Nothing is written
  anywhere (no `data/local/demo/` either; `data/local/` is already git-ignored, so `.gitignore` is unchanged).
- Shape: `_synthetic: true`, `_note: "DEMO DATA, not real"`, a daily table with every query and collection (count,
  ratio, total_count), the three derived series computed with the connector's formulas (a pytest checks the share
  against `derive()`), distinct sources per day, `queries.news_mediacloud.mediacloud` = the real query block with
  synthetic collections ("United States - National (DEMO: synthetic counts)", "Texas state and local (DEMO: no real
  collection)", no ids) and `top_sources`, and a coded audit sample (40 rows per core query and collection,
  "DEMO headline N (synthetic, not a real story)", links on https://example.invalid/, outlets on example.invalid).
  Plausible shapes: rising toward election day, weekend dips, four random spike days, an election spike; one
  explicit zero day and one missing day per collection.
- The page asks for the fixture only when the URL has `demo=1` and the server says `demo`. Then a box at the top, the
  status line, every tile group, every chart, the top-days table, the drawer and the download section show a visible
  "DEMO DATA, not real" banner (black on yellow, plain text, in the accessibility tree; no tooltip). Chart 3 keeps
  the real Kalshi and Wikipedia panels and labels only its news panel as demo. Download file names end in `-DEMO`.
  `demo=1` without a demo server shows a note and real data.

## Defaults chosen

- Port 4173 (the Vite preview port); `--port 0` for a free port.
- The analysis window from the query config, else 2026-09-01..2026-11-02.
- The main collection for Charts 2 and 4 and the top-days table: the first collection with race_either data, in
  config order (national).
- Config hash shown as 12 characters, full in a details element.
- Headlines: up to three per day, national rows first.
- Precision: analysis phase first, else tuning.
- Run step in the empty state: the race's current sources plus news_mediacloud (above).

## Verification

`npm run verify` is one command (`web/scripts/run-verify.mjs`): it starts `python -m raceattn dashboard --no-build
--no-open --port 0` twice (real and `--demo`), runs `scripts/verify.mjs` (the M1 and M3 checks, unchanged) against
the real server and `scripts/verify-news.mjs` against both, then stops them. It serves the existing `web/dist`, so
run `npm run build` first. As in M1 and M3, Playwright 1.65 expects Chromium 1254, which is not installed; set
`CHROME_PATH` to the installed Chromium 1248. `verify-news.mjs` also serves `web/dist` with a plain static server
to check the static build. Checks: no request leaves 127.0.0.1, no console or page errors, the empty-state card
and run command, status "Not yet pulled", the config hash and all 8 queries against the server's query config,
labeled empty panels, Chart 3 Kalshi first and last close against `series.hourly`, the Overview tab's 2026-10-05
close and lag cell against the JSON, three demo numbers recomputed from the fixture (independently of `news.ts`),
the banner on every chart, tile group and section and in the aria snapshot, headline links, precision tiles, both
downloads, the ratio toggle, no page overflow at 390 px, `web/dist` free of local and demo files, the static build
(no `/local/` request, "available when run locally"), and axe (WCAG 2.1 A/AA) at 1280 and 390 in both modes with
every details element open. Screenshots: `docs/screenshots/mc-news-{empty,demo}-{1280,390}.png`. Tall pages are
captured at CSS-pixel scale, because Chromium repeats content past about 16k device pixels in a full-page capture.

## Unverified until the live pull (MC3)

- The real series: whether count-over-time returns `ratio`, `total_count` and explicit zero days, so whether the
  ratio toggle, the zero-day tile and the missing-day count show anything meaningful.
- Whether per-source counts exist: the distinct-sources tile and Chart 5 stay "not available yet" / empty until a
  connector fills the shapes above.
- The texas_local collection: until it has an id, Chart 1 has one line and the Texas tiles say not configured.
- The y scales and layout with real counts (the demo shapes are guesses).
- Headlines and precision on a real coded audit file (only the demo audit and a test CSV were read).
- The race page (Overview tab) lists every Media Cloud series as an attention panel once they exist (MC1 noted that
  the labels and grouping need a look then); MC2 did not change it.
