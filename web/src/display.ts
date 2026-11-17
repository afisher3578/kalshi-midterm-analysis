// Pure helpers for the dashboard line chart: series from series.display_daily and series.display_hourly, the
// Democratic and Republican lines from the candidates block, date range checks, the news coverage count, the legend
// text, the line toggles, the hourly zoom rule, the attention step line, the end of line label nudge and the range
// buttons. No DOM here, so they can be unit tested.
import type { Candidates, DisplayDaily, DisplayHourly, Num } from "./types";

export const PRICE_COL = "kalshi_price_close";
export const VOLUME_COL = "kalshi_volume";
export const NEWS_COL = "news/race_either/national";
export const WIKI_COL = "wikipedia_pageviews_total";

// one line per candidate (Democratic and Republican), then Kalshi volume and attention
export type SeriesKey = "dem" | "rep" | "volume" | "news";
export const SERIES_KEYS: SeriesKey[] = ["dem", "rep", "volume", "news"];
export type PriceKey = "dem" | "rep";
export const PRICE_KEYS: PriceKey[] = ["dem", "rep"];

/** One candidate's price line: who it is and which columns hold the contract's price. */
export interface PartyLine {
  name: string;        // "James Talarico"
  surname: string;     // "Talarico", for the end of line label
  party: "D" | "R";
  ticker: string;
  daily: string;       // display_daily column, e.g. kalshi_price_close
  hourly: string;      // display_hourly column, e.g. kalshi/price_close
}
export type PartyLines = Record<PriceKey, PartyLine | null>;

const FOLLOWED = { daily: PRICE_COL, hourly: "kalshi/price_close" };
const OPPOSING = { daily: "kalshi_r_price_close", hourly: "kalshi_r/price_close" };

function surnameOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] || name;
}

/** The Democratic and Republican lines of a race. The party and the ticker come from the candidates block; the
 * columns follow from the ticker: kalshi_* hold the followed market and kalshi_r_* the opposing contract (G0), so
 * nothing here assumes the followed market is the Democratic one. A candidate whose ticker is neither market, or a
 * race with no candidates block, gets no line (the followed market then stays as one unnamed line). */
export function partyLines(c: Candidates | null | undefined, followed: string, opposing: string | null | undefined): PartyLines {
  const out: PartyLines = { dem: null, rep: null };
  if (!c?.major?.length) {
    out.dem = { name: "Democratic candidate", surname: "Democrat", party: "D", ticker: followed, ...FOLLOWED };
    return out;
  }
  for (const m of c.major) {
    const cols = m.kalshi_ticker === followed ? FOLLOWED : opposing && m.kalshi_ticker === opposing ? OPPOSING : null;
    if (!cols || (m.party !== "D" && m.party !== "R")) continue;
    out[m.party === "D" ? "dem" : "rep"] = { name: m.name, surname: surnameOf(m.name), party: m.party, ticker: m.kalshi_ticker, ...cols };
  }
  return out;
}

export interface ChartSeries {
  dates: string[];
  dem: Num[];     // Democratic candidate's contract close as percent chance (0 to 100)
  rep: Num[];     // Republican candidate's contract close as percent chance; all null when the race has none
  volume: Num[];  // contracts per day (the followed market)
  news: Num[];    // the attention line: Media Cloud stories per day (race_either, national) or Wikipedia pageviews
}                 // per day (attentionCol); all null when the race has none

function num(v: unknown): Num {
  return v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
}

const pct = (v: unknown): Num => { const x = num(v); return x === null ? null : x * 100; };

/** The chart series, one value per display date. Missing values stay null (a gap, never zero or carried). Prices are
 * scaled from 0..1 to percent; `news` may come from another block of the same window (the demo fixture).
 * `attentionCol` picks the attention line (NEWS_COL or WIKI_COL); `lines` picks the price columns per party. */
export function chartSeries(dd: DisplayDaily, news?: DisplayDaily | null, attentionCol = NEWS_COL,
                            lines: PartyLines = partyLines(null, "", null)): ChartSeries {
  const dates = dd.rows.map((r) => String(r.date));
  const newsBy = new Map((news ?? dd).rows.map((r) => [String(r.date), num(r[attentionCol])]));
  const col = (l: PartyLine | null) => dd.rows.map((r) => (l ? pct(r[l.daily]) : null));
  return {
    dates,
    dem: col(lines.dem),
    rep: col(lines.rep),
    volume: dd.rows.map((r) => num(r[VOLUME_COL])),
    news: dates.map((d) => newsBy.get(d) ?? null),
  };
}

