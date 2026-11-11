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
export function seriesLabel(name: string): string {
  if (name === "wikipedia/pageviews_total") return "Wikipedia pageviews, all pages summed";
  const m = name.match(/^wikipedia\/pageviews\/(.+)$/);
  if (m) return `Wikipedia: ${m[1].replace(/_/g, " ")}`;
  return name;
}
