#!/usr/bin/env python3
"""Pilot: three attention series next to Kalshi Texas Senate (SENATETX-26-D).

Attention series
  talking   : X post counts (needs X_BEARER_TOKEN in the environment)
  reporting : GDELT news article counts
  looking   : Wikipedia pageviews (race page + both candidates)
Outcomes (Kalshi, public API, no key): hourly price and volume.

Stdlib only. All HTTP goes through curl (python has no CA certs here).
Usage:  python3 tx_pilot.py            (runs everything it can)
        python3 tx_pilot.py --skip-x   (skip the X pull)
Outputs land in ./out/
"""
import csv, datetime as dt, json, math, os, subprocess, sys, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

KALSHI = "https://external-api.kalshi.com/trade-api/v2"
SERIES, TICKER = "SENATETX", "SENATETX-26-D"
START = dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc)
END = dt.datetime(2026, 11, 5, tzinfo=dt.timezone.utc)
ELECTION_DAYS = {"2026-11-03", "2026-11-04"}  # excluded from the main test

WIKI_PAGES = {
    "wiki_race": "2026_United_States_Senate_election_in_Texas",
    "wiki_talarico": "James_Talarico",
    "wiki_paxton": "Ken_Paxton",
}
GDELT_QUERY = "(Talarico OR Paxton) sourcelang:english"
X_QUERY = "(Talarico OR Paxton) lang:en -is:retweet"


def curl(url, headers_stdin=None, timeout=60):
    cmd = ["curl", "-s", "--max-time", str(timeout), "-w", "\n%{http_code}"]
    inp = None
    if headers_stdin:
        cmd += ["-K", "-"]
        inp = "\n".join('header = "%s"' % h for h in headers_stdin)
    cmd.append(url)
    r = subprocess.run(cmd, input=inp, capture_output=True, text=True)
    body, _, code = r.stdout.rpartition("\n")
    return int(code or 0), body


def jget(url, **kw):
    code, body = curl(url, **kw)
    try:
        return code, json.loads(body)
    except Exception:
        return code, {"_raw": body[:300]}


def ts(d):
    return int(d.timestamp())


# ---------------------------------------------------------------- Kalshi
def kalshi_hourly():
    rows, cur = [], START
    while cur < END:
        nxt = min(cur + dt.timedelta(days=20), END)
        url = "%s/series/%s/markets/%s/candlesticks?start_ts=%d&end_ts=%d&period_interval=60" % (
            KALSHI, SERIES, TICKER, ts(cur), ts(nxt))
        code, r = jget(url)
        for c in r.get("candlesticks", []):
            p = c.get("price", {}) or {}
            close = p.get("close_dollars")
            rows.append({
                "t": dt.datetime.fromtimestamp(c["end_period_ts"], dt.timezone.utc),
                "close": float(close) if close not in (None, "") else None,
                "volume": float(c.get("volume_fp") or 0),
            })
        time.sleep(0.3)
        cur = nxt
    rows.sort(key=lambda x: x["t"])
    seen, out = set(), []
    for r in rows:
        if r["t"] not in seen:
            seen.add(r["t"]); out.append(r)
    last = None
    for r in out:  # forward fill price for hours with no trades
        if r["close"] is None:
            r["close"] = last
        else:
            last = r["close"]
    return out


# ------------------------------------------------------------- Wikipedia
def wiki_daily():
    res = {}
    for col, title in WIKI_PAGES.items():
        url = ("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/"
               "all-access/user/%s/daily/%s/%s" % (urllib.parse.quote(title, safe=""),
                                                   START.strftime("%Y%m%d"), "20261104"))
        code, r = jget(url)
        for it in r.get("items", []):
            day = "%s-%s-%s" % (it["timestamp"][:4], it["timestamp"][4:6], it["timestamp"][6:8])
            res.setdefault(day, {})[col] = it["views"]
        print("wiki", col, code, len(r.get("items", [])))
        time.sleep(0.3)
    return res


