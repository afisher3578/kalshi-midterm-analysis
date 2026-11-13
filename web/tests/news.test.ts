import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RaceData, Table } from "../src/types";
import { analysisWindow, type AuditRow, codedPhase, countTile, dailyRatio, dailyShare, hasMcData, headlinesByDay,
  meanOver, meanShare, mcColumns, newsCsv, newsMetrics, precision, seriesName, topDays, valuesOn, wilson,
  windowDays } from "../src/news";

const tx: RaceData = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../data/processed/tx-senate-2026.json"), "utf-8"));

// A small daily table: 2026-09-01..09-06, national only. 09-04 is an explicit zero, 09-05 has no value (missing),
// 09-06 is absent from the table (missing too).
const N = (q: string, k?: string) => seriesName(q, "national", k);
const table: Table = {
  columns: ["date", N("race_either"), N("talarico_race"), N("paxton_race"), N("any_either"), N("talarico_share"),
    N("core_vs_broad"), N("race_either", "ratio")],
  rows: [
    ["2026-09-01", 10, 6, 5, 20, 6 / 11, 0.5, 0.001],
    ["2026-09-02", 30, 10, 25, 40, 10 / 35, 0.75, 0.002],
    ["2026-09-03", 30, 20, 10, 60, 2 / 3, 0.5, 0.002],
    ["2026-09-04", 0, 0, 0, 5, null, 0, 0],
    ["2026-09-05", null, null, null, null, null, null, null],
  ],
};
const WIN: [string, string] = ["2026-09-01", "2026-09-06"];

describe("Media Cloud tiles", () => {
  it("totals, mean per day and peak day (earliest date wins a tie)", () => {
    const t = countTile(table, N("race_either"), WIN);
    expect(t.windowDays).toBe(6);
    expect(t.total).toBe(70);
    expect(t.presentDays).toBe(4);
    expect(t.mean).toBe(17.5);
    expect(t.peak).toEqual({ date: "2026-09-02", count: 30 });
  });
  it("keeps explicit zeros apart from missing days (null cell and absent date)", () => {
    const t = countTile(table, N("race_either"), WIN);
    expect(t.zeroDays).toBe(1);
    expect(t.missingDays).toBe(2);
    expect(t.missingDates).toEqual(["2026-09-05", "2026-09-06"]);
  });
  it("a series with no values gives null totals, not zeros", () => {
    const t = countTile(table, seriesName("race_either", "texas_local"), WIN);
    expect(t.total).toBeNull();
    expect(t.mean).toBeNull();
    expect(t.peak).toBeNull();
    expect(t.missingDays).toBe(6);
  });
  it("mean Talarico share leaves out the days where it is undefined and reports n", () => {
    const s = meanShare(table, "national", WIN);
    expect(s.from).toBe("derived series");
    expect(s.n).toBe(3);
    expect(s.undefinedDays).toBe(3);
    expect(s.mean!).toBeCloseTo((6 / 11 + 10 / 35 + 2 / 3) / 3, 12);
  });
  it("computes the same share from the counts when the derived column is absent", () => {
    const t2: Table = { columns: table.columns.filter((c) => c !== N("talarico_share")),
      rows: table.rows.map((r) => r.filter((_, i) => table.columns[i] !== N("talarico_share"))) };
    const s = meanShare(t2, "national", WIN);
    expect(s.from).toBe("counts");
    expect(s.n).toBe(3);
    expect(s.mean!).toBeCloseTo(meanShare(table, "national", WIN).mean!, 12);
  });
  it("daily share and ratio are null on a zero denominator or a missing input, never 0 or Infinity", () => {
    expect(dailyShare([1, 0, null, 3], [1, 0, 2, null])).toEqual([0.5, null, null, null]);
    expect(dailyRatio([10, 0, 3, null], [20, 0, null, 4])).toEqual([0.5, null, null, null]);
  });
  it("core vs broad from the table matches race_either / any_either", () => {
    const days = windowDays(...WIN);
    const r = dailyRatio(valuesOn(table, N("race_either"), days), valuesOn(table, N("any_either"), days));
    expect(r.slice(0, 4)).toEqual([0.5, 0.75, 0.5, 0]);
    expect(valuesOn(table, N("core_vs_broad"), days).slice(0, 4)).toEqual(r.slice(0, 4));
    expect(meanOver(table, N("core_vs_broad"), WIN)).toEqual({ mean: 1.75 / 4, n: 4, windowDays: 6 });
  });
  it("top days: largest first, ties by date, missing days left out", () => {
    expect(topDays(table, N("race_either"), WIN, 3)).toEqual([{ date: "2026-09-02", count: 30 },
      { date: "2026-09-03", count: 30 }, { date: "2026-09-01", count: 10 }]);
  });
  it("analysis window from the query config, else the default", () => {
    expect(analysisWindow(null)).toEqual(["2026-09-01", "2026-11-02"]);
    expect(analysisWindow({ phases: { analysis: ["2026-09-10", "2026-10-01"] } } as never)).toEqual(["2026-09-10", "2026-10-01"]);
  });
});

