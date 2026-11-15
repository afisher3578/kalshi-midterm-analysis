import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DisplayDaily, RaceData } from "../src/types";
import { canHide, chartSeries, checkRange, clampDate, coverageCount, indexed, isIsoDate, NEWS_COL } from "../src/display";
import { formatValue } from "../src/linechart";

const load = (id: string): RaceData =>
  JSON.parse(readFileSync(resolve(__dirname, `../../data/processed/${id}.json`), "utf-8"));

const tiny: DisplayDaily = {
  window: { start: "2026-08-05", end: "2026-08-08", days: 4 },
  columns: ["date", "kalshi_price_close", "kalshi_volume", NEWS_COL],
  news: [NEWS_COL],
  rows: [
    { date: "2026-08-05", kalshi_price_close: 0.48, kalshi_volume: 10, [NEWS_COL]: 3 },
    { date: "2026-08-06", kalshi_price_close: null, kalshi_volume: 0, [NEWS_COL]: null },
    { date: "2026-08-07", kalshi_price_close: 0.5, kalshi_volume: null, [NEWS_COL]: 0 },
    { date: "2026-08-08", kalshi_price_close: 0.487, kalshi_volume: 4.5 },
  ],
};

describe("chartSeries", () => {
  it("reads price as percent, keeps nulls as gaps and zeros as zeros", () => {
    const s = chartSeries(tiny);
    expect(s.dates).toEqual(["2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"]);
    expect(s.price[0]).toBeCloseTo(48);
    expect(s.price[1]).toBeNull();
    expect(s.price[3]).toBeCloseTo(48.7);
    expect(s.volume).toEqual([10, 0, null, 4.5]);
    expect(s.news).toEqual([3, null, 0, null]);
  });

  it("takes news from another block by date (the demo fixture)", () => {
    const demo: DisplayDaily = { ...tiny, rows: [{ date: "2026-08-07", [NEWS_COL]: 9 }, { date: "2026-08-05", [NEWS_COL]: 1 }] };
    expect(chartSeries(tiny, demo).news).toEqual([1, null, 9, null]);
  });

  it("matches the committed Texas JSON", () => {
    const dd = load("tx-senate-2026").series.display_daily!;
    const s = chartSeries(dd);
    expect(s.dates.length).toBe(92);
    expect(s.dates[0]).toBe("2026-08-05");
    expect(s.dates[91]).toBe("2026-11-04");
    const i = s.dates.indexOf("2026-09-15");
    const row = dd.rows.find((r) => r.date === "2026-09-15")!;
    expect(s.price[i]).toBeCloseTo(Number(row.kalshi_price_close) * 100);
    expect(s.volume[i]).toBe(row.kalshi_volume);
    expect(s.news[i]).toBe(row[NEWS_COL]);
  });

  it("keeps Kentucky's missing Kalshi days as nulls and has no news", () => {
    const dd = load("ky-senate-2026").series.display_daily!;
    const s = chartSeries(dd);
    for (const d of dd.coverage!.kalshi_price_close.missing_days) expect(s.price[s.dates.indexOf(d)]).toBeNull();
    for (const d of dd.coverage!.kalshi_volume.missing_days) expect(s.volume[s.dates.indexOf(d)]).toBeNull();
    expect(coverageCount(s.news)).toEqual({ n: 0, m: 92 });
  });
});

describe("coverageCount", () => {
  it("counts non-null days out of all days", () => {
    expect(coverageCount([1, null, 0, 2])).toEqual({ n: 3, m: 4 });
    expect(coverageCount([])).toEqual({ n: 0, m: 0 });
  });
  it("is 92 of 92 for Texas", () => {
    expect(coverageCount(chartSeries(load("tx-senate-2026").series.display_daily!).news)).toEqual({ n: 92, m: 92 });
  });
});

describe("indexed", () => {
  it("maps min to 0 and max to 100 over the range, nulls stay null", () => {
    expect(indexed([2, null, 4, 6])).toEqual([0, null, 50, 100]);
  });
  it("uses only the given index range and blanks values outside it", () => {
    expect(indexed([100, 2, 4, 6, -5], 1, 3)).toEqual([null, 0, 50, 100, null]);
  });
  it("maps a flat series to 50 and an all-null series to nulls", () => {
    expect(indexed([3, 3, null])).toEqual([50, 50, null]);
    expect(indexed([null, null])).toEqual([null, null]);
  });
});

describe("date range", () => {
  const MIN = "2026-08-05", MAX = "2026-11-04";
  it("accepts the full window and any inner range", () => {
    expect(checkRange(MIN, MAX, MIN, MAX)).toEqual({ ok: true, from: MIN, to: MAX });
    expect(checkRange("2026-09-15", "2026-09-15", MIN, MAX).ok).toBe(true);
  });
  it("rejects dates outside the window", () => {
    const a = checkRange("2026-08-04", MAX, MIN, MAX);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error).toContain("before 2026-08-05");
    const b = checkRange(MIN, "2026-11-05", MIN, MAX);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toContain("after 2026-11-04");
  });
  it("rejects start after end and non-dates", () => {
    const a = checkRange("2026-10-01", "2026-09-01", MIN, MAX);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error).toContain("after end date");
    expect(checkRange("", MAX, MIN, MAX).ok).toBe(false);
    expect(checkRange("2026-02-30", MAX, MIN, MAX).ok).toBe(false);
  });
  it("validates ISO dates and clamps", () => {
    expect(isIsoDate("2026-11-04")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("11/04/2026")).toBe(false);
    expect(clampDate("2026-01-01", MIN, MAX)).toBe(MIN);
    expect(clampDate("2027-01-01", MIN, MAX)).toBe(MAX);
    expect(clampDate("2026-09-01", MIN, MAX)).toBe("2026-09-01");
  });
});

describe("toggles", () => {
  it("never lets the last visible series be hidden", () => {
    expect(canHide({ price: true, volume: true, news: false }, "price")).toBe(true);
    expect(canHide({ price: true, volume: false, news: false }, "price")).toBe(false);
    expect(canHide({ price: false, volume: false, news: true }, "news")).toBe(false);
    expect(canHide({ price: false, volume: false, news: true }, "price")).toBe(true);  // already off
  });
});

describe("readout values", () => {
  it("formats each series the way the readout prints it", () => {
    expect(formatValue("price", 48)).toBe("48.0%");
    expect(formatValue("price", 48.7)).toBe("48.7%");
    expect(formatValue("volume", 57848.490000000005)).toBe("57,848.49 contracts");
    expect(formatValue("news", 34)).toBe("34 stories");
    expect(formatValue("news", null)).toBe("no data");
  });
});
