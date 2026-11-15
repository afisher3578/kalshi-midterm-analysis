// Pure helpers for the dashboard line chart: series from series.display_daily, indexing, date range checks and the
// news coverage count. No DOM here, so they can be unit tested.
import type { DisplayDaily, Num } from "./types";

export const PRICE_COL = "kalshi_price_close";
export const VOLUME_COL = "kalshi_volume";
export const NEWS_COL = "news/race_either/national";

export type SeriesKey = "price" | "volume" | "news";
export const SERIES_KEYS: SeriesKey[] = ["price", "volume", "news"];

export interface ChartSeries {
  dates: string[];
  price: Num[];   // Democratic-win contract close as percent chance (0 to 100)
  volume: Num[];  // contracts per day
  news: Num[];    // Media Cloud stories per day (race_either, national); all null when the race has no news
}

function num(v: unknown): Num {
  return v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
}

/** The three chart series, one value per display date. Missing values stay null (a gap, never zero). The price
 * is scaled from 0..1 to percent; `news` may come from another block of the same window (the demo fixture). */
export function chartSeries(dd: DisplayDaily, news?: DisplayDaily | null): ChartSeries {
  const dates = dd.rows.map((r) => String(r.date));
  const newsBy = new Map((news ?? dd).rows.map((r) => [String(r.date), num(r[NEWS_COL])]));
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

/** Rescale the values at indexes lo..hi (inclusive) so their min is 0 and their max is 100. Values outside the
 * range and nulls are null. A flat series (max equals min) maps to 50. */
export function indexed(values: Num[], lo = 0, hi = values.length - 1): Num[] {
  let min = Infinity, max = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return values.map((v, i) => {
    if (v === null || i < lo || i > hi || !Number.isFinite(min)) return null;
    return max === min ? 50 : ((v - min) / (max - min)) * 100;
  });
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
