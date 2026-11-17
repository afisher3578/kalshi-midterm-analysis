// Pure helpers for the dashboard line chart: series from series.display_daily, date range checks, the news coverage
// count, the legend text and the line toggles. No DOM here, so they can be unit tested.
import type { DisplayDaily, Num } from "./types";

export const PRICE_COL = "kalshi_price_close";
export const VOLUME_COL = "kalshi_volume";
export const NEWS_COL = "news/race_either/national";
export const WIKI_COL = "wikipedia_pageviews_total";

export type SeriesKey = "price" | "volume" | "news";
export const SERIES_KEYS: SeriesKey[] = ["price", "volume", "news"];

export interface ChartSeries {
  dates: string[];
  price: Num[];   // Democratic-win contract close as percent chance (0 to 100)
  volume: Num[];  // contracts per day
  news: Num[];    // the attention line: Media Cloud stories per day (race_either, national) or Wikipedia pageviews
}                 // per day (attentionCol); all null when the race has none

function num(v: unknown): Num {
  return v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
}

/** The three chart series, one value per display date. Missing values stay null (a gap, never zero). The price
 * is scaled from 0..1 to percent; `news` may come from another block of the same window (the demo fixture).
 * `attentionCol` picks the attention line (NEWS_COL or WIKI_COL). */
export function chartSeries(dd: DisplayDaily, news?: DisplayDaily | null, attentionCol = NEWS_COL): ChartSeries {
  const dates = dd.rows.map((r) => String(r.date));
  const newsBy = new Map((news ?? dd).rows.map((r) => [String(r.date), num(r[attentionCol])]));
  return {
    dates,
    price: dd.rows.map((r) => { const v = num(r[PRICE_COL]); return v === null ? null : v * 100; }),
    volume: dd.rows.map((r) => num(r[VOLUME_COL])),
    news: dates.map((d) => newsBy.get(d) ?? null),
  };
}

/** Days with a non-null value (N) out of all days (M). */
export function coverageCount(values: Num[]): { n: number; m: number } {
  return { n: values.filter((v) => v !== null).length, m: values.length };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  return ISO.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().startsWith(s);
}

export type RangeCheck = { ok: true; from: string; to: string } | { ok: false; error: string };

/** Accepts a start and end date only when both are real dates inside [min, max] and start is not after end. */
export function checkRange(from: string, to: string, min: string, max: string): RangeCheck {
  for (const [label, v] of [["Start", from], ["End", to]] as const) {
    if (!isIsoDate(v)) return { ok: false, error: `${label} date is not a valid date. Use a date from ${min} to ${max}.` };
    if (v < min) return { ok: false, error: `${label} date ${v} is before ${min}, the first day with chart data.` };
    if (v > max) return { ok: false, error: `${label} date ${v} is after ${max}, the last day with chart data.` };
  }
  if (from > to) return { ok: false, error: `Start date ${from} is after end date ${to}.` };
  return { ok: true, from, to };
}

/** Clamp a date into [min, max]. */
export function clampDate(d: string, min: string, max: string): string {
  return d < min ? min : d > max ? max : d;
}

/** Whether a series may be switched off: never the last visible one. */
export function canHide(visible: Record<SeriesKey, boolean>, key: SeriesKey): boolean {
  return !visible[key] || SERIES_KEYS.some((k) => k !== key && visible[k]);
}

/** Switch a line on or off. The last visible line stays on: the same object comes back unchanged. */
export function toggleLine(visible: Record<SeriesKey, boolean>, key: SeriesKey): Record<SeriesKey, boolean> {
  if (!canHide(visible, key)) return visible;
  return { ...visible, [key]: !visible[key] };
}

/** The line that cannot be switched off (the only one on), or null when two or more are on. */
export function lockedLine(visible: Record<SeriesKey, boolean>): SeriesKey | null {
  const on = SERIES_KEYS.filter((k) => visible[k]);
  return on.length === 1 ? on[0] : null;
}

export type Granularity = "day" | "hour";
export type AttentionSource = "news" | "wikipedia";

/** Legend name and one-line description of a line. The attention line follows the Sources choice; "per day"
 * follows the granularity of the plotted data. */
export function legendText(key: SeriesKey, source: AttentionSource = "news", granularity: Granularity = "day"):
  { name: string; desc: string } {
  const per = `per ${granularity}`;
  if (key === "price") return { name: "Price", desc: "Kalshi chance that Democrats win (%)" };
  if (key === "volume") return { name: "Volume", desc: `contracts traded ${per}` };
  return { name: "Attention", desc: source === "wikipedia" ? `Wikipedia pageviews ${per} (race and candidate pages)`
    : `news stories ${per} mentioning the race (Media Cloud)` };
}

export const PRICE_WHY = "The Republican contract is the mirror image: its price is about 100% minus this line.";
