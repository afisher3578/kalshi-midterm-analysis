import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { IndexData, IndexDisplay } from "../src/types";
import { countChanged, DEFAULT_FILTERS, type Filters, MAP_MIN_N, mapValue, parseHash, passesPolls, pollClass,
  serializeHash, SOURCE_COL } from "../src/filters";

const index: IndexData = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../data/processed/index.json"), "utf-8"));
const fmt = (n: number) => String(Math.round(n));
const disp = (cols: Record<string, { total: number | null; n_days: number }>): IndexDisplay =>
  ({ window: { start: "2026-08-05", end: "2026-11-04", days: 92 }, ...cols });

describe("hash parse and serialize", () => {
  it("the default view is an empty hash, and an empty hash is the default view", () => {
    expect(serializeHash(DEFAULT_FILTERS)).toBe("");
    expect(parseHash("")).toEqual(DEFAULT_FILTERS);
    expect(parseHash("#")).toEqual(DEFAULT_FILTERS);
  });
  it("round trips every non-default choice and leaves defaults out", () => {
    const f: Filters = { ...DEFAULT_FILTERS, metric: "attention", polls: "few", source: "wikipedia" };
    const h = serializeHash(f);
    expect(h).toBe("#metric=attention&polls=few&source=wikipedia");
    expect(parseHash(h)).toEqual(f);
    expect(serializeHash({ ...DEFAULT_FILTERS, polls: "many" })).toBe("#polls=many");
  });
  it("accepts the example hash from the spec", () => {
    expect(parseHash("#state=TX&metric=attention&polls=few&source=wikipedia"))
      .toEqual({ state: "TX", type: "senate", metric: "attention", polls: "few", source: "wikipedia" });
    expect(parseHash("#state=tx").state).toBe("TX");
  });
  it("rejects unknown and disabled values and falls back to the default", () => {
    const f = parseHash("#state=FL&type=governor&metric=attention_rho&polls=medium&source=bluesky&group=talking");
    expect(f).toEqual(DEFAULT_FILTERS);
    expect(parseHash("#state=ZZ&type=house&metric=price_change&polls=&source=").state).toBe("TX");
    expect(parseHash("#metric=attention&polls=lots").polls).toBe("all");
    expect(parseHash("#metric=attention&polls=lots").metric).toBe("attention");
  });
});

describe("count differing from default", () => {
  it("counts the controls that differ", () => {
    expect(countChanged(DEFAULT_FILTERS)).toBe(0);
    expect(countChanged({ ...DEFAULT_FILTERS, metric: "attention" })).toBe(1);
    expect(countChanged({ ...DEFAULT_FILTERS, metric: "attention", polls: "many", source: "wikipedia" })).toBe(3);
    expect(countChanged(parseHash("#state=FL&type=governor"))).toBe(0);
  });
});

describe("polling classes", () => {
  it("under 10 is few, 10 or more is many, unknown is null", () => {
    expect(pollClass(0)).toBe("few");
    expect(pollClass(9)).toBe("few");
    expect(pollClass(10)).toBe("many");
    expect(pollClass(53)).toBe("many");
    expect(pollClass(null)).toBeNull();
    expect(pollClass(undefined)).toBeNull();
  });
  it("unknown counts pass only All", () => {
    expect(passesPolls("all", null)).toBe(true);
    expect(passesPolls("few", null)).toBe(false);
    expect(passesPolls("many", undefined)).toBe(false);
    expect(passesPolls("few", 1)).toBe(true);
    expect(passesPolls("many", 1)).toBe(false);
    expect(passesPolls("many", 10)).toBe(true);
  });
  it("classifies the committed races (Kentucky has 1 poll, Texas Senate 53)", () => {
    expect(pollClass(index.races["ky-senate-2026"].metrics?.polling_density)).toBe("few");
    expect(pollClass(index.races["tx-senate-2026"].metrics?.polling_density)).toBe("many");
  });
});

describe("map value", () => {
  it("volume: total contracts with n days", () => {
    const v = mapValue(disp({ kalshi_volume: { total: 1234.4, n_days: 92 } }), "volume", "news", fmt);
    expect(v).toEqual({ status: "ok", value: 1234.4, n: 92, text: "1234 contracts (n=92 days)" });
  });
  it("attention follows the source", () => {
    const d = disp({ [SOURCE_COL.news]: { total: 50, n_days: 30 }, [SOURCE_COL.wikipedia]: { total: 900, n_days: 92 } });
    expect(mapValue(d, "attention", "news", fmt).text).toBe("50 stories (n=30 days)");
    expect(mapValue(d, "attention", "wikipedia", fmt).text).toBe("900 pageviews (n=92 days)");
  });
  it("n under 20 days is insufficient data, never a number", () => {
    const v = mapValue(disp({ kalshi_volume: { total: 99, n_days: MAP_MIN_N - 1 } }), "volume", "news", fmt);
    expect(v.status).toBe("insufficient");
    expect(v.value).toBeNull();
    expect(v.n).toBe(19);
    expect(v.text).toBe("insufficient data (n=19 days, under 20)");
    expect(mapValue(disp({ kalshi_volume: { total: 99, n_days: 20 } }), "volume", "news", fmt).status).toBe("ok");
  });
  it("a missing column, no display block or zero days is no data", () => {
    const d = disp({ kalshi_volume: { total: 1, n_days: 92 } });
    expect(mapValue(d, "attention", "news", fmt)).toEqual({ status: "nodata", value: null, n: 0, text: "no news data" });
    expect(mapValue(undefined, "volume", "news", fmt).status).toBe("nodata");
    expect(mapValue(null, "attention", "wikipedia", fmt).text).toBe("no Wikipedia data");
    expect(mapValue(disp({ kalshi_volume: { total: null, n_days: 0 } }), "volume", "news", fmt).status).toBe("nodata");
  });
  it("committed index: volume for every race, news only for Texas Senate", () => {
    for (const r of Object.values(index.races)) {
      const v = mapValue(r.display, "volume", "news", fmt);
      expect(v.status).toBe("ok");
      expect(v.text).toMatch(/contracts \(n=\d+ days\)$/);
      expect(mapValue(r.display, "attention", "wikipedia", fmt).status).toBe("ok");
      expect(mapValue(r.display, "attention", "news", fmt).status).toBe(r.race_id === "tx-senate-2026" ? "ok" : "nodata");
    }
    expect(mapValue(index.races["tx-senate-2026"].display, "volume", "news", fmt).value).toBeCloseTo(42959694.59, 2);
  });
});
