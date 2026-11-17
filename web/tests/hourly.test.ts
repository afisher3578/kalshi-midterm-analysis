import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DisplayHourly, RaceData } from "../src/types";
import { addDays, attentionNote, axisTitle, CARRIED, chartSeries, dailyToSteps, dayTotals, fmtHour, granularityFor,
  HOURLY_MAX_DAYS, hourlyRange, hourlySeries, hourNote, kalshiLabel, legendText, NO_TRADES, quickRanges, rangeDays,
  zoomRange } from "../src/display";

const load = (id: string): RaceData =>
  JSON.parse(readFileSync(resolve(__dirname, `../../data/processed/${id}.json`), "utf-8"));
const H = Date.parse;

describe("granularityFor", () => {
  it("is hourly for 14 days or fewer, daily above", () => {
    expect(HOURLY_MAX_DAYS).toBe(14);
    expect(granularityFor("2026-10-01", addDays("2026-10-01", 12))).toBe("hourly");  // 13 days
    expect(granularityFor("2026-10-01", "2026-10-14")).toBe("hourly");               // 14 days
    expect(granularityFor("2026-10-01", "2026-10-15")).toBe("daily");                // 15 days
    expect(granularityFor("2026-11-03", "2026-11-03")).toBe("hourly");               // a single day
    expect(granularityFor("2026-08-05", "2026-11-04")).toBe("daily");                // the full window
    expect(rangeDays("2026-08-05", "2026-11-04")).toBe(92);
  });
});

const tiny: DisplayHourly = {
  window: { start: "2026-08-05", end: "2026-08-07", days: 3 },
  columns: ["ts_utc", "kalshi/price_close", "kalshi/volume"],
  rows: [
    ["2026-08-05T00:00:00Z", 0.4, 1], ["2026-08-05T01:00:00Z", 0.41, 2], ["2026-08-05T23:00:00Z", 0.42, 3],
    ["2026-08-06T00:00:00Z", 0.5, 10], ["2026-08-06T12:00:00Z", 0.5, 0], ["2026-08-06T23:00:00Z", 0.55, 5],
    ["2026-08-07T00:00:00Z", 0.6, 7],
  ],
  filled_hours: { n: 1, hours: ["2026-08-06T12:00:00Z"] },
  forward_filled_null_price: { n: 1, hours: ["2026-08-06T23:00:00Z"] },
};

describe("hourly rows for a range", () => {
  it("takes the start date's 00:00Z hour through the end date's last hour (UTC day = ts[:10])", () => {
    const h = hourlySeries(tiny);
    expect(h.price[0]).toBeCloseTo(40);
    expect(hourlyRange(h.ts, "2026-08-06", "2026-08-06")).toEqual([3, 5]);
    expect(hourlyRange(h.ts, "2026-08-05", "2026-08-06")).toEqual([0, 5]);
    expect(hourlyRange(h.ts, "2026-08-07", "2026-08-07")).toEqual([6, 6]);
    expect(hourlyRange(h.ts, "2026-08-08", "2026-08-09")).toBeNull();
  });

  it("gives 24 hours per day in the committed Texas JSON, and the window end's partial day", () => {
    const h = hourlySeries(load("tx-senate-2026").series.display_hourly!);
    const [lo, hi] = hourlyRange(h.ts, "2026-10-28", "2026-11-03")!;
    expect(hi - lo + 1).toBe(7 * 24);
    expect(h.ts[lo]).toBe("2026-10-28T00:00:00Z");
    expect(h.ts[hi]).toBe("2026-11-03T23:00:00Z");
    const end = hourlyRange(h.ts, "2026-11-04", "2026-11-04")!;
    expect(h.ts[end[1]]).toBe("2026-11-04T05:00:00Z");
  });
});

describe("dayTotals", () => {
  it("sums the day's hourly volume and takes its last price", () => {
    const h = hourlySeries(tiny);
    const d = dayTotals(h, "2026-08-06");
    expect(d.hours).toBe(3);
    expect(d.volume).toBe(15);
    expect(d.close).toBeCloseTo(55);
    expect(dayTotals(h, "2026-09-01")).toEqual({ hours: 0, volume: 0, close: null });
  });

  it("reconciles with series.display_daily for every day of the Texas JSON", () => {
    const data = load("tx-senate-2026");
    const h = hourlySeries(data.series.display_hourly!);
    const s = chartSeries(data.series.display_daily!);
    s.dates.forEach((d, i) => {
      const t = dayTotals(h, d);
      expect(t.volume).toBeCloseTo(s.volume[i]!, 4);
      expect(t.close).toBeCloseTo(s.price[i]!, 6);
    });
  });
});

