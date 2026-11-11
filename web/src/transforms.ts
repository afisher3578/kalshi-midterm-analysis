// Pure data transforms. No DOM here, so they can be unit tested.
import type { Num, RaceData, Table } from "./types";

export const PRICE = "kalshi/price_close";
export const VOLUME = "kalshi/volume";
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export type View = "raw" | "z" | "surprise";

/** Same formula as raceattn/metrics/surprise.py (spec section 8):
 * ln((x_t + 1) / (mean of the previous `lookback` same-slot values + 1)).
 * Null when x_t is null or any of the previous `lookback` same-slot values is missing or out of range. */
export function surprise(series: Num[], lookback = 7, step = 1): Num[] {
  return series.map((x, i) => {
    if (x === null || i - lookback * step < 0) return null;
    let sum = 0;
    for (let k = 1; k <= lookback; k++) {
      const p = series[i - k * step];
      if (p === null || p === undefined) return null;
      sum += p;
    }
    return Math.log((x + 1) / (sum / lookback + 1));
  });
}

/** z-score (x - mean) / sd. Mean and sample sd (n - 1) come from the non-null values on days where keep is true
 * (excluded days are left out of the fit). Every non-null value, excluded days included, is then scaled. */
export function zscore(series: Num[], keep: boolean[]): Num[] {
  const fit = series.filter((v, i) => v !== null && keep[i]) as number[];
  if (fit.length < 2) return series.map(() => null);
  const mean = fit.reduce((a, b) => a + b, 0) / fit.length;
  const sd = Math.sqrt(fit.reduce((a, b) => a + (b - mean) ** 2, 0) / (fit.length - 1));
  if (!(sd > 0)) return series.map(() => null);
  return series.map((v) => (v === null ? null : (v - mean) / sd));
}

export function transform(series: Num[], keep: boolean[], view: View): Num[] {
  if (view === "z") return zscore(series, keep);
  if (view === "surprise") return surprise(series);
  return series;
}

export function column(table: Table, name: string): Num[] {
  const i = table.columns.indexOf(name);
  if (i < 0) throw new Error(`column ${name} not in table`);
  return table.rows.map((r) => (r[i] === null || r[i] === undefined ? null : Number(r[i])));
}

/** Attention series in the daily table: every column after date, excluded and the two Kalshi columns. */
export function attentionColumns(data: RaceData): string[] {
  return data.series.daily.columns.filter((c) => c !== "date" && c !== "excluded" && !c.startsWith("kalshi/"));
}

export function utcMs(date: string): number {
  return Date.parse(date + "T00:00:00Z");
}

/** Shared x domain for every panel: window start 00:00 UTC to the day after window end, 00:00 UTC. */
export function xDomain(data: RaceData): [Date, Date] {
  return [new Date(utcMs(data.window.start)), new Date(utcMs(data.window.end) + DAY_MS)];
}

/** Excluded days merged into contiguous [start, end) UTC intervals. */
export function excludedSpans(days: string[]): { start: Date; end: Date; first: string; last: string }[] {
  const ms = [...days].sort().map(utcMs);
  const out: { start: Date; end: Date; first: string; last: string }[] = [];
  for (const t of ms) {
    const prev = out[out.length - 1];
    if (prev && prev.end.getTime() === t) {
      prev.end = new Date(t + DAY_MS);
      prev.last = new Date(t).toISOString().slice(0, 10);
    } else {
      const d = new Date(t).toISOString().slice(0, 10);
      out.push({ start: new Date(t), end: new Date(t + DAY_MS), first: d, last: d });
    }
  }
  return out;
}

export interface Extremes {
  min: { v: number; i: number } | null;
  max: { v: number; i: number } | null;
  last: { v: number; i: number } | null;
  count: number;
}

