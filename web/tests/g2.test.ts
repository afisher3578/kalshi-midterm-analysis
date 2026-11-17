import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { line } from "d3";
import { describe, expect, it } from "vitest";
import type { Candidates, DisplayDaily, DisplayHourly, RaceData } from "../src/types";
import { chartSeries, HOURLY_MAX_DAYS, hourlySeries, lastValueIndex, legendText, NEWS_COL, nudgeLabels, partyLines,
  RANGE_IDS, rangeDays, rangeForButton } from "../src/display";
import * as display from "../src/display";

const load = (id: string): RaceData =>
  JSON.parse(readFileSync(resolve(__dirname, `../../data/processed/${id}.json`), "utf-8"));

describe("nudgeLabels", () => {
  it("leaves labels that are far apart where they are", () => {
    expect(nudgeLabels([40, 200], 30, 0, 300)).toEqual([40, 200]);
    expect(nudgeLabels([250, 60, 150], 30, 0, 300)).toEqual([250, 60, 150]);
  });
  it("separates close labels by minGap around their center and keeps their order", () => {
    const [a, b] = nudgeLabels([100, 110], 30, 0, 300);
    expect(b - a).toBeCloseTo(30);
    expect((a + b) / 2).toBeCloseTo(105);
    const [c, d] = nudgeLabels([110, 100], 30, 0, 300);  // input order is kept in the output
    expect(c - d).toBeCloseTo(30);
    expect(c).toBeGreaterThan(d);
    const three = nudgeLabels([100, 105, 108], 20, 0, 300);
    expect(three[1] - three[0]).toBeCloseTo(20);
    expect(three[2] - three[1]).toBeCloseTo(20);
  });
  it("clamps inside the plot at the top and the bottom", () => {
    const top = nudgeLabels([2, 5], 30, 10, 300);
    expect(top).toEqual([10, 40]);
    const bottom = nudgeLabels([299, 296], 30, 0, 290);
    expect(Math.max(...bottom)).toBe(290);
    expect(Math.abs(bottom[0] - bottom[1])).toBeCloseTo(30);
    expect(bottom[0]).toBeGreaterThan(bottom[1]);  // 299 wanted lower than 296: still below it
  });
  it("equal values are separated, the first one on top", () => {
    const [a, b] = nudgeLabels([150, 150], 26, 0, 300);
    expect(a).toBeCloseTo(137);
    expect(b).toBeCloseTo(163);
  });
  it("squeezes the gap when the labels cannot fit at minGap", () => {
    const r = nudgeLabels([50, 50, 50], 100, 0, 100);
    expect(r).toEqual([0, 50, 100]);
    expect(nudgeLabels([], 10, 0, 100)).toEqual([]);
  });
});

describe("rangeForButton", () => {
  const w = { start: "2026-08-05", end: "2026-11-04" };
  it("gives the Texas ranges, all ending on the window's last day", () => {
    expect(RANGE_IDS).toEqual(["1D", "1W", "1M", "3M", "All"]);
    const got = Object.fromEntries(RANGE_IDS.map((id) => { const r = rangeForButton(id, w); return [id, `${r.from}..${r.to} ${r.zoom}`]; }));
    expect(got).toEqual({
      "1D": "2026-11-04..2026-11-04 hourly",
      "1W": "2026-10-29..2026-11-04 hourly",
      "1M": "2026-10-06..2026-11-04 daily",
      "3M": "2026-08-07..2026-11-04 daily",
      All: "2026-08-05..2026-11-04 daily",
    });
    expect(rangeDays("2026-10-29", "2026-11-04")).toBe(7);
    expect(rangeDays("2026-08-07", "2026-11-04")).toBe(90);
  });
  it("1D and 1W are hourly (at most HOURLY_MAX_DAYS), 1M and longer daily", () => {
    for (const id of RANGE_IDS) {
      const r = rangeForButton(id, w);
      expect(r.zoom).toBe(rangeDays(r.from, r.to) <= HOURLY_MAX_DAYS ? "hourly" : "daily");
      expect(r.zoom === "hourly").toBe(id === "1D" || id === "1W");
    }
  });
  it("clamps to the window: on a short window 3M equals All", () => {
    const short = { start: "2026-10-01", end: "2026-11-04" };
    expect(rangeForButton("3M", short)).toEqual(rangeForButton("All", short));
    expect(rangeForButton("3M", short).from).toBe("2026-10-01");
    expect(rangeForButton("1M", { start: "2026-10-20", end: "2026-11-04" }).from).toBe("2026-10-20");
  });
  it("replaces the old quick ranges", () => {
    expect("quickRanges" in display).toBe(false);
    expect("PRICE_WHY" in display).toBe(false);
  });
});

const TX = { major: [{ name: "James Talarico", party: "D", kalshi_ticker: "SENATETX-26-D" },
  { name: "Ken Paxton", party: "R", kalshi_ticker: "SENATETX-26-R" }] } as Candidates;

