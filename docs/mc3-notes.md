# MC3 notes: the live Media Cloud pull for Texas Senate

Date: 2026-11-12. Status: live data pulled for tx-senate-2026, both collections. The query config is still
draft (version 1, not frozen) and the tuning audit is not coded yet. Every number below comes from the live API
on 2026-11-12. Source notes: docs/sources/mediacloud.md ("Verified" and "Live run 2026-11-12"); query decisions:
docs/mediacloud-search-criteria.md section 11.

## What MC3 did

1. Checked the key, the endpoints and the query syntax against the live API (version 3.2.3). No query changes were
   needed. `article_title:` and `language:en` work as drafted; count-over-time returns `ratio`, `total_count` and
   explicit zero days; start and end are inclusive.
2. Found the Texas collection with `mediacloud collections --state TX` and put both collections in
   `config/queries/tx-senate-2026.mediacloud.yaml`: `national` (United States - National, 34412234, 246 sources)
   and `texas_local` (Texas, United States - State & Local, 38381323, 593 sources).
3. Pulled the tuning window (Aug 1 to 24) and drew the tuning audit sample, then pulled the analysis and election
   window and rebuilt the race JSON with every source. `data/processed/tx-senate-2026.json` now has 16 Media Cloud
   count series (8 queries x 2 collections) plus the ratio, total_count and derived series, Sept 1 to Nov 4.
4. Dashboard: the Texas race page overflowed at 390 px once the real series arrived. Panel titles such as
   `news_mediacloud/headline_either/texas_local/total_count` had no break point (fixed with `overflow-wrap: anywhere`
   on `.ptitle`). The event study's facet labels sat in a 14 px right margin and spilled past the screen (now drawn
   above each facet, inside the plot). `web/scripts/verify-news.mjs` now checks the live Texas state; the empty
   state is checked on fl-senate-2026, which has no query file.
5. Test: `test_collection_without_id_is_skipped_and_listed` loads a copy of the real config with texas_local's id
   set to null and checks the skip message, the not configured status and the audit's `not_configured` list. The
   real config has both ids now, so the earlier tests no longer covered this.

## Requests

54 in total: 1 key check, 1 collections lookup, 16 probe requests (syntax and endpoints), 16 tuning-window counts,
4 tuning audit story-list pages, 16 analysis-and-election counts. The full-source rebuild after that was 16 cache
hits and 0 requests. No 401, 403 or 429. A full Texas run without the cache is 16 count requests, about 8 minutes at
30 s.

## Tuning window, Aug 1 to 24

Total stories, national / texas_local. Every series 24/24 days.

| Query | national | texas_local |
|---|---|---|
| talarico_race | 436 | 345 |
| paxton_race | 456 | 445 |
| race_either | 605 | 484 |
| race_both | 287 | 306 |
| talarico_any | 458 | 349 |
| paxton_any | 639 | 638 |
| headline_either | 155 | 210 |
| any_either | 810 | 681 |

## Tuning audit

One story-list page per cell (2 core queries x 2 collections), every match retrieved (no page cap), 100 drawn per
cell with seed 1, 400 rows. Retrieved equals the count-over-time total in every cell. The CSV is git-ignored:
`data/local/mediacloud/audit/tx-senate-2026/tuning.csv`.

Duplicate rate (same normalized title on 2 or more domains), in sample / against retrieved:

| Cell | in sample | against retrieved |
|---|---|---|
| talarico_race / national | 6% | 8% |
| talarico_race / texas_local | 28% | 43% |
| paxton_race / national | 7% | 14% |
| paxton_race / texas_local | 24% | 41% |

Overall in sample: 90/400 (22.5%). Syndication is heavy in the Texas collection, and Media Cloud does not collapse
it. A texas_local count is partly a count of reprints.

## Analysis and election windows

Analysis Sept 1 to Nov 2 / election Nov 3 to 4, total stories:

| Query | national | texas_local |
|---|---|---|
| talarico_race | 4045 / 861 | 3222 / 795 |
| paxton_race | 3782 / 724 | 3290 / 710 |
| race_either | 4928 / 974 | 3875 / 893 |
| race_both | 2899 / 611 | 2637 / 612 |
| talarico_any | 4140 / 865 | 3248 / 799 |
| paxton_any | 3979 / 732 | 3654 / 715 |
| headline_either | 1067 / 116 | 1137 / 175 |
| any_either | 5220 / 986 | 4265 / 902 |

- Every count series 65/65 days, quality ok; analysis phase 63/63 days. No near-zero stretches, no missing days.
- Explicit zero days: one, headline_either / texas_local on 2026-10-04.
- talarico_exclusive_share / texas_local is 64/65: 2026-09-20 has a zero denominator, so it is null with a reason.
- Largest race_either national days: Nov 4 (675), Nov 3 (299), Sept 10 (203). Nov 4 being larger than Nov 3 fits
  publish dates being local dates with no timezone.
- Collection totals (total_count): national 5,532 to 13,151 stories a day; texas_local 1,480 to 8,721 a day. The
  low texas_local days are weekends (Oct 3, 4, 11, 18, 25), which looks like a normal weekly cycle, not an ingest
  gap.

## What MC2 left open (docs/mc2-notes.md)

- The real series: resolved. Ratio, total_count and explicit zero days are all there, so the ratio toggle, the
  zero-day tile and the missing-day count show real values.
- Per-source counts: the endpoints exist (`count-by-source-over-interval`, `search/sources`) but are not built, so
  the distinct-sources tile and Chart 5 still say not available. A follow-up card builds them.
- texas_local: resolved. Chart 1 has two lines and both tile groups have numbers.
- Y scales and layout with real counts: checked by `npm run verify` at 1280 and 390 px (the 390 px overflow is
  fixed, see above).
- Headlines and precision on a real coded audit: still open, the audit is not coded.
- The Overview tab lists every Media Cloud series as an attention panel. The long labels now wrap; the grouping of
  those panels still needs a look.

## Still unverified

- Whether Media Cloud's `publish_date` extraction is accurate.
- The story-list default sort order and pagination beyond one page (never needed).
- Whether endpoints other than search are limited to 2 requests a minute.
- Breadth and top sources: the endpoints exist, not built (follow-up card).
- Licensing of publishing counts: still `licensing_confirmed: false`, as with Bluesky (docs/licensing.md).

## Status

Draft. The queries are not frozen.

## Human step (Alex)

1. Open `data/local/mediacloud/audit/tx-senate-2026/tuning.csv`.
2. Fill `relevant` with `yes`, `no` or `unclear` for every row. The precision code reads exactly those three values.
3. For paxton_race rows, fill `category` with `race`, `ag_office` or `other`.
4. Put your initials in `coder`.
5. Run `python -m raceattn mediacloud precision data/local/mediacloud/audit/tx-senate-2026/tuning.csv`. The target
   is 0.90.
6. If a core query is under 90%, revise it on the tuning period only and redraw with
   `python -m raceattn mediacloud audit --race tx-senate-2026 --phase tuning --force`. Freeze the queries only after
   that.

## Screenshots

`docs/screenshots/mc-live-1280.png`, `mc-live-390.png` (the Texas news view) and `mc-live-overview-1280.png` (the
Texas Overview tab) are taken from the static build (`web/dist` served without `/local/`), where the headline
column says "available when run locally". `verify-news.mjs` also fetches the audit titles and URLs from the local
server and checks that none of them is on those pages before saving them. `mc-news-empty-*.png` now shows
fl-senate-2026.
