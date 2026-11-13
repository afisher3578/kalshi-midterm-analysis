// Media Cloud news view: pure functions (no DOM), unit tested in tests/news.test.ts.
// Series names follow raceattn/connectors/news.py: news_mediacloud/<query>/<collection> (daily story count),
// .../ratio, .../total_count, .../breadth (distinct sources per day), news_mediacloud/<derived>/<collection>, and the
// top sources at queries.news_mediacloud.mediacloud.top_sources.<query>.<collection>.
import type { Num, Table } from "./types";

export const MC = "news_mediacloud";
export const DEFAULT_ANALYSIS: [string, string] = ["2026-09-01", "2026-11-02"];
export const DEFAULT_COLLECTIONS = ["national", "texas_local"];
export const Z95 = 1.959963984540054; // same constant as raceattn/metrics/reliability.py

export interface McCollection { name: string | null; id: number | null; source_count?: number | null;
  looked_up_on?: string | null; status: string }
export interface McQuery { query: string; query_sha256: string; role: string;
  collections: Record<string, { collection_id: number | null; collection_name: string | null; status: string;
    request_hash?: string; note?: string }> }
export interface TopSources { query: string; collection?: string; start: string; end: string;
  sources: { source: string; count: number }[]; note?: string }
export interface McBlock {
  path?: string; version: number; status: string; frozen_on?: string | null; config_sha256: string; language?: string;
  platform?: string; api_version?: string | null; timezone_note?: string | null;
  phases: Record<string, [string, string]>;
  collections: Record<string, McCollection>;
  derived_support?: string[];
  derived?: Record<string, Record<string, string>>;
  exclusions_log?: unknown[]; changes_log?: unknown[];
  queries?: Record<string, McQuery>;
  derived_nulls?: Record<string, Record<string, string>>;
  top_sources?: Record<string, Record<string, TopSources>>;  // query -> collection -> top sources
  top_sources_window?: [string, string];
  per_source_queries?: string[];
  endpoints?: Record<string, string>;
}

/** Queries with breadth and top sources (the pipeline default, raceattn/mcqueries.py DEFAULT_PER_SOURCE), race_either first. */
export const PER_SOURCE_QUERIES = ["race_either", "talarico_race", "paxton_race"];
export const BREADTH_RULE = "distinct sources with at least one matching story that day (search/count-by-source-over-interval); "
  + "syndicated copies on several domains each count as a source";
export interface AuditRow { query: string; collection: string; story_id: string; publish_date: string; source: string;
  title: string; url: string; relevant: string }
export interface AuditData { available: boolean; _note?: string;
  phases: Record<string, { path: string; rows: AuditRow[]; error?: string }> }

export function seriesName(query: string, collection: string, kind?: string): string {
  return `${MC}/${query}/${collection}${kind ? `/${kind}` : ""}`;
}

/** Every Media Cloud column of a daily table (query-config path names, not the old story_count). */
export function mcColumns(t: Table): string[] {
  return t.columns.filter((c) => c.startsWith(`${MC}/`) && c.split("/").length >= 3);
}

/** True when any Media Cloud count column has at least one value (a pull happened). */
export function hasMcData(t: Table): boolean {
  return mcColumns(t).some((c) => t.rows.some((r) => r[t.columns.indexOf(c)] !== null && r[t.columns.indexOf(c)] !== undefined));
}

export function analysisWindow(block?: McBlock | null): [string, string] {
  const a = block?.phases?.analysis;
  return a && a.length === 2 ? [a[0], a[1]] : DEFAULT_ANALYSIS;
}

/** ISO dates from start to end, inclusive. */
export function windowDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(start + "T00:00:00Z"); t <= Date.parse(end + "T00:00:00Z"); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** date -> value for one column. A date absent from the table, or a null cell, is missing (not in the map or null). */
export function dailyMap(t: Table, name: string): Map<string, Num> {
  const i = t.columns.indexOf(name);
  const m = new Map<string, Num>();
  if (i < 0) return m;
  for (const r of t.rows) {
    const v = r[i];
    m.set(String(r[0]), v === null || v === undefined ? null : Number(v));
  }
  return m;
}

/** A column's values on the given dates (null where missing). */
export function valuesOn(t: Table, name: string, dates: string[]): Num[] {
  const m = dailyMap(t, name);
  return dates.map((d) => m.get(d) ?? null);
}

export interface CountTile {
  series: string;
  windowDays: number;     // days in the analysis window
  presentDays: number;    // days with a value (explicit zeros included)
  total: number | null;   // sum over present days; null when no day has a value
  mean: number | null;    // total / presentDays
  peak: { date: string; count: number } | null;  // largest day; the earliest date wins a tie
  zeroDays: number;       // explicit zeros (the API returned count 0)
  missingDays: number;    // dates with no value at all
  missingDates: string[];
}