describe("dailyToSteps", () => {
  it("puts a point at each day's 00:00Z and a last one at the end of the last day", () => {
    const p = dailyToSteps([{ date: "2026-11-02", v: 5 }, { date: "2026-11-03", v: 8 }]);
    expect(p).toEqual([{ t: H("2026-11-02T00:00:00Z"), v: 5 }, { t: H("2026-11-03T00:00:00Z"), v: 8 },
      { t: H("2026-11-04T00:00:00Z"), v: 8 }]);
  });

  it("makes a null day a gap and closes the run before it at 24:00", () => {
    const p = dailyToSteps([{ date: "2026-11-01", v: 1 }, { date: "2026-11-02", v: null }, { date: "2026-11-03", v: 0 }]);
    expect(p).toEqual([
      { t: H("2026-11-01T00:00:00Z"), v: 1 }, { t: H("2026-11-02T00:00:00Z"), v: 1 },
      { t: H("2026-11-02T00:00:00Z"), v: null },
      { t: H("2026-11-03T00:00:00Z"), v: 0 }, { t: H("2026-11-04T00:00:00Z"), v: 0 },
    ]);
    expect(dailyToSteps([])).toEqual([]);
  });

  it("only changes value at 00:00 UTC", () => {
    const p = dailyToSteps([{ date: "2026-10-30", v: 3 }, { date: "2026-10-31", v: 4 }, { date: "2026-11-01", v: 2 }]);
    for (const q of p) expect(q.t % 86_400_000).toBe(0);
  });
});

describe("readout and labels", () => {
  it("writes an hour in UTC", () => {
    expect(fmtHour("2026-11-03T14:00:00Z")).toBe("Nov 3, 2026, 14:00 UTC");
    expect(fmtHour("2026-08-05T00:00:00Z")).toBe("Aug 5, 2026, 00:00 UTC");
  });

  it("says when an hour had no trades or a carried price", () => {
    const h = hourlySeries(tiny);
    expect(hourNote("2026-08-06T12:00:00Z", h)).toBe(NO_TRADES);
    expect(NO_TRADES).toBe("no trades this hour, last price carried forward");
    expect(hourNote("2026-08-06T23:00:00Z", h)).toBe(CARRIED);
    expect(hourNote("2026-08-06T00:00:00Z", h)).toBe("");
  });

  it("a filled hour in the Texas JSON has volume 0 and the previous hour's price", () => {
    const dh = load("tx-senate-2026").series.display_hourly!;
    const h = hourlySeries(dh);
    const ts = dh.filled_hours!.hours[dh.filled_hours!.hours.length - 1];
    const i = h.ts.indexOf(ts);
    expect(hourNote(ts, h)).toBe(NO_TRADES);
    expect(h.volume[i]).toBe(0);
    expect(h.price[i]).toBe(h.price[i - 1]);
  });

  it("legend and axis say per hour for volume when hourly; attention stays per day", () => {
    expect(legendText("volume", "news", "hour").desc).toBe("contracts traded per hour");
    expect(legendText("volume", "news", "day").desc).toBe("contracts traded per day");
    expect(axisTitle("volume", "news", "hour")).toBe("Volume per hour");
    expect(axisTitle("volume", "news", "day")).toBe("Volume per day");
    expect(axisTitle("news", "news", "hour")).toBe("Stories");
    expect(axisTitle("news", "wikipedia", "hour")).toBe("Pageviews");
    expect(kalshiLabel("hour")).toBe("Kalshi: hourly");
    expect(kalshiLabel("day")).toBe("Kalshi: daily");
    expect(attentionNote("news")).toBe("Attention is daily: Media Cloud gives no time of day.");
    expect(attentionNote("wikipedia")).toBe("Attention is daily: Wikipedia pageviews are daily.");
  });
});

describe("quick ranges and zoom", () => {
  const w = { start: "2026-08-05", end: "2026-11-04" };

  it("derives the election week from the election date and the last 14 days from the window", () => {
    const q = quickRanges(w, "2026-11-03");
    expect(q.map((r) => `${r.id} ${r.from}..${r.to}`)).toEqual(["election7 2026-10-28..2026-11-03",
      "last14 2026-10-22..2026-11-04", "full 2026-08-05..2026-11-04"]);
    expect(quickRanges(w, "2026-08-06")[0]).toMatchObject({ from: "2026-08-05", to: "2026-08-06" });
  });

  it("zooms in whole days around the anchor and stays inside the window", () => {
    expect(zoomRange("2026-08-05", "2026-11-04", w.start, w.end, 0.5, 0.5)).toEqual({ from: "2026-08-28", to: "2026-10-12" });
    expect(zoomRange("2026-10-28", "2026-11-03", w.start, w.end, 0.5, 1)).toEqual({ from: "2026-10-31", to: "2026-11-03" });
    expect(zoomRange("2026-10-22", "2026-11-04", w.start, w.end, 4, 1)).toMatchObject({ to: "2026-11-04" });
    expect(zoomRange("2026-08-05", "2026-11-04", w.start, w.end, 3, 0.5)).toEqual({ from: w.start, to: w.end });
    expect(zoomRange("2026-11-03", "2026-11-03", w.start, w.end, 0.5, 0.5)).toEqual({ from: "2026-11-03", to: "2026-11-03" });
    expect(zoomRange("2026-10-01", "2026-10-02", w.start, w.end, 1.1, 0)).toEqual({ from: "2026-10-01", to: "2026-10-03" });
  });
});