# ----------------------------------------------------------------- GDELT
def gdelt_daily():
    params = {"query": GDELT_QUERY, "mode": "timelinevolraw", "format": "json",
              "startdatetime": START.strftime("%Y%m%d%H%M%S"),
              "enddatetime": END.strftime("%Y%m%d%H%M%S")}
    url = "https://api.gdeltproject.org/api/v2/doc/doc?" + urllib.parse.urlencode(params)
    cache = os.path.join(OUT, "gdelt_daily.csv")
    manual = os.path.join(OUT, "news_daily.csv")  # e.g. a Media Cloud export: date,count
    if os.path.exists(manual):
        cache = manual
    if os.path.exists(cache):
        with open(cache) as f:
            res = {r["date"]: float(r["count"]) for r in csv.DictReader(f)}
        print("gdelt: using cached", cache, len(res), "days")
        return res
    r = {}
    for attempt in range(3):
        code, r = jget(url, timeout=90)
        if "timeline" in r:
            break
        print("gdelt throttled/failed (try %d, http %s). Waiting 40s." % (attempt, code))
        time.sleep(40)
    res = {}
    for s_ in r.get("timeline", []):
        if s_.get("series") != "Article Count":
            continue
        for d in s_["data"]:
            day = "%s-%s-%s" % (d["date"][:4], d["date"][4:6], d["date"][6:8])
            res[day] = res.get(day, 0) + d["value"]
    print("gdelt days", len(res))
    if res:
        with open(cache, "w", newline="") as f:
            w = csv.writer(f); w.writerow(["date", "count"])
            for d in sorted(res):
                w.writerow([d, res[d]])
    return res


# --------------------------------------------------------------------- X
def x_hourly(token):
    hdr = ["Authorization: Bearer " + token]
    base = "https://api.x.com/2/tweets/counts/all"
    params = {"query": X_QUERY, "granularity": "hour",
              "start_time": START.strftime("%Y-%m-%dT%H:%M:%SZ"),
              "end_time": END.strftime("%Y-%m-%dT%H:%M:%SZ")}
    out, calls = {}, 0
    while True:
        code, r = jget(base + "?" + urllib.parse.urlencode(params), headers_stdin=hdr)
        calls += 1
        if code != 200:
            print("X counts/all failed:", code, json.dumps(r)[:400])
            return None
        for d in r.get("data", []):
            out[d["start"][:13]] = out.get(d["start"][:13], 0) + d["tweet_count"]
        nt = (r.get("meta") or {}).get("next_token")
        if not nt or calls > 20:
            break
        params["next_token"] = nt
        time.sleep(1.1)
    print("X hourly buckets", len(out), "calls", calls, "(~$%.3f)" % (calls * 0.005))
    return out


