// The dashboard filters: five controls (state, race type, map metric, polling, source), their URL hash form, the
// count of controls that differ from the default, the polling classes and the map value. No DOM here, so they can
// be unit tested.
import type { IndexDisplay, Num } from "./types";

export type MapMetric = "volume" | "attention";
export type Polls = "all" | "few" | "many";
export type Source = "news" | "wikipedia";

export interface Filters {
  state: string;   // postal code
  type: string;    // race office
  metric: MapMetric;
  polls: Polls;
  source: Source;
}

export const DEFAULT_FILTERS: Filters = { state: "TX", type: "senate", metric: "volume", polls: "all", source: "news" };

// The values a control accepts today. Anything else (other states, other race types) is shown but disabled.
export const ENABLED_STATES = ["TX"];
export const RACE_TYPES = [
  { value: "senate", label: "Senate" }, { value: "governor", label: "Governor" },
  { value: "house", label: "House" }, { value: "national", label: "National" },
];
export const ENABLED_TYPES = ["senate"];
export const METRICS: { value: MapMetric; label: string }[] = [
  { value: "volume", label: "Kalshi trading volume" }, { value: "attention", label: "Attention" },
];
export const POLLS: { value: Polls; label: string }[] = [
  { value: "all", label: "All" }, { value: "few", label: "Few polls (under 10)" },
  { value: "many", label: "Many polls (10 or more)" },
];
export const SOURCES: { value: Source; label: string }[] = [
  { value: "news", label: "News (Media Cloud)" }, { value: "wikipedia", label: "Wikipedia" },
];

const ALLOWED: { [K in keyof Filters]: readonly string[] } = {
  state: ENABLED_STATES, type: ENABLED_TYPES, metric: METRICS.map((m) => m.value), polls: POLLS.map((p) => p.value),
  source: SOURCES.map((s) => s.value),
};
const KEYS = Object.keys(DEFAULT_FILTERS) as (keyof Filters)[];

/** Filters from a location hash like "#state=TX&metric=attention&polls=few&source=wikipedia". Unknown keys are
 * ignored; unknown or disabled values fall back to the default. */
export function parseHash(hash: string): Filters {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const out = { ...DEFAULT_FILTERS };
  for (const k of KEYS) {
    let v = q.get(k);
    if (v === null) continue;
    if (k === "state") v = v.toUpperCase();
    if (ALLOWED[k].includes(v)) (out as Record<string, string>)[k] = v;
  }
  return out;
}

/** The hash for a filter state, defaults left out; "" for the default view. */
export function serializeHash(f: Filters): string {
  const q = new URLSearchParams();
  for (const k of KEYS) if (f[k] !== DEFAULT_FILTERS[k]) q.set(k, f[k]);
  const s = q.toString();
  return s ? `#${s}` : "";
}

/** How many of the five controls differ from the default (the badge on the Filters button). */
export function countChanged(f: Filters): number {
  return KEYS.filter((k) => f[k] !== DEFAULT_FILTERS[k]).length;
}

/** Polling class of a race from its poll count in the window; null when the count is unknown. */
export function pollClass(polls: number | null | undefined): Exclude<Polls, "all"> | null {
  if (polls === null || polls === undefined || !Number.isFinite(polls)) return null;
  return polls < 10 ? "few" : "many";
}

/** Does a race pass the polling control? Unknown counts pass only "all". */
export function passesPolls(choice: Polls, polls: number | null | undefined): boolean {
  return choice === "all" || pollClass(polls) === choice;
}

// display_daily columns behind each map value (raceattn/display.py)
export const VOLUME_COL = "kalshi_volume";
export const SOURCE_COL: Record<Source, string> = { news: "news/race_either/national", wikipedia: "wikipedia_pageviews_total" };
export const SOURCE_UNIT: Record<Source, string> = { news: "stories", wikipedia: "pageviews" };
export const MAP_MIN_N = 20;

export interface MapValue {
  status: "ok" | "insufficient" | "nodata";
  value: Num;      // null unless status is ok
  n: number;       // days with data
  text: string;    // the number with its unit and n, or the reason
}

/** The map value for one race: Kalshi volume or attention (from the chosen source) summed over the display window.
 * No column is "no data"; fewer than 20 days with data is "insufficient data", never a number. */
export function mapValue(d: IndexDisplay | null | undefined, metric: MapMetric, source: Source,
  fmt: (n: number) => string): MapValue {
  const col = metric === "volume" ? VOLUME_COL : SOURCE_COL[source];
  const unit = metric === "volume" ? "contracts" : SOURCE_UNIT[source];
  const what = metric === "volume" ? "Kalshi data" : source === "news" ? "news data" : "Wikipedia data";
  const c = d?.[col] as { total: Num; n_days: number } | undefined;
  if (!c || c.n_days === 0) return { status: "nodata", value: null, n: 0, text: `no ${what}` };
  const days = `n=${c.n_days} day${c.n_days === 1 ? "" : "s"}`;
  if (c.total === null || c.n_days < MAP_MIN_N) {
    return { status: "insufficient", value: null, n: c.n_days, text: `insufficient data (${days}, under ${MAP_MIN_N})` };
  }
  return { status: "ok", value: c.total, n: c.n_days, text: `${fmt(c.total)} ${unit} (${days})` };
}
