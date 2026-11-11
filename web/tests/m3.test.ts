import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { IndexData, RaceData } from "../src/types";
import { byOffice, clampRange, column, densityBand, eventStudy, keepMask, lagCellRho, mapValue, outcomes, passesFilter,
  spearman, surprise, VOLUME, PRICE } from "../src/transforms";

const PROCESSED = resolve(import.meta.dirname, "../../data/processed");
const index: IndexData = JSON.parse(readFileSync(resolve(PROCESSED, "index.json"), "utf-8"));
const races: RaceData[] = readdirSync(PROCESSED).filter((n) => n.endsWith(".json") && n !== "index.json")
  .map((n) => JSON.parse(readFileSync(resolve(PROCESSED, n), "utf-8")));
const fmt = { int: (n: number) => String(Math.round(n)), two: (n: number) => n.toFixed(2), pct: (n: number) => `${Math.round(n * 100)}%` };

describe("lead-lag math in the page", () => {
  it("reproduces every pipeline daily lag cell vs volume surprise for every committed race", () => {
    let checked = 0;
    for (const d of races) {
      const dates = d.series.daily.rows.map((r) => String(r[0]));
      const excl = d.series.daily.rows.map((r) => r[1] === true);
      const keep = keepMask(dates, excl, d.window.start, d.window.end);
      const outs = outcomes(column(d.series.daily, PRICE), column(d.series.daily, VOLUME));
      for (const [name, e] of Object.entries(d.metrics.daily)) {
        if (e.status !== "computed") continue;
        const a = surprise(column(d.series.daily, name));
        for (const [okey, cells] of Object.entries(e.outcomes!)) {
          for (const [lag, cell] of Object.entries(cells)) {
            const r = lagCellRho(a, outs[okey as keyof typeof outs], keep, Number(lag));
            expect(r.n).toBe(cell.n);
            if (cell.rho === null) expect(r.rho).toBeNull();
            else expect(r.rho!).toBeCloseTo(cell.rho, 4);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(14);
  });
  it("blanks rho under 20 pairs and keeps n", () => {
    const a = Array.from({ length: 19 }, (_, i) => i);
    expect(spearman(a, a)).toEqual({ rho: null, n: 19 });
    expect(spearman([...a, 19], [...a, 19]).rho).toBeCloseTo(1, 12);
  });
  it("a sub-range keeps fewer days", () => {
    const d = races[0];
    const dates = d.series.daily.rows.map((r) => String(r[0]));
    const excl = d.series.daily.rows.map((r) => r[1] === true);
    const full = keepMask(dates, excl, d.window.start, d.window.end).filter(Boolean).length;
    const part = keepMask(dates, excl, dates[10], dates[30]).filter(Boolean).length;
    expect(part).toBe(21);
    expect(part).toBeLessThan(full);
  });
});

describe("filters and map values", () => {
  it("platform groups", () => {
    expect(passesFilter("wikipedia/pageviews_total", "looking", "all")).toBe(true);
    expect(passesFilter("bluesky/post_count", "looking", "all")).toBe(false);
    expect(passesFilter("bluesky/post_count", "talking", "bluesky")).toBe(true);
    expect(passesFilter("bluesky/post_count", "all", "wikipedia")).toBe(false);
  });
  it("clamps the window", () => {
    expect(clampRange(null, null, "2026-09-01", "2026-11-04")).toEqual(["2026-09-01", "2026-11-04"]);
    expect(clampRange("2026-08-01", "2026-10-01", "2026-09-01", "2026-11-04")).toEqual(["2026-09-01", "2026-10-01"]);
    expect(clampRange("2026-10-05", "2026-10-01", "2026-09-01", "2026-11-04")).toEqual(["2026-09-01", "2026-11-04"]);
  });
  it("density bands", () => {
    expect(densityBand(null)).toBeNull();
    expect(densityBand(3)).toBe("low");
    expect(densityBand(10)).toBe("medium");
    expect(densityBand(53)).toBe("high");
  });
  it("every map value of every race carries n, and n < 20 is insufficient data", () => {
    for (const r of Object.values(index.races)) {
      for (const metric of ["attention_total", "attention_rho", "price_change", "polling_density", "data_coverage"] as const) {
        const v = mapValue(r.metrics, metric, "wikipedia/pageviews_total", fmt);
        if (v.value === null) expect(v.text).toBe("insufficient data");
        else expect(v.text).toMatch(/n=\d+/);
        if (metric === "attention_rho" && v.value !== null) expect(v.n).toBeGreaterThanOrEqual(20);
      }
    }
    expect(mapValue(undefined, "attention_total", "wikipedia/pageviews_total", fmt).value).toBeNull();
  });
  it("Texas map values match the index", () => {
    const tx = index.races["tx-senate-2026"];
    const v = mapValue(tx.metrics, "attention_rho", "wikipedia/pageviews_total", fmt);
    expect(v.value).toBeCloseTo(0.2383, 4);
    expect(v.n).toBe(56);
  });
});

describe("default race per state", () => {
  it("orders offices senate, governor, house, national, then others, not alphabetically", () => {
    const rs = ["mayor", "national", "house", "governor", "senate", "attorney"].map((office) => ({ office, race_id: `xx-${office}` }));
    expect(rs.sort(byOffice).map((r) => r.office)).toEqual(["senate", "governor", "house", "national", "attorney", "mayor"]);
  });
  it("picks the Senate race for Texas, which also has a Governor race", () => {
    const tx = Object.values(index.races).filter((r) => r.state === "TX").sort(byOffice);
    expect(tx.length).toBeGreaterThan(1);
    expect(tx[0].race_id).toBe("tx-senate-2026");
  });
});

describe("event study", () => {
  it("averages offsets around anchors with n per offset", () => {
    const s = [0, 1, 2, 3, 4, 5, 6];
    const keep = s.map(() => true);
    const out = eventStudy([1, 5], s, keep, 2);
    expect(out.find((p) => p.offset === 0)).toEqual({ offset: 0, mean: 3, n: 2 });
    expect(out.find((p) => p.offset === -2)).toEqual({ offset: -2, mean: 3, n: 1 });
    expect(out.find((p) => p.offset === 2)).toEqual({ offset: 2, mean: 3, n: 1 });
  });
});