# -------------------------------------------------------------- analysis
def ranks(v):
    idx = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v)
    i = 0
    while i < len(idx):
        j = i
        while j + 1 < len(idx) and v[idx[j + 1]] == v[idx[i]]:
            j += 1
        for k in range(i, j + 1):
            r[idx[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def spearman(a, b):
    pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
    if len(pairs) < 20:
        return None, len(pairs)
    ra, rb = ranks([p[0] for p in pairs]), ranks([p[1] for p in pairs])
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    den = math.sqrt(sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))
    return (num / den if den else None), len(pairs)


def surprise(series, lookback, step=1):
    """ln((x_t+1) / (mean of previous `lookback` same-slot values + 1))."""
    out = []
    for i, x in enumerate(series):
        prev = [series[i - k * step] for k in range(1, lookback + 1) if i - k * step >= 0]
        if x is None or len(prev) < lookback or any(p is None for p in prev):
            out.append(None)
        else:
            out.append(math.log((x + 1) / (sum(prev) / len(prev) + 1)))
    return out


def lag_table(att, outs, lags):
    table = {}
    for name, o in outs.items():
        table[name] = {}
        for k in lags:  # k>0: outcome measured k slots AFTER attention
            a, b = [], []
            for i in range(len(att)):
                j = i + k
                if 0 <= j < len(o):
                    a.append(att[i]); b.append(o[j])
            rho, n = spearman(a, b)
            table[name][k] = (None if rho is None else round(rho, 2), n)
    return table


def write_chart(rows, has_x):
    panels = [("Kalshi Texas Senate D, daily close (price)", "close", False),
              ("Kalshi daily volume (contracts, log scale)", "volume", True),
              ("Looking: Wikipedia pageviews (race + both candidates)", "wiki_total", False),
              ("Reporting: GDELT news articles per day", "gdelt", False)]
    if has_x:
        panels.append(("Talking: X posts per day", "x", False))
    W, PH, L, R = 760, 110, 48, 12
    n = len(rows)
    H = len(panels) * (PH + 28) + 24
    svg = ['<svg viewBox="0 0 %d %d" width="100%%" xmlns="http://www.w3.org/2000/svg" font-size="11" fill="currentColor">' % (W, H)]
    xe = [i for i, r in enumerate(rows) if r["date"] == "2026-11-03"]
    for pi, (title, key, logy) in enumerate(panels):
        y0 = 18 + pi * (PH + 28)
        vals = [r.get(key) for r in rows]
        clean = [v for v in vals if v is not None]
        svg.append('<text x="%d" y="%d" font-weight="600">%s</text>' % (L, y0 - 5, title))
        svg.append('<rect x="%d" y="%d" width="%d" height="%d" fill="none" stroke="currentColor" opacity="0.2"/>' % (L, y0, W - L - R, PH))
        if not clean:
            svg.append('<text x="%d" y="%d" opacity="0.6">no data in this run</text>' % (L + 8, y0 + PH // 2))
            continue
        f = (lambda v: math.log10(v + 1)) if logy else (lambda v: v)
        lo, hi = min(f(v) for v in clean), max(f(v) for v in clean)
        if hi == lo:
            hi = lo + 1
        pts = []
        for i, v in enumerate(vals):
            if v is None:
                continue
            x = L + (W - L - R) * i / max(n - 1, 1)
            y = y0 + PH - PH * (f(v) - lo) / (hi - lo)
            pts.append("%.1f,%.1f" % (x, y))
        svg.append('<polyline fill="none" stroke="var(--accent, #4a7)" stroke-width="1.6" points="%s"/>' % " ".join(pts))
        for i in xe:
            x = L + (W - L - R) * i / max(n - 1, 1)
            svg.append('<line x1="%.1f" x2="%.1f" y1="%d" y2="%d" stroke="currentColor" stroke-dasharray="3 3" opacity="0.6"/>' % (x, x, y0, y0 + PH))
        top = (10 ** hi - 1) if logy else hi
        bot = (10 ** lo - 1) if logy else lo
        fmt = lambda v: ("%.0f" % v) if abs(v) > 5 else ("%.2f" % v)
        svg.append('<text x="2" y="%d" opacity="0.7">%s</text>' % (y0 + 10, fmt(top)))
        svg.append('<text x="2" y="%d" opacity="0.7">%s</text>' % (y0 + PH, fmt(bot)))
    ylab = H - 6
    svg.append('<text x="%d" y="%d" opacity="0.7">%s</text>' % (L, ylab, rows[0]["date"]))
    svg.append('<text x="%d" y="%d" text-anchor="end" opacity="0.7">%s (dashed line = Nov 3, election day)</text>' % (W - R, ylab, rows[-1]["date"]))
    svg.append("</svg>")
    with open(os.path.join(OUT, "tx_chart.html"), "w") as fh:
        fh.write("".join(svg))


def main():
    skip_x = "--skip-x" in sys.argv
    print("== Kalshi hourly")
    k = kalshi_hourly()
    print("hours", len(k), k[0]["t"] if k else None, k[-1]["t"] if k else None)
    print("== Wikipedia")
    wk = wiki_daily()
    print("== GDELT")
    gd = gdelt_daily()
    xh = None
    token = os.environ.get("X_BEARER_TOKEN")
    if skip_x or not token:
        print("== X skipped (%s)" % ("flag" if skip_x else "no X_BEARER_TOKEN in env"))
    else:
        print("== X counts")
        xh = x_hourly(token)

    # daily table
    days = {}
    prev_close = None
    for r in k:
        d = r["t"].strftime("%Y-%m-%d")
        e = days.setdefault(d, {"volume": 0.0, "close": None})
        e["volume"] += r["volume"]
        if r["close"] is not None:
            e["close"] = r["close"]
    daylist = sorted(days)
    rows = []
    for d in daylist:
        row = {"date": d, "close": days[d]["close"], "volume": days[d]["volume"]}
        for c in WIKI_PAGES:
            row[c] = wk.get(d, {}).get(c)
        row["wiki_total"] = sum(v for v in (row[c] for c in WIKI_PAGES) if v is not None) if wk.get(d) else None
        row["gdelt"] = gd.get(d)
        if xh is not None:
            row["x"] = sum(v for hk, v in xh.items() if hk.startswith(d))
        rows.append(row)
    cols = ["date", "close", "volume"] + list(WIKI_PAGES) + ["wiki_total", "gdelt"] + (["x"] if xh is not None else [])
    with open(os.path.join(OUT, "tx_daily.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c) for c in cols})
    if xh is not None:
        with open(os.path.join(OUT, "tx_hourly.csv"), "w", newline="") as f:
            w = csv.writer(f); w.writerow(["hour_utc", "close", "volume", "x"])
            for r in k:
                w.writerow([r["t"].isoformat(), r["close"], r["volume"], xh.get(r["t"].strftime("%Y-%m-%dT%H"), 0)])

    # daily analysis
    vol = [r["volume"] for r in rows]
    close = [r["close"] for r in rows]
    dprice = [None] + [(close[i] - close[i - 1]) if close[i] is not None and close[i - 1] is not None else None
                       for i in range(1, len(close))]
    absd = [abs(x) if x is not None else None for x in dprice]
    vol_s = surprise(vol, 7)
    outs = {"volume_surprise": vol_s, "abs_price_change": absd, "price_change": dprice}
    mask = [r["date"] not in ELECTION_DAYS for r in rows]
    results = {"window": [rows[0]["date"], rows[-1]["date"]], "excluded": sorted(ELECTION_DAYS), "daily": {}}
    for name in ["wiki_total", "gdelt"] + (["x"] if xh is not None else []):
        series = [r.get(name) for r in rows]
        s = surprise(series, 7)
        s = [v if m else None for v, m in zip(s, mask)]
        o2 = {kk: [v if m else None for v, m in zip(vv, mask)] for kk, vv in outs.items()}
        results["daily"][name] = {kk: {str(l): v for l, v in vv.items()} for kk, vv in lag_table(s, o2, [-2, -1, 0, 1, 2]).items()}

    # hourly analysis for X
    if xh is not None:
        xs = [xh.get(r["t"].strftime("%Y-%m-%dT%H"), 0) for r in k]
        vs = [r["volume"] for r in k]
        cl = [r["close"] for r in k]
        dp = [None] + [abs(cl[i] - cl[i - 1]) if cl[i] is not None and cl[i - 1] is not None else None for i in range(1, len(cl))]
        xsur, vsur = surprise(xs, 7, step=24), surprise(vs, 7, step=24)
        hm = [r["t"].strftime("%Y-%m-%d") not in ELECTION_DAYS for r in k]
        xsur = [v if m else None for v, m in zip(xsur, hm)]
        o = {"volume_surprise": [v if m else None for v, m in zip(vsur, hm)],
             "abs_price_change": [v if m else None for v, m in zip(dp, hm)]}
        results["hourly_x"] = {kk: {str(l): v for l, v in vv.items()} for kk, vv in lag_table(xsur, o, [-3, -2, -1, 0, 1, 2, 3]).items()}

    with open(os.path.join(OUT, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    def show(title, tab):
        print(title)
        for oname, d in tab.items():
            print("  %-17s" % oname, "  ".join(
                "lag%+d=%s(n%d)" % (int(l), ("%.2f" % v[0]) if v[0] is not None else "NA", v[1]) for l, v in d.items()))
    for name, tab in results["daily"].items():
        show("DAILY %s surprise vs outcomes (lag>0: outcome after attention)" % name, tab)
    if "hourly_x" in results:
        show("HOURLY X surprise vs outcomes", results["hourly_x"])
    write_chart(rows, xh is not None)
    n = sum(1 for m in mask if m)
    print("daily n (non-election days) ~", n, "| rough |rho| noise band ~", round(2 / math.sqrt(max(n - 7, 1)), 2))


if __name__ == "__main__":
    main()