/** Whether a line has any value at all. */
export function hasData(values: Num[]): boolean {
  return values.some((v) => v !== null);
}

/** Index of the last non-null value in [lo, hi], or -1. */
export function lastValueIndex(values: Num[], lo: number, hi: number): number {
  for (let i = Math.min(hi, values.length - 1); i >= lo; i--) if (values[i] !== null) return i;
  return -1;
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
export function canHide(visible: Record<SeriesKey, boolean>, key: SeriesKey, keys: SeriesKey[] = SERIES_KEYS): boolean {
  return !visible[key] || keys.some((k) => k !== key && visible[k]);
}

/** Switch a line on or off. The last visible line stays on: the same object comes back unchanged. */
export function toggleLine(visible: Record<SeriesKey, boolean>, key: SeriesKey, keys: SeriesKey[] = SERIES_KEYS):
  Record<SeriesKey, boolean> {
  if (!canHide(visible, key, keys)) return visible;
  return { ...visible, [key]: !visible[key] };
}

/** The line that cannot be switched off (the only one on), or null when two or more are on. */
export function lockedLine(visible: Record<SeriesKey, boolean>, keys: SeriesKey[] = SERIES_KEYS): SeriesKey | null {
  const on = keys.filter((k) => visible[k]);
  return on.length === 1 ? on[0] : null;
}

export type Granularity = "day" | "hour";
export type AttentionSource = "news" | "wikipedia";

/** Legend name and one-line description of a line. Price lines are named after the candidates ("James Talarico
 * (D)"); the attention line follows the Sources choice; "per day" follows the granularity of the plotted data. The
 * volume line is the followed market's contract only, and says so when its candidate is known. */
export function legendText(key: SeriesKey, source: AttentionSource = "news", granularity: Granularity = "day",
                           lines?: Partial<PartyLines>): { name: string; desc: string } {
  const per = `per ${granularity}`;
  if (key === "dem" || key === "rep") {
    const l = lines?.[key];
    const who = l ? l.name : key === "dem" ? "Democrats" : "Republicans";
    return { name: l ? `${l.name} (${l.party})` : who, desc: `Kalshi chance that ${who} win${l ? "s" : ""} (%)` };
  }
  if (key === "volume") {
    const of = lines && Object.values(lines).find((l) => l && l.daily === PRICE_COL);
    return { name: "Volume", desc: `contracts traded ${per}${of ? ` in the ${of.surname} contract` : ""}` };
  }
  return { name: "Attention", desc: source === "wikipedia" ? `Wikipedia pageviews ${per} (race and candidate pages)`
    : `news stories ${per} mentioning the race (Media Cloud)` };
}

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
  dem: Num[];        // Democratic contract, last price of the hour as percent chance (0 to 100)
  rep: Num[];        // Republican contract, the same; all null when the race has no such column
  volume: Num[];     // contracts traded in the hour (the followed market)
  filled: Set<string>;   // followed market: no candle, no trades, price carried forward, volume 0
  carried: Set<string>;  // followed market: candle with a null price, price carried forward, volume kept
  filledR?: Set<string>; // the opposing contract's filled hours (display_hourly.opposing.filled_hours)
}

/** The hourly Kalshi series from series.display_hourly. Prices are scaled from 0..1 to percent; G0 already forward
 * filled the grid, nothing more is filled here (a null stays a gap). */
