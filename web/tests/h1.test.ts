import { describe, expect, it } from "vitest";
import { CHART_TITLE, chartTitle, REPO_URL, STATES } from "../src/config";
import { binScale, FADED_FILL, fmtCompact, hasLabel, labelValue, legendEntries, stateA11y, type StateCell } from "../src/map";

describe("compact formatter rounds half up on the decimal value", () => {
  it("6655 and its float neighbours read 6.66k, the bin edges of 0..6655 read 1.33k, 2.66k, 3.99k, 5.32k", () => {
    expect(fmtCompact(6655)).toBe("6.66k");
    expect(fmtCompact(6654.999999999999)).toBe("6.66k");
    expect(fmtCompact(6655 / 1000 * 1000)).toBe("6.66k");
    expect(fmtCompact(6.655)).toBe("6.66");
    expect([1331, 2662, 3993, 5324].map(fmtCompact)).toEqual(["1.33k", "2.66k", "3.99k", "5.32k"]);
    expect(fmtCompact(6654.4)).toBe("6.65k");
    expect(fmtCompact(0)).toBe("0");
    expect(fmtCompact(999.5)).toBe("1k");
    expect(fmtCompact(42959694.59)).toBe("43M");
    expect(fmtCompact(-6655)).toBe("−6.66k");
  });
  it("legend for News on Texas Senate (6,655 stories)", () => {
    expect(legendEntries(binScale([6655]), fmtCompact).map((e) => e.label)).toEqual(["0 to 1.33k", "1.33k to 2.66k",
      "2.66k to 3.99k", "3.99k to 5.32k", "5.32k to 6.66k", "coming soon"]);
    expect(FADED_FILL).toBe("var(--map-faded)");
  });
});

describe("chart heading and footer", () => {
  it("<State> <Office> Race <year>: ..., no space before the colon", () => {
    expect(CHART_TITLE).toBe("{state} {office} Race {year}: Kalshi price, Kalshi volume and media attention");
    expect(chartTitle("Texas", "Senate", "2026")).toBe("Texas Senate Race 2026: Kalshi price, Kalshi volume and media attention");
    expect(REPO_URL).toBe("https://github.com/afisher3578/kalshi-midterm-analysis");
  });
});

describe("only Texas has a label, a tooltip and a focus stop", () => {
  const cell = (code: string, o: Partial<StateCell> = {}): StateCell => ({ code, name: STATES[code], value: 7720000, status: "ok",
    text: "7.72M contracts (n=92 days)", raceId: `${code.toLowerCase()}-senate-2026`, filteredOut: false, active: false, ...o });
  const tx = cell("TX", { value: 6655, text: "6.66k stories (n=92 days)", active: true });
  it("Texas keeps its label with the value, its tooltip and its button", () => {
    expect(hasLabel(tx)).toBe(true);
    expect(labelValue(tx, fmtCompact)).toBe("6.66k");
    expect(stateA11y(tx, "TX")).toEqual({ title: "Texas: 6.66k stories (n=92 days)", role: "button",
      label: "Texas: 6.66k stories (n=92 days). Open the race.", pressed: true });
  });
  it("other states, with a race (OH 7.72M), with no data or with no race, get no label, tooltip, name or focus", () => {
    for (const c of [cell("OH"), cell("FL", { value: null, status: "nodata", text: "no news data" }),
      cell("AL", { value: null, status: "nodata", text: "no senate race", raceId: null }), undefined]) {
      expect(hasLabel(c)).toBe(false);
      expect(stateA11y(c, "TX")).toBeNull();
    }
  });
});
