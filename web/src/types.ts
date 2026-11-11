// Shape of data/processed/<race_id>.json (schema_version 1), as written by raceattn/pipeline.py.

export type Num = number | null;
export type Status = "ok" | "degraded" | "unusable";

export interface RaceSummary {
  race_id: string;
  state: string;
  office: string;
  election_date: string;
  kalshi: { series: string; event: string; followed_market: string };
  entities: { name: string; aliases: string[] }[];
  wikipedia_pages: string[];
  subreddits: string[];
  news_query: string | null;
  polling_density: number | null;
}

export interface Quality {
  coverage_days: number;
  window_days: number;
  missing_days: string[];
  longest_gap: number;
  near_zero: { start: string; end: string; days: number }[];
  status: Status;
  reasons: string[];
  extra: Record<string, unknown>;
  coverage: number;
}

export interface LagCell {
  rho: Num;
  n: number;
  noise_band: Num;
  quality_status: Status;
  query_hash: { attention: string | null; outcome: string | null };
}

export interface MetricEntry {
  attention_series: string;
  granularity: string;
  lags: number[];
  min_pairs: number;
  query_hash: string | null;
  status: "computed" | "skipped";
  reason?: string;
  quality_status?: Status;
  outcomes?: Record<string, Record<string, LagCell>>;
  noise_band?: Num;
  noise_band_n?: number;
  noise_band_pilot?: Num;
  n_days_not_excluded?: number;
  note?: string;
}

export interface SeriesMeta {
  source: string;
  granularity: string;
  unit: string;
  query_hash: string;
  fetched_at: string;
}

export interface Table {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  note?: string;
}

export interface RaceData {
  project: string;
  version: string;
  schema_version: number;
  generated_at: string;
  race: RaceSummary;
  window: { start: string; end: string; days: number; inclusive: boolean; timezone: string };
  excluded_days: string[];
  sources: string[];
  queries: Record<string, { query_hash: string; queries: { label: string; endpoint: string; query_hash: string }[];
    series_query_hash: Record<string, string> }>;
  series: { meta: Record<string, SeriesMeta>; hourly: Table; daily: Table };
  quality: Record<string, Quality>;
  metrics: { daily: Record<string, MetricEntry>; hourly: Record<string, MetricEntry>; hourly_note?: string };
  notes: string[];
}