/** Totals for one count series over [start, end]. Zero and missing are kept apart: a 0 in the table is a real zero,
 * a date with no row or a null cell is missing and is not counted as 0. */
export function countTile(t: Table, name: string, [start, end]: [string, string]): CountTile {
  const days = windowDays(start, end);
  const m = dailyMap(t, name);
  let total = 0, present = 0, zeros = 0;
  let peak: CountTile["peak"] = null;
  const missing: string[] = [];
  for (const d of days) {
    const v = m.get(d);
    if (v === null || v === undefined) { missing.push(d); continue; }
    present++;
    total += v;
    if (v === 0) zeros++;
    if (!peak || v > peak.count) peak = { date: d, count: v };
  }
  return { series: name, windowDays: days.length, presentDays: present, total: present ? total : null,
    mean: present ? total / present : null, peak, zeroDays: zeros, missingDays: missing.length, missingDates: missing };
}

/** Mention share a / (a + b) per day; null when either count is missing or both are 0 (same rule as derive()). */
export function dailyShare(a: Num[], b: Num[]): Num[] {
  return a.map((x, i) => {
    const y = b[i];
    if (x === null || y === null || y === undefined) return null;
    return x + y === 0 ? null : x / (x + y);
  });
}

/** numerator / denominator per day; null when either is missing or the denominator is 0. */
export function dailyRatio(num: Num[], den: Num[]): Num[] {
  return num.map((x, i) => {
    const y = den[i];
    if (x === null || y === null || y === undefined || y === 0) return null;
    return x / y;
  });
}

export const SHARE_RULE = "mean of the daily Talarico share talarico_race / (talarico_race + paxton_race) over the "
  + "days of the analysis window where it is defined (both counts present and their sum above 0); days where it is "
  + "undefined are left out and counted";

export interface ShareTile { mean: number | null; n: number; undefinedDays: number; windowDays: number;
  from: "derived series" | "counts" }

/** Average Talarico share for one collection. Reads news_mediacloud/talarico_share/<c> when the pipeline wrote it,
 * else computes the same share from the two counts. */
export function meanShare(t: Table, collection: string, [start, end]: [string, string]): ShareTile {
  const days = windowDays(start, end);
  const derived = seriesName("talarico_share", collection);
  const fromDerived = t.columns.includes(derived);
  const share = fromDerived ? valuesOn(t, derived, days)
    : dailyShare(valuesOn(t, seriesName("talarico_race", collection), days), valuesOn(t, seriesName("paxton_race", collection), days));
  const vals = share.filter((v): v is number => v !== null && Number.isFinite(v));
  return { mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, n: vals.length,
    undefinedDays: days.length - vals.length, windowDays: days.length, from: fromDerived ? "derived series" : "counts" };
}

export interface MeanTile { mean: number | null; n: number; windowDays: number }

/** Mean of a daily series over the window days where it has a value (used for distinct sources per day). */
export function meanOver(t: Table, name: string, [start, end]: [string, string]): MeanTile {
  const days = windowDays(start, end);
  const vals = valuesOn(t, name, days).filter((v): v is number => v !== null);
  return { mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, n: vals.length, windowDays: days.length };
}

/** Mean breadth (distinct sources per day) of one query and collection over the window, or null when the table has
 * no breadth column for it. Missing days are left out, not counted as 0. */
export function breadthTile(t: Table, collection: string, window: [string, string], query = "race_either"): MeanTile | null {
  const name = seriesName(query, collection, "breadth");
  return t.columns.includes(name) ? meanOver(t, name, window) : null;
}

/** The top sources entry for one query and collection, or null when the block has none (or an empty list). */
export function topSources(block: McBlock | null | undefined, query: string, collection: string): TopSources | null {
  const e = block?.top_sources?.[query]?.[collection];
  return e && Array.isArray(e.sources) && e.sources.length ? e : null;
}

/** Sources largest first (ties by name), at most k when k is given. */
export function sourceRows(e: TopSources, k?: number): { label: string; count: number }[] {
  const rows = [...e.sources].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
    .map((s) => ({ label: s.source, count: s.count }));
  return k === undefined ? rows : rows.slice(0, k);
}

/** The k largest days of a series in [start, end], largest first; ties go to the earlier date. */
export function topDays(t: Table, name: string, [start, end]: [string, string], k = 10): { date: string; count: number }[] {
  const m = dailyMap(t, name);
  return windowDays(start, end).map((d) => ({ date: d, count: m.get(d) }))
    .filter((x): x is { date: string; count: number } => x.count !== null && x.count !== undefined)
    .sort((a, b) => b.count - a.count || a.date.localeCompare(b.date)).slice(0, k);
}

// ---------------------------------------------------------------- audit: precision and sample headlines

