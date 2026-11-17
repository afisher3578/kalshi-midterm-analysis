import { describe, expect, it } from "vitest";
import { format } from "d3";
import { MAP_TITLE, MEDIA_ATTENTION_DEF, SUBTITLE, TITLE } from "../src/config";
import { MAP_MIN_N, mapValue } from "../src/filters";
import { MOON, SUN, themeIcon } from "../src/icons";
import { binScale, FADED_FILL, fillOf, labelValue, legendEntries, RAMP, type StateCell } from "../src/map";

const fmt = format(".3~s");
const cell = (o: Partial<StateCell>): StateCell => ({ code: "TX", name: "Texas", value: 42959694.59, status: "ok",
  text: "43M contracts (n=92 days)", raceId: "tx-senate-2026", filteredOut: false, active: true, ...o });

describe("G1 copy", () => {
  it("title, subtitle, map title and the media attention definition are exact", () => {
    expect(TITLE).toBe("2026 U.S. Midterms");
    expect(SUBTITLE).toBe("Kalshi results and media attention");
    expect(MAP_TITLE).toBe("Kalshi volume by state and media attention");
    expect(MEDIA_ATTENTION_DEF).toBe("Media attention is how often the race appears in the news each day, counted as "
      + "stories that mention the candidates or race.");
  });
});

describe("map legend", () => {
  it("five bins labeled from the data, then coming soon", () => {
    const scale = binScale([42959694.59, 1_000_000, 250_000]);
    const e = legendEntries(scale, fmt);
    expect(e.map((x) => x.label)).toEqual(["0 to 8.59M", "8.59M to 17.2M", "17.2M to 25.8M", "25.8M to 34.4M",
      "34.4M to 43M", "coming soon"]);
    expect(e.map((x) => x.fill)).toEqual([...RAMP, FADED_FILL]);
    expect(e.map((x) => x.faded)).toEqual([false, false, false, false, false, true]);
    expect(e.some((x) => /no data|insufficient|polling/.test(x.label))).toBe(false);
  });
  it("labels follow the data, never fixed", () => {
    expect(legendEntries(binScale([500, 100]), fmt)[4].label).toBe("400 to 500");
  });
  it("no scale: only coming soon", () => {
    expect(legendEntries(null, fmt)).toEqual([{ fill: FADED_FILL, label: "coming soon", faded: true }]);
  });
});

describe("map fill and labels", () => {
  const scale = binScale([42959694.59]);
  it("an open state with a value gets its bin color", () => {
    expect(fillOf(cell({}), scale)).toBe("var(--map-5)");
  });
  it("no race, no data, insufficient, filtered and coming soon states all get the faded fill", () => {
    const faded = [undefined, cell({ status: "nodata", value: null, raceId: null }), cell({ status: "nodata", value: null }),
      cell({ status: "insufficient", value: null }), cell({ filteredOut: true }), cell({ active: false })];
    for (const c of faded) expect(fillOf(c, scale)).toBe(FADED_FILL);
    expect(fillOf(cell({}), null)).toBe(FADED_FILL);
  });
  it("the on-map label is the postal code only for no data, insufficient and filtered", () => {
    expect(labelValue(cell({ status: "nodata", value: null }), fmt)).toBeNull();
    expect(labelValue(cell({ status: "insufficient", value: null }), fmt)).toBeNull();
    expect(labelValue(cell({ filteredOut: true }), fmt)).toBeNull();
    expect(labelValue(cell({}), fmt)).toBe("43M");
  });
  it("a value from under 20 days never renders as a number", () => {
    const v = mapValue({ window: { start: "2026-08-05", end: "2026-11-04", days: 92 },
      kalshi_volume: { total: 12345, n_days: MAP_MIN_N - 1 } }, "volume", "news", fmt);
    const c = cell({ value: v.value, status: v.status, text: v.text });
    expect(labelValue(c, fmt)).toBeNull();
    expect(fillOf(c, scale)).toBe(FADED_FILL);
    // even if a value slipped through, an insufficient cell shows no number
    expect(labelValue(cell({ status: "insufficient", value: 12345 }), fmt)).toBeNull();
  });
});

describe("theme icon", () => {
  it("sun while dark (switches to light), moon while light (switches to dark)", () => {
    expect(themeIcon("dark")).toEqual({ icon: "sun", svg: SUN, label: "Switch to light theme" });
    expect(themeIcon("light")).toEqual({ icon: "moon", svg: MOON, label: "Switch to dark theme" });
    expect(SUN).toContain('data-icon="sun"');
    expect(MOON).toContain('data-icon="moon"');
    expect(SUN).toContain('stroke="currentColor"');
  });
});
