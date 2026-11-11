# Test fixtures

All offline tests read these files; none of them needs a key or the network.

| Path | Source | How it was made |
|---|---|---|
| `raw/kalshi/tx-senate-2026/...` | Kalshi candlesticks | recorded live (M0) |
| `raw/wikipedia/tx-senate-2026/...` | Wikimedia pageviews | recorded live (M0) |
| `raw/kalshi_trades/tx-trades-2day/...` | Kalshi `/historical/cutoff`, `/historical/trades`, `/markets/trades` for SENATETX-26-D, 2026-09-10..11 | recorded live 2026-11-11 (public API, no key). The window spans the historical cutoff (2026-09-11 when recorded) |
| `raw/wikipedia_events/tx-senate-2026/...` | MediaWiki API `action=parse` of the Texas race page, revision 1384978385 | recorded live 2026-11-11 |
| `bluesky/tx-bsky-1day.json` | `app.bsky.feed.searchPosts` on api.bsky.app, 2026-10-01, terms Talarico and Paxton, 4 pages per term | recorded live 2026-11-11, unauthenticated, by `scripts/record_bluesky_fixture.py`. Reduced: each post keeps only a sha256 of its uri, `record.createdAt` and `indexedAt`. No text, handles or dids |
| `x/*.json` | X `/2/tweets/counts/all` and `/counts/recent` | **synthetic from docs**: no X token was available. Shapes follow the docs.x.com examples (`data[].start/end/tweet_count`, `meta.next_token`, problem JSON errors with `title/detail/type`) |
| `news/guardian_day.json` | Guardian `/search` | **synthetic from docs** (no key): `response.status/total/...` per open-platform.theguardian.com |
| `news/nyt_day.json` | NYT Article Search | **synthetic from docs** (no key): `response.meta.hits` per the published OpenAPI spec |
| `news/mediacloud_count_over_time.json` | Media Cloud `search/count-over-time` | **synthetic from docs** (no key): `count_over_time.counts[].date/count/total_count/ratio` per the `mediacloud` python client |
| `news/gdelt_timelinevolraw.json` | GDELT DOC 2.0 `timelinevolraw` | **synthetic from docs**: `timeline[0].data[].date/value` as used by the pilot script; the live probe was rate limited (HTTP 429) |
| `news_manual/*.csv` | manual CSV import | hand-written test inputs |

Synthetic fixtures carry `"_fixture": "synthetic from docs"` at the top level. Replace them with recorded
responses once a key is available (see docs/m2-notes.md).