/** Wilson score interval, no continuity correction; [null, null] when n is 0. Same as raceattn.metrics.reliability. */
export function wilson(k: number, n: number, z = Z95): [Num, Num] {
  if (n <= 0) return [null, null];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface PrecisionRow { query: string; collection: string; rows: number; yes: number; no: number; unclear: number;
  uncoded: number; invalid: number; coded: number; precision: Num; wilson95: [Num, Num] }

export const PRECISION_RULE = "precision = relevant yes / (yes + no) per query and collection; unclear and blank rows "
  + "are left out of the denominator and counted; Wilson 95% interval (same rule as `raceattn mediacloud precision`)";

/** Same rule as raceattn.mediacloud.precision: per (query, collection), yes / (yes + no). */
export function precision(rows: AuditRow[]): PrecisionRow[] {
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const k = `${r.query}\u0000${r.collection}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push((r.relevant ?? "").trim().toLowerCase());
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, vals]) => {
    const [query, collection] = k.split("\u0000");
    const yes = vals.filter((v) => v === "yes").length, no = vals.filter((v) => v === "no").length;
    return { query, collection, rows: vals.length, yes, no, unclear: vals.filter((v) => v === "unclear").length,
      uncoded: vals.filter((v) => v === "").length, invalid: vals.filter((v) => v && !["yes", "no", "unclear"].includes(v)).length,
      coded: yes + no, precision: yes + no ? yes / (yes + no) : null, wilson95: wilson(yes, yes + no) };
  });
}

/** The audit phase to report: analysis (the final audit) if any of its rows is coded, else tuning, else null. */
export function codedPhase(a: AuditData | null | undefined): { phase: string; rows: AuditRow[]; path: string } | null {
  for (const phase of ["analysis", "tuning"]) {
    const p = a?.phases?.[phase];
    if (p && p.rows.some((r) => ["yes", "no"].includes((r.relevant ?? "").trim().toLowerCase()))) {
      return { phase, rows: p.rows, path: p.path };
    }
  }
  return null;
}

/** Up to `max` sample headlines per date (publish_date, a date with no timezone), deduplicated by URL; collection `prefer` first. */
export function headlinesByDay(a: AuditData | null | undefined, dates: string[], max = 3, prefer = "national"): Map<string, AuditRow[]> {
  const want = new Set(dates);
  const out = new Map<string, AuditRow[]>();
  const rows = Object.values(a?.phases ?? {}).flatMap((p) => p.rows)
    .filter((r) => want.has((r.publish_date ?? "").slice(0, 10)) && r.title && /^https?:\/\//.test(r.url ?? ""))
    .sort((x, y) => Number(y.collection === prefer) - Number(x.collection === prefer) || x.story_id.localeCompare(y.story_id));
  for (const r of rows) {
    const d = r.publish_date.slice(0, 10);
    const list = out.get(d) ?? [];
    if (list.length < max && !list.some((x) => x.url === r.url)) list.push(r);
    out.set(d, list);
  }
  return out;
}

// ---------------------------------------------------------------- downloads

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV of the daily table: date plus the given Media Cloud columns, one row per table row. Missing is blank. */
export function newsCsv(t: Table, columns: string[]): string {
  const idx = columns.map((c) => t.columns.indexOf(c));
  const lines = [["date", ...columns].map(csvCell).join(",")];
  for (const r of t.rows) lines.push([r[0], ...idx.map((i) => (i < 0 ? null : r[i]))].map(csvCell).join(","));
  return lines.join("\n") + "\n";
}

export interface NewsMetrics {
  demo: boolean;
  window: [string, string];
  collections: Record<string, { total_stories: CountTile; share: ShareTile; breadth: MeanTile | null }>;
  precision: { phase: string; path: string; rows: PrecisionRow[] } | null;
  definitions: Record<string, string>;
}

/** Every tile value with its definition and n, for the metrics JSON download. */
export function newsMetrics(t: Table, collections: string[], window: [string, string], audit: AuditData | null,
  demo: boolean): NewsMetrics {
  const coded = codedPhase(audit);
  return {
    demo, window,
    collections: Object.fromEntries(collections.map((c) => {
      return [c, { total_stories: countTile(t, seriesName("race_either", c), window), share: meanShare(t, c, window),
        breadth: breadthTile(t, c, window) }];
    })),
    precision: coded ? { phase: coded.phase, path: coded.path, rows: precision(coded.rows) } : null,
    definitions: {
      total_stories: "sum of the daily race_either story counts over the analysis window days that have a value",
      mean_per_day: "total / days with a value (explicit zeros count as days with a value)",
      peak_day: "the day with the largest race_either count; the earliest date wins a tie",
      zero_days: "days the API returned with count 0 (real zeros)",
      missing_days: "window days with no value at all (not counted as 0)",
      talarico_share: SHARE_RULE,
      breadth: `mean of news_mediacloud/race_either/<collection>/breadth over the days with a value; breadth = ${BREADTH_RULE}`,
      precision: PRECISION_RULE,
    },
  };
}
