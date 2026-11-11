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
- Trades endpoints (`/markets/trades`, `/historical/trades`, `/historical/cutoff`) are M2 and were not re-checked here.
