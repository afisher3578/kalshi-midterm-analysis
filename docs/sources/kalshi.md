# Source: Kalshi (public market data)

Checked 2026-11-11.

## What we call
- `GET https://external-api.kalshi.com/trade-api/v2/series/{series}/markets/{market}/candlesticks?start_ts&end_ts&period_interval=60`
- Unauthenticated, read-only. No API key, no trading, no portfolio endpoints.
- Series, market and window come from the race config. Nothing is hard-coded in the connector.

## Terms and robots findings
- Kalshi's "Quick Start: Market Data" page (https://docs.kalshi.com/getting_started/quick_start_market_data) says
  public market data endpoints need no API key and are served from `https://external-api.kalshi.com/trade-api/v2`.
- `https://external-api.kalshi.com/robots.txt` returns 404 (no robots file on the API host).
  `https://docs.kalshi.com/robots.txt` allows crawling of the docs except `/cdn-cgi/` and `/_next/`.
- The rate limits page (https://docs.kalshi.com/getting_started/rate_limits) describes token budgets for
  authenticated requests. It does not state a limit for unauthenticated market data reads.
- Candlestick fields as seen live: `end_period_ts`, `price.{open,high,low,close,mean,previous}_dollars` (strings),
  `volume_fp` (string), `open_interest_fp`, `yes_bid`, `yes_ask`. Hours with no trades return a null price.

## How the connector behaves
- Chunks of at most 20 days; the inclusive window runs from start 00:00 UTC to (end + 1 day) 00:00 UTC.
- 0.3 s sleep between calls, a descriptive User-Agent, bounded retries with exponential backoff on 429 and 5xx,
  then it stops and reports. 403 stops at once. It never rotates IPs or spoofs agents.
- Every response is cached under `data/raw/kalshi/...`, so a re-run makes no calls unless `--refresh`.

## Not verified
- Kalshi's terms of service on redistributing derived aggregates (daily closes, volume) were not read in this
  session. The output publishes only aggregates and metrics; confirm before publishing.
- Any unauthenticated rate limit. Our usage (4 requests per race run) is tiny.

## Trades (M2, checked live 2026-11-11)
- `GET /historical/cutoff` returned `{"trades_created_ts": "2026-09-11T00:00:00Z", ...}` (also
  `market_settled_ts`, `orders_updated_ts`, `market_positions_last_updated_ts`).
- `GET /historical/trades?ticker&min_ts&max_ts&limit&cursor` for trades before `trades_created_ts`, and
  `GET /markets/trades?...` from it on. `limit` max is 1000 (`limit=1001` returned a validation error). Paging by
  `cursor`; an empty cursor ends it. `/historical/trades` for a range after the cutoff returned no trades;
  `/markets/trades` also returned trades from before the cutoff, so the connector splits the window at the cutoff and
  dedupes on `trade_id` anyway.
- Trade fields: `trade_id`, `created_time`, `count_fp` (string), `yes_price_dollars`, `no_price_dollars`,
  `taker_side`, `taker_book_side`, `taker_outcome_side`, `is_block_trade`, `ticker`.
- Texas SENATETX-26-D, 2026-09-01..11-04: 2,563 historical trades (3 pages) and 113,765 live trades (114 pages),
  116,328 in the window after dedupe; 0 block trades.
- Series: `kalshi/trade_count` (trades per hour, every hour of the window, 0 when none) and
  `kalshi/small_trade_share` (trades with `count_fp` under 10 contracts divided by trades in the hour, null when the
  hour has no trades). Hours are bucket starts in UTC. Threshold and block-trade handling (`exclude` by default; the
  number excluded is in the quality object) are in `config/project.yaml`.
- The cutoff is cached with the trade pages, so a cached run is a consistent snapshot. `--refresh` re-reads it.
- Fixture: `tests/fixtures/raw/kalshi_trades/tx-trades-2day/...`, recorded live for 2026-09-10..11 (spans the
  cutoff).
