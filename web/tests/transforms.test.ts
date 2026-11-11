import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Num, RaceData } from "../src/types";
import { attentionColumns, column, excludedSpans, extremes, PRICE, raceIdFromSearch, surprise, toCsv, VOLUME,
  zscore } from "../src/transforms";

const data: RaceData = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../data/processed/tx-senate-2026.json"), "utf-8"));

// Spearman with average ranks, as in raceattn/metrics/lags.py, used only to cross-check our surprise.
function ranks(v: number[]): number[] {
  const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
  const r = new Array(v.length).fill(0);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
    for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function spearman(a: Num[], b: Num[]): [number, number] {
  const p = a.map((x, i) => [x, b[i]]).filter(([x, y]) => x !== null && y !== null) as number[][];
  const ra = ranks(p.map((q) => q[0])), rb = ranks(p.map((q) => q[1]));
  const n = p.length, ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return [num / Math.sqrt(da * db), n];
}

describe("surprise", () => {
  it("matches the spec formula on a small series", () => {
    const s = surprise([1, 1, 1, 1, 1, 1, 1, 3]);
    expect(s.slice(0, 7)).toEqual([null, null, null, null, null, null, null]);
    expect(s[7]).toBeCloseTo(Math.log(4 / 2), 12);
  });
  it("is null when any of the previous 7 is missing", () => {
    expect(surprise([1, null, 1, 1, 1, 1, 1, 1, 1])[8]).toBeNull();
    expect(surprise([1, 1, 1, 1, 1, 1, 1, 1, 1])[8]).toBe(0);
  });
  it("supports the hourly same-slot step", () => {
    const s = surprise(Array.from({ length: 24 * 8 }, (_, i) => (i === 24 * 7 ? 9 : 1)), 7, 24);
    expect(s[24 * 7]).toBeCloseTo(Math.log(10 / 2), 12);
    expect(s[24 * 7 - 1]).toBeNull();
  });
  it("reproduces the pipeline's lag-0 rho for Wikipedia total vs volume surprise", () => {
    const keep = data.series.daily.rows.map((r) => r[1] === false);
    const mask = (v: Num[]) => v.map((x, i) => (keep[i] ? x : null));
    const a = mask(surprise(column(data.series.daily, "wikipedia/pageviews_total")));
    const o = mask(surprise(column(data.series.daily, VOLUME)));
    const [rho, n] = spearman(a, o);
    const cell = data.metrics.daily["wikipedia/pageviews_total"].outcomes!.volume_surprise["0"];
    expect(n).toBe(cell.n);
    expect(rho).toBeCloseTo(cell.rho!, 4);
  });
});

describe("zscore", () => {
  it("fits on kept values only and scales every value", () => {
    const z = zscore([1, 2, 3, 100], [true, true, true, false]);
    expect(z[1]).toBeCloseTo(0, 12);
    expect(z[0]).toBeCloseTo(-1, 12);
    expect(z[3]).toBeCloseTo(98, 12);
  });
  it("keeps nulls and returns nulls when sd is 0", () => {
    expect(zscore([1, null, 3], [true, true, true])[1]).toBeNull();
    expect(zscore([2, 2, 2], [true, true, true])).toEqual([null, null, null]);
  });
});

describe("helpers", () => {
  it("merges consecutive excluded days", () => {
    const s = excludedSpans(["2026-11-04", "2026-11-03"]);
    expect(s).toHaveLength(1);
    expect(s[0].start.toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(s[0].end.toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });
  it("finds extremes and ignores nulls", () => {
    const e = extremes([null, 3, 1, null, 5, 2]);
    expect(e.min).toEqual({ v: 1, i: 2 });
    expect(e.max).toEqual({ v: 5, i: 4 });
    expect(e.last).toEqual({ v: 2, i: 5 });
    expect(e.count).toBe(4);
  });
  it("writes CSV with header, blanks for null and quoting", () => {
    expect(toCsv({ columns: ["a", "b"], rows: [[1, null], ["x,y", true]] })).toBe('a,b\n1,\n"x,y",true\n');
  });
  it("reads the race id from the query string", () => {
    expect(raceIdFromSearch("?race=ga-senate-2026", "tx")).toBe("ga-senate-2026");
    expect(raceIdFromSearch("?race=../etc", "tx")).toBe("tx");
    expect(raceIdFromSearch("", "tx")).toBe("tx");
  });
  it("lists the Texas attention series and Kalshi columns", () => {
    expect(attentionColumns(data)).toHaveLength(5); // Wikipedia total, three pages, Bluesky (M2)
    expect(column(data.series.daily, PRICE)).toHaveLength(65);
  });
});
