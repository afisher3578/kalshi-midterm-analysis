// Pure helpers for the dashboard line chart: series from series.display_daily and series.display_hourly, date range
// checks, the news coverage count, the legend text, the line toggles, the hourly zoom rule, the attention step line
// and the quick ranges. No DOM here, so they can be unit tested.
import type { DisplayDaily, DisplayHourly, Num } from "./types";

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

// ---------------------------------------------------------------- F3: hourly zoom for the Kalshi lines

const DAY = 86_400_000;
const dayMs = (d: string) => Date.parse(d + "T00:00:00Z");
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Ranges of this many days or fewer (inclusive) draw the Kalshi lines hourly. */
export const HOURLY_MAX_DAYS = 14;

export type Zoom = "hourly" | "daily";

/** Number of days from `from` to `to`, both included. */
export function rangeDays(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / DAY) + 1;
}

/** "hourly" when the range is HOURLY_MAX_DAYS days or fewer, else "daily". */
export function granularityFor(from: string, to: string): Zoom {
  return rangeDays(from, to) <= HOURLY_MAX_DAYS ? "hourly" : "daily";
}

/** Day the date `d` plus `n` days. */
export function addDays(d: string, n: number): string {
  return isoDay(dayMs(d) + n * DAY);
}

export interface HourlySeries {
  ts: string[];      // ts_utc, the candle end_period_ts
  t: number[];       // ts as epoch ms
  price: Num[];      // last price of the hour as percent chance (0 to 100)
  volume: Num[];     // contracts traded in the hour
  filled: Set<string>;   // no candle: no trades, price carried forward, volume 0
  carried: Set<string>;  // candle with a null price: price carried forward, volume kept
}

/** The hourly Kalshi series from series.display_hourly. The price is scaled from 0..1 to percent. */
export function hourlySeries(dh: DisplayHourly): HourlySeries {
  const it = dh.columns.indexOf("ts_utc"), ip = dh.columns.indexOf("kalshi/price_close"), iv = dh.columns.indexOf("kalshi/volume");
  const ts = dh.rows.map((r) => String(r[it]));
  return {
    ts,
    t: ts.map((x) => Date.parse(x)),
    price: dh.rows.map((r) => { const v = num(r[ip]); return v === null ? null : v * 100; }),
    volume: dh.rows.map((r) => num(r[iv])),
    filled: new Set(dh.filled_hours?.hours ?? []),
    carried: new Set(dh.forward_filled_null_price?.hours ?? []),
  };
}

/** The UTC day of an hour: ts_utc[:10], the same rule as the daily series. */
export function hourDay(ts: string): string {
  return ts.slice(0, 10);
}

/** Index range [lo, hi] of the hours whose UTC day (ts[:10]) is inside [from, to], or null when there are none.
 * The hours are sorted, so this is the start date's 00:00Z hour through the end date's last hour. */
export function hourlyRange(ts: string[], from: string, to: string): [number, number] | null {
  let lo = 0;
  while (lo < ts.length && hourDay(ts[lo]) < from) lo++;
  let hi = ts.length - 1;
  while (hi >= lo && hourDay(ts[hi]) > to) hi--;
  return lo <= hi ? [lo, hi] : null;
}

/** Day totals from the hours of one UTC day: summed volume and the last price of the day. These equal the daily
 * series (daily volume and daily close) by construction. */
export function dayTotals(h: Pick<HourlySeries, "ts" | "price" | "volume">, day: string):
  { hours: number; volume: number; close: Num } {
  const r = hourlyRange(h.ts, day, day);
  if (!r) return { hours: 0, volume: 0, close: null };
  let volume = 0, close: Num = null;
  for (let i = r[0]; i <= r[1]; i++) {
    volume += h.volume[i] ?? 0;
    if (h.price[i] !== null) close = h.price[i];
  }
  return { hours: r[1] - r[0] + 1, volume, close };
}

export interface StepPoint { t: number; v: Num }