export function extremes(series: Num[]): Extremes {
  let min: Extremes["min"] = null, max: Extremes["max"] = null, last: Extremes["last"] = null;
  let count = 0;
  series.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    count++;
    if (!min || v < min.v) min = { v, i };
    if (!max || v > max.v) max = { v, i };
    last = { v, i };
  });
  return { min, max, last, count };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(table: Table): string {
  return [table.columns, ...table.rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

/** Everything a reader needs to audit the numbers: lag tables, quality, noise bands, query hashes, meta. */
export function metricsExport(data: RaceData) {
  return {
    project: data.project,
    version: data.version,
    schema_version: data.schema_version,
    generated_at: data.generated_at,
    race: data.race,
    window: data.window,
    excluded_days: data.excluded_days,
    sources: data.sources,
    series_meta: data.series.meta,
    series_query_hash: Object.fromEntries(Object.entries(data.queries).map(([k, q]) => [k, q.series_query_hash])),
    quality: data.quality,
    metrics: data.metrics,
    noise_bands: Object.fromEntries(Object.entries(data.metrics.daily).map(([k, e]) => [k, {
      noise_band: e.noise_band ?? null, noise_band_n: e.noise_band_n ?? null,
      noise_band_pilot: e.noise_band_pilot ?? null, note: e.note ?? null }])),
  };
}

export function raceIdFromSearch(search: string, fallback: string): string {
  const id = new URLSearchParams(search).get("race");
  return id && /^[a-z0-9-]+$/.test(id) ? id : fallback;
}

/** Display label for a series name, e.g. wikipedia/pageviews/James_Talarico -> "James Talarico". */
const SERIES_NAMES: Record<string, string> = {
  "bluesky/post_count": "Bluesky posts", "x/post_count": "X posts",
  "news_mediacloud/story_count": "Media Cloud stories", "news_guardian/article_count": "Guardian articles",
  "news_nyt/article_count": "NYT articles", "news_manual/story_count": "News stories (manual CSV)",
  "gdelt/article_count": "GDELT articles",
};

export function seriesLabel(name: string): string {
  if (name === "wikipedia/pageviews_total") return "Wikipedia pageviews, all pages summed";
  if (SERIES_NAMES[name]) return SERIES_NAMES[name];
  const m = name.match(/^wikipedia\/pageviews\/(.+)$/);
  if (m) return `Wikipedia: ${m[1].replace(/_/g, " ")}`;
  return name;
}

// ---------------------------------------------------------------- M3: lag math, sub-ranges, map metrics

export const MIN_PAIRS_DEFAULT = 20;
export const LAGS = [-2, -1, 0, 1, 2];

function ranks(v: number[]): number[] {
  const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
  const r = new Array<number>(v.length).fill(0);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
    for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

/** Spearman rho with average ranks, as raceattn/metrics/lags.py. rho is null when n < minN or no variance. */
export function spearman(a: Num[], b: Num[], minN = MIN_PAIRS_DEFAULT): { rho: Num; n: number } {
  const p: [number, number][] = [];
  a.forEach((x, i) => { const y = b[i]; if (x !== null && y !== null && y !== undefined) p.push([x, y]); });
  const n = p.length;
  if (n < minN) return { rho: null, n };
  const ra = ranks(p.map((q) => q[0])), rb = ranks(p.map((q) => q[1]));
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  const den = Math.sqrt(da * db);
  return { rho: den ? num / den : null, n };
}

/** Signed change from the previous day (null where either side is missing). */
export function priceChange(close: Num[]): Num[] {
  return close.map((c, i) => (i === 0 || c === null || close[i - 1] === null ? null : c - (close[i - 1] as number)));
}

export function mask(series: Num[], keep: boolean[]): Num[] {
  return series.map((v, i) => (keep[i] ? v : null));
}

/** Days kept for metrics in a sub-range: not excluded (election night) and inside [from, to] (ISO dates). */
export function keepMask(dates: string[], excluded: boolean[], from: string, to: string): boolean[] {
  return dates.map((d, i) => !excluded[i] && d >= from && d <= to);
}

export type Outcome = "volume_surprise" | "abs_price_change" | "price_change";

/** Outcome series per day, from the daily table (surprise needs the 7 days before, so it runs on the full window
 * and the mask is applied afterwards, the same order as the pipeline). */
export function outcomes(close: Num[], volume: Num[]): Record<Outcome, Num[]> {
  const pc = priceChange(close);
  return { volume_surprise: surprise(volume), price_change: pc, abs_price_change: pc.map((v) => (v === null ? null : Math.abs(v))) };
}

/** rho of attention surprise on day t vs the outcome on day t + lag, over the kept days. */
export function lagCellRho(attSurprise: Num[], outcome: Num[], keep: boolean[], lag: number, minN = MIN_PAIRS_DEFAULT) {
  const a: Num[] = [], b: Num[] = [];
  const am = mask(attSurprise, keep), om = mask(outcome, keep);
  for (let i = 0; i < am.length; i++) {
    const j = i + lag;
    if (j >= 0 && j < om.length) { a.push(am[i]); b.push(om[j]); }
  }
  return spearman(a, b, minN);
}

/** Clamp an ISO date range to the window; returns the window when the input is missing or reversed. */
export function clampRange(from: string | null, to: string | null, start: string, end: string): [string, string] {
  const ok = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  let f = ok(from) ? from! : start, t = ok(to) ? to! : end;
  if (f < start) f = start;
  if (t > end) t = end;
  if (f > t) return [start, end];
  return [f, t];
}

/** Platform groups (spec section 6). Kalshi is the outcome side, not attention. */
export const PLATFORM_GROUP: Record<string, string> = {
  x: "talking", bluesky: "talking", reddit: "talking", news_mediacloud: "reporting", news_guardian: "reporting",
  news_nyt: "reporting", news_manual: "reporting", gdelt: "reporting", wikipedia: "looking", youtube: "video",
};

export function sourceOf(series: string): string {
  const head = series.split("/")[0];
  return head;
}

export function groupOf(series: string): string {
  return PLATFORM_GROUP[sourceOf(series)] ?? "other";
}

/** Does a series pass the platform group and individual-source filters ("all" = no filter)? */
export function passesFilter(series: string, group: string, source: string): boolean {
  if (group !== "all" && groupOf(series) !== group) return false;
  if (source !== "all" && sourceOf(series) !== source) return false;
  return true;
}

export type MapMetric = "attention_total" | "attention_rho" | "price_change" | "polling_density" | "data_coverage";

export interface MapValue {
  value: number | null;   // null: insufficient data
  n: number;
  nLabel: string;         // what n counts
  text: string;           // the number as shown, with its unit and n
  reason?: string;        // why the value is insufficient
}

export const MAP_MIN_N = 20;

/** The map value for one race. `series` picks the attention series for the attention metrics. Every value carries
 * n; anything with n < 20 (pairs or days) is "insufficient data", never a number. */
export function mapValue(m: import("./types").IndexMetrics | undefined, metric: MapMetric, series: string,
  fmt: { int: (n: number) => string; two: (n: number) => string; pct: (n: number) => string }): MapValue {
  const insufficient = (reason: string, n = 0, nLabel = ""): MapValue => ({ value: null, n, nLabel, text: "insufficient data", reason });
  if (!m) return insufficient("no processed data for this race");
  if (metric === "attention_total" || metric === "attention_rho") {
    const a = m.attention[series];
    if (!a) return insufficient(`no ${series} series for this race`);
    if (a.status === "unusable") return insufficient(`${series} is unusable`, a.n_days, "days");
    if (metric === "attention_total") {
      if (a.total === null || a.n_days < MAP_MIN_N) return insufficient(`n=${a.n_days} days with data (under ${MAP_MIN_N})`, a.n_days, "days");
      return { value: a.total, n: a.n_days, nLabel: "days", text: `${fmt.int(a.total)} (n=${a.n_days} days)` };
    }
    if (a.rho_volume_surprise === null || a.n_pairs < MAP_MIN_N) {
      return insufficient(`n=${a.n_pairs} pairs (under ${MAP_MIN_N})${a.reason ? `: ${a.reason}` : ""}`, a.n_pairs, "pairs");
    }
    return { value: a.rho_volume_surprise, n: a.n_pairs, nLabel: "pairs",
      text: `rho ${fmt.two(a.rho_volume_surprise)} (n=${a.n_pairs} pairs, lag ${a.lag})` };
  }
  if (metric === "price_change") {
    const p = m.price_change;
    if (!p || p.n_days < MAP_MIN_N) return insufficient(`n=${p?.n_days ?? 0} days of prices (under ${MAP_MIN_N})`, p?.n_days ?? 0, "days");
    return { value: p.cents, n: p.n_days, nLabel: "days",
      text: `${p.cents > 0 ? "+" : ""}${p.cents.toFixed(1)} cents (n=${p.n_days} days, ${p.from} to ${p.to})` };
  }
  if (metric === "polling_density") {
    if (m.polling_density === null || m.polling_density === undefined) return insufficient("no poll count (run the events generator)");
    return { value: m.polling_density, n: m.polling_density, nLabel: "polls",
      text: `${m.polling_density} poll${m.polling_density === 1 ? "" : "s"} in the window (n=${m.polling_density})` };
  }
  const c = m.data_coverage;
  if (c.share === null || c.n_series === 0) return insufficient("no attention series ran");
  return { value: c.share, n: c.n_series * c.window_days, nLabel: "series-days",
    text: `${fmt.pct(c.share)} (n=${c.n_series} series x ${c.window_days} days)` };
}

/** Office order for picking a state's default race: senate, governor, house, national, then others by name. */
export const OFFICE_ORDER = ["senate", "governor", "house", "national"];

export function byOffice(a: { office: string; race_id: string }, b: { office: string; race_id: string }): number {
  const rank = (o: string) => { const i = OFFICE_ORDER.indexOf(o); return i < 0 ? OFFICE_ORDER.length : i; };
  return rank(a.office) - rank(b.office) || a.office.localeCompare(b.office) || a.race_id.localeCompare(b.race_id);
}

export type DensityBand = "all" | "low" | "medium" | "high";
/** Polling density bands for the map filter: low under 10 polls in the window, medium 10 to 29, high 30 or more. */
export function densityBand(polls: number | null | undefined): Exclude<DensityBand, "all"> | null {
  if (polls === null || polls === undefined) return null;
  return polls < 10 ? "low" : polls < 30 ? "medium" : "high";
}

/** Mean of the outcome at offsets -k..k around anchor days (each offset with its own n). */
export function eventStudy(anchorIdx: number[], series: Num[], keep: boolean[], k = 2) {
  const out: { offset: number; mean: Num; n: number }[] = [];
  for (let o = -k; o <= k; o++) {
    const vals: number[] = [];
    for (const i of anchorIdx) {
      const j = i + o;
      if (j >= 0 && j < series.length && keep[j] && series[j] !== null) vals.push(series[j] as number);
    }
    out.push({ offset: o, mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, n: vals.length });
  }
  return out;
}

/** Shorter label for tight places (heatmap rows): the race article becomes "Wikipedia: race article". */
export function shortLabel(name: string, raceArticle: string): string {
  if (name === `wikipedia/pageviews/${raceArticle}`) return "Wikipedia: race article";
  if (name === "wikipedia/pageviews_total") return "Wikipedia: all pages";
  const l = seriesLabel(name);
  return l.length > 32 ? l.slice(0, 31) + "..." : l;
}