describe("candidate lines", () => {
  it("maps D and R from the candidates block and the tickers", () => {
    const l = partyLines(TX, "SENATETX-26-D", "SENATETX-26-R");
    expect(l.dem).toMatchObject({ name: "James Talarico", surname: "Talarico", party: "D", daily: "kalshi_price_close",
      hourly: "kalshi/price_close" });
    expect(l.rep).toMatchObject({ name: "Ken Paxton", surname: "Paxton", party: "R", daily: "kalshi_r_price_close",
      hourly: "kalshi_r/price_close" });
  });
  it("does not assume the followed market is the Democratic one", () => {
    const l = partyLines(TX, "SENATETX-26-R", "SENATETX-26-D");
    expect(l.dem!.daily).toBe("kalshi_r_price_close");
    expect(l.rep!.daily).toBe("kalshi_price_close");
  });
  it("a candidate on neither market gets no line; no candidates block keeps one unnamed Democratic line", () => {
    expect(partyLines(TX, "SENATETX-26-D", null).rep).toBeNull();
    const none = partyLines(undefined, "X-D", null);
    expect(none.rep).toBeNull();
    expect(none.dem!.daily).toBe("kalshi_price_close");
  });
  it("matches every committed race: the followed market is the D contract, the opposing one the R contract", () => {
    for (const id of ["fl-senate-2026", "ky-senate-2026", "nc-senate-2026", "oh-senate-2026", "tx-governor-2026", "tx-senate-2026"]) {
      const d = load(id);
      const l = partyLines(d.candidates, d.race.kalshi.followed_market, d.series.display_hourly!.opposing!.ticker);
      expect(l.dem!.ticker).toBe(d.race.kalshi.followed_market);
      expect(l.rep!.ticker).toBe(d.series.display_hourly!.opposing!.ticker);
      expect(l.rep!.name).toBe(d.series.display_hourly!.opposing!.name);
    }
  });
  it("legend names and descriptions come from the candidate names", () => {
    const l = partyLines(TX, "SENATETX-26-D", "SENATETX-26-R");
    expect(legendText("dem", "news", "day", l)).toEqual({ name: "James Talarico (D)", desc: "Kalshi chance that James Talarico wins (%)" });
    expect(legendText("rep", "news", "hour", l)).toEqual({ name: "Ken Paxton (R)", desc: "Kalshi chance that Ken Paxton wins (%)" });
    expect(legendText("volume", "news", "day", l).desc).toBe("contracts traded per day in the Talarico contract");
    expect(legendText("volume", "news", "hour", l).desc).toBe("contracts traded per hour in the Talarico contract");
  });
});

describe("gaps", () => {
  const l = partyLines(TX, "SENATETX-26-D", "SENATETX-26-R");
  it("a null R value is a null point, so line().defined() leaves a gap (no fill, no interpolation)", () => {
    const dd: DisplayDaily = { window: { start: "2026-08-05", end: "2026-08-07", days: 3 }, news: [NEWS_COL],
      columns: ["date", "kalshi_price_close", "kalshi_volume", "kalshi_r_price_close"],
      rows: [{ date: "2026-08-05", kalshi_price_close: 0.5, kalshi_r_price_close: 0.5 },
        { date: "2026-08-06", kalshi_price_close: 0.6, kalshi_r_price_close: null },
        { date: "2026-08-07", kalshi_price_close: 0.7, kalshi_r_price_close: 0.3 }] };
    const s = chartSeries(dd, null, NEWS_COL, l);
    expect(s.rep).toEqual([50, null, 30]);
    const defined = (i: number) => s.rep[i] !== null;
    expect([0, 1, 2].map(defined)).toEqual([true, false, true]);
    const d = line<number>().defined(defined).x((i) => i * 10).y((i) => s.rep[i] as number)([0, 1, 2])!;
    expect((d.match(/M/g) ?? []).length).toBe(2);  // two pieces: the null breaks the line
    expect(lastValueIndex(s.rep, 0, 1)).toBe(0);    // the latest value in view skips the null
  });
  it("a race without R columns has an all-null R line, hourly too", () => {
    const dh: DisplayHourly = { window: { start: "2026-08-05", end: "2026-08-05", days: 1 },
      columns: ["ts_utc", "kalshi/price_close", "kalshi/volume"], rows: [["2026-08-05T00:00:00Z", 0.4, 1]] };
    const h = hourlySeries(dh, l);
    expect(h.dem[0]).toBeCloseTo(40);
    expect(h.rep).toEqual([null]);
  });
  it("Texas hourly R equals the JSON column, leading nulls stay null in a race that has them", () => {
    const tx = load("tx-senate-2026"), ky = load("ky-senate-2026");
    const h = hourlySeries(tx.series.display_hourly!, partyLines(tx.candidates, tx.race.kalshi.followed_market, "SENATETX-26-R"));
    const ir = tx.series.display_hourly!.columns.indexOf("kalshi_r/price_close");
    expect(h.rep[100]).toBeCloseTo(Number(tx.series.display_hourly!.rows[100][ir]) * 100);
    const kh = hourlySeries(ky.series.display_hourly!, partyLines(ky.candidates, ky.race.kalshi.followed_market, "SENATELA-26-R"));
    expect(kh.rep.slice(0, 68).every((v) => v === null)).toBe(true);
    expect(kh.filledR!.size).toBe(ky.series.display_hourly!.opposing!.filled_hours!.n);
  });
});
