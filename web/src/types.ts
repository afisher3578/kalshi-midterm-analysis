// Shape of data/processed/<race_id>.json (schema_version 2) and index.json, as written by raceattn/pipeline.py.

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
  status?: string;
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
  connector?: string;
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

export interface QueryLog {
  query_hash: string;
  queries: { label: string; endpoint: string; params?: Record<string, unknown>; query_hash: string }[];
  series_query_hash: Record<string, string>;
  terms?: string[];
  queries_note?: string;
}

export interface OverlayEvent { date: string; type: string; status: string; note: string }

export interface EventSeries {
  status: string;
  reason?: string;
  spikes?: { n: number; dates: string[]; surprise: number[] };
}

// series.display_daily (raceattn/display.py): one row per UTC date of the display window, for charts only.
export interface DisplayDaily {
  window: { start: string; end: string; days: number; inclusive?: boolean; timezone?: string; source?: string };
  columns: string[];
  rows: Record<string, string | number | null>[];
  news: string[] | string;
  coverage?: Record<string, { days_present: number; days_total: number; missing_days: string[] }>;
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
  sources_requested?: string[];
  skipped?: Record<string, string>;
  polling?: { polling_density: number | null; source?: string; revision_url?: string; status?: string; note?: string };
  run_overrides?: { skip?: Record<string, string>; connectors?: Record<string, unknown>; note?: string };
  events_overlay?: { rows: OverlayEvent[]; n: number; n_confirmed: number; note: string; exists: boolean };
  queries: Record<string, QueryLog>;
  series: { meta: Record<string, SeriesMeta>; hourly: Table; daily: Table; hourly_grid?: Table; display_daily?: DisplayDaily };
  quality: Record<string, Quality>;
  metrics: { daily: Record<string, MetricEntry>; hourly: Record<string, MetricEntry>; hourly_note?: string;
    events?: { status?: string; n_confirmed: number; n_needs_review_ignored: number; series: Record<string, EventSeries> } };
  notes: string[];
}

// index.json: one entry per race, headline numbers for the map.
export interface IndexAttention {
  source: string;
  group: string;
  total: Num;
  n_days: number;
  coverage: Num;
  status: Status;
  rho_volume_surprise: Num;
  n_pairs: number;
  lag: number;
  metric_status: string;
  reason?: string | null;
}

export interface IndexMetrics {
  attention_total: { series: string; value: Num; n_days: number; unit: string; note: string };
  attention_vs_volume: { series: string; outcome: string; lag: number; rho: Num; n: number; noise_band: Num; note: string };
  price_change: { cents: number; from: string; to: string; n_days: number; full_window_cents: number; note: string } | null;
  polling_density: number | null;
  polling_source?: string;
  data_coverage: { share: Num; n_series: number; window_days: number; note: string };
  quality_summary: { ok: number; degraded: number; unusable: number; unusable_series: Record<string, string[]>;
    skipped_sources: Record<string, string> };
  attention: Record<string, IndexAttention>;
}

export interface IndexRace {
  race_id: string;
  state: string;
  office: string;
  election_date: string;
  followed_market: string;
  window: RaceData["window"];
  path: string;
  generated_at: string;
  sources: string[];
  quality: Record<string, Status>;
  headline: { status: string; lags?: Record<string, { rho: Num; n: number }> };
  metrics?: IndexMetrics;
}

export interface IndexData {
  project: string;
  races: Record<string, IndexRace>;
  updated_at: string;
}