/** Points of a daily series drawn as a step line on an hourly axis (draw with a step-after curve): one point at
 * each day's 00:00Z, and after each run of days with a value a closing point at the run's last day 24:00Z, so the
 * value stays flat across the whole UTC day. A day with no value gives a null point (a gap, never zero). */
export function dailyToSteps(days: { date: string; v: Num }[]): StepPoint[] {
  const out: StepPoint[] = [];
  days.forEach((d, i) => {
    const t = dayMs(d.date);
    out.push({ t, v: d.v });
    const next = days[i + 1];
    if (d.v !== null && (!next || next.v === null)) out.push({ t: t + DAY, v: d.v });
  });
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An hour as readout text, e.g. "Nov 3, 2026, 14:00 UTC". */
export function fmtHour(ts: string): string {
  const d = new Date(ts);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, "0")}:00 UTC`;
}

/** A day as short text, e.g. "Nov 3". */
export function fmtDayShort(day: string): string {
  const d = new Date(dayMs(day));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export const NO_TRADES = "no trades this hour, last price carried forward";
export const CARRIED = "price carried forward";

/** The readout note for an hour: no candle (no trades) or a candle with no price; "" otherwise. */
export function hourNote(ts: string, h: Pick<HourlySeries, "filled" | "carried">): string {
  if (h.filled.has(ts)) return NO_TRADES;
  if (h.carried.has(ts)) return CARRIED;
  return "";
}

/** The y axis title of a line. Volume says per day or per hour; attention (always per day, as its legend entry
 * says) keeps a short title so the stacked right axis titles fit at 390 px. */
export function axisTitle(key: SeriesKey, source: AttentionSource = "news", granularity: Granularity = "day"): string {
  if (key === "price") return "Price, %";
  if (key === "volume") return `Volume per ${granularity}`;
  return source === "wikipedia" ? "Pageviews" : "Stories";
}

/** The label next to the chart: how the Kalshi lines are drawn. */
export function kalshiLabel(g: Granularity): string {
  return g === "hour" ? "Kalshi: hourly" : "Kalshi: daily";
}

/** The note under the chart in hourly view: attention has no time of day. */
export function attentionNote(source: AttentionSource): string {
  return source === "wikipedia" ? "Attention is daily: Wikipedia pageviews are daily."
    : "Attention is daily: Media Cloud gives no time of day.";
}

export interface QuickRange { id: "election7" | "last14" | "full"; label: string; from: string; to: string }

/** The quick range buttons: the 7 days ending on election day, the 14 days ending at the window end, the whole
 * window. Each is clamped to the window. */
export function quickRanges(window: { start: string; end: string }, election: string): QuickRange[] {
  const c = (d: string) => clampDate(d, window.start, window.end);
  return [
    { id: "election7", label: "Last 7 days before the election", from: c(addDays(election, -6)), to: c(election) },
    { id: "last14", label: "Last 14 days", from: c(addDays(window.end, -13)), to: window.end },
    { id: "full", label: "Full range", from: window.start, to: window.end },
  ];
}

/** Zoom a range by `factor` (below 1 zooms in) around `anchor` (0 = left edge, 1 = right edge), in whole days,
 * kept inside [min, max]. A factor that would not change the span still moves it by one day. */
export function zoomRange(from: string, to: string, min: string, max: string, factor: number, anchor: number):
  { from: string; to: string } {
  const total = rangeDays(min, max), span = rangeDays(from, to);
  let next = Math.max(1, Math.min(total, Math.round(span * factor)));
  if (next === span && factor !== 1) next = Math.max(1, Math.min(total, span + (factor > 1 ? 1 : -1)));
  const a = Math.max(0, Math.min(1, anchor));
  const at = (dayMs(from) - dayMs(min)) / DAY + a * span;   // anchor, in days from min
  let start = Math.round(at - a * next);
  start = Math.max(0, Math.min(total - next, start));
  return { from: addDays(min, start), to: addDays(min, start + next - 1) };
}

