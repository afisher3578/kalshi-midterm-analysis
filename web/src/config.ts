// Site-wide constants. PROJECT_NAME is the working title (spec section 15); change it here only.
export const PROJECT_NAME = "race-attention";
export const DEFAULT_RACE = "tx-senate-2026";

// Kalshi grant funding disclosure (spec section 12). Off until the grant is awarded.
// Turn on at build time with VITE_FUNDING_DISCLOSURE=on npm run build.
export const SHOW_FUNDING_DISCLOSURE = import.meta.env.VITE_FUNDING_DISCLOSURE === "on";
export const FUNDING_DISCLOSURE =
  "This research was funded in part by a grant from Kalshi Inc. under the Kalshi Midterm Election Research " +
  "Grant Program. Kalshi did not direct, review, or approve the research or its conclusions.";

export const MIN_PAIRS = 20;

// Attention sources from the spec catalog (section 6) and the keys they need (section 11).
// `needs` says which race config field makes the source apply to a race. Ids match the --sources names used by
// raceattn/connectors (M2 work in progress at the time of M1; reddit and youtube are not built yet).
export interface CatalogSource {
  id: string;
  label: string;
  channel: string;
  needs: "entities" | "news_query" | "subreddits";
  env: string[];
  envNote?: string;
  milestone: string;
}

export const SOURCE_CATALOG: CatalogSource[] = [
  { id: "x", label: "X (Twitter) post counts", channel: "talking", needs: "entities", env: ["X_BEARER_TOKEN"],
    milestone: "M2" },
  { id: "bluesky", label: "Bluesky post counts", channel: "talking", needs: "entities",
    env: ["BSKY_HANDLE", "BSKY_APP_PASSWORD"], envNote: "optional, search may work without a session", milestone: "M2" },
  { id: "news_mediacloud", label: "Media Cloud story counts", channel: "reporting", needs: "news_query",
    env: ["MEDIACLOUD_API_KEY"], milestone: "M2" },
  { id: "news_guardian", label: "Guardian article counts", channel: "reporting", needs: "news_query",
    env: ["GUARDIAN_API_KEY"], milestone: "M2" },
  { id: "news_nyt", label: "New York Times article counts", channel: "reporting", needs: "news_query",
    env: ["NYT_API_KEY"], milestone: "M2" },
  { id: "gdelt", label: "GDELT DOC article counts", channel: "reporting", needs: "news_query", env: [],
    milestone: "M4" },
  { id: "reddit", label: "Reddit post counts", channel: "talking", needs: "subreddits",
    env: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"], milestone: "M4" },
  { id: "youtube", label: "YouTube video counts", channel: "video", needs: "entities", env: ["YOUTUBE_API_KEY"],
    milestone: "M4" },
];

// Licensing notes, as recorded in docs/sources/*.md.
export const SOURCE_NOTES: Record<string, { name: string; note: string; url: string }> = {
  kalshi: {
    name: "Kalshi public market data API",
    note: "Unauthenticated, read-only candlesticks. Only aggregates are published. Kalshi's terms on " +
      "redistributing derived aggregates were not yet reviewed (docs/sources/kalshi.md).",
    url: "https://docs.kalshi.com/getting_started/quick_start_market_data",
  },
  wikipedia: {
    name: "Wikimedia Analytics API (pageviews)",
    note: "Pageview data is CC0 1.0; use of the API is under the Wikimedia Terms of Use (docs/sources/wikipedia.md).",
    url: "https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html",
  },
};
