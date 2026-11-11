# Texas pilot: three attention series next to Kalshi

Script: `tx_pilot.py` (stdlib only). Outputs in `out/`: `tx_daily.csv`, `tx_hourly.csv` (only with X), `results.json`, `tx_chart.html`.
Market: SENATETX-26-D (Kalshi, Texas Senate, Democratic win). Window Sept 1 to Nov 4, 2026. Election days (Nov 3-4 UTC) are excluded from the correlations.

## Run
    cd ~/obsidian/main/permanent/kalshi-grant-pilot
    python3 tx_pilot.py --skip-x      # Kalshi + Wikipedia + news, no X
    export X_BEARER_TOKEN=...          # set in your own shell, never in chat or in this folder
    python3 tx_pilot.py                # adds X hourly counts (counts/all, ~$0.005 per request, a handful of requests)

## Series
- Talking: X post counts, query `(Talarico OR Paxton) lang:en -is:retweet`. Not run yet (no token in this environment). Whether counts/all is open on pay-per-use is unverified; the script prints the API error if it is not.
- Reporting: GDELT DOC article counts. UNRELIABLE for this window (see findings). To swap in Media Cloud: export the daily attention-over-time CSV from search.mediacloud.org (query `Talarico OR Paxton`, US national collection, Sept 1 to Nov 4) and save it as `out/news_daily.csv` with columns `date,count`. The script prefers that file.
- Looking: Wikipedia pageviews (daily only; per-article hourly is not offered): race page + James Talarico + Ken Paxton.

## Method
"Surprise" = ln((x_t + 1) / (mean of the previous 7 same-slot values + 1)). Applied to attention and to Kalshi volume so shared upward trends toward the election do not create fake correlation. Spearman rho against volume surprise, absolute price change and signed price change at lags -2..+2 (lag>0: outcome after attention). Cells with fewer than 20 pairs are blanked.

## First-run findings (Wikipedia only, n about 55 days)
- Wikipedia surprise vs volume surprise: rho 0.24 to 0.28 at lags 0, +1, +2. Rough noise band is about +-0.27 and daily series are autocorrelated, so this is weak and not evidence either way.
- Wikipedia vs absolute price change: about 0. Vs signed price change: -0.05 to -0.15, weak.
- GDELT: 44 of 65 days returned, with gaps (Sept 14-19, Oct 3-5, Oct 28-Nov 2) and near-zero values (2, 2, 0) in the weeks before the election. That looks like indexing gaps, not quiet news. Not usable.
- Daily price close: 0.49 (Sept 5), 0.65 (Oct 5), 0.69 (Oct 29), 0.997 (Nov 4).