describe("precision and Wilson match raceattn (Python) on a small case", () => {
  const row = (query: string, collection: string, relevant: string, i: number): AuditRow => ({ query, collection,
    story_id: `${query}-${i}`, publish_date: "2026-10-01T10:00:00", source: "s", title: `t${i}`, url: `https://example.invalid/${query}/${collection}/${i}`, relevant });
  const rows = [
    ...[...Array(17).fill("yes"), ...Array(3).fill("no"), "unclear", "unclear", "", "maybe"].map((v, i) => row("talarico_race", "national", v, i)),
    ...[...Array(8).fill("yes"), ...Array(4).fill("no")].map((v, i) => row("paxton_race", "national", v, i)),
    ...["unclear", ""].map((v, i) => row("paxton_race", "texas_local", v, i)),
  ];
  it("same groups, counts, precision and interval as raceattn.mediacloud.precision", () => {
    // values printed by `.venv/bin/python -c "from raceattn.mediacloud import precision; ..."` on the same rows
    const py = [
      { query: "paxton_race", collection: "national", rows: 12, yes: 8, no: 4, unclear: 0, uncoded: 0, invalid: 0, coded: 12,
        precision: 0.6666666666666666, wilson95: [0.39062208887279953, 0.8618799089087867] },
      { query: "paxton_race", collection: "texas_local", rows: 2, yes: 0, no: 0, unclear: 1, uncoded: 1, invalid: 0, coded: 0,
        precision: null, wilson95: [null, null] },
      { query: "talarico_race", collection: "national", rows: 24, yes: 17, no: 3, unclear: 2, uncoded: 1, invalid: 1, coded: 20,
        precision: 0.85, wilson95: [0.6395811352592431, 0.9476312541037835] },
    ];
    const got = precision(rows);
    expect(got.map(({ wilson95, precision: p, ...rest }) => rest)).toEqual(py.map(({ wilson95, precision: p, ...rest }) => rest));
    got.forEach((g, i) => {
      if (py[i].precision === null) expect(g.precision).toBeNull();
      else expect(g.precision!).toBeCloseTo(py[i].precision!, 12);
      if (py[i].wilson95[0] === null) expect(g.wilson95).toEqual([null, null]);
      else { expect(g.wilson95[0]!).toBeCloseTo(py[i].wilson95[0]!, 12); expect(g.wilson95[1]!).toBeCloseTo(py[i].wilson95[1]!, 12); }
    });
  });
  it("Wilson against Newcombe (1998) Table I, as the Python test", () => {
    const [a, b] = wilson(81, 263);
    expect(a!).toBeCloseTo(0.2552885198782742, 12);
    expect(b!).toBeCloseTo(0.36620957698280004, 12);
    expect(wilson(0, 20)[0]).toBe(0);
    expect(wilson(0, 20)[1]!).toBeCloseTo(0.16112515805281938, 12);
    expect(wilson(5, 0)).toEqual([null, null]);
  });
  it("reports the analysis audit when it is coded, else tuning, else nothing", () => {
    const blank = rows.map((r) => ({ ...r, relevant: "" }));
    expect(codedPhase({ available: true, phases: { analysis: { path: "a", rows: blank }, tuning: { path: "t", rows } } })?.phase).toBe("tuning");
    expect(codedPhase({ available: true, phases: { analysis: { path: "a", rows }, tuning: { path: "t", rows } } })?.phase).toBe("analysis");
    expect(codedPhase({ available: true, phases: { analysis: { path: "a", rows: blank } } })).toBeNull();
    expect(codedPhase(null)).toBeNull();
  });
  it("headlines: up to three per day, national first, no duplicate URL", () => {
    const h = headlinesByDay({ available: true, phases: { analysis: { path: "a", rows } } }, ["2026-10-01", "2026-10-02"]);
    expect(h.get("2026-10-01")!.length).toBe(3);
    expect(h.get("2026-10-01")!.every((r) => r.collection === "national")).toBe(true);
    expect(h.get("2026-10-02")).toBeUndefined();
  });
});

describe("downloads", () => {
  it("CSV: date plus every Media Cloud column, missing as blank", () => {
    const csv = newsCsv(table, mcColumns(table));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(["date", ...table.columns.slice(1)].join(","));
    expect(lines).toHaveLength(6);
    expect(lines[4].startsWith("2026-09-04,0,0,0,5,,0,0")).toBe(true);
    expect(lines[5]).toBe("2026-09-05,,,,,,,");
  });
  it("metrics JSON carries every tile value with its definition and n", () => {
    const m = newsMetrics(table, ["national", "texas_local"], WIN, null, false);
    expect(m.collections.national.total_stories.total).toBe(70);
    expect(m.collections.national.share.n).toBe(3);
    expect(m.collections.texas_local.total_stories.total).toBeNull();
    expect(m.precision).toBeNull();
    expect(Object.keys(m.definitions)).toEqual(expect.arrayContaining(["total_stories", "talarico_share", "precision", "missing_days"]));
  });
});

describe("the committed Texas JSON", () => {
  it("has the live Media Cloud series for both collections (MC3), so the news view shows data", () => {
    const cols = mcColumns(tx.series.daily);
    for (const q of ["talarico_race", "paxton_race", "race_either", "race_both", "talarico_any", "paxton_any", "headline_either", "any_either"]) {
      for (const c of ["national", "texas_local"]) expect(cols).toEqual(expect.arrayContaining([`news_mediacloud/${q}/${c}`]));
    }
    expect(hasMcData(tx.series.daily)).toBe(true);
    expect(tx.skipped?.news_mediacloud).toBeUndefined();
  });
});