export function hourlySeries(dh: DisplayHourly, lines: PartyLines = partyLines(null, "", null)): HourlySeries {
  const it = dh.columns.indexOf("ts_utc"), iv = dh.columns.indexOf("kalshi/volume");
  const ts = dh.rows.map((r) => String(r[it]));
  const col = (l: PartyLine | null) => {
    const ip = l ? dh.columns.indexOf(l.hourly) : -1;
    return dh.rows.map((r) => (ip < 0 ? null : pct(r[ip])));
  };
  const opp = lines.dem?.hourly === OPPOSING.hourly ? "dem" : "rep";
  return {
    ts,
    t: ts.map((x) => Date.parse(x)),
    dem: col(lines.dem),
    rep: col(lines.rep),
    volume: dh.rows.map((r) => num(r[iv])),
    filled: new Set(dh.filled_hours?.hours ?? []),
    carried: new Set(dh.forward_filled_null_price?.hours ?? []),
    filledR: lines[opp] ? new Set(dh.opposing?.filled_hours?.hours ?? []) : undefined,
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

/** Day totals from the hours of one UTC day: summed volume and the last Democratic price of the day (the followed
 * market in every race so far). These equal the daily series (daily volume and daily close) by construction. */
export function dayTotals(h: Pick<HourlySeries, "ts" | "dem" | "volume">, day: string):
  { hours: number; volume: number; close: Num } {
  const r = hourlyRange(h.ts, day, day);
  if (!r) return { hours: 0, volume: 0, close: null };
  let volume = 0, close: Num = null;
  for (let i = r[0]; i <= r[1]; i++) {
    volume += h.volume[i] ?? 0;
    if (h.dem[i] !== null) close = h.dem[i];
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
  if (key === "dem" || key === "rep") return "Chance";
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

export type RangeId = "1D" | "1W" | "1M" | "3M" | "All";
export const RANGE_IDS: RangeId[] = ["1D", "1W", "1M", "3M", "All"];
const RANGE_DAYS: Record<Exclude<RangeId, "All">, number> = { "1D": 1, "1W": 7, "1M": 30, "3M": 90 };

/** The range buttons under the chart, as on Kalshi. Every range ends on the window's last day (2026-11-04 for the
 * 2026 races, the day after the election and the last day with candles), the way Kalshi's ranges end at the latest
 * data; 1D, 1W, 1M and 3M are the last 1, 7, 30 and 90 days, All the whole window. Each is clamped to the window, so
 * on a short window 3M and All can be the same range. 1D and 1W are HOURLY_MAX_DAYS or fewer, so they draw the
 * Kalshi lines hourly (granularityFor); 1M and longer daily. */
export function rangeForButton(id: RangeId, window: { start: string; end: string }): { from: string; to: string; zoom: Zoom } {
  const from = id === "All" ? window.start : clampDate(addDays(window.end, -(RANGE_DAYS[id] - 1)), window.start, window.end);
  return { from, to: window.end, zoom: granularityFor(from, window.end) };
}

/** End of line labels: move label centers apart so neighbours are at least `minGap` px apart, keep their order
 * (top to bottom, ties by input order) and keep every label inside [top, bottom]. Labels already far enough apart
 * stay where they are; a group of close labels spreads around its own center. Returns positions in input order. */
export function nudgeLabels(ys: number[], minGap: number, top: number, bottom: number): number[] {
  const n = ys.length;
  if (!n) return [];
  const gap = n > 1 ? Math.min(minGap, (bottom - top) / (n - 1)) : minGap;
  const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b] || a - b);
  const want = order.map((i) => Math.max(top, Math.min(bottom, ys[i])));
  // clusters of consecutive labels, each centered on the mean of what its members want
  let cl = want.map((y, k) => ({ first: k, n: 1, sum: y }));
  const start = (c: { n: number; sum: number }) => c.sum / c.n - ((c.n - 1) * gap) / 2;
  for (let merged = true; merged;) {
    merged = false;
    for (let k = 1; k < cl.length; k++) {
      const a = cl[k - 1], b = cl[k];
      if (start(b) < start(a) + a.n * gap - 1e-9) {
        cl = [...cl.slice(0, k - 1), { first: a.first, n: a.n + b.n, sum: a.sum + b.sum }, ...cl.slice(k + 1)];
        merged = true;
        break;
      }
    }
  }
  const pos: number[] = [];
  for (const c of cl) for (let m = 0; m < c.n; m++) pos.push(start(c) + m * gap);
  // keep inside the plot: push down from the top edge, then up from the bottom edge
  for (let k = 0; k < n; k++) pos[k] = Math.max(pos[k], k ? pos[k - 1] + gap : top);
  for (let k = n - 1; k >= 0; k--) pos[k] = Math.min(pos[k], k < n - 1 ? pos[k + 1] - gap : bottom);
  const out = new Array<number>(n);
  order.forEach((i, k) => { out[i] = pos[k]; });
  return out;
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

